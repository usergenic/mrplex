/**
 * CEL parser wrapper — design §5.1 / §7.1, superseded by m2-plan §1.
 *
 * The design pinned `cel-go` compiled to WASM. In M2 we use `@bufbuild/cel`
 * (a TS-native CEL parser from the Buf team, spec-conformant) instead. The
 * result of `parse()` is the standard CEL protobuf `ParsedExpr` — the exact
 * same shape `cel-go` emits — so the AST→SQL compiler stays portable across
 * parser choices. If we later need to swap to `cel-go`/WASM for M5 parity,
 * only this file changes; the compiler doesn't.
 *
 * The design's `$`-prefixed intrinsics (`$path`, `$created_at`) are not
 * legal identifiers in standard CEL. Rather than patch the grammar, we
 * preprocess: `$foo` → `__mrplex_i_foo` before parsing, and the AST walker
 * recognizes the prefix (see ../query/intrinsics.ts). The preprocessor is
 * string-literal-aware so `contains(body, "$foo")` is untouched.
 */

import { parse } from "@bufbuild/cel";
import type { ParsedExpr } from "@bufbuild/cel-spec/cel/expr/syntax_pb.js";
import { KernelError } from "../errors.js";

/**
 * Sentinel prefix for mangled intrinsic identifiers. Deliberately unlikely
 * to collide with real user frontmatter names — mrplex isn't yet exposing
 * `__mrplex_*` to frontmatter, and the AST walker only unmangles idents
 * that pass this exact prefix.
 */
export const INTRINSIC_PREFIX = "__mrplex_i_";

/**
 * Preprocess `$identifier` sequences into the mangled form, skipping over
 * CEL string literal content. Both single- and double-quoted strings are
 * respected, including `\`-escaped quote chars inside them.
 */
export function preprocessDollarIdents(source: string): string {
  let out = "";
  let i = 0;
  let inString: '"' | "'" | null = null;
  while (i < source.length) {
    const ch = source[i] as string;
    if (inString !== null) {
      out += ch;
      if (ch === "\\" && i + 1 < source.length) {
        // Preserve the escape sequence verbatim.
        out += source[i + 1] as string;
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "$") {
      const match = source.slice(i + 1).match(/^([A-Za-z_][A-Za-z0-9_]*)/);
      if (match?.[1]) {
        out += INTRINSIC_PREFIX + match[1];
        i += 1 + match[1].length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Parse a CEL expression string into a ParsedExpr AST. Preprocesses
 * `$`-prefixed intrinsics and surfaces parser errors as
 * `KernelError("filter_invalid", { source, error })`.
 */
export function parseCel(source: string): ParsedExpr {
  const preprocessed = preprocessDollarIdents(source);
  try {
    return parse(preprocessed);
  } catch (err) {
    throw new KernelError("filter_invalid", {
      source,
      error: (err as Error).message,
    });
  }
}
