/**
 * `mrplex sync --once` orchestration (sync/history plan §4.9). Runs the full
 * startup reconciliation, then applies the feed from R and advances the cursor.
 * The daemon (M8) layers a watcher + poll loop over these same pieces.
 */

import type { KernelClient } from "../client/kernel-client.js";
import { readCursor, sourceFields, writeCursor } from "./cursor.js";
import { applyFeed } from "./feed.js";
import { createFsStore } from "./fs-store.js";
import { makeScopeFilter } from "./paths.js";
import { type ReconcileReport, reconcileOnce } from "./reconcile.js";

export type SyncOnceOptions = {
  root: string;
  repo: string;
  server?: string;
  database?: string;
  include?: string[];
  exclude?: string[];
  dryRun?: boolean;
  log?: (msg: string) => void;
};

export type SyncOnceReport = ReconcileReport & { feed_applied: number };

/**
 * The full once-pass: index reconciliation through R, then drain
 * history.since(R) to catch anything that advanced during the scan, then
 * persist the cursor. `--once` always performs the full reconciliation (§4.9),
 * so it also restores offline deletes and propagates offline moves.
 */
export async function syncOnce(
  client: KernelClient,
  opts: SyncOnceOptions,
): Promise<SyncOnceReport> {
  const store = createFsStore(opts.root);
  const scope = makeScopeFilter({ include: opts.include, exclude: opts.exclude });

  const report = await reconcileOnce(client, store, scope, {
    repo: opts.repo,
    dryRun: opts.dryRun,
    log: opts.log,
  });

  if (opts.dryRun) return { ...report, feed_applied: 0 };

  // Apply the feed from R forward: documents that advanced mid-scan land here
  // exactly once (§3.4 handoff invariant). The feed returns its final cursor.
  const { cursor, applied } = await applyFeed(client, store, scope, {
    repo: opts.repo,
    since: report.through_version,
    log: opts.log,
  });

  // Persist the cursor only after all filesystem effects complete (§4.3).
  // Record the source as exactly one of server/database, falling back to
  // whichever the existing marker carried so an incidental re-run doesn't drop
  // it. server/database are mutually exclusive, so a set server wins outright.
  const existing = await readCursor(opts.root);
  await writeCursor(opts.root, {
    ...sourceFields(opts.server, opts.database, existing),
    repo: opts.repo,
    last_synced_version_id: cursor,
  });

  return { ...report, feed_applied: applied };
}
