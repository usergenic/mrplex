/**
 * The real filesystem `FileStore` (sync/history plan §4). Maps repo-relative
 * POSIX doc paths to files under `<root>`, walking the vault to enumerate the
 * live set. The `.mrplex/` state dir is skipped by the scope filter, but we
 * also prune it (and dotdirs like `.obsidian/`) during the walk for speed.
 */

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SYNC_DIR, toDocPath, toLocalPath } from "./paths.js";
import type { FileStore } from "./reconcile.js";

export function createFsStore(root: string): FileStore {
  return {
    async list(): Promise<string[]> {
      const out: string[] = [];
      await walk(root, root, out);
      return out;
    },
    async read(docPath: string): Promise<string | null> {
      try {
        return await readFile(toLocalPath(root, docPath), "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async write(docPath: string, text: string): Promise<void> {
      const abs = toLocalPath(root, docPath);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, text, "utf8");
    },
    async remove(docPath: string): Promise<void> {
      await rm(toLocalPath(root, docPath), { force: true });
    },
  };
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const ent of entries) {
    if (ent.isDirectory()) {
      // Prune the sync state dir and hidden dirs (e.g. .obsidian) — the scope
      // filter would exclude them anyway; pruning avoids the descent.
      if (ent.name === SYNC_DIR || ent.name.startsWith(".")) continue;
      await walk(root, `${dir}/${ent.name}`, out);
    } else if (ent.isFile()) {
      const docPath = toDocPath(root, `${dir}/${ent.name}`);
      if (docPath !== null) out.push(docPath);
    }
  }
}
