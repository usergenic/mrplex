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

export type UserRow = {
  id: number;
  slug: string;
  created_at: string;
};

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
  author_id: number;
  created_at: string;
};

export type VersionInsertInput = {
  document_id: number;
  repo_id: number;
  prev_id: number | null;
  path: string;
  frontmatter_raw: string;
  frontmatter: FrontmatterJson;
  body: string;
  author_id: number;
  created_at: string;
};

export type HistoryOptions = {
  limit?: number;
  before?: string; // ISO 8601 UTC
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

/**
 * Row shape for api_tokens (see design §3.2 and §8). `scopes` is the JSON
 * text as stored; parsing to StoredScope[] happens at the kernel layer.
 * `admin` is a real boolean — the adapter owns the mapping from 0/1
 * (SQLite) or native boolean (Postgres).
 */
export type TokenRow = {
  id: number;
  user_id: number;
  secret_hash: string;
  label: string | null;
  scopes: string; // JSON text — kernel parses to StoredScope[]
  admin: boolean;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  last_used_at: string | null;
};

export type TokenInsertInput = {
  user_id: number;
  secret_hash: string;
  label: string | null;
  scopes: string; // pre-serialized JSON
  admin: boolean;
  expires_at: string | null;
  created_at: string;
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

  users_list(): Promise<UserRow[]>;
  users_create(input: { slug: string; created_at: string }): Promise<UserRow>;
  users_rename(id: number, new_slug: string): Promise<UserRow>;
  users_by_slug(slug: string): Promise<UserRow | null>;
  users_by_id(id: number): Promise<UserRow | null>;

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

  // Tokens (design §3.2, §8). All queries return null / empty for
  // revoked or expired rows — the adapter does the filter so the kernel
  // never has to remember.
  tokens_create(input: TokenInsertInput): Promise<TokenRow>;
  tokens_by_hash(hash: string): Promise<TokenRow | null>;
  tokens_by_id(id: number): Promise<TokenRow | null>;
  tokens_list(user_id: number): Promise<TokenRow[]>;
  tokens_revoke(id: number, revoked_at: string): Promise<TokenRow | null>;
  tokens_revoke_by_user(user_id: number, revoked_at: string): Promise<void>;
  /** Opportunistic, non-transactional per §8.5. */
  tokens_touch_last_used(id: number, when: string): Promise<void>;
};

export type OpenConfig = {
  /** Database url — sqlite:./path.db or postgres://… */
  database: string;
};

export type StorageAdapter = {
  scheme: string; // "sqlite" or "postgres"
  open(config: OpenConfig): Promise<Storage>;
};
