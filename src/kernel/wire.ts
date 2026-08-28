/**
 * Kernel wire types — the shapes returned to surfaces (design §6.4).
 * Integer ids never appear here; version_ids are opaque strings.
 */

import type { KernelErrorCode } from "./errors.js";

export type PathConfig = {
  disallowed_chars?: string[];
  system_sigils?: string[];
  hidden_sigils?: string[];
};

export type Repo = {
  repo: string; // slug
  path_config: PathConfig | null;
};

export type Version = {
  version_id: string;
  prev_version_id: string | null;
  next_version_id: string | null;
  repo: string; // slug
  path: string;
  frontmatter: Record<string, unknown>;
  frontmatter_raw: string;
  body: string;
  author: string; // opaque caller-supplied string (noauth plan §1)
  created_at: string; // ISO 8601 UTC
  content_hash: string; // sha-256 of canonical content (sync/history plan §2)
};

export type PathWarning = {
  version_id: string;
  path: string;
  reason: string;
};

/** The operation a version row represents, derived server-side (§3.3). */
export type VersionOp = "create" | "update" | "move" | "delete";

/**
 * A lightweight change-feed pointer (sync/history plan §3.3). Consumers fetch
 * bodies via `docs.get_version` only when needed; `content_hash` lets them
 * skip no-op materializations and `prev_path` names both ends of a move/delete.
 * `op` is derived server-side so consumers never parse path sigils.
 */
export type VersionRef = {
  version_id: string;
  prev_version_id: string | null;
  repo: string;
  path: string;
  prev_path: string | null;
  content_hash: string;
  op: VersionOp;
  created_at: string;
};

/** Result of `history.since` — a page of refs plus the resume cursor (§3.3). */
export type HistorySincePage = {
  refs: VersionRef[];
  next_since: string;
};

/** One live-set entry from `history.index` (§3.4). */
export type IndexItem = {
  path: string;
  version_id: string;
  content_hash: string;
};

/**
 * A page of `history.index` (sync/history plan §3.4). `through_version` is the
 * safe head `R` — captured on the first call, echoed on later pages;
 * `next_after_version` is absent on the final page.
 */
export type HistoryIndexPage = {
  items: IndexItem[];
  through_version: string;
  next_after_version?: string;
};

/**
 * A projected `query` hit (docs/query-select-plan.md). `query` names the
 * fields it wants via `select` and gets back these lean objects rather than
 * full `Version` rows. Following `GraphDocument`'s precedent, any field that
 * isn't user-authored frontmatter carries the `$` sigil, so a document whose
 * frontmatter literally contains a key named `path`/`repo` still round-trips
 * without colliding with the system's `$path`/`$repo`.
 */
export type QueryHit = {
  [intrinsic: `$${string}`]: unknown; // $path, $version_id, $repo, …
  [frontmatterKey: string]: unknown; // bare select-ed frontmatter keys
};

// -----------------------------------------------------------------------------
// Graph read surface (docs/graph-plan.md). The API transacts in documents and
// links — no "nodes"/"edges" anywhere on the wire.
// -----------------------------------------------------------------------------

/** Direction lens for a graph expansion (§2.1). */
export type GraphDirection = "out" | "in" | "both";

/**
 * Input to `kernel.graph` (§2.1). `roots` is a path or gitignore-style glob,
 * string or array. `filter` is CEL, evaluated as *visibility* (not selection);
 * `$degrees` is legal only here. `fields` restricts both traversal and the
 * output `links`. `select` names bare frontmatter keys projected onto result
 * documents (default `["title"]`).
 */
export type GraphSpec = {
  repo: string;
  roots: string | string[];
  direction?: GraphDirection;
  degrees?: number;
  fields?: string[];
  filter?: string;
  select?: string[];
  max_documents?: number;
};

/**
 * A result document (§2.2): the filter language's data model reified. Bare
 * keys are `select`-projected frontmatter; `$`-keys are system intrinsics, so
 * no user frontmatter key can collide. `$degrees` is call-relative (minimum
 * hops from the nearest root under this call's lens) and must not be persisted
 * across calls. `$links`/`$backlinks` are counts of distinct scope-visible
 * documents, independent of this call's filter/fields/degrees.
 */
export type GraphDocument = {
  $path: string;
  $degrees: number;
  $links: number;
  $backlinks: number;
  [frontmatterKey: string]: unknown;
};

/** An induced link on the wire (§2.2): a distinct (source, target, field)
 * triple, both endpoints present in `documents`. No `ord`, no counts. */
export type GraphLink = {
  source: string;
  target: string;
  field: string;
};

/** Structured result of `kernel.graph` (§2.2). */
export type GraphResult = {
  documents: GraphDocument[];
  links: GraphLink[];
  /** Paths of returned documents whose links were not fully enumerated —
   * the continuation contract (§2.2, decision 10). Sorted by path. */
  frontier: string[];
  /** Largest d such that every effective-graph document within d hops of a
   * root is present (§2.2). Equals `degrees` when `truncated` is false. */
  complete_degrees: number;
  /** True iff `max_documents` or the links ceiling elided anything. */
  truncated: boolean;
};

/** Per-path failure from `docs.get_many` — the call still succeeds. */
export type DocGetManyError = {
  path: string;
  code: KernelErrorCode;
  data: Record<string, unknown>;
};

/** Result of `docs.get_many` — found versions plus per-path errors. */
export type DocGetManyResult = {
  items: Version[];
  errors: DocGetManyError[];
};
