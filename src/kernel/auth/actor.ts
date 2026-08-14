/**
 * Actor + authorization types — design §6.1, §8.
 *
 * The `Actor` is the resolved identity attached to every kernel call. It's
 * populated by the auth middleware (see resolveActor in ./tokens.ts) after
 * the bearer token is looked up and its scopes hydrated to internal repo ids.
 *
 * The kernel calls `authorize(actor, action, target)` (see ./authorize.ts)
 * before every op — its shape is defined here so the kernel signature and
 * the real check stay decoupled.
 */

/**
 * Stored form of a scope entry — internal repo ids (except the dynamic "*"
 * wildcard, which keeps covering repos created after issuance per §8.2).
 * The wire form (see kernel/wire.ts Scope) uses current slugs.
 */
export type StoredScope = {
  repos: "*" | number[];
  read?: string[];
  write?: string[];
};

export type Actor = {
  user_id: number;
  scopes: StoredScope[];
  admin: boolean;
  /** Present when derived from a real token; absent for kernel-driven ops. */
  token_id?: number;
};

export type Action = "read" | "write" | "admin";

/**
 * Authorization target shapes. Targets carry the resolved `repo_id` (not the
 * slug) because scopes bind ids (§8.2 — repo renames don't break tokens).
 * The kernel resolves the slug once and reuses the row for both storage and
 * authorization.
 *
 * `move` is used for `docs.put` where the caller moves a doc from one path
 * to another — the design's "both endpoints match write" rule (§8.2) with
 * the system-namespace carve-out applies here.
 */
export type Target =
  | { kind: "server" }
  | { kind: "server_admin" } // admin-gated server op (users.*, repos.create/rename/delete/set_path_config, cross-user token mgmt)
  | { kind: "repo"; repo_id: number }
  | { kind: "path"; repo_id: number; path: string }
  | {
      kind: "move";
      repo_id: number;
      source: string;
      destination: string;
      /**
       * Effective system-sigil prefixes for THIS repo (not the hardcoded
       * defaults). authorize() uses them to apply the system-namespace
       * carve-out (§8.2) against a repo that may have overridden its
       * system_sigils via repos.set_path_config.
       */
      system_sigils: readonly string[];
    };

/**
 * Kernel-internal system actor. Used for calls the kernel makes on its own
 * behalf (e.g. `docs.delete`'s move to the system-namespace path, which
 * bypasses "no writing under system sigils" — the check that WOULD reject a
 * user attempt). Also used by the bootstrap command before any real token
 * exists. Never handed out through any surface.
 */
export const SYSTEM_ACTOR: Actor = {
  user_id: 0,
  scopes: [{ repos: "*", read: ["**"], write: ["**"] }],
  admin: true,
};
