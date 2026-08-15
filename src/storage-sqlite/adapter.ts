import { RE2JS } from "@bufbuild/re2";
import Database from "better-sqlite3";
import type { SearchPlan } from "../storage/search-plan.js";
import type {
  BacklogRow,
  BacklogStatus,
  ChunkRow,
  ChunkUpsertInput,
  DocumentRow,
  FrontmatterJson,
  HistoryOptions,
  OpenConfig,
  RepoRow,
  Storage,
  StorageAdapter,
  TokenInsertInput,
  TokenRow,
  UserRow,
  VectorSearchHit,
  VersionInsertInput,
  VersionRow,
} from "../storage/types.js";
import { compileSearchPlan } from "./compile-sqlite.js";
import { migrate } from "./migrations/index.js";
import { decodeVectorBlob, encodeVectorBlob, loadSqliteVec } from "./vec.js";

type VersionRawRow = {
  id: number;
  document_id: number;
  repo_id: number;
  prev_id: number | null;
  next_id: number | null;
  path: string;
  frontmatter_raw: string;
  frontmatter: string; // JSON text
  body: string;
  author_id: number;
  created_at: string;
};

const hydrateVersion = (row: VersionRawRow): VersionRow => ({
  ...row,
  frontmatter: JSON.parse(row.frontmatter) as FrontmatterJson,
});

type TokenRawRow = Omit<TokenRow, "admin"> & { admin: number };
const hydrateToken = (row: TokenRawRow): TokenRow => ({ ...row, admin: row.admin === 1 });

/**
 * Compile + cache RE2JS patterns per SqliteStorage instance. Returns null
 * for patterns that fail to compile — matches SQLite's regexp() convention
 * of "no match" rather than raising, so a bad pattern doesn't kill the
 * whole query.
 */
const re2Cache = new WeakMap<Database.Database, Map<string, RE2JS | null>>();
function compileRegexpCachedFor(db: Database.Database, pattern: string): RE2JS | null {
  let cache = re2Cache.get(db);
  if (!cache) {
    cache = new Map();
    re2Cache.set(db, cache);
  }
  if (cache.has(pattern)) return cache.get(pattern) ?? null;
  let compiled: RE2JS | null;
  try {
    compiled = RE2JS.compile(pattern);
  } catch {
    compiled = null;
  }
  cache.set(pattern, compiled);
  return compiled;
}

function parseSqliteUrl(url: string): string {
  const m = url.match(/^sqlite:(.+)$/);
  if (!m || !m[1]) {
    throw new Error(`invalid sqlite database url: ${url}`);
  }
  return m[1];
}

class SqliteStorage implements Storage {
  private db: Database.Database;
  private txDepth = 0;

  constructor(path: string) {
    this.db = new Database(path);
    // Concurrency & correctness pragmas — see design §7.2.2 (obligation 3).
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    // regexp() user function — the SQL side of CEL's matches() (m2-plan
    // §5). RE2JS keeps the semantics identical to Postgres's `~`.
    const dbHandle = this.db;
    this.db.function(
      "regexp",
      { deterministic: true },
      (pattern: unknown, input: unknown): number => {
        if (typeof pattern !== "string" || typeof input !== "string") return 0;
        const compiled = compileRegexpCachedFor(dbHandle, pattern);
        if (!compiled) return 0;
        return compiled.matches(input) ? 1 : 0;
      },
    );
    loadSqliteVec(this.db);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async migrate(): Promise<void> {
    migrate(this.db);
  }

  async tx<T>(fn: () => Promise<T>): Promise<T> {
    // SQLite's transactions are on-connection and can hold across
    // `await`s because better-sqlite3 is synchronous per call — no
    // other statement runs on the connection between our steps.
    // Kernel contract (design §7.2 / m5-plan WS1): tx bodies never
    // await foreign I/O, only storage calls; that's safe.
    if (this.txDepth === 0) {
      this.db.exec("begin immediate");
      this.txDepth++;
      try {
        const result = await fn();
        this.db.exec("commit");
        this.txDepth--;
        return result;
      } catch (err) {
        this.db.exec("rollback");
        this.txDepth--;
        throw err;
      }
    }
    // Nested — use a savepoint.
    const name = `sp_${this.txDepth}`;
    this.db.exec(`savepoint ${name}`);
    this.txDepth++;
    try {
      const result = await fn();
      this.db.exec(`release ${name}`);
      this.txDepth--;
      return result;
    } catch (err) {
      this.db.exec(`rollback to ${name}`);
      this.db.exec(`release ${name}`);
      this.txDepth--;
      throw err;
    }
  }

  async users_list(): Promise<UserRow[]> {
    return this.db
      .prepare("select id, slug, created_at from users order by slug")
      .all() as UserRow[];
  }

  async users_create(input: { slug: string; created_at: string }): Promise<UserRow> {
    return this.db
      .prepare("insert into users(slug, created_at) values (?, ?) returning id, slug, created_at")
      .get(input.slug, input.created_at) as UserRow;
  }

  async users_rename(id: number, new_slug: string): Promise<UserRow> {
    const row = this.db
      .prepare("update users set slug = ? where id = ? returning id, slug, created_at")
      .get(new_slug, id) as UserRow | undefined;
    if (!row) throw new Error(`users_rename: user ${id} not found`);
    return row;
  }

  async users_by_slug(slug: string): Promise<UserRow | null> {
    return (
      (this.db.prepare("select id, slug, created_at from users where slug = ?").get(slug) as
        | UserRow
        | undefined) ?? null
    );
  }

  async users_by_id(id: number): Promise<UserRow | null> {
    return (
      (this.db.prepare("select id, slug, created_at from users where id = ?").get(id) as
        | UserRow
        | undefined) ?? null
    );
  }

  async repos_list(): Promise<RepoRow[]> {
    return this.db
      .prepare("select id, slug, path_config, created_at from repos order by slug")
      .all() as RepoRow[];
  }

  async repos_create(input: { slug: string; created_at: string }): Promise<RepoRow> {
    return this.db
      .prepare(
        "insert into repos(slug, created_at) values (?, ?) returning id, slug, path_config, created_at",
      )
      .get(input.slug, input.created_at) as RepoRow;
  }

  async repos_rename(id: number, new_slug: string): Promise<RepoRow> {
    const row = this.db
      .prepare("update repos set slug = ? where id = ? returning id, slug, path_config, created_at")
      .get(new_slug, id) as RepoRow | undefined;
    if (!row) throw new Error(`repos_rename: repo ${id} not found`);
    return row;
  }

  async repos_set_path_config(id: number, path_config: string | null): Promise<RepoRow> {
    const row = this.db
      .prepare(
        "update repos set path_config = ? where id = ? returning id, slug, path_config, created_at",
      )
      .get(path_config, id) as RepoRow | undefined;
    if (!row) throw new Error(`repos_set_path_config: repo ${id} not found`);
    return row;
  }

  async repos_by_slug(slug: string): Promise<RepoRow | null> {
    return (
      (this.db
        .prepare("select id, slug, path_config, created_at from repos where slug = ?")
        .get(slug) as RepoRow | undefined) ?? null
    );
  }

  async repos_by_id(id: number): Promise<RepoRow | null> {
    return (
      (this.db
        .prepare("select id, slug, path_config, created_at from repos where id = ?")
        .get(id) as RepoRow | undefined) ?? null
    );
  }

  async documents_create(repo_id: number): Promise<DocumentRow> {
    return this.db
      .prepare("insert into documents(repo_id) values (?) returning id, repo_id")
      .get(repo_id) as DocumentRow;
  }

  async version_insert(input: VersionInsertInput): Promise<VersionRow> {
    return this.tx(async () => {
      if (input.prev_id !== null) {
        const updated = this.db
          .prepare(
            "update versions set next_id = id where id = ? and document_id = ? and next_id is null",
          )
          .run(input.prev_id, input.document_id);
        if (updated.changes !== 1) {
          throw new Error(
            `version_insert: prev_id ${input.prev_id} is not the current version of document ${input.document_id} (or does not exist)`,
          );
        }
      }

      const inserted = this.db
        .prepare(
          `insert into versions
            (document_id, repo_id, prev_id, next_id, path,
             frontmatter_raw, frontmatter, body, author_id, created_at)
           values (?, ?, ?, null, ?, ?, ?, ?, ?, ?)
           returning id, document_id, repo_id, prev_id, next_id, path,
                     frontmatter_raw, frontmatter, body, author_id, created_at`,
        )
        .get(
          input.document_id,
          input.repo_id,
          input.prev_id,
          input.path,
          input.frontmatter_raw,
          JSON.stringify(input.frontmatter),
          input.body,
          input.author_id,
          input.created_at,
        ) as VersionRawRow;

      if (input.prev_id !== null) {
        this.db
          .prepare("update versions set next_id = ? where id = ?")
          .run(inserted.id, input.prev_id);
      }

      return hydrateVersion(inserted);
    });
  }

  async version_by_id(id: number): Promise<VersionRow | null> {
    const row = this.db
      .prepare(
        `select id, document_id, repo_id, prev_id, next_id, path,
                frontmatter_raw, frontmatter, body, author_id, created_at
         from versions where id = ?`,
      )
      .get(id) as VersionRawRow | undefined;
    return row ? hydrateVersion(row) : null;
  }

  async version_current(repo_id: number, path: string): Promise<VersionRow | null> {
    const row = this.db
      .prepare(
        `select id, document_id, repo_id, prev_id, next_id, path,
                frontmatter_raw, frontmatter, body, author_id, created_at
         from versions where repo_id = ? and path = ? and next_id is null`,
      )
      .get(repo_id, path) as VersionRawRow | undefined;
    return row ? hydrateVersion(row) : null;
  }

  async versions_live_by_repo(repo_id: number): Promise<VersionRow[]> {
    const rows = this.db
      .prepare(
        `select id, document_id, repo_id, prev_id, next_id, path,
                frontmatter_raw, frontmatter, body, author_id, created_at
         from versions
         where repo_id = ? and next_id is null
         order by path`,
      )
      .all(repo_id) as VersionRawRow[];
    return rows.map(hydrateVersion);
  }

  async fts_index(_version_id: number, _body: string): Promise<void> {
    // SQLite FTS5 external-content mode with AFTER INSERT triggers on
    // `versions` keeps the index in sync automatically (see migration
    // 0003_fts_docs.sql).
  }

  async versions_search(plan: SearchPlan): Promise<VersionRow[]> {
    if (plan.repo_ids.length === 0) return [];
    if (plan.scope.kind === "deny_all") return [];
    const { sql, params } = compileSearchPlan(plan);
    const rows = this.db.prepare(sql).all(...params) as VersionRawRow[];
    return rows.map(hydrateVersion);
  }

  async version_history(document_id: number, opts?: HistoryOptions): Promise<VersionRow[]> {
    const clauses: string[] = [];
    const params: (string | number)[] = [document_id];
    if (opts?.before) {
      clauses.push("chain.created_at < ?");
      params.push(opts.before);
    }
    const where = clauses.length > 0 ? ` where ${clauses.join(" and ")}` : "";
    const limitClause = opts?.limit ? " limit ?" : "";
    if (opts?.limit) params.push(opts.limit);

    const rows = this.db
      .prepare(
        `with recursive chain(
           id, document_id, repo_id, prev_id, next_id, path,
           frontmatter_raw, frontmatter, body, author_id, created_at, depth
         ) as (
           select id, document_id, repo_id, prev_id, next_id, path,
                  frontmatter_raw, frontmatter, body, author_id, created_at, 0
             from versions
             where document_id = ? and next_id is null
           union all
           select v.id, v.document_id, v.repo_id, v.prev_id, v.next_id, v.path,
                  v.frontmatter_raw, v.frontmatter, v.body, v.author_id, v.created_at,
                  c.depth + 1
             from versions v
             join chain c on v.id = c.prev_id
         )
         select id, document_id, repo_id, prev_id, next_id, path,
                frontmatter_raw, frontmatter, body, author_id, created_at
         from chain${where}
         order by depth asc${limitClause}`,
      )
      .all(...params) as VersionRawRow[];
    return rows.map(hydrateVersion);
  }

  async chunks_upsert(
    version_id: number,
    model: string,
    chunks: readonly ChunkUpsertInput[],
  ): Promise<void> {
    if (chunks.length === 0) {
      await this.tx(async () => {
        this.db.prepare("delete from chunks where version_id = ?").run(version_id);
      });
      return;
    }
    // Normalize each embedding to a Buffer (BLOB) at the adapter
    // boundary. Callers pass either number[] (fresh from the hook) or
    // Float32Array (reused via chunks_by_hash).
    const encoded = chunks.map((c) => ({
      ...c,
      embedding:
        c.embedding instanceof Float32Array
          ? Buffer.from(c.embedding.buffer, c.embedding.byteOffset, c.embedding.byteLength)
          : encodeVectorBlob(c.embedding),
    }));
    const dim = encoded[0]?.embedding.byteLength;
    if (dim === undefined) throw new Error("chunks_upsert: unreachable");
    for (const c of encoded) {
      if (c.embedding.byteLength !== dim) {
        throw new Error(
          `chunks_upsert: mixed embedding dimensions in one batch (${c.embedding.byteLength} vs ${dim})`,
        );
      }
      if (c.model !== model) {
        throw new Error(
          `chunks_upsert: mixed models in one batch (${JSON.stringify(c.model)} vs ${JSON.stringify(model)})`,
        );
      }
    }
    await this.tx(async () => {
      this.db.prepare("delete from chunks where version_id = ?").run(version_id);
      const insert = this.db.prepare(
        "insert into chunks(version_id, ix, text, text_hash, model, embedding) values (?, ?, ?, ?, ?, ?)",
      );
      for (const c of encoded) {
        insert.run(version_id, c.ix, c.text, c.text_hash, c.model, c.embedding);
      }
    });
  }

  async chunks_by_hash(
    model: string,
    text_hashes: readonly string[],
  ): Promise<{ text_hash: string; embedding: Float32Array }[]> {
    if (text_hashes.length === 0) return [];
    const ph = text_hashes.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `select text_hash, embedding
           from chunks
           where model = ?
             and text_hash in (${ph})
             and embedding is not null
           group by text_hash`,
      )
      .all(model, ...text_hashes) as { text_hash: string; embedding: Buffer }[];
    return rows.map((r) => ({ text_hash: r.text_hash, embedding: decodeVectorBlob(r.embedding) }));
  }

  async chunks_by_version(version_id: number): Promise<ChunkRow[]> {
    const rows = this.db
      .prepare(
        `select version_id, ix, text, text_hash, model, embedding
           from chunks
           where version_id = ?
           order by ix`,
      )
      .all(version_id) as {
      version_id: number;
      ix: number;
      text: string;
      text_hash: string;
      model: string;
      embedding: Buffer | null;
    }[];
    return rows.map((r) => ({
      ...r,
      embedding: r.embedding ? decodeVectorBlob(r.embedding) : null,
    }));
  }

  async chunks_model_summary(): Promise<{ model: string; chunk_count: number }[]> {
    return this.db
      .prepare(
        `select model, count(*) as chunk_count
           from chunks
           group by model
           order by model`,
      )
      .all() as { model: string; chunk_count: number }[];
  }

  async vector_search(
    repo_ids: readonly number[],
    model: string,
    embedding: readonly number[],
    k: number,
  ): Promise<VectorSearchHit[]> {
    if (repo_ids.length === 0 || k <= 0) return [];
    const queryBlob = encodeVectorBlob(embedding);
    const repoPh = repo_ids.map(() => "?").join(",");
    return this.db
      .prepare(
        `with scored as (
           select chunks.version_id as version_id,
                  chunks.ix as chunk_ix,
                  vec_distance_cosine(chunks.embedding, ?) as score,
                  row_number() over (
                    partition by chunks.version_id
                    order by vec_distance_cosine(chunks.embedding, ?) asc, chunks.ix asc
                  ) as rn
             from chunks
             join versions on versions.id = chunks.version_id
             where chunks.model = ?
               and chunks.embedding is not null
               and versions.next_id is null
               and versions.repo_id in (${repoPh})
         )
         select version_id, chunk_ix, score
           from scored
           where rn = 1
           order by score asc
           limit ?`,
      )
      .all(queryBlob, queryBlob, model, ...repo_ids, k) as VectorSearchHit[];
  }

  async backlog_enqueue(version_id: number): Promise<void> {
    this.db
      .prepare(
        `insert into embedding_backlog(version_id, attempts, last_error, next_retry_at)
           values (?, 0, null, null)
           on conflict(version_id) do update
             set attempts = 0, last_error = null, next_retry_at = null`,
      )
      .run(version_id);
  }

  async backlog_dequeue(now: string, limit: number): Promise<BacklogRow[]> {
    if (limit <= 0) return [];
    return this.db
      .prepare(
        `select version_id, attempts, last_error, next_retry_at
           from embedding_backlog
           where next_retry_at is null or next_retry_at <= ?
           order by coalesce(next_retry_at, '') asc, version_id asc
           limit ?`,
      )
      .all(now, limit) as BacklogRow[];
  }

  async backlog_retain(input: {
    version_id: number;
    attempts: number;
    last_error: string;
    next_retry_at: string;
  }): Promise<void> {
    this.db
      .prepare(
        `update embedding_backlog
           set attempts = ?, last_error = ?, next_retry_at = ?
           where version_id = ?`,
      )
      .run(input.attempts, input.last_error, input.next_retry_at, input.version_id);
  }

  async backlog_delete(version_id: number): Promise<void> {
    this.db.prepare("delete from embedding_backlog where version_id = ?").run(version_id);
  }

  async backlog_status(now: string): Promise<BacklogStatus> {
    const pending = (
      this.db.prepare("select count(*) as n from embedding_backlog").get() as { n: number }
    ).n;
    const due = (
      this.db
        .prepare(
          "select count(*) as n from embedding_backlog where next_retry_at is null or next_retry_at <= ?",
        )
        .get(now) as { n: number }
    ).n;
    const failing = (
      this.db.prepare("select count(*) as n from embedding_backlog where attempts > 0").get() as {
        n: number;
      }
    ).n;
    const oldestRow = this.db
      .prepare(
        `select next_retry_at
           from embedding_backlog
           where next_retry_at is not null
           order by next_retry_at asc
           limit 1`,
      )
      .get() as { next_retry_at: string } | undefined;
    const recent = this.db
      .prepare(
        `select version_id, last_error
           from embedding_backlog
           where last_error is not null
           order by next_retry_at desc
           limit 5`,
      )
      .all() as { version_id: number; last_error: string }[];
    const models = this.db
      .prepare(
        `select model, count(*) as chunk_count
           from chunks
           group by model
           order by model`,
      )
      .all() as { model: string; chunk_count: number }[];
    return {
      pending,
      due,
      failing,
      oldest_next_retry_at: oldestRow?.next_retry_at ?? null,
      recent_errors: recent,
      models,
    };
  }

  async tokens_create(input: TokenInsertInput): Promise<TokenRow> {
    const raw = this.db
      .prepare(
        `insert into api_tokens
           (user_id, secret_hash, label, scopes, admin,
            expires_at, revoked_at, created_at, last_used_at)
         values (?, ?, ?, ?, ?, ?, null, ?, null)
         returning id, user_id, secret_hash, label, scopes,
                   admin, expires_at, revoked_at, created_at, last_used_at`,
      )
      .get(
        input.user_id,
        input.secret_hash,
        input.label,
        input.scopes,
        input.admin ? 1 : 0,
        input.expires_at,
        input.created_at,
      ) as TokenRawRow;
    return hydrateToken(raw);
  }

  async tokens_by_hash(hash: string): Promise<TokenRow | null> {
    const raw = this.db
      .prepare(
        `select id, user_id, secret_hash, label, scopes,
                admin, expires_at, revoked_at, created_at, last_used_at
           from api_tokens
           where secret_hash = ?
             and revoked_at is null
             and (expires_at is null or expires_at > ?)`,
      )
      .get(hash, new Date().toISOString()) as TokenRawRow | undefined;
    return raw ? hydrateToken(raw) : null;
  }

  async tokens_by_id(id: number): Promise<TokenRow | null> {
    const raw = this.db
      .prepare(
        `select id, user_id, secret_hash, label, scopes,
                admin, expires_at, revoked_at, created_at, last_used_at
           from api_tokens where id = ?`,
      )
      .get(id) as TokenRawRow | undefined;
    return raw ? hydrateToken(raw) : null;
  }

  async tokens_list(user_id: number): Promise<TokenRow[]> {
    const rows = this.db
      .prepare(
        `select id, user_id, secret_hash, label, scopes,
                admin, expires_at, revoked_at, created_at, last_used_at
           from api_tokens
           where user_id = ?
             and revoked_at is null
             and (expires_at is null or expires_at > ?)
           order by created_at desc, id desc`,
      )
      .all(user_id, new Date().toISOString()) as TokenRawRow[];
    return rows.map(hydrateToken);
  }

  async tokens_revoke(id: number, revoked_at: string): Promise<TokenRow | null> {
    const raw = this.db
      .prepare(
        `update api_tokens set revoked_at = coalesce(revoked_at, ?)
           where id = ?
         returning id, user_id, secret_hash, label, scopes,
                   admin, expires_at, revoked_at, created_at, last_used_at`,
      )
      .get(revoked_at, id) as TokenRawRow | undefined;
    return raw ? hydrateToken(raw) : null;
  }

  async tokens_revoke_by_user(user_id: number, revoked_at: string): Promise<void> {
    this.db
      .prepare("update api_tokens set revoked_at = coalesce(revoked_at, ?) where user_id = ?")
      .run(revoked_at, user_id);
  }

  async tokens_touch_last_used(id: number, when: string): Promise<void> {
    this.db.prepare("update api_tokens set last_used_at = ? where id = ?").run(when, id);
  }
}

export const sqliteAdapter: StorageAdapter = {
  scheme: "sqlite",
  async open(config: OpenConfig): Promise<Storage> {
    const path = parseSqliteUrl(config.database);
    const storage = new SqliteStorage(path);
    await storage.migrate();
    return storage;
  },
};
