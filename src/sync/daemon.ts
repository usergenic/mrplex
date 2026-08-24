/**
 * The two-way sync daemon (sync/history plan §4.3–4.8, M8). Startup
 * reconciliation, then two steady-state loops:
 *
 *   • remote → local: poll history.since(cursor) every --interval, apply refs
 *     (feed.ts), advance the cursor after fs effects.
 *   • local → remote: a chokidar watcher debounces per-path events into a work
 *     queue; each settled path runs the push pass (push.ts). Event *types* are
 *     untrusted — the pass stats the path (§4.6).
 *
 * chokidar is confined to this module (§4.4). Echo suppression falls out of
 * self-description (§4.5): our own pushes come back on the feed but the local
 * file already embeds that version+hash, and our own writes trip the watcher
 * but the hash gate no-ops them.
 */

import { watch } from "chokidar";
import type { FSWatcher } from "chokidar";
import type { KernelClient } from "../client/kernel-client.js";
import { readCursor, writeCursor } from "./cursor.js";
import { applyFeed } from "./feed.js";
import { createFsStore } from "./fs-store.js";
import { isIgnored, readFileIntrinsics } from "./intrinsics.js";
import { SYNC_DIR, type ScopeFilter, makeScopeFilter, toDocPath } from "./paths.js";
import { type RemoteMap, pushPath } from "./push.js";
import { type FileStore, reconcileOnce } from "./reconcile.js";

export type DaemonOptions = {
  root: string;
  repo: string;
  server?: string;
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
  const intervalMs = opts.intervalMs ?? 5000;
  const debounceMs = opts.debounceMs ?? 500;

  let stopped = false;
  let watcher: FSWatcher | undefined;
  const pending = new Map<string, NodeJS.Timeout>();
  let cursor = "";
  let serverHint: string | undefined;
  // Serialize all remote-touching work so a poll and a push never interleave a
  // read-modify-write on the same path.
  let chain: Promise<void> = Promise.resolve();
  const serialize = (fn: () => Promise<void>): Promise<void> => {
    chain = chain.then(fn, fn);
    return chain;
  };

  async function persistCursor(): Promise<void> {
    await writeCursor(opts.root, {
      server: opts.server ?? serverHint,
      repo: opts.repo,
      last_synced_version_id: cursor,
    });
  }

  async function pollFeedOnce(): Promise<void> {
    const { cursor: next } = await applyFeed(client, store, scope, {
      repo: opts.repo,
      since: cursor,
      log,
      map,
    });
    if (next !== cursor) {
      cursor = next;
      await persistCursor();
    }
  }

  function schedulePush(docPath: string): void {
    if (!scope.matches(docPath)) return;
    const existing = pending.get(docPath);
    if (existing) clearTimeout(existing);
    pending.set(
      docPath,
      setTimeout(() => {
        pending.delete(docPath);
        void serialize(async () => {
          if (stopped) return;
          try {
            await pushPath(docPath, { client, store, repo: opts.repo, map, log });
          } catch (err) {
            log(`push error\t${docPath}\t${(err as Error).message}`);
          }
        });
      }, debounceMs),
    );
  }

  const ready = (async () => {
    // 1. Startup reconciliation (§4.9). Seeds the map from the index + local walk.
    const existing = await readCursor(opts.root);
    serverHint = existing?.server;
    const report = await reconcileOnce(client, store, scope, { repo: opts.repo, log });
    await seedMapFromLocal(store, scope, map);
    cursor = report.through_version;
    await persistCursor();

    // 2. Drain the feed from R (advances + re-persists the cursor if it moves).
    await pollFeedOnce();

    // 3. Start the watcher (local → remote).
    watcher = watch(opts.root, {
      ignoreInitial: true,
      // Prune the sync state dir; the scope filter still guards everything else.
      ignored: (p: string) => p.includes(`/${SYNC_DIR}/`) || p.endsWith(`/${SYNC_DIR}`),
      ...(opts.settleMs
        ? { awaitWriteFinish: { stabilityThreshold: opts.settleMs, pollInterval: 100 } }
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
      for (const t of pending.values()) clearTimeout(t);
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
