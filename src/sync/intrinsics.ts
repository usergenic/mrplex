/**
 * Reading and writing the self-describing frontmatter that makes sync work
 * (sync/history plan §2.4, §4.2). A materialized file embeds `$version` and
 * `$content_hash`; a user may also add the `$sync: ignore` client directive.
 * Per-file sync state lives *in the file* — this module is the single place
 * that parses it out and renders it back.
 */

import type { Version } from "../kernel/wire.js";
import { contentHashOfFile } from "../markdown/content-hash.js";
import {
  appendSystemProperty,
  extractSystemProperties,
  join,
  split,
} from "../markdown/frontmatter.js";

/** The `$sync` directive value we honor (§4.2). Only `ignore` is defined. */
export const SYNC_IGNORE = "ignore";

export type FileIntrinsics = {
  /** Embedded `$version` (ancestry), or undefined if absent. */
  version?: string;
  /** Embedded `$content_hash` (clean-state fingerprint), or undefined. */
  content_hash?: string;
  /** Embedded `$sync` client directive, or undefined. */
  sync?: string;
  /** The canonical content hash computed from the file's user bytes. */
  computed_hash: string;
};

/**
 * Parse a file's embedded intrinsics and compute its canonical content hash.
 * The computed hash excludes all `$*` lines, so adding/removing intrinsics or
 * the `$sync` directive never changes it (§4.2).
 */
export function readFileIntrinsics(text: string): FileIntrinsics {
  const lf = text.replace(/\r\n/g, "\n");
  const { frontmatter_raw } = split(lf);
  const { props } = extractSystemProperties(frontmatter_raw);
  return {
    version: props.version,
    content_hash: props.content_hash,
    sync: props.sync,
    computed_hash: contentHashOfFile(lf),
  };
}

/** True when the file opts out of sync via `$sync: ignore` (§4.2). */
export function isIgnored(intr: FileIntrinsics): boolean {
  return intr.sync === SYNC_IGNORE;
}

/**
 * A file is "dirty" when its user bytes differ from the version its embedded
 * `$version` names — i.e. the computed hash ≠ the embedded `$content_hash`
 * (§4.4 hash gate). A file with no embedded hash is treated as dirty (we
 * cannot prove it clean).
 */
export function isDirty(intr: FileIntrinsics): boolean {
  return intr.content_hash === undefined || intr.computed_hash !== intr.content_hash;
}

/**
 * Render a version as a self-describing file: strip any stale `$*` lines from
 * the stored frontmatter, then append `$version` and `$content_hash` in fixed
 * order (§2.4). Robust whether or not the transport already injected them.
 */
export function renderMaterialized(v: Version): string {
  const { raw } = extractSystemProperties(v.frontmatter_raw);
  let fm = appendSystemProperty(raw, "version", v.version_id);
  fm = appendSystemProperty(fm, "content_hash", v.content_hash);
  return join({ frontmatter_raw: fm, body: v.body });
}

/**
 * Render a version as a conflict sibling (§4.8): the normal materialization
 * plus `$sync: ignore`, which is the *only* thing keeping it out of sync.
 */
export function renderIgnoredSibling(v: Version): string {
  const { raw } = extractSystemProperties(v.frontmatter_raw);
  let fm = appendSystemProperty(raw, "version", v.version_id);
  fm = appendSystemProperty(fm, "content_hash", v.content_hash);
  fm = appendSystemProperty(fm, "sync", SYNC_IGNORE);
  return join({ frontmatter_raw: fm, body: v.body });
}
