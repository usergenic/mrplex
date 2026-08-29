/**
 * Slug + path segment validation — the write-time gate.
 *
 * Design §3.5.1 pins the structural constants (grammar, not policy):
 *   PATH_SEPARATOR = "/", CURRENT_SEGMENT = ".", PARENT_SEGMENT = "..",
 *   EMPTY_SEGMENT  = ""
 *
 * Design §3.5.2 defines the configurable policy layered per repo:
 *   disallowed_chars: single chars forbidden anywhere in a user segment
 *   system_sigils:    leading string prefixes marking kernel-owned segments
 *   hidden_sigils:    leading string prefixes marking user-hidden segments
 *
 * Design §3.5.3 says validation is write-time only — existing rows keep
 * whatever paths they had. §3.5.6 says slugs use the SERVER-level config
 * (per-repo config doesn't gate slug validation).
 */

import { KernelError } from "./errors.js";

// -----------------------------------------------------------------------------
// Structural constants (§3.5.1) — grammar, not policy.
// -----------------------------------------------------------------------------

export const PATH_SEPARATOR = "/";
export const CURRENT_SEGMENT = ".";
export const PARENT_SEGMENT = "..";
export const EMPTY_SEGMENT = "";

// Slug hygiene — pinned in m1-plan §5.
export const SLUG_MAX_LENGTH = 64;

// -----------------------------------------------------------------------------
// Effective config shape (populated by WS2's path-config layering).
// -----------------------------------------------------------------------------

export type EffectivePathConfig = {
  disallowed_chars: string[]; // single chars, verified at startup
  system_sigils: string[]; // non-empty strings; sigils[0] is canonical
  hidden_sigils: string[]; // non-empty strings; sigils[0] is canonical
};

// -----------------------------------------------------------------------------
// Errors.
// -----------------------------------------------------------------------------

type SlugInvalidData = { slug: string; reason: string };
type PathInvalidData = { path: string; segment: string; reason: string };

const slugInvalid = (slug: string, reason: string) =>
  new KernelError<SlugInvalidData>("slug_invalid", { slug, reason });

const pathInvalid = (path: string, segment: string, reason: string) =>
  new KernelError<PathInvalidData>("path_invalid", { path, segment, reason });

// -----------------------------------------------------------------------------
// Segment-level predicates (shared by slug and path validators).
// -----------------------------------------------------------------------------

function isReservedSegment(segment: string): boolean {
  return segment === EMPTY_SEGMENT || segment === CURRENT_SEGMENT || segment === PARENT_SEGMENT;
}

function containsDisallowedChar(segment: string, disallowed: readonly string[]): string | null {
  for (const ch of disallowed) {
    if (segment.includes(ch)) return ch;
  }
  return null;
}

function startsWithAnySigil(segment: string, sigils: readonly string[]): string | null {
  for (const sigil of sigils) {
    if (segment.startsWith(sigil)) return sigil;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Exact document path normalization (canonical-path-normalization plan).
// -----------------------------------------------------------------------------

/** True when `path` is a glob/pattern operand (not an exact document path). */
export function isPathGlobPattern(path: string): boolean {
  return path.includes("*") || path.includes("?");
}

/**
 * Normalize an exact document path for API lookup and writes. Accepts a
 * canonical slashless path unchanged, or exactly one leading `/` as a
 * repository-root reference alias (Markdown-style). Returns the slashless
 * canonical form after applying `validatePath`. Failure → `path_invalid`.
 *
 * Idempotent: `normalizeExactDocumentPath(normalizeExactDocumentPath(p))`
 * equals `normalizeExactDocumentPath(p)`.
 *
 * Do not use for glob operands, CEL `$path` literals, or stored link text —
 * those keep their own semantics.
 */
export function normalizeExactDocumentPath(
  input: string,
  config: EffectivePathConfig,
): string {
  if (input.includes("\\")) {
    throw pathInvalid(input, "", "path contains backslash");
  }

  let path = input;
  if (path.startsWith(PATH_SEPARATOR)) {
    if (path === PATH_SEPARATOR) {
      throw pathInvalid(path, "", "path is empty");
    }
    if (path.length > 1 && path[1] === PATH_SEPARATOR) {
      throw pathInvalid(path, "", "path has multiple leading '/'");
    }
    path = path.slice(1);
  }

  validatePath(path, config);
  return path;
}

// -----------------------------------------------------------------------------
// Path validation (§3.5.3).
// -----------------------------------------------------------------------------

/**
 * Validate every segment of a canonical (slashless) user-written path.
 * Applied at `docs.create` and `docs.put` (design §3.5.3) after exact-path
 * alias normalization. Failure → `path_invalid`.
 *
 * The kernel bypasses these checks for its own deletion moves (§4.1 rule 4);
 * that bypass lives in the write surface, not here.
 */
export function validatePath(path: string, config: EffectivePathConfig): void {
  if (path === EMPTY_SEGMENT) {
    throw pathInvalid(path, "", "path is empty");
  }
  if (path.startsWith(PATH_SEPARATOR)) {
    throw pathInvalid(path, "", "path has a leading '/'");
  }
  if (path.endsWith(PATH_SEPARATOR)) {
    throw pathInvalid(path, "", "path has a trailing '/'");
  }
  const segments = path.split(PATH_SEPARATOR);
  for (const segment of segments) {
    if (isReservedSegment(segment)) {
      throw pathInvalid(path, segment, `segment is reserved ("${segment}")`);
    }
    const sysSigil = startsWithAnySigil(segment, config.system_sigils);
    if (sysSigil !== null) {
      throw pathInvalid(
        path,
        segment,
        `segment starts with system sigil "${sysSigil}" — reserved for the kernel`,
      );
    }
    const bad = containsDisallowedChar(segment, config.disallowed_chars);
    if (bad !== null) {
      throw pathInvalid(path, segment, `segment contains disallowed character "${bad}"`);
    }
  }
}

// -----------------------------------------------------------------------------
// Slug validation (§3.5.6) — server-config only, single segment, no '/'.
// -----------------------------------------------------------------------------

/**
 * Validate a repo or user slug against server-level path config (§3.5.6).
 * Per-repo config doesn't apply: slug is validated before any repo has a
 * chance to override, and users are global.
 *
 * Slug hygiene numbers are pinned by m1-plan §5: ≤ 64 chars, no leading/
 * trailing whitespace, no control chars.
 */
export function validateSlug(slug: string, config: EffectivePathConfig): void {
  if (isReservedSegment(slug)) {
    throw slugInvalid(slug, `slug is reserved ("${slug}")`);
  }
  if (slug.length > SLUG_MAX_LENGTH) {
    throw slugInvalid(slug, `slug exceeds ${SLUG_MAX_LENGTH} characters`);
  }
  if (slug !== slug.trim()) {
    throw slugInvalid(slug, "slug has leading or trailing whitespace");
  }
  if (slug.includes(PATH_SEPARATOR)) {
    throw slugInvalid(slug, "slug contains '/'");
  }
  // Control chars (0x00–0x1F, 0x7F) are always illegal — they don't need to
  // be in disallowed_chars to be forbidden.
  for (const ch of slug) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      throw slugInvalid(slug, "slug contains a control character");
    }
  }
  const sysSigil = startsWithAnySigil(slug, config.system_sigils);
  if (sysSigil !== null) {
    throw slugInvalid(slug, `slug starts with system sigil "${sysSigil}"`);
  }
  const hidSigil = startsWithAnySigil(slug, config.hidden_sigils);
  if (hidSigil !== null) {
    throw slugInvalid(slug, `slug starts with hidden sigil "${hidSigil}"`);
  }
  const bad = containsDisallowedChar(slug, config.disallowed_chars);
  if (bad !== null) {
    throw slugInvalid(slug, `slug contains disallowed character "${bad}"`);
  }
}

// -----------------------------------------------------------------------------
// Sigil classification helpers (used by both writes and query default exclusion).
// -----------------------------------------------------------------------------

/**
 * True if any segment of `path` starts with any of the given sigils.
 * Design §5.1 uses this to compile the default-exclude clause.
 */
export function pathHasSigilSegment(path: string, sigils: readonly string[]): boolean {
  if (sigils.length === 0) return false;
  const segments = path.split(PATH_SEPARATOR);
  for (const segment of segments) {
    if (startsWithAnySigil(segment, sigils) !== null) return true;
  }
  return false;
}
