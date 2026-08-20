/**
 * Target normalization — design §11.2 "Path resolution rules" (WS2 half).
 *
 * Turns a RawEdge's as-written target into:
 *   • target_raw   — the repo-root-relative path stored in the links table,
 *                    anchor preserved (this is what `links repair` compares
 *                    against and what dangling re-resolution keys on)
 *   • candidates   — ordered repo-root-relative *paths* (anchor stripped) to
 *                    try against the live path set; the first that resolves
 *                    to a document binds the edge (WS3)
 *
 * Paths are stored without a leading slash (e.g. "people/alice.md"), so
 * "repo-absolute" here means repo-root-relative in that same form. Binding
 * a candidate to a document id is WS3's job (resolve-against-live-paths);
 * this module is pure and has no storage dependency.
 *
 * External targets (a URI scheme like https:, or a bare fragment "#x")
 * produce no candidates — they never enter the graph (links are repo-local,
 * §11.2).
 */

import type { RawEdge } from "./extract.js";
import type { LinkConfig } from "./link-config.js";

export type NormalizedEdge = {
  ord: number;
  field: string;
  /** Repo-root-relative, anchor preserved. Stored as links.target_raw. */
  target_raw: string;
  /**
   * Ordered candidate paths (no anchor) to resolve against live paths.
   * Empty = external / unresolvable target (never binds, never dangles).
   */
  candidates: string[];
};

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Normalize one raw edge against its source document's path and the repo's
 * link config. `srcPath` is the repo-root-relative path of the document the
 * edge originates from (e.g. "moc/employees.md").
 */
export function normalizeTarget(
  edge: RawEdge,
  srcPath: string,
  config: LinkConfig,
): NormalizedEdge {
  const base = { ord: edge.ord, field: edge.field };

  // Split off the anchor. `preserve_anchors` keeps it on target_raw; the
  // path used for resolution never includes it.
  const hashIx = edge.target.indexOf("#");
  const hasAnchor = hashIx >= 0;
  const rawPath = hasAnchor ? edge.target.slice(0, hashIx) : edge.target;
  const anchor = hasAnchor ? edge.target.slice(hashIx) : "";
  const keepAnchor = config.resolution.preserve_anchors ? anchor : "";

  // A bare fragment ("#section") is a same-document link — no edge target.
  if (rawPath.length === 0) {
    return { ...base, target_raw: edge.target, candidates: [] };
  }

  // External URIs (https:, mailto:, etc.) are repo-external — dropped.
  if (SCHEME.test(rawPath)) {
    return { ...base, target_raw: edge.target, candidates: [] };
  }

  if (edge.wikilink) {
    return normalizeWikilink(base, rawPath, keepAnchor, config);
  }
  return normalizeCommonMark(base, rawPath, keepAnchor, srcPath);
}

/** Convenience: normalize a whole edge list for one source document. */
export function normalizeEdges(
  edges: readonly RawEdge[],
  srcPath: string,
  config: LinkConfig,
): NormalizedEdge[] {
  return edges.map((e) => normalizeTarget(e, srcPath, config));
}

// -----------------------------------------------------------------------------
// CommonMark: relative-to-source unless repo-absolute (leading '/').
// -----------------------------------------------------------------------------

function normalizeCommonMark(
  base: { ord: number; field: string },
  rawPath: string,
  anchor: string,
  srcPath: string,
): NormalizedEdge {
  const resolved = rawPath.startsWith("/")
    ? normalizeSegments(rawPath.slice(1).split("/"))
    : normalizeSegments([...dirSegments(srcPath), ...rawPath.split("/")]);
  // Unresolvable (escaped above repo root via too many "..") → no candidate.
  const candidates = resolved === null ? [] : [resolved];
  const target_raw = resolved === null ? rawPath + anchor : resolved + anchor;
  return { ...base, target_raw, candidates };
}

// -----------------------------------------------------------------------------
// Wikilinks: root-relative, with extension elision candidates.
// -----------------------------------------------------------------------------

function normalizeWikilink(
  base: { ord: number; field: string },
  rawPath: string,
  anchor: string,
  config: LinkConfig,
): NormalizedEdge {
  // Wikilinks are root-relative (Obsidian-style short links resolve from the
  // vault root), leading slash tolerated.
  const stripped = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath;
  const resolved = normalizeSegments(stripped.split("/"));
  if (resolved === null) {
    return { ...base, target_raw: rawPath + anchor, candidates: [] };
  }

  if (!config.resolution.wikilink_elision) {
    return { ...base, target_raw: resolved + anchor, candidates: [resolved] };
  }

  // Elision: [[foo]] → foo.md → foo/<index>.md. Only an explicit `.md`
  // suffix skips elision — every other bare name gets `.md` appended,
  // including dotted daily-note names like `2024.01.01` (→ 2024.01.01.md).
  // Deliberately NOT keyed on "contains a dot": that would strand daily
  // notes. A non-`.md` extension (e.g. `[[diagram.png]]`) therefore also
  // gets `.md` appended and simply dangles — mrplex documents are markdown
  // (§2), and non-document attachments are inert to the graph regardless.
  // target_raw records the primary (.md) candidate so `links repair` has a
  // canonical written form (§11.2 table).
  if (resolved.endsWith(".md")) {
    return { ...base, target_raw: resolved + anchor, candidates: [resolved] };
  }
  const dotMd = `${resolved}.md`;
  const indexMd = `${resolved}/${config.resolution.index_basename}.md`;
  return { ...base, target_raw: dotMd + anchor, candidates: [dotMd, indexMd] };
}

// -----------------------------------------------------------------------------
// Segment normalization — collapse '.', apply '..', reject repo-root escape.
// -----------------------------------------------------------------------------

function normalizeSegments(segments: string[]): string | null {
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null; // escaped above repo root
      out.pop();
      continue;
    }
    out.push(seg);
  }
  if (out.length === 0) return null;
  return out.join("/");
}

/** Directory segments of a repo-root-relative file path. */
function dirSegments(path: string): string[] {
  const segs = path.split("/");
  segs.pop(); // drop the filename
  return segs;
}
