/**
 * Local → remote: the debounced per-path pass (sync/history plan §4.4, §4.6,
 * §4.7). Given a settled path, decide: skip (ignored/clean), push (edit/create/
 * move), witnessed-delete, or conflict-park. Event *types* are untrusted — the
 * pass stats the path itself (§4.6): present → change; ENOENT → witnessed
 * delete.
 *
 * The in-memory map (path → last-known { version_id, content_hash }) is the
 * daemon's working knowledge, chiefly so a witnessed unlink still knows the
 * prev_version_id of a file that no longer exists to be read (§4.2 tier 3).
 */

import type { KernelClient } from "../client/kernel-client.js";
import { withVersionSuffix } from "../kernel/deletion.js";
import { KernelError } from "../kernel/errors.js";
import type { Version } from "../kernel/wire.js";
import { extractSystemProperties, split } from "../markdown/frontmatter.js";
import {
  isDirty,
  isIgnored,
  readFileIntrinsics,
  renderIgnoredSibling,
  renderMaterialized,
} from "./intrinsics.js";
import type { FileStore } from "./reconcile.js";

/** Last-known remote state per path (§4.2 tier 3). */
export type RemoteMap = Map<string, { version_id: string; content_hash: string }>;

export type PushResult =
  | "skip"
  | "clean"
  | "ignored"
  | "created"
  | "updated"
  | "deleted"
  | "conflict"
  | "no-op-untracked-unlink";

export type PushDeps = {
  client: KernelClient;
  store: FileStore;
  repo: string;
  map: RemoteMap;
  log?: (msg: string) => void;
};

/**
 * Process one settled path. The store's `read` returning null is the stat
 * verdict "absent" (a witnessed delete); a non-null read is "present" (a
 * change), coalescing the atomic-rename save case into a plain update.
 */
export async function pushPath(path: string, deps: PushDeps): Promise<PushResult> {
  const { client, store, repo, map } = deps;
  const log = deps.log ?? (() => {});
  const text = await store.read(path);

  // --- Witnessed delete (§4.6): the file is gone. ---
  if (text === null) {
    const known = map.get(path);
    if (!known) return "no-op-untracked-unlink"; // never tracked (e.g. $sync:ignore)
    try {
      await client.docs.delete(repo, known.version_id);
      map.delete(path);
      log(`delete\t${path}`);
      return "deleted";
    } catch (err) {
      if (err instanceof KernelError && err.code === "stale_prev") {
        // Remote advanced after our last knowledge → skip the delete; the feed
        // will re-materialize the newer version (§4.6 "remote edit outlives a
        // local delete"). Drop our stale map entry so the feed can repopulate.
        map.delete(path);
        return "skip";
      }
      throw err;
    }
  }

  const intr = readFileIntrinsics(text);
  if (isIgnored(intr)) {
    map.delete(path); // invisible to diffing + deletion (§4.4 directive gate)
    return "ignored";
  }

  // Hash gate (§4.4): computed == embedded → clean, no push. Absorbs editor
  // noise, our own materializations, and our own post-push intrinsic rewrites.
  if (!isDirty(intr)) {
    // Keep the map current even for clean files so a later unlink can delete.
    if (intr.version && intr.content_hash) {
      map.set(path, { version_id: intr.version, content_hash: intr.content_hash });
    }
    return "clean";
  }

  const user = stripToUserContent(text);

  // Dirty with embedded provenance → optimistic put (§4.4). This is also how a
  // move propagates (§4.7): the file at the new path still embeds its $version,
  // and a put whose path differs from the prev version's path IS a move that
  // preserves document identity — the kernel resolves it from prev_version_id.
  // (Move vs. edit is a cosmetic distinction here; both are one optimistic put.)
  if (intr.version) {
    try {
      const v = await client.docs.put(repo, intr.version, path, user);
      await store.write(path, renderMaterialized(v));
      map.set(path, { version_id: v.version_id, content_hash: v.content_hash });
      log(`update\t${path}`);
      return "updated";
    } catch (err) {
      if (err instanceof KernelError && err.code === "stale_prev") {
        // Remote current isn't our embedded version → conflict (§4.8): keep our
        // bytes, park the remote current as an ignored sibling.
        const current = await currentAtPath(client, repo, path);
        if (current) {
          await store.write(
            withVersionSuffix(path, current.version_id),
            renderIgnoredSibling(current),
          );
        }
        log(`conflict\t${path}`);
        return "conflict";
      }
      throw err;
    }
  }

  // Dirty, no embedded provenance → resolve the current remote doc at this path
  // first (§4.4): absent → create; present + hash-equal → adopt provenance in
  // place; present + differ → occupied-path conflict.
  const current = await currentAtPath(client, repo, path);
  if (!current) {
    try {
      const v = await client.docs.create(repo, path, user);
      await store.write(path, renderMaterialized(v));
      map.set(path, { version_id: v.version_id, content_hash: v.content_hash });
      log(`create\t${path}`);
      return "created";
    } catch (err) {
      if (err instanceof KernelError && err.code === "create_conflict") {
        // Raced a create → downgrade to the occupied-path rule.
        const raced = await currentAtPath(client, repo, path);
        if (raced) return occupiedPath(deps, path, intr.computed_hash, raced);
      }
      throw err;
    }
  }
  return occupiedPath(deps, path, intr.computed_hash, current);
}

/** The occupied-path rule (§4.4): hash match → adopt; differ → conflict park. */
async function occupiedPath(
  deps: PushDeps,
  path: string,
  computedHash: string,
  current: Version,
): Promise<PushResult> {
  const { store, map } = deps;
  const log = deps.log ?? (() => {});
  if (computedHash === current.content_hash) {
    // Clean local copy missing metadata → inject remote provenance in place, no
    // server write. Re-render from the current version so intrinsics are exact.
    await store.write(path, renderMaterialized(current));
    map.set(path, { version_id: current.version_id, content_hash: current.content_hash });
    return "clean";
  }
  await store.write(withVersionSuffix(path, current.version_id), renderIgnoredSibling(current));
  log(`conflict\t${path}`);
  return "conflict";
}

async function currentAtPath(
  client: KernelClient,
  repo: string,
  path: string,
): Promise<Version | null> {
  try {
    return await client.docs.get(repo, path);
  } catch (err) {
    if (err instanceof KernelError && err.code === "doc_not_found") return null;
    throw err;
  }
}

function stripToUserContent(text: string): { frontmatter_raw: string; body: string } {
  const lf = text.replace(/\r\n/g, "\n");
  const { frontmatter_raw, body } = split(lf);
  return { frontmatter_raw: extractSystemProperties(frontmatter_raw).raw, body };
}
