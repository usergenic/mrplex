/**
 * Graph-predicate recognizers over the CEL AST — design §11.2 "CEL surface"
 * (links-plan.md WS4). Shared by both dialect compilers so `$in_static` etc.
 * are detected identically; each compiler emits its own SQL.
 *
 * The parser mangles `$name` → `__mrplex_i_name` (cel-parse.ts), so the four
 * possession-language intrinsics arrive as ordinary function calls:
 *
 *   $in_static("g")          → call __mrplex_i_in_static("g")
 *   $has_static("g","field") → call __mrplex_i_has_static("g","field")
 *   $backlinks_static()      → call __mrplex_i_backlinks_static()   (a collection)
 *   $links_static()          → call __mrplex_i_links_static()       (a collection)
 *
 * Collections are only meaningful as the target of `.size()` or as the
 * iterRange of `.exists()`/`.all()`; a bare collection call as a boolean is
 * rejected by the dialect compiler (it never reaches a boolean context).
 *
 * Phasing (§11.2): Phase 1 ships the **bare names** ($in/$has/$backlinks()/
 * $links()) AND their `_static` forms — both resolve against the static
 * index today. The bare name is defined as the future union $x_static ∪
 * $x_dyn; with no dynamic edges yet, that union IS the static set, so
 * `$in` == `$in_static` for now. When Phase 2 adds embedded queries, `$in`
 * transparently widens to include them while `$in_static` stays pinned to
 * the index. Only the `_dyn` variants are unimplemented (they need
 * embedded queries) and are rejected with an actionable error.
 */

import { KernelError } from "../errors.js";
import type { CelExpr } from "./ast.js";
import { INTRINSIC_PREFIX } from "./cel-parse.js";

const P = INTRINSIC_PREFIX;

/** Direction of a graph edge relative to the current (outer) document. */
export type GraphDirection =
  | "in" // others → me: a source references me (I'm in X's set)
  | "has" // me → others: I reference a target (X is in my set)
  | "backlinks" // collection of docs referencing me
  | "links"; // collection of docs I reference

/** A boolean membership predicate: $in_static(glob) / $has_static(glob, field?). */
export type GraphMembership = {
  direction: "in" | "has";
  glob: string;
  field?: string; // optional frontmatter-field / '$body' restriction
};

/** A collection: $backlinks_static() / $links_static(). */
export type GraphCollection = {
  direction: "backlinks" | "links";
};

// Bare names AND their `_static` forms both map to the static index today.
// The bare name is the DESIGNED-FOR-THE-FUTURE union $x_static ∪ $x_dyn
// (§11.2); Phase 1 has no dynamic edges, so the union is exactly the static
// set — so `$in` == `$in_static` for now, and callers who want to *stay*
// static-only forever write `$in_static`. When Phase 2 lands embedded
// queries, `$in` transparently widens to include them; `$in_static` does
// not. Only `_dyn` is unimplemented (it needs embedded queries).
const MEMBERSHIP_FNS: Record<string, "in" | "has"> = {
  [`${P}in`]: "in",
  [`${P}in_static`]: "in",
  [`${P}has`]: "has",
  [`${P}has_static`]: "has",
};

const COLLECTION_FNS: Record<string, "backlinks" | "links"> = {
  [`${P}backlinks`]: "backlinks",
  [`${P}backlinks_static`]: "backlinks",
  [`${P}links`]: "links",
  [`${P}links_static`]: "links",
};

// `_dyn` variants — reserved until Phase 2 ships embedded queries. Recognized
// only to produce a clear error, never compiled.
const RESERVED_FNS = new Set<string>([
  `${P}in_dyn`,
  `${P}has_dyn`,
  `${P}backlinks_dyn`,
  `${P}links_dyn`,
]);

function reservedName(fn: string): string {
  // __mrplex_i_in_dyn → $in_dyn
  return `$${fn.slice(P.length)}`;
}

/**
 * Throw if `fn` is a reserved (`_dyn`) graph name. Called by the dialect
 * compilers before their generic "unsupported function" fallthrough so the
 * message is actionable ("use $in / $in_static").
 */
export function assertNotReservedGraphName(fn: string): void {
  if (RESERVED_FNS.has(fn)) {
    const name = reservedName(fn);
    const base = name.replace(/_dyn$/, "");
    throw new KernelError("filter_invalid", {
      reason: `${name}() needs Phase 2 (embedded queries); use ${base}() (static today, static∪dynamic later) or ${base}_static() to stay static-only`,
    });
  }
}

/** A string-constant argument's value, or undefined if not a string const. */
function stringArg(expr: CelExpr | undefined): string | undefined {
  if (!expr || expr.exprKind.case !== "constExpr") return undefined;
  const k = expr.exprKind.value.constantKind;
  return k?.case === "stringValue" ? k.value : undefined;
}

/**
 * If `expr` is a membership call ($in_static / $has_static), return its
 * structured form; otherwise null. Throws filter_invalid on a malformed
 * call (wrong arity, non-string args) so mistakes surface clearly.
 */
/** Human name for a mangled graph fn (`__mrplex_i_in` → `$in`). */
function displayName(fn: string): string {
  return `$${fn.slice(P.length)}`;
}

export function asGraphMembership(expr: CelExpr): GraphMembership | null {
  if (expr.exprKind.case !== "callExpr") return null;
  const call = expr.exprKind.value;
  const direction = MEMBERSHIP_FNS[call.function];
  if (!direction) return null;
  const name = displayName(call.function);
  if (call.target !== undefined) {
    throw new KernelError("filter_invalid", {
      reason: `${name} is a free function, not a method`,
    });
  }
  const glob = stringArg(call.args[0]);
  if (glob === undefined || call.args.length < 1 || call.args.length > 2) {
    throw new KernelError("filter_invalid", {
      reason: `${name}(path-or-glob [, field]) takes a string glob and an optional string field`,
    });
  }
  let field: string | undefined;
  if (call.args.length === 2) {
    field = stringArg(call.args[1]);
    if (field === undefined) {
      throw new KernelError("filter_invalid", {
        reason: `${name} field argument must be a string`,
      });
    }
  }
  return field === undefined ? { direction, glob } : { direction, glob, field };
}

/**
 * If `expr` is a collection call ($backlinks / $links, or their _static
 * forms), return its structured form; otherwise null. Throws on args.
 */
export function asGraphCollection(expr: CelExpr): GraphCollection | null {
  if (expr.exprKind.case !== "callExpr") return null;
  const call = expr.exprKind.value;
  const direction = COLLECTION_FNS[call.function];
  if (!direction) return null;
  if (call.target !== undefined || call.args.length !== 0) {
    throw new KernelError("filter_invalid", {
      reason: `${displayName(call.function)}() takes no arguments`,
    });
  }
  return { direction };
}
