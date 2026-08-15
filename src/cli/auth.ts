/**
 * CLI auth glue — turn a bearer secret into a resolved kernel Actor.
 *
 * Precedence:
 *   1. --token flag
 *   2. MRPLEX_TOKEN env var
 *   3. token from ~/.config/mrplex/config.json
 *
 * If none are set, or the resolved secret is unknown/revoked/expired, the
 * CLI exits with the auth family (3) code and code=`unauthorized`. The
 * milestone goal is a secure single-writer — accidentally-unauthenticated
 * writes are worse than a small dev-ergonomics tax to run `mrplex bootstrap`.
 *
 * The one exception is `mrplex bootstrap` itself, which does not go
 * through this path — it needs to create the first user and token before
 * any actor exists.
 */

import type { Actor } from "../kernel/auth/actor.js";
import { resolveActor } from "../kernel/auth/tokens.js";
import type { Storage } from "../storage/types.js";
import { loadConfig } from "./config.js";

export function resolveTokenString(cliFlag: string | undefined): string | null {
  if (cliFlag) return cliFlag;
  const envToken = process.env.MRPLEX_TOKEN;
  if (envToken) return envToken;
  const cfg = loadConfig();
  return cfg.token ?? null;
}

/**
 * Resolve the CLI's actor from a token + storage. Throws a CLI-shaped
 * error with `.code === "unauthorized"` (exit code 3) if no token is
 * configured or the token doesn't resolve.
 */
export async function resolveCliActor(
  cliFlag: string | undefined,
  storage: Storage,
): Promise<Actor> {
  const secret = resolveTokenString(cliFlag);
  if (secret === null) {
    throw makeUnauthorized(
      "no token — set MRPLEX_TOKEN, use --token, or `mrplex config set-token`",
    );
  }
  const actor = await resolveActor(secret, storage);
  if (!actor) {
    throw makeUnauthorized("token unknown, revoked, or expired");
  }
  return actor;
}

function makeUnauthorized(reason: string): Error {
  const err = new Error(`unauthorized: ${reason}`);
  (err as unknown as { code: string }).code = "unauthorized";
  return err;
}
