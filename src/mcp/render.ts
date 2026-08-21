/**
 * Human-text rendering of kernel results for MCP tool `content`. The
 * structuredContent carries the wire object verbatim; this is the
 * best-effort text shape an agent (or a debug console) would want to see
 * alongside.
 *
 * Kept intentionally small — the CLI's pretty-printers already speak to
 * humans; the MCP text rendering just has to be *readable*, not pretty.
 */

import type { Repo, Version } from "../kernel/wire.js";

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
