/**
 * Token secrets, hashing, and actor resolution — design §8.1.
 *
 * Wire form of a secret: `mrplex_<base64url(32)>` (m1-plan §5 decision). The
 * `mrplex_` prefix is UX-only; the ENTIRE string is the secret. The server
 * computes `sha256(entire_string)` — see hashSecret below — which is what
 * ends up in `api_tokens.secret_hash`.
 *
 * SHA-256 (not argon2/bcrypt) because the secret is high-entropy and
 * server-generated (design §8.1 rationale). Determinism is exactly what
 * makes lookup-by-hash a single indexed equality on the hot auth path.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Storage, TokenRow } from "../../storage/types.js";
import type { Actor, StoredScope } from "./actor.js";

const SECRET_PREFIX = "mrplex_";
const SECRET_BYTES = 32; // 256 bits of entropy — comfortably above what SHA-256 preimage protects

/**
 * Generate a fresh token secret. Not yet stored — the caller passes the
 * hash of the returned string to `tokens_create`.
 *
 * Returned once, in plaintext, on the response to `tokens.create` (design
 * §6.4, §8.3). The server retains only its hash.
 */
export function generateSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
}

/**
 * Hash a secret for storage / lookup. Deterministic — the same secret always
 * hashes to the same digest, so the `api_tokens.secret_hash` unique index
 * gives constant-time lookup.
 */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * Constant-time comparison of two hex-encoded hashes. Not strictly required
 * for M1's lookup-by-index path (equality is checked by the DB), but exposed
 * here for anywhere else the kernel compares two hashes.
 */
export function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

// -----------------------------------------------------------------------------
// Actor resolution — the middleware seam between "here's a bearer string" and
// "here's a fully hydrated Actor with real scopes and admin bit."
// -----------------------------------------------------------------------------

/**
 * Look up a bearer secret in storage and return a resolved Actor, or null
 * if the token is unknown / revoked / expired.
 *
 * Best-effort `last_used_at` update per design §8.5 — not transactional,
 * doesn't fail the auth call if it errors.
 */
export function resolveActor(secret: string, storage: Storage): Actor | null {
  const hash = hashSecret(secret);
  const row = storage.tokens_by_hash(hash);
  if (!row) return null;
  const parsed = parseStoredScopes(row.scopes);
  const actor: Actor = {
    user_id: row.user_id,
    scopes: parsed,
    admin: row.admin === 1,
    token_id: row.id,
  };
  try {
    storage.tokens_touch_last_used(row.id, new Date().toISOString());
  } catch {
    // Best-effort per §8.5; auth still succeeds.
  }
  return actor;
}

/**
 * Parse the JSON text stored in `api_tokens.scopes` into StoredScope[].
 * Corrupt data throws — the token is effectively unusable, and the operator
 * should investigate.
 */
export function parseStoredScopes(json: string): StoredScope[] {
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`corrupt scopes JSON: expected array, got ${typeof parsed}`);
  }
  // Structural sanity — deep validation belongs to scope.ts (WS5).
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("corrupt scopes JSON: entry is not an object");
    }
    const e = entry as { repos?: unknown };
    if (e.repos !== "*" && !Array.isArray(e.repos)) {
      throw new Error("corrupt scopes JSON: entry.repos must be '*' or number[]");
    }
  }
  return parsed as StoredScope[];
}

/**
 * Serialize StoredScope[] to the JSON text stored on `api_tokens.scopes`.
 * Kept alongside `parseStoredScopes` so the pair stays in sync.
 */
export function serializeStoredScopes(scopes: StoredScope[]): string {
  return JSON.stringify(scopes);
}

/**
 * Small convenience for callers who have a TokenRow and just want the id
 * strings the wire expects (matches the version-id `v{integer}` pattern).
 */
export function tokenIdString(row: TokenRow): string {
  return `t${row.id}`;
}
