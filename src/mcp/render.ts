/**
 * Human-text rendering of kernel results for MCP tool `content`. The
 * structuredContent carries the wire object verbatim; this is the
 * best-effort text shape an agent (or a debug console) would want to see
 * alongside.
 *
 * Kept intentionally small — the CLI's pretty-printers already speak to
 * humans; the MCP text rendering just has to be *readable*, not pretty.
 */

import type { GraphResult, QueryHit, Repo, Version } from "../kernel/wire.js";

export function renderJson(x: unknown): string {
  return JSON.stringify(x, null, 2);
}

export function renderRepoList(repos: Repo[]): string {
  if (repos.length === 0) return "(no repos)";
  return repos.map((r) => `${r.repo}${r.path_config ? "  (custom path_config)" : ""}`).join("\n");
}

export function renderVersion(v: Version): string {
  return `${v.repo}/${v.path}  @${v.version_id}  by ${v.author}  ${v.created_at}`;
}

export function renderVersionList(versions: Version[]): string {
  if (versions.length === 0) return "(no results)";
  return versions.map(renderVersion).join("\n");
}

/**
 * Text half for `query`'s projected hits. Since `select` decides which fields
 * are present, render each hit as its `key: value` pairs in projection order —
 * a compact, readable line per hit rather than a fixed column layout.
 */
export function renderQueryHitList(hits: QueryHit[]): string {
  if (hits.length === 0) return "(no results)";
  return hits
    .map((hit) =>
      Object.entries(hit)
        .map(([key, value]) => `${key}: ${renderHitValue(value)}`)
        .join("  "),
    )
    .join("\n");
}

function renderHitValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * The graph tool's fixed text half (docs/graph-plan.md §2.3): a dense
 * adjacency listing grouped by field, one block per document. Pure function
 * of the structured result — the same rendering the CLI uses by default.
 */
export function renderGraphSummary(result: GraphResult): string {
  if (result.documents.length === 0) return "(no documents)";

  // Group each document's outgoing/incoming links by field for compact display.
  // out: source == doc; in: target == doc.
  const outByDoc = new Map<string, Map<string, string[]>>();
  const inByDoc = new Map<string, Map<string, string[]>>();
  const add = (
    byDoc: Map<string, Map<string, string[]>>,
    doc: string,
    field: string,
    other: string,
  ): void => {
    let byField = byDoc.get(doc);
    if (!byField) {
      byField = new Map();
      byDoc.set(doc, byField);
    }
    const list = byField.get(field);
    if (list) list.push(other);
    else byField.set(field, [other]);
  };
  for (const l of result.links) {
    add(outByDoc, l.source, l.field, l.target);
    add(inByDoc, l.target, l.field, l.source);
  }

  const lines: string[] = [];
  for (const doc of result.documents) {
    lines.push(`${doc.$path} (${doc.$degrees})`);
    const out = outByDoc.get(doc.$path);
    if (out) {
      for (const field of [...out.keys()].sort()) {
        lines.push(`  →(${field}) ${(out.get(field) as string[]).sort().join(", ")}`);
      }
    }
    const inc = inByDoc.get(doc.$path);
    if (inc) {
      for (const field of [...inc.keys()].sort()) {
        lines.push(`  ←(${field}) ${(inc.get(field) as string[]).sort().join(", ")}`);
      }
    }
  }

  const trailer: string[] = [];
  if (result.frontier.length > 0) trailer.push(`frontier: ${result.frontier.join(" · ")}`);
  trailer.push(
    `complete through ${result.complete_degrees} degree${result.complete_degrees === 1 ? "" : "s"}`,
  );
  if (result.truncated) trailer.push("truncated");
  lines.push(trailer.join(" · "));

  return lines.join("\n");
}
