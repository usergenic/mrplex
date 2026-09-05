/**
 * `chain` verify family (docs/verify-plan.md §2.1) — version-chain structural
 * integrity. Catches what the partial unique indexes (§3.2) are supposed to
 * make impossible but a directly-corrupted DB can still violate.
 *
 * Walks every document chain-independently (`versions_by_document`, not the
 * recursive-from-current walk, which a broken chain defeats) and checks the
 * prev/next inverse-link invariant, current-version cardinality, prev target
 * validity, cycles, and repo-id agreement. Also flags orphan documents (zero
 * versions) and the one-live-per-path invariant across the repo's live set.
 */

import { normalizeKey } from "../casefold.js";
import { type CheckContext, SCAN_BATCH, canRead, did, finding, vid } from "./checks.js";

export async function checkChain(ctx: CheckContext): Promise<void> {
  const asym = ctx.selected("chain.prev_next_asymmetry");
  const multiCurrent = ctx.selected("chain.multiple_current");
  const noCurrent = ctx.selected("chain.no_current");
  const brokenPrev = ctx.selected("chain.broken_prev");
  const cycle = ctx.selected("chain.cycle");
  const repoMismatch = ctx.selected("chain.repo_mismatch");
  const orphanDoc = ctx.selected("chain.orphan_document");
  const multiLive = ctx.selected("chain.multiple_live_at_path");

  // Per-document chain checks — walk documents keyset-paginated by id.
  let afterDoc = 0;
  for (;;) {
    const docs = await ctx.storage.documents_all({
      repo_id: ctx.repo.id,
      after_id: afterDoc,
      limit: SCAN_BATCH,
    });
    if (docs.length === 0) break;
    ctx.acc.countDocuments(docs.length);

    for (const doc of docs) {
      // Advance the keyset cursor FIRST — before any `continue` below — so an
      // orphan doc (zero versions) that lands last in a batch can't stall the
      // scan into refetching the same page forever.
      afterDoc = doc.id;

      const versions = await ctx.storage.versions_by_document(doc.id);
      ctx.acc.countVersions(versions.length);

      if (versions.length === 0) {
        if (orphanDoc) {
          ctx.acc.add(
            finding(ctx, {
              check: "chain.orphan_document",
              severity: "warn",
              document_id: did(doc.id),
              detail: {},
            }),
          );
        }
        continue;
      }

      const byId = new Map(versions.map((v) => [v.id, v]));
      const currents = versions.filter((v) => v.next_id === null);

      if (multiCurrent && currents.length > 1) {
        ctx.acc.add(
          finding(ctx, {
            check: "chain.multiple_current",
            severity: "error",
            document_id: did(doc.id),
            detail: { current_version_ids: currents.map((v) => vid(v.id)) },
          }),
        );
      }
      if (noCurrent && currents.length === 0) {
        ctx.acc.add(
          finding(ctx, {
            check: "chain.no_current",
            severity: "error",
            document_id: did(doc.id),
            detail: { version_count: versions.length },
          }),
        );
      }

      for (const v of versions) {
        const path = canRead(ctx, v.path) ? v.path : undefined;

        // repo_id agreement with the denormalized column.
        if (repoMismatch && v.repo_id !== doc.repo_id) {
          ctx.acc.add(
            finding(ctx, {
              check: "chain.repo_mismatch",
              severity: "error",
              document_id: did(doc.id),
              version_id: vid(v.id),
              path,
              detail: { version_repo_id: v.repo_id, document_repo_id: doc.repo_id },
            }),
          );
        }

        // prev target validity + prev↔next symmetry.
        if (v.prev_id !== null) {
          const prev = byId.get(v.prev_id);
          if (brokenPrev && prev === undefined) {
            ctx.acc.add(
              finding(ctx, {
                check: "chain.broken_prev",
                severity: "error",
                document_id: did(doc.id),
                version_id: vid(v.id),
                path,
                detail: { prev_version_id: vid(v.prev_id) },
              }),
            );
          } else if (asym && prev !== undefined && prev.next_id !== v.id) {
            ctx.acc.add(
              finding(ctx, {
                check: "chain.prev_next_asymmetry",
                severity: "error",
                document_id: did(doc.id),
                version_id: vid(v.id),
                path,
                detail: {
                  prev_version_id: vid(v.prev_id),
                  prev_next_id: prev.next_id === null ? null : vid(prev.next_id),
                },
              }),
            );
          }
        }

        // next target validity + next↔prev symmetry (the other direction).
        if (v.next_id !== null) {
          const next = byId.get(v.next_id);
          if (brokenPrev && next === undefined) {
            ctx.acc.add(
              finding(ctx, {
                check: "chain.broken_prev",
                severity: "error",
                document_id: did(doc.id),
                version_id: vid(v.id),
                path,
                detail: { next_version_id: vid(v.next_id), reason: "next points nowhere" },
              }),
            );
          } else if (asym && next !== undefined && next.prev_id !== v.id) {
            ctx.acc.add(
              finding(ctx, {
                check: "chain.prev_next_asymmetry",
                severity: "error",
                document_id: did(doc.id),
                version_id: vid(v.id),
                path,
                detail: {
                  next_version_id: vid(v.next_id),
                  next_prev_id: next.prev_id === null ? null : vid(next.prev_id),
                },
              }),
            );
          }
        }
      }

      // Cycle detection: follow prev_id from each current back to a root,
      // bounded by version count. A revisit (or overrun) is a loop.
      if (cycle && currents.length > 0) {
        for (const start of currents) {
          const seen = new Set<number>();
          let cur = start;
          let looped = false;
          while (cur.prev_id !== null) {
            if (seen.has(cur.id)) {
              looped = true;
              break;
            }
            seen.add(cur.id);
            const prev = byId.get(cur.prev_id);
            if (prev === undefined) break; // broken_prev already covers this
            if (seen.has(prev.id)) {
              looped = true;
              break;
            }
            cur = prev;
          }
          if (looped) {
            ctx.acc.add(
              finding(ctx, {
                check: "chain.cycle",
                severity: "error",
                document_id: did(doc.id),
                detail: { from_version_id: vid(start.id) },
              }),
            );
          }
        }
      }
    }
  }

  // Repo-wide: one live document per normalized path. The partial unique index
  // should forbid duplicates; a finding means it's missing or corrupt.
  if (multiLive) {
    const live = await ctx.storage.versions_live_by_repo(ctx.repo.id);
    const byNorm = new Map<string, number[]>();
    for (const v of live) {
      const key = normalizeKey(v.path);
      const ids = byNorm.get(key);
      if (ids) ids.push(v.id);
      else byNorm.set(key, [v.id]);
    }
    for (const [, ids] of byNorm) {
      if (ids.length > 1) {
        const first = live.find((v) => v.id === ids[0]);
        ctx.acc.add(
          finding(ctx, {
            check: "chain.multiple_live_at_path",
            severity: "error",
            path: first && canRead(ctx, first.path) ? first.path : undefined,
            detail: { version_ids: ids.map(vid) },
          }),
        );
      }
    }
  }
}
