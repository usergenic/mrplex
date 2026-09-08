/**
 * `chunks` verify family (docs/verify-plan.md §2.5) — embedding provenance.
 *
 * Structural consistency only, never vector quality (§1 Out). Two shapes:
 *
 *   • Whole-store (chunks/backlog aren't repo-partitioned): `chunks.orphan`,
 *     `chunks.backlog_orphan`, `chunks.mixed_dim`. Run once per verify call in
 *     an all-repos run; skipped-with-note under a `--repo` filter (a scoped run
 *     can't attribute a version that no longer exists to a repo).
 *   • Per-repo: `chunks.unembedded` — a repo's live version with neither chunk
 *     rows nor a backlog entry. Gated on an embedder being configured (§2.5):
 *     with no embedder every live version is "unembedded", which is noise.
 *
 * "Orphan" means the referenced version does NOT exist — not merely that it's
 * superseded. The embed worker leaves chunks on superseded versions on purpose
 * (`worker.ts`), so a non-live-but-existing version keeping chunks is normal.
 */

import { type CheckContext, SCAN_BATCH, finding, vid } from "./checks.js";

/** Whole-store chunk checks — call once per verify, not per repo. */
export async function checkChunksStore(ctx: CheckContext): Promise<void> {
  const orphan = ctx.selected("chunks.orphan");
  const backlogOrphan = ctx.selected("chunks.backlog_orphan");
  const mixedDim = ctx.selected("chunks.mixed_dim");

  if (orphan) {
    let after = 0;
    for (;;) {
      const ids = await ctx.storage.chunks_orphan_version_ids({
        after_id: after,
        limit: SCAN_BATCH,
      });
      if (ids.length === 0) break;
      for (const id of ids) {
        ctx.acc.add(
          finding(ctx, {
            check: "chunks.orphan",
            severity: "error",
            version_id: vid(id),
            detail: { reason: "chunk references a nonexistent version" },
          }),
        );
      }
      after = ids[ids.length - 1] as number;
    }
  }

  if (backlogOrphan) {
    let after = 0;
    for (;;) {
      const ids = await ctx.storage.backlog_orphan_version_ids({
        after_id: after,
        limit: SCAN_BATCH,
      });
      if (ids.length === 0) break;
      for (const id of ids) {
        ctx.acc.add(
          finding(ctx, {
            check: "chunks.backlog_orphan",
            severity: "error",
            version_id: vid(id),
            detail: { reason: "backlog entry references a nonexistent version" },
          }),
        );
      }
      after = ids[ids.length - 1] as number;
    }
  }

  if (mixedDim) {
    let after = 0;
    for (;;) {
      const rows = await ctx.storage.chunks_dims_by_version({ after_id: after, limit: SCAN_BATCH });
      if (rows.length === 0) break;
      for (const row of rows) {
        if (row.dims.length > 1) {
          ctx.acc.add(
            finding(ctx, {
              check: "chunks.mixed_dim",
              severity: "error",
              version_id: vid(row.version_id),
              detail: { dims: row.dims.slice().sort((a, b) => a - b) },
            }),
          );
        }
      }
      after = rows[rows.length - 1]?.version_id as number;
    }
  }
}

/**
 * Per-repo `chunks.unembedded`. Only meaningful when an embedder is configured
 * — the caller (kernel) decides that and skips-with-note otherwise. A live
 * version with neither chunks nor a pending backlog entry has fallen out of
 * the pipeline.
 */
export async function checkChunksUnembedded(ctx: CheckContext): Promise<void> {
  if (!ctx.selected("chunks.unembedded")) return;

  // Membership sets are whole-store; build them once as Sets of version ids.
  const chunked = await collectAll((after) =>
    ctx.storage.chunks_all_version_ids({ after_id: after, limit: SCAN_BATCH }),
  );
  const backlogged = await collectAll((after) =>
    ctx.storage.backlog_all_version_ids({ after_id: after, limit: SCAN_BATCH }),
  );

  const live = await ctx.storage.versions_live_by_repo(ctx.repo.id);
  for (const v of live) {
    if (!chunked.has(v.id) && !backlogged.has(v.id)) {
      ctx.acc.add(
        finding(ctx, {
          check: "chunks.unembedded",
          severity: "warn",
          document_id: vid(v.document_id),
          version_id: vid(v.id),
          path: v.path,
          detail: {},
          suggested_fix: "mrplex embed backfill",
        }),
      );
    }
  }
}

/** Drain a keyset-paginated id scan into a Set. */
async function collectAll(page: (afterId: number) => Promise<number[]>): Promise<Set<number>> {
  const out = new Set<number>();
  let after = 0;
  for (;;) {
    const ids = await page(after);
    if (ids.length === 0) break;
    for (const id of ids) out.add(id);
    after = ids[ids.length - 1] as number;
  }
  return out;
}
