/**
 * Link-index maintenance — the write-path glue (design §11.2, WS3).
 *
 * Extraction is pure CPU (no external I/O), so the design runs it in the
 * write transaction alongside version_insert rather than on the async
 * backlog worker (links-plan.md §5 decision 1). These helpers are called
 * from inside the kernel's create/put/delete tx closures.
 *
 * The flow for a source document D whose current version just advanced:
 *   1. extractEdges(body, frontmatter, config)     → RawEdge[]   (parse)
 *   2. normalizeEdges(edges, srcPath, config)       → NormalizedEdge[] (paths)
 *   3. resolve each edge's candidates against live paths → target_id | null
 *   4. links_replace(repo, D, resolved)
 *
 * Resolution is case-insensitive: candidates are matched via the storage
 * layer's version_current (which folds to path_norm, §3.5.1), and the
 * folded key of the primary candidate is stored as target_norm so a later
 * dangling re-resolution can rebind by folded path.
 */

import { normalizeKey } from "../kernel/casefold.js";
import type { FrontmatterJson } from "../markdown/frontmatter.js";
import type { LinkEdgeInput, Storage } from "../storage/types.js";
import { type RawEdge, extractEdges } from "./extract.js";
import type { LinkConfig } from "./link-config.js";
import { type NormalizedEdge, normalizeEdges } from "./resolve.js";

/**
 * Resolve one normalized edge's ordered candidates against the repo's live
 * paths, returning the storable edge. The first candidate that resolves to
 * a live document wins; if none resolve, the edge is dangling (target_id
 * null) and keyed by the folded primary candidate for later rebinding.
 *
 * An edge with no candidates (external URI / bare fragment) yields null —
 * it never enters the index (links are repo-local, §11.2).
 */
async function resolveEdge(
  storage: Storage,
  repoId: number,
  edge: NormalizedEdge,
): Promise<LinkEdgeInput | null> {
  if (edge.candidates.length === 0) return null;

  let targetId: number | null = null;
  for (const candidate of edge.candidates) {
    const current = await storage.version_current(repoId, candidate);
    if (current) {
      targetId = current.document_id;
      break;
    }
  }

  // The primary candidate is the canonical resolution key: its folded form
  // is what a later-appearing document's path will match against to rebind.
  const primary = edge.candidates[0] as string;
  return {
    ord: edge.ord,
    field: edge.field,
    target_raw: edge.target_raw,
    target_norm: normalizeKey(primary),
    target_id: targetId,
  };
}

/**
 * Extract + resolve + persist document `sourceId`'s outbound edges. Called
 * after every create/put that advances the doc's current version, inside
 * the same tx. `sourcePath` is the new current version's repo-root-relative
 * path (edges resolve relative to it).
 */
export async function reindexOutboundLinks(
  storage: Storage,
  config: LinkConfig,
  repoId: number,
  sourceId: number,
  sourcePath: string,
  body: string,
  frontmatter: FrontmatterJson,
): Promise<void> {
  const rawEdges: RawEdge[] = extractEdges({ body, frontmatter, config });
  const normalized = normalizeEdges(rawEdges, sourcePath, config);

  const resolved: LinkEdgeInput[] = [];
  let ord = 0;
  for (const edge of normalized) {
    const stored = await resolveEdge(storage, repoId, edge);
    if (stored === null) continue;
    // Drop self-links: an edge resolving to the source document itself is
    // noise — it would make the doc appear in its own $backlinks_static() /
    // $links_static() and match $in_static against itself. A self-reference
    // is never a meaningful graph edge, so it never enters the index.
    if (stored.target_id === sourceId) continue;
    // Re-pack ord densely: dropped edges (external, self) must not leave
    // gaps, and the PK is (source_id, ord). Extraction order is preserved.
    resolved.push({ ...stored, ord: ord++ });
  }

  await storage.links_replace(repoId, sourceId, resolved);
}

/**
 * Bind dangling edges that name `path` (in `repoId`) to `documentId`, so a
 * document appearing at a path (create / move-in / restore) resolves the
 * links that were waiting for it. Matches on the folded path (§3.5.1),
 * consistent with how resolution stored target_norm. Returns the count
 * bound. Bind-only — never unbinds (a move produces zero inbound churn).
 */
export async function bindDanglingToPath(
  storage: Storage,
  repoId: number,
  path: string,
  documentId: number,
): Promise<number> {
  return storage.links_resolve_dangling(repoId, normalizeKey(path), documentId);
}
