/**
 * The one persistent client state: a single cursor (sync/history plan §4.2).
 * `<root>/.mrplex/sync.json` holds `{ server, repo, last_synced_version_id }`,
 * meaning "every change at or before this position in the log is reflected on
 * disk." In-vault so it travels with the vault it describes. There is no
 * per-file database, manifest, or tombstone journal.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CURSOR_FILE } from "./paths.js";

export type SyncCursor = {
  server?: string;
  repo?: string;
  last_synced_version_id: string;
};

/**
 * Read the cursor file, or null when absent (marker absent → full index
 * reconciliation, §4.9). A malformed file throws — the caller must not silently
 * treat corruption as "start fresh."
 */
export async function readCursor(root: string): Promise<SyncCursor | null> {
  const path = join(root, CURSOR_FILE);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed = JSON.parse(text) as SyncCursor;
  if (typeof parsed.last_synced_version_id !== "string") {
    throw new Error(`${path}: missing last_synced_version_id`);
  }
  return parsed;
}

/**
 * Write the cursor atomically (temp + rename) so a crash mid-write can't leave
 * a torn file. The cursor advances only after a batch's filesystem effects
 * complete (§4.3), so this is called at safe points.
 */
export async function writeCursor(root: string, cursor: SyncCursor): Promise<void> {
  const path = join(root, CURSOR_FILE);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(cursor, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}
