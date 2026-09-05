/**
 * `fts` verify family (docs/verify-plan.md §2.4) — SQLite-only.
 *
 * SQLite maintains a separate `fts_docs` external-content FTS5 table via
 * triggers, so its rowid membership can drift from `versions.id` (a trigger
 * that didn't fire → missing; a stray shadow-table row → orphan). The
 * invariant is a bijection over ALL versions, not the live set. Postgres has
 * no separate structure (`fts_tsv` is a generated column that can't drift), so
 * this family is skipped-with-note there — the kernel gates it on the
 * `VerifyFtsScans` capability before calling.
 *
 * Both scans are repo-agnostic (rowids are global), so this runs once per
 * verify call, not once per repo — the kernel calls it against the first
 * repo's context only.
 */

import type { VerifyFtsScans } from "../../storage/types.js";
import { type CheckContext, SCAN_BATCH, finding, vid } from "./checks.js";

export async function checkFts(ctx: CheckContext, scans: VerifyFtsScans): Promise<void> {
  const missing = ctx.selected("fts.missing");
  const orphan = ctx.selected("fts.orphan");

  if (missing) {
    let afterId = 0;
    for (;;) {
      const ids = await scans.fts_missing_rowids({ after_id: afterId, limit: SCAN_BATCH });
      if (ids.length === 0) break;
      for (const id of ids) {
        ctx.acc.add(
          finding(ctx, {
            check: "fts.missing",
            severity: "error",
            version_id: vid(id),
            detail: {},
            suggested_fix: "rebuild the fts_docs index",
          }),
        );
      }
      afterId = ids[ids.length - 1] as number;
    }
  }

  if (orphan) {
    let afterId = 0;
    for (;;) {
      const ids = await scans.fts_orphan_rowids({ after_id: afterId, limit: SCAN_BATCH });
      if (ids.length === 0) break;
      for (const id of ids) {
        ctx.acc.add(
          finding(ctx, {
            check: "fts.orphan",
            severity: "error",
            detail: { fts_rowid: id },
          }),
        );
      }
      afterId = ids[ids.length - 1] as number;
    }
  }
}
