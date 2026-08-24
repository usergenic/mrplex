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
 *
 * A rename is unlink(old) + add(new) of a file that still embeds `$version`.
 * `pushBurst` is the §4.7 debounce burst: present paths (moves/edits) run
 * before absent ones (deletes), and a delete is suppressed when another file
 * in the burst still carries that version. `pushPath` itself still pushes a
 * *clean* move when the map knows the version at a different path, and a
 * late-arriving dest after a premature delete restores from `:deleted`
 * rather than parking a no-op conflict.
 */

import type { KernelClient } from "../client/kernel-client.js";
import { pathIsInSystemNamespace, withVersionSuffix } from "../kernel/deletion.js";
import { KernelError } from "../kernel/errors.js";
import { HARDCODED_DEFAULTS } from "../kernel/path-config.js";
import type { Version } from "../kernel/wire.js";
import { extractSystemProperties, split } from "../markdown/frontmatter.js";
import {
  isDirty,
  isIgnored,
  readFileIntrinsics,
  renderIgnoredSibling,
  renderMaterialized,
  stampProvenance,
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

type UserContent = { frontmatter_raw: string; body: string };

type StalePrevData = {
  current_version_id?: string | null;
  current_path?: string | null;
};

/**
 * Process a debounce burst of paths together (§4.7). Present files (moves,
 * edits, creates) run first so a rename's dest put supersedes the source
 * unlink; a witnessed delete is skipped when another file in the burst still
 * embeds that version. Each path is isolated: one failure does not abort the
 * rest.
 */
export async function pushBurst(paths: string[], deps: PushDeps): Promise<PushResult[]> {
  const unique = [...new Set(paths)];
  const present: string[] = [];
  const absent: string[] = [];
  const presentByVersion = new Map<string, string>();

  for (const path of unique) {
    const text = await deps.store.read(path);
    if (text === null) {
      absent.push(path);
      continue;
    }
    present.push(path);
    const version = readFileIntrinsics(text).version;
    if (version) presentByVersion.set(version, path);
  }

  const suppressDelete = new Set<string>();
  for (const path of absent) {
    const known = deps.map.get(path);
    if (!known) continue;
    const dest = presentByVersion.get(known.version_id);
    if (dest !== undefined && dest !== path) suppressDelete.add(path);
  }

  const results: PushResult[] = [];
  const log = deps.log ?? (() => {});

  for (const path of present) {
    try {
      results.push(await pushPath(path, deps));
    } catch (err) {
      log(`push error\t${path}\t${(err as Error).message}`);
    }
  }

  for (const path of absent) {
    if (suppressDelete.has(path)) {
      deps.map.delete(path);
      results.push("no-op-untracked-unlink");
      continue;
    }
    try {
      results.push(await pushPath(path, deps));
    } catch (err) {
      log(`push error\t${path}\t${(err as Error).message}`);
    }
  }

  return results;
}

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
  // Exceptions that still fall through to put:
  //   • `$version` is known at a *different* map path — a live rename (§4.7)
  //   • `$version` is not in the map at all — a late rename dest after the
  //     source was already dropped; currentAtPath equal to embedded is the
  //     only cheap "already synced here" proof that avoids a no-op version
  if (!isDirty(intr)) {
    const source = intr.version ? findMapPathByVersion(map, intr.version) : undefined;
    if (source === path) {
      return "clean";
    }
    if (source === undefined) {
      if (intr.version) {
        const current = await currentAtPath(client, repo, path);
        if (current && current.version_id === intr.version) {
          map.set(path, { version_id: current.version_id, content_hash: current.content_hash });
          return "clean";
        }
        // dest empty or different version → fall through to put / restore
      } else {
        return "clean";
      }
    }
  }

  const user = stripToUserContent(text);

  // Provenance present → optimistic put (§4.4). This is also how a move
  // propagates (§4.7): the file at the new path still embeds its `$version`,
  // and a put whose path differs from the prev version's path IS a move that
  // preserves document identity — the kernel resolves it from prev_version_id.
  if (intr.version) {
    try {
      return await commitPut(deps, path, intr.version, user, "update");
    } catch (err) {
      if (err instanceof KernelError && err.code === "stale_prev") {
        return recoverStalePut(deps, path, user, intr.computed_hash, err);
      }
      throw err;
    }
  }

  // Dirty, no embedded provenance → resolve the current remote doc at this path
  // first (§4.4): absent → create; present + hash-equal → adopt provenance in
  // place; present + differ → occupied-path conflict.
  const current = await currentAtPath(client, repo, path);
  if (!current) {
    return createAtPath(deps, path, user, intr.computed_hash);
  }
  return occupiedPath(deps, path, intr.computed_hash, current);
}

/**
 * `stale_prev` on a put: dest occupied → rebase local bytes onto the remote
 * current (Obsidian keeps typing after we already pushed a snapshot); dest
 * empty and the document currently lives in the system namespace (a premature
 * local delete of a rename source) → put from that current version to restore
 * identity; dest empty with no recoverable current → create so the local file
 * is not stranded.
 */
async function recoverStalePut(
  deps: PushDeps,
  path: string,
  user: UserContent,
  computedHash: string,
  err: KernelError,
): Promise<PushResult> {
  const { client, store, repo } = deps;
  const log = deps.log ?? (() => {});
  const destCurrent = await currentAtPath(client, repo, path);
  if (destCurrent) {
    if (computedHash === destCurrent.content_hash) {
      return occupiedPath(deps, path, computedHash, destCurrent);
    }
    try {
      // Same-path continuation: the editor is still on an older $version but
      // has newer bytes. Put those bytes on top of current instead of parking
      // a sibling that then gets fed back over the open note.
      return await commitPut(deps, path, destCurrent.version_id, user, "update");
    } catch (rebaseErr) {
      if (
        !(
          rebaseErr instanceof KernelError &&
          (rebaseErr.code === "stale_prev" || rebaseErr.code === "path_taken")
        )
      ) {
        throw rebaseErr;
      }
      await store.write(
        withVersionSuffix(path, destCurrent.version_id),
        renderIgnoredSibling(destCurrent),
      );
      log(`conflict\t${path}`);
      return "conflict";
    }
  }

  const data = err.data as StalePrevData;
  const currentId = data.current_version_id ?? null;
  let currentPath = data.current_path ?? null;
  if (currentId && !currentPath) {
    try {
      currentPath = (await client.docs.get_version(repo, currentId)).path;
    } catch {
      // Leave currentPath unset; restore is skipped and we may create.
    }
  }

  if (currentId && currentPath && isDeletedPath(currentPath)) {
    try {
      return await commitPut(deps, path, currentId, user, "restore");
    } catch (restoreErr) {
      if (!(restoreErr instanceof KernelError && restoreErr.code === "stale_prev"))
        throw restoreErr;
      // Raced; fall through to create so the file is not left unpushable.
    }
  }

  if (currentId && currentPath && !isDeletedPath(currentPath)) {
    // Still live at another path with a newer version — local rename vs
    // remote edit. Park the remote current; keep local bytes.
    const current = await client.docs.get_version(repo, currentId);
    await store.write(withVersionSuffix(path, current.version_id), renderIgnoredSibling(current));
    log(`conflict\t${path}`);
    return "conflict";
  }

  // Dest is empty and we could not follow the document — create so a renamed
  // (or late-arriving) file is never stranded.
  return createAtPath(deps, path, user, computedHash);
}

async function createAtPath(
  deps: PushDeps,
  path: string,
  user: UserContent,
  computedHash: string,
): Promise<PushResult> {
  const { client, store, repo, map } = deps;
  const log = deps.log ?? (() => {});
  try {
    const v = await client.docs.create(repo, path, user);
    await ackLocalWrite(store, path, v, user);
    map.set(path, { version_id: v.version_id, content_hash: v.content_hash });
    log(`create\t${path}`);
    return "created";
  } catch (err) {
    if (err instanceof KernelError && err.code === "create_conflict") {
      const raced = await currentAtPath(client, repo, path);
      if (raced) return occupiedPath(deps, path, computedHash, raced);
    }
    throw err;
  }
}

async function commitPut(
  deps: PushDeps,
  path: string,
  prevVersionId: string,
  user: UserContent,
  logLabel: string,
): Promise<PushResult> {
  const { client, store, repo, map } = deps;
  const log = deps.log ?? (() => {});
  const v = await client.docs.put(repo, prevVersionId, path, user);
  await ackLocalWrite(store, path, v, user);
  dropMapEntriesForVersion(map, prevVersionId, path);
  map.set(path, { version_id: v.version_id, content_hash: v.content_hash });
  log(`${logLabel}\t${path}`);
  return "updated";
}

/**
 * After a successful kernel write, restamp the local file. If the editor saved
 * again during the round-trip, keep those bytes and only update provenance —
 * never write the snapshot we just pushed over newer typing.
 */
async function ackLocalWrite(
  store: FileStore,
  path: string,
  v: Version,
  pushed: UserContent,
): Promise<void> {
  const now = await store.read(path);
  if (now === null) return;
  const current = stripToUserContent(now);
  if (current.body === pushed.body && current.frontmatter_raw === pushed.frontmatter_raw) {
    await store.write(path, renderMaterialized(v));
    return;
  }
  await store.write(path, stampProvenance(now, v.version_id, v.content_hash));
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

function findMapPathByVersion(map: RemoteMap, versionId: string): string | undefined {
  for (const [path, entry] of map) {
    if (entry.version_id === versionId) return path;
  }
  return undefined;
}

/** After a move/restore, the source path must not still look live for unlink. */
function dropMapEntriesForVersion(map: RemoteMap, versionId: string, keepPath: string): void {
  for (const [path, entry] of map) {
    if (path !== keepPath && entry.version_id === versionId) map.delete(path);
  }
}

function isDeletedPath(path: string): boolean {
  return pathIsInSystemNamespace(path, HARDCODED_DEFAULTS.system_sigils);
}

function stripToUserContent(text: string): UserContent {
  const lf = text.replace(/\r\n/g, "\n");
  const { frontmatter_raw, body } = split(lf);
  return { frontmatter_raw: extractSystemProperties(frontmatter_raw).raw, body };
}
