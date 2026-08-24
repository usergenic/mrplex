/**
 * Content-hash backfill (sync/history plan §2.6) — walk rows with
 * `content_hash IS NULL`, compute via the shared hash function, and write them
 * back in batches. Mirrors `links backfill` in shape. Idempotent: rows already
 * hashed are skipped by the `IS NULL` predicate, so re-running only touches
 * what's left.
 *
 * Until a repo is fully backfilled, reads still compute the hash on the fly
 * (kernel `toVersionWire`, §2.6) and the feed/index emit "" for null — so the
 * system is correct throughout the transition; backfill just makes the column
 * authoritative and the `$content_hash` filter complete.
 */

import type { Storage } from "../storage/types.js";
import { contentHash } from "./content-hash.js";

export type HashBackfillReport = { hashed: number };

/** Default rows per batch — bounded so no single tx grows unbounded. */
export const HASH_BACKFILL_BATCH = 500;

export async function backfillContentHashes(
  storage: Storage,
  opts?: { repo_id?: number; batch?: number },
): Promise<HashBackfillReport> {
  const batch = opts?.batch ?? HASH_BACKFILL_BATCH;
  let afterId = 0;
  let hashed = 0;
  for (;;) {
    const rows = await storage.versions_missing_content_hash({
      repo_id: opts?.repo_id,
      after_id: afterId,
      limit: batch,
    });
    if (rows.length === 0) break;
    const updates = rows.map((r) => ({
      id: r.id,
      content_hash: contentHash(r.frontmatter_raw, r.body),
    }));
    await storage.versions_set_content_hash(updates);
    hashed += updates.length;
    // Keyset advance: the last id in this batch is the next cursor. Rows just
    // written no longer match `IS NULL`, but keying by id avoids re-scanning
    // them regardless.
    afterId = rows[rows.length - 1]?.id ?? afterId;
    if (rows.length < batch) break;
  }
  return { hashed };
}
