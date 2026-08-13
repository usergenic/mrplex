/**
 * Storage layer types — adapter-agnostic. Kernel operations run on top of these.
 *
 * Integer ids are internal (design §3.3) and never cross the wire — the kernel
 * translates rows into Version envelopes with opaque `version_id` strings and
 * slug-based references.
 */

export type UserRow = {
  id: number;
  slug: string;
  created_at: string;
};

export type RepoRow = {
  id: number;
  slug: string;
  path_config: string | null;
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

export type Storage = {
  close(): void;
  migrate(): void;

  /** Serializable transaction. Nested tx flattens into the outer via savepoints. */
  tx<T>(fn: () => T): T;

  users_list(): UserRow[];
  users_create(input: { slug: string; created_at: string }): UserRow;
  users_by_slug(slug: string): UserRow | null;
  users_by_id(id: number): UserRow | null;

  repos_list(): RepoRow[];
  repos_create(input: { slug: string; created_at: string }): RepoRow;
  repos_by_slug(slug: string): RepoRow | null;
  repos_by_id(id: number): RepoRow | null;

  documents_create(repo_id: number): DocumentRow;

  /**
   * Insert a new version and advance the chain atomically (design §7.2.2 #1):
   * new row goes in; `prev.next_id` is updated to the new row's id; both happen
   * in one tx. The two partial unique indexes on `versions` enforce the
   * "one current per document" and "one live per (repo, path)" invariants
   * at the storage layer (design §7.2.2 #2).
   */
  version_insert(input: VersionInsertInput): VersionRow;

  version_by_id(id: number): VersionRow | null;
  version_current(repo_id: number, path: string): VersionRow | null;
  version_history(document_id: number, opts?: HistoryOptions): VersionRow[];
};

export type OpenConfig = {
  /** Database url — sqlite:./path.db or postgres://… */
  database: string;
};

export type StorageAdapter = {
  scheme: string; // "sqlite" or "postgres"
  open(config: OpenConfig): Storage;
};
