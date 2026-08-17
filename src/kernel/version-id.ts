/**
 * Opaque `version_id` wire encoding. Design §3.3 says clients echo these back
 * and never construct or parse them; the server owns the representation.
 *
 * M0 decision (see docs/archive/m0-plan.md §5): `v{integer}` — trivially readable
 * during dev/debug, opaque by *contract*, and already the form the design's
 * deletion-path examples use (`:deleted/…/foo-v45129.md`).
 */

export function encodeVersionId(id: number): string {
  return `v${id}`;
}

export function decodeVersionId(versionId: string): number | null {
  const m = versionId.match(/^v(\d+)$/);
  if (!m || !m[1]) return null;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}
