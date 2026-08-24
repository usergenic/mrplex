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
 */

import type { KernelClient } from "../client/kernel-client.js";
import { withVersionSuffix } from "../kernel/deletion.js";
import { decodeVersionId } from "../kernel/version-id.js";
import type { VersionRef } from "../kernel/wire.js";
import {
  isDirty,
  isIgnored,
  readFileIntrinsics,
  renderIgnoredSibling,
  renderMaterialized,
} from "./intrinsics.js";
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
};

export type ApplyFeedResult = {
  /** Final resume cursor after draining the currently-safe feed. */
  cursor: string;
  /** Number of refs whose filesystem effect was applied. */
  applied: number;
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
  for (;;) {
    const page = await client.history.since({ after_version: cursor, repo: opts.repo });
    for (const ref of page.refs) {
      if (await applyRef(client, store, scope, opts.repo, ref, log, opts.map)) applied++;
    }
    // No forward progress → caught up (or a hot gap). Stop draining.
    if (page.next_since === cursor || page.refs.length === 0) {
      cursor = page.next_since;
      break;
    }
    cursor = page.next_since;
  }
  return { cursor, applied };
}

/** Apply one feed ref to the local store. Returns true if it changed a file. */
async function applyRef(
  client: KernelClient,
  store: FileStore,
  scope: ScopeFilter,
  repo: string,
  ref: VersionRef,
  log: (msg: string) => void,
  map?: RemoteMap,
): Promise<boolean> {
  if (ref.op === "delete") {
    // Remove the local file at prev_path IF clean; dirty ⇒ keep (resurrection
    // happens on its next local-change cycle). §4.3 delete.
    const target = ref.prev_path;
    if (target === null || !scope.matches(target)) return false;
    map?.delete(target);
    const text = await store.read(target);
    if (text === null) return false;
    const intr = readFileIntrinsics(text);
    if (isIgnored(intr) || isDirty(intr)) return false; // preserve local work
    await store.remove(target);
    log(`feed delete\t${target}`);
    return true;
  }

  if (ref.op === "move") {
    const from = ref.prev_path;
    if (from !== null && scope.matches(from)) {
      map?.delete(from);
      const text = await store.read(from);
      if (text !== null) {
        const intr = readFileIntrinsics(text);
        if (!isIgnored(intr) && !isDirty(intr)) await store.remove(from);
      }
    }
    // Fall through to materialize at the destination path.
  }

  // create / update / move-destination: materialize at ref.path unless the
  // local file already holds these bytes, is at-or-ahead of this ref, is
  // dirty against a *newer* remote, or is $sync: ignore.
  if (!scope.matches(ref.path)) return false;
  const existing = await store.read(ref.path);
  if (existing !== null) {
    const intr = readFileIntrinsics(existing);
    if (isIgnored(intr)) return false;
    if (intr.computed_hash === ref.content_hash) {
      // Bytes already present (our own push echoing back, or a vault copy).
      map?.set(ref.path, { version_id: ref.version_id, content_hash: ref.content_hash });
      // Repair provenance only if the embedded version lags.
      if (intr.version === ref.version_id) return false;
      if (versionAtOrAhead(intr.version, ref.version_id)) return false;
      const v = await client.docs.get_version(repo, ref.version_id);
      await store.write(ref.path, renderMaterialized(v));
      return true;
    }
    // Local is at or ahead of this ref (echo of our push, or a replay of an
    // older version). Never clobber and never park a sibling of something we
    // already have — including when the user has typed more since (dirty).
    if (versionAtOrAhead(intr.version, ref.version_id)) return false;
    if (isDirty(intr)) {
      // A local edit collides with a *newer* incoming version → conflict, not
      // overwrite. Park the remote as an ignored sibling; keep local bytes.
      const v = await client.docs.get_version(repo, ref.version_id);
      await store.write(withVersionSuffix(ref.path, ref.version_id), renderIgnoredSibling(v));
      log(`feed conflict\t${ref.path}`);
      return true;
    }
  }
  const v = await client.docs.get_version(repo, ref.version_id);
  await store.write(ref.path, renderMaterialized(v));
  map?.set(ref.path, { version_id: ref.version_id, content_hash: ref.content_hash });
  log(`feed ${ref.op}\t${ref.path}`);
  return true;
}

/** True when the local embedded version is this ref or a later one. */
function versionAtOrAhead(localVersion: string | undefined, refVersion: string): boolean {
  if (!localVersion) return false;
  if (localVersion === refVersion) return true;
  const local = decodeVersionId(localVersion);
  const ref = decodeVersionId(refVersion);
  if (local === null || ref === null) return false;
  return local > ref;
}
