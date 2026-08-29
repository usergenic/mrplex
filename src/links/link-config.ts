/**
 * Link config layering — design §11.2 (Phase 1, links-plan.md §1.2).
 *
 *   HARDCODED_DEFAULTS  → server config  → per-repo override
 *      (in code)          (operator)       (repos.link_config JSON)
 *
 * Body and frontmatter each declare which link *syntaxes* are recognized in
 * that region. Frontmatter string values are scanned automatically — no
 * per-field opt-in list.
 */

import { KernelError } from "../kernel/errors.js";

// -----------------------------------------------------------------------------
// The three tiers.
// -----------------------------------------------------------------------------

/**
 * Which link syntaxes extraction recognizes. Each is a boolean knob; the
 * `!` embed/transclusion prefix is NOT a syntax — it's a rendering hint
 * captured as an ordinary edge from its base syntax (§1.1).
 *
 * `fullpath` matches repo-root paths written as `/dir/doc.md` (optional
 * `#anchor`). In the document body, matches may appear inline in prose; in
 * frontmatter, only a string value that *is* such a path (after trim) counts.
 */
export type LinkSyntaxes = {
  inline: boolean; // [text](path)
  reference: boolean; // [text][id] + [id]: path
  autolink: boolean; // <path>
  wikilink: boolean; // [[page]], [[page|display]]
  fullpath: boolean; // /repo/root/path.md
};

/**
 * Path-resolution knobs. Absolute-vs-relative and case policy follow the
 * repo's §3.5.1 path policy — one path-normalization authority — so they
 * are deliberately NOT knobs here.
 */
export type LinkResolution = {
  wikilink_elision: boolean; // [[foo]] → foo.md → foo/index.md
  preserve_anchors: boolean; // keep '#heading' on target_raw
  index_basename: string; // basename tried for [[foo]] → foo/<index>.md
};

/** The full config after merging tiers — every field populated. */
export type LinkConfig = {
  /** Syntaxes recognized in the Markdown body. */
  body: LinkSyntaxes;
  /** Syntaxes recognized inside frontmatter string values. */
  frontmatter: LinkSyntaxes;
  resolution: LinkResolution;
};

/**
 * Optional per-field override — the shape stored in `repos.link_config`
 * JSON and accepted by `repos.set_link_config`. Omitting a field means
 * "inherit"; setting it means "replace the inherited value wholesale."
 */
export type LinkConfigOverride = {
  body?: LinkSyntaxes;
  frontmatter?: LinkSyntaxes;
  resolution?: LinkResolution;
};

const SYNTAX_KEYS = ["inline", "reference", "autolink", "wikilink", "fullpath"] as const;

/** All body syntaxes on — the default document-body profile. */
export const DEFAULT_BODY_SYNTAXES: LinkSyntaxes = {
  inline: true,
  reference: true,
  autolink: true,
  wikilink: true,
  fullpath: true,
};

/**
 * Frontmatter profile: whole-value `/…/*.md` paths plus embedded wikilinks
 * and inline links. Reference/autolink off — uncommon inside YAML scalars.
 */
export const DEFAULT_FRONTMATTER_SYNTAXES: LinkSyntaxes = {
  inline: true,
  reference: false,
  autolink: false,
  wikilink: true,
  fullpath: true,
};

export const HARDCODED_DEFAULTS: LinkConfig = {
  body: DEFAULT_BODY_SYNTAXES,
  frontmatter: DEFAULT_FRONTMATTER_SYNTAXES,
  resolution: {
    wikilink_elision: true,
    preserve_anchors: true,
    index_basename: "index",
  },
};

// -----------------------------------------------------------------------------
// Merging.
// -----------------------------------------------------------------------------

export function mergeConfig(base: LinkConfig, override: LinkConfigOverride | null): LinkConfig {
  if (!override) return base;
  return {
    body: override.body ?? base.body,
    frontmatter: override.frontmatter ?? base.frontmatter,
    resolution: override.resolution ?? base.resolution,
  };
}

export function effectiveLinkConfig(
  serverConfig: LinkConfig,
  repoOverride: LinkConfigOverride | null,
): LinkConfig {
  return mergeConfig(serverConfig, repoOverride);
}

export function parseRepoOverride(json: string | null): LinkConfigOverride | null {
  if (json === null) return null;
  const parsed = JSON.parse(json) as unknown;
  if (parsed === null || parsed === undefined) return null;
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`corrupt repos.link_config JSON: expected object, got ${typeof parsed}`);
  }
  return parsed as LinkConfigOverride;
}

// -----------------------------------------------------------------------------
// Startup invariants.
// -----------------------------------------------------------------------------

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function validateSyntaxes(label: string, syn: LinkSyntaxes): void {
  for (const key of SYNTAX_KEYS) {
    if (typeof syn[key] !== "boolean") {
      throw new ConfigError(`${label}.${key} must be a boolean, got ${JSON.stringify(syn[key])}`);
    }
  }
}

export function validateConfig(config: LinkConfig): void {
  validateSyntaxes("body", config.body);
  validateSyntaxes("frontmatter", config.frontmatter);

  if (
    typeof config.resolution.index_basename !== "string" ||
    config.resolution.index_basename.length === 0
  ) {
    throw new ConfigError(
      `resolution.index_basename must be a non-empty string, got ${JSON.stringify(config.resolution.index_basename)}`,
    );
  }
  for (const key of ["wikilink_elision", "preserve_anchors"] as const) {
    if (typeof config.resolution[key] !== "boolean") {
      throw new ConfigError(
        `resolution.${key} must be a boolean, got ${JSON.stringify(config.resolution[key])}`,
      );
    }
  }
}

export function validateRepoOverride(override: LinkConfigOverride, serverConfig: LinkConfig): void {
  try {
    validateConfig(mergeConfig(serverConfig, override));
  } catch (err) {
    if (err instanceof ConfigError) {
      throw new KernelError("link_config_invalid", { reason: err.message });
    }
    throw err;
  }
}
