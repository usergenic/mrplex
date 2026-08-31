/**
 * Hot-path detection and inbound convergence decisions (better-sync.plan).
 * Feed/reconcile call `decideInbound` then `effectInbound`; the daemon holds
 * deferred refs in memory and retries them on later polls.
 */

import type { KernelClient } from "../client/kernel-client.js";
import { KernelError } from "../kernel/errors.js";
import { decodeVersionId } from "../kernel/version-id.js";
import type { Version, VersionRef } from "../kernel/wire.js";
import {
  materializeAt,
  parkIgnoredSibling,
  putAndAck,
  stripToUserContent,
  type UserContent,
} from "./converge.js";
import { isDirty, isIgnored, readFileIntrinsics } from "./intrinsics.js";
import type { FileStore } from "./reconcile.js";
import type { RemoteMap } from "./push.js";

/** Drop deferred entries older than this and force cold treatment (park/rebase). */
export const DEFER_TTL_MS = 30 * 60 * 1000;

export type DeferredEntry = { ref: VersionRef; since: number };
export type DeferredMap = Map<string, DeferredEntry>;

export type InboundDecision =
  | { action: "noop" }
  | { action: "adopt"; version: Version }
  | { action: "materialize"; version: Version }
  | { action: "rebase"; prevVersionId: string; user: UserContent }
  | { action: "defer" };

/**
 * Pure mtime gate: true when the file was modified within settleMs of now.
 * settleMs ≤ 0 disables the gate. Absent files (null mtime) are never hot.
 */
export function isPathHot(
  mtimeMs: number | null,
  settleMs: number,
  nowMs: number = Date.now(),
): boolean {
  if (settleMs <= 0) return false;
  if (mtimeMs === null) return false;
  return nowMs - mtimeMs < settleMs;
}

/** Store-backed hot check. */
export async function pathIsHot(
  store: FileStore,
  path: string,
  settleMs: number,
  nowMs: number = Date.now(),
): Promise<boolean> {
  return isPathHot(await store.mtime(path), settleMs, nowMs);
}

/** True when the local embedded version is this ref or a later one. */
export function versionAtOrAhead(localVersion: string | undefined, refVersion: string): boolean {
  if (!localVersion) return false;
  if (localVersion === refVersion) return true;
  const local = decodeVersionId(localVersion);
  const ref = decodeVersionId(refVersion);
  if (local === null || ref === null) return false;
  return local > ref;
}

export function isDeferExpired(
  entry: DeferredEntry,
  nowMs: number,
  ttlMs: number = DEFER_TTL_MS,
): boolean {
  return nowMs - entry.since >= ttlMs;
}

/**
 * Insert or replace a deferred hold. Newer version_id wins when both decode.
 */
export function enqueueDeferred(
  deferred: DeferredMap,
  path: string,
  ref: VersionRef,
  nowMs: number = Date.now(),
): void {
  const existing = deferred.get(path);
  if (existing) {
    const old = decodeVersionId(existing.ref.version_id);
    const neu = decodeVersionId(ref.version_id);
    if (old !== null && neu !== null && neu <= old) return;
    // Keep original `since` so TTL is from first deferral of this path.
    deferred.set(path, { ref, since: existing.since });
    return;
  }
  deferred.set(path, { ref, since: nowMs });
}

/**
 * Decide how to converge an existing local file with an incoming remote version.
 * Does not touch the filesystem or kernel — callers run `effectInbound`.
 *
 * When `canDefer` is false (e.g. `--once` with no deferred map), hot files are
 * treated as cold so the pass still converges.
 */
export function decideInbound(opts: {
  localText: string;
  remote: Version;
  hot: boolean;
  canDefer: boolean;
}): InboundDecision {
  const { localText, remote } = opts;
  const treatHot = opts.hot && opts.canDefer;
  const intr = readFileIntrinsics(localText);
  if (isIgnored(intr)) return { action: "noop" };

  if (intr.computed_hash === remote.content_hash) {
    if (intr.version === remote.version_id && intr.content_hash === remote.content_hash) {
      return { action: "noop" };
    }
    if (treatHot) return { action: "defer" };
    return { action: "adopt", version: remote };
  }

  if (versionAtOrAhead(intr.version, remote.version_id)) {
    return { action: "noop" };
  }

  if (!isDirty(intr)) {
    if (treatHot) return { action: "defer" };
    return { action: "materialize", version: remote };
  }

  // Dirty + divergent: rebase local bytes onto remote current (better-sync WS2).
  if (treatHot) return { action: "defer" };
  return {
    action: "rebase",
    prevVersionId: remote.version_id,
    user: stripToUserContent(localText),
  };
}

export type EffectResult = "noop" | "applied" | "deferred" | "parked";

/**
 * Apply a decision from `decideInbound`. Rebase failures (`stale_prev` /
 * `path_taken`) fall through to parking the remote as an ignored sibling.
 */
export async function effectInbound(
  client: KernelClient,
  store: FileStore,
  repo: string,
  path: string,
  decision: InboundDecision,
  opts: {
    deferred?: DeferredMap;
    ref?: VersionRef;
    map?: RemoteMap;
    nowMs?: number;
  } = {},
): Promise<EffectResult> {
  const nowMs = opts.nowMs ?? Date.now();

  switch (decision.action) {
    case "noop":
      return "noop";
    case "defer": {
      if (opts.deferred && opts.ref) {
        enqueueDeferred(opts.deferred, path, opts.ref, nowMs);
        return "deferred";
      }
      // No place to hold it — treat as cold materialize of the ref's version.
      return "noop";
    }
    case "adopt": {
      await materializeAt(store, path, decision.version, { preserveMtime: true });
      opts.map?.set(path, {
        version_id: decision.version.version_id,
        content_hash: decision.version.content_hash,
      });
      return "applied";
    }
    case "materialize": {
      await materializeAt(store, path, decision.version);
      opts.map?.set(path, {
        version_id: decision.version.version_id,
        content_hash: decision.version.content_hash,
      });
      return "applied";
    }
    case "rebase": {
      try {
        const v = await putAndAck(
          client,
          store,
          repo,
          path,
          decision.prevVersionId,
          decision.user,
        );
        opts.map?.set(path, { version_id: v.version_id, content_hash: v.content_hash });
        return "applied";
      } catch (err) {
        if (
          err instanceof KernelError &&
          (err.code === "stale_prev" || err.code === "path_taken")
        ) {
          const current = await client.docs.get_version(repo, decision.prevVersionId);
          // Prefer live current at path if available (may have advanced).
          let park: Version = current;
          try {
            park = await client.docs.get(repo, path);
          } catch {
            // Keep get_version result.
          }
          await parkIgnoredSibling(store, path, park);
          return "parked";
        }
        throw err;
      }
    }
  }
}

/**
 * Retry one deferred hold: re-read local, fetch remote, decide, effect.
 * Returns whether the entry should be removed from the deferred map.
 */
export async function retryDeferredEntry(
  client: KernelClient,
  store: FileStore,
  repo: string,
  path: string,
  entry: DeferredEntry,
  opts: {
    settleMs: number;
    map?: RemoteMap;
    nowMs?: number;
    deferred?: DeferredMap;
  },
): Promise<{ done: boolean; result: EffectResult }> {
  const nowMs = opts.nowMs ?? Date.now();
  const forceCold = isDeferExpired(entry, nowMs);
  const hot = forceCold ? false : await pathIsHot(store, path, opts.settleMs, nowMs);
  const canDefer = opts.deferred !== undefined && !forceCold;

  if (entry.ref.op === "delete") {
    const text = await store.read(path);
    if (text === null) return { done: true, result: "noop" };
    const intr = readFileIntrinsics(text);
    if (isIgnored(intr) || isDirty(intr)) return { done: true, result: "noop" };
    if (hot && canDefer) return { done: false, result: "deferred" };
    await store.remove(path);
    opts.map?.delete(path);
    return { done: true, result: "applied" };
  }

  const text = await store.read(path);
  if (text === null) {
    // Local gone — materialize remote current if still live.
    try {
      const current = await client.docs.get(repo, path);
      if (hot && canDefer) return { done: false, result: "deferred" };
      await materializeAt(store, path, current);
      opts.map?.set(path, {
        version_id: current.version_id,
        content_hash: current.content_hash,
      });
      return { done: true, result: "applied" };
    } catch (err) {
      if (err instanceof KernelError && err.code === "doc_not_found") {
        return { done: true, result: "noop" };
      }
      throw err;
    }
  }

  // Prefer live current at path; fall back to the held version.
  let remote: Version;
  try {
    remote = await client.docs.get(repo, path);
  } catch (err) {
    if (!(err instanceof KernelError && err.code === "doc_not_found")) throw err;
    try {
      remote = await client.docs.get_version(repo, entry.ref.version_id);
    } catch {
      return { done: true, result: "noop" };
    }
  }

  const decision = decideInbound({
    localText: text,
    remote,
    hot,
    canDefer,
  });
  if (decision.action === "defer") {
    return { done: false, result: "deferred" };
  }
  const result = await effectInbound(client, store, repo, path, decision, {
    map: opts.map,
    nowMs,
  });
  return { done: true, result };
}
