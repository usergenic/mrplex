/**
 * SearchPlan → SQLite SQL compiler (m5-plan WS2).
 *
 * The kernel builds a `SearchPlan` (parsed CEL AST + scope groups +
 * per-repo sigil groups + optional FTS text + optional candidate ids +
 * limit). The SQLite adapter compiles that plan into one prepared
 * statement — CEL filter + scope regex over the RE2-backed regexp UDF +
 * sigil `NOT LIKE` + FTS5 MATCH + `IN (…)` whitelist + ORDER BY / LIMIT.
 *
 * All user values land as positional `?` placeholders. The compiler
 * appends parameters in the order they appear in the emitted SQL text so
 * SQLite's positional binding matches.
 */

import { globToRegexSource } from "../kernel/auth/glob.js";
import type { ScopeGroup, SearchPlan, SigilExclusion } from "../storage/search-plan.js";
import { compileFilter } from "./compile-filter.js";

export type CompiledSql = {
  sql: string;
  params: (string | number | bigint | null)[];
};

export function compileSearchPlan(plan: SearchPlan): CompiledSql {
  const params: (string | number | bigint | null)[] = [];
  const clauses: string[] = ["versions.next_id IS NULL"];

  // repo_id IN (…) — repo scope, always present (kernel guarantees non-empty).
  const repoPh = plan.repo_ids.map(() => "?").join(",");
  clauses.push(`versions.repo_id IN (${repoPh})`);
  for (const id of plan.repo_ids) params.push(id);

  // Optional CEL filter. Graph predicates ($in_static etc.) need to apply
  // the caller's read scope to the OTHER endpoint of an edge, so hand the
  // filter compiler a scope-fragment builder bound to this plan's scope.
  if (plan.filter_ast) {
    const compiled = compileFilter(plan.filter_ast, {
      graphScope: (alias: string) => scopeFragmentForAlias(plan.scope, alias),
    });
    clauses.push(`(${compiled.sql})`);
    for (const p of compiled.params) params.push(p);
  }

  // Sigil exclusion.
  const sigilFrag = compileSigilExclusion(plan.sigils);
  if (sigilFrag.sql.length > 0) {
    clauses.push(sigilFrag.sql);
    for (const p of sigilFrag.params) params.push(p);
  }

  // Scope filter.
  if (plan.scope.kind === "groups") {
    const scopeFrag = compileScopeGroups(plan.scope.groups, "versions");
    if (scopeFrag.sql.length > 0) {
      clauses.push(`(${scopeFrag.sql})`);
      for (const p of scopeFrag.params) params.push(p);
    } else {
      // No scope grants → no rows (silent-drop per §8.2).
      clauses.push("0");
    }
  }
  // allow_all: no clause added.
  // deny_all: caller short-circuits before compiling.

  // Candidate whitelist (rank branch).
  if (plan.candidate_ids && plan.candidate_ids.length > 0) {
    const idPh = plan.candidate_ids.map(() => "?").join(",");
    clauses.push(`versions.id IN (${idPh})`);
    for (const id of plan.candidate_ids) params.push(id);
  }

  const cols = `versions.id, versions.document_id, versions.repo_id,
                versions.prev_id, versions.next_id, versions.path,
                versions.frontmatter_raw, versions.frontmatter,
                versions.body, versions.author_id, versions.created_at`;

  let sql: string;
  if (plan.text !== undefined) {
    clauses.push("versions.id = fts_docs.rowid");
    clauses.push("fts_docs MATCH ?");
    params.push(plan.text);
    sql = `SELECT ${cols}
             FROM versions, fts_docs
             WHERE ${clauses.join(" AND ")}
             ORDER BY bm25(fts_docs)
             LIMIT ?`;
  } else {
    sql = `SELECT ${cols}
             FROM versions
             WHERE ${clauses.join(" AND ")}
             ORDER BY versions.created_at DESC, versions.id DESC
             LIMIT ?`;
  }
  params.push(plan.limit);
  return { sql, params };
}

function compileSigilExclusion(groups: readonly SigilExclusion[]): CompiledSql {
  const clauses: string[] = [];
  const params: (string | number | bigint | null)[] = [];
  for (const group of groups) {
    if (group.sigils.length === 0) continue;
    if (group.repo_ids.length === 0) continue;
    const repoPh = group.repo_ids.map(() => "?").join(",");
    for (const id of group.repo_ids) params.push(id);
    const sigilClauses: string[] = [];
    for (const sigil of group.sigils) {
      const escaped = sigil.replace(/[\\%_]/g, (ch) => `\\${ch}`);
      sigilClauses.push("versions.path NOT LIKE ? ESCAPE '\\'");
      sigilClauses.push("versions.path NOT LIKE ? ESCAPE '\\'");
      params.push(`${escaped}%`);
      params.push(`%/${escaped}%`);
    }
    clauses.push(`(versions.repo_id NOT IN (${repoPh}) OR (${sigilClauses.join(" AND ")}))`);
  }
  if (clauses.length === 0) return { sql: "", params: [] };
  return { sql: clauses.join(" AND "), params };
}

function compileScopeGroups(groups: readonly ScopeGroup[], alias: string): CompiledSql {
  const scopeSqls: string[] = [];
  const scopeParams: (string | number | bigint | null)[] = [];
  for (const group of groups) {
    if (group.globs.length === 0) continue;
    if (group.repos === "*") {
      const globExpr = globsToLastMatchCaseSql(group.globs, scopeParams, alias);
      scopeSqls.push(`(${globExpr})`);
    } else if (group.repos.length > 0) {
      const ph = group.repos.map(() => "?").join(",");
      for (const id of group.repos) scopeParams.push(id);
      const globExpr = globsToLastMatchCaseSql(group.globs, scopeParams, alias);
      scopeSqls.push(`(${alias}.repo_id IN (${ph}) AND (${globExpr}))`);
    }
  }
  return { sql: scopeSqls.join(" OR "), params: scopeParams };
}

function globsToLastMatchCaseSql(
  globs: readonly string[],
  params: (string | number | bigint | null)[],
  alias: string,
): string {
  let expr = "0";
  const localParams: string[] = [];
  for (let i = 0; i < globs.length; i++) {
    const g = globs[i] as string;
    const negated = g.startsWith("!");
    const raw = negated ? g.slice(1) : g;
    const regex = `^${globToRegexSource(raw)}$`;
    localParams.unshift(regex);
    expr = `(CASE WHEN regexp(?, ${alias}.path) THEN ${negated ? "0" : "1"} ELSE ${expr} END)`;
  }
  for (const p of localParams) params.push(p);
  return expr;
}

/**
 * Scope predicate for an aliased `versions` row inside a graph subquery
 * (links-plan.md §5 decision 5 — the visible graph equals the readable
 * graph). `allow_all` → always true; `deny_all` → always false; `groups`
 * → the same OR-of-globs the outer query applies, retargeted to `alias`.
 */
function scopeFragmentForAlias(scope: SearchPlan["scope"], alias: string): CompiledSql {
  if (scope.kind === "allow_all") return { sql: "1", params: [] };
  if (scope.kind === "deny_all") return { sql: "0", params: [] };
  const frag = compileScopeGroups(scope.groups, alias);
  return frag.sql.length > 0
    ? { sql: `(${frag.sql})`, params: frag.params }
    : { sql: "0", params: [] };
}
