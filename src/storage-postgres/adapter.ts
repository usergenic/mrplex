/**
 * Postgres adapter (m5-plan WS4).
 *
 * Contract:
 *   - Kernel calls are async; storage owns SQL emission.
 *   - `tx()` wraps `begin isolation level repeatable read` and reuses the
 *     same PoolClient inside via AsyncLocalStorage. Nested tx uses
 *     savepoints. On 40001/40P01 the whole tx body retries with jittered
 *     backoff up to 3 times.
 *   - int8 parser: PG returns bigints as strings by default; a custom
 *     parser converts them to JS numbers with a SafeInteger guard so id
 *     drift is loud, not silent.
 *   - Vectors serialize as pgvector's `'[…]'` literal; on read they
 *     arrive as a string and parse back to Float32Array.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient, types as pgTypes } from "pg";
import type { SearchPlan } from "../storage/search-plan.js";
import type {
  BacklogRow,
  BacklogStatus,
  ChunkRow,
  ChunkUpsertInput,
  DocumentRow,
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
import { compileSearchPlan } from "./compile-postgres.js";
import { isSerializationRetryable } from "./errors.js";
import { migrate } from "./migrations/index.js";

// PG type OIDs. INT8 = 20, NUMERIC = 1700.
// Parse int8 → number with a SafeInteger guard so schema drift (e.g. an
// id truly exceeding 2^53) fails loud, not silently rounds.
pgTypes.setTypeParser(20, (val) => {
  const n = Number(val);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`postgres int8 value ${val} is not a safe JS integer`);
  }
  return n;
});

function parseVectorLiteral(v: unknown): Float32Array {
  if (v instanceof Float32Array) return v;
  if (typeof v !== "string") throw new Error(`unexpected vector shape: ${typeof v}`);
  // pgvector emits "[a,b,c]" without spaces (defensive: allow spaces).
  const trimmed = v.startsWith("[") && v.endsWith("]") ? v.slice(1, -1) : v;
  if (trimmed.length === 0) return new Float32Array(0);
  const parts = trimmed.split(",");
  const out = new Float32Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    out[i] = Number.parseFloat(parts[i] as string);
  }
  return out;
}

function toVectorLiteral(v: readonly number[] | Float32Array): string {
  // pgvector accepts "[a,b,c]"; JSON.stringify gives the exact form.
  const arr = v instanceof Float32Array ? Array.from(v) : v;
  return `[${arr.join(",")}]`;
}

function parsePostgresUrl(url: string): string {
  if (!url.startsWith("postgres:") && !url.startsWith("postgresql:")) {
    throw new Error(`invalid postgres database url: ${url}`);
  }
  return url;
}

type VersionRawRow = {
  id: number;
  document_id: number;
  repo_id: number;
  prev_id: number | null;
  next_id: number | null;
  path: string;
  frontmatter_raw: string;
  frontmatter: Record<string, unknown>; // jsonb — arrives parsed
  body: string;
  author_id: number;
  created_at: string;
};

class PostgresStorage implements Storage {
  private readonly pool: Pool;
  private readonly txClient: AsyncLocalStorage<PoolClient>;
  // Savepoint depth per-tx-client; keyed off the client object.
  private readonly txDepthByClient = new WeakMap<PoolClient, number>();

  constructor(url: string) {
    this.pool = new Pool({ connectionString: url });
    this.txClient = new AsyncLocalStorage<PoolClient>();
  }

  // Route each call to the tx client (if inside a tx) or borrow a fresh
  // one from the pool.
  private async withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const inTx = this.txClient.getStore();
    if (inTx) return fn(inTx);
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await migrate(client);
    } finally {
      client.release();
    }
  }

  async tx<T>(fn: () => Promise<T>): Promise<T> {
    const existing = this.txClient.getStore();
    if (existing) {
      // Nested — use a savepoint. Depth is per-client so parallel tx
      // on different clients don't clash.
      const depth = (this.txDepthByClient.get(existing) ?? 0) + 1;
      this.txDepthByClient.set(existing, depth);
      const name = `sp_${depth}`;
      await existing.query(`savepoint ${name}`);
      try {
        const result = await fn();
        await existing.query(`release savepoint ${name}`);
        return result;
      } catch (err) {
        await existing.query(`rollback to savepoint ${name}`).catch(() => {});
        await existing.query(`release savepoint ${name}`).catch(() => {});
        throw err;
      } finally {
        const now = this.txDepthByClient.get(existing) ?? 0;
        this.txDepthByClient.set(existing, Math.max(0, now - 1));
      }
    }
    // Top-level tx — REPEATABLE READ + retry on 40001/40P01.
    const maxAttempts = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query("begin isolation level repeatable read");
        this.txDepthByClient.set(client, 0);
        try {
          const result = await this.txClient.run(client, fn);
          await client.query("commit");
          return result;
        } catch (err) {
          await client.query("rollback").catch(() => {});
          throw err;
        }
      } catch (err) {
        lastErr = err;
        if (isSerializationRetryable(err) && attempt < maxAttempts) {
          const delayMs = Math.floor(Math.random() * 25 * attempt);
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        throw err;
      } finally {
        this.txDepthByClient.delete(client);
        client.release();
      }
    }
    throw lastErr;
  }

  async users_list(): Promise<UserRow[]> {
    return this.withClient(async (c) => {
      const res = await c.query<UserRow>(
        "select id, slug, created_at from users order by slug",
      );
      return res.rows;
    });
  }

  async users_create(input: { slug: string; created_at: string }): Promise<UserRow> {
    return this.withClient(async (c) => {
      const res = await c.query<UserRow>(
        "insert into users(slug, created_at) values ($1, $2) returning id, slug, created_at",
        [input.slug, input.created_at],
      );
      return res.rows[0] as UserRow;
    });
  }

  async users_rename(id: number, new_slug: string): Promise<UserRow> {
    return this.withClient(async (c) => {
      const res = await c.query<UserRow>(
        "update users set slug = $1 where id = $2 returning id, slug, created_at",
        [new_slug, id],
      );
      if (res.rows.length === 0) throw new Error(`users_rename: user ${id} not found`);
      return res.rows[0] as UserRow;
    });
  }

  async users_by_slug(slug: string): Promise<UserRow | null> {
    return this.withClient(async (c) => {
      const res = await c.query<UserRow>(
        "select id, slug, created_at from users where slug = $1",
        [slug],
      );
      return res.rows[0] ?? null;
    });
  }

  async users_by_id(id: number): Promise<UserRow | null> {
    return this.withClient(async (c) => {
      const res = await c.query<UserRow>(
        "select id, slug, created_at from users where id = $1",
        [id],
      );
      return res.rows[0] ?? null;
    });
  }

  async repos_list(): Promise<RepoRow[]> {
    return this.withClient(async (c) => {
      const res = await c.query<{
        id: number;
        slug: string;
        path_config: unknown;
        created_at: string;
      }>("select id, slug, path_config, created_at from repos order by slug");
      return res.rows.map(hydrateRepo);
    });
  }

  async repos_create(input: { slug: string; created_at: string }): Promise<RepoRow> {
    return this.withClient(async (c) => {
      const res = await c.query<{
        id: number;
        slug: string;
        path_config: unknown;
        created_at: string;
      }>(
        "insert into repos(slug, created_at) values ($1, $2) returning id, slug, path_config, created_at",
        [input.slug, input.created_at],
      );
      return hydrateRepo(res.rows[0] as never);
    });
  }

  async repos_rename(id: number, new_slug: string): Promise<RepoRow> {
    return this.withClient(async (c) => {
      const res = await c.query<{
        id: number;
        slug: string;
        path_config: unknown;
        created_at: string;
      }>(
        "update repos set slug = $1 where id = $2 returning id, slug, path_config, created_at",
        [new_slug, id],
      );
      if (res.rows.length === 0) throw new Error(`repos_rename: repo ${id} not found`);
      return hydrateRepo(res.rows[0] as never);
    });
  }

  async repos_set_path_config(id: number, path_config: string | null): Promise<RepoRow> {
    return this.withClient(async (c) => {
      // path_config on the wire is JSON text; store as jsonb.
      const res = await c.query<{
        id: number;
        slug: string;
        path_config: unknown;
        created_at: string;
      }>(
        "update repos set path_config = $1::jsonb where id = $2 returning id, slug, path_config, created_at",
        [path_config, id],
      );
      if (res.rows.length === 0) throw new Error(`repos_set_path_config: repo ${id} not found`);
      return hydrateRepo(res.rows[0] as never);
    });
  }

  async repos_by_slug(slug: string): Promise<RepoRow | null> {
    return this.withClient(async (c) => {
      const res = await c.query<{
        id: number;
        slug: string;
        path_config: unknown;
        created_at: string;
      }>("select id, slug, path_config, created_at from repos where slug = $1", [slug]);
      return res.rows[0] ? hydrateRepo(res.rows[0] as never) : null;
    });
  }

  async repos_by_id(id: number): Promise<RepoRow | null> {
    return this.withClient(async (c) => {
      const res = await c.query<{
        id: number;
        slug: string;
        path_config: unknown;
        created_at: string;
      }>("select id, slug, path_config, created_at from repos where id = $1", [id]);
      return res.rows[0] ? hydrateRepo(res.rows[0] as never) : null;
    });
  }

  async documents_create(repo_id: number): Promise<DocumentRow> {
    return this.withClient(async (c) => {
      const res = await c.query<DocumentRow>(
        "insert into documents(repo_id) values ($1) returning id, repo_id",
        [repo_id],
      );
      return res.rows[0] as DocumentRow;
    });
  }

  async version_insert(input: VersionInsertInput): Promise<VersionRow> {
    return this.tx(async () => {
      // Same three-statement dance the SQLite adapter uses (design
      // §7.2.2 obligation 1). Partial unique indexes enforce the
      // invariants at the engine layer.
      return this.withClient(async (c) => {
        if (input.prev_id !== null) {
          const upd = await c.query(
            "update versions set next_id = id where id = $1 and document_id = $2 and next_id is null",
            [input.prev_id, input.document_id],
          );
          if (upd.rowCount !== 1) {
            throw new Error(
              `version_insert: prev_id ${input.prev_id} is not the current version of document ${input.document_id} (or does not exist)`,
            );
          }
        }
        const ins = await c.query<VersionRawRow>(
          `insert into versions
             (document_id, repo_id, prev_id, next_id, path,
              frontmatter_raw, frontmatter, body, author_id, created_at)
           values ($1, $2, $3, null, $4, $5, $6::jsonb, $7, $8, $9)
           returning id, document_id, repo_id, prev_id, next_id, path,
                     frontmatter_raw, frontmatter, body, author_id, created_at`,
          [
            input.document_id,
            input.repo_id,
            input.prev_id,
            input.path,
            input.frontmatter_raw,
            JSON.stringify(input.frontmatter),
            input.body,
            input.author_id,
            input.created_at,
          ],
        );
        const inserted = ins.rows[0] as VersionRawRow;
        if (input.prev_id !== null) {
          await c.query("update versions set next_id = $1 where id = $2", [
            inserted.id,
            input.prev_id,
          ]);
        }
        return inserted as VersionRow;
      });
    });
  }

  async version_by_id(id: number): Promise<VersionRow | null> {
    return this.withClient(async (c) => {
      const res = await c.query<VersionRawRow>(
        `select id, document_id, repo_id, prev_id, next_id, path,
                frontmatter_raw, frontmatter, body, author_id, created_at
         from versions where id = $1`,
        [id],
      );
      return (res.rows[0] as VersionRow | undefined) ?? null;
    });
  }

  async version_current(repo_id: number, path: string): Promise<VersionRow | null> {
    return this.withClient(async (c) => {
      const res = await c.query<VersionRawRow>(
        `select id, document_id, repo_id, prev_id, next_id, path,
                frontmatter_raw, frontmatter, body, author_id, created_at
         from versions where repo_id = $1 and path = $2 and next_id is null`,
        [repo_id, path],
      );
      return (res.rows[0] as VersionRow | undefined) ?? null;
    });
  }

  async versions_live_by_repo(repo_id: number): Promise<VersionRow[]> {
    return this.withClient(async (c) => {
      const res = await c.query<VersionRawRow>(
        `select id, document_id, repo_id, prev_id, next_id, path,
                frontmatter_raw, frontmatter, body, author_id, created_at
         from versions
         where repo_id = $1 and next_id is null
         order by path`,
        [repo_id],
      );
      return res.rows as VersionRow[];
    });
  }

  async fts_index(_version_id: number, _body: string): Promise<void> {
    // The generated `fts_tsv` column keeps the index in sync automatically.
    // No-op here for interface symmetry.
  }

  async versions_search(plan: SearchPlan): Promise<VersionRow[]> {
    if (plan.repo_ids.length === 0) return [];
    if (plan.scope.kind === "deny_all") return [];
    return this.withClient(async (c) => {
      const { sql, params } = compileSearchPlan(plan);
      const res = await c.query<VersionRawRow>(sql, params);
      return res.rows as VersionRow[];
    });
  }

  async version_history(document_id: number, opts?: HistoryOptions): Promise<VersionRow[]> {
    return this.withClient(async (c) => {
      const params: (string | number)[] = [document_id];
      const clauses: string[] = [];
      if (opts?.before) {
        params.push(opts.before);
        clauses.push(`chain.created_at < $${params.length}`);
      }
      const where = clauses.length > 0 ? ` where ${clauses.join(" and ")}` : "";
      let limitClause = "";
      if (opts?.limit) {
        params.push(opts.limit);
        limitClause = ` limit $${params.length}`;
      }
      const res = await c.query<VersionRawRow>(
        `with recursive chain as (
           select id, document_id, repo_id, prev_id, next_id, path,
                  frontmatter_raw, frontmatter, body, author_id, created_at, 0 as depth
             from versions
             where document_id = $1 and next_id is null
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
        params,
      );
      return res.rows as VersionRow[];
    });
  }

  async chunks_upsert(
    version_id: number,
    model: string,
    chunks: readonly ChunkUpsertInput[],
  ): Promise<void> {
    if (chunks.length === 0) {
      await this.tx(async () => {
        await this.withClient((c) =>
          c.query("delete from chunks where version_id = $1", [version_id]),
        );
      });
      return;
    }
    // Validate cross-batch invariants before touching the db.
    let dim: number | null = null;
    for (const c of chunks) {
      const len = c.embedding instanceof Float32Array ? c.embedding.length : c.embedding.length;
      if (dim === null) dim = len;
      else if (len !== dim) {
        throw new Error(
          `chunks_upsert: mixed embedding dimensions in one batch (${len} vs ${dim})`,
        );
      }
      if (c.model !== model) {
        throw new Error(
          `chunks_upsert: mixed models in one batch (${JSON.stringify(c.model)} vs ${JSON.stringify(model)})`,
        );
      }
    }
    await this.tx(async () => {
      await this.withClient(async (c) => {
        await c.query("delete from chunks where version_id = $1", [version_id]);
        for (const chunk of chunks) {
          await c.query(
            "insert into chunks(version_id, ix, text, text_hash, model, embedding) values ($1, $2, $3, $4, $5, $6::vector)",
            [
              version_id,
              chunk.ix,
              chunk.text,
              chunk.text_hash,
              chunk.model,
              toVectorLiteral(chunk.embedding),
            ],
          );
        }
      });
    });
  }

  async chunks_by_hash(
    model: string,
    text_hashes: readonly string[],
  ): Promise<{ text_hash: string; embedding: Float32Array }[]> {
    if (text_hashes.length === 0) return [];
    return this.withClient(async (c) => {
      const res = await c.query<{ text_hash: string; embedding: string }>(
        `select text_hash, embedding
           from chunks
           where model = $1
             and text_hash = any($2::text[])
             and embedding is not null`,
        [model, [...text_hashes]],
      );
      // GROUP BY-per-hash: one row per hash, arbitrary embedding.
      const seen = new Map<string, string>();
      for (const r of res.rows) {
        if (!seen.has(r.text_hash)) seen.set(r.text_hash, r.embedding);
      }
      return [...seen.entries()].map(([text_hash, embedding]) => ({
        text_hash,
        embedding: parseVectorLiteral(embedding),
      }));
    });
  }

  async chunks_by_version(version_id: number): Promise<ChunkRow[]> {
    return this.withClient(async (c) => {
      const res = await c.query<{
        version_id: number;
        ix: number;
        text: string;
        text_hash: string;
        model: string;
        embedding: string | null;
      }>(
        `select version_id, ix, text, text_hash, model, embedding
           from chunks
           where version_id = $1
           order by ix`,
        [version_id],
      );
      return res.rows.map((r) => ({
        version_id: r.version_id,
        ix: r.ix,
        text: r.text,
        text_hash: r.text_hash,
        model: r.model,
        embedding: r.embedding !== null ? parseVectorLiteral(r.embedding) : null,
      }));
    });
  }

  async chunks_model_summary(): Promise<{ model: string; chunk_count: number }[]> {
    return this.withClient(async (c) => {
      const res = await c.query<{ model: string; chunk_count: number }>(
        `select model, count(*)::int as chunk_count
           from chunks
           group by model
           order by model`,
      );
      return res.rows;
    });
  }

  async vector_search(
    repo_ids: readonly number[],
    model: string,
    embedding: readonly number[],
    k: number,
  ): Promise<VectorSearchHit[]> {
    if (repo_ids.length === 0 || k <= 0) return [];
    return this.withClient(async (c) => {
      // Brute-force `<=>` (cosine distance). ROW_NUMBER-per-version
      // collapses to best chunk per version — mirrors the SQLite
      // adapter's shape.
      const res = await c.query<{
        version_id: number;
        chunk_ix: number;
        score: number;
      }>(
        `with scored as (
           select chunks.version_id,
                  chunks.ix as chunk_ix,
                  (chunks.embedding <=> $1::vector) as score,
                  row_number() over (
                    partition by chunks.version_id
                    order by (chunks.embedding <=> $1::vector) asc, chunks.ix asc
                  ) as rn
             from chunks
             join versions on versions.id = chunks.version_id
             where chunks.model = $2
               and chunks.embedding is not null
               and versions.next_id is null
               and versions.repo_id = any($3::bigint[])
         )
         select version_id, chunk_ix, score::float8 as score
           from scored
           where rn = 1
           order by score asc
           limit $4`,
        [toVectorLiteral(embedding), model, [...repo_ids], k],
      );
      return res.rows.map((r) => ({
        version_id: r.version_id,
        chunk_ix: r.chunk_ix,
        score: Number(r.score),
      }));
    });
  }

  async backlog_enqueue(version_id: number): Promise<void> {
    await this.withClient((c) =>
      c.query(
        `insert into embedding_backlog(version_id, attempts, last_error, next_retry_at)
           values ($1, 0, null, null)
           on conflict(version_id) do update
             set attempts = 0, last_error = null, next_retry_at = null`,
        [version_id],
      ),
    );
  }

  async backlog_dequeue(now: string, limit: number): Promise<BacklogRow[]> {
    if (limit <= 0) return [];
    return this.withClient(async (c) => {
      const res = await c.query<BacklogRow>(
        `select version_id, attempts, last_error, next_retry_at
           from embedding_backlog
           where next_retry_at is null or next_retry_at <= $1
           order by coalesce(next_retry_at, '') asc, version_id asc
           limit $2`,
        [now, limit],
      );
      return res.rows;
    });
  }

  async backlog_retain(input: {
    version_id: number;
    attempts: number;
    last_error: string;
    next_retry_at: string;
  }): Promise<void> {
    await this.withClient((c) =>
      c.query(
        `update embedding_backlog
           set attempts = $1, last_error = $2, next_retry_at = $3
           where version_id = $4`,
        [input.attempts, input.last_error, input.next_retry_at, input.version_id],
      ),
    );
  }

  async backlog_delete(version_id: number): Promise<void> {
    await this.withClient((c) =>
      c.query("delete from embedding_backlog where version_id = $1", [version_id]),
    );
  }

  async backlog_status(now: string): Promise<BacklogStatus> {
    return this.withClient(async (c) => {
      const pending = Number(
        (await c.query<{ n: string }>("select count(*)::text as n from embedding_backlog")).rows[0]
          ?.n ?? "0",
      );
      const due = Number(
        (
          await c.query<{ n: string }>(
            "select count(*)::text as n from embedding_backlog where next_retry_at is null or next_retry_at <= $1",
            [now],
          )
        ).rows[0]?.n ?? "0",
      );
      const failing = Number(
        (
          await c.query<{ n: string }>(
            "select count(*)::text as n from embedding_backlog where attempts > 0",
          )
        ).rows[0]?.n ?? "0",
      );
      const oldest = (
        await c.query<{ next_retry_at: string }>(
          `select next_retry_at from embedding_backlog
             where next_retry_at is not null
             order by next_retry_at asc limit 1`,
        )
      ).rows[0];
      const recent = (
        await c.query<{ version_id: number; last_error: string }>(
          `select version_id, last_error from embedding_backlog
             where last_error is not null
             order by next_retry_at desc limit 5`,
        )
      ).rows;
      const models = (
        await c.query<{ model: string; chunk_count: number }>(
          `select model, count(*)::int as chunk_count from chunks group by model order by model`,
        )
      ).rows;
      return {
        pending,
        due,
        failing,
        oldest_next_retry_at: oldest?.next_retry_at ?? null,
        recent_errors: recent,
        models,
      };
    });
  }

  async tokens_create(input: TokenInsertInput): Promise<TokenRow> {
    return this.withClient(async (c) => {
      const res = await c.query<TokenRow>(
        `insert into api_tokens
           (user_id, secret_hash, label, scopes, admin, expires_at, revoked_at, created_at, last_used_at)
         values ($1, $2, $3, $4::jsonb, $5, $6, null, $7, null)
         returning id, user_id, secret_hash, label, scopes::text as scopes,
                   admin, expires_at, revoked_at, created_at, last_used_at`,
        [
          input.user_id,
          input.secret_hash,
          input.label,
          input.scopes,
          input.admin,
          input.expires_at,
          input.created_at,
        ],
      );
      return res.rows[0] as TokenRow;
    });
  }

  async tokens_by_hash(hash: string): Promise<TokenRow | null> {
    return this.withClient(async (c) => {
      const res = await c.query<TokenRow>(
        `select id, user_id, secret_hash, label, scopes::text as scopes,
                admin, expires_at, revoked_at, created_at, last_used_at
           from api_tokens
           where secret_hash = $1
             and revoked_at is null
             and (expires_at is null or expires_at > $2)`,
        [hash, new Date().toISOString()],
      );
      return res.rows[0] ?? null;
    });
  }

  async tokens_by_id(id: number): Promise<TokenRow | null> {
    return this.withClient(async (c) => {
      const res = await c.query<TokenRow>(
        `select id, user_id, secret_hash, label, scopes::text as scopes,
                admin, expires_at, revoked_at, created_at, last_used_at
           from api_tokens where id = $1`,
        [id],
      );
      return res.rows[0] ?? null;
    });
  }

  async tokens_list(user_id: number): Promise<TokenRow[]> {
    return this.withClient(async (c) => {
      const res = await c.query<TokenRow>(
        `select id, user_id, secret_hash, label, scopes::text as scopes,
                admin, expires_at, revoked_at, created_at, last_used_at
           from api_tokens
           where user_id = $1
             and revoked_at is null
             and (expires_at is null or expires_at > $2)
           order by created_at desc, id desc`,
        [user_id, new Date().toISOString()],
      );
      return res.rows;
    });
  }

  async tokens_revoke(id: number, revoked_at: string): Promise<TokenRow | null> {
    return this.withClient(async (c) => {
      const res = await c.query<TokenRow>(
        `update api_tokens set revoked_at = coalesce(revoked_at, $1)
           where id = $2
         returning id, user_id, secret_hash, label, scopes::text as scopes,
                   admin, expires_at, revoked_at, created_at, last_used_at`,
        [revoked_at, id],
      );
      return res.rows[0] ?? null;
    });
  }

  async tokens_revoke_by_user(user_id: number, revoked_at: string): Promise<void> {
    await this.withClient((c) =>
      c.query(
        "update api_tokens set revoked_at = coalesce(revoked_at, $1) where user_id = $2",
        [revoked_at, user_id],
      ),
    );
  }

  async tokens_touch_last_used(id: number, when: string): Promise<void> {
    await this.withClient((c) =>
      c.query("update api_tokens set last_used_at = $1 where id = $2", [when, id]),
    );
  }
}

function hydrateRepo(row: {
  id: number;
  slug: string;
  path_config: unknown;
  created_at: string;
}): RepoRow {
  // path_config arrives as an already-parsed object from jsonb. RepoRow
  // types it as string | null (the SQLite raw shape); serialize it back
  // to a string so the kernel's JSON.parse path is uniform across
  // adapters.
  return {
    id: row.id,
    slug: row.slug,
    path_config: row.path_config === null || row.path_config === undefined
      ? null
      : JSON.stringify(row.path_config),
    created_at: row.created_at,
  };
}

export const postgresAdapter: StorageAdapter = {
  scheme: "postgres",
  async open(config: OpenConfig): Promise<Storage> {
    const url = parsePostgresUrl(config.database);
    const storage = new PostgresStorage(url);
    await storage.migrate();
    return storage;
  },
};
