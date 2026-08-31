/**
 * Startup reconciliation (sync/history plan §4.9) — the entirety of
 * `mrplex sync --once`. No watcher, no remote deletes (by construction, §4.6).
 *
 * The pass walks the remote live set (history.index through a safe head R) and
 * the local files, then resolves each path/identity against the §4.9 table.
 * Every verdict is deterministic and non-destructive: local edits are pushed,
 * clean local copies adopt remote provenance in place, and true conflicts park
 * the remote current as an ignored sibling rather than clobbering local bytes.
 *
 * This module is transport-agnostic: it drives a `KernelClient` and a small
 * `FileStore` seam (real fs in `fs-store.ts`, in-memory in tests), so the whole
 * §4.9 table is testable against a local kernel without touching disk.
 */

import type { KernelClient } from "../client/kernel-client.js";
import { KernelError } from "../kernel/errors.js";
import type { IndexItem } from "../kernel/wire.js";
import {
  materializeAt,
  parkIgnoredSibling,
  putAndAck,
  stripToUserContent,
} from "./converge.js";
import { decideInbound, effectInbound } from "./hot-path.js";
import {
  type FileIntrinsics,
  isDirty,
  isIgnored,
  readFileIntrinsics,
  renderMaterialized,
} from "./intrinsics.js";
import type { ScopeFilter } from "./paths.js";

/** The filesystem seam the reconciler drives (real fs or in-memory test double). */
export type FileStore = {
  /** All in-scope doc paths present locally (repo-relative POSIX). */
  list(): Promise<string[]>;
  /** File text at a doc path, or null if absent. */
  read(docPath: string): Promise<string | null>;
  /**
   * Write file text at a doc path (creating parent dirs).
   * `preserveMtime` keeps the previous mtime — provenance stamps must not look
   * newer than an Obsidian client's still-unsynced buffer or iCloud/Obsidian
   * Sync will push the stamped snapshot back and clobber in-progress typing.
   */
  write(docPath: string, text: string, opts?: { preserveMtime?: boolean }): Promise<void>;
  /** Remove the file at a doc path (no-op if already absent). */
  remove(docPath: string): Promise<void>;
  /**
   * File mtime in epoch milliseconds, or null if absent. Used by the settle /
   * hot-path gate (better-sync.plan); provenance-preserving writes must not
   * advance this value.
   */
  mtime(docPath: string): Promise<number | null>;
};

/** One reconciliation action, for reporting + dry-run (§4.1 `--dry-run`). */
export type SyncAction = {
  path: string;
  verdict:
    | "clean"
    | "adopt" // metadata repair: inject remote provenance into a clean local copy
    | "materialize" // write remote current locally (new or fast-forward)
    | "push" // local edit → docs.put / docs.create
    | "rebase" // dirty local put onto advanced remote current (better-sync)
    | "conflict" // park remote as ignored sibling; local bytes preserved
    | "delete-local" // remote-deleted, local clean → remove
    | "resurrect" // remote-deleted, local dirty → push as create
    | "ignored" // $sync: ignore → skipped
    | "skip"; // nothing to do (e.g. out of scope)
  detail?: string;
};

export type ReconcileOptions = {
  repo: string;
  dryRun?: boolean;
  log?: (msg: string) => void;
};

export type ReconcileReport = {
  through_version: string;
  actions: SyncAction[];
};

/**
 * Run the full §4.9 reconciliation once. Returns the safe head R (the cursor to
 * persist) and the list of actions taken (or planned, under dryRun).
 */
export async function reconcileOnce(
  client: KernelClient,
  store: FileStore,
  scope: ScopeFilter,
  opts: ReconcileOptions,
): Promise<ReconcileReport> {
  const actions: SyncAction[] = [];
  const dryRun = opts.dryRun ?? false;
  const log = opts.log ?? (() => {});

  // 1. Enumerate the remote live set through a safe head R (§3.4). Keyset-page.
  const remoteByPath = new Map<string, IndexItem>();
  let through: string | undefined;
  let after: string | undefined;
  for (;;) {
    const page = await client.history.index({
      repo: opts.repo,
      through_version: through,
      after_version: after,
    });
    through = page.through_version;
    for (const item of page.items) {
      if (scope.matches(item.path)) remoteByPath.set(item.path, item);
    }
    if (page.next_after_version === undefined) break;
    after = page.next_after_version;
  }
  const R = through ?? "";

  // Index remote items by embedded version id too, for move detection (§4.7).
  const remoteByVersion = new Map<string, IndexItem>();
  for (const item of remoteByPath.values()) remoteByVersion.set(item.version_id, item);

  // 2. Walk local files (in scope; $sync: ignore excluded from the walk, §4.9).
  const localPaths = (await store.list()).filter((p) => scope.matches(p));
  const seenRemote = new Set<string>();

  for (const path of localPaths) {
    const text = await store.read(path);
    if (text === null) continue; // vanished between list and read — skip
    const intr = readFileIntrinsics(text);
    if (isIgnored(intr)) {
      actions.push({ path, verdict: "ignored" });
      continue;
    }
    const remote = remoteByPath.get(path);
    if (remote) seenRemote.add(path);
    const action = await resolveLocalPath(client, store, opts, dryRun, {
      path,
      intr,
      remote,
      remoteByVersion,
    });
    actions.push(action);
  }

  // 3. Remote docs with no local file → materialize (§4.9 row 9; the offline
  //    concession restoring deletes). Never a remote delete.
  for (const [path, item] of remoteByPath) {
    if (seenRemote.has(path)) continue;
    if (!dryRun) {
      const v = await client.docs.get_version(opts.repo, item.version_id);
      await store.write(path, renderMaterialized(v));
    }
    actions.push({ path, verdict: "materialize", detail: "remote doc absent locally" });
  }

  for (const a of actions) {
    if (a.verdict !== "clean" && a.verdict !== "skip") {
      log(`${a.verdict}\t${a.path}${a.detail ? `\t(${a.detail})` : ""}`);
    }
  }
  return { through_version: R, actions };
}

/** Resolve one local file against its remote counterpart (the §4.9 table). */
async function resolveLocalPath(
  client: KernelClient,
  store: FileStore,
  opts: ReconcileOptions,
  dryRun: boolean,
  ctx: {
    path: string;
    intr: FileIntrinsics;
    remote: IndexItem | undefined;
    remoteByVersion: Map<string, IndexItem>;
  },
): Promise<SyncAction> {
  const { path, intr, remote } = ctx;
  const dirty = isDirty(intr);

  if (remote) {
    // A document lives at this path remotely.
    if (intr.computed_hash === remote.content_hash) {
      // Local user-bytes already equal the remote version — a clean equivalence
      // even if the file has no embedded provenance (row 2) or stale intrinsics.
      // Path equality alone never suffices; only this hash match licenses
      // stamping the remote $version. Metadata-only, no server write.
      if (intr.version === remote.version_id && intr.content_hash === remote.content_hash) {
        return { path, verdict: "clean" };
      }
      if (!dryRun) await materializeInPlace(client, store, opts.repo, path, remote.version_id);
      return { path, verdict: "adopt", detail: "content matches remote; provenance repaired" };
    }
    if (!intr.version) {
      // No embedded version and bytes differ → rebase onto remote, else park
      // (better-sync WS2; formerly unconditional §4.9 row 6 park).
      if (dryRun) {
        return { path, verdict: "rebase", detail: "occupied path, no local provenance" };
      }
      return convergeOccupied(client, store, opts.repo, path);
    }
    if (intr.version === remote.version_id) {
      // Embedded version is the remote current.
      if (!dirty) return { path, verdict: "clean" };
      // Local edit on top of the current → push (row 4).
      if (!dryRun) await pushEdit(client, store, opts.repo, path, intr.version);
      return { path, verdict: "push", detail: "local edit on current" };
    }
    // Embedded version differs from remote current.
    if (!dirty) {
      // Local unedited but stale → fast-forward to remote current (row 3).
      if (!dryRun) await materializeVersion(client, store, opts.repo, path, remote.version_id);
      return { path, verdict: "materialize", detail: "fast-forward to remote current" };
    }
    // Local edited AND remote advanced → rebase, else park (better-sync WS2).
    if (dryRun) {
      return { path, verdict: "rebase", detail: "local edit vs advanced remote" };
    }
    return convergeOccupied(client, store, opts.repo, path);
  }

  // No remote doc at this path.
  const embeddedVersion = intr.version;
  const known = embeddedVersion ? ctx.remoteByVersion.get(embeddedVersion) : undefined;
  if (known && embeddedVersion) {
    // Embedded version is known at a DIFFERENT remote path → a move (row 8).
    // The clean/dirty + conflict subtleties of live moves belong to the daemon;
    // for --once we push the move (put with the new path) when the local file
    // carries the ancestry. A stale_prev downgrades to a conflict.
    if (!dryRun) {
      try {
        await pushMove(client, store, opts.repo, path, embeddedVersion);
      } catch (err) {
        if (err instanceof KernelError && err.code === "stale_prev") {
          await parkConflictForCurrent(client, store, opts.repo, path, embeddedVersion);
          return { path, verdict: "conflict", detail: "move raced remote change" };
        }
        throw err;
      }
    }
    return { path, verdict: "push", detail: `move from ${known.path}` };
  }

  if (!intr.version) {
    // No provenance, path absent remotely → a genuine local creation (row 7).
    if (!dryRun) await pushCreate(client, store, opts.repo, path);
    return { path, verdict: "push", detail: "local creation" };
  }

  // Embedded version exists but the document is no longer live at this path and
  // isn't known elsewhere → it was remotely deleted. Clean removes locally;
  // dirty resurrects (push as create). Never discard dirty bytes (§4.9 edge).
  if (!dirty) {
    if (!dryRun) await store.remove(path);
    return { path, verdict: "delete-local", detail: "remote-deleted, local clean" };
  }
  if (!dryRun) await pushCreate(client, store, opts.repo, path);
  return { path, verdict: "resurrect", detail: "remote-deleted, local dirty" };
}

// --- effecting helpers -------------------------------------------------------

async function readUserContent(
  store: FileStore,
  path: string,
): Promise<{ frontmatter_raw: string; body: string }> {
  const text = (await store.read(path)) ?? "";
  return stripToUserContent(text);
}

async function materializeVersion(
  client: KernelClient,
  store: FileStore,
  repo: string,
  path: string,
  versionId: string,
): Promise<void> {
  const v = await client.docs.get_version(repo, versionId);
  await materializeAt(store, path, v);
}

/** Repair a clean local file's embedded provenance to the given version. */
async function materializeInPlace(
  client: KernelClient,
  store: FileStore,
  repo: string,
  path: string,
  versionId: string,
): Promise<void> {
  const v = await client.docs.get_version(repo, versionId);
  await materializeAt(store, path, v, { preserveMtime: true });
}

async function pushEdit(
  client: KernelClient,
  store: FileStore,
  repo: string,
  path: string,
  prevVersionId: string,
): Promise<void> {
  const user = await readUserContent(store, path);
  await putAndAck(client, store, repo, path, prevVersionId, user);
}

async function pushMove(
  client: KernelClient,
  store: FileStore,
  repo: string,
  path: string,
  prevVersionId: string,
): Promise<void> {
  const user = await readUserContent(store, path);
  // A put whose path differs from prev's path is a move preserving identity.
  await putAndAck(client, store, repo, path, prevVersionId, user);
}

async function pushCreate(
  client: KernelClient,
  store: FileStore,
  repo: string,
  path: string,
): Promise<void> {
  const user = await readUserContent(store, path);
  try {
    const v = await client.docs.create(repo, path, user);
    await store.write(path, renderMaterialized(v), { preserveMtime: true });
  } catch (err) {
    if (err instanceof KernelError && err.code === "create_conflict") {
      // A doc appeared at this path since the index scan; rebase or park.
      await convergeOccupied(client, store, repo, path);
      return;
    }
    throw err;
  }
}

/**
 * Rebase local bytes onto the live remote current at `path`, else park a
 * sibling (better-sync WS2). Used for §4.9 rows 5–6 and create races.
 */
async function convergeOccupied(
  client: KernelClient,
  store: FileStore,
  repo: string,
  path: string,
): Promise<SyncAction> {
  const text = (await store.read(path)) ?? "";
  const remote = await client.docs.get(repo, path);
  const decision = decideInbound({
    localText: text,
    remote,
    hot: false,
    canDefer: false,
  });
  const result = await effectInbound(client, store, repo, path, decision);
  if (result === "parked" || decision.action === "noop") {
    // noop here would mean ignored; occupied diverge shouldn't noop.
    if (result === "parked") {
      return { path, verdict: "conflict", detail: "rebase failed; parked remote sibling" };
    }
  }
  if (decision.action === "rebase" || result === "applied") {
    return { path, verdict: "rebase", detail: "local bytes put onto remote current" };
  }
  if (decision.action === "adopt") {
    return { path, verdict: "adopt", detail: "content matches remote; provenance repaired" };
  }
  return { path, verdict: "conflict", detail: "could not converge occupied path" };
}

/** Conflict park keyed off the doc's *current* remote version (move race). */
async function parkConflictForCurrent(
  client: KernelClient,
  store: FileStore,
  repo: string,
  path: string,
  embeddedVersionId: string,
): Promise<void> {
  const superseded = await client.docs.get_version(repo, embeddedVersionId);
  const current = await client.docs.get(repo, superseded.path);
  await parkIgnoredSibling(store, path, current);
}
