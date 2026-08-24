/**
 * Storage layer types — adapter-agnostic. Kernel operations run on top of these.
 *
 * Integer ids are internal (design §3.3) and never cross the wire — the kernel
 * translates rows into Version envelopes with opaque `version_id` strings and
 * slug-based references.
 *
 * All Storage methods are async. SQLite adapter methods complete
 * synchronously and resolve on the next microtask; Postgres adapter
 * methods await real I/O. The uniform signature keeps kernel code
 * dialect-agnostic (design §7.2, m5-plan WS1).
 */

import type { SearchPlan } from "./search-plan.js";

export type RepoRow = {
  id: number;
  slug: string;
  path_config: string | null;
  /** Per-repo link-extraction override JSON (§11.2). Null = inherit. */
  link_config: string | null;
  created_at: string;
};

export type DocumentRow = {
  id: number;
  repo_id: number;
};

export type FrontmatterJson = Record<string, unknown>;

export type VersionRow = {
  id: number;
  document_id: number;
  repo_id: number;
  prev_id: number | null;
  next_id: number | null;
  path: string;
  frontmatter_raw: string;
  frontmatter: FrontmatterJson;
  body: string;
  author: string;
  created_at: string;
  /**
   * SHA-256 (bare hex) of canonical content (sync/history plan §2). Derived and
   * server-owned — computed in-tx by `version_insert`, never part of the insert
   * input. Null only on pre-backfill rows written before migration 0002.
   */
  content_hash: string | null;
};

export type VersionInsertInput = {
  document_id: number;
  repo_id: number;
  prev_id: number | null;
  path: string;
  frontmatter_raw: string;
  frontmatter: FrontmatterJson;
  body: string;
  author: string;
  created_at: string;
};

export type HistoryOptions = {
  limit?: number;
  before?: string; // ISO 8601 UTC
};

/**
 * Options for the scoped history walk (sync/history plan §3.5). A forward
 * id-ordered walk over the versions of documents selected by a path glob,
 * bounded by version-id cursors. `path_regexes` are anchored regex sources
 * (the gitignore-glob compilation used everywhere); empty = every document in
 * the repo. `ever: false` anchors on the *live* set (docs whose CURRENT path
 * matches); `ever: true` includes any document that *ever* had a matching path
 * (whole chains). `after_id`/`until_id` are version-id bounds (exclusive lower,
 * inclusive upper). `order` picks id ascending (oldest-first) or descending.
 */
export type VersionsListOptions = {
  repo_id: number;
  path_regexes: readonly string[];
  ever: boolean;
  after_id?: number;
  until_id?: number;
  order: "asc" | "desc";
  limit: number;
};

/**
 * Options for the gap-aware forward feed walk (sync/history plan §3.2–3.3).
 * `after_id` is the resume cursor (0 = from the beginning); `repo_id` filters
 * the output without affecting gap detection (gaps are global). `now_ms` and
 * `window_ms` drive the safety window — the adapter supplies wall-clock now;
 * `window_ms` is the caller's tolerance for treating a gap's successor as
 * "settled long enough that the hole is burned, not pending."
 */
export type VersionsSinceOptions = {
  after_id: number;
  repo_id?: number;
  limit: number;
  now_ms: number;
  window_ms: number;
};

/**
 * Result of `versions_since`: the settled rows in `(after_id, next_id]`
 * (repo-filtered, ascending by id) and the resume cursor `next_id`. Every id
 * ≤ `next_id` is final and gap-free; `next_id === after_id` means nothing is
 * safe to deliver yet (caught up, or stalled at a hot gap — the client just
 * polls again).
 */
export type VersionsSinceResult = {
  rows: VersionRow[];
  next_id: number;
};

/**
 * Chunks (design §3.2, §5.3). One row per chunk of a version's body.
 * `embedding` is null while the row is pending embedding (rare in
 * practice — chunk rows are only inserted alongside their vectors).
 * Content-hash dedup key is (model, text_hash). Embeddings are
 * exchanged with the storage layer as Float32Array — the adapter owns
 * the on-disk representation (byte layout is private to each engine).
 */
export type ChunkRow = {
  version_id: number;
  ix: number;
  text: string;
  text_hash: string;
  model: string;
  embedding: Float32Array | null;
};

export type ChunkUpsertInput = {
  ix: number;
  text: string;
  text_hash: string;
  model: string;
  /**
   * Query vector. Callers passing fresh vectors use `readonly number[]`
   * (that's what the embed hook returns); callers reusing a dedup-hit
   * vector pass the Float32Array they got back from chunks_by_hash so
   * the adapter round-trips it without re-encoding.
   */
  embedding: readonly number[] | Float32Array;
};

export type VectorSearchHit = {
  version_id: number;
  chunk_ix: number;
  score: number; // cosine distance (0 = identical, 2 = opposite)
};

/**
 * Links derived index (design §11.2). One row per outbound STATIC edge
 * from a source document's CURRENT version, doc-keyed. The kernel extracts
 * + resolves edges and hands the adapter the resolved shape below;
 * extraction/resolution logic (markdown parsing, path normalization) lives
 * in src/links, never in the storage layer.
 */

/**
 * A resolved outbound edge, ready to persist. `target_id` is the bound
 * document identity or null when dangling (the named path has no live
 * document yet). `target_norm` is the folded, anchor-stripped resolution
 * key used to rebind danglers case-insensitively (§3.5.1).
 */
export type LinkEdgeInput = {
  ord: number;
  field: string; // '$body' or a CEL frontmatter field path
  target_raw: string; // canonical written form (primary candidate + anchor)
  target_norm: string; // normalizeKey of the primary candidate (no anchor)
  target_id: number | null; // resolved document id, or null = dangling
};

/** A stored link edge row (read shape — backfill, links.stale, tests). */
export type LinkRow = {
  repo_id: number;
  source_id: number;
  ord: number;
  field: string;
  target_raw: string;
  target_norm: string;
  target_id: number | null;
};

/**
 * A distinct resolved adjacency triple for the graph read surface
 * (docs/graph-plan.md WS1). `ord`, `target_raw`, and `target_norm` never
 * leave storage on this path: adjacency reads collapse multiple occurrences
 * of the same `(source, target, field)` to one row (`SELECT DISTINCT`) and
 * exclude dangling edges (`target_id IS NULL`). Both endpoints are document
 * ids; the kernel maps them to paths and applies scope.
 */
export type AdjacentLink = {
  source_id: number;
  target_id: number;
  field: string;
};

/**
 * Embedding backlog (design §3.2, §5.3). One row per version awaiting
 * (or having failed) embedding. `attempts` counts failed tries; a fresh
 * enqueue resets `attempts` and `next_retry_at` so a superseding write
 * doesn't inherit an old backoff.
 */
export type BacklogRow = {
  version_id: number;
  attempts: number;
  last_error: string | null;
  next_retry_at: string | null; // ISO 8601 UTC
};

export type BacklogStatus = {
  pending: number; // rows total in the backlog
  due: number; // rows whose next_retry_at is null or <= now
  failing: number; // rows with attempts > 0
  oldest_next_retry_at: string | null;
  recent_errors: readonly { version_id: number; last_error: string }[];
  models: readonly { model: string; chunk_count: number }[];
};

export type Storage = {
  close(): Promise<void>;
  migrate(): Promise<void>;

  /**
   * Serializable transaction. Nested tx flattens into the outer via
   * savepoints. Contract: never await foreign I/O inside `fn` — the
   * tx holds locks and the adapter's REPEATABLE READ retry loop (PG)
   * must be able to replay the whole body. Kernel tx bodies only call
   * storage.
   */
  tx<T>(fn: () => Promise<T>): Promise<T>;

  repos_list(): Promise<RepoRow[]>;
  repos_create(input: { slug: string; created_at: string }): Promise<RepoRow>;
  repos_rename(id: number, new_slug: string): Promise<RepoRow>;
  repos_set_path_config(id: number, path_config: string | null): Promise<RepoRow>;
  repos_set_link_config(id: number, link_config: string | null): Promise<RepoRow>;
  repos_by_slug(slug: string): Promise<RepoRow | null>;
  repos_by_id(id: number): Promise<RepoRow | null>;

  documents_create(repo_id: number): Promise<DocumentRow>;

  /**
   * Insert a new version and advance the chain atomically (design §7.2.2 #1):
   * new row goes in; `prev.next_id` is updated to the new row's id; both happen
   * in one tx. The two partial unique indexes on `versions` enforce the
   * "one current per document" and "one live per (repo, path)" invariants
   * at the storage layer (design §7.2.2 #2).
   */
  version_insert(input: VersionInsertInput): Promise<VersionRow>;

  version_by_id(id: number): Promise<VersionRow | null>;
  version_current(repo_id: number, path: string): Promise<VersionRow | null>;
  version_history(document_id: number, opts?: HistoryOptions): Promise<VersionRow[]>;

  /**
   * Scoped, document-spanning history walk (sync/history plan §3.5). Selects
   * documents by path glob (via `path_regexes`), then returns their version
   * rows interleaved by id, bounded by `after_id`/`until_id` cursors. See
   * `VersionsListOptions` for the `ever` (live vs. whole-corpus) distinction.
   */
  versions_list(opts: VersionsListOptions): Promise<VersionRow[]>;

  /**
   * The gap-aware forward feed walk (sync/history plan §3.2–3.3): the longest
   * safe contiguous run of version rows after `opts.after_id`, filtered to
   * `opts.repo_id` when given. Returns settled rows only (never crosses a hot
   * gap) plus the resume cursor `next_id`. See `versions-since.ts` for the
   * safety-window logic both adapters share.
   */
  versions_since(opts: VersionsSinceOptions): Promise<VersionsSinceResult>;

  /**
   * Batch id → path lookup (sync/history plan §3.3): the feed derives each
   * ref's `prev_path` (both ends of a move/delete) from its `prev_id` without
   * hydrating whole prev rows. Ids not present are simply absent from the map.
   */
  versions_paths_by_ids(ids: readonly number[]): Promise<Map<number, string>>;

  /**
   * The safe head `R` (sync/history plan §3.4): the raw version id the feed
   * would hand out as `next_since` at the live tip — everything ≤ R is visible
   * and final. Computed with the same safety-window machinery as the feed, but
   * anchored at the tip rather than a cursor, so `history.index` scans through
   * a settled boundary while `history.since(R)` covers the rest with no gaps.
   * Returns 0 when the log is empty.
   */
  versions_safe_head(now_ms: number, window_ms: number): Promise<number>;

  /**
   * One keyset page of the live set for `history.index` (§3.4): live rows
   * (`next_id IS NULL`) in `repo_id` whose current version id is in
   * `(after_id, through_id]`, ascending by id, capped at `limit`. Lightweight
   * tuples only — the kernel applies system/hidden exclusion and scope.
   */
  versions_live_index(opts: {
    repo_id: number;
    through_id: number;
    after_id: number;
    limit: number;
  }): Promise<{ id: number; path: string; content_hash: string | null }[]>;

  /**
   * Content-hash backfill (sync/history plan §2.6). Fetch one batch of rows
   * with `content_hash IS NULL` (id-ascending, id > `after_id`, capped at
   * `limit`), optionally scoped to `repo_id`. Returns the raw fields the shared
   * hash function needs; the kernel computes hashes and writes them via
   * `versions_set_content_hash`. Keyset by id so batches don't re-scan.
   */
  versions_missing_content_hash(opts: {
    repo_id?: number;
    after_id: number;
    limit: number;
  }): Promise<{ id: number; frontmatter_raw: string; body: string }[]>;

  /** Set `content_hash` for a batch of version ids (backfill writer, §2.6). */
  versions_set_content_hash(
    updates: readonly { id: number; content_hash: string }[],
  ): Promise<void>;

  /**
   * All currently-live versions in a repo (i.e. rows where next_id IS NULL).
   * Used by `repos.set_path_config` to produce the advisory PathWarning[]
   * scan (§3.5.3). Riding the partial-index on (repo_id, path) where
   * next_id is null, so O(live-set) per repo.
   */
  versions_live_by_repo(repo_id: number): Promise<VersionRow[]>;

  // Full-text search (design §5.1, §7.2.2). Indexes CURRENT versions
  // only — the versions_search method above filters live rows itself.
  //
  //   fts_index — hook the storage engine offers if it needs an explicit
  //               indexing call. SQLite's FTS5 external-content mode uses
  //               triggers, so this method is a no-op there; kept for
  //               interface symmetry with engines that need it.
  //
  // FTS querying itself lives in versions_search (below) which JOINs
  // fts_docs directly, so kernel.query has one path through the
  // adapter, not two.
  fts_index(version_id: number, body: string): Promise<void>;

  // Links derived index (design §11.2). Doc-keyed, maintained in the write
  // tx alongside version_insert — extraction is pure CPU (no external I/O),
  // so it rides the kernel tx rather than the async backlog worker.

  /**
   * Replace document `source_id`'s outbound edges wholesale (delete +
   * insert) in one shot. `repo_id` scopes the rows (links are repo-local).
   * Called on every create/put that advances the doc's current version.
   * Passing an empty `edges` clears the doc's outbound rows.
   */
  links_replace(repo_id: number, source_id: number, edges: readonly LinkEdgeInput[]): Promise<void>;

  /** Clear a document's outbound edges (on delete). Inbound rows stay put. */
  links_clear(source_id: number): Promise<void>;

  /**
   * Bind dangling edges in `repo_id` whose folded target matches
   * `target_norm` to `document_id`. Called when a document appears at a
   * path (create / move-in / restore) so waiting danglers resolve — the
   * identity-bound counterpart to "backlinks survive renames" (§11.2).
   * Bind-only: already-bound edges are never touched, and edges are never
   * unbound (a move produces zero inbound churn; a delete leaves inbound
   * rows bound and lets visibility filtering hide them — §11.2). A source's
   * edge is never bound to the source itself (self-links are noise and are
   * excluded, `source_id <> document_id`). Returns the number of edges
   * newly bound.
   */
  links_resolve_dangling(
    repo_id: number,
    target_norm: string,
    document_id: number,
  ): Promise<number>;

  /** A document's outbound edges (backfill, links.stale, tests). */
  links_by_source(source_id: number): Promise<LinkRow[]>;

  /** Every link row in a repo, ordered by (source_id, ord) (tests, verify). */
  links_by_repo(repo_id: number): Promise<LinkRow[]>;

  /**
   * Outbound adjacency for a batch of source documents: distinct
   * `(source_id, target_id, field)` triples where `source_id` is in the
   * batch. Dangling edges (`target_id IS NULL`) are excluded in SQL. Used by
   * the graph read surface (docs/graph-plan.md WS1); the kernel applies
   * scope/filter visibility to the endpoints. `ord` never leaves storage.
   */
  links_adjacent_out(repo_id: number, source_ids: readonly number[]): Promise<AdjacentLink[]>;

  /**
   * Inbound adjacency for a batch of target documents: distinct
   * `(source_id, target_id, field)` triples where `target_id` is in the
   * batch (resolved edges only). The counterpart to links_adjacent_out.
   */
  links_adjacent_in(repo_id: number, target_ids: readonly number[]): Promise<AdjacentLink[]>;

  /**
   * Current-version rows for a batch of document ids (graph read surface).
   * Only live rows (`next_id IS NULL`) in `repo_id`; ids not currently live
   * are simply absent. The kernel needs the paths + frontmatter to project
   * documents and to apply scope to graph endpoints.
   */
  versions_current_by_documents(
    repo_id: number,
    document_ids: readonly number[],
  ): Promise<VersionRow[]>;

  /**
   * Document ids of live versions in `repo_id` whose path matches ANY of the
   * given anchored regex sources (`^…$`, the gitignore-glob compilation used
   * everywhere). Path matching happens in SQL (SQLite `regexp()` UDF, Postgres
   * `~`) so the graph root-resolution path never materializes the whole repo.
   * An empty `path_regexes` returns [].
   */
  versions_live_document_ids_matching(
    repo_id: number,
    path_regexes: readonly string[],
  ): Promise<number[]>;

  /**
   * Composed query — the kernel orchestrator (§5) hands over a structured
   * `SearchPlan` (repo ids + parsed CEL AST + scope regex sources + sigil
   * exclusions + optional text + candidate whitelist + limit); the adapter
   * compiles the plan into engine-specific SQL. Ordering per §5.1:
   * text-score if `text` is present, else `$created_at DESC`.
   *
   * m5-plan WS2 pushed compilation behind the adapter so the kernel emits
   * no SQL strings.
   */
  versions_search(plan: SearchPlan): Promise<VersionRow[]>;

  /**
   * Chunks + vectors (design §3.2, §5.3, §7.2.2). Written by the
   * backlog worker; read by kernel.query's `rank` branch.
   *
   * `chunks_upsert` replaces all chunks for `version_id` in one tx.
   * All vectors in the input must share `model` and the same
   * dimensionality; the adapter refuses mixed-dim writes (m4-plan §1,
   * §5.3 "refuse mixed-dim writes to the chunks table").
   */
  chunks_upsert(
    version_id: number,
    model: string,
    chunks: readonly ChunkUpsertInput[],
  ): Promise<void>;

  /**
   * Content-hash dedup lookup (§5.3). Returns one row per hash present
   * in the input list for the given model, with its stored vector so
   * the worker can reuse it without calling the hook.
   */
  chunks_by_hash(
    model: string,
    text_hashes: readonly string[],
  ): Promise<{ text_hash: string; embedding: Float32Array }[]>;

  chunks_by_version(version_id: number): Promise<ChunkRow[]>;

  /**
   * Distinct (model, chunk_count) pairs across the chunks table — for
   * `embed status`. `chunk_count` counts rows, not distinct hashes.
   */
  chunks_model_summary(): Promise<{ model: string; chunk_count: number }[]>;

  /**
   * Brute-force k-NN over current-version chunks with vectors matching
   * `model`. §7.2.1 pins v1 at brute-force — indexed ANN (HNSW/IVFFlat
   * for pgvector) is a fast-follow.
   *
   * `k` limits distinct-version results, not chunk hits. The adapter
   * owns the version-collapse (best chunk per version) AND the vector
   * serialization (float32 vs float64, LE vs BE, etc.). Kernel callers
   * pass a plain JS number array — no dialect-specific encoding leaks
   * into the query layer.
   */
  vector_search(
    repo_ids: readonly number[],
    model: string,
    embedding: readonly number[],
    k: number,
  ): Promise<VectorSearchHit[]>;

  // Embedding backlog (design §5.3). One row per version awaiting or
  // retrying embedding. Enqueue is idempotent-per-version (upsert).
  backlog_enqueue(version_id: number): Promise<void>;
  /** Rows due now (next_retry_at IS NULL or <= now), oldest first. */
  backlog_dequeue(now: string, limit: number): Promise<BacklogRow[]>;
  backlog_retain(input: {
    version_id: number;
    attempts: number;
    last_error: string;
    next_retry_at: string;
  }): Promise<void>;
  backlog_delete(version_id: number): Promise<void>;
  backlog_status(now: string): Promise<BacklogStatus>;
};

export type OpenConfig = {
  /** Database url — sqlite:./path.db or postgres://… */
  database: string;
};

export type StorageAdapter = {
  scheme: string; // "sqlite" or "postgres"
  open(config: OpenConfig): Promise<Storage>;
};
