/**
 * The two-way sync daemon (sync/history plan §4.3–4.8, M8). Startup
 * reconciliation, then two steady-state loops:
 *
 *   • remote → local: poll history.since(cursor) every --interval, apply refs
 *     (feed.ts), advance the cursor after fs effects.
 *   • local → remote: a chokidar watcher coalesces events into a debounce
 *     *burst* (all paths that settled together). The burst runs present files
 *     first so unlink+add of a rename is a move, not a delete (§4.7); each
 *     path is still stated, not trusted by event type (§4.6).
 *
 * better-sync.plan: `--settle` is an mtime-age gate on both directions; inbound
 * conflicts on hot files are held in an in-memory deferred map and retried on
 * later polls (cursor still advances).
 *
 * chokidar is confined to this module (§4.4). Echo suppression falls out of
 * self-description (§4.5): our own pushes come back on the feed but the local
 * file already embeds that version+hash, and our own writes trip the watcher
 * but the hash gate no-ops them.
 */

import { watch } from "chokidar";
import type { FSWatcher } from "chokidar";
import type { KernelClient } from "../client/kernel-client.js";
import { type SyncCursor, readCursor, sourceFields, writeCursor } from "./cursor.js";
import { applyFeed } from "./feed.js";
import { createFsStore } from "./fs-store.js";
import {
  type DeferredMap,
  pathIsHot,
  retryDeferredEntry,
} from "./hot-path.js";
import { isIgnored, readFileIntrinsics } from "./intrinsics.js";
import { SYNC_DIR, type ScopeFilter, makeScopeFilter, toDocPath } from "./paths.js";
import { type RemoteMap, pushBurst, pushPath } from "./push.js";
import { type FileStore, reconcileOnce } from "./reconcile.js";

export type DaemonOptions = {
  root: string;
  repo: string;
  server?: string;
  database?: string;
  include?: string[];
  exclude?: string[];
  intervalMs?: number;
  debounceMs?: number;
  settleMs?: number;
  log?: (msg: string) => void;
};

export type Daemon = {
  /** Resolves once the initial reconciliation + first feed drain complete. */
  ready: Promise<void>;
  /** Stop the watcher and poll loop; resolves when fully torn down. */
  stop(): Promise<void>;
};

/**
 * Start the daemon. Returns handles rather than blocking, so the CLI (or a
 * test) controls its lifetime. The poll loop and watcher run until `stop()`.
 */
export function startDaemon(client: KernelClient, opts: DaemonOptions): Daemon {
  const log = opts.log ?? (() => {});
  const store = createFsStore(opts.root);
  const scope = makeScopeFilter({ include: opts.include, exclude: opts.exclude });
  const map: RemoteMap = new Map();
  const deferred: DeferredMap = new Map();
  const intervalMs = opts.intervalMs ?? 5000;
  const debounceMs = opts.debounceMs ?? 5000;
  const settleMs = opts.settleMs ?? 0;

  let stopped = false;
  let watcher: FSWatcher | undefined;
  const pending = new Set<string>();
  let burstTimer: NodeJS.Timeout | undefined;
  let cursor = "";
  let existingCursor: SyncCursor | null = null;
  // Serialize all remote-touching work so a poll and a push never interleave a
  // read-modify-write on the same path.
  let chain: Promise<void> = Promise.resolve();
  const serialize = (fn: () => Promise<void>): Promise<void> => {
    chain = chain.then(fn, fn);
    return chain;
  };

  async function persistCursor(): Promise<void> {
    await writeCursor(opts.root, {
      ...sourceFields(opts.server, opts.database, existingCursor),
      repo: opts.repo,
      last_synced_version_id: cursor,
    });
  }

  /**
   * The marker-present offline reconcile (§4.9): a purely-local walk that
   * pushes offline edits and creations without enumerating the remote. Each
   * file runs the ordinary push pass — clean files no-op via the hash gate,
   * dirty ones push, files lacking provenance resolve the remote path first.
   * Offline deletions and moves reconcile lazily (they are not witnessed), per
   * the plan's stated consequence; a full pass (--once) is the lever for those.
   */
  async function localDirtyWalk(): Promise<void> {
    for (const docPath of await store.list()) {
      if (!scope.matches(docPath)) continue;
      try {
        await pushPath(docPath, { client, store, repo: opts.repo, map, log });
      } catch (err) {
        log(`push error\t${docPath}\t${(err as Error).message}`);
      }
    }
  }

  /** Retry in-memory deferred inbound holds before draining new feed pages. */
  async function retryDeferred(): Promise<void> {
    if (deferred.size === 0) return;
    for (const [path, entry] of [...deferred.entries()]) {
      if (!scope.matches(path) && entry.ref.op !== "delete") {
        deferred.delete(path);
        continue;
      }
      try {
        const { done } = await retryDeferredEntry(client, store, opts.repo, path, entry, {
          settleMs,
          map,
          deferred,
        });
        if (done) deferred.delete(path);
      } catch (err) {
        log(`defer retry error\t${path}\t${(err as Error).message}`);
      }
    }
  }

  async function pollFeedOnce(): Promise<void> {
    await retryDeferred();
    const { cursor: next } = await applyFeed(client, store, scope, {
      repo: opts.repo,
      since: cursor,
      log,
      map,
      settleMs,
      deferred,
    });
    if (next !== cursor) {
      cursor = next;
      await persistCursor();
    }
  }

  function armBurstTimer(): void {
    if (burstTimer) clearTimeout(burstTimer);
    burstTimer = setTimeout(() => {
      burstTimer = undefined;
      const batch = [...pending];
      pending.clear();
      void serialize(async () => {
        if (stopped) return;
        const ready: string[] = [];
        for (const path of batch) {
          if (settleMs > 0 && (await pathIsHot(store, path, settleMs))) {
            pending.add(path);
            continue;
          }
          ready.push(path);
        }
        if (pending.size > 0) armBurstTimer();
        if (ready.length > 0) {
          await pushBurst(ready, { client, store, repo: opts.repo, map, log });
        }
      });
    }, debounceMs);
  }

  function schedulePush(docPath: string): void {
    if (!scope.matches(docPath)) return;
    pending.add(docPath);
    armBurstTimer();
  }

  const ready = (async () => {
    // 1. Startup is deterministic on the cursor marker (§4.9, §7).
    const existing = await readCursor(opts.root);
    existingCursor = existing;
    // Seed the map from local provenance first, so the dirty walk's witnessed
    // deletes (and the feed's) know each file's prev_version_id.
    await seedMapFromLocal(store, scope, map);
    if (existing === null) {
      // Marker absent → full index reconciliation, then resume the feed from R.
      const report = await reconcileOnce(client, store, scope, { repo: opts.repo, log });
      // reconcileOnce may have materialized/pushed files; re-seed so the map
      // reflects the post-reconcile provenance.
      await seedMapFromLocal(store, scope, map);
      cursor = report.through_version;
    } else {
      // Marker present → skip the index scan. Run a purely-local dirty walk
      // (pushes offline edits + creations; no remote enumeration), then resume
      // history.since(cursor). The feed is gap-free from any cursor age (§3.2),
      // so an old marker is merely more replay, never a correctness question.
      // Offline deletions/moves reconcile lazily until a full pass (§4.9).
      await localDirtyWalk();
      cursor = existing.last_synced_version_id;
    }
    await persistCursor();

    // 2. Drain the feed from the cursor (advances + re-persists if it moves).
    await pollFeedOnce();

    // 3. Start the watcher (local → remote).
    watcher = watch(opts.root, {
      ignoreInitial: true,
      // Prune the sync state dir; the scope filter still guards everything else.
      ignored: (p: string) => p.includes(`/${SYNC_DIR}/`) || p.endsWith(`/${SYNC_DIR}`),
      ...(settleMs > 0
        ? {
            awaitWriteFinish: {
              stabilityThreshold: Math.min(settleMs, 2000),
              pollInterval: 100,
            },
          }
        : {}),
    });
    const onEvent = (abs: string): void => {
      const docPath = toDocPath(opts.root, abs);
      if (docPath !== null) schedulePush(docPath);
    };
    watcher.on("add", onEvent).on("change", onEvent).on("unlink", onEvent);
    // Wait for the initial scan to finish so events aren't missed right after
    // ready resolves (chokidar only watches reliably once it emits `ready`).
    const w = watcher;
    await new Promise<void>((resolve) => w.once("ready", () => resolve()));

    // 4. Start the remote → local poll loop.
    void pollLoop();
  })();

  async function pollLoop(): Promise<void> {
    while (!stopped) {
      await sleep(intervalMs);
      if (stopped) break;
      await serialize(async () => {
        if (stopped) return;
        try {
          await pollFeedOnce();
        } catch (err) {
          log(`poll error\t${(err as Error).message}`);
        }
      });
    }
  }

  return {
    ready,
    async stop() {
      stopped = true;
      if (burstTimer) clearTimeout(burstTimer);
      burstTimer = undefined;
      pending.clear();
      if (watcher) await watcher.close();
      await chain.catch(() => {});
    },
  };
}

/** Seed the in-memory map from the local files' embedded provenance (§4.2). */
async function seedMapFromLocal(
  store: FileStore,
  scope: ScopeFilter,
  map: RemoteMap,
): Promise<void> {
  for (const path of await store.list()) {
    if (!scope.matches(path)) continue;
    const text = await store.read(path);
    if (text === null) continue;
    const intr = readFileIntrinsics(text);
    if (isIgnored(intr) || !intr.version || !intr.content_hash) continue;
    map.set(path, { version_id: intr.version, content_hash: intr.content_hash });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
