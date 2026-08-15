/**
 * kernel.query orchestration — design §5.
 *
 * Composes:
 *   • CEL filter (§5.1) — compiled to SQL via compile-sqlite.ts
 *   • FTS text (§5.1) — the SQLite FTS5 branch is wired in the adapter
 *   • Rank (§5.1, M4) — the embed hook produces the query vector;
 *     vector_search returns the top-k version ids by cosine distance
 *     (current-versions only). Rank intersects with filter/text/scope/
 *     sigil-exclusion inline: for the intersection, the rank hits are
 *     the candidate row set, and everything else applies as WHERE
 *     clauses ANDed on top. Ordering falls out of the hit-order.
 *   • Scope filter (§8.2) — compiled to SQL via the RE2-backed regexp UDF.
 *     Silently drops rows outside scope, not 403.
 *   • Default sigil exclusion (§5.1, §3.5.5) — hidden/system paths hidden
 *     unless opt-in flags are set. Per-repo: each repo group contributes
 *     its own sigil clauses based on its effective config.
 *   • Result ordering (§5.1 pin) — rank score if `rank` is present, else
 *     text-score if `text` is present, else `$created_at DESC`.
 *   • Limit — required; kernel provides the default.
 */

import type { RepoRow, Storage, VersionRow } from "../../storage/types.js";
import type { Actor, StoredScope } from "../auth/actor.js";
import { globToRegexSource, slugMatchesPattern } from "../auth/glob.js";
import { KernelError } from "../errors.js";
import type { PathConfig } from "../path-config.js";
import { effectivePathConfig, parseRepoOverride } from "../path-config.js";
import type { Version } from "../wire.js";
import { parseCel } from "./cel-parse.js";
import { compileFilter } from "./compile-sqlite.js";

export type QuerySpec = {
  /** Slug, glob, or list. Omitted = every repo the caller can address. */
  repo?: string | string[];
  filter?: string;
  text?: string;
  rank?: string;
  limit?: number;
  include_hidden?: boolean;
  include_system?: boolean;
};

const KNOWN_SPEC_FIELDS = new Set<keyof QuerySpec>([
  "repo",
  "filter",
  "text",
  "rank",
  "limit",
  "include_hidden",
  "include_system",
]);

export type QueryDeps = {
  storage: Storage;
  serverPathConfig: PathConfig;
  toVersionWire: (row: VersionRow, repoSlug: string) => Version;
  /**
   * Optional rank-time embed hook. When absent and `spec.rank` is set,
   * runQuery throws `rank_unavailable` (m4-plan §5 decision 4).
   */
  queryEmbed?: (rank: string) => Promise<{ vector: number[]; model: string; dim: number }>;
};

/** M2 default when the spec omits limit. */
export const DEFAULT_QUERY_LIMIT = 50;

export async function runQuery(actor: Actor, spec: QuerySpec, deps: QueryDeps): Promise<Version[]> {
  validateSpec(spec);

  // 1. Resolve repos the caller can address.
  const reposById = new Map<number, RepoRow>();
  for (const row of deps.storage.repos_list()) reposById.set(row.id, row);
  const targetRepos = filterReposByAccessAndSpec(actor, spec, reposById, deps.serverPathConfig);
  if (targetRepos.length === 0) return [];

  // 2. Compile the filter (if any) once.
  let whereSql = "";
  let whereParams: readonly (string | number | bigint | null)[] = [];
  if (spec.filter !== undefined) {
    const ast = parseCel(spec.filter);
    if (!ast.expr) {
      throw new KernelError("filter_invalid", { reason: "empty filter" });
    }
    const compiled = compileFilter(ast.expr);
    whereSql = compiled.sql;
    whereParams = compiled.params;
  }

  // 3. Per-repo sigil exclusion (§3.5.5). Group repos by effective config
  //    so multiple repos sharing the same config share one clause.
  const sigilExclusion = buildPerRepoSigilExclusion(
    targetRepos,
    deps.serverPathConfig,
    spec.include_hidden ?? false,
    spec.include_system ?? false,
  );

  // 4. Scope filter compiled to SQL (§8.2). Admins bypass; anyone else
  //    gets a WHERE clause built from their read globs, evaluated by the
  //    RE2-backed regexp UDF (see storage-sqlite/adapter.ts).
  const scopeFilter = actor.admin ? { sql: "", params: [] } : buildScopeFilter(actor.scopes);

  const userLimit = spec.limit ?? DEFAULT_QUERY_LIMIT;
  if (userLimit <= 0) return [];

  // 5. Rank branch (M4). When `rank` is set, the candidate row set is
  //    the vector_search top-k, and filter/text/scope/sigil ANDed as
  //    a version_id whitelist through the normal versions_search path.
  //    Ordering: rank wins (best first), then text score, then created_at
  //    (§5.1). vector_search already returns best-per-version — we pass
  //    that order downstream via a CASE-indexed clause.
  if (spec.rank !== undefined) {
    if (!deps.queryEmbed) {
      throw new KernelError("rank_unavailable", {
        reason: "no embedding hook configured on this server",
      });
    }
    let embed: { vector: number[]; model: string; dim: number };
    try {
      embed = await deps.queryEmbed(spec.rank);
    } catch (err) {
      throw new KernelError("rank_unavailable", {
        reason: `embedding hook failed at query time: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
    // Validate the hook's shape at the query boundary — a misbehaving
    // hook (or a wrapper that skipped validateEmbedResponse) shouldn't
    // reach vec_distance_cosine and surface as a generic UDF error.
    if (embed.vector.length !== embed.dim) {
      throw new KernelError("rank_unavailable", {
        reason: `embedding hook returned vector.length ${embed.vector.length} != dim ${embed.dim}`,
      });
    }

    // Ask storage for a wider k than the caller's limit — the intersection
    // may drop hits that fail filter/text/scope. A 4× multiplier is a
    // cheap first pass; if we exhaust hits we fall through to whatever
    // survived. Cap at 200 to keep memory bounded.
    const rankK = Math.min(userLimit * 4, 200);
    const hits = deps.storage.vector_search(
      targetRepos.map((r) => r.id),
      embed.model,
      embed.vector,
      rankK,
    );
    if (hits.length === 0) return [];

    // Apply filter/text/scope/sigil to the rank hits by running
    // versions_search restricted to the hit ids and reordering by the
    // rank score locally. versions_search's `next_id IS NULL` predicate
    // ANDs with our whitelist (vector_search already scoped to current
    // versions via its own join) — no conflict.
    const candidateIds = hits.map((h) => h.version_id);
    const scoreById = new Map(hits.map((h) => [h.version_id, h.score]));
    const idPh = candidateIds.map(() => "?").join(",");
    const combinedWhere = joinWhere([
      whereSql,
      sigilExclusion.sql,
      scopeFilter.sql,
      `versions.id IN (${idPh})`,
    ]);
    const combinedParams: (string | number | bigint | null)[] = [
      ...whereParams,
      ...sigilExclusion.params,
      ...scopeFilter.params,
      ...candidateIds,
    ];
    const rows = deps.storage.versions_search({
      repo_ids: targetRepos.map((r) => r.id),
      where_sql: combinedWhere,
      where_params: combinedParams,
      text: spec.text,
      limit: candidateIds.length, // fetch all survivors; we sort locally
    });
    // Reorder by rank score (best-first).
    rows.sort((a, b) => (scoreById.get(a.id) ?? 1) - (scoreById.get(b.id) ?? 1));
    return rows.slice(0, userLimit).map((row) => {
      const repoSlug = (reposById.get(row.repo_id) as RepoRow).slug;
      return deps.toVersionWire(row, repoSlug);
    });
  }

  // 6. Non-rank path — filter/text/scope/sigil composed as before.
  const combinedWhere = joinWhere([whereSql, sigilExclusion.sql, scopeFilter.sql]);
  const combinedParams: (string | number | bigint | null)[] = [
    ...whereParams,
    ...sigilExclusion.params,
    ...scopeFilter.params,
  ];
  const rows = deps.storage.versions_search({
    repo_ids: targetRepos.map((r) => r.id),
    where_sql: combinedWhere,
    where_params: combinedParams,
    text: spec.text,
    limit: userLimit,
  });

  // 7. Hydrate.
  return rows.map((row) => {
    const repoSlug = (reposById.get(row.repo_id) as RepoRow).slug;
    return deps.toVersionWire(row, repoSlug);
  });
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

function validateSpec(spec: QuerySpec): void {
  // m2-plan §3 WS7 step 1: filter_invalid on unknown fields.
  for (const key of Object.keys(spec)) {
    if (!KNOWN_SPEC_FIELDS.has(key as keyof QuerySpec)) {
      throw new KernelError("filter_invalid", {
        reason: `unknown QuerySpec field: ${JSON.stringify(key)}`,
      });
    }
  }
  if (spec.rank !== undefined) {
    if (typeof spec.rank !== "string" || spec.rank.trim().length === 0) {
      throw new KernelError("filter_invalid", {
        reason: "the `rank` mode requires a non-empty query string",
      });
    }
  }
  if (spec.limit !== undefined) {
    if (typeof spec.limit !== "number" || !Number.isSafeInteger(spec.limit) || spec.limit < 0) {
      throw new KernelError("filter_invalid", {
        reason: `invalid limit: ${JSON.stringify(spec.limit)}`,
      });
    }
  }
}

// -----------------------------------------------------------------------------
// Repo resolution
// -----------------------------------------------------------------------------

function filterReposByAccessAndSpec(
  actor: Actor,
  spec: QuerySpec,
  reposById: Map<number, RepoRow>,
  serverConfig: PathConfig,
): RepoRow[] {
  const patterns =
    spec.repo === undefined ? undefined : Array.isArray(spec.repo) ? spec.repo : [spec.repo];
  const systemSigils = serverConfig.system_sigils;
  return [...reposById.values()]
    .filter((repo) => {
      // Actor must be able to address the repo at all.
      if (!actor.admin && !actorBindsRepo(actor, repo.id)) return false;
      // System-namespaced repo slugs are always excluded from query
      // results. The query surface intentionally has no include-system
      // flag for repos themselves — `repos.list --include-system` is
      // the surface for that. Uses the configured system sigils so
      // migrations from `:` to `#` (etc.) don't leak deleted repos.
      if (systemSigils.some((sigil) => repo.slug.startsWith(sigil))) return false;
      if (patterns === undefined) return true;
      return patterns.some((pattern) => slugMatchesPattern(pattern, repo.slug));
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

function actorBindsRepo(actor: Actor, repoId: number): boolean {
  return actor.scopes.some(
    (s) => s.repos === "*" || (Array.isArray(s.repos) && s.repos.includes(repoId)),
  );
}

// -----------------------------------------------------------------------------
// Per-repo sigil exclusion (§5.1, §3.5.5)
// -----------------------------------------------------------------------------

function buildPerRepoSigilExclusion(
  repos: readonly RepoRow[],
  serverConfig: PathConfig,
  includeHidden: boolean,
  includeSystem: boolean,
): { sql: string; params: (string | number | bigint | null)[] } {
  if (repos.length === 0) return { sql: "", params: [] };
  // Group repos by their effective (hidden_sigils, system_sigils) — a
  // signature string keyed off the tuple. Repos sharing a group share
  // one exclusion sub-clause.
  const groups = new Map<string, { sigils: string[]; repoIds: number[] }>();
  for (const repo of repos) {
    const cfg = effectivePathConfig(serverConfig, parseRepoOverride(repo.path_config));
    const sigils: string[] = [];
    if (!includeHidden) sigils.push(...cfg.hidden_sigils);
    if (!includeSystem) sigils.push(...cfg.system_sigils);
    const key = JSON.stringify(sigils);
    const existing = groups.get(key);
    if (existing) {
      existing.repoIds.push(repo.id);
    } else {
      groups.set(key, { sigils, repoIds: [repo.id] });
    }
  }
  const clauses: string[] = [];
  const params: (string | number | bigint | null)[] = [];
  for (const { sigils, repoIds } of groups.values()) {
    if (sigils.length === 0) continue; // this group's repos have no exclusion
    // Emit in SQL text order: `repo_id NOT IN (...)` first (params ← repo
    // ids), then the sigil `NOT LIKE ?` clauses (params ← escaped patterns).
    // If we push in a different order the placeholders bind wrong.
    const repoPh = repoIds.map(() => "?").join(",");
    for (const id of repoIds) params.push(id);
    const sigilClauses: string[] = [];
    for (const sigil of sigils) {
      const escaped = sigil.replace(/[\\%_]/g, (ch) => `\\${ch}`);
      sigilClauses.push("versions.path NOT LIKE ? ESCAPE '\\'");
      sigilClauses.push("versions.path NOT LIKE ? ESCAPE '\\'");
      params.push(`${escaped}%`);
      params.push(`%/${escaped}%`);
    }
    clauses.push(`(versions.repo_id NOT IN (${repoPh}) OR (${sigilClauses.join(" AND ")}))`);
  }
  return { sql: clauses.join(" AND "), params };
}

// -----------------------------------------------------------------------------
// Scope filter → SQL (§8.2, compiled via the RE2-backed regexp UDF)
// -----------------------------------------------------------------------------

function buildScopeFilter(scopes: readonly StoredScope[]): {
  sql: string;
  params: (string | number | bigint | null)[];
} {
  // Compile each scope entry to a SQL sub-clause:
  //   (versions.repo_id IN (bound_repos) AND (path matches any read glob))
  // OR them together; a row is allowed if any scope entry admits it.
  //
  // Gitignore semantics for a glob list: last-match-wins with `!` as
  // negation, via a nested CASE over the RE2-backed regexp() UDF for each
  // pattern (see globsToLastMatchCaseSql).
  //
  // If the actor has NO scopes at all, the filter is `0` (falsy) — no
  // row is allowed. Consistent with §8.2's silent-drop.
  if (scopes.length === 0) return { sql: "0", params: [] };
  const scopeSqls: string[] = [];
  const scopeParams: (string | number | bigint | null)[] = [];
  for (const scope of scopes) {
    const globs = scope.read ?? [];
    if (globs.length === 0) continue; // no read → this scope contributes nothing
    // Emit in SQL text order: `repo_id IN (...)` first (bind ids), THEN the
    // regex patterns in the CASE.
    if (scope.repos === "*") {
      const globExpr = globsToLastMatchCaseSql(globs, scopeParams);
      scopeSqls.push(`(${globExpr})`);
    } else if (scope.repos.length > 0) {
      const ph = scope.repos.map(() => "?").join(",");
      for (const id of scope.repos) scopeParams.push(id);
      const globExpr = globsToLastMatchCaseSql(globs, scopeParams);
      scopeSqls.push(`(versions.repo_id IN (${ph}) AND (${globExpr}))`);
    }
  }
  if (scopeSqls.length === 0) return { sql: "0", params: [] };
  return { sql: scopeSqls.join(" OR "), params: scopeParams };
}

/**
 * Compile a gitignore-style glob list to a SQL expression that returns 1
 * if the last-matching glob is positive, 0 otherwise. Uses the
 * RE2-backed regexp() UDF for each pattern (fast + linear-time).
 *
 * Encoding: we CASE-walk the globs; each iteration sets a running
 * accumulator to 1 (positive match), 0 (negative match), or leaves it.
 * Because SQL doesn't have iterative state, we simulate with a nested
 * CASE — last-match-wins by evaluating in REVERSE glob order and
 * short-circuiting on the first match.
 */
function globsToLastMatchCaseSql(
  globs: readonly string[],
  params: (string | number | bigint | null)[],
): string {
  // Build a nested CASE that evaluates each glob outer-to-inner in
  // GLOB-ORDER — meaning the LAST glob's check is the OUTERMOST CASE, so
  // its verdict wins when it matches (last-match-wins per gitignore
  // semantics). A missing match yields 0 (no coverage).
  //
  // SQL `?` placeholders bind positionally by their appearance in the
  // SQL text, so params must land in outermost-first order — we walk
  // globs forward and UNSHIFT into a local params list so the LAST glob
  // (which we wrapped last, i.e. outermost) ends up first in the list.
  let expr = "0";
  const localParams: string[] = [];
  for (let i = 0; i < globs.length; i++) {
    const g = globs[i] as string;
    const negated = g.startsWith("!");
    const raw = negated ? g.slice(1) : g;
    const regex = `^${globToRegexSource(raw)}$`;
    // This iteration wraps the current accumulator as the ELSE branch,
    // making the new WHEN clause the outermost. Its `?` will appear
    // FIRST in the SQL text — so its pattern goes to the head of the
    // local params list.
    localParams.unshift(regex);
    expr = `(CASE WHEN regexp(?, versions.path) THEN ${negated ? "0" : "1"} ELSE ${expr} END)`;
  }
  for (const p of localParams) params.push(p);
  return expr;
}

// -----------------------------------------------------------------------------
// Utility
// -----------------------------------------------------------------------------

function joinWhere(fragments: readonly string[]): string {
  const nonEmpty = fragments.map((f) => f.trim()).filter((f) => f.length > 0);
  if (nonEmpty.length === 0) return "";
  if (nonEmpty.length === 1) return nonEmpty[0] as string;
  return nonEmpty.map((f) => `(${f})`).join(" AND ");
}

/**
 * Compute a repo's effective config — exported for callers that want to
 * apply per-repo sigils outside the main query loop (e.g., surfaces).
 */
export function repoEffectiveConfig(repo: RepoRow, serverConfig: PathConfig): PathConfig {
  return effectivePathConfig(serverConfig, parseRepoOverride(repo.path_config));
}
