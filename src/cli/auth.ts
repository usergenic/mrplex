/**
 * CLI auth glue — turn a bearer secret into a resolved kernel Actor.
 *
 * Precedence:
 *   1. --token flag
 *   2. MRPLEX_TOKEN env var
 *   3. token from ~/.config/mrplex/config.json
 *   4. no token → SYSTEM_ACTOR for local kernel access (M1 dev ergonomics)
 *
 * The SYSTEM_ACTOR fallback exists because M0 didn't require any token and
 * the transition to M1 shouldn't blow up local dev workflows. The behavior
 * is documented in mrplex --help; anyone shipping a mrplex to production
 * mounts it behind M3's HTTP surface, where the fallback doesn't apply.
 */

import { type Actor, SYSTEM_ACTOR } from "../kernel/auth/actor.js";
import { resolveActor } from "../kernel/auth/tokens.js";
import type { Storage } from "../storage/types.js";
import { loadConfig } from "./config.js";

/**
 * Resolve which bearer secret the CLI should use (raw string only — no
 * lookup yet). Returns null if none is configured; the CLI treats null
 * as "use SYSTEM_ACTOR in local mode."
 */
export function resolveTokenString(cliFlag: string | undefined): string | null {
  if (cliFlag) return cliFlag;
  const envToken = process.env.MRPLEX_TOKEN;
  if (envToken) return envToken;
  const cfg = loadConfig();
  return cfg.token ?? null;
}

/**
 * Resolve the CLI's actor from the token string + storage. If no token is
 * configured, returns SYSTEM_ACTOR (local dev fallback). If a token IS
 * configured but doesn't resolve, throws "unauthorized" — the caller
 * should map this to exit code 3.
 */
export function resolveCliActor(cliFlag: string | undefined, storage: Storage): Actor {
  const secret = resolveTokenString(cliFlag);
  if (secret === null) {
    // No token configured — local dev fallback.
    return SYSTEM_ACTOR_LOCAL;
  }
  const actor = resolveActor(secret, storage);
  if (!actor) {
    const err = new Error("unauthorized: token unknown, revoked, or expired");
    (err as unknown as { code: string }).code = "unauthorized";
    throw err;
  }
  return actor;
}

/**
 * Local-mode SYSTEM_ACTOR: like the kernel's SYSTEM_ACTOR but with a real
 * user_id (0) that we never write to the DB. tokens.create / any op that
 * needs an FK-linked user_id would fail; but the CLI's local mode uses
 * this only for read-through and for calls that don't create rows keyed
 * on user_id. bootstrap + writes-as-alice go through a real actor.
 */
const SYSTEM_ACTOR_LOCAL: Actor = { ...SYSTEM_ACTOR };
