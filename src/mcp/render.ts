/**
 * Human-text rendering of kernel results for MCP tool `content`. The
 * structuredContent carries the wire object verbatim; this is the
 * best-effort text shape an agent (or a debug console) would want to see
 * alongside.
 *
 * Kept intentionally small — the CLI's pretty-printers already speak to
 * humans; the MCP text rendering just has to be *readable*, not pretty.
 */

import type { GraphResult, QueryHit, Repo, VerifyReport, Version } from "../kernel/wire.js";

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

/** Text half for `docs_get_many`: versions plus a trailing errors block. */
export function renderDocGetManyText(
  items: Version[],
  errors: { path: string; code: string }[],
): string {
  const parts = [renderVersionList(items)];
  if (errors.length > 0) {
    parts.push("errors:");
    for (const e of errors) parts.push(`${e.path}: ${e.code}`);
  }
  return parts.join("\n");
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

/**
 * Text half for `verify` (docs/verify-plan.md §5). A per-finding block grouped
 * by check code, a summary line, and any skipped-check notes. Shared by the MCP
 * tool and the CLI's default (non-JSON) output.
 */
export function renderVerifyReport(report: VerifyReport): string {
  const lines: string[] = [];
  const { versions_scanned, documents_scanned, by_severity } = report.counts;

  if (report.findings.length === 0 && !report.truncated) {
    lines.push("clean — no findings");
  } else {
    // Group findings by check code, preserving first-seen order.
    const byCheck = new Map<string, typeof report.findings>();
    for (const f of report.findings) {
      const list = byCheck.get(f.check);
      if (list) list.push(f);
      else byCheck.set(f.check, [f]);
    }
    for (const [check, findings] of byCheck) {
      const sev = findings[0]?.severity ?? "error";
      lines.push(`${check} [${sev}] — ${findings.length}`);
      for (const f of findings) {
        const loc = f.path ?? f.version_id ?? f.document_id ?? "";
        const fix = f.suggested_fix ? `  (fix: ${f.suggested_fix})` : "";
        lines.push(`  ${f.repo}${loc ? `/${loc}` : ""}${fix}`);
      }
    }
  }

  const vLabel = `${versions_scanned} version${versions_scanned === 1 ? "" : "s"}`;
  const dLabel = `${documents_scanned} document${documents_scanned === 1 ? "" : "s"}`;
  const trunc = report.truncated ? " (findings truncated; counts exact)" : "";
  lines.push(
    `scanned ${vLabel} across ${dLabel}; ${by_severity.error} error, ${by_severity.warn} warn${trunc}`,
  );
  for (const s of report.checks_skipped) {
    lines.push(`skipped ${s.check}: ${s.reason}`);
  }
  return lines.join("\n");
}
