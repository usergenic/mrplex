/**
 * Deterministic link extraction — design §11.2 "Extraction" (WS2).
 *
 * Body and frontmatter string values each honor their own LinkSyntaxes profile.
 * Frontmatter links are discovered by walking all scalar string values — no
 * per-field opt-in list.
 */

import { parse, postprocess, preprocess } from "micromark";
import type { FrontmatterJson } from "../markdown/frontmatter.js";
import type { LinkConfig, LinkSyntaxes } from "./link-config.js";

/** The `field` value for body-derived edges (§11.2 reserved sentinel). */
export const BODY_FIELD = "$body";

/** Repo-root absolute path ending in `.md` — whole frontmatter value form. */
export const FRONTMATTER_FULLPATH_WHOLE = /^\/[^\s#]+\.md(?:#.*)?$/;

/** Inline repo-root `/…/*.md` paths in prose (body scan). Requires `/` at a token boundary. */
const BODY_FULLPATH = /(?:^|[\s(\["'`<>])(\/[^\s\])"'`<>]+\.md(?:#[^\s\])"'`<>]*)?)/g;

export type RawEdge = {
  ord: number;
  field: string;
  target: string;
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
  const bodyEdges = extractBodyEdges(body, config.body);
  const fmEdges = extractFrontmatterEdges(frontmatter, config.frontmatter);

  const out: RawEdge[] = [];
  let ord = 0;
  for (const e of bodyEdges) out.push({ ...e, ord: ord++ });
  for (const e of fmEdges) out.push({ ...e, ord: ord++ });
  return out;
}

// -----------------------------------------------------------------------------
// Body extraction
// -----------------------------------------------------------------------------

type TextHit = {
  offset: number;
  target: string;
  wikilink: boolean;
  dest_span?: { start: number; end: number };
};

function extractBodyEdges(body: string, syntaxes: LinkSyntaxes): Omit<RawEdge, "ord">[] {
  const hits: TextHit[] = [];
  const codeRanges = collectCommonMark(body, syntaxes, hits);
  if (syntaxes.wikilink) collectWikilinks(body, codeRanges, hits);
  if (syntaxes.fullpath) collectBodyFullpaths(body, codeRanges, hits);
  hits.sort((a, b) => a.offset - b.offset);
  return hits.map((h) => ({
    field: BODY_FIELD,
    target: h.target,
    wikilink: h.wikilink,
    ...(h.dest_span ? { dest_span: h.dest_span } : {}),
  }));
}

function collectBodyFullpaths(body: string, codeRanges: [number, number][], hits: TextHit[]): void {
  for (const m of body.matchAll(BODY_FULLPATH)) {
    const target = m[1] as string;
    const offset = (m.index ?? 0) + m[0].length - target.length;
    if (inAnyRange(offset, codeRanges)) continue;
    hits.push({
      offset,
      target,
      wikilink: false,
      dest_span: { start: offset, end: offset + target.length },
    });
  }
}

// -----------------------------------------------------------------------------
// Frontmatter extraction — walk all string values.
// -----------------------------------------------------------------------------

function extractFrontmatterEdges(
  frontmatter: FrontmatterJson,
  syntaxes: LinkSyntaxes,
): Omit<RawEdge, "ord">[] {
  const out: Omit<RawEdge, "ord">[] = [];
  walkFrontmatterStrings(frontmatter, [], (field, value) => {
    for (const hit of extractFromFrontmatterString(value, syntaxes)) {
      out.push({ field, target: hit.target, wikilink: hit.wikilink });
    }
  });
  return out;
}

function walkFrontmatterStrings(
  node: unknown,
  path: string[],
  visit: (fieldPath: string, value: string) => void,
): void {
  if (typeof node === "string") {
    visit(path.join("."), node);
    return;
  }
  if (Array.isArray(node)) {
    for (const el of node) walkFrontmatterStrings(el, path, visit);
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      walkFrontmatterStrings(val, [...path, key], visit);
    }
  }
}

function extractFromFrontmatterString(value: string, syntaxes: LinkSyntaxes): TextHit[] {
  const hits: TextHit[] = [];

  if (syntaxes.fullpath) {
    const trimmed = value.trim();
    if (FRONTMATTER_FULLPATH_WHOLE.test(trimmed)) {
      hits.push({ offset: 0, target: trimmed, wikilink: false });
      return hits;
    }
  }

  const codeRanges = collectCommonMark(value, syntaxes, hits);
  if (syntaxes.wikilink) collectWikilinks(value, codeRanges, hits);
  hits.sort((a, b) => a.offset - b.offset);
  return hits;
}

// -----------------------------------------------------------------------------
// CommonMark + wikilinks (shared by body and frontmatter strings)
// -----------------------------------------------------------------------------

function collectCommonMark(text: string, syntaxes: LinkSyntaxes, hits: TextHit[]): [number, number][] {
  const events = tokenize(text);
  const slice = (t: Token) => text.slice(t.start.offset, t.end.offset);

  const definitions = new Map<string, Definition>();
  for (const [kind, token] of events) {
    if (kind !== "enter") continue;
    if (token.type === "definition") {
      const label = childValue(events, text, token, "definitionLabelString");
      const destTok = childToken(events, token, "definitionDestinationString");
      if (label !== undefined && destTok !== undefined) {
        const key = normalizeLabel(label);
        if (!definitions.has(key)) {
          definitions.set(key, {
            dest: text.slice(destTok.start.offset, destTok.end.offset),
            span: { start: destTok.start.offset, end: destTok.end.offset },
          });
        }
      }
    }
  }

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
      if (resolved !== undefined && resolved.dest.length > 0 && syntaxEnabled(frame, syntaxes)) {
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
  dest?: string;
  destSpan?: { start: number; end: number };
  refKey?: string;
};

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

function syntaxEnabled(frame: Frame, syntaxes: LinkSyntaxes): boolean {
  return frame.dest !== undefined ? syntaxes.inline : syntaxes.reference;
}

function normalizeLabel(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

const WIKILINK = () => /!?\[\[([^\]\n]+?)\]\]/g;

function collectWikilinks(text: string, codeRanges: [number, number][], hits: TextHit[]): void {
  for (const m of text.matchAll(WIKILINK())) {
    const offset = m.index ?? 0;
    if (inAnyRange(offset, codeRanges)) continue;
    const full = m[0] as string;
    const inner = m[1] as string;
    const pageRaw = inner.split("|")[0] as string;
    const target = pageRaw.trim();
    if (target.length === 0) continue;
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

type Point = { offset: number };
type Token = { type: string; start: Point; end: Point };
type Event = [kind: "enter" | "exit", token: Token];

function tokenize(md: string): Event[] {
  const p = parse();
  return postprocess(p.document().write(preprocess()(md, "utf8", true))) as unknown as Event[];
}

function childValue(
  events: Event[],
  body: string,
  parent: Token,
  type: string,
): string | undefined {
  const tok = childToken(events, parent, type);
  return tok ? body.slice(tok.start.offset, tok.end.offset) : undefined;
}

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
