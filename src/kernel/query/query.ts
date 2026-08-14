/**
 * kernel.query orchestration — design §5.
 *
 * Composes:
 *   • CEL filter (§5.1) — compiled to SQL via compile-sqlite.ts
 *   • FTS text (§5.1) — the SQLite FTS5 branch is wired in the adapter
 *   • Scope filter (§8.2) — the caller's read globs, post-filtered in TS
 *     (M2 simplification — see comment in filterByScope). Silently drops
 *     rows outside scope, not 403.
 *   • Default sigil exclusion (§5.1) — hidden/system paths hidden unless
 *     opt-in flags are set.
 *   • Result ordering (§5.1 pin) — text-score if `text` is present,
 *     else `$created_at DESC`.
 *   • Limit — required; kernel provides the default.
 *
 * `rank` is deferred to M4; queries with `rank` set return filter_invalid.
 */

import type { RepoRow, Storage, VersionRow } from "../../storage/types.js";
import type { Actor } from "../auth/actor.js";
import { pathMatchesGlobs } from "../auth/glob.js";
import { slugMatchesPattern } from "../auth/glob.js";
import { KernelError } from "../errors.js";
import type { PathConfig } from "../path-config.js";
import { effectivePathConfig, parseRepoOverride } from "../path-config.js";
import { pathHasSigilSegment } from "../validation.js";
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

export type QueryDeps = {
  storage: Storage;
  serverPathConfig: PathConfig;
  toVersionWire: (row: VersionRow, repoSlug: string) => Version;
};

/** M2 default when the spec omits limit. */
export const DEFAULT_QUERY_LIMIT = 50;

/** Overfetch multiplier so post-filter scope drops don't shrink the result. */
const OVERFETCH_MULTIPLIER = 4;
const MAX_INTERNAL_LIMIT = 1_000;

export function runQuery(actor: Actor, spec: QuerySpec, deps: QueryDeps): Version[] {
  validateSpec(spec);

  // 1. Resolve repos the caller can address.
  const reposById = new Map<number, RepoRow>();
  for (const row of deps.storage.repos_list()) reposById.set(row.id, row);
  const targetRepos = filterReposByAccessAndSpec(actor, spec, reposById);
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

  // 3. Sigil exclusion — build a WHERE clause using the server-level config.
  //    (Per-repo overrides are noted as an M2 limitation — see comment.)
  const sigilExclusion = buildSigilExclusion(
    deps.serverPathConfig,
    spec.include_hidden ?? false,
    spec.include_system ?? false,
  );
  const combinedWhere = combineWhere(whereSql, sigilExclusion.sql);
  const combinedParams: (string | number | bigint | null)[] = [
    ...whereParams,
    ...sigilExclusion.params,
  ];

  // 4. Overfetch to keep the caller-facing `limit` honest under post-filter
  //    scope drops.
  const userLimit = spec.limit ?? DEFAULT_QUERY_LIMIT;
  if (userLimit <= 0) return [];
  const internalLimit = actor.admin
    ? userLimit
    : Math.min(userLimit * OVERFETCH_MULTIPLIER, MAX_INTERNAL_LIMIT);

  // 5. Run the storage-level search.
  const rows = deps.storage.versions_search({
    repo_ids: targetRepos.map((r) => r.id),
    where_sql: combinedWhere,
    where_params: combinedParams,
    text: spec.text,
    limit: internalLimit,
  });

  // 6. Post-filter for scope (§8.2). Admins skip.
  const scoped = actor.admin ? rows : rows.filter((row) => scopeAllowsRow(actor, row));

  // 7. Slice to the user-facing limit.
  const bounded = scoped.slice(0, userLimit);

  // 8. Hydrate into wire Version[].
  return bounded.map((row) => {
    const repoSlug = (reposById.get(row.repo_id) as RepoRow).slug;
    return deps.toVersionWire(row, repoSlug);
  });
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

function validateSpec(spec: QuerySpec): void {
  if (spec.rank !== undefined) {
    throw new KernelError("filter_invalid", {
      reason: "the `rank` mode is deferred to M4 (embeddings)",
    });
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
): RepoRow[] {
  const patterns =
    spec.repo === undefined ? undefined : Array.isArray(spec.repo) ? spec.repo : [spec.repo];
  return [...reposById.values()]
    .filter((repo) => {
      // Actor must be able to address the repo at all.
      if (!actor.admin && !actorBindsRepo(actor, repo.id)) return false;
      // Skip system-namespaced repo slugs unless include_system flag.
      // (System repos are only surfaced by repos.list with include_system.)
      // No wire flag for this in query; system repos are always excluded here.
      if (repo.slug.startsWith(":")) return false;
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
// Sigil exclusion (§5.1)
// -----------------------------------------------------------------------------

function buildSigilExclusion(
  serverConfig: PathConfig,
  includeHidden: boolean,
  includeSystem: boolean,
): { sql: string; params: (string | number | bigint | null)[] } {
  // NOTE (m2-plan §7): For M2 we use server-level config sigils, not the
  // per-repo effective config. Real per-repo differences in sigils are
  // rare (path config is setup-time — §3.5.2); when they matter, this
  // should be refactored to build one per-repo clause each.
  const sigils: string[] = [];
  if (!includeHidden) sigils.push(...serverConfig.hidden_sigils);
  if (!includeSystem) sigils.push(...serverConfig.system_sigils);
  if (sigils.length === 0) return { sql: "", params: [] };
  const clauses: string[] = [];
  const params: (string | number | bigint | null)[] = [];
  for (const sigil of sigils) {
    const escaped = sigil.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    // Segment-starts-with-sigil in one of two positions:
    //   • start of path                    → path LIKE 'S%'
    //   • immediately after a '/'          → path LIKE '%/S%'
    clauses.push("versions.path NOT LIKE ? ESCAPE '\\'");
    clauses.push("versions.path NOT LIKE ? ESCAPE '\\'");
    params.push(`${escaped}%`);
    params.push(`%/${escaped}%`);
  }
  return { sql: clauses.join(" AND "), params };
}

// -----------------------------------------------------------------------------
// Scope post-filter (§8.2)
// -----------------------------------------------------------------------------

function scopeAllowsRow(actor: Actor, row: VersionRow): boolean {
  for (const scope of actor.scopes) {
    if (!scopeCoversRepo(scope, row.repo_id)) continue;
    const globs = scope.read ?? [];
    if (pathMatchesGlobs(globs, row.path)) return true;
  }
  return false;
}

function scopeCoversRepo(scope: { repos: "*" | number[] }, repoId: number): boolean {
  if (scope.repos === "*") return true;
  return scope.repos.includes(repoId);
}

// -----------------------------------------------------------------------------
// Utility
// -----------------------------------------------------------------------------

function combineWhere(a: string, b: string): string {
  const aTrim = a.trim();
  const bTrim = b.trim();
  if (!aTrim) return bTrim;
  if (!bTrim) return aTrim;
  return `(${aTrim}) AND (${bTrim})`;
}

/**
 * Compute a repo's effective config — exported for callers that want to
 * apply per-repo sigils outside the main query loop (e.g., surfaces).
 */
export function repoEffectiveConfig(repo: RepoRow, serverConfig: PathConfig): PathConfig {
  return effectivePathConfig(serverConfig, parseRepoOverride(repo.path_config));
}

// Also referenced from tests to spot-check sigil exclusion behavior.
export const __internal = { pathHasSigilSegment };
