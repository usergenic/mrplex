/**
 * docs.diff — the one v1 read primitive deferred from M3 (m4-plan WS5).
 *
 * Produces a unified diff over the byte-exact serialized documents (§3.2
 * — one canonical representation via frontmatter.join). Both versions
 * must belong to the same document at `(repo, path)`; otherwise the
 * `version_not_in_document` error we reserved back in M1 finally fires.
 *
 * Read scope is checked on the lookup path AND both version paths
 * (m4-plan §5 decision 10) — a doc renamed out of the caller's scope
 * doesn't leak history through diff.
 */

import { createTwoFilesPatch } from "diff";
import { join as joinFrontmatter } from "../markdown/frontmatter.js";
import type { Storage, VersionRow } from "../storage/types.js";
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
  resolveReadRepo: (slug: string) => Promise<{ id: number; slug: string }>;
  authorizeReadPath: (repoSlug: string, path: string) => void;
};

export async function runDiff(
  input: {
    repo: string;
    path: string;
    from_version_id: string;
    to_version_id: string;
  },
  deps: DiffDeps,
): Promise<UnifiedDiff> {
  const repo = await deps.resolveReadRepo(input.repo);
  deps.authorizeReadPath(repo.slug, input.path);

  const current = await deps.storage.version_current(repo.id, input.path);
  if (!current) throw docNotFound(input.repo, input.path);
  const documentId = current.document_id;

  const from = await decodeAndFetch(deps.storage, input.from_version_id);
  const to = await decodeAndFetch(deps.storage, input.to_version_id);

  if (from.document_id !== documentId) {
    throw versionNotInDocument(input.from_version_id, input.repo, input.path);
  }
  if (to.document_id !== documentId) {
    throw versionNotInDocument(input.to_version_id, input.repo, input.path);
  }
  if (from.repo_id !== repo.id || to.repo_id !== repo.id) {
    throw versionNotInDocument(input.from_version_id, input.repo, input.path);
  }

  deps.authorizeReadPath(repo.slug, from.path);
  deps.authorizeReadPath(repo.slug, to.path);

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

async function decodeAndFetch(storage: Storage, versionId: string): Promise<VersionRow> {
  const id = decodeVersionId(versionId);
  if (id === null) throw versionNotFound(versionId);
  const row = await storage.version_by_id(id);
  if (!row) throw versionNotFound(versionId);
  return row;
}

function serializeVersion(v: VersionRow): string {
  return joinFrontmatter({ frontmatter_raw: v.frontmatter_raw, body: v.body });
}

export { KernelError };
