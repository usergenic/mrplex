/**
 * Link config layering — design §11.2 (Phase 1, links-plan.md §1.2).
 *
 *   HARDCODED_DEFAULTS  → server config  → per-repo override
 *      (in code)          (operator)       (repos.link_config JSON)
 *
 * A structural twin of kernel/path-config.ts: non-null replaces the *field
 * it sets*, not deep-merged. A repo that sets `fields: ["parent"]` sees
 * exactly that; `syntaxes` and `resolution` still inherit from the server.
 *
 * `syntaxes` is one field — an override that sets it must restate every
 * syntax it wants on (whole-object replace, links-plan.md §5 decision 7).
 * This keeps one merge rule everywhere, matching path-config's field-level
 * semantics.
 *
 * The effective config drives deterministic extraction (WS2). Disabling a
 * syntax removes it from extraction entirely; a config change triggers a
 * repo-wide re-extraction on the backfill path (WS3), never synchronously.
 */

import { KernelError } from "../kernel/errors.js";

// -----------------------------------------------------------------------------
// The three tiers.
// -----------------------------------------------------------------------------

/**
 * Which link syntaxes extraction recognizes. Each is a boolean knob; the
 * `!` embed/transclusion prefix is NOT a syntax — it's a rendering hint
 * captured as an ordinary edge from its base syntax (§1.1).
 */
export type LinkSyntaxes = {
  inline: boolean; // [text](path)
  reference: boolean; // [text][id] + [id]: path
  autolink: boolean; // <path>
  wikilink: boolean; // [[page]], [[page|display]]
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
  syntaxes: LinkSyntaxes;
  /** Frontmatter reference fields — CEL field paths, opt-in per repo. */
  fields: string[];
  resolution: LinkResolution;
};

/**
 * Optional per-field override — the shape stored in `repos.link_config`
 * JSON and accepted by `repos.set_link_config`. Omitting a field means
 * "inherit"; setting it means "replace the inherited value wholesale."
 */
export type LinkConfigOverride = {
  syntaxes?: LinkSyntaxes;
  fields?: string[];
  resolution?: LinkResolution;
};

/**
 * Hardcoded defaults (§11.2 "Recognized syntaxes and defaults"). One
 * constant, source of truth. All body syntaxes on; frontmatter fields
 * opt-in (empty).
 */
export const HARDCODED_DEFAULTS: LinkConfig = {
  syntaxes: {
    inline: true,
    reference: true,
    autolink: true,
    wikilink: true,
  },
  fields: [],
  resolution: {
    wikilink_elision: true,
    preserve_anchors: true,
    index_basename: "index",
  },
};

// -----------------------------------------------------------------------------
// Merging.
// -----------------------------------------------------------------------------

/**
 * Replace-not-merge per field (§1.2): if override.X is set, result.X =
 * override.X; otherwise result.X inherits from base. `syntaxes` and
 * `resolution` are whole-object fields (decision 7) — no per-key merge.
 */
export function mergeConfig(base: LinkConfig, override: LinkConfigOverride | null): LinkConfig {
  if (!override) return base;
  return {
    syntaxes: override.syntaxes ?? base.syntaxes,
    fields: override.fields ?? base.fields,
    resolution: override.resolution ?? base.resolution,
  };
}

/**
 * Compute the effective config for a repo:
 *
 *   effective = merge(server, repo_override)  where server = merge(defaults, server_override)
 *
 * `serverConfig` is expected to already be validated (validateConfig at
 * startup). Does NOT re-validate — a caller taking an override from
 * `repos.set_link_config` must validate the merge before persisting.
 */
export function effectiveLinkConfig(
  serverConfig: LinkConfig,
  repoOverride: LinkConfigOverride | null,
): LinkConfig {
  return mergeConfig(serverConfig, repoOverride);
}

/** Parse the JSON text stored in `repos.link_config`. Null → null. */
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

/**
 * Thrown at startup when server config violates an invariant. Not a
 * KernelError — a configuration error the operator must fix before the
 * server starts, mirroring path-config's ConfigError.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * CEL field path (§11.2 "Field paths"): a leading identifier, followed by
 * zero or more `.identifier` or `["quoted"]` accessors. No array indices;
 * `$body` and other `$`-sentinels are not legal declared fields.
 *
 *   parent · project.lead · owners["team-lead"] · data["2024-Q3"].value
 */
const IDENT = "[A-Za-z_][A-Za-z0-9_]*";
const BRACKET = '\\["(?:[^"\\\\]|\\\\.)*"\\]';
const FIELD_PATH = new RegExp(`^${IDENT}(?:\\.${IDENT}|${BRACKET})*$`);

function isValidFieldPath(path: string): boolean {
  if (path.length === 0) return false;
  if (path.startsWith("$")) return false; // '$body' etc. are sentinels, not fields
  return FIELD_PATH.test(path);
}

/**
 * Validate a fully-merged LinkConfig:
 *
 *   • syntaxes has exactly the four boolean knobs.
 *   • fields entries are non-empty, valid CEL field paths (not sentinels).
 *   • resolution.index_basename is a non-empty string.
 *
 * Throws ConfigError on the first violation, with a human-readable message.
 */
export function validateConfig(config: LinkConfig): void {
  const syn = config.syntaxes;
  for (const key of ["inline", "reference", "autolink", "wikilink"] as const) {
    if (typeof syn[key] !== "boolean") {
      throw new ConfigError(`syntaxes.${key} must be a boolean, got ${JSON.stringify(syn[key])}`);
    }
  }

  if (!Array.isArray(config.fields)) {
    throw new ConfigError(`fields must be an array, got ${typeof config.fields}`);
  }
  for (const field of config.fields) {
    if (typeof field !== "string" || !isValidFieldPath(field)) {
      throw new ConfigError(
        `fields entry must be a valid CEL field path, got ${JSON.stringify(field)}`,
      );
    }
  }

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

/**
 * Validate a LinkConfigOverride BEFORE merging — used by
 * `repos.set_link_config`. The merged result must be a valid config.
 * Surfaces as a KernelError so the API returns a clean 4xx (path-config's
 * validateRepoOverride throws ConfigError at startup, but repo overrides
 * are runtime input, so we wrap the message as filter-style config_invalid).
 */
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
