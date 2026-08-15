/**
 * SearchPlan → Postgres SQL compiler (m5-plan WS5).
 *
 * Mirrors the SQLite compiler (src/storage-sqlite/compile-sqlite.ts)
 * with dialect swaps:
 *   - `$n` placeholders instead of `?`; params are appended in the
 *     order they land in the SQL text.
 *   - jsonb access: `frontmatter->'k' = '"v"'::jsonb OR frontmatter->'k'
 *     @> '["v"]'::jsonb` covers scalar+list under one GIN.
 *   - `->>` + casts for typed compare (mirrors json_extract semantics).
 *   - `~` for CEL matches() and scope-glob regexes; POSIX ARE.
 *   - `position()` / `LIKE ESCAPE` for contains/startsWith/endsWith.
 *   - Native booleans (never `1`/`0` predicates).
 *   - FTS: `websearch_to_tsquery` (never throws on user input) +
 *     `ts_rank`; ordering by rank when text is present.
 */

import { globToRegexSource } from "../kernel/auth/glob.js";
import { KernelError } from "../kernel/errors.js";
import type { CelExpr } from "../kernel/query/ast.js";
import { unwrapConstant, unwrapListHint } from "../kernel/query/ast.js";
import { INTRINSIC_PREFIX } from "../kernel/query/cel-parse.js";
import type { ScopeGroup, SearchPlan, SigilExclusion } from "../storage/search-plan.js";

export type CompiledSql = {
  sql: string;
  params: unknown[];
};

// A running builder that keeps params + `$n` counter aligned as we
// weave nested fragments together.
class Builder {
  readonly params: unknown[] = [];
  push(v: unknown): string {
    this.params.push(v);
    return `$${this.params.length}`;
  }
}

// -----------------------------------------------------------------------------
// Public entry
// -----------------------------------------------------------------------------

export function compileSearchPlan(plan: SearchPlan): CompiledSql {
  const b = new Builder();
  const clauses: string[] = ["versions.next_id IS NULL"];

  // repo_id filter.
  clauses.push(`versions.repo_id = ANY(${b.push(plan.repo_ids)}::bigint[])`);

  if (plan.filter_ast) {
    clauses.push(`(${compileExpr(plan.filter_ast, b)})`);
  }

  const sigilSql = compileSigilExclusion(plan.sigils, b);
  if (sigilSql.length > 0) clauses.push(sigilSql);

  if (plan.scope.kind === "groups") {
    const scopeSql = compileScopeGroups(plan.scope.groups, b);
    if (scopeSql.length > 0) clauses.push(`(${scopeSql})`);
    else clauses.push("false");
  }
  // allow_all: no clause.

  if (plan.candidate_ids && plan.candidate_ids.length > 0) {
    clauses.push(`versions.id = ANY(${b.push(plan.candidate_ids)}::bigint[])`);
  }

  const cols = `versions.id, versions.document_id, versions.repo_id,
                versions.prev_id, versions.next_id, versions.path,
                versions.frontmatter_raw, versions.frontmatter,
                versions.body, versions.author_id, versions.created_at`;

  let sql: string;
  if (plan.text !== undefined) {
    // websearch_to_tsquery never throws on user input. Order by ts_rank
    // then id for stability.
    const textPh = b.push(plan.text);
    clauses.push(`versions.fts_tsv @@ websearch_to_tsquery('english', ${textPh})`);
    sql = `SELECT ${cols}
             FROM versions
             WHERE ${clauses.join(" AND ")}
             ORDER BY ts_rank(versions.fts_tsv, websearch_to_tsquery('english', ${textPh})) DESC,
                      versions.id DESC
             LIMIT ${b.push(plan.limit)}`;
  } else {
    sql = `SELECT ${cols}
             FROM versions
             WHERE ${clauses.join(" AND ")}
             ORDER BY versions.created_at DESC, versions.id DESC
             LIMIT ${b.push(plan.limit)}`;
  }
  return { sql, params: b.params };
}

// -----------------------------------------------------------------------------
// Sigil exclusion + scope groups
// -----------------------------------------------------------------------------

function compileSigilExclusion(groups: readonly SigilExclusion[], b: Builder): string {
  const parts: string[] = [];
  for (const g of groups) {
    if (g.sigils.length === 0) continue;
    if (g.repo_ids.length === 0) continue;
    const repoPh = b.push(g.repo_ids);
    const notInAny = `versions.repo_id <> ALL(${repoPh}::bigint[])`;
    const sigilChecks: string[] = [];
    for (const sigil of g.sigils) {
      const escaped = sigil.replace(/[\\%_]/g, (ch) => `\\${ch}`);
      sigilChecks.push(`versions.path NOT LIKE ${b.push(`${escaped}%`)}`);
      sigilChecks.push(`versions.path NOT LIKE ${b.push(`%/${escaped}%`)}`);
    }
    parts.push(`(${notInAny} OR (${sigilChecks.join(" AND ")}))`);
  }
  return parts.join(" AND ");
}

function compileScopeGroups(groups: readonly ScopeGroup[], b: Builder): string {
  const parts: string[] = [];
  for (const g of groups) {
    if (g.globs.length === 0) continue;
    const globExpr = compileScopeGlobs(g.globs, b);
    if (g.repos === "*") {
      parts.push(`(${globExpr})`);
    } else if (g.repos.length > 0) {
      const ph = b.push(g.repos);
      parts.push(`(versions.repo_id = ANY(${ph}::bigint[]) AND (${globExpr}))`);
    }
  }
  return parts.join(" OR ");
}

/**
 * Gitignore-style last-match-wins list, encoded as a CASE nesting where
 * later globs wrap earlier ones (so the outermost WHEN — the last glob
 * — wins if it matches).
 */
function compileScopeGlobs(globs: readonly string[], b: Builder): string {
  // We need `$n`s to appear in outermost-first order in the emitted SQL.
  // The compileWithReverseOrder pattern: build the fragment text first
  // with named placeholders, then emit params in the correct order.
  //
  // Simpler: build a stack of {regex, verdict}, walk it outward and
  // push params in that order as we build the string.
  let expr = "FALSE";
  // Collect regexes in outer-to-inner order (i.e. last glob first, since
  // last glob is outermost).
  const entries: { regex: string; verdict: string }[] = [];
  for (let i = globs.length - 1; i >= 0; i--) {
    const g = globs[i] as string;
    const negated = g.startsWith("!");
    const raw = negated ? g.slice(1) : g;
    const regex = `^${globToRegexSource(raw)}$`;
    entries.push({ regex, verdict: negated ? "FALSE" : "TRUE" });
  }
  // entries[0] is the outermost. Build outer-to-inner so outer's `$n`
  // gets pushed first.
  for (const e of entries) {
    const ph = b.push(e.regex);
    expr = `(CASE WHEN versions.path ~ ${ph} THEN ${e.verdict} ELSE ${expr} END)`;
  }
  return expr;
}

// -----------------------------------------------------------------------------
// CEL AST → Postgres SQL
// -----------------------------------------------------------------------------

const INTRINSIC_COLUMNS: Record<string, string> = {
  path: "versions.path",
  created_at: "versions.created_at",
  body: "versions.body",
};

function compileIntrinsic(mangledName: string): string {
  const name = mangledName.slice(INTRINSIC_PREFIX.length);
  const column = INTRINSIC_COLUMNS[name];
  if (!column) {
    const expected = Object.keys(INTRINSIC_COLUMNS)
      .map((k) => `$${k}`)
      .join(", ");
    throw new KernelError("filter_invalid", {
      reason: `unknown intrinsic $${name} (expected ${expected})`,
    });
  }
  return column;
}

/**
 * jsonb path access. Returns the SQL for `frontmatter -> 'k' -> ...`.
 * The `->>` variant (text) is used inside typed comparisons.
 */
function frontmatterPath(parts: readonly string[]): string {
  // Parts come from the CEL parser (identExpr.value.name /
  // selectExpr.value.field) — the CEL grammar forbids newlines and
  // other control chars in identifiers, so single-quote escaping is
  // the only string-safety concern here.
  if (parts.length === 0) throw new Error("frontmatterPath: empty parts");
  let expr = `versions.frontmatter -> '${(parts[0] as string).replace(/'/g, "''")}'`;
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i] as string;
    expr = `${expr} -> '${p.replace(/'/g, "''")}'`;
  }
  return expr;
}

function frontmatterText(parts: readonly string[]): string {
  // `->>` returns text. Convert the last hop to `->>` for that.
  if (parts.length === 0) throw new Error("frontmatterText: empty parts");
  if (parts.length === 1) {
    const p = parts[0] as string;
    return `versions.frontmatter ->> '${p.replace(/'/g, "''")}'`;
  }
  const prefix = frontmatterPath(parts.slice(0, -1));
  const last = parts[parts.length - 1] as string;
  return `${prefix} ->> '${last.replace(/'/g, "''")}'`;
}

function collectSelectPath(expr: CelExpr): string[] | undefined {
  if (expr.exprKind.case === "identExpr") return [expr.exprKind.value.name];
  if (expr.exprKind.case !== "selectExpr") return undefined;
  const inner = expr.exprKind.value.operand;
  if (!inner) return undefined;
  const innerPath = collectSelectPath(inner);
  if (!innerPath) return undefined;
  return [...innerPath, expr.exprKind.value.field];
}

function compileExpr(expr: CelExpr, b: Builder): string {
  const kind = expr.exprKind.case;
  switch (kind) {
    case "constExpr":
      return compileConst(expr, b);
    case "identExpr":
      return compileIdent(expr);
    case "selectExpr":
      return compileSelect(expr);
    case "callExpr":
      return compileCall(expr, b);
    case "comprehensionExpr":
      return compileComprehension(expr, b);
    case "listExpr":
    case "structExpr":
      throw new KernelError("filter_invalid", {
        reason: `${kind ?? "unknown"} expressions are not supported in filters`,
      });
    default:
      throw new KernelError("filter_invalid", {
        reason: `unsupported expression kind: ${String(kind)}`,
      });
  }
}

function compileConst(expr: CelExpr, b: Builder): string {
  const value = unwrapConstant(expr);
  if (value === undefined) {
    throw new KernelError("filter_invalid", { reason: "unsupported constant kind" });
  }
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return b.push(value);
}

function compileIdent(expr: CelExpr): string {
  if (expr.exprKind.case !== "identExpr") throw new Error("compileIdent: wrong kind");
  const name = expr.exprKind.value.name;
  if (name.startsWith(INTRINSIC_PREFIX)) return compileIntrinsic(name);
  // Bare frontmatter key → text access. Comparisons wrap with casts.
  return frontmatterText([name]);
}

function compileSelect(expr: CelExpr): string {
  if (expr.exprKind.case !== "selectExpr") throw new Error("compileSelect: wrong kind");
  const sel = expr.exprKind.value;
  const path = collectSelectPath(expr);
  if (!path) {
    throw new KernelError("filter_invalid", {
      reason: `unsupported select expression: field '${sel.field}'`,
    });
  }
  const [root, ...rest] = path;
  const rootExpr = root as string;
  if (rootExpr.startsWith(INTRINSIC_PREFIX)) {
    if (rest.length > 0) {
      throw new KernelError("filter_invalid", {
        reason: `intrinsics do not have subfields ($${rootExpr.slice(INTRINSIC_PREFIX.length)})`,
      });
    }
    return compileIntrinsic(rootExpr);
  }
  return frontmatterText([rootExpr, ...rest]);
}

const BIN_OPS: Record<string, string> = {
  "_==_": "=",
  "_!=_": "<>",
  "_<_": "<",
  "_<=_": "<=",
  "_>_": ">",
  "_>=_": ">=",
  "_&&_": "AND",
  "_||_": "OR",
};

function compileCall(expr: CelExpr, b: Builder): string {
  if (expr.exprKind.case !== "callExpr") throw new Error("compileCall: wrong kind");
  const call = expr.exprKind.value;
  const fn = call.function;
  const args = call.args;
  const target = call.target;

  const binOp = BIN_OPS[fn];
  if (binOp && args.length === 2) {
    return compileBinary(binOp, args[0] as CelExpr, args[1] as CelExpr, b);
  }
  if (fn === "!_" && args.length === 1) {
    return `NOT (${compileExpr(args[0] as CelExpr, b)})`;
  }
  if (fn === "-_" && args.length === 1) {
    return `-(${compileExpr(args[0] as CelExpr, b)})`;
  }
  if (fn === "@in" && args.length === 2) {
    return compileIn(args[0] as CelExpr, args[1] as CelExpr, b);
  }

  if (target === undefined) {
    if (fn === "size" && args.length === 1) return compileSize(args[0] as CelExpr, b);
    if (fn === "contains" && args.length === 2)
      return compileContains(args[0] as CelExpr, args[1] as CelExpr, b);
    if (fn === "startsWith" && args.length === 2)
      return compileStartsWith(args[0] as CelExpr, args[1] as CelExpr, b);
    if (fn === "endsWith" && args.length === 2)
      return compileEndsWith(args[0] as CelExpr, args[1] as CelExpr, b);
    if (fn === "matches" && args.length === 2)
      return compileMatches(args[0] as CelExpr, args[1] as CelExpr, b);
    if (fn === "list" && args.length === 1) {
      throw new KernelError("filter_invalid", {
        reason:
          "list() is a hint that must sit inside `in` or a comprehension (.all/.exists), not stand alone",
      });
    }
  }

  if (target) {
    if (fn === "startsWith" && args.length === 1)
      return compileStartsWith(target, args[0] as CelExpr, b);
    if (fn === "endsWith" && args.length === 1)
      return compileEndsWith(target, args[0] as CelExpr, b);
    if (fn === "contains" && args.length === 1)
      return compileContains(target, args[0] as CelExpr, b);
    if (fn === "matches" && args.length === 1) return compileMatches(target, args[0] as CelExpr, b);
  }

  throw new KernelError("filter_invalid", {
    reason: `unsupported function: ${target ? "<target>." : ""}${fn}(...) with ${args.length} arg(s)`,
  });
}

function compileBinary(op: string, a: CelExpr, b_: CelExpr, b: Builder): string {
  // For comparison ops on frontmatter text vs a typed literal, we need
  // a cast. Detect the RHS literal shape and cast the LHS accordingly.
  const isBool = op === "AND" || op === "OR";
  if (isBool) {
    return `(${compileExpr(a, b)} ${op} ${compileExpr(b_, b)})`;
  }
  // For comparison, if the LHS is a bare frontmatter ident/select and
  // the RHS is a constant, cast the text extract to the const's type.
  const lhsFm = fmPathIfPure(a);
  const rhsConst = unwrapConstant(b_);
  if (lhsFm !== undefined && rhsConst !== undefined) {
    const rhsSql = compileConst(b_, b);
    return typedCompare(lhsFm, op, rhsConst, rhsSql);
  }
  // Otherwise, compare the two expressions verbatim. Both sides text.
  return `(${compileExpr(a, b)} ${op} ${compileExpr(b_, b)})`;
}

function fmPathIfPure(expr: CelExpr): string[] | undefined {
  if (expr.exprKind.case === "identExpr") {
    const name = expr.exprKind.value.name;
    if (name.startsWith(INTRINSIC_PREFIX)) return undefined;
    return [name];
  }
  if (expr.exprKind.case === "selectExpr") {
    const path = collectSelectPath(expr);
    if (!path) return undefined;
    if ((path[0] as string).startsWith(INTRINSIC_PREFIX)) return undefined;
    return path;
  }
  return undefined;
}

function typedCompare(
  fmPath: readonly string[],
  op: string,
  rhsConst: unknown,
  rhsSql: string,
): string {
  const textExpr = frontmatterText(fmPath);
  if (typeof rhsConst === "number") {
    // json_extract in SQLite auto-typecasts number frontmatter to number.
    // For PG we cast the ->>text back with `::numeric`, but a missing key
    // yields NULL — NULL compares are FALSE (matches SQLite semantics of
    // missing key → predicate false).
    return `(${textExpr})::numeric ${op} ${rhsSql}::numeric`;
  }
  if (typeof rhsConst === "bigint") {
    return `(${textExpr})::numeric ${op} ${rhsSql}::numeric`;
  }
  if (typeof rhsConst === "boolean") {
    return `(${textExpr})::boolean ${op} ${rhsConst ? "TRUE" : "FALSE"}`;
  }
  // Strings and everything else — direct text compare.
  return `(${textExpr}) ${op} ${rhsSql}`;
}

function compileContains(haystack: CelExpr, needle: CelExpr, b: Builder): string {
  const h = compileExpr(haystack, b);
  const n = compileExpr(needle, b);
  return `(position(${n} in ${h}) > 0)`;
}

function compileStartsWith(target: CelExpr, prefix: CelExpr, b: Builder): string {
  const constPrefix = unwrapConstant(prefix);
  const t = compileExpr(target, b);
  if (typeof constPrefix === "string") {
    const escaped = constPrefix.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    return `(${t} LIKE ${b.push(`${escaped}%`)})`;
  }
  const p = compileExpr(prefix, b);
  return `(substring(${t} from 1 for length(${p})) = ${p})`;
}

function compileEndsWith(target: CelExpr, suffix: CelExpr, b: Builder): string {
  const constSuffix = unwrapConstant(suffix);
  const t = compileExpr(target, b);
  if (typeof constSuffix === "string") {
    const escaped = constSuffix.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    return `(${t} LIKE ${b.push(`%${escaped}`)})`;
  }
  const s = compileExpr(suffix, b);
  return `(substring(${t} from length(${t}) - length(${s}) + 1) = ${s})`;
}

function compileMatches(target: CelExpr, pattern: CelExpr, b: Builder): string {
  // POSIX ARE via `~`. Bad pattern → SQLSTATE 2201B, adapter maps to
  // filter_invalid; here it's just a query error.
  const t = compileExpr(target, b);
  const p = compileExpr(pattern, b);
  return `(${t} ~ ${p})`;
}

// -----------------------------------------------------------------------------
// list() polymorphism + membership
// -----------------------------------------------------------------------------

function compileIn(needle: CelExpr, container: CelExpr, b: Builder): string {
  const listHint = unwrapListHint(container);
  if (!listHint) {
    throw new KernelError("filter_invalid", {
      reason: '@in without list(field): use `"x" in list(field)` for polymorphic membership',
    });
  }
  const fmPath = fmPathIfPure(listHint);
  if (!fmPath) {
    throw new KernelError("filter_invalid", {
      reason: "list() must wrap a frontmatter key",
    });
  }
  const jsonbPath = frontmatterPath(fmPath);
  const needleConst = unwrapConstant(needle);
  if (needleConst !== undefined) {
    // Build a jsonb literal for the value to compare/contain.
    const jsonbLit = jsonbLiteral(needleConst);
    if (jsonbLit === null) {
      // Non-primitive needle — fall through to expression path below.
    } else {
      // Scalar match: `path = '"v"'::jsonb`
      // List match:   `path @> '["v"]'::jsonb`
      const scalarLit = b.push(jsonbLit.scalar);
      const arrayLit = b.push(jsonbLit.array);
      return `(${jsonbPath} = ${scalarLit}::jsonb OR ${jsonbPath} @> ${arrayLit}::jsonb)`;
    }
  }
  // Dynamic needle — fall back to typed text compare + jsonb_array_elements_text.
  const n = compileExpr(needle, b);
  const textPath = frontmatterText(fmPath);
  return `(${textPath} = ${n} OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(${jsonbPath}) v WHERE v = ${n}))`;
}

function jsonbLiteral(v: unknown): { scalar: string; array: string } | null {
  if (typeof v === "string") {
    const j = JSON.stringify(v);
    return { scalar: j, array: `[${j}]` };
  }
  if (typeof v === "number" || typeof v === "bigint") {
    const s = String(v);
    return { scalar: s, array: `[${s}]` };
  }
  if (typeof v === "boolean") {
    return { scalar: v ? "true" : "false", array: v ? "[true]" : "[false]" };
  }
  return null;
}

function compileSize(inner: CelExpr, b: Builder): string {
  const listHint = unwrapListHint(inner);
  if (listHint) {
    const fmPath = fmPathIfPure(listHint);
    if (fmPath) {
      const path = frontmatterPath(fmPath);
      // jsonb_typeof: 'array' → jsonb_array_length; scalar → 1; null → 0.
      return `(CASE
        WHEN ${path} IS NULL THEN 0
        WHEN jsonb_typeof(${path}) = 'array' THEN jsonb_array_length(${path})
        ELSE 1
      END)`;
    }
  }
  // Fallback: string length.
  return `length(${compileExpr(inner, b)})`;
}

// -----------------------------------------------------------------------------
// Comprehensions
// -----------------------------------------------------------------------------

function compileComprehension(expr: CelExpr, b: Builder): string {
  if (expr.exprKind.case !== "comprehensionExpr") {
    throw new Error("compileComprehension: wrong kind");
  }
  const comp = expr.exprKind.value;
  const listHint = unwrapListHint(comp.iterRange as CelExpr);
  if (!listHint) {
    throw new KernelError("filter_invalid", {
      reason: "comprehensions must iterate over list(field)",
    });
  }
  const fmPath = fmPathIfPure(listHint);
  if (!fmPath) {
    throw new KernelError("filter_invalid", {
      reason: "list() must wrap a frontmatter key",
    });
  }
  const shape = classifyComprehension(comp);
  if (shape === "unsupported") {
    throw new KernelError("filter_invalid", {
      reason: "unsupported comprehension shape (use .all or .exists)",
    });
  }

  const jsonbPath = frontmatterPath(fmPath);
  const userPred = extractUserPredicate(comp.loopStep as CelExpr);
  const arrayPred = compileWithIterSubstitution(userPred, comp.iterVar, "elem.value::text", b);
  const scalarPred = compileWithIterSubstitution(
    userPred,
    comp.iterVar,
    frontmatterText(fmPath),
    b,
  );

  if (shape === "exists") {
    return `(
      (${jsonbPath} IS NOT NULL AND jsonb_typeof(${jsonbPath}) <> 'array' AND (${scalarPred}))
      OR (jsonb_typeof(${jsonbPath}) = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(${jsonbPath}) AS elem(value) WHERE ${arrayPred}
      ))
    )`;
  }
  return `(
    CASE
      WHEN ${jsonbPath} IS NULL THEN TRUE
      WHEN jsonb_typeof(${jsonbPath}) <> 'array' THEN (${scalarPred})
      ELSE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(${jsonbPath}) AS elem(value) WHERE NOT (${arrayPred})
      )
    END
  )`;
}

function classifyComprehension(
  comp: NonNullable<Extract<CelExpr["exprKind"], { case: "comprehensionExpr" }>["value"]>,
): "all" | "exists" | "unsupported" {
  const init = unwrapConstant(comp.accuInit as CelExpr);
  if (init === true) return "all";
  if (init === false) return "exists";
  return "unsupported";
}

function extractUserPredicate(loopStep: CelExpr): CelExpr {
  if (loopStep.exprKind.case === "callExpr") {
    const call = loopStep.exprKind.value;
    if ((call.function === "_&&_" || call.function === "_||_") && call.args.length === 2) {
      const [first, second] = call.args;
      if (
        first?.exprKind.case === "identExpr" &&
        (first.exprKind.value.name === "@result" || first.exprKind.value.name === "__result__")
      ) {
        return second as CelExpr;
      }
      if (
        second?.exprKind.case === "identExpr" &&
        (second.exprKind.value.name === "@result" || second.exprKind.value.name === "__result__")
      ) {
        return first as CelExpr;
      }
    }
  }
  return loopStep;
}

/**
 * Recursively compile a predicate expression, substituting occurrences
 * of `iterVar` with the given SQL expression. Kept minimal — supports
 * comparisons, boolean combinators, and the string methods we care
 * about.
 */
function compileWithIterSubstitution(
  expr: CelExpr,
  iterVar: string,
  iterSql: string,
  b: Builder,
): string {
  const kind = expr.exprKind.case;
  if (kind === "identExpr" && expr.exprKind.value.name === iterVar) {
    return iterSql;
  }
  if (kind === "callExpr") {
    const call = expr.exprKind.value;
    const target = call.target;
    const compiledArgs = call.args.map((a) =>
      compileWithIterSubstitution(a as CelExpr, iterVar, iterSql, b),
    );
    const compiledTarget = target
      ? compileWithIterSubstitution(target as CelExpr, iterVar, iterSql, b)
      : undefined;
    return combineCallWithSubstitutedArgs(call.function, compiledTarget, compiledArgs, b);
  }
  if (kind === "selectExpr") {
    const root = collectSelectPath(expr)?.[0];
    if (root === iterVar) {
      throw new KernelError("filter_invalid", {
        reason: `member access on comprehension iter-var '${iterVar}' is not yet supported`,
      });
    }
    return compileExpr(expr, b);
  }
  return compileExpr(expr, b);
}

function combineCallWithSubstitutedArgs(
  fn: string,
  target: string | undefined,
  args: string[],
  b: Builder,
): string {
  const binOp = BIN_OPS[fn];
  if (binOp && args.length === 2 && !target) {
    return `(${args[0]} ${binOp} ${args[1]})`;
  }
  if (fn === "!_" && args.length === 1 && !target) {
    return `NOT (${args[0]})`;
  }
  if (fn === "startsWith") {
    const t = target ?? args[0];
    const p = target ? args[0] : args[1];
    if (t === undefined || p === undefined)
      throw new KernelError("filter_invalid", { reason: "startsWith needs 2 args" });
    return `(substring(${t} from 1 for length(${p})) = ${p})`;
  }
  if (fn === "endsWith") {
    const t = target ?? args[0];
    const p = target ? args[0] : args[1];
    if (t === undefined || p === undefined)
      throw new KernelError("filter_invalid", { reason: "endsWith needs 2 args" });
    return `(substring(${t} from length(${t}) - length(${p}) + 1) = ${p})`;
  }
  if (fn === "contains") {
    const t = target ?? args[0];
    const n = target ? args[0] : args[1];
    if (t === undefined || n === undefined)
      throw new KernelError("filter_invalid", { reason: "contains needs 2 args" });
    return `(position(${n} in ${t}) > 0)`;
  }
  // Silence unused
  void b;
  throw new KernelError("filter_invalid", {
    reason: `unsupported call inside comprehension predicate: ${fn}`,
  });
}
