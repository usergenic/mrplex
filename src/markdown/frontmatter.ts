/**
 * Split, parse, and join Markdown files with YAML frontmatter.
 *
 * The design (§3.2) stores frontmatter twice: `frontmatter_raw` (byte-verbatim
 * YAML source) and `frontmatter` (parsed JSON, a derived query index). The
 * utilities here are the source of truth for that split/join contract.
 *
 * The delimiter grammar we recognize is deliberately narrow and LF-based:
 *
 *   ---LF
 *   <raw YAML>
 *   ---LF
 *   <body>
 *
 * That is, a file has frontmatter iff it starts with the literal `---\n` AND a
 * subsequent line consisting of exactly `---\n` (or `---` at EOF). Files that
 * don't match are treated as pure body, with `frontmatter_raw = ""`. Round-trip
 * (`join(split(x)) === x`) holds exactly for the canonical form; a
 * present-but-empty frontmatter (`---\n---\n<body>`) collapses to no-frontmatter
 * (semantically equivalent — `parse("") === {}`).
 */

import { parse as parseYaml } from "yaml";
import { INTRINSIC_SIGIL } from "../kernel/constants.js";

const DELIM = "---";
const DELIM_LINE = `${DELIM}\n`;

/**
 * Match a line that starts with a system-property key: `<sigil>identifier:`
 * at column 0, followed by a colon. Kept intentionally strict — only
 * top-level scalar keys are treated as system props, so nested `$foo:`
 * inside a map body (which would start with whitespace) is untouched.
 */
const SYSTEM_PROP_LINE = new RegExp(
  `^${escapeRegex(INTRINSIC_SIGIL)}([A-Za-z_][A-Za-z0-9_]*):[^\\n]*(?:\\n|$)`,
  "gm",
);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type Split = { frontmatter_raw: string; body: string };

/**
 * Split a raw Markdown file into `{ frontmatter_raw, body }`. No parsing yet —
 * `frontmatter_raw` is the exact YAML source between the delimiters.
 */
export function split(text: string): Split {
  if (!text.startsWith(DELIM_LINE)) {
    return { frontmatter_raw: "", body: text };
  }
  const bodyStartMarker = `\n${DELIM_LINE}`;
  // Search from position (DELIM_LINE.length - 1) — the \n of the opening
  // delimiter's terminator — so the immediately-adjacent form `---\n---\n<body>`
  // (empty frontmatter, closing delim right after opening) is recognized.
  // Starting one character later would skip the `\n---\n` sequence.
  const idx = text.indexOf(bodyStartMarker, DELIM_LINE.length - 1);
  if (idx === -1) {
    // The trailing `---` at EOF (no final newline) also closes the block.
    if (text.endsWith(`\n${DELIM}`)) {
      const closingStart = text.length - DELIM.length - 1;
      return {
        frontmatter_raw: text.slice(DELIM_LINE.length, closingStart + 1),
        body: "",
      };
    }
    return { frontmatter_raw: "", body: text };
  }
  return {
    frontmatter_raw: text.slice(DELIM_LINE.length, idx + 1),
    body: text.slice(idx + bodyStartMarker.length),
  };
}

/**
 * Join back to the canonical file form. Inverse of `split` for canonical inputs.
 */
export function join(parts: Split): string {
  if (parts.frontmatter_raw === "") return parts.body;
  const raw = parts.frontmatter_raw.endsWith("\n")
    ? parts.frontmatter_raw
    : `${parts.frontmatter_raw}\n`;
  return `${DELIM_LINE}${raw}${DELIM_LINE}${parts.body}`;
}

/** Value stored in `versions.frontmatter` — parsed frontmatter as JSON. */
export type FrontmatterJson = Record<string, unknown>;

export class FrontmatterInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrontmatterInvalidError";
  }
}

/**
 * Parse the raw YAML source into a JSON object. Empty raw → `{}`. Anything that
 * doesn't parse to a plain map throws `FrontmatterInvalidError` (surfaced as
 * kernel error `frontmatter_invalid` in M1 writes, per design §4.3).
 */
export function parse(frontmatterRaw: string): FrontmatterJson {
  if (frontmatterRaw === "") return {};
  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatterRaw);
  } catch (err) {
    throw new FrontmatterInvalidError(`YAML parse error: ${(err as Error).message}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new FrontmatterInvalidError("frontmatter must parse to a map");
  }
  return parsed as FrontmatterJson;
}

/**
 * Append a system property (`$key: value`) as a plain text line to raw YAML
 * source. Non-destructive — never round-trips through the YAML parser, so
 * existing comments, key order, and whitespace are preserved byte-exact.
 *
 * `value` must be a simple scalar (string / number / boolean). Strings are
 * emitted unquoted; callers are responsible for supplying values that are
 * safe as bare YAML scalars (all current system props — version ids, ISO
 * timestamps, user slugs — satisfy this).
 */
export function appendSystemProperty(
  frontmatterRaw: string,
  key: string,
  value: string | number | boolean,
): string {
  const line = `${INTRINSIC_SIGIL}${key}: ${value}\n`;
  if (frontmatterRaw === "") return line;
  const base = frontmatterRaw.endsWith("\n") ? frontmatterRaw : `${frontmatterRaw}\n`;
  return `${base}${line}`;
}

/**
 * Strip every `$key: value` line from raw YAML source and return the parsed
 * key→value map alongside the cleaned source. Non-destructive on the
 * remainder — only the matched lines are removed, everything else stays
 * byte-exact.
 *
 * Values are returned as trimmed strings (leading/trailing whitespace after
 * the colon removed). Callers coerce as needed.
 */
export function extractSystemProperties(frontmatterRaw: string): {
  raw: string;
  props: Record<string, string>;
} {
  if (frontmatterRaw === "" || !frontmatterRaw.includes(INTRINSIC_SIGIL)) {
    return { raw: frontmatterRaw, props: {} };
  }
  const props: Record<string, string> = {};
  const cleaned = frontmatterRaw.replace(SYSTEM_PROP_LINE, (line, key: string) => {
    const colonIdx = line.indexOf(":");
    const value = line
      .slice(colonIdx + 1)
      .replace(/\n$/, "")
      .trim();
    props[key] = value;
    return "";
  });
  return { raw: cleaned, props };
}
