/**
 * Structured search plan — the kernel/adapter seam for versions_search
 * (design §7.2, m5-plan WS2).
 *
 * The kernel builds a `SearchPlan` from a validated QuerySpec — it
 * parses CEL eagerly (so `filter_invalid` surfaces before storage),
 * resolves per-repo sigils to a list of exclusion sub-clauses, and
 * flattens the actor's read scopes into engine-agnostic regex sources.
 * The adapter compiles this plan into its dialect's SQL: SQLite uses
 * `regexp()` and json_extract; Postgres uses `~` and jsonb operators.
 *
 * Kernel emits no SQL strings.
 */

import type { CelExpr } from "../kernel/query/ast.js";

/**
 * A per-repo-group sigil-exclusion sub-clause (§3.5.5). Each entry
 * says: for versions in `repo_ids`, hide paths whose first path
 * segment starts with any of `sigils`. Empty `sigils` = no exclusion
 * for that group; the adapter can skip it.
 */
export type SigilExclusion = {
  repo_ids: readonly number[];
  sigils: readonly string[];
};

/**
 * A per-scope-entry pattern for the read-scope filter (§8.2).
 * `repos` is either the literal `"*"` (dynamic all-repos wildcard) or
 * a resolved list of repo ids the scope binds. `globs` is the
 * gitignore-style pattern list; each pattern is prefixed with `!` for
 * negation (last-match-wins on the resulting list). The compiler
 * turns each pattern into a regex source via kernel/auth/glob.
 */
export type ScopeGroup = {
  repos: "*" | readonly number[];
  globs: readonly string[];
};

/**
 * SearchPlan — the structured input to versions_search.
 *
 * The adapter is responsible for compiling this into engine-specific
 * SQL. Ordering: if `rank` candidate ids are present, adapter must
 * preserve caller-provided order for the intersection; otherwise
 * text-score (if `text`) else `created_at DESC, id DESC`.
 */
export type SearchPlan = {
  /** Repos to search. Empty → adapter returns []. */
  repo_ids: readonly number[];
  /** Result cap. Adapter enforces LIMIT. */
  limit: number;
  /**
   * Optional FTS text. Adapter applies its dialect's syntax
   * (SQLite: FTS5 MATCH; Postgres: websearch_to_tsquery). Kernel
   * passes the raw user string — the portable subset (bare terms +
   * quoted phrases) is the parity target.
   */
  text?: string;
  /**
   * Parsed CEL AST for the filter, if any. Kernel-side eager parse
   * surfaces `filter_invalid` before it reaches the adapter.
   */
  filter_ast?: CelExpr;
  /** Per-repo sigil exclusion groups. Empty list = no exclusions. */
  sigils: readonly SigilExclusion[];
  /**
   * Read-scope filter (§8.2). One of three modes:
   *   • `allow_all` — actor is admin, no filter.
   *   • `deny_all` — actor has no scopes at all; adapter must return [].
   *   • `groups` — one or more scope entries; adapter ORs them together.
   */
  scope: { kind: "allow_all" } | { kind: "deny_all" } | { kind: "groups"; groups: ScopeGroup[] };
  /**
   * Optional candidate id whitelist (rank branch, m4-plan §5.1).
   * When present, adapter restricts results to these ids AND returns
   * them in the order given so the kernel's semantic-score sort is stable.
   */
  candidate_ids?: readonly number[];
  /**
   * Optional candidate DOCUMENT-id whitelist (graph read surface,
   * docs/graph-plan.md WS2). When present, the adapter restricts results to
   * live versions whose `document_id` is in this set — the kernel uses it to
   * evaluate scope∧filter visibility over a BFS round's candidate documents
   * in one pass. Unlike `candidate_ids` (version ids, order-significant for
   * rank), this imposes no ordering.
   */
  candidate_document_ids?: readonly number[];
};
