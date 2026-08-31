/**
 * The real filesystem `FileStore` (sync/history plan §4). Maps repo-relative
 * POSIX doc paths to files under `<root>`, walking the vault to enumerate the
 * live set. The `.mrplex/` state dir is skipped by the scope filter, but we
 * also prune it (and dotdirs like `.obsidian/`) during the walk for speed.
 */

import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { toDocPath, toLocalPath } from "./paths.js";
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
    async write(docPath: string, text: string, opts?: { preserveMtime?: boolean }): Promise<void> {
      const abs = toLocalPath(root, docPath);
      await mkdir(dirname(abs), { recursive: true });
      let mtime: Date | undefined;
      if (opts?.preserveMtime) {
        try {
          mtime = (await stat(abs)).mtime;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
      await writeFile(abs, text, "utf8");
      if (mtime) await utimes(abs, mtime, mtime);
    },
    async remove(docPath: string): Promise<void> {
      await rm(toLocalPath(root, docPath), { force: true });
    },
    async mtime(docPath: string): Promise<number | null> {
      try {
        return (await stat(toLocalPath(root, docPath))).mtimeMs;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
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
      // Prune any dot-prefixed dir (the `.mrplex/` state dir, app dotdirs like
      // `.obsidian/`). This is exactly what makeScopeFilter's hasDotSegment
      // excludes, so the walk and the scope filter agree in both directions
      // (§4.1); pruning here just avoids the descent.
      if (ent.name.startsWith(".")) continue;
      await walk(root, `${dir}/${ent.name}`, out);
    } else if (ent.isFile()) {
      const docPath = toDocPath(root, `${dir}/${ent.name}`);
      if (docPath !== null) out.push(docPath);
    }
  }
}
