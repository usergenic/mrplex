/**
 * The real `authorize()` — design §8.2.
 *
 * Wired at every kernel op via M0's target plumbing; kernel signatures don't
 * change. `admin: true` short-circuits every action. For scope-gated reads
 * and writes, we walk actor.scopes with gitignore-style glob semantics
 * (see ./glob.ts and ./scope.ts).
 *
 * The action / target matrix (§8.2):
 *
 *   read  server            → always allowed (surface filters output)
 *   read  server_admin      → admin only
 *   read  repo(id)          → scope covers repo AND has any read glob
 *   read  path(id, path)    → scope covers repo AND read globs match path
 *   write path(id, path)    → scope covers repo AND write globs match path
 *   write move(...)         → both endpoints' write, minus system-namespace
 *                             carve-out (source or dest under a sigil is
 *                             kernel-controlled and skipped)
 *   admin server_admin      → admin only
 *   admin *                 → admin only
 */

import { forbidden } from "../errors.js";
import type { Action, Actor, Target } from "./actor.js";
import { moveEndpointsToCheck, scopesGrant, scopesGrantRepo } from "./scope.js";

export function authorize(actor: Actor, action: Action, target: Target): void {
  // Admin short-circuits every action, per §8.2.
  if (actor.admin) return;

  // Any admin-required target requires the admin bit.
  if (target.kind === "server_admin" || action === "admin") {
    throw forbidden();
  }

  // Reads at the server level are always allowed — the surface filters
  // results down to what the caller can see (§8.2 — "repos.list returns
  // only repos bound by at least one of the token's scopes").
  if (target.kind === "server") return;

  if (target.kind === "repo") {
    // `{kind:"repo"}` is a COARSE addressability check — "can this actor
    // reach this repo at all?" — regardless of read/write. It's the
    // pre-check we run before finer-grained {kind:"path"} or
    // {kind:"move"} authorization for the specific op. If no scope binds
    // the repo id, forbidden either way.
    if (scopesGrantRepo(actor.scopes, target.repo_id)) return;
    throw forbidden();
  }

  if (target.kind === "path") {
    if (scopesGrant(actor.scopes, action as "read" | "write", target.repo_id, target.path)) {
      return;
    }
    throw forbidden();
  }

  if (target.kind === "move") {
    if (action !== "write") throw forbidden();
    // System-namespace carve-out (§8.2): a move where one endpoint is under
    // a system sigil skips scope check on that endpoint. The kernel emits
    // system-namespace paths on its own behalf (delete/restore).
    //
    // The move target carries the REPO's effective system_sigils (not the
    // hardcoded defaults), so a repo that overrode its sigils via
    // repos.set_path_config still gets a correct carve-out on delete/restore.
    const endpoints = moveEndpointsToCheck(target.source, target.destination, target.system_sigils);
    for (const path of endpoints) {
      if (!scopesGrant(actor.scopes, "write", target.repo_id, path)) {
        throw forbidden();
      }
    }
    return;
  }

  // Exhaustiveness check — the compiler catches any unhandled kind.
  const _exhaustive: never = target;
  void _exhaustive;
  throw forbidden();
}
