import type { Repo, User, Version } from "../kernel/wire.js";
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

export function renderUsersTable(users: User[]): string {
  if (users.length === 0) return "(no users)";
  return renderTable(
    ["USER"],
    users.map((u) => [u.user]),
  );
}

export function renderHistoryTable(versions: Version[]): string {
  if (versions.length === 0) return "(no history)";
  const rows = versions.map((v) => [
    v.version_id,
    v.created_at,
    v.author.user,
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
