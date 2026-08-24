/**
 * kernel.query orchestration — design §5.
 *
 * The kernel resolves repo access, parses CEL eagerly (so
 * `filter_invalid` surfaces before storage), and builds a structured
 * `SearchPlan` the adapter compiles into its dialect's SQL (m5-plan
 * WS2). Rank mode composes vector_search → SearchPlan with a
 * candidate-id whitelist.
 */

import type { SearchPlan, SigilExclusion } from "../../storage/search-plan.js";
import type { RepoRow, Storage, VersionRow } from "../../storage/types.js";
import { slugMatchesPattern } from "../auth/glob.js";
import { type ClaimMatcher, claimsGrantRepo, claimsToScopeGroups } from "../auth/scope.js";
import { KernelError } from "../errors.js";
import type { PathConfig } from "../path-config.js";
import { effectivePathConfig, parseRepoOverride } from "../path-config.js";
import type { QueryHit, Version } from "../wire.js";
import type { CelExpr } from "./ast.js";
import { parseCel } from "./cel-parse.js";

export type QuerySpec = {
  /** Slug, glob, or list. Omitted = every repo the caller can address. */
  repo?: string | string[];
  filter?: string;
  text?: string;
  rank?: string;
  limit?: number;
  include_hidden?: boolean;
  include_system?: boolean;
  /**
   * Fields to project onto each hit (docs/query-select-plan.md). Names bare
   * frontmatter keys (`title`) or `$`-intrinsics (`$path`, `$body`, …).
   * Defaults to `["$path"]` — the identity you almost always want and the
   * cheapest thing to return.
   */
  select?: string[];
};

const KNOWN_SPEC_FIELDS = new Set<keyof QuerySpec>([
  "repo",
  "filter",
  "text",
  "rank",
  "limit",
  "include_hidden",
  "include_system",
  "select",
]);

/**
 * Projectable `$`-intrinsics (docs/query-select-plan.md §3): the filter
 * compilers' filterable columns (`$path`, `$updated_at`, `$body`) plus the
 * version-identity fields that are projectable but not filterable. Each maps
 * a `$name` to the value read off the already-built `Version` wire object.
 * `select` validates against this registry and rejects unknown `$names`.
 */
const INTRINSIC_PROJECTORS: Record<string, (v: Version) => unknown> = {
  $path: (v) => v.path,
  $repo: (v) => v.repo,
  $version_id: (v) => v.version_id,
  $prev_version_id: (v) => v.prev_version_id,
  $next_version_id: (v) => v.next_version_id,
  $updated_at: (v) => v.created_at,
  $author: (v) => v.author,
  $body: (v) => v.body,
};

/** Identity default — the cheapest useful projection (§2). */
const DEFAULT_SELECT = ["$path"] as const;

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

/**
 * `claims` is null when the call supplies no scope (full visibility) or a
 * normalized `ClaimMatcher[]` narrowing what's visible (noauth plan §1).
 */
export async function runQuery(
  claims: ClaimMatcher[] | null,
  spec: QuerySpec,
  deps: QueryDeps,
): Promise<QueryHit[]> {
  validateSpec(spec);
  const select = spec.select ?? [...DEFAULT_SELECT];

  // 1. Resolve repos the caller can address.
  const reposById = new Map<number, RepoRow>();
  for (const row of await deps.storage.repos_list()) reposById.set(row.id, row);
  const targetRepos = filterReposByAccessAndSpec(claims, spec, reposById, deps.serverPathConfig);
  if (targetRepos.length === 0) return [];

  // 2. Parse CEL filter eagerly — `filter_invalid` before storage.
  let filterAst: CelExpr | undefined;
  if (spec.filter !== undefined) {
    const ast = parseCel(spec.filter);
    if (!ast.expr) {
      throw new KernelError("filter_invalid", { reason: "empty filter" });
    }
    filterAst = ast.expr;
  }

  // 3. Per-repo sigil exclusion (§3.5.5).
  const sigils = buildPerRepoSigilExclusion(
    targetRepos,
    deps.serverPathConfig,
    spec.include_hidden ?? false,
    spec.include_system ?? false,
  );

  // 4. Scope filter — absent claims see everything; claims contribute groups.
  const scope = buildScope(claims, targetRepos);

  const userLimit = spec.limit ?? DEFAULT_QUERY_LIMIT;
  if (userLimit <= 0) return [];

  // 5. Rank branch (M4): vector_search → candidate whitelist → SearchPlan.
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
    if (embed.vector.length !== embed.dim) {
      throw new KernelError("rank_unavailable", {
        reason: `embedding hook returned vector.length ${embed.vector.length} != dim ${embed.dim}`,
      });
    }

    const rankK = Math.min(userLimit * 4, 200);
    const hits = await deps.storage.vector_search(
      targetRepos.map((r) => r.id),
      embed.model,
      embed.vector,
      rankK,
    );
    if (hits.length === 0) return [];

    const candidateIds = hits.map((h) => h.version_id);
    const scoreById = new Map(hits.map((h) => [h.version_id, h.score]));
    const plan: SearchPlan = {
      repo_ids: targetRepos.map((r) => r.id),
      limit: candidateIds.length,
      text: spec.text,
      filter_ast: filterAst,
      sigils,
      scope,
      candidate_ids: candidateIds,
    };
    const rows = await deps.storage.versions_search(plan);
    rows.sort((a, b) => (scoreById.get(a.id) ?? 1) - (scoreById.get(b.id) ?? 1));
    return rows.slice(0, userLimit).map((row) => {
      const repoSlug = (reposById.get(row.repo_id) as RepoRow).slug;
      return projectHit(deps.toVersionWire(row, repoSlug), select);
    });
  }

  // 6. Non-rank path.
  const plan: SearchPlan = {
    repo_ids: targetRepos.map((r) => r.id),
    limit: userLimit,
    text: spec.text,
    filter_ast: filterAst,
    sigils,
    scope,
  };
  const rows = await deps.storage.versions_search(plan);

  return rows.map((row) => {
    const repoSlug = (reposById.get(row.repo_id) as RepoRow).slug;
    return projectHit(deps.toVersionWire(row, repoSlug), select);
  });
}

/**
 * Project a full `Version` wire object down to a lean `QueryHit` per the
 * `select` field list. `$`-prefixed names read intrinsics from the registry;
 * bare names read frontmatter (a missing key is simply absent, matching
 * `graph`'s `select`). Order follows `select` for deterministic key order.
 */
function projectHit(v: Version, select: readonly string[]): QueryHit {
  const hit: QueryHit = {};
  for (const name of select) {
    if (name.startsWith("$")) {
      hit[name as `$${string}`] = INTRINSIC_PROJECTORS[name]!(v);
    } else if (v.frontmatter[name] !== undefined) {
      hit[name] = v.frontmatter[name];
    }
  }
  return hit;
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

function validateSpec(spec: QuerySpec): void {
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
  if (spec.select !== undefined) {
    if (!Array.isArray(spec.select) || spec.select.some((s) => typeof s !== "string")) {
      throw new KernelError("filter_invalid", { reason: "select must be an array of strings" });
    }
    for (const name of spec.select) {
      if (name.startsWith("$") && !(name in INTRINSIC_PROJECTORS)) {
        // Derive the "expected" list from the registry so the message can't
        // drift from the code (mirrors the filter compiler's intrinsic error).
        const expected = Object.keys(INTRINSIC_PROJECTORS).join(", ");
        throw new KernelError("filter_invalid", {
          reason: `unknown intrinsic ${name} in select (expected ${expected})`,
        });
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Repo resolution
// -----------------------------------------------------------------------------

function filterReposByAccessAndSpec(
  claims: ClaimMatcher[] | null,
  spec: QuerySpec,
  reposById: Map<number, RepoRow>,
  serverConfig: PathConfig,
): RepoRow[] {
  const patterns =
    spec.repo === undefined ? undefined : Array.isArray(spec.repo) ? spec.repo : [spec.repo];
  const systemSigils = serverConfig.system_sigils;
  return [...reposById.values()]
    .filter((repo) => {
      if (claims !== null && !claimsGrantRepo(claims, repo.slug)) return false;
      if (systemSigils.some((sigil) => repo.slug.startsWith(sigil))) return false;
      if (patterns === undefined) return true;
      return patterns.some((pattern) => slugMatchesPattern(pattern, repo.slug));
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

// -----------------------------------------------------------------------------
// Per-repo sigil exclusion (§5.1, §3.5.5)
// -----------------------------------------------------------------------------

function buildPerRepoSigilExclusion(
  repos: readonly RepoRow[],
  serverConfig: PathConfig,
  includeHidden: boolean,
  includeSystem: boolean,
): SigilExclusion[] {
  if (repos.length === 0) return [];
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
  const out: SigilExclusion[] = [];
  for (const { sigils, repoIds } of groups.values()) {
    if (sigils.length === 0) continue;
    out.push({ repo_ids: repoIds, sigils });
  }
  return out;
}

// -----------------------------------------------------------------------------
// Scope → SearchPlan.scope (§8.2)
// -----------------------------------------------------------------------------

function buildScope(
  claims: ClaimMatcher[] | null,
  targetRepos: readonly RepoRow[],
): SearchPlan["scope"] {
  // Absent scope = full visibility. The repo-access filter already limited
  // targetRepos, so an empty groups list here means the claims grant no path
  // in any addressable repo — deny.
  if (claims === null) return { kind: "allow_all" };
  const groups = claimsToScopeGroups(claims, targetRepos);
  if (groups.length === 0) return { kind: "deny_all" };
  return { kind: "groups", groups };
}

/**
 * Compute a repo's effective config — exported for callers that want to
 * apply per-repo sigils outside the main query loop (e.g., surfaces).
 */
export function repoEffectiveConfig(repo: RepoRow, serverConfig: PathConfig): PathConfig {
  return effectivePathConfig(serverConfig, parseRepoOverride(repo.path_config));
}
