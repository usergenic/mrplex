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
import pg, { Pool, type PoolClient } from "pg";
import { normalizeKey } from "../kernel/casefold.js";
import { KernelError } from "../kernel/errors.js";
import { contentHash } from "../markdown/content-hash.js";
import type { SearchPlan } from "../storage/search-plan.js";
import type {
  AdjacentLink,
  BacklogRow,
  BacklogStatus,
  ChunkRow,
  ChunkUpsertInput,
  DocumentRow,
  HistoryOptions,
  LinkEdgeInput,
  LinkRow,
  OpenConfig,
  RepoRow,
  Storage,
  StorageAdapter,
  VectorSearchHit,
  VersionInsertInput,
  VersionRow,
  VersionsListOptions,
  VersionsSinceOptions,
  VersionsSinceResult,
} from "../storage/types.js";
import {
  GLOBAL_SCAN_CAP,
  SAFE_HEAD_TAIL,
  safeFrontier,
  safeHeadFromTail,
} from "../storage/versions-since.js";
import { compileSearchPlan } from "./compile-postgres.js";
import { isRegexInvalid, isSerializationRetryable, isVersionRaceViolation } from "./errors.js";
import { migrate } from "./migrations/index.js";

// PG type OID for INT8 (bigint). We parse it to a JS number with a
// SafeInteger guard so schema drift (an id truly exceeding 2^53) fails
// loud, not silently rounds. The parser is installed on a per-pool
// TypeOverrides so importing this adapter never mutates the
// process-wide `pg.types` registry.
const PG_OID_INT8 = 20;

function safeInt8Parser(val: string): number {
  const n = Number(val);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`postgres int8 value ${val} is not a safe JS integer`);
  }
  return n;
}

function makeTypeOverrides(): pg.CustomTypesConfig {
  // pg's TypeOverrides constructor takes an optional parent registry
  // and lets you override per OID. We narrow the return to
  // CustomTypesConfig (the Pool option's shape) so callers see the
  // config object rather than the concrete TypeOverrides class.
  // biome-ignore lint/suspicious/noExplicitAny: pg's types export lacks TypeOverrides.
  const overrides = new (pg as any).TypeOverrides();
  overrides.setTypeParser(PG_OID_INT8, safeInt8Parser);
  return overrides;
}

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
  author: string;
  created_at: string;
  content_hash: string | null;
};

class PostgresStorage implements Storage {
  private readonly pool: Pool;
  private readonly txClient: AsyncLocalStorage<PoolClient>;
  // Savepoint depth per-tx-client; keyed off the client object.
  private readonly txDepthByClient = new WeakMap<PoolClient, number>();

  constructor(url: string) {
    this.pool = new Pool({ connectionString: url, types: makeTypeOverrides() });
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
        // Retry serialization failures AND partial-index race violations.
        // Both indicate a concurrent writer beat us; a fresh tx re-runs
        // the kernel's app-level pre-check which raises the right
        // KernelError (create_conflict / stale_prev / path_taken).
        const retryable = isSerializationRetryable(err) || isVersionRaceViolation(err);
        if (retryable && attempt < maxAttempts) {
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
    // Unreachable: the loop either returns or throws on every attempt.
    throw new Error("tx: retry loop exited without decision (unreachable)");
  }

  async repos_list(): Promise<RepoRow[]> {
    return this.withClient(async (c) => {
      const res = await c.query<RepoRawRow>(
        "select id, slug, path_config, link_config, created_at from repos order by slug",
      );
      return res.rows.map(hydrateRepo);
    });
  }

  async repos_create(input: { slug: string; created_at: string }): Promise<RepoRow> {
    return this.withClient(async (c) => {
      const res = await c.query<RepoRawRow>(
        "insert into repos(slug, slug_norm, created_at) values ($1, $2, $3) returning id, slug, path_config, link_config, created_at",
        [input.slug, normalizeKey(input.slug), input.created_at],
      );
      return hydrateRepo(res.rows[0] as never);
    });
  }

  async repos_rename(id: number, new_slug: string): Promise<RepoRow> {
    return this.withClient(async (c) => {
      const res = await c.query<RepoRawRow>(
        "update repos set slug = $1, slug_norm = $2 where id = $3 returning id, slug, path_config, link_config, created_at",
        [new_slug, normalizeKey(new_slug), id],
      );
      if (res.rows.length === 0) throw new Error(`repos_rename: repo ${id} not found`);
      return hydrateRepo(res.rows[0] as never);
    });
  }

  async repos_set_path_config(id: number, path_config: string | null): Promise<RepoRow> {
    return this.withClient(async (c) => {
      // path_config on the wire is JSON text; store as jsonb.
      const res = await c.query<RepoRawRow>(
        "update repos set path_config = $1::jsonb where id = $2 returning id, slug, path_config, link_config, created_at",
        [path_config, id],
      );
      if (res.rows.length === 0) throw new Error(`repos_set_path_config: repo ${id} not found`);
      return hydrateRepo(res.rows[0] as never);
    });
  }

  async repos_set_link_config(id: number, link_config: string | null): Promise<RepoRow> {
    return this.withClient(async (c) => {
      // link_config on the wire is JSON text; store as jsonb.
      const res = await c.query<RepoRawRow>(
        "update repos set link_config = $1::jsonb where id = $2 returning id, slug, path_config, link_config, created_at",
        [link_config, id],
      );
      if (res.rows.length === 0) throw new Error(`repos_set_link_config: repo ${id} not found`);
      return hydrateRepo(res.rows[0] as never);
    });
  }

  async repos_by_slug(slug: string): Promise<RepoRow | null> {
    return this.withClient(async (c) => {
      const res = await c.query<RepoRawRow>(
        "select id, slug, path_config, link_config, created_at from repos where slug_norm = $1",
        [normalizeKey(slug)],
      );
      return res.rows[0] ? hydrateRepo(res.rows[0] as never) : null;
    });
  }

  async repos_by_id(id: number): Promise<RepoRow | null> {
    return this.withClient(async (c) => {
      const res = await c.query<RepoRawRow>(
        "select id, slug, path_config, link_config, created_at from repos where id = $1",
        [id],
      );
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
             (document_id, repo_id, prev_id, next_id, path, path_norm,
              frontmatter_raw, frontmatter, body, author, created_at, content_hash)
           values ($1, $2, $3, null, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
           returning id, document_id, repo_id, prev_id, next_id, path,
                     frontmatter_raw, frontmatter, body, author, created_at, content_hash`,
          [
            input.document_id,
            input.repo_id,
            input.prev_id,
            input.path,
            normalizeKey(input.path),
            input.frontmatter_raw,
            JSON.stringify(input.frontmatter),
            input.body,
            input.author,
            input.created_at,
            contentHash(input.frontmatter_raw, input.body),
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
                frontmatter_raw, frontmatter, body, author, created_at, content_hash
         from versions where id = $1`,
        [id],
      );
      return (res.rows[0] as VersionRow | undefined) ?? null;
    });
  }

  async versions_current_by_paths(
    repo_id: number,
    paths: readonly string[],
  ): Promise<VersionRow[]> {
    if (paths.length === 0) return [];
    const norms = paths.map(normalizeKey);
    return this.withClient(async (c) => {
      const res = await c.query<VersionRawRow>(
        `select id, document_id, repo_id, prev_id, next_id, path,
                frontmatter_raw, frontmatter, body, author, created_at, content_hash
         from versions
         where repo_id = $1 and next_id is null and path_norm = ANY($2::text[])`,
        [repo_id, norms],
      );
      return res.rows as VersionRow[];
    });
  }

  async version_current(repo_id: number, path: string): Promise<VersionRow | null> {
    return this.withClient(async (c) => {
      // Case-insensitive identity: fold the query key to path_norm (§3.5.1).
      const res = await c.query<VersionRawRow>(
        `select id, document_id, repo_id, prev_id, next_id, path,
                frontmatter_raw, frontmatter, body, author, created_at, content_hash
         from versions where repo_id = $1 and path_norm = $2 and next_id is null`,
        [repo_id, normalizeKey(path)],
      );
      return (res.rows[0] as VersionRow | undefined) ?? null;
    });
  }

  async versions_live_by_repo(repo_id: number): Promise<VersionRow[]> {
    return this.withClient(async (c) => {
      const res = await c.query<VersionRawRow>(
        `select id, document_id, repo_id, prev_id, next_id, path,
                frontmatter_raw, frontmatter, body, author, created_at, content_hash
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

  // Links derived index (design §11.2, migration 0003_links.sql).

  async links_replace(
    repo_id: number,
    source_id: number,
    edges: readonly LinkEdgeInput[],
  ): Promise<void> {
    return this.tx(async () => {
      return this.withClient(async (c) => {
        await c.query("delete from links where source_id = $1", [source_id]);
        for (const e of edges) {
          await c.query(
            `insert into links (repo_id, source_id, ord, field, target_raw, target_norm, target_id)
             values ($1, $2, $3, $4, $5, $6, $7)`,
            [repo_id, source_id, e.ord, e.field, e.target_raw, e.target_norm, e.target_id],
          );
        }
      });
    });
  }

  async links_clear(source_id: number): Promise<void> {
    return this.withClient(async (c) => {
      await c.query("delete from links where source_id = $1", [source_id]);
    });
  }

  async links_resolve_dangling(
    repo_id: number,
    target_norm: string,
    document_id: number,
  ): Promise<number> {
    return this.withClient(async (c) => {
      const res = await c.query(
        `update links set target_id = $1
         where repo_id = $2 and target_norm = $3 and target_id is null
           and source_id <> $1`,
        [document_id, repo_id, target_norm],
      );
      return res.rowCount ?? 0;
    });
  }

  async links_by_source(source_id: number): Promise<LinkRow[]> {
    return this.withClient(async (c) => {
      const res = await c.query<LinkRow>(
        `select repo_id, source_id, ord, field, target_raw, target_norm, target_id
         from links where source_id = $1 order by ord`,
        [source_id],
      );
      return res.rows;
    });
  }

  async links_by_repo(repo_id: number): Promise<LinkRow[]> {
    return this.withClient(async (c) => {
      const res = await c.query<LinkRow>(
        `select repo_id, source_id, ord, field, target_raw, target_norm, target_id
         from links where repo_id = $1 order by source_id, ord`,
        [repo_id],
      );
      return res.rows;
    });
  }

  async links_adjacent_out(
    repo_id: number,
    source_ids: readonly number[],
  ): Promise<AdjacentLink[]> {
    if (source_ids.length === 0) return [];
    // `= ANY($2::bigint[])` binds the whole id batch as one array param, so
    // there's no per-id placeholder and no Postgres parameter-limit concern.
    return this.withClient(async (c) => {
      const res = await c.query<AdjacentLink>(
        `select distinct source_id, target_id, field
         from links
         where repo_id = $1 and target_id is not null and source_id = ANY($2::bigint[])`,
        [repo_id, source_ids],
      );
      return res.rows;
    });
  }

  async links_adjacent_in(repo_id: number, target_ids: readonly number[]): Promise<AdjacentLink[]> {
    if (target_ids.length === 0) return [];
    return this.withClient(async (c) => {
      const res = await c.query<AdjacentLink>(
        `select distinct source_id, target_id, field
         from links
         where repo_id = $1 and target_id is not null and target_id = ANY($2::bigint[])`,
        [repo_id, target_ids],
      );
      return res.rows;
    });
  }

  async versions_current_by_documents(
    repo_id: number,
    document_ids: readonly number[],
  ): Promise<VersionRow[]> {
    if (document_ids.length === 0) return [];
    return this.withClient(async (c) => {
      const res = await c.query<VersionRawRow>(
        `select id, document_id, repo_id, prev_id, next_id, path,
                frontmatter_raw, frontmatter, body, author, created_at, content_hash
         from versions
         where repo_id = $1 and next_id is null and document_id = ANY($2::bigint[])`,
        [repo_id, document_ids],
      );
      return res.rows as VersionRow[];
    });
  }

  async versions_live_document_ids_matching(
    repo_id: number,
    path_regexes: readonly string[],
  ): Promise<number[]> {
    if (path_regexes.length === 0) return [];
    // `path ~ ANY($2)` matches against the whole regex array in one predicate;
    // POSIX ARE, same engine the scope-glob compiler uses.
    return this.withClient(async (c) => {
      const res = await c.query<{ document_id: number }>(
        `select document_id from versions
         where repo_id = $1 and next_id is null and path ~ ANY($2::text[])`,
        [repo_id, path_regexes],
      );
      return res.rows.map((r) => r.document_id);
    });
  }

  async versions_search(plan: SearchPlan): Promise<VersionRow[]> {
    if (plan.repo_ids.length === 0) return [];
    if (plan.scope.kind === "deny_all") return [];
    return this.withClient(async (c) => {
      const { sql, params } = compileSearchPlan(plan);
      try {
        const res = await c.query<VersionRawRow>(sql, params);
        return res.rows as VersionRow[];
      } catch (err) {
        // A user regex that survives CEL parse but fails Postgres's
        // POSIX ARE compiler surfaces as SQLSTATE 2201B. Map it to
        // filter_invalid so the wire error catalog stays consistent
        // (SQLite's RE2 UDF returns 0 for bad patterns, so this is
        // the PG-only surface for the same failure mode).
        if (isRegexInvalid(err)) {
          throw new KernelError("filter_invalid", {
            reason: `invalid regex in filter: ${err.message ?? "2201B"}`,
          });
        }
        throw err;
      }
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
                  frontmatter_raw, frontmatter, body, author, created_at, content_hash, 0 as depth
             from versions
             where document_id = $1 and next_id is null
           union all
           select v.id, v.document_id, v.repo_id, v.prev_id, v.next_id, v.path,
                  v.frontmatter_raw, v.frontmatter, v.body, v.author, v.created_at,
                  v.content_hash, c.depth + 1
             from versions v
             join chain c on v.id = c.prev_id
         )
         select id, document_id, repo_id, prev_id, next_id, path,
                frontmatter_raw, frontmatter, body, author, created_at, content_hash
         from chain${where}
         order by depth asc${limitClause}`,
        params,
      );
      return res.rows as VersionRow[];
    });
  }

  async versions_list(opts: VersionsListOptions): Promise<VersionRow[]> {
    return this.withClient(async (c) => {
      // 1. Document ids in scope. Empty globs → all docs; else match by path
      //    regex (POSIX ARE, `path ~ ANY`), with `ever` gating live-only.
      const hasGlob = opts.path_regexes.length > 0;
      let docIds: number[];
      if (!hasGlob) {
        const res = await c.query<{ document_id: number }>(
          "select distinct document_id from versions where repo_id = $1",
          [opts.repo_id],
        );
        docIds = res.rows.map((r) => Number(r.document_id));
      } else {
        const liveClause = opts.ever ? "" : " and next_id is null";
        const res = await c.query<{ document_id: number }>(
          `select distinct document_id from versions
           where repo_id = $1${liveClause} and path ~ ANY($2::text[])`,
          [opts.repo_id, opts.path_regexes as string[]],
        );
        docIds = res.rows.map((r) => Number(r.document_id));
      }
      if (docIds.length === 0) return [];

      // 2. Their versions, interleaved by id, within cursor bounds.
      const params: (number | number[])[] = [docIds];
      let sql = `select id, document_id, repo_id, prev_id, next_id, path,
                        frontmatter_raw, frontmatter, body, author, created_at, content_hash
                 from versions where document_id = ANY($1::bigint[])`;
      if (opts.after_id !== undefined) {
        params.push(opts.after_id);
        sql += ` and id > $${params.length}`;
      }
      if (opts.until_id !== undefined) {
        params.push(opts.until_id);
        sql += ` and id <= $${params.length}`;
      }
      params.push(opts.limit);
      sql += ` order by id ${opts.order === "desc" ? "desc" : "asc"} limit $${params.length}`;
      const res = await c.query<VersionRawRow>(sql, params);
      return res.rows as VersionRow[];
    });
  }

  async versions_since(opts: VersionsSinceOptions): Promise<VersionsSinceResult> {
    return this.withClient(async (c) => {
      // Global scan (id, repo, age) — gaps are only meaningful on the global
      // id sequence; the repo filter narrows the delivered rows only. On PG
      // burned ids (rolled-back nextval) and commit-visibility skew make gaps
      // routine, which is exactly what the safety window handles.
      const lightRes = await c.query<{ id: number; repo_id: number; created_at: string }>(
        "select id, repo_id, created_at from versions where id > $1 order by id asc limit $2",
        [opts.after_id, GLOBAL_SCAN_CAP],
      );
      const { upper_id } = safeFrontier(
        lightRes.rows.map((r) => ({
          id: Number(r.id),
          repo_id: Number(r.repo_id),
          created_at_ms: Date.parse(r.created_at),
        })),
        opts.after_id,
        opts.repo_id,
        opts.limit,
        opts.now_ms,
        opts.window_ms,
      );
      if (upper_id <= opts.after_id) return { rows: [], next_id: opts.after_id };
      const repoClause = opts.repo_id === undefined ? "" : " and repo_id = $3";
      const params: number[] =
        opts.repo_id === undefined
          ? [opts.after_id, upper_id]
          : [opts.after_id, upper_id, opts.repo_id];
      const res = await c.query<VersionRawRow>(
        `select id, document_id, repo_id, prev_id, next_id, path,
                frontmatter_raw, frontmatter, body, author, created_at, content_hash
         from versions
         where id > $1 and id <= $2${repoClause}
         order by id asc`,
        params,
      );
      return { rows: res.rows as VersionRow[], next_id: upper_id };
    });
  }

  async versions_paths_by_ids(ids: readonly number[]): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    if (ids.length === 0) return map;
    return this.withClient(async (c) => {
      const res = await c.query<{ id: number; path: string }>(
        "select id, path from versions where id = any($1)",
        [ids as number[]],
      );
      for (const r of res.rows) map.set(Number(r.id), r.path);
      return map;
    });
  }

  async versions_safe_head(now_ms: number, window_ms: number): Promise<number> {
    return this.withClient(async (c) => {
      const res = await c.query<{ id: number; created_at: string }>(
        "select id, created_at from versions order by id desc limit $1",
        [SAFE_HEAD_TAIL],
      );
      const tail = res.rows
        .map((r) => ({ id: Number(r.id), repo_id: 0, created_at_ms: Date.parse(r.created_at) }))
        .reverse(); // ascending by id
      return safeHeadFromTail(tail, now_ms, window_ms);
    });
  }

  async versions_live_index(opts: {
    repo_id: number;
    through_id: number;
    after_id: number;
    limit: number;
  }): Promise<{ id: number; path: string; content_hash: string | null }[]> {
    return this.withClient(async (c) => {
      const res = await c.query<{ id: number; path: string; content_hash: string | null }>(
        `select id, path, content_hash from versions
         where repo_id = $1 and next_id is null and id > $2 and id <= $3
         order by id asc limit $4`,
        [opts.repo_id, opts.after_id, opts.through_id, opts.limit],
      );
      return res.rows.map((r) => ({
        id: Number(r.id),
        path: r.path,
        content_hash: r.content_hash,
      }));
    });
  }

  async versions_missing_content_hash(opts: {
    repo_id?: number;
    after_id: number;
    limit: number;
  }): Promise<{ id: number; frontmatter_raw: string; body: string }[]> {
    return this.withClient(async (c) => {
      const repoClause = opts.repo_id === undefined ? "" : " and repo_id = $3";
      const params =
        opts.repo_id === undefined
          ? [opts.after_id, opts.limit]
          : [opts.after_id, opts.limit, opts.repo_id];
      const res = await c.query<{ id: number; frontmatter_raw: string; body: string }>(
        `select id, frontmatter_raw, body from versions
         where content_hash is null and id > $1${repoClause}
         order by id asc limit $2`,
        params,
      );
      return res.rows.map((r) => ({
        id: Number(r.id),
        frontmatter_raw: r.frontmatter_raw,
        body: r.body,
      }));
    });
  }

  async versions_set_content_hash(
    updates: readonly { id: number; content_hash: string }[],
  ): Promise<void> {
    if (updates.length === 0) return;
    return this.tx(async () => {
      await this.withClient(async (c) => {
        for (const u of updates) {
          await c.query("update versions set content_hash = $1 where id = $2", [
            u.content_hash,
            u.id,
          ]);
        }
      });
    });
  }

  // Verify scans (docs/verify-plan.md §4). Read-only, keyset by id. No fts
  // scans here: Postgres's fts_tsv is a generated column that cannot drift, so
  // the kernel skips the `fts` family (§2.4) — this adapter deliberately omits
  // the VerifyFtsScans capability.

  async versions_all(opts: {
    repo_id?: number;
    after_id: number;
    limit: number;
  }): Promise<VersionRow[]> {
    return this.withClient(async (c) => {
      const repoClause = opts.repo_id === undefined ? "" : " and repo_id = $3";
      const params =
        opts.repo_id === undefined
          ? [opts.after_id, opts.limit]
          : [opts.after_id, opts.limit, opts.repo_id];
      const res = await c.query<VersionRawRow>(
        `select id, document_id, repo_id, prev_id, next_id, path,
                frontmatter_raw, frontmatter, body, author, created_at, content_hash
         from versions
         where id > $1${repoClause}
         order by id asc limit $2`,
        params,
      );
      return res.rows as VersionRow[];
    });
  }

  async documents_all(opts: {
    repo_id?: number;
    after_id: number;
    limit: number;
  }): Promise<DocumentRow[]> {
    return this.withClient(async (c) => {
      const repoClause = opts.repo_id === undefined ? "" : " and repo_id = $3";
      const params =
        opts.repo_id === undefined
          ? [opts.after_id, opts.limit]
          : [opts.after_id, opts.limit, opts.repo_id];
      const res = await c.query<DocumentRow>(
        `select id, repo_id from documents
         where id > $1${repoClause}
         order by id asc limit $2`,
        params,
      );
      return res.rows as DocumentRow[];
    });
  }

  async chunks_all_version_ids(opts: { after_id: number; limit: number }): Promise<number[]> {
    return this.withClient(async (c) => {
      const res = await c.query<{ version_id: number }>(
        `select distinct version_id from chunks
         where version_id > $1
         order by version_id asc limit $2`,
        [opts.after_id, opts.limit],
      );
      return res.rows.map((r) => Number(r.version_id));
    });
  }

  async backlog_all_version_ids(opts: { after_id: number; limit: number }): Promise<number[]> {
    return this.withClient(async (c) => {
      const res = await c.query<{ version_id: number }>(
        `select version_id from embedding_backlog
         where version_id > $1
         order by version_id asc limit $2`,
        [opts.after_id, opts.limit],
      );
      return res.rows.map((r) => Number(r.version_id));
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
      const len = c.embedding.length;
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
      // Collapse the three counts + oldest into one query via `filter`
      // and a min() aggregate — one round-trip instead of four.
      const summary = (
        await c.query<{
          pending: string;
          due: string;
          failing: string;
          oldest: string | null;
        }>(
          `select count(*)::text as pending,
                  count(*) filter (where next_retry_at is null or next_retry_at <= $1)::text as due,
                  count(*) filter (where attempts > 0)::text as failing,
                  min(next_retry_at) filter (where next_retry_at is not null) as oldest
             from embedding_backlog`,
          [now],
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
          "select model, count(*)::int as chunk_count from chunks group by model order by model",
        )
      ).rows;
      return {
        pending: Number(summary?.pending ?? "0"),
        due: Number(summary?.due ?? "0"),
        failing: Number(summary?.failing ?? "0"),
        oldest_next_retry_at: summary?.oldest ?? null,
        recent_errors: recent,
        models,
      };
    });
  }

  /**
   * Refuse to open a pre-noauth database. Such a database carries an
   * `api_tokens` table; the collapsed migration chain starts at 0001 and
   * would run against a mismatched schema. Probe for the legacy marker and
   * refuse with a clear message (noauth plan §1 — no upgrade path).
   */
  async assertNotLegacy(): Promise<void> {
    const res = await this.withClient((c) =>
      c.query<{ exists: boolean }>("select to_regclass('public.api_tokens') is not null as exists"),
    );
    if (res.rows[0]?.exists) {
      throw new Error(
        "this database predates the no-auth schema (found legacy api_tokens table). " +
          "Pre-noauth databases are unsupported — re-ingest into a fresh database.",
      );
    }
  }
}

type RepoRawRow = {
  id: number;
  slug: string;
  path_config: unknown;
  link_config: unknown;
  created_at: string;
};

function hydrateRepo(row: RepoRawRow): RepoRow {
  // path_config / link_config arrive as already-parsed objects from jsonb.
  // RepoRow types them as string | null (the SQLite raw shape); serialize
  // back to a string so the kernel's JSON.parse path is uniform across
  // adapters.
  const asText = (v: unknown): string | null =>
    v === null || v === undefined ? null : JSON.stringify(v);
  return {
    id: row.id,
    slug: row.slug,
    path_config: asText(row.path_config),
    link_config: asText(row.link_config),
    created_at: row.created_at,
  };
}

export const postgresAdapter: StorageAdapter = {
  scheme: "postgres",
  async open(config: OpenConfig): Promise<Storage> {
    const url = parsePostgresUrl(config.database);
    const storage = new PostgresStorage(url);
    await storage.assertNotLegacy();
    await storage.migrate();
    return storage;
  },
};
