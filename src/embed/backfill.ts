/**
 * Backfill: re-chunk + re-embed current versions missing chunks
 * (design §5.3, m4-plan WS3).
 *
 *   1. Walk the repo's live versions.
 *   2. For any without chunks (any model), enqueue.
 *   3. Drain the backlog synchronously with a live worker.
 *
 * Deliberately does NOT delete stale chunks — the worker's
 * chunks_upsert handles that on the re-embed. And deliberately does
 * NOT re-embed versions that already have chunks — call `mrplex embed
 * backfill --force` (future) to swap models. For v1, model changes go
 * through: (a) point the hook at the new model, (b) delete the repo's
 * chunks manually, (c) run backfill.
 */

import type { Storage } from "../storage/types.js";
import type { Worker } from "./worker.js";

export type BackfillReport = {
  enqueued: number;
  processed: number;
  failed: number;
  skipped: number;
};

export async function backfillRepo(
  storage: Storage,
  repoSlug: string,
  worker: Worker,
  onProgress?: (msg: string) => void,
): Promise<BackfillReport> {
  const repo = await storage.repos_by_slug(repoSlug);
  if (!repo) throw new Error(`repo not found: ${repoSlug}`);
  const live = await storage.versions_live_by_repo(repo.id);
  let enqueued = 0;
  for (const version of live) {
    const existing = await storage.chunks_by_version(version.id);
    if (existing.length === 0) {
      await storage.backlog_enqueue(version.id);
      enqueued++;
    }
  }
  onProgress?.(`enqueued ${enqueued} version(s)`);
  const { processed, failed, skipped } = await worker.drainOnce();
  return { enqueued, processed, failed, skipped };
}
