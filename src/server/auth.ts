/**
 * Bearer-auth middleware — design §8.1.
 *
 * Extracts `Authorization: Bearer <secret>`, hashes it, resolves the Actor,
 * or returns a KernelError("unauthorized") the caller can turn into HTTP 401
 * / MCP in-band error as appropriate.
 *
 * Applies to BOTH the REST surface and the Streamable-HTTP MCP surface
 * (m3-plan §5 decision 3): every request authenticates independently and
 * resolves its own actor. No session store.
 *
 * STDIO's launch-time actor binding lives in the MCP surface (mcp/server.ts)
 * — there is no per-request auth channel on stdio (§6.2).
 */

import type { IncomingMessage } from "node:http";
import type { Actor } from "../kernel/auth/actor.js";
import { resolveActor } from "../kernel/auth/tokens.js";
import { KernelError } from "../kernel/errors.js";
import type { Storage } from "../storage/types.js";

/**
 * Extract the bearer secret from an `Authorization` header. Returns null
 * if absent or malformed. The check is case-insensitive on the scheme
 * ("Bearer" / "bearer") per RFC 6750 §2.1.
 */
export function extractBearerFromHeader(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const m = headerValue.match(/^\s*Bearer\s+(\S+)\s*$/i);
  return m ? (m[1] ?? null) : null;
}

/**
 * Resolve a bearer secret to an Actor, or throw `unauthorized`.
 * Wraps kernel/auth/tokens.resolveActor with kernel-error semantics.
 */
export async function resolveBearerActor(secret: string, storage: Storage): Promise<Actor> {
  const actor = await resolveActor(secret, storage);
  if (!actor) throw new KernelError("unauthorized", {});
  return actor;
}

/**
 * Extract-and-resolve in one call, from a Node IncomingMessage. Throws
 * `unauthorized` on missing header or unknown/revoked/expired token.
 */
export async function actorFromRequest(req: IncomingMessage, storage: Storage): Promise<Actor> {
  const secret = extractBearerFromHeader(req.headers.authorization);
  if (secret === null) throw new KernelError("unauthorized", {});
  return resolveBearerActor(secret, storage);
}
