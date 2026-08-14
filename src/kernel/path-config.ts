/**
 * Path config layering — design §3.5.2.
 *
 *   HARDCODED_DEFAULTS  → server config  → per-repo override
 *      (in code)          (operator)       (repos.path_config JSON)
 *
 * Non-null replaces the *field it sets*, not deep-merged. A repo that
 * sets `hidden_sigils: [".", "_"]` sees exactly that; other fields still
 * inherit from the server. Startup invariants (below) protect operators
 * from configs that would make the system unusable — the server refuses
 * to start if server config violates them, and `repos.set_path_config`
 * rejects a per-repo override the same way.
 *
 * Slugs are validated against server-level config only (§3.5.6) — the
 * per-repo override doesn't apply to slug validation.
 */

import { KernelError } from "./errors.js";
import { type EffectivePathConfig, PATH_SEPARATOR } from "./validation.js";

// -----------------------------------------------------------------------------
// The three tiers.
// -----------------------------------------------------------------------------

/**
 * Optional per-field override — the shape stored in `repos.path_config`
 * JSON and accepted by `repos.set_path_config`. Omitting a field means
 * "inherit"; setting it means "replace the inherited value wholesale."
 */
export type PathConfigOverride = {
  disallowed_chars?: string[];
  system_sigils?: string[];
  hidden_sigils?: string[];
};

/**
 * The full config after merging tiers — every field populated. All kernel
 * code that validates paths/slugs takes this shape (see validation.ts).
 */
export type PathConfig = EffectivePathConfig;

/**
 * Hardcoded defaults (design §3.5.2). One constant, source of truth.
 * Obsidian's cross-platform-safe rule minus `/`.
 */
export const HARDCODED_DEFAULTS: PathConfig = {
  disallowed_chars: ["\\", "<", ">", ":", "|", "?", '"'],
  system_sigils: [":"],
  hidden_sigils: ["."],
};

// -----------------------------------------------------------------------------
// Merging.
// -----------------------------------------------------------------------------

/**
 * Replace-not-merge per field (design §3.5.2 tier 3): if override.X is set,
 * result.X = override.X; otherwise result.X inherits from base.
 */
export function mergeConfig(base: PathConfig, override: PathConfigOverride | null): PathConfig {
  if (!override) return base;
  return {
    disallowed_chars: override.disallowed_chars ?? base.disallowed_chars,
    system_sigils: override.system_sigils ?? base.system_sigils,
    hidden_sigils: override.hidden_sigils ?? base.hidden_sigils,
  };
}

/**
 * Compute the effective config for a repo (design §3.5.2).
 *
 *   effective = merge(server, repo_override)  where server = merge(defaults, server_override)
 *
 * `serverConfig` is expected to already be validated (see validateConfig
 * called at startup). This function does NOT re-validate — a caller who
 * takes an override from `repos.set_path_config` must validate the
 * resulting merge themselves before persisting.
 */
export function effectivePathConfig(
  serverConfig: PathConfig,
  repoOverride: PathConfigOverride | null,
): PathConfig {
  return mergeConfig(serverConfig, repoOverride);
}

/**
 * Parse the JSON text stored in `repos.path_config`. Null → null.
 */
export function parseRepoOverride(json: string | null): PathConfigOverride | null {
  if (json === null) return null;
  const parsed = JSON.parse(json) as unknown;
  if (parsed === null || parsed === undefined) return null;
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`corrupt repos.path_config JSON: expected object, got ${typeof parsed}`);
  }
  return parsed as PathConfigOverride;
}

// -----------------------------------------------------------------------------
// Startup invariants (design §3.5.2).
// -----------------------------------------------------------------------------

/**
 * Thrown at startup when server config violates an invariant. Deliberately
 * not a KernelError — this is a configuration error the operator must fix
 * before the server starts, not a runtime error the API returns.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Validate a fully-merged PathConfig against design §3.5.2's invariants:
 *
 *   • Every disallowed_chars entry is a single character; every sigil is
 *     a non-empty string.
 *   • PATH_SEPARATOR appears in no entry of any list.
 *   • No sigil is a prefix of any other sigil, across BOTH lists.
 *     (With multi-char sigils, plain set-disjointness isn't enough:
 *     ":" vs ":h" would classify ":hfoo" both ways. Forbidding prefix
 *     relations makes segment classification unambiguous.)
 *   • No hidden sigil contains a character from disallowed_chars
 *     (users must be able to write the prefixes they use to hide
 *     their own folders). System sigils may — users never write those.
 *   • Both sigil lists are non-empty (otherwise the kernel has no
 *     canonical sigil to emit under).
 *
 * Throws ConfigError on the first violation, with a human-readable message.
 */
export function validateConfig(config: PathConfig): void {
  // 1. Char-vs-string discipline.
  for (const ch of config.disallowed_chars) {
    if (typeof ch !== "string" || Array.from(ch).length !== 1) {
      throw new ConfigError(
        `disallowed_chars entry must be a single character, got ${JSON.stringify(ch)}`,
      );
    }
  }
  for (const sigil of [...config.system_sigils, ...config.hidden_sigils]) {
    if (typeof sigil !== "string" || sigil.length === 0) {
      throw new ConfigError(`sigil must be a non-empty string, got ${JSON.stringify(sigil)}`);
    }
  }

  // 2. No PATH_SEPARATOR anywhere.
  for (const list of [config.disallowed_chars, config.system_sigils, config.hidden_sigils]) {
    for (const entry of list) {
      if (entry.includes(PATH_SEPARATOR)) {
        throw new ConfigError(
          `entries cannot contain the path separator '${PATH_SEPARATOR}': got ${JSON.stringify(entry)}`,
        );
      }
    }
  }

  // 3. No sigil is a prefix of any other sigil, across the union.
  const allSigils = [...config.system_sigils, ...config.hidden_sigils];
  for (let i = 0; i < allSigils.length; i++) {
    for (let j = 0; j < allSigils.length; j++) {
      if (i === j) continue;
      const a = allSigils[i] as string;
      const b = allSigils[j] as string;
      if (b.startsWith(a)) {
        throw new ConfigError(
          `sigil ${JSON.stringify(a)} is a prefix of sigil ${JSON.stringify(b)} — segment classification would be ambiguous`,
        );
      }
    }
  }

  // 4. No hidden sigil contains a disallowed char.
  for (const sigil of config.hidden_sigils) {
    for (const ch of config.disallowed_chars) {
      if (sigil.includes(ch)) {
        throw new ConfigError(
          `hidden sigil ${JSON.stringify(sigil)} contains disallowed character ${JSON.stringify(ch)} — users could not write it`,
        );
      }
    }
  }

  // 5. Both sigil lists non-empty.
  if (config.system_sigils.length === 0) {
    throw new ConfigError("system_sigils must be non-empty");
  }
  if (config.hidden_sigils.length === 0) {
    throw new ConfigError("hidden_sigils must be non-empty");
  }
}

/**
 * Validate a PathConfigOverride BEFORE merging — used by
 * `repos.set_path_config`. Fields that are set must merge cleanly against
 * the current server config.
 */
export function validateRepoOverride(override: PathConfigOverride, serverConfig: PathConfig): void {
  validateConfig(mergeConfig(serverConfig, override));
}

// -----------------------------------------------------------------------------
// PathWarning — advisory-only, no rows are hidden or rewritten.
// -----------------------------------------------------------------------------

export type PathWarning = {
  version_id: string; // opaque, wire-form
  path: string;
  reason: string;
};

/**
 * Convert a validation error thrown during a re-scan into a wire-friendly
 * PathWarning. Used by `repos.set_path_config` to produce the advisory list
 * of currently-live paths that would fail the new config (§3.5.3).
 */
export function pathWarning(versionId: string, path: string, err: unknown): PathWarning {
  const reason =
    err instanceof KernelError
      ? ((err.data as { reason?: string }).reason ?? err.code)
      : (err as Error).message;
  return { version_id: versionId, path, reason };
}
