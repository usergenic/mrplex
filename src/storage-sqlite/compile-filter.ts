/**
 * CEL AST → SQLite SQL compiler — design §5.
 *
 * Every user value ends up as a `?` placeholder in the emitted SQL; no
 * string interpolation of literals. The kernel wraps the returned
 * fragment in the WHERE clause of a versions query.
 *
 * Design-mandated ergonomics:
 *   • Bare identifiers refer to frontmatter keys, compiled to
 *     `json_extract(versions.frontmatter, '$."name"')`.
 *   • `$path`, `$updated_at` — kernel-owned intrinsics, compiled to
 *     `versions.path` / `versions.created_at` (§5.1). `$updated_at` names
 *     the intrinsic from the caller's mental model — queries always see
 *     current versions, so the version's created_at IS the doc's last
 *     update time.
 *   • `list(x)` — a compile-time hint that the enclosing expression should
 *     compile against scalar OR list frontmatter shapes (§5.2).
 *   • Missing key → false predicate (m2-plan §5 decision).
 *
 * Compiled SQL fragments are pure boolean predicates (no SELECT, no FROM);
 * the kernel wraps them in the main query.
 */

import { globToRegexSource } from "../kernel/auth/glob.js";
import { KernelError } from "../kernel/errors.js";
import { type CelExpr, unwrapConstant, unwrapListHint } from "../kernel/query/ast.js";
import { INTRINSIC_PREFIX } from "../kernel/query/cel-parse.js";
import {
  type GraphCollection,
  type GraphMembership,
  asGraphCollection,
  asGraphMembership,
  assertNotReservedGraphName,
} from "../kernel/query/graph-ast.js";
import { BODY_FIELD } from "../links/extract.js";

// -----------------------------------------------------------------------------
// Public compiler surface
// -----------------------------------------------------------------------------

export type SqlFragment = {
  sql: string;
  params: (string | number | bigint | null)[];
};

/**
 * Compile context. Graph predicates need the caller's full visibility
 * filter applied to the OTHER endpoint of an edge (§11.2 "visible graph =
 * readable graph"): `graphScope(alias)` is the read-scope predicate and
 * `graphSigils(alias)` the sigil-exclusion predicate for an aliased
 * `versions` row. Absent when the caller doesn't support graph predicates
 * (compile-filter's own tests) — a graph predicate then errors rather than
 * leaking unfiltered edges.
 */
export type FilterCtx = {
  graphScope?: (alias: string) => SqlFragment;
  graphSigils?: (alias: string) => SqlFragment;
};

// Per-compile state for the current pass: the context plus a graph-subquery
// alias counter (reset each compileFilter so aliases are stable per query,
// matching the Postgres compiler's per-Builder counter). Compilation is
// fully synchronous, so a module-level cell is safe and avoids threading
// state through every compileExpr signature.
let CTX: FilterCtx = {};
let GRAPH_ALIAS_SEQ = 0;

export function compileFilter(expr: CelExpr, ctx: FilterCtx = {}): SqlFragment {
  CTX = ctx;
  GRAPH_ALIAS_SEQ = 0;
  try {
    return compileExpr(expr);
  } finally {
    CTX = {};
    GRAPH_ALIAS_SEQ = 0;
  }
}

/** Alias for a graph subquery's joined `versions` row; unique per compile. */
function nextGraphAlias(): string {
  return `lv${GRAPH_ALIAS_SEQ++}`;
}

// -----------------------------------------------------------------------------
// Intrinsic + frontmatter symbol resolution
// -----------------------------------------------------------------------------

const INTRINSIC_COLUMNS: Record<string, string> = {
  path: "versions.path",
  // `$updated_at` reads as "the timestamp of the current version" — which is
  // what filters see (`next_id IS NULL` is implicit). The underlying column
  // is `versions.created_at` (when this version row was written), but from
  // a query-writer's mental model that's the doc's last update time.
  updated_at: "versions.created_at",
  // The document body — a text column, addressable via $body for the
  // consistency of the $-prefixed convention. Design §5.1's example
  // `contains(body, "pricing")` is updated to `$body`.
  body: "versions.body",
};

function compileIntrinsic(mangledName: string): string {
  const name = mangledName.slice(INTRINSIC_PREFIX.length);
  const column = INTRINSIC_COLUMNS[name];
  if (!column) {
    // Derive the "expected" list from INTRINSIC_COLUMNS so the message
    // can't drift from the code.
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
 * Escape a JSON-path key for the `'$."name"'` form. SQLite's json1 doesn't
 * allow `"` inside a double-quoted key in the path — but our frontmatter
 * keys come through YAML validation and don't include double quotes in
 * practice. We defensively escape by doubling the `"` (SQLite's convention
 * for identifier quoting) and refusing keys with newlines / `$` prefixes.
 */
function frontmatterExtract(name: string): string {
  if (name.includes("\n") || name.includes("\r")) {
    throw new KernelError("filter_invalid", {
      reason: `frontmatter key contains newline: ${JSON.stringify(name)}`,
    });
  }
  const escaped = name.replace(/"/g, '""');
  return `json_extract(versions.frontmatter, '$."${escaped}"')`;
}

// -----------------------------------------------------------------------------
// Expression compiler — dispatches on exprKind.case
// -----------------------------------------------------------------------------

function compileExpr(expr: CelExpr): SqlFragment {
  const kind = expr.exprKind.case;
  switch (kind) {
    case "constExpr":
      return compileConst(expr);
    case "identExpr":
      return compileIdent(expr);
    case "selectExpr":
      return compileSelect(expr);
    case "callExpr":
      return compileCall(expr);
    case "comprehensionExpr":
      return compileComprehension(expr);
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

function compileConst(expr: CelExpr): SqlFragment {
  const value = unwrapConstant(expr);
  if (value === undefined) {
    throw new KernelError("filter_invalid", { reason: "unsupported constant kind" });
  }
  if (value === null) return { sql: "NULL", params: [] };
  if (typeof value === "boolean") return { sql: value ? "1" : "0", params: [] };
  return { sql: "?", params: [value] };
}

function compileIdent(expr: CelExpr): SqlFragment {
  if (expr.exprKind.case !== "identExpr") throw new Error("compileIdent: wrong kind");
  const name = expr.exprKind.value.name;
  if (name.startsWith(INTRINSIC_PREFIX)) {
    return { sql: compileIntrinsic(name), params: [] };
  }
  // Bare identifiers are frontmatter keys. Missing key → predicate false
  // (m2-plan §5 decision). The compileCall layer wraps comparisons to make
  // that shape work; the raw ident extract is what feeds them.
  return { sql: frontmatterExtract(name), params: [] };
}

/**
 * Selects like `x.y` — we support nested frontmatter access when the LHS is
 * a bare identifier or another select.
 */
function compileSelect(expr: CelExpr): SqlFragment {
  if (expr.exprKind.case !== "selectExpr") throw new Error("compileSelect: wrong kind");
  const sel = expr.exprKind.value;
  const path = collectSelectPath(expr);
  if (!path) {
    throw new KernelError("filter_invalid", {
      reason: `unsupported select expression: field '${sel.field}'`,
    });
  }
  // The first segment is the root — either an intrinsic or frontmatter.
  const [root, ...rest] = path;
  const rootExpr = root as string;
  if (rootExpr.startsWith(INTRINSIC_PREFIX)) {
    if (rest.length > 0) {
      throw new KernelError("filter_invalid", {
        reason: `intrinsics do not have subfields ($${rootExpr.slice(INTRINSIC_PREFIX.length)})`,
      });
    }
    return { sql: compileIntrinsic(rootExpr), params: [] };
  }
  const parts = [rootExpr, ...rest].map((p) => `"${p.replace(/"/g, '""')}"`);
  return {
    sql: `json_extract(versions.frontmatter, '$.${parts.join(".")}')`,
    params: [],
  };
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

// -----------------------------------------------------------------------------
// Call dispatch
// -----------------------------------------------------------------------------

function compileCall(expr: CelExpr): SqlFragment {
  if (expr.exprKind.case !== "callExpr") throw new Error("compileCall: wrong kind");
  const call = expr.exprKind.value;
  const fn = call.function;
  const args = call.args;
  const target = call.target;

  // Boolean/comparison operators
  const binOp = BIN_OPS[fn];
  if (binOp && args.length === 2) {
    return compileBinary(binOp, args[0] as CelExpr, args[1] as CelExpr);
  }
  if (fn === "!_" && args.length === 1) return compileNot(args[0] as CelExpr);
  if (fn === "-_" && args.length === 1) {
    const inner = compileExpr(args[0] as CelExpr);
    return { sql: `-(${inner.sql})`, params: inner.params };
  }
  if (fn === "@in" && args.length === 2) {
    return compileIn(args[0] as CelExpr, args[1] as CelExpr);
  }

  // Free-standing calls
  if (target === undefined) {
    if (fn === "size" && args.length === 1) return compileSize(args[0] as CelExpr);
    if (fn === "contains" && args.length === 2) {
      return compileContains(args[0] as CelExpr, args[1] as CelExpr);
    }
    if (fn === "startsWith" && args.length === 2) {
      return compileStartsWith(args[0] as CelExpr, args[1] as CelExpr);
    }
    if (fn === "endsWith" && args.length === 2) {
      return compileEndsWith(args[0] as CelExpr, args[1] as CelExpr);
    }
    if (fn === "matches" && args.length === 2) {
      return compileMatches(args[0] as CelExpr, args[1] as CelExpr);
    }
    if (fn === "list" && args.length === 1) {
      // Bare `list(x)` outside a `@in` / comprehension context is a silent
      // semantic loss — `list(tags) == "foo"` would compile as
      // `tags == "foo"`, which fails on list-valued frontmatter. Since
      // list() is a compile-time hint (§5.2) that only makes sense in
      // hint-consuming contexts, reject it here so users get a clear
      // signal that they probably meant `"foo" in list(tags)`.
      throw new KernelError("filter_invalid", {
        reason:
          "list() is a hint that must sit inside `in` or a comprehension (.all/.exists), not stand alone",
      });
    }
  }

  // Method-style calls: `x.startsWith(y)`, etc.
  if (target) {
    // `$backlinks_static().size()` parses as method-form size (target =
    // the collection call, zero args) — dispatch to the collection COUNT.
    if (fn === "size" && args.length === 0) {
      const collection = asGraphCollection(target);
      if (collection) return compileGraphCollectionSize(collection);
    }
    if (fn === "startsWith" && args.length === 1) {
      return compileStartsWith(target, args[0] as CelExpr);
    }
    if (fn === "endsWith" && args.length === 1) {
      return compileEndsWith(target, args[0] as CelExpr);
    }
    if (fn === "contains" && args.length === 1) {
      return compileContains(target, args[0] as CelExpr);
    }
    if (fn === "matches" && args.length === 1) {
      return compileMatches(target, args[0] as CelExpr);
    }
  }

  // Graph membership predicates: $in_static / $has_static (§11.2).
  const membership = asGraphMembership(expr);
  if (membership) return compileGraphMembership(membership);

  // A bare collection call ($backlinks_static()) reaching a boolean context
  // is meaningless — collections only compose via .size()/.exists()/.all().
  const collection = asGraphCollection(expr);
  if (collection) {
    throw new KernelError("filter_invalid", {
      reason: `$${collection.direction}() is a collection; use .size(), .exists(), or .all()`,
    });
  }

  // Reserved `_dyn` graph names (need Phase 2 embedded queries).
  assertNotReservedGraphName(fn);

  throw new KernelError("filter_invalid", {
    reason: `unsupported function: ${target ? "<target>." : ""}${fn}(...) with ${args.length} arg(s)`,
  });
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

// -----------------------------------------------------------------------------
// Graph predicates — $in_static / $has_static / $backlinks_static() /
// $links_static() over the `links` index (design §11.2, WS4).
//
// Direction fixes which end of the edge the OUTER `versions` row sits on:
//   in / backlinks  → outer doc is the TARGET; the OTHER end is the source.
//   has / links     → outer doc is the SOURCE; the OTHER end is the target.
//
// Scope (§5 decision 5): the other endpoint's version row carries the
// caller's read scope, so an edge to/from an unreadable doc is invisible.
// For `has`/`links` a resolved edge joins the target's version; a *dangling*
// `has` edge has no target version to scope, but the source (the outer,
// already-scoped row) is what the caller reads, and the target is just a
// written path — so dangling edges count for `has_static` (matches
// "$has_static(\"horses.md\") — dangling target ok").
// -----------------------------------------------------------------------------

/**
 * The full visibility predicate for a joined endpoint `alias`: read scope
 * AND sigil-exclusion, so the visible graph equals the readable graph
 * (§11.2). Errors if the compile context didn't supply the builders (a
 * graph predicate must never leak an unfiltered endpoint). Sigil-exclusion
 * has no fragment when the plan excludes nothing (`include_hidden/system`),
 * in which case only scope contributes.
 */
function graphVisibility(alias: string): SqlFragment {
  if (!CTX.graphScope) {
    throw new KernelError("filter_invalid", {
      reason: "graph predicates are not available in this query context",
    });
  }
  const scope = CTX.graphScope(alias);
  const sigils = CTX.graphSigils ? CTX.graphSigils(alias) : { sql: "", params: [] };
  if (!sigils.sql) return scope;
  return { sql: `(${scope.sql} AND ${sigils.sql})`, params: [...scope.params, ...sigils.params] };
}

/** Anchored regexp over a path glob (gitignore-style, §8.2 machinery). */
function globRegex(glob: string): string {
  return `^${globToRegexSource(glob)}$`;
}

/** `AND l.field = ?` fragment (or '$body' sentinel) when a field is given. */
function fieldClause(field: string | undefined): SqlFragment {
  if (field === undefined) return { sql: "", params: [] };
  const f = field === "$body" ? BODY_FIELD : field;
  return { sql: " AND l.field = ?", params: [f] };
}

/**
 * The correlated EXISTS body shared by membership ($in/$has) and the
 * collection `.size()`/comprehension forms. Returns the FROM+WHERE of a
 * subquery correlated to the outer `versions` row, minus the leading
 * SELECT (callers wrap it).
 */
function graphSubqueryCore(
  direction: "in" | "has" | "backlinks" | "links",
  opts: { glob?: string; field?: string; predicateAlias?: string },
): SqlFragment {
  const params: SqlFragment["params"] = [];

  if (direction === "in" || direction === "backlinks") {
    // Outer = target; join the source version. Resolved edges only
    // (target_id must equal the outer doc), source must be live + readable.
    const alias = opts.predicateAlias ?? nextGraphAlias();
    const parts = [
      "FROM links l",
      `JOIN versions ${alias} ON l.source_id = ${alias}.document_id AND ${alias}.next_id IS NULL`,
      "WHERE l.target_id = versions.document_id",
    ];
    if (opts.glob !== undefined) {
      parts.push(`AND regexp(?, ${alias}.path)`);
      params.push(globRegex(opts.glob));
    }
    const fc = fieldClause(opts.field);
    if (fc.sql) {
      parts.push(fc.sql.replace(/^ AND /, "AND "));
      params.push(...fc.params);
    }
    const vis = graphVisibility(alias);
    parts.push(`AND ${vis.sql}`);
    params.push(...vis.params);
    return { sql: parts.join(" "), params };
  }

  // direction === "has" || "links": outer = source; the other end is target.
  // Match the written folded target (target_norm) so dangling edges count.
  // When the target resolves, also require it to be readable; a dangling
  // target has no version row to scope (the target path isn't a live doc).
  const alias = opts.predicateAlias ?? nextGraphAlias();
  const parts = [
    `FROM links l LEFT JOIN versions ${alias} ON l.target_id = ${alias}.document_id AND ${alias}.next_id IS NULL`,
    "WHERE l.source_id = versions.document_id",
  ];
  if (opts.glob !== undefined) {
    // has/links match against the resolved/​written target path. Prefer the
    // resolved live path when bound; fall back to target_norm for danglers.
    parts.push(`AND regexp(?, COALESCE(${alias}.path, l.target_norm))`);
    params.push(globRegex(opts.glob));
  }
  const fc = fieldClause(opts.field);
  if (fc.sql) {
    parts.push(fc.sql.replace(/^ AND /, "AND "));
    params.push(...fc.params);
  }
  // Visibility: a bound target must be readable AND not sigil-hidden (so an
  // inbound edge to a deleted/hidden doc doesn't surface the source); a
  // dangling edge (no target row) is visible because the source is the
  // caller's own already-filtered row.
  const vis = graphVisibility(alias);
  parts.push(`AND (l.target_id IS NULL OR ${vis.sql})`);
  params.push(...vis.params);
  return { sql: parts.join(" "), params };
}

function compileGraphMembership(m: GraphMembership): SqlFragment {
  const core = graphSubqueryCore(m.direction, { glob: m.glob, field: m.field });
  return { sql: `EXISTS (SELECT 1 ${core.sql})`, params: core.params };
}

/** COUNT(*) scalar for size($backlinks_static()) / size($links_static()). */
function compileGraphCollectionSize(c: GraphCollection): SqlFragment {
  const core = graphSubqueryCore(c.direction, {});
  return { sql: `(SELECT COUNT(*) ${core.sql})`, params: core.params };
}

/**
 * $backlinks_static().exists(d, pred) / .all(d, pred). The iter var ranges
 * over the OTHER document's live version (aliased); the predicate compiles
 * against that alias. `.exists` → EXISTS(core AND pred); `.all` →
 * NOT EXISTS(core AND NOT pred) — vacuously true on an empty collection,
 * matching CEL's `.all` semantics.
 */
function compileGraphComprehension(
  comp: NonNullable<Extract<CelExpr["exprKind"], { case: "comprehensionExpr" }>["value"]>,
  collection: GraphCollection,
): SqlFragment {
  const shape = classifyComprehension(comp);
  if (shape === "unsupported") {
    throw new KernelError("filter_invalid", {
      reason: "unsupported comprehension over a link collection (use .exists or .all)",
    });
  }
  const alias = nextGraphAlias();
  const core = graphSubqueryCore(collection.direction, { predicateAlias: alias });
  const userPred = extractUserPredicate(comp.loopStep as CelExpr);
  const pred = compileAgainstAlias(userPred, comp.iterVar, alias);

  if (shape === "exists") {
    return {
      sql: `EXISTS (SELECT 1 ${core.sql} AND (${pred.sql}))`,
      params: [...core.params, ...pred.params],
    };
  }
  // "all": no member violates the predicate (vacuously true when empty).
  return {
    sql: `NOT EXISTS (SELECT 1 ${core.sql} AND NOT (${pred.sql}))`,
    params: [...core.params, ...pred.params],
  };
}

/**
 * Compile a comprehension predicate where the iter var denotes the OTHER
 * document's version row (aliased). `d` bare is meaningless; `d.field`
 * reads that doc's frontmatter, and `d.$path`/`d.$updated_at`/`d.$body`
 * read its intrinsics. Everything else compiles normally (referring to the
 * OUTER `versions` row) — so a predicate can mix both documents.
 */
function compileAgainstAlias(expr: CelExpr, iterVar: string, alias: string): SqlFragment {
  const kind = expr.exprKind.case;

  if (kind === "identExpr") {
    if (expr.exprKind.value.name === iterVar) {
      // Bare iter var in a boolean/scalar position isn't supported — you
      // must access a field (d.status) or intrinsic (d.$path).
      throw new KernelError("filter_invalid", {
        reason: `bare '${iterVar}' is not usable; access a field like ${iterVar}.status or ${iterVar}.$path`,
      });
    }
    return compileExpr(expr);
  }

  if (kind === "selectExpr") {
    const path = collectSelectPath(expr);
    if (path && path[0] === iterVar) {
      return aliasFieldAccess(alias, path.slice(1));
    }
    return compileExpr(expr);
  }

  if (kind === "callExpr") {
    const call = expr.exprKind.value;
    const target = call.target
      ? compileAgainstAlias(call.target as CelExpr, iterVar, alias)
      : undefined;
    const args = call.args.map((a) => compileAgainstAlias(a as CelExpr, iterVar, alias));
    return recompileCallWithSubstitutedArgs(call.function, target, args);
  }

  // Constants and anything else: compile normally.
  return compileExpr(expr);
}

/**
 * Field access on the aliased other-document row. An empty tail is the bare
 * iter var (rejected above). A `$`-prefixed head is an intrinsic
 * ($path/$updated_at/$body); otherwise it's a frontmatter path.
 */
function aliasFieldAccess(alias: string, tail: string[]): SqlFragment {
  const head = tail[0];
  if (head === undefined) {
    throw new KernelError("filter_invalid", { reason: "empty field access on link iter var" });
  }
  if (head.startsWith(INTRINSIC_PREFIX)) {
    if (tail.length > 1) {
      throw new KernelError("filter_invalid", { reason: "intrinsics have no subfields" });
    }
    const name = head.slice(INTRINSIC_PREFIX.length);
    const col = INTRINSIC_COLUMNS[name];
    if (!col) {
      throw new KernelError("filter_invalid", { reason: `unknown intrinsic $${name}` });
    }
    // INTRINSIC_COLUMNS maps to `versions.<col>`; retarget to the alias.
    return { sql: col.replace(/^versions\./, `${alias}.`), params: [] };
  }
  const parts = tail.map((p) => `"${p.replace(/"/g, '""')}"`);
  return { sql: `json_extract(${alias}.frontmatter, '$.${parts.join(".")}')`, params: [] };
}

function compileBinary(op: string, a: CelExpr, b: CelExpr): SqlFragment {
  const lhs = compileExpr(a);
  const rhs = compileExpr(b);
  return {
    sql: `(${lhs.sql} ${op} ${rhs.sql})`,
    params: [...lhs.params, ...rhs.params],
  };
}

function compileNot(inner: CelExpr): SqlFragment {
  const c = compileExpr(inner);
  return { sql: `NOT (${c.sql})`, params: c.params };
}

// -----------------------------------------------------------------------------
// String methods
// -----------------------------------------------------------------------------

function compileContains(haystack: CelExpr, needle: CelExpr): SqlFragment {
  const h = compileExpr(haystack);
  const n = compileExpr(needle);
  return {
    sql: `(instr(${h.sql}, ${n.sql}) > 0)`,
    params: [...h.params, ...n.params],
  };
}

function compileStartsWith(target: CelExpr, prefix: CelExpr): SqlFragment {
  // Literal prefix → use LIKE with the literal escaped. Dynamic prefix →
  // use substr-based check (LIKE with runtime pattern is possible but
  // needs LIKE-escaping which we'd rather avoid).
  const constPrefix = unwrapConstant(prefix);
  const t = compileExpr(target);
  if (typeof constPrefix === "string") {
    const escaped = escapeLikePattern(constPrefix);
    return {
      sql: `(${t.sql} LIKE ? ESCAPE '\\')`,
      params: [...t.params, `${escaped}%`],
    };
  }
  const p = compileExpr(prefix);
  // SQL contains p.sql twice: length(p) and = p. Duplicate p.params 2x.
  return {
    sql: `(substr(${t.sql}, 1, length(${p.sql})) = ${p.sql})`,
    params: [...t.params, ...p.params, ...p.params],
  };
}

function compileEndsWith(target: CelExpr, suffix: CelExpr): SqlFragment {
  const constSuffix = unwrapConstant(suffix);
  const t = compileExpr(target);
  if (typeof constSuffix === "string") {
    const escaped = escapeLikePattern(constSuffix);
    return {
      sql: `(${t.sql} LIKE ? ESCAPE '\\')`,
      params: [...t.params, `%${escaped}`],
    };
  }
  const s = compileExpr(suffix);
  return {
    sql: `(substr(${t.sql}, length(${t.sql}) - length(${s.sql}) + 1) = ${s.sql})`,
    params: [...t.params, ...t.params, ...s.params, ...s.params],
  };
}

function compileMatches(target: CelExpr, pattern: CelExpr): SqlFragment {
  // `regexp` is registered as a user function by the adapter (m2-plan §5).
  const t = compileExpr(target);
  const p = compileExpr(pattern);
  return { sql: `(regexp(${p.sql}, ${t.sql}))`, params: [...p.params, ...t.params] };
}

function escapeLikePattern(literal: string): string {
  return literal.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// -----------------------------------------------------------------------------
// Membership + size (list() polymorphism, §5.2)
// -----------------------------------------------------------------------------

function compileIn(needle: CelExpr, container: CelExpr): SqlFragment {
  const listHint = unwrapListHint(container);
  const n = compileExpr(needle);
  if (listHint) {
    // Polymorphic scalar-or-list frontmatter membership.
    const field = compileExpr(listHint);
    // needle params appear THREE times: once for scalar branch, twice
    // for the list-branch inner comparison? No — just twice: scalar
    // comparison + json_each subquery.
    return {
      sql: `(
        ${field.sql} = ${n.sql}
        OR EXISTS (
          SELECT 1 FROM json_each(${field.sql}) WHERE value = ${n.sql}
        )
      )`,
      // field.sql appears twice; n.sql appears twice → duplicate both.
      params: [...field.params, ...n.params, ...field.params, ...n.params],
    };
  }
  // No list() hint → plain @in against a materialized list. Not supported
  // in M2 (there's no scalar-list variable to iterate against yet).
  throw new KernelError("filter_invalid", {
    reason: '@in without list(field): use `"x" in list(field)` for polymorphic membership',
  });
}

function compileSize(inner: CelExpr): SqlFragment {
  // size($backlinks_static()) / size($links_static()) → COUNT subquery.
  const collection = asGraphCollection(inner);
  if (collection) return compileGraphCollectionSize(collection);

  // size(list(field)) — polymorphic: 1 if scalar, N if list, 0 if null.
  // We use the two-arg form of json_type — json_type(root, path) — so it
  // looks at the JSON representation BEFORE unwrapping (a bare scalar
  // like "one" would otherwise fail json_type as invalid JSON).
  const listHint = unwrapListHint(inner);
  if (listHint) {
    const jsonType = jsonTypeSql(listHint);
    if (jsonType) {
      const field = compileExpr(listHint);
      return {
        sql: `(CASE
          WHEN ${jsonType.sql} IS NULL THEN 0
          WHEN ${jsonType.sql} = 'array' THEN json_array_length(${field.sql})
          ELSE 1
        END)`,
        params: [...jsonType.params, ...jsonType.params, ...field.params],
      };
    }
  }
  // size(string) → length(str). size(list_literal) not supported.
  const c = compileExpr(inner);
  return { sql: `length(${c.sql})`, params: c.params };
}

/**
 * Build a `json_type(root, path)` SQL fragment for a frontmatter access
 * expression, so we can classify scalar vs list without json_extract
 * unwrapping the value. Returns undefined for anything other than a
 * top-level frontmatter identifier or a select over frontmatter.
 */
function jsonTypeSql(expr: CelExpr): SqlFragment | undefined {
  if (expr.exprKind.case === "identExpr") {
    const name = expr.exprKind.value.name;
    if (name.startsWith(INTRINSIC_PREFIX)) return undefined;
    const escaped = name.replace(/"/g, '""');
    return {
      sql: `json_type(versions.frontmatter, '$."${escaped}"')`,
      params: [],
    };
  }
  if (expr.exprKind.case === "selectExpr") {
    const path = collectSelectPath(expr);
    if (!path) return undefined;
    const [root, ...rest] = path;
    if (!root || root.startsWith(INTRINSIC_PREFIX)) return undefined;
    const parts = [root, ...rest].map((p) => `"${p.replace(/"/g, '""')}"`);
    return {
      sql: `json_type(versions.frontmatter, '$.${parts.join(".")}')`,
      params: [],
    };
  }
  return undefined;
}

// -----------------------------------------------------------------------------
// Comprehensions — `list(field).all(v, pred)` and `.exists(v, pred)`
// -----------------------------------------------------------------------------

function compileComprehension(expr: CelExpr): SqlFragment {
  if (expr.exprKind.case !== "comprehensionExpr") {
    throw new Error("compileComprehension: wrong kind");
  }
  const comp = expr.exprKind.value;
  // CEL comprehensions are macro-expanded by the parser. The parser emits
  // one of a few canonical shapes:
  //
  //   .all(v, pred)     → accuInit=true,  loopStep = accu && pred,
  //                       loopCondition = accu (short-circuit)
  //   .exists(v, pred)  → accuInit=false, loopStep = accu || pred
  //   .filter(v, pred)  → accumulator is a list (not supported here)
  //   .map(...)         → likewise not supported

  // Graph collection comprehension: $backlinks_static().exists(d, pred) /
  // $links_static().all(d, pred). The iter var ranges over the OTHER
  // document's version row (§11.2), so the predicate compiles against a
  // joined `versions` alias rather than json_each rows.
  const collection = asGraphCollection(comp.iterRange as CelExpr);
  if (collection) return compileGraphComprehension(comp, collection);

  // We detect the two supported shapes structurally. iterRange must be a
  // list() hint (§5.2).
  const listHint = unwrapListHint(comp.iterRange as CelExpr);
  if (!listHint) {
    throw new KernelError("filter_invalid", {
      reason: "comprehensions must iterate over list(field)",
    });
  }
  const shape = classifyComprehension(comp);
  if (shape === "unsupported") {
    throw new KernelError("filter_invalid", {
      reason: "unsupported comprehension shape (use .all or .exists)",
    });
  }

  const field = compileExpr(listHint);
  // The predicate uses `comp.iterVar` (the loop var) as an ident referring
  // to the current element. We compile predicates against a "row.value"
  // sourced from json_each; substitute the iter var with a placeholder
  // that maps to `_row.value`.
  const predicate = compilePredicateAgainstIter(comp.loopStep as CelExpr, comp.iterVar, shape);

  // json_type(root, path) is used to classify scalar vs array BEFORE
  // json_extract unwraps the value (which would otherwise leave us with
  // a bare scalar that json_type(...) alone can't process).
  const jt = jsonTypeSql(listHint);
  const jtSql = jt?.sql ?? "NULL";
  const jtParams = jt?.params ?? [];

  if (shape === "exists") {
    // exists over list(field): try each list element; on scalar frontmatter
    // treat the scalar as a one-element list.
    const scalarPred = compilePredicateAgainstIter(comp.loopStep as CelExpr, comp.iterVar, shape, {
      source: "scalar",
      fieldSql: field.sql,
      fieldParams: field.params,
    });
    return {
      sql: `(
        (${jtSql} IS NOT NULL AND ${jtSql} != 'array' AND (${scalarPred.sql}))
        OR (${jtSql} = 'array' AND EXISTS (SELECT 1 FROM json_each(${field.sql}) WHERE ${predicate.sql}))
      )`,
      params: [
        ...jtParams,
        ...jtParams,
        ...scalarPred.params,
        ...jtParams,
        ...field.params,
        ...predicate.params,
      ],
    };
  }

  // "all"
  const scalarPredAll = compilePredicateAgainstIter(comp.loopStep as CelExpr, comp.iterVar, shape, {
    source: "scalar",
    fieldSql: field.sql,
    fieldParams: field.params,
  });
  return {
    sql: `(
      CASE
        WHEN ${jtSql} IS NULL THEN 1
        WHEN ${jtSql} != 'array' THEN (${scalarPredAll.sql})
        ELSE NOT EXISTS (SELECT 1 FROM json_each(${field.sql}) WHERE NOT (${predicate.sql}))
      END
    )`,
    params: [
      ...jtParams,
      ...jtParams,
      ...scalarPredAll.params,
      ...field.params,
      ...predicate.params,
    ],
  };
}

function classifyComprehension(
  comp: NonNullable<Extract<CelExpr["exprKind"], { case: "comprehensionExpr" }>["value"]>,
): "all" | "exists" | "unsupported" {
  const init = unwrapConstant(comp.accuInit as CelExpr);
  if (init === true) return "all";
  if (init === false) return "exists";
  return "unsupported";
}

/**
 * Compile a comprehension predicate, substituting occurrences of the
 * loop-variable identifier with either `_row.value` (list branch) or the
 * field's own SQL (scalar branch). The predicate walker is a recursive
 * compileExpr with a scoped override for `identExpr` matches on `iterVar`.
 */
function compilePredicateAgainstIter(
  predicateBase: CelExpr,
  iterVar: string,
  _shape: "all" | "exists",
  scalarCtx?: { source: "scalar"; fieldSql: string; fieldParams: SqlFragment["params"] },
): SqlFragment {
  // The loopStep for CEL's .all/.exists is a boolean combinator around the
  // user's predicate. For .all: loopStep = _&&_(accu, pred). For .exists:
  // loopStep = _||_(accu, pred). We extract the raw predicate.
  const userPred = extractUserPredicate(predicateBase);
  return compileWithIterSubstitution(userPred, iterVar, scalarCtx);
}

/**
 * loopStep in CEL's canonical .all/.exists macros is `__result__ && pred` or
 * `__result__ || pred`. Peel the accumulator off — we compile only the
 * user's predicate; the accumulator semantics are handled by our
 * EXISTS / NOT-EXISTS wrapping.
 */
function extractUserPredicate(loopStep: CelExpr): CelExpr {
  if (loopStep.exprKind.case === "callExpr") {
    const call = loopStep.exprKind.value;
    if ((call.function === "_&&_" || call.function === "_||_") && call.args.length === 2) {
      const [first, second] = call.args;
      // Heuristic: the accumulator is an identExpr against @result / __result__.
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

function compileWithIterSubstitution(
  expr: CelExpr,
  iterVar: string,
  scalarCtx: { source: "scalar"; fieldSql: string; fieldParams: SqlFragment["params"] } | undefined,
): SqlFragment {
  const kind = expr.exprKind.case;
  if (kind === "identExpr" && expr.exprKind.value.name === iterVar) {
    if (scalarCtx) {
      return { sql: scalarCtx.fieldSql, params: [...scalarCtx.fieldParams] };
    }
    // Inside a FROM json_each(...) subquery, the current element is
    // exposed as the unqualified column `value`.
    return { sql: "value", params: [] };
  }
  if (kind === "callExpr") {
    const call = expr.exprKind.value;
    const target = call.target;
    const args = call.args.map((a) =>
      compileWithIterSubstitution(a as CelExpr, iterVar, scalarCtx),
    );
    const targetCompiled = target
      ? compileWithIterSubstitution(target as CelExpr, iterVar, scalarCtx)
      : undefined;
    return recompileCallWithSubstitutedArgs(call.function, targetCompiled, args);
  }
  if (kind === "selectExpr") {
    // Guard against silent-wrong-results: if the select's root IS the iter
    // var (e.g. `list(authors).all(a, a.name == "alice")`), the fall-
    // through to compileExpr would compile `a.name` as if it were a
    // frontmatter path — semantically wrong and impossible to notice.
    // Reject explicitly until we grow proper member-access support.
    const root = collectSelectPath(expr)?.[0];
    if (root === iterVar) {
      throw new KernelError("filter_invalid", {
        reason: `member access on comprehension iter-var '${iterVar}' is not yet supported`,
      });
    }
    return compileExpr(expr);
  }
  return compileExpr(expr);
}

function recompileCallWithSubstitutedArgs(
  fn: string,
  target: SqlFragment | undefined,
  args: SqlFragment[],
): SqlFragment {
  // Small dispatch for the operators/functions we actually see inside a
  // comprehension predicate: comparison ops + string methods.
  const binOp = BIN_OPS[fn];
  if (binOp && args.length === 2 && !target) {
    const [a, b] = args as [SqlFragment, SqlFragment];
    return { sql: `(${a.sql} ${binOp} ${b.sql})`, params: [...a.params, ...b.params] };
  }
  if (fn === "!_" && args.length === 1 && !target) {
    const [a] = args as [SqlFragment];
    return { sql: `NOT (${a.sql})`, params: a.params };
  }
  if (fn === "startsWith") {
    const t = target ?? args[0];
    const p = target ? args[0] : args[1];
    if (!t || !p) throw new KernelError("filter_invalid", { reason: "startsWith needs 2 args" });
    // SQL contains p.sql twice (length(p), = p). Duplicate p.params 2x.
    return {
      sql: `(substr(${t.sql}, 1, length(${p.sql})) = ${p.sql})`,
      params: [...t.params, ...p.params, ...p.params],
    };
  }
  if (fn === "endsWith") {
    const t = target ?? args[0];
    const p = target ? args[0] : args[1];
    if (!t || !p) throw new KernelError("filter_invalid", { reason: "endsWith needs 2 args" });
    return {
      sql: `(substr(${t.sql}, length(${t.sql}) - length(${p.sql}) + 1) = ${p.sql})`,
      params: [...t.params, ...t.params, ...p.params, ...p.params],
    };
  }
  if (fn === "contains") {
    const t = target ?? args[0];
    const n = target ? args[0] : args[1];
    if (!t || !n) throw new KernelError("filter_invalid", { reason: "contains needs 2 args" });
    return { sql: `(instr(${t.sql}, ${n.sql}) > 0)`, params: [...t.params, ...n.params] };
  }
  throw new KernelError("filter_invalid", {
    reason: `unsupported call inside comprehension predicate: ${fn}`,
  });
}
