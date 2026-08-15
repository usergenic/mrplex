/**
 * docs.diff — the one v1 read primitive deferred from M3 (m4-plan WS5).
 *
 * Produces a unified diff over the byte-exact serialized documents (§3.2
 * — one canonical representation via frontmatter.join). Both versions
 * must belong to the same document at `(repo, path)`; otherwise the
 * `version_not_in_document` error we reserved back in M1 finally fires.
 *
 * Wire shape (m4-plan §5 decision 8):
 *   {
 *     repo, path,
 *     from_version_id, to_version_id,
 *     patch,           // unified diff, {path}@{version_id} headers
 *   }
 *
 * Read scope is checked on the lookup path AND both version paths
 * (m4-plan §5 decision 10) — a doc renamed out of the caller's scope
 * doesn't leak history through diff.
 */

import { createTwoFilesPatch } from "diff";
import { join as joinFrontmatter } from "../markdown/frontmatter.js";
import type { Storage, VersionRow } from "../storage/types.js";
import type { Actor } from "./auth/actor.js";
import { KernelError, docNotFound, versionNotFound, versionNotInDocument } from "./errors.js";
import { decodeVersionId } from "./version-id.js";

export type UnifiedDiff = {
  repo: string;
  path: string;
  from_version_id: string;
  to_version_id: string;
  patch: string;
};

export type DiffDeps = {
  storage: Storage;
  /**
   * Callback that produces the (repo_id → repo_slug) lookup. In practice
   * the kernel passes its own `resolveRepo(actor, slug, "read")`
   * pattern, which handles authorize + repo_not_found for us.
   */
  resolveReadRepo: (actor: Actor, slug: string) => { id: number };
  /**
   * Ask the shared kernel helper to authorize a read on this path — the
   * write-not-required path scope check (§8.2).
   */
  authorizeReadPath: (actor: Actor, repo_id: number, path: string) => void;
};

export function runDiff(
  actor: Actor,
  input: {
    repo: string;
    path: string;
    from_version_id: string;
    to_version_id: string;
  },
  deps: DiffDeps,
): UnifiedDiff {
  const repo = deps.resolveReadRepo(actor, input.repo);
  deps.authorizeReadPath(actor, repo.id, input.path);

  // Current document at (repo, path) — anchors the identity we require
  // both endpoints to share. doc_not_found if the live path is missing.
  const current = deps.storage.version_current(repo.id, input.path);
  if (!current) throw docNotFound(input.repo, input.path);
  const documentId = current.document_id;

  const from = decodeAndFetch(deps.storage, input.from_version_id);
  const to = decodeAndFetch(deps.storage, input.to_version_id);

  // Both versions must belong to the same document as (repo, path).
  if (from.document_id !== documentId) {
    throw versionNotInDocument(input.from_version_id, input.repo, input.path);
  }
  if (to.document_id !== documentId) {
    throw versionNotInDocument(input.to_version_id, input.repo, input.path);
  }
  if (from.repo_id !== repo.id || to.repo_id !== repo.id) {
    // Defensive: the document_id check should have caught this, but
    // pin the invariant.
    throw versionNotInDocument(input.from_version_id, input.repo, input.path);
  }

  // §8.2 — path globs match at the path each version was at. Re-check
  // read scope on each version's own path so a caller whose scope no
  // longer covers a historical path can't diff into it.
  deps.authorizeReadPath(actor, repo.id, from.path);
  deps.authorizeReadPath(actor, repo.id, to.path);

  const fromText = serializeVersion(from);
  const toText = serializeVersion(to);
  const patch = createTwoFilesPatch(
    `${from.path}@${input.from_version_id}`,
    `${to.path}@${input.to_version_id}`,
    fromText,
    toText,
  );

  return {
    repo: input.repo,
    path: input.path,
    from_version_id: input.from_version_id,
    to_version_id: input.to_version_id,
    patch,
  };
}

function decodeAndFetch(storage: Storage, versionId: string): VersionRow {
  const id = decodeVersionId(versionId);
  if (id === null) throw versionNotFound(versionId);
  const row = storage.version_by_id(id);
  if (!row) throw versionNotFound(versionId);
  return row;
}

function serializeVersion(v: VersionRow): string {
  return joinFrontmatter({ frontmatter_raw: v.frontmatter_raw, body: v.body });
}

// Re-export so callers who want the constructor for tests get it here.
export { KernelError };
