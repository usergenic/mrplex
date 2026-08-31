/**
 * Remote → local: consume the change feed (sync/history plan §4.3). Drains
 * `history.since` from a cursor and applies each ref to the local store, then
 * returns the final cursor and a count. Shared by `--once` (drain to the tip
 * after reconciliation) and the daemon's poll loop (M8).
 *
 * Every operation is idempotent (§4.3): same bytes → same file; removing an
 * absent file is a no-op; the dirty check prevents a replay from clobbering an
 * edit made in a crash window. So a crash between apply and cursor-advance
 * simply replays the batch harmlessly.
 *
 * better-sync.plan: hot files defer inbound effects into an in-memory map
 * (cursor still advances); dirty+stale local files rebase onto remote current
 * before parking a sibling.
 */

import type { KernelClient } from "../client/kernel-client.js";
import type { VersionRef } from "../kernel/wire.js";
import { materializeAt } from "./converge.js";
import {
  type DeferredMap,
  decideInbound,
  effectInbound,
  enqueueDeferred,
  pathIsHot,
  versionAtOrAhead,
} from "./hot-path.js";
import { isDirty, isIgnored, readFileIntrinsics } from "./intrinsics.js";
import type { ScopeFilter } from "./paths.js";
import type { RemoteMap } from "./push.js";
import type { FileStore } from "./reconcile.js";

export type ApplyFeedOptions = {
  repo: string;
  since: string;
  log?: (msg: string) => void;
  /**
   * Optional daemon working-map (§4.2 tier 3). When supplied, feed application
   * keeps it current — set on materialize, delete on remove — so a later
   * witnessed unlink knows the file's prev_version_id.
   */
  map?: RemoteMap;
  /**
   * Minimum mtime age before inbound touch (better-sync `--settle`). When a
   * deferred map is also supplied, hot paths enqueue instead of writing.
   */
  settleMs?: number;
  /** In-memory deferred holds (daemon only). Absent → never defer (e.g. `--once`). */
  deferred?: DeferredMap;
  /** Injectable clock for tests. */
  nowMs?: () => number;
};

export type ApplyFeedResult = {
  /** Final resume cursor after draining the currently-safe feed. */
  cursor: string;
  /** Number of refs whose filesystem effect was applied. */
  applied: number;
  /** Number of refs held in the deferred map (hot path). */
  deferred: number;
};

/**
 * Drain the safe feed from `since` to the live tip, applying each in-scope ref.
 * Returns the final cursor to persist. Stops when a poll returns no new refs
 * (caught up, or stalled at a hot gap — the caller decides whether to re-poll).
 */
export async function applyFeed(
  client: KernelClient,
  store: FileStore,
  scope: ScopeFilter,
  opts: ApplyFeedOptions,
): Promise<ApplyFeedResult> {
  const log = opts.log ?? (() => {});
  let cursor = opts.since;
  let applied = 0;
  let deferredCount = 0;
  for (;;) {
    const page = await client.history.since({ after_version: cursor, repo: opts.repo });
    for (const ref of page.refs) {
      const outcome = await applyRef(client, store, scope, opts, ref, log);
      if (outcome === "applied") applied++;
      else if (outcome === "deferred") deferredCount++;
    }
    // No forward progress → caught up (or a hot gap). Stop draining.
    if (page.next_since === cursor || page.refs.length === 0) {
      cursor = page.next_since;
      break;
    }
    cursor = page.next_since;
  }
  return { cursor, applied, deferred: deferredCount };
}

type ApplyOutcome = "applied" | "deferred" | "noop";

/** Apply one feed ref to the local store. */
async function applyRef(
  client: KernelClient,
  store: FileStore,
  scope: ScopeFilter,
  opts: ApplyFeedOptions,
  ref: VersionRef,
  log: (msg: string) => void,
): Promise<ApplyOutcome> {
  const settleMs = opts.settleMs ?? 0;
  const nowMs = opts.nowMs?.() ?? Date.now();
  const canDefer = opts.deferred !== undefined;

  if (ref.op === "delete") {
    const target = ref.prev_path;
    if (target === null || !scope.matches(target)) return "noop";
    opts.map?.delete(target);
    const text = await store.read(target);
    if (text === null) return "noop";
    const intr = readFileIntrinsics(text);
    if (isIgnored(intr) || isDirty(intr)) return "noop"; // preserve local work
    if (canDefer && (await pathIsHot(store, target, settleMs, nowMs))) {
      enqueueDeferred(opts.deferred!, target, ref, nowMs);
      return "deferred";
    }
    await store.remove(target);
    log(`feed delete\t${target}`);
    return "applied";
  }

  if (ref.op === "move") {
    const from = ref.prev_path;
    if (from !== null && scope.matches(from)) {
      opts.map?.delete(from);
      const text = await store.read(from);
      if (text !== null) {
        const intr = readFileIntrinsics(text);
        if (!isIgnored(intr) && !isDirty(intr)) {
          if (canDefer && (await pathIsHot(store, from, settleMs, nowMs))) {
            // Hold the whole move (including dest) until source is cold.
            enqueueDeferred(opts.deferred!, ref.path, ref, nowMs);
            return "deferred";
          }
          await store.remove(from);
        }
      }
    }
    // Fall through to materialize at the destination path.
  }

  if (!scope.matches(ref.path)) return "noop";
  const existing = await store.read(ref.path);
  if (existing !== null) {
    const intr = readFileIntrinsics(existing);
    if (isIgnored(intr)) return "noop";

    // Fast path: bytes already match — may still need provenance repair.
    if (intr.computed_hash === ref.content_hash) {
      opts.map?.set(ref.path, { version_id: ref.version_id, content_hash: ref.content_hash });
      if (intr.version === ref.version_id) return "noop";
      if (versionAtOrAhead(intr.version, ref.version_id)) return "noop";
      const hot = await pathIsHot(store, ref.path, settleMs, nowMs);
      const v = await client.docs.get_version(opts.repo, ref.version_id);
      const decision = decideInbound({
        localText: existing,
        remote: v,
        hot,
        canDefer,
      });
      const result = await effectInbound(client, store, opts.repo, ref.path, decision, {
        deferred: opts.deferred,
        ref,
        map: opts.map,
        nowMs,
      });
      if (result === "deferred") return "deferred";
      if (result === "noop") return "noop";
      log(`feed adopt\t${ref.path}`);
      return "applied";
    }

    if (versionAtOrAhead(intr.version, ref.version_id)) return "noop";

    // Divergent local vs newer remote → decideInbound (rebase / defer / park).
    const hot = await pathIsHot(store, ref.path, settleMs, nowMs);
    const v = await client.docs.get_version(opts.repo, ref.version_id);
    const decision = decideInbound({
      localText: existing,
      remote: v,
      hot,
      canDefer,
    });
    const result = await effectInbound(client, store, opts.repo, ref.path, decision, {
      deferred: opts.deferred,
      ref,
      map: opts.map,
      nowMs,
    });
    if (result === "deferred") return "deferred";
    if (result === "noop") return "noop";
    if (result === "parked") log(`feed conflict\t${ref.path}`);
    else if (decision.action === "rebase") log(`feed rebase\t${ref.path}`);
    else log(`feed ${ref.op}\t${ref.path}`);
    return "applied";
  }

  // Absent locally → materialize (unless somehow hot — can't be; no mtime).
  const v = await client.docs.get_version(opts.repo, ref.version_id);
  await materializeAt(store, ref.path, v);
  opts.map?.set(ref.path, { version_id: ref.version_id, content_hash: ref.content_hash });
  log(`feed ${ref.op}\t${ref.path}`);
  return "applied";
}
