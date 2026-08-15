/**
 * Scope grammar — design §8.2.
 *
 * The wire form (ScopeInput) carries slug patterns; the stored form
 * (StoredScope) carries resolved repo ids. This module owns the translation
 * between them, plus:
 *
 *   • the child-token subset check for self-token creation (§8.2)
 *   • the system-namespace carve-out helper (moves where one endpoint is
 *     under a system sigil check scope only on the user-territory endpoint)
 */

import type { Storage } from "../../storage/types.js";
import { pathIsInSystemNamespace } from "../deletion.js";
import type { StoredScope } from "./actor.js";
import { pathMatchesGlobs, slugMatchesPattern } from "./glob.js";

// -----------------------------------------------------------------------------
// Wire input types.
// -----------------------------------------------------------------------------

/** Design §6.4 ScopeInput — accepted by tokens.create. */
export type ScopeInput = {
  repo: string | string[];
  read?: string | string[];
  write?: string | string[];
};

const asList = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

// -----------------------------------------------------------------------------
// ScopeInput → StoredScope at token creation.
// -----------------------------------------------------------------------------

/**
 * Resolve one ScopeInput entry against the current repo set (§8.2). Repo
 * patterns evaluate at creation time; the literal `"*"` (in any position of
 * the repo pattern list) short-circuits to the dynamic all-repos wildcard,
 * which covers repos created after issuance. Non-`"*"` patterns are snapshots.
 */
export async function resolveScopeInput(input: ScopeInput, storage: Storage): Promise<StoredScope> {
  const repoPatterns = asList(input.repo);
  if (repoPatterns.length === 0) {
    throw new Error("scope entry has no repo pattern");
  }
  let repos: "*" | number[];
  if (repoPatterns.includes("*")) {
    repos = "*";
  } else {
    const allRepos = await storage.repos_list();
    const matched = new Set<number>();
    for (const pattern of repoPatterns) {
      for (const repo of allRepos) {
        if (slugMatchesPattern(pattern, repo.slug)) {
          matched.add(repo.id);
        }
      }
    }
    repos = [...matched].sort((a, b) => a - b);
  }
  const out: StoredScope = { repos };
  const read = asList(input.read);
  const write = asList(input.write);
  if (read.length > 0) out.read = read;
  if (write.length > 0) out.write = write;
  return out;
}

export async function resolveScopeInputs(
  inputs: ScopeInput[],
  storage: Storage,
): Promise<StoredScope[]> {
  const out: StoredScope[] = [];
  for (const i of inputs) out.push(await resolveScopeInput(i, storage));
  return out;
}

// -----------------------------------------------------------------------------
// Subset check for child-token creation (§8.2).
//
// Verbatim structural subset (m1-plan §3 WS5 — decidable, conservative):
//   • Every capability the child has must be covered by SOME capability the
//     parent has.
//   • A "capability" here is the flat tuple (repos, action, glob) — read
//     globs are compared to parent's read globs; write to write. Both the
//     glob string AND the repo binding must line up verbatim, except "*" on
//     the parent side covers any child repo binding.
//
// Rejects (correctly, per m1-plan) semantically-equivalent-but-differently-
// spelled child globs like `drafts/**` when the parent has `drafts/*/*` —
// the design's `[OPEN]` marker acknowledges this. Users can always re-spell.
// -----------------------------------------------------------------------------

type Capability = {
  repos: "*" | number;
  action: "read" | "write";
  glob: string;
};

function flattenScopes(scopes: StoredScope[]): Capability[] {
  const caps: Capability[] = [];
  for (const s of scopes) {
    const bindings: ("*" | number)[] = s.repos === "*" ? ["*"] : s.repos;
    for (const binding of bindings) {
      for (const g of s.read ?? []) caps.push({ repos: binding, action: "read", glob: g });
      for (const g of s.write ?? []) {
        caps.push({ repos: binding, action: "write", glob: g });
      }
    }
  }
  return caps;
}

function parentCoversChild(parent: Capability, child: Capability): boolean {
  if (parent.action !== child.action) return false;
  if (parent.glob !== child.glob) return false;
  if (parent.repos === "*") return true; // "*" on the parent covers anything
  if (child.repos === "*") return false; // parent concrete can't cover child "*"
  return parent.repos === child.repos;
}

/**
 * Throws if the child scopes are not a verbatim structural subset of the
 * parent scopes. The child is expected to already be resolved to
 * StoredScope form (repo ids).
 */
export function assertChildScopeSubset(
  parentScopes: StoredScope[],
  childScopes: StoredScope[],
): void {
  const parent = flattenScopes(parentScopes);
  const child = flattenScopes(childScopes);
  for (const c of child) {
    if (!parent.some((p) => parentCoversChild(p, c))) {
      throw new Error(`child scope not covered by parent: ${JSON.stringify(c)}`);
    }
  }
}

/**
 * Admin subset: a non-admin parent cannot mint an admin child.
 */
export function assertAdminSubset(parentAdmin: boolean, childAdmin: boolean): void {
  if (childAdmin && !parentAdmin) {
    throw new Error("cannot create an admin token: parent is not admin");
  }
}

// -----------------------------------------------------------------------------
// Runtime scope evaluation — used by authorize().
// -----------------------------------------------------------------------------

/**
 * Does any scope entry in `scopes` grant `action` for `path` in repo `repo_id`?
 * Follows gitignore's per-glob-list "last match wins" (see glob.ts), then
 * OR'd across scope entries (design §8.2 — "Multiple scope entries stack —
 * union semantics").
 */
export function scopesGrant(
  scopes: readonly StoredScope[],
  action: "read" | "write",
  repo_id: number,
  path: string,
): boolean {
  for (const scope of scopes) {
    if (!scopeCoversRepo(scope, repo_id)) continue;
    const globs = action === "read" ? (scope.read ?? []) : (scope.write ?? []);
    if (pathMatchesGlobs(globs, path)) return true;
  }
  return false;
}

/**
 * Does any scope entry in `scopes` grant read on the repo at all (regardless
 * of path)? Used by `repos.list` to filter results (§8.2 — "repos.list
 * returns only repos bound by at least one of the token's scopes").
 */
export function scopesGrantRepo(scopes: readonly StoredScope[], repo_id: number): boolean {
  for (const scope of scopes) {
    if (scopeCoversRepo(scope, repo_id)) return true;
  }
  return false;
}

function scopeCoversRepo(scope: StoredScope, repo_id: number): boolean {
  if (scope.repos === "*") return true;
  return scope.repos.includes(repo_id);
}

// -----------------------------------------------------------------------------
// System-namespace carve-out (§8.2).
// -----------------------------------------------------------------------------

/**
 * For a `docs.put` move, decide which endpoints need to be scope-checked.
 * If EXACTLY ONE endpoint is under a system sigil, only the user-territory
 * endpoint is checked (design §8.2 — "the system-namespace endpoint is
 * kernel-controlled"). If both are user territory, both are checked. If
 * both are system (shouldn't happen in the user-write path — the kernel
 * only writes to one system endpoint at a time), neither is checked.
 */
export function moveEndpointsToCheck(
  source: string,
  destination: string,
  systemSigils: readonly string[],
): string[] {
  const sourceIsSystem = pathIsInSystemNamespace(source, systemSigils);
  const destIsSystem = pathIsInSystemNamespace(destination, systemSigils);
  if (sourceIsSystem && !destIsSystem) return [destination];
  if (!sourceIsSystem && destIsSystem) return [source];
  if (sourceIsSystem && destIsSystem) return [];
  return [source, destination];
}
