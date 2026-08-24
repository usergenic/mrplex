/**
 * Path mapping and scope filtering for sync (sync/history plan §4.1). A single
 * include/exclude predicate filters BOTH directions — the local walk, the index
 * items, and the feed refs all pass through it — so the two sides can never
 * disagree about what is in scope. Local `<root>`-relative paths map to doc
 * paths by relative POSIX path.
 */

import { relative, resolve, sep } from "node:path";
import { pathMatchesGlobs } from "../kernel/auth/glob.js";

/** The cursor/state directory inside a synced vault (§4.2). */
export const SYNC_DIR = ".mrplex";
/** The cursor file path relative to the vault root. */
export const CURSOR_FILE = `${SYNC_DIR}/sync.json`;

export type ScopeFilter = {
  /** True when a doc path (POSIX, repo-relative) is in sync scope. */
  matches(docPath: string): boolean;
};

/**
 * Build the include/exclude predicate. Defaults to `**\/*.md` include (§4.1).
 * Exclusions always win; the `.mrplex/` state dir is excluded unconditionally
 * so the cursor file is never synced or witnessed.
 */
export function makeScopeFilter(opts?: {
  include?: string[];
  exclude?: string[];
}): ScopeFilter {
  const include = opts?.include && opts.include.length > 0 ? opts.include : ["**/*.md"];
  const exclude = opts?.exclude ?? [];
  return {
    matches(docPath: string): boolean {
      if (docPath.startsWith(`${SYNC_DIR}/`)) return false;
      if (exclude.length > 0 && pathMatchesGlobs(exclude, docPath)) return false;
      return pathMatchesGlobs(include, docPath);
    },
  };
}

/**
 * Map an absolute local file path to its repo-relative POSIX doc path, or null
 * when the file is outside `<root>`. On POSIX this is just the relative path;
 * on Windows backslashes fold to `/` so doc paths are portable.
 */
export function toDocPath(root: string, absPath: string): string | null {
  const rel = relative(resolve(root), resolve(absPath));
  if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`)) return null;
  return sep === "/" ? rel : rel.split(sep).join("/");
}

/** Map a repo-relative POSIX doc path back to an absolute local file path. */
export function toLocalPath(root: string, docPath: string): string {
  const native = sep === "/" ? docPath : docPath.split("/").join(sep);
  return resolve(root, native);
}
