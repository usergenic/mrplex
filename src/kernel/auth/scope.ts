/**
 * Read-scope claim evaluation — design §8.2, noauth plan §1.
 *
 * A `CallContext.scope` (ScopeClaim[]) narrows a call's visibility. Claims
 * name repos by slug pattern and paths by gitignore-style globs, and are
 * evaluated against the repos existing at call time — there is no issuance
 * snapshot and no repo-id binding (noauth plan decision 4). A claim names what
 * it names right now.
 *
 * This module owns:
 *   • claim normalization (`ScopeClaim` → `ClaimMatcher[]`)
 *   • the runtime grant checks (`claimsGrantRead`, `claimsGrantRepo`)
 *   • compilation to `SearchPlan` scope groups (`claimsToScopeGroups`) — the
 *     seam into the adapter's silent search filtering, unchanged from tokens;
 *     only the provenance of the globs changed (per-call input, not a row).
 *
 * The old token machinery (id resolution, subset assertions, the child-token
 * subset check) is gone: a caller who can supply a claim can supply a wider
 * one, so narrowing across trust levels is the shell's concern, not ours.
 */

import type { ScopeGroup } from "../../storage/search-plan.js";
import type { RepoRow } from "../../storage/types.js";
import type { ScopeClaim } from "../context.js";
import { pathMatchesGlobs, slugMatchesPattern } from "./glob.js";

const asList = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

/**
 * Normalized claim: repo patterns split from the `"*"` fast-path, plus the
 * read globs. `hasWildcard` distinguishes the dynamic all-repos claim (covers
 * repos created after the call is issued) for scope-group compilation.
 */
export type ClaimMatcher = {
  repoPatterns: string[];
  hasWildcard: boolean;
  read: string[];
};

export function normalizeClaims(claims: readonly ScopeClaim[]): ClaimMatcher[] {
  return claims.map((c) => {
    const repoPatterns = asList(c.repo);
    return {
      repoPatterns,
      hasWildcard: repoPatterns.includes("*"),
      read: asList(c.read),
    };
  });
}

function matcherCoversRepo(m: ClaimMatcher, repoSlug: string): boolean {
  if (m.hasWildcard) return true;
  return m.repoPatterns.some((p) => slugMatchesPattern(p, repoSlug));
}

/**
 * Does any claim grant read on `path` in the repo named `repoSlug`? Follows
 * gitignore's per-glob-list "last match wins" (see glob.ts), OR'd across
 * claims (union semantics, §8.2).
 */
export function claimsGrantRead(
  matchers: readonly ClaimMatcher[],
  repoSlug: string,
  path: string,
): boolean {
  for (const m of matchers) {
    if (!matcherCoversRepo(m, repoSlug)) continue;
    if (pathMatchesGlobs(m.read, path)) return true;
  }
  return false;
}

/**
 * Does any claim bind `repoSlug` at all (regardless of path)? Coarse
 * addressability — used by `repos.list` and query repo resolution to filter
 * to claimed repos (§8.2).
 */
export function claimsGrantRepo(matchers: readonly ClaimMatcher[], repoSlug: string): boolean {
  return matchers.some((m) => matcherCoversRepo(m, repoSlug));
}

/**
 * Compile claims into `SearchPlan` scope groups against the current repo set.
 * A wildcard claim maps to the dynamic `"*"` group; a concrete claim resolves
 * its repo patterns to the matching current repo ids. Claims with no read
 * globs contribute nothing (they grant no path).
 */
export function claimsToScopeGroups(
  matchers: readonly ClaimMatcher[],
  repos: readonly RepoRow[],
): ScopeGroup[] {
  const groups: ScopeGroup[] = [];
  for (const m of matchers) {
    if (m.read.length === 0) continue;
    if (m.hasWildcard) {
      groups.push({ repos: "*", globs: m.read });
      continue;
    }
    const ids = repos
      .filter((r) => m.repoPatterns.some((p) => slugMatchesPattern(p, r.slug)))
      .map((r) => r.id);
    if (ids.length > 0) groups.push({ repos: ids, globs: m.read });
  }
  return groups;
}
