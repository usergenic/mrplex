/**
 * Conditional-request parsing — design §6.3.
 *
 * `version_id` is the ETag. Accept both quoted (`"v123"`) and bare (`v123`)
 * forms; reject weak validators (`W/"v123"`) — the strong-validator
 * discipline is load-bearing for `prev_version_id` semantics (§4).
 *
 * If-Match: *   → RFC-legal, means "any existing entity"
 * If-None-Match: *   → the RFC "create if absent" pattern from §6.3
 */

/** Parse `If-Match` header value into a decision. Returns null if header absent. */
export type IfMatch =
  | { kind: "any" } // "*"
  | { kind: "version"; version_id: string };

export function parseIfMatch(headerValue: string | undefined): IfMatch | null {
  if (headerValue === undefined) return null;
  const v = headerValue.trim();
  if (v === "*") return { kind: "any" };
  const version = parseValidatorToVersionId(v);
  if (version === null) return null;
  return { kind: "version", version_id: version };
}

/** Parse `If-None-Match` header value into a decision. */
export type IfNoneMatch =
  | { kind: "any" } // "*" — create-if-absent
  | { kind: "version"; version_id: string };

export function parseIfNoneMatch(headerValue: string | undefined): IfNoneMatch | null {
  if (headerValue === undefined) return null;
  const v = headerValue.trim();
  if (v === "*") return { kind: "any" };
  const version = parseValidatorToVersionId(v);
  if (version === null) return null;
  return { kind: "version", version_id: version };
}

/**
 * Turn a validator token (quoted or bare) into a version_id string, or null
 * for weak validators / malformed input.
 *
 * We're deliberately strict: `W/"v123"` returns null (§m3-plan risk note —
 * accepting weak validators here would let a caller "prove freshness"
 * against a value that isn't guaranteed to be byte-identical).
 */
export function parseValidatorToVersionId(token: string): string | null {
  const t = token.trim();
  if (t.startsWith("W/")) return null; // weak — refuse
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return t.slice(1, -1);
  }
  // Bare form: no quotes. Only accept if it's plausibly a version_id shape
  // (leading `v` + digits) so we don't confuse random garbage with an ETag.
  if (/^v\d+$/.test(t)) return t;
  return null;
}

/** Format a version_id as a strong ETag response header value. */
export function etagOf(versionId: string): string {
  return `"${versionId}"`;
}
