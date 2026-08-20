/**
 * mrplex links repair — rewrite stale link text so the written destination
 * matches the target's current path (design §11.2 "Link rewriting is
 * cosmetic, not structural — and opt-in").
 *
 * The graph is identity-bound, so a move breaks nothing structurally; this
 * only repairs the visible text. Each source document is rewritten as an
 * ordinary optimistic `docs.put` under the caller's token — `prev` checks
 * apply, conflicts are reported and skipped, and every repair is a normal
 * authored version in the chain (NOT a silent side effect of the move).
 *
 * Rewriting is surgical: only the destination spans of stale edges are
 * spliced (right-to-left so earlier offsets stay valid); the rest of the
 * body is byte-identical. Only inline/​wikilink edges with a captured
 * destination span are rewritten; reference-definition links are left for a
 * later phase.
 */

import { normalizeKey } from "../kernel/casefold.js";
import type { Storage, VersionRow } from "../storage/types.js";
import { type RawEdge, extractEdges } from "./extract.js";
import type { LinkConfig } from "./link-config.js";
import { normalizeEdges } from "./resolve.js";

export type RepairOutcome = {
  repaired: { path: string; edges: number }[]; // docs rewritten (+ edge count)
  skipped: { path: string; reason: string }[]; // conflicts / nothing-to-do
};

/**
 * A single planned rewrite of one source document: the new body plus the
 * version to base the optimistic put on. Returned by planRepairs so a
 * caller (the kernel op) can drive the actual docs.put and handle conflicts.
 */
export type RepairPlan = {
  version: VersionRow; // the live version to rewrite (prev for the put)
  newBody: string;
  edges: number; // how many destinations were rewritten
};

/**
 * Compute the body rewrites needed to repair stale links across a repo's
 * live documents. Pure w.r.t. storage reads — no writes. The caller issues
 * the puts (so auth, conflict handling, and dry-run all live at the op
 * layer, where the actor and kernel are in scope).
 */
export async function planRepairs(
  storage: Storage,
  repoId: number,
  config: LinkConfig,
): Promise<RepairPlan[]> {
  const live = await storage.versions_live_by_repo(repoId);
  const currentPathByDoc = new Map<number, string>();
  for (const v of live) currentPathByDoc.set(v.document_id, v.path);

  const plans: RepairPlan[] = [];
  for (const version of live) {
    const stored = await storage.links_by_source(version.document_id);
    if (stored.length === 0) continue;

    const raw = extractEdges({ body: version.body, frontmatter: version.frontmatter, config });
    const normalized = normalizeEdges(raw, version.path, config);
    // The stored rows correspond to the storable (non-external) edges in
    // order; re-derive that alignment, keeping the RawEdge (for dest_span).
    const storableRaw: RawEdge[] = [];
    for (let i = 0; i < normalized.length; i++) {
      if ((normalized[i] as (typeof normalized)[number]).candidates.length > 0) {
        storableRaw.push(raw[i] as RawEdge);
      }
    }

    // Collect (span, replacement) rewrites for stale, span-bearing edges.
    const rewrites: { start: number; end: number; text: string }[] = [];
    for (let i = 0; i < stored.length && i < storableRaw.length; i++) {
      const row = stored[i];
      const edge = storableRaw[i];
      if (!row || !edge) continue;
      if (row.target_id === null) continue; // dangling — nothing to repair
      const currentPath = currentPathByDoc.get(row.target_id);
      if (currentPath === undefined) continue; // target not live
      if (normalizeKey(row.target_norm) === normalizeKey(currentPath)) continue; // fresh
      if (!edge.dest_span) continue; // reference-def link: not rewritable here

      // Preserve any anchor the writer had on the destination.
      const anchorIx = edge.target.indexOf("#");
      const anchor = anchorIx >= 0 ? edge.target.slice(anchorIx) : "";
      // Wikilinks are written without the .md extension by convention; keep
      // that shape. Inline links get the full repo-relative path.
      const replacement = edge.wikilink ? stripMd(currentPath) + anchor : currentPath + anchor;
      rewrites.push({ start: edge.dest_span.start, end: edge.dest_span.end, text: replacement });
    }

    if (rewrites.length === 0) continue;

    // Splice right-to-left so earlier offsets remain valid.
    rewrites.sort((a, b) => b.start - a.start);
    let body = version.body;
    for (const r of rewrites) {
      body = body.slice(0, r.start) + r.text + body.slice(r.end);
    }
    plans.push({ version, newBody: body, edges: rewrites.length });
  }
  return plans;
}

function stripMd(path: string): string {
  return path.endsWith(".md") ? path.slice(0, -3) : path;
}
