/**
 * Shared disk↔kernel write helpers used by push, feed, and reconcile so
 * inbound rebase and outbound ack stay byte-identical (better-sync.plan).
 */

import type { KernelClient } from "../client/kernel-client.js";
import { withVersionSuffix } from "../kernel/deletion.js";
import type { Version } from "../kernel/wire.js";
import { extractSystemProperties, split } from "../markdown/frontmatter.js";
import { renderIgnoredSibling, renderMaterialized, stampProvenance } from "./intrinsics.js";
import type { FileStore } from "./reconcile.js";

export type UserContent = { frontmatter_raw: string; body: string };

/** Split a file into stored-shape fields, dropping all `$*` intrinsic lines. */
export function stripToUserContent(text: string): UserContent {
  const lf = text.replace(/\r\n/g, "\n");
  const { frontmatter_raw, body } = split(lf);
  return { frontmatter_raw: extractSystemProperties(frontmatter_raw).raw, body };
}

/**
 * After a successful kernel write, restamp the local file. If the editor saved
 * again during the round-trip, keep those bytes and only update provenance —
 * never write the snapshot we just pushed over newer typing.
 */
export async function ackLocalWrite(
  store: FileStore,
  path: string,
  v: Version,
  pushed: UserContent,
): Promise<void> {
  const now = await store.read(path);
  if (now === null) return;
  const current = stripToUserContent(now);
  if (current.body === pushed.body && current.frontmatter_raw === pushed.frontmatter_raw) {
    await store.write(path, renderMaterialized(v), { preserveMtime: true });
    return;
  }
  await store.write(path, stampProvenance(now, v.version_id, v.content_hash), {
    preserveMtime: true,
  });
}

/** Optimistic put of local user bytes, then ack provenance on disk. */
export async function putAndAck(
  client: KernelClient,
  store: FileStore,
  repo: string,
  path: string,
  prevVersionId: string,
  user: UserContent,
): Promise<Version> {
  const v = await client.docs.put(repo, prevVersionId, path, user);
  await ackLocalWrite(store, path, v, user);
  return v;
}

/** Park remote as `<name>-<version_id>.md` with `$sync: ignore` (§4.8). */
export async function parkIgnoredSibling(
  store: FileStore,
  path: string,
  version: Version,
): Promise<void> {
  await store.write(withVersionSuffix(path, version.version_id), renderIgnoredSibling(version));
}

/** Write remote version bytes at the canonical path (fast-forward / materialize). */
export async function materializeAt(
  store: FileStore,
  path: string,
  version: Version,
  opts?: { preserveMtime?: boolean },
): Promise<void> {
  await store.write(path, renderMaterialized(version), opts);
}
