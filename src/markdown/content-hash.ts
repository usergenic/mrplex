/**
 * `$content_hash` — the canonical content fingerprint (sync/history plan §2).
 *
 * A derived, server-owned property: the SHA-256 (bare lowercase hex, no
 * algorithm prefix) of a version's canonical content —
 * `join({ frontmatter_raw, body })` where `frontmatter_raw` has already been
 * stripped of `$*` system lines. The hash excludes all intrinsics and the
 * document path (a pure move does not change it).
 *
 * The server and every client must produce byte-identical input, which is why
 * the hash lives in this one shared module rather than parallel
 * implementations. Three byte-exactness traps it honors (§2.1):
 *
 *   1. Empty-frontmatter collapse — route through `join`, which collapses the
 *      empty block, so `frontmatter_raw === ""` hashes bare `<body>`.
 *   2. Trailing-newline normalization — `join` forces the frontmatter block to
 *      end in `\n`; a local file lacking it normalizes identically.
 *   3. Line endings — the delimiter grammar is LF-based; CRLF is normalized to
 *      LF before hashing.
 */

import { createHash } from "node:crypto";
import { extractSystemProperties, join, split } from "./frontmatter.js";

/** Canonical bytes hashed for `$content_hash`. */
export function canonicalContent(frontmatterRaw: string, body: string): string {
  return join({ frontmatter_raw: frontmatterRaw, body });
}

/**
 * Hash a version's canonical content. `frontmatterRaw` must already be the
 * stored raw (stripped of `$*` system lines by `canonicalizeFrontmatter`).
 */
export function contentHash(frontmatterRaw: string, body: string): string {
  return createHash("sha256").update(canonicalContent(frontmatterRaw, body), "utf8").digest("hex"); // bare hex
}

/**
 * Hash a whole file as the server would after storing it. Normalizes CRLF→LF,
 * strips embedded `$*` lines via the same split/strip/join path so a file
 * carrying intrinsics from a prior materialization hashes to the same value as
 * its stored version.
 */
export function contentHashOfFile(text: string): string {
  const lf = text.replace(/\r\n/g, "\n");
  const { frontmatter_raw, body } = split(lf);
  const stripped = extractSystemProperties(frontmatter_raw).raw;
  return contentHash(stripped, body);
}
