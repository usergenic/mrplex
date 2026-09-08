/**
 * `links` verify family (docs/verify-plan.md §2.6) — link index vs. re-extraction.
 *
 * Re-runs the pure extraction+normalization pipeline (`extractEdges` →
 * `normalizeEdges`) for each live version under the repo's effective link
 * config, resolves candidates against an in-memory snapshot of the live path
 * set (the same first-candidate-wins, self-link-drop, dense-ord logic as the
 * write path's `reindexOutboundLinks`), and diffs the result against the stored
 * `links` rows. Then checks resolution correctness against the live set.
 *
 * Findings:
 *   • links.set_mismatch          — re-extracted (ord,field,target_raw) set ≠ stored
 *   • links.misresolved_dangling  — target_id null but a live doc exists at target_norm
 *   • links.misresolved_bound     — target_id points at a missing/non-live doc, or one
 *                                    whose current path's fold ≠ target_norm
 *   • links.self_link             — source_id == target_id (excluded by construction)
 *   • links.deleted_source_has_outbound — a doc in the system namespace still has edges
 */

import { extractEdges } from "../../links/extract.js";
import { normalizeEdges } from "../../links/resolve.js";
import type { LinkRow, VersionRow } from "../../storage/types.js";
import { normalizeKey } from "../casefold.js";
import { pathIsInSystemNamespace } from "../deletion.js";
import { type CheckContext, canRead, did, finding } from "./checks.js";

/** The identity-independent shape of an edge, for set comparison. */
type EdgeKey = { ord: number; field: string; target_raw: string };

export async function checkLinks(ctx: CheckContext): Promise<void> {
  const setMismatch = ctx.selected("links.set_mismatch");
  const misDangling = ctx.selected("links.misresolved_dangling");
  const misBound = ctx.selected("links.misresolved_bound");
  const selfLink = ctx.selected("links.self_link");
  const deletedOutbound = ctx.selected("links.deleted_source_has_outbound");
  if (!setMismatch && !misDangling && !misBound && !selfLink && !deletedOutbound) return;

  const live = await ctx.storage.versions_live_by_repo(ctx.repo.id);
  // Live path snapshot: folded path → document id. This is the resolution
  // universe the write path binds against (via version_current's fold).
  const liveByNorm = new Map<string, number>();
  for (const v of live) {
    liveByNorm.set(normalizeKey(v.path), v.document_id);
  }

  const storedRows = await ctx.storage.links_by_repo(ctx.repo.id);
  const storedBySource = new Map<number, LinkRow[]>();
  for (const row of storedRows) {
    const list = storedBySource.get(row.source_id);
    if (list) list.push(row);
    else storedBySource.set(row.source_id, [row]);
  }

  // --- set_mismatch: re-extract each live doc and diff against stored rows.
  if (setMismatch) {
    for (const v of live) {
      const expected = resolveExpected(ctx, v, liveByNorm);
      const stored = (storedBySource.get(v.document_id) ?? [])
        .slice()
        .sort((a, b) => a.ord - b.ord)
        .map((r) => ({ ord: r.ord, field: r.field, target_raw: r.target_raw }));
      const { missing, extra } = diffEdgeSets(expected, stored);
      if (missing.length > 0 || extra.length > 0) {
        ctx.acc.add(
          finding(ctx, {
            check: "links.set_mismatch",
            severity: "error",
            document_id: did(v.document_id),
            path: canRead(ctx, v.path) ? v.path : undefined,
            detail: { missing, extra },
          }),
        );
      }
    }
  }

  // --- per-row resolution correctness + self-link.
  const currentPathByDoc = new Map<number, string>();
  for (const v of live) currentPathByDoc.set(v.document_id, v.path);

  for (const row of storedRows) {
    if (row.target_id === null) {
      if (misDangling && liveByNorm.has(row.target_norm)) {
        ctx.acc.add(
          finding(ctx, {
            check: "links.misresolved_dangling",
            severity: "error",
            document_id: did(row.source_id),
            detail: {
              target_norm: row.target_norm,
              should_bind_to: did(liveByNorm.get(row.target_norm) as number),
            },
          }),
        );
      }
      continue;
    }

    if (selfLink && row.target_id === row.source_id) {
      ctx.acc.add(
        finding(ctx, {
          check: "links.self_link",
          severity: "warn",
          document_id: did(row.source_id),
          detail: { ord: row.ord },
        }),
      );
    }

    if (misBound) {
      const targetPath = currentPathByDoc.get(row.target_id);
      // A bound edge should point at a live document whose current folded path
      // equals the edge's target_norm. Missing (not live) or a fold mismatch
      // is a stale binding renames alone can't explain.
      if (targetPath === undefined) {
        ctx.acc.add(
          finding(ctx, {
            check: "links.misresolved_bound",
            severity: "error",
            document_id: did(row.source_id),
            detail: { target_id: did(row.target_id), reason: "target not live in this repo" },
          }),
        );
      } else if (normalizeKey(targetPath) !== row.target_norm) {
        ctx.acc.add(
          finding(ctx, {
            check: "links.misresolved_bound",
            severity: "error",
            document_id: did(row.source_id),
            detail: {
              target_id: did(row.target_id),
              target_norm: row.target_norm,
              actual_norm: normalizeKey(targetPath),
              reason: "bound target's folded path differs from target_norm",
            },
          }),
        );
      }
    }
  }

  // --- deleted_source_has_outbound: a doc under a system sigil keeps edges.
  if (deletedOutbound) {
    // Sources with stored edges whose current path is in the system namespace.
    // We need the current path of each source doc, incl. deleted ones — the
    // live snapshot only has user-territory docs, so scan the source ids that
    // have edges but are absent from the live set.
    const liveDocIds = new Set(live.map((v) => v.document_id));
    for (const [sourceId] of storedBySource) {
      if (liveDocIds.has(sourceId)) continue; // live doc — edges are expected
      // Not in the live set: either deleted (system namespace) or gone. Either
      // way it shouldn't have outbound edges. Resolve its current path to
      // report it precisely.
      const versions = await ctx.storage.versions_by_document(sourceId);
      const current = versions.find((v) => v.next_id === null);
      const inSystem =
        current !== undefined &&
        pathIsInSystemNamespace(current.path, ctx.pathConfig.system_sigils);
      ctx.acc.add(
        finding(ctx, {
          check: "links.deleted_source_has_outbound",
          severity: "error",
          document_id: did(sourceId),
          detail: {
            edge_count: (storedBySource.get(sourceId) as LinkRow[]).length,
            reason: inSystem ? "source is deleted (system namespace)" : "source not live",
          },
        }),
      );
    }
  }
}

/**
 * Re-derive the expected stored edge keys for one live version — the pure twin
 * of `reindexOutboundLinks`: extract → normalize → resolve against the live
 * snapshot, drop external (no-candidate) and self edges, re-pack ord densely.
 */
function resolveExpected(
  ctx: CheckContext,
  v: VersionRow,
  liveByNorm: Map<string, number>,
): EdgeKey[] {
  const raw = extractEdges({ body: v.body, frontmatter: v.frontmatter, config: ctx.linkConfig });
  const normalized = normalizeEdges(raw, v.path, ctx.linkConfig);
  const out: EdgeKey[] = [];
  let ord = 0;
  for (const edge of normalized) {
    if (edge.candidates.length === 0) continue; // external / unresolvable
    // Resolve: first candidate that maps to a live doc; else dangling.
    let targetId: number | null = null;
    for (const candidate of edge.candidates) {
      const docId = liveByNorm.get(normalizeKey(candidate));
      if (docId !== undefined) {
        targetId = docId;
        break;
      }
    }
    if (targetId === v.document_id) continue; // self-link dropped
    out.push({ ord: ord++, field: edge.field, target_raw: edge.target_raw });
  }
  return out;
}

/** Diff two ord-ordered edge-key lists positionally by (ord,field,target_raw). */
function diffEdgeSets(
  expected: EdgeKey[],
  stored: EdgeKey[],
): { missing: EdgeKey[]; extra: EdgeKey[] } {
  const key = (e: EdgeKey) => `${e.ord} ${e.field} ${e.target_raw}`;
  const expSet = new Set(expected.map(key));
  const storedSet = new Set(stored.map(key));
  const missing = expected.filter((e) => !storedSet.has(key(e)));
  const extra = stored.filter((e) => !expSet.has(key(e)));
  return { missing, extra };
}
