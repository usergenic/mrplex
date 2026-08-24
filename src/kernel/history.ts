/**
 * The `history` namespace (sync/history plan §3) — a top-level read surface
 * keyed by position in the version log, spanning documents. `history.since` is
 * the global change feed: it wraps `Storage.versions_since` (the gap-aware
 * walk, §3.2) and enriches each settled row into a `VersionRef` — deriving
 * `op` and resolving `prev_path` — so consumers never parse path sigils.
 */

import type { Storage, VersionRow } from "../storage/types.js";
import { decodeVersionId, encodeVersionId } from "./version-id.js";
import type {
  HistoryIndexPage,
  HistorySincePage,
  IndexItem,
  VersionOp,
  VersionRef,
} from "./wire.js";

/** Default feed page size when a caller omits `limit` (§3.3). */
export const HISTORY_SINCE_DEFAULT_LIMIT = 500;

/** Default `history.index` page size when a caller omits `limit` (§3.4). */
export const HISTORY_INDEX_DEFAULT_LIMIT = 1000;

/**
 * Safety-window duration (§3.2): a gap's successor visible longer than this is
 * treated as settled (the hole is burned, cross it); younger means the hole may
 * still be committing (truncate before it). ~30s dwarfs any real write-tx.
 */
export const HISTORY_SAFETY_WINDOW_MS = 30_000;

/**
 * Derive the operation a version row represents (§3.3): no prev → create; same
 * path → update; a new path in the system namespace (a `:deleted/…` tombstone)
 * → delete; any other new path → move.
 */
export function deriveOp(
  hasPrev: boolean,
  path: string,
  prevPath: string | null,
  isSystemPath: (p: string) => boolean,
): VersionOp {
  if (!hasPrev) return "create";
  if (prevPath === path) return "update";
  if (isSystemPath(path)) return "delete";
  return "move";
}

export type HistorySinceInput = {
  after_version: string; // opaque version_id; "" = from the beginning
  repo_id?: number;
  limit: number;
  now_ms: number;
  window_ms: number;
};

export type HistorySinceDeps = {
  storage: Storage;
  /** repo id → slug, for stamping refs. */
  repoSlug: (repoId: number) => string;
  /** Whether a path lives in the system namespace (delete tombstones). */
  isSystemPath: (path: string) => boolean;
  /** Visibility gate: true when the caller may see this repo+path. */
  canRead: (repoId: number, path: string) => boolean;
};

/**
 * The global change feed. Advances the cursor to the storage safe frontier
 * regardless of how many refs survive the visibility filter, so a caller with
 * narrow scope still makes progress rather than stalling on hidden rows.
 */
export async function runHistorySince(
  input: HistorySinceInput,
  deps: HistorySinceDeps,
): Promise<HistorySincePage> {
  // "" (or any unparseable cursor) means "from the beginning" → after_id 0.
  const afterId = input.after_version === "" ? 0 : (decodeVersionId(input.after_version) ?? 0);

  const { rows, next_id } = await deps.storage.versions_since({
    after_id: afterId,
    repo_id: input.repo_id,
    limit: input.limit,
    now_ms: input.now_ms,
    window_ms: input.window_ms,
  });

  // Batch-resolve prev paths (both ends of moves/deletes) in one lookup.
  const prevIds = rows.map((r) => r.prev_id).filter((id): id is number => id !== null);
  const prevPaths =
    prevIds.length > 0
      ? await deps.storage.versions_paths_by_ids(prevIds)
      : new Map<number, string>();

  const refs: VersionRef[] = [];
  for (const row of rows) {
    const prevPath = row.prev_id === null ? null : (prevPaths.get(row.prev_id) ?? null);
    // Visibility: deliver when the caller can read either endpoint — a delete's
    // tombstone path may be hidden while its prior path is readable, and vice
    // versa. Absent scope (canRead always true) sees everything.
    const visible =
      deps.canRead(row.repo_id, row.path) ||
      (prevPath !== null && deps.canRead(row.repo_id, prevPath));
    if (!visible) continue;
    refs.push(toRef(row, prevPath, deps));
  }

  const nextSince = next_id > afterId ? encodeVersionId(next_id) : input.after_version;
  return { refs, next_since: nextSince };
}

export type HistoryIndexInput = {
  repo_id: number;
  through_version?: string; // omitted on the first call; captured + echoed
  after_version?: string; // previous page's last version_id
  limit: number;
  now_ms: number;
  window_ms: number;
};

export type HistoryIndexDeps = {
  storage: Storage;
  /** Exclude a path from the index (system/hidden namespaces, as query does). */
  isExcluded: (path: string) => boolean;
  /** Visibility gate for the caller's scope. */
  canRead: (path: string) => boolean;
};

/**
 * Page the live set as of a safe head `R` (§3.4). On the first call (no
 * `through_version`) the server captures `R = versions_safe_head(...)` and
 * echoes it; subsequent pages pass it back. Keyset over current-version id in
 * `(after, R]`, never offset — a document updated mid-pagination gets a new id
 * > R, drops out of the remaining pages, and is delivered by
 * `history.since(R)` afterward. System/hidden paths and out-of-scope rows are
 * dropped here (the storage page is lightweight and unfiltered), so a raw page
 * may yield fewer visible items than `limit`; we keep pulling storage pages
 * until we fill `limit` or reach R.
 */
export async function runHistoryIndex(
  input: HistoryIndexInput,
  deps: HistoryIndexDeps,
): Promise<HistoryIndexPage> {
  const through =
    input.through_version !== undefined && input.through_version !== ""
      ? (decodeVersionId(input.through_version) ?? 0)
      : await deps.storage.versions_safe_head(input.now_ms, input.window_ms);
  const throughVersion = encodeVersionId(through);

  let afterId =
    input.after_version !== undefined && input.after_version !== ""
      ? (decodeVersionId(input.after_version) ?? 0)
      : 0;

  const items: IndexItem[] = [];
  let exhausted = false;
  while (items.length < input.limit && !exhausted) {
    const rows = await deps.storage.versions_live_index({
      repo_id: input.repo_id,
      through_id: through,
      after_id: afterId,
      // Over-fetch a little so heavy exclusion doesn't cause many round-trips.
      limit: input.limit,
    });
    if (rows.length === 0) {
      exhausted = true;
      break;
    }
    for (const r of rows) {
      afterId = r.id;
      if (deps.isExcluded(r.path)) continue;
      if (!deps.canRead(r.path)) continue;
      items.push({
        path: r.path,
        version_id: encodeVersionId(r.id),
        content_hash: r.content_hash ?? "",
      });
      if (items.length === input.limit) break;
    }
    // A short storage page means we've reached R's boundary.
    if (rows.length < input.limit) exhausted = true;
  }

  // More live rows may remain ≤ R only if the page filled AND we haven't yet
  // consumed up to R itself. Reaching R (afterId === through) means the keyset
  // window is exhausted even when the visible page happened to fill exactly.
  const hasMore = !exhausted && items.length === input.limit && afterId < through;
  return {
    items,
    through_version: throughVersion,
    ...(hasMore ? { next_after_version: encodeVersionId(afterId) } : {}),
  };
}

function toRef(row: VersionRow, prevPath: string | null, deps: HistorySinceDeps): VersionRef {
  return {
    version_id: encodeVersionId(row.id),
    prev_version_id: row.prev_id === null ? null : encodeVersionId(row.prev_id),
    repo: deps.repoSlug(row.repo_id),
    path: row.path,
    prev_path: prevPath,
    // content_hash is always populated post-M1; pre-backfill rows (null) would
    // read as an empty string, which a consumer treats as "unknown, fetch".
    content_hash: row.content_hash ?? "",
    op: deriveOp(row.prev_id !== null, row.path, prevPath, deps.isSystemPath),
    created_at: row.created_at,
  };
}
