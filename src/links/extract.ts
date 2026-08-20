/**
 * Deterministic link extraction — design §11.2 "Extraction" (WS2).
 *
 * A pure, total function of `(body, frontmatter, config)`: same input →
 * same edges, always. That determinism is what makes the derived index
 * rebuildable (backfill) and the write-path in-tx maintenance correct.
 *
 * Body edges come from a real CommonMark parse (micromark's event stream),
 * so "a link inside a fenced code block is not a link" and reference-link
 * resolution are correct by construction rather than by regex luck. The
 * `!` embed/transclusion prefix is NOT a distinct type (§1.1): `![x](p)`
 * and `![[p]]` yield the same edge their plain forms would — the renderer
 * inlines the target, the graph doesn't care.
 *
 * Wikilinks (`[[page]]`) aren't CommonMark, so they're scanned from the
 * raw text with the parser's code-span/fence ranges masked out. Frontmatter
 * reference fields (opt-in `link_config.fields`) contribute edges under the
 * declaring field path, honoring the terminal-fields rule (§11.2).
 *
 * Extraction emits RAW edges — the target exactly as written, plus a
 * `wikilink` flag. Turning a raw target into a repo-absolute path and a
 * set of resolution candidates is resolve.ts's job (WS2 normalizeTarget);
 * binding a candidate to a document identity is WS3.
 */

import { parse, postprocess, preprocess } from "micromark";
import type { FrontmatterJson } from "../markdown/frontmatter.js";
import type { LinkConfig } from "./link-config.js";

/** The `field` value for body-derived edges (§11.2 reserved sentinel). */
export const BODY_FIELD = "$body";

/**
 * One extracted edge, pre-resolution. `target` is verbatim as written
 * (anchor included); `wikilink` selects the resolution rules in resolve.ts
 * (root-relative + extension elision vs. CommonMark relative-to-source).
 *
 * `dest_span` is the [start, end) byte range of the *destination text* in
 * the body — the exact slice `mrplex links repair` rewrites. Present for
 * body edges whose destination sits at the link site (inline `[t](dest)`
 * and wikilink `[[dest]]`); absent for reference-style links (the
 * destination lives in a separate `[id]: dest` definition, repaired via its
 * own edge is out of scope) and for frontmatter edges.
 */
export type RawEdge = {
  ord: number;
  field: string; // BODY_FIELD or a CEL frontmatter field path
  target: string; // as written, e.g. "../horses.md", "foo#sec", "moc/employees.md"
  wikilink: boolean;
  dest_span?: { start: number; end: number };
};

export type ExtractInput = {
  body: string;
  frontmatter: FrontmatterJson;
  config: LinkConfig;
};

export function extractEdges(input: ExtractInput): RawEdge[] {
  const { body, frontmatter, config } = input;
  // Body edges first (document order), then frontmatter edges — a stable,
  // total order so `ord` is a deterministic identity for each edge.
  const bodyEdges = extractBodyEdges(body, config);
  const fmEdges = extractFrontmatterEdges(frontmatter, config);

  const out: RawEdge[] = [];
  let ord = 0;
  for (const e of bodyEdges) out.push({ ...e, ord: ord++ });
  for (const e of fmEdges) out.push({ ...e, ord: ord++ });
  return out;
}

// -----------------------------------------------------------------------------
// Body extraction — CommonMark via micromark, plus wikilink scan.
// -----------------------------------------------------------------------------

type BodyHit = {
  offset: number;
  target: string;
  wikilink: boolean;
  dest_span?: { start: number; end: number };
};

function extractBodyEdges(body: string, config: LinkConfig): Omit<RawEdge, "ord">[] {
  const hits: BodyHit[] = [];
  const codeRanges = collectCommonMark(body, config, hits);
  if (config.syntaxes.wikilink) {
    collectWikilinks(body, codeRanges, hits);
  }
  hits.sort((a, b) => a.offset - b.offset);
  return hits.map((h) => ({
    field: BODY_FIELD,
    target: h.target,
    wikilink: h.wikilink,
    ...(h.dest_span ? { dest_span: h.dest_span } : {}),
  }));
}

/**
 * Walk micromark's event stream. Collects link/image destinations (inline
 * + reference), and returns the [start, end) offset ranges of code spans
 * and fences so the wikilink scan can mask them out.
 */
function collectCommonMark(body: string, config: LinkConfig, hits: BodyHit[]): [number, number][] {
  const events = tokenize(body);
  const slice = (t: Token) => body.slice(t.start.offset, t.end.offset);

  // Pass 1: build the label → definition map from link/image definitions.
  // We keep the destination's byte-span too so reference-style links can be
  // rewritten (repair edits the shared `[id]: dest` definition, §11.2).
  const definitions = new Map<string, Definition>();
  for (const [kind, token] of events) {
    if (kind !== "enter") continue;
    if (token.type === "definition") {
      const label = childValue(events, body, token, "definitionLabelString");
      const destTok = childToken(events, token, "definitionDestinationString");
      if (label !== undefined && destTok !== undefined) {
        const key = normalizeLabel(label);
        if (!definitions.has(key)) {
          definitions.set(key, {
            dest: body.slice(destTok.start.offset, destTok.end.offset),
            span: { start: destTok.start.offset, end: destTok.end.offset },
          });
        }
      }
    }
  }

  // Pass 2: link/image nodes via a stack (handles image-in-link nesting).
  const codeRanges: [number, number][] = [];
  const stack: Frame[] = [];
  for (const [kind, token] of events) {
    const T = token.type;
    if (kind === "enter") {
      if (T === "codeText" || T === "codeFenced" || T === "codeIndented") {
        codeRanges.push([token.start.offset, token.end.offset]);
      } else if (T === "link" || T === "image") {
        stack.push({ isImage: T === "image", start: token.start.offset, label: "" });
      } else if (T === "labelText") {
        const top = stack[stack.length - 1];
        if (top && top.dest === undefined && top.refKey === undefined) top.label += slice(token);
      } else if (T === "resourceDestinationString") {
        const top = stack[stack.length - 1];
        if (top) {
          top.dest = slice(token);
          top.destSpan = { start: token.start.offset, end: token.end.offset };
        }
      } else if (T === "referenceString") {
        const top = stack[stack.length - 1];
        if (top) top.refKey = normalizeLabel(slice(token));
      }
    } else if (kind === "exit" && (T === "link" || T === "image")) {
      const frame = stack.pop();
      if (!frame) continue;
      const resolved = resolveDestination(frame, definitions);
      if (resolved !== undefined && resolved.dest.length > 0 && syntaxEnabled(frame, config)) {
        // Rewritable destination span: inline links carry their own; a
        // reference link points at its shared `[id]: dest` definition span
        // (so repairing it edits the definition once).
        const span = frame.destSpan ?? resolved.span;
        hits.push({
          offset: frame.start,
          target: resolved.dest,
          wikilink: false,
          ...(span ? { dest_span: span } : {}),
        });
      }
    }
  }
  return codeRanges;
}

type Frame = {
  isImage: boolean;
  start: number;
  label: string;
  dest?: string; // inline resource destination
  destSpan?: { start: number; end: number }; // [start,end) of the inline dest text
  refKey?: string; // full/collapsed reference key (normalized)
};

/**
 * A frame is inline if it has a resource destination; otherwise it's a
 * reference (full → refKey, collapsed/shortcut → label). Whether the base
 * CommonMark syntax is enabled is decided by `syntaxEnabled`.
 */
type Definition = { dest: string; span: { start: number; end: number } };
type ResolvedDest = { dest: string; span?: { start: number; end: number } };

function resolveDestination(
  frame: Frame,
  definitions: Map<string, Definition>,
): ResolvedDest | undefined {
  if (frame.dest !== undefined) return { dest: frame.dest, span: frame.destSpan };
  const key = frame.refKey && frame.refKey.length > 0 ? frame.refKey : normalizeLabel(frame.label);
  const def = definitions.get(key);
  return def ? { dest: def.dest, span: def.span } : undefined;
}

function syntaxEnabled(frame: Frame, config: LinkConfig): boolean {
  // Inline resource → `syntaxes.inline`; reference/shortcut → `syntaxes.reference`.
  // The `!` embed prefix rides its base syntax's toggle (§1.1), so images
  // are governed by inline/reference exactly like their non-image forms.
  return frame.dest !== undefined ? config.syntaxes.inline : config.syntaxes.reference;
}

/** CommonMark label normalization: trim, collapse internal whitespace, casefold. */
function normalizeLabel(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

// -----------------------------------------------------------------------------
// Wikilinks — [[page]], [[page|display]], ![[page]] (embed, cosmetic prefix).
// -----------------------------------------------------------------------------

// Fresh pattern per call via matchAll — no shared `/g` lastIndex state to
// reset (avoids a footgun if extraction ever runs re-entrantly / in a worker).
const WIKILINK = () => /!?\[\[([^\]\n]+?)\]\]/g;

function collectWikilinks(body: string, codeRanges: [number, number][], hits: BodyHit[]): void {
  for (const m of body.matchAll(WIKILINK())) {
    const offset = m.index;
    if (inAnyRange(offset, codeRanges)) continue;
    const full = m[0] as string;
    const inner = m[1] as string;
    // Display half after '|' is cosmetic; the target is the page half.
    const pageRaw = inner.split("|")[0] as string;
    const target = pageRaw.trim();
    if (target.length === 0) continue;
    // Span of the trimmed page-half within the body: the inner content
    // starts after the `!?[[` prefix; the trimmed target sits at
    // pageRaw's leading-whitespace offset within that.
    const innerStart = offset + full.indexOf(inner);
    const lead = pageRaw.length - pageRaw.trimStart().length;
    const start = innerStart + lead;
    hits.push({
      offset,
      target,
      wikilink: true,
      dest_span: { start, end: start + target.length },
    });
  }
}

function inAnyRange(offset: number, ranges: [number, number][]): boolean {
  for (const [start, end] of ranges) {
    if (offset >= start && offset < end) return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Frontmatter reference fields (opt-in) — §11.2 "Field paths".
// -----------------------------------------------------------------------------

function extractFrontmatterEdges(
  frontmatter: FrontmatterJson,
  config: LinkConfig,
): Omit<RawEdge, "ord">[] {
  if (config.fields.length === 0) return [];
  const out: Omit<RawEdge, "ord">[] = [];
  for (const field of config.fields) {
    const segments = splitFieldPath(field);
    for (const value of collectTerminalStrings(frontmatter, segments)) {
      out.push({ field, target: value, wikilink: false });
    }
  }
  return out;
}

/**
 * Resolve a CEL field path against the frontmatter JSON, collecting
 * terminal string values in document order. Terminal-fields rule (§11.2):
 * only strings (and lists of strings) extract — a non-terminal path on a
 * list-of-objects yields nothing. Arrays are traversed polymorphically
 * (§5.2 list() convention): the remaining path applies to each element.
 */
function collectTerminalStrings(node: unknown, segments: string[]): string[] {
  if (segments.length === 0) {
    if (typeof node === "string") return [node];
    if (Array.isArray(node)) return node.filter((x): x is string => typeof x === "string");
    return []; // object / number / null / undefined → not a terminal
  }
  if (Array.isArray(node)) {
    // Polymorphic: apply the SAME remaining path to each element.
    return node.flatMap((el) => collectTerminalStrings(el, segments));
  }
  if (node !== null && typeof node === "object") {
    const [seg, ...rest] = segments;
    return collectTerminalStrings((node as Record<string, unknown>)[seg as string], rest);
  }
  return [];
}

/**
 * Split a CEL field path into segments. Dot-separated identifiers plus
 * bracket-quoted segments (`owners["team-lead"]`). The path grammar is
 * validated by link-config.validateConfig; this splitter assumes a
 * well-formed path.
 */
function splitFieldPath(path: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < path.length) {
    if (path[i] === ".") {
      i++;
      continue;
    }
    if (path[i] === "[") {
      // ["quoted"] — read to the matching "].
      const close = path.indexOf('"]', i);
      const inner = path.slice(i + 2, close);
      out.push(inner.replace(/\\(.)/g, "$1"));
      i = close + 2;
      continue;
    }
    let j = i;
    while (j < path.length && path[j] !== "." && path[j] !== "[") j++;
    out.push(path.slice(i, j));
    i = j;
  }
  return out;
}

// -----------------------------------------------------------------------------
// micromark event plumbing.
// -----------------------------------------------------------------------------

type Point = { offset: number };
type Token = { type: string; start: Point; end: Point };
type Event = [kind: "enter" | "exit", token: Token];

function tokenize(md: string): Event[] {
  const p = parse();
  return postprocess(p.document().write(preprocess()(md, "utf8", true))) as unknown as Event[];
}

/**
 * Find the first child token of `type` enclosed by `parent`'s offset range
 * and return its source slice. Used to read a definition's label and
 * destination without a full sub-walk.
 */
function childValue(
  events: Event[],
  body: string,
  parent: Token,
  type: string,
): string | undefined {
  const tok = childToken(events, parent, type);
  return tok ? body.slice(tok.start.offset, tok.end.offset) : undefined;
}

/** Like childValue, but returns the token (so callers can read its span). */
function childToken(events: Event[], parent: Token, type: string): Token | undefined {
  for (const [kind, token] of events) {
    if (kind !== "enter") continue;
    if (
      token.type === type &&
      token.start.offset >= parent.start.offset &&
      token.end.offset <= parent.end.offset
    ) {
      return token;
    }
  }
  return undefined;
}
