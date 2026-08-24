import type { GraphResult, QueryHit, Repo, Version } from "../kernel/wire.js";
import { join as joinFrontmatter } from "../markdown/frontmatter.js";

/**
 * Pretty-printers for CLI output. `--json` bypasses these entirely.
 */

export function renderVersionAsMarkdown(v: Version): string {
  return joinFrontmatter({ frontmatter_raw: v.frontmatter_raw, body: v.body });
}

export function renderReposTable(repos: Repo[]): string {
  if (repos.length === 0) return "(no repos)";
  const rows = repos.map((r) => [r.repo, r.path_config ? "custom" : "default"]);
  return renderTable(["REPO", "PATH CONFIG"], rows);
}

export function renderQueryTable(hits: QueryHit[]): string {
  if (hits.length === 0) return "(no results)";
  // Columns are the union of projected keys, in first-seen order across hits —
  // `select` decides which fields are present, so the table follows suit.
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    for (const key of Object.keys(hit)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  const rows = hits.map((hit) => columns.map((key) => renderCell(hit[key])));
  return renderTable(columns, rows);
}

function renderCell(value: unknown): string {
  // A key absent from this hit (not selected, or missing frontmatter) is an
  // empty cell; a present-but-null intrinsic (e.g. $next_version_id on the
  // current version) renders as "null" to match the MCP text renderer.
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function renderHistoryTable(versions: Version[]): string {
  if (versions.length === 0) return "(no history)";
  const rows = versions.map((v) => [
    v.version_id,
    v.created_at,
    v.author,
    v.next_version_id === null ? "current" : "",
  ]);
  return renderTable(["VERSION", "CREATED_AT", "AUTHOR", "STATE"], rows);
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [
    line(headers),
    line(headers.map((_, i) => "-".repeat(widths[i] ?? 0))),
    ...rows.map(line),
  ].join("\n");
}

// -----------------------------------------------------------------------------
// Graph renders (docs/graph-plan.md §2.3). CLI-only presentations of the
// structured GraphResult; the `summary` render is shared with the MCP text
// half (mcp/render.ts renderGraphSummary). These are pure functions of the
// result — presentation is a surface concern, never a call parameter.
// -----------------------------------------------------------------------------

/**
 * YAML dump of the structured payload — a better *reading* format than JSON
 * for a human or LLM skimming a subgraph. Hand-rolled (the shape is flat and
 * known) rather than pulling in a YAML serializer.
 */
export function renderGraphYaml(result: GraphResult): string {
  const lines: string[] = [];
  lines.push("documents:");
  if (result.documents.length === 0) lines.push("  []");
  for (const doc of result.documents) {
    lines.push(`  - $path: ${yamlScalar(doc.$path)}`);
    lines.push(`    $degrees: ${doc.$degrees}`);
    lines.push(`    $links: ${doc.$links}`);
    lines.push(`    $backlinks: ${doc.$backlinks}`);
    for (const [key, value] of Object.entries(doc)) {
      if (key === "$path" || key === "$degrees" || key === "$links" || key === "$backlinks") {
        continue;
      }
      lines.push(`    ${key}: ${yamlScalar(value)}`);
    }
  }
  lines.push("links:");
  if (result.links.length === 0) lines.push("  []");
  for (const l of result.links) {
    lines.push(`  - source: ${yamlScalar(l.source)}`);
    lines.push(`    target: ${yamlScalar(l.target)}`);
    lines.push(`    field: ${yamlScalar(l.field)}`);
  }
  lines.push(`frontier: [${result.frontier.map(yamlScalar).join(", ")}]`);
  lines.push(`complete_degrees: ${result.complete_degrees}`);
  lines.push(`truncated: ${result.truncated}`);
  return lines.join("\n");
}

/** Quote a scalar for YAML when it isn't a safe bare token. */
function yamlScalar(v: unknown): string {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  if (s === "" || /[:#\-?\[\]{},&*!|>'"%@`]/.test(s) || /^\s|\s$/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

/**
 * Mermaid flowchart — passthrough-renderable by most chat/markdown surfaces.
 * The id-sanitization rule is load-bearing: generated ids (`d0`, `d1`, …) with
 * the path only ever as a quoted label — a path as a mermaid id would break on
 * slashes, dots, and colons. Roots (degrees 0) get a classDef; a trailing `%%`
 * comment echoes truncation.
 */
export function renderGraphMermaid(result: GraphResult): string {
  const lines: string[] = ["flowchart LR"];
  const idByPath = new Map<string, string>();
  result.documents.forEach((doc, i) => {
    const id = `d${i}`;
    idByPath.set(doc.$path, id);
    const rootClass = doc.$degrees === 0 ? ":::root" : "";
    lines.push(`  ${id}[${JSON.stringify(doc.$path)}]${rootClass}`);
  });
  for (const l of result.links) {
    const s = idByPath.get(l.source);
    const t = idByPath.get(l.target);
    if (s === undefined || t === undefined) continue;
    lines.push(`  ${s} -->|${JSON.stringify(l.field)}| ${t}`);
  }
  if (result.documents.some((d) => d.$degrees === 0)) {
    lines.push("  classDef root stroke-width:3px");
  }
  const note = `complete through ${result.complete_degrees} degree${
    result.complete_degrees === 1 ? "" : "s"
  }${result.truncated ? " · truncated" : ""}`;
  lines.push(`  %% ${note}`);
  return lines.join("\n");
}
