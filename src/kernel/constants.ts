/**
 * Cross-cutting kernel constants. Kept small on purpose — this is not a
 * grab-bag. Only things with more than one caller and no better home.
 */

/**
 * Intrinsic sigil — the leading character that marks an identifier as
 * server-owned rather than user-authored. Single source of truth.
 *
 * Two surfaces share it:
 *
 *   • Query filter syntax — `$path`, `$created_at`, and other intrinsics
 *     recognized by the CEL parser (see ../kernel/query/cel-parse.ts).
 *   • Frontmatter system properties — `$version` and (future) `$author`,
 *     `$updated_at`, etc., injected into GET responses and stripped on
 *     write (see ../markdown/frontmatter.ts).
 *
 * Not to be confused with `PathConfig.system_sigils` in wire.ts, which
 * governs a different reservation entirely (path-segment prefixes like
 * `.` / `:` gating hidden and deleted namespaces).
 */
export const INTRINSIC_SIGIL = "$";
