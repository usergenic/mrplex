/**
 * API keys — auth-shell plan §1 (authn front 1), decision 9.
 *
 * High-entropy shell-generated secrets, stored as `sha256:<hex>` hashes in the
 * policy file itself. There is no key database: issuance is a line appended to
 * a diffable file (`key mint`), revocation is deleting the line. A key is a
 * non-human-chosen 256-bit random secret, so a plain sha256 — no KDF, no salt —
 * is the right primitive: deterministic lookup, and there is no low-entropy
 * password to protect against brute force (the old design §8.1 argument,
 * carried over intact).
 *
 * Presented to the shell as `Authorization: Bearer <plaintext-key>`.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Policy } from "./policy.js";

/** Bytes of entropy in a minted key. 32 = 256 bits. */
const KEY_BYTES = 32;

/**
 * Mint a fresh plaintext key and its policy-file hash. The plaintext is shown
 * to the operator ONCE (by `key mint`) and never stored; only the hash lives
 * in the policy file. base64url keeps it copy-paste-safe in shell/env/headers.
 */
export function mintKey(): { plaintext: string; hash: string } {
  const plaintext = randomBytes(KEY_BYTES).toString("base64url");
  return { plaintext, hash: hashKey(plaintext) };
}

/** The `sha256:<hex>` hash of a plaintext key — the policy-file storage form. */
export function hashKey(plaintext: string): string {
  const hex = createHash("sha256").update(plaintext, "utf8").digest("hex");
  return `sha256:${hex}`;
}

/**
 * Resolve a presented plaintext key to its principal id, or null if no
 * principal lists its hash. Comparison is constant-time per candidate hash so
 * a timing side-channel can't distinguish "no such key" from "wrong key".
 */
export function principalForKey(policy: Policy, plaintext: string): string | null {
  const presented = Buffer.from(hashKey(plaintext), "utf8");
  let match: string | null = null;
  for (const [id, principal] of Object.entries(policy.principals)) {
    for (const stored of principal.keys ?? []) {
      const storedBuf = Buffer.from(stored, "utf8");
      // Length differs only for a malformed stored hash (validation forbids
      // it), but timingSafeEqual throws on unequal lengths, so guard it.
      if (storedBuf.length === presented.length && timingSafeEqual(storedBuf, presented)) {
        // Don't early-return: keep scanning so total work doesn't leak which
        // principal matched. Record the first (and, given unique keys, only) hit.
        if (match === null) match = id;
      }
    }
  }
  return match;
}

/**
 * Extract a bearer token from an `Authorization` header value, or null. Case-
 * insensitive on the scheme per RFC 7235; the token is returned verbatim.
 */
export function bearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const m = /^Bearer[ \t]+(.+)$/i.exec(authorization.trim());
  return m ? (m[1] as string).trim() : null;
}
