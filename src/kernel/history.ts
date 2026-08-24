/**
 * The `history` namespace (sync/history plan §3) — a top-level read surface
 * keyed by position in the version log, spanning documents. `history.since` is
 * the global change feed: it wraps `Storage.versions_since` (the gap-aware
 * walk, §3.2) and enriches each settled row into a `VersionRef` — deriving
 * `op` and resolving `prev_path` — so consumers never parse path sigils.
 */

import type { Storage, VersionRow } from "../storage/types.js";
import { decodeVersionId, encodeVersionId } from "./version-id.js";
import type { HistorySincePage, VersionOp, VersionRef } from "./wire.js";

/** Default feed page size when a caller omits `limit` (§3.3). */
export const HISTORY_SINCE_DEFAULT_LIMIT = 500;

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
