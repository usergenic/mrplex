/**
 * links.stale — find live documents whose written link text no longer
 * matches the resolved target's current path (design §11.2 "Link rewriting
 * is cosmetic"). A move is identity-bound, so the edge stays resolved but
 * the *text* goes stale; this surfaces that gap so `mrplex links repair`
 * can rewrite it.
 *
 * Staleness is defined only for RESOLVED edges (target_id not null) — a
 * dangling edge has no current target path to disagree with. And only for
 * body edges with a rewritable destination span; a reference-style link's
 * destination lives in a separate definition (out of scope for Phase 1
 * repair), and frontmatter edges aren't a "link text" in the body.
 */

import { normalizeKey } from "../kernel/casefold.js";
import type { Storage } from "../storage/types.js";
import { extractEdges } from "./extract.js";
import type { LinkConfig } from "./link-config.js";
import { normalizeEdges } from "./resolve.js";

export type StaleLink = {
  source_id: number;
  source_path: string; // the live path of the document holding the stale link
  ord: number;
  written: string; // target_raw as stored (what the link currently says)
  current: string; // the target's current live path (what it should say)
};

/**
 * Scan a repo's live documents for stale link text. Scope filtering is the
 * caller's concern (the kernel op applies it); this walks the raw index.
 *
 * Algorithm: for each live source, re-extract its edges (to recover the
 * per-edge destination span + written form), resolve them, and for each
 * resolved edge compare the target's current path against what was written.
 * Re-extraction keeps this consistent with exactly what repair will rewrite.
 */
export async function findStaleLinks(
  storage: Storage,
  repoId: number,
  config: LinkConfig,
): Promise<StaleLink[]> {
  const out: StaleLink[] = [];
  const live = await storage.versions_live_by_repo(repoId);
  // Map document_id → current path for O(1) target lookups.
  const currentPathByDoc = new Map<number, string>();
  for (const v of live) currentPathByDoc.set(v.document_id, v.path);

  for (const version of live) {
    const stored = await storage.links_by_source(version.document_id);
    if (stored.length === 0) continue;

    // Re-extract to recover destination spans + the written target string.
    const raw = extractEdges({ body: version.body, frontmatter: version.frontmatter, config });
    const normalized = normalizeEdges(raw, version.path, config);

    // Align stored rows (dense ord) with the re-extracted edges that
    // produced them (external edges were dropped during storage, so filter
    // the normalized list the same way maintain.ts does).
    const storable = normalized.filter((e) => e.candidates.length > 0);

    for (let i = 0; i < stored.length && i < storable.length; i++) {
      const row = stored[i];
      const edge = storable[i];
      if (!row || !edge) continue;
      if (row.target_id === null) continue; // dangling: no current path to compare

      const currentTargetPath = currentPathByDoc.get(row.target_id);
      if (currentTargetPath === undefined) continue; // target not live (deleted)

      // The written target resolves to the target's OLD path; compare its
      // folded form against the target's CURRENT folded path. A mismatch is
      // stale text. Comparison is case-insensitive (identity is folded), so
      // a pure recasing of the target isn't flagged unless the path changed.
      // row.target_norm is already folded (maintain.ts stores it), so
      // compare it directly against the folded current path.
      if (row.target_norm !== normalizeKey(currentTargetPath)) {
        out.push({
          source_id: version.document_id,
          source_path: version.path,
          ord: row.ord,
          written: row.target_raw,
          current: currentTargetPath,
        });
      }
    }
  }
  return out;
}
