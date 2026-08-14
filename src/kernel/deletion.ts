/**
 * Deletion path builder — design §3.4.
 *
 *   path/to/document.md   @ v45129   →   :deleted/path/to/document-v45129.md
 *
 * The version-id suffix goes before the file extension so type detection,
 * syntax highlighting, and globs like `**\/*.md` keep working on trashed docs.
 * The extension is "everything from the final segment's last '.'" — with the
 * key caveat that a leading dot doesn't count. So:
 *
 *   README                   → README-v45129
 *   .gitignore               → .gitignore-v45129
 *   notes/foo.tar.gz         → notes/foo.tar-v45129.gz
 *   notes/a-v42.md           → notes/a-v42-v45129.md   (uniqueness still holds:
 *                                                       version_ids are unique
 *                                                       and the suffix is
 *                                                       always appended)
 */

import { PATH_SEPARATOR } from "./validation.js";

/**
 * Split the final segment of a path into `(basename, extension)` per the
 * "final dot, but not a leading dot" rule from §3.4.
 *
 * Returned extension includes its leading dot (e.g. `.md`), or is `""` when
 * there is no extension.
 */
export function splitExtension(finalSegment: string): {
  basename: string;
  extension: string;
} {
  // A leading dot doesn't count as an extension separator — .gitignore is
  // basename `.gitignore`, extension "".
  const searchFrom = finalSegment.startsWith(".") ? 1 : 0;
  const dot = finalSegment.lastIndexOf(".");
  if (dot < searchFrom || dot === finalSegment.length - 1) {
    // Either no dot at all (dot === -1 < searchFrom), or the only dot is the
    // leading one, or the dot is trailing (bare "foo." would be basename
    // "foo." — but §3.5 disallows most weird chars anyway).
    if (dot === -1 || dot < searchFrom) {
      return { basename: finalSegment, extension: "" };
    }
    return { basename: finalSegment.slice(0, dot), extension: finalSegment.slice(dot) };
  }
  return { basename: finalSegment.slice(0, dot), extension: finalSegment.slice(dot) };
}

/**
 * Insert a version-id suffix before the extension of the final path segment.
 * Does NOT prepend the deletion sigil — that's `deletionPath`'s job.
 */
export function withVersionSuffix(path: string, versionIdString: string): string {
  const segments = path.split(PATH_SEPARATOR);
  const last = segments[segments.length - 1] ?? "";
  const { basename, extension } = splitExtension(last);
  segments[segments.length - 1] = `${basename}-${versionIdString}${extension}`;
  return segments.join(PATH_SEPARATOR);
}

/**
 * The kernel-emitted path for a deletion move. `<systemSigil>` is the
 * canonical (first-entry) system sigil from the effective path config
 * (design §3.5.4 — set for input, first for output).
 *
 * Example:
 *   deletionPath(":", "notes/foo.md", "v45129") = ":deleted/notes/foo-v45129.md"
 */
export function deletionPath(
  systemSigil: string,
  originalPath: string,
  versionIdString: string,
): string {
  return `${systemSigil}deleted/${withVersionSuffix(originalPath, versionIdString)}`;
}

/**
 * Rough classifier used by `docs.delete` idempotency (§4.1 rule 4): true if
 * ANY segment of the path starts with one of the accepted system sigils.
 * (The design-wide primitive lives in validation.pathHasSigilSegment; this
 * shim keeps the naming intent-facing at the call site.)
 */
export function pathIsInSystemNamespace(
  path: string,
  systemSigils: readonly string[],
): boolean {
  if (path === "") return false;
  const segments = path.split(PATH_SEPARATOR);
  for (const segment of segments) {
    for (const sigil of systemSigils) {
      if (segment.startsWith(sigil)) return true;
    }
  }
  return false;
}
