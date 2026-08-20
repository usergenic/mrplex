/**
 * Links backfill — rebuild the derived index for a repo (design §11.2, WS3).
 *
 * Mirrors src/embed/backfill.ts in shape, but synchronous (no hook, no
 * worker): extraction is pure CPU, so a full rebuild is just a walk over
 * the repo's live versions, re-extracting + resolving each document's
 * outbound edges. Because every live document already exists when the walk
 * runs, candidate resolution binds immediately — no separate dangling
 * sweep is needed for a full rebuild (a dangling edge here means the target
 * genuinely has no live document).
 *
 * Used by `mrplex links backfill` (build the index for an existing corpus)
 * and by link-config-change re-extraction (the effective config changed, so
 * every document must be re-parsed under the new rules).
 */

import type { Storage } from "../storage/types.js";
import type { LinkConfig } from "./link-config.js";
import { reindexOutboundLinks } from "./maintain.js";

export type LinksBackfillReport = {
  documents: number; // live documents reindexed
  edges: number; // total edges written across all documents
};

/**
 * Rebuild `repo`'s link index from its current live versions. Idempotent:
 * re-running produces the same rows (links_replace is delete-then-insert
 * per source). Each document is reindexed in its own transaction so a huge
 * repo doesn't hold one giant tx.
 */
export async function backfillRepoLinks(
  storage: Storage,
  repoId: number,
  config: LinkConfig,
): Promise<LinksBackfillReport> {
  const live = await storage.versions_live_by_repo(repoId);
  let edges = 0;
  for (const version of live) {
    await reindexOutboundLinks(
      storage,
      config,
      repoId,
      version.document_id,
      version.path,
      version.body,
      version.frontmatter,
    );
    const rows = await storage.links_by_source(version.document_id);
    edges += rows.length;
  }
  return { documents: live.length, edges };
}
