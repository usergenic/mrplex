import { RE2JS } from "@bufbuild/re2";
import Database from "better-sqlite3";
import { normalizeKey } from "../kernel/casefold.js";
import { contentHash } from "../markdown/content-hash.js";
import type { SearchPlan } from "../storage/search-plan.js";
import type {
  AdjacentLink,
  BacklogRow,
  BacklogStatus,
  ChunkRow,
  ChunkUpsertInput,
  DocumentRow,
  FrontmatterJson,
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
  author: string;
  created_at: string;
  content_hash: string | null;
};

const hydrateVersion = (row: VersionRawRow): VersionRow => ({
  ...row,
  frontmatter: JSON.parse(row.frontmatter) as FrontmatterJson,
});

/**
 * Max ids per `IN (?,…)` chunk. SQLite's SQLITE_MAX_VARIABLE_NUMBER is 32766
 * in modern builds; we leave generous headroom for the other bound params
 * (repo_id, etc.) a query may carry alongside the id list.
 */
const ID_CHUNK_SIZE = 20000;

/**
 * Run an `IN`-list query in chunks so a large id batch can't overflow
 * SQLite's bound-variable cap, and flatten the per-chunk rows. `run` receives
 * the `?,?,…` placeholder string and the chunk's ids. Callers whose query is
 * `DISTINCT` and partitions rows by the chunked column (e.g. `source_id IN …`)
 * get a correct union with no extra dedup; a `<= ID_CHUNK_SIZE` batch runs as
 * a single query. An empty batch runs nothing.
 */
function chunkedInList<T>(
  ids: readonly number[],
  run: (placeholders: string, chunk: readonly number[]) => T[],
): T[] {
  if (ids.length === 0) return [];
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + ID_CHUNK_SIZE);
    const ph = chunk.map(() => "?").join(",");
    out.push(...run(ph, chunk));
  }
  return out;
}

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

  async repos_list(): Promise<RepoRow[]> {
    return this.db
      .prepare("select id, slug, path_config, link_config, created_at from repos order by slug")
      .all() as RepoRow[];
  }

  async repos_create(input: { slug: string; created_at: string }): Promise<RepoRow> {
    return this.db
      .prepare(
        "insert into repos(slug, slug_norm, created_at) values (?, ?, ?) returning id, slug, path_config, link_config, created_at",
      )
      .get(input.slug, normalizeKey(input.slug), input.created_at) as RepoRow;
  }

  async repos_rename(id: number, new_slug: string): Promise<RepoRow> {
    const row = this.db
      .prepare(
        "update repos set slug = ?, slug_norm = ? where id = ? returning id, slug, path_config, link_config, created_at",
      )
      .get(new_slug, normalizeKey(new_slug), id) as RepoRow | undefined;
    if (!row) throw new Error(`repos_rename: repo ${id} not found`);
    return row;
  }

  async repos_set_path_config(id: number, path_config: string | null): Promise<RepoRow> {
    const row = this.db
      .prepare(
        "update repos set path_config = ? where id = ? returning id, slug, path_config, link_config, created_at",
      )
      .get(path_config, id) as RepoRow | undefined;
    if (!row) throw new Error(`repos_set_path_config: repo ${id} not found`);
    return row;
  }

  async repos_set_link_config(id: number, link_config: string | null): Promise<RepoRow> {
    const row = this.db
      .prepare(
        "update repos set link_config = ? where id = ? returning id, slug, path_config, link_config, created_at",
      )
      .get(link_config, id) as RepoRow | undefined;
    if (!row) throw new Error(`repos_set_link_config: repo ${id} not found`);
    return row;
  }

  async repos_by_slug(slug: string): Promise<RepoRow | null> {
    // Case-insensitive identity: fold the query key to slug_norm (§3.5.1).
    return (
      (this.db
        .prepare(
          "select id, slug, path_config, link_config, created_at from repos where slug_norm = ?",
        )
        .get(normalizeKey(slug)) as RepoRow | undefined) ?? null
    );
  }

  async repos_by_id(id: number): Promise<RepoRow | null> {
    return (
      (this.db
        .prepare("select id, slug, path_config, link_config, created_at from repos where id = ?")
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
            (document_id, repo_id, prev_id, next_id, path, path_norm,
             frontmatter_raw, frontmatter, body, author, created_at, content_hash)
           values (?, ?, ?, null, ?, ?, ?, ?, ?, ?, ?, ?)
           returning id, document_id, repo_id, prev_id, next_id, path,
                     frontmatter_raw, frontmatter, body, author, created_at, content_hash`,
        )
        .get(
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
                frontmatter_raw, frontmatter, body, author, created_at, content_hash
         from versions where id = ?`,
      )
      .get(id) as VersionRawRow | undefined;
    return row ? hydrateVersion(row) : null;
  }

  async version_current(repo_id: number, path: string): Promise<VersionRow | null> {
    // Case-insensitive identity: fold the query key to path_norm (§3.5.1).
    const row = this.db
      .prepare(
        `select id, document_id, repo_id, prev_id, next_id, path,
                frontmatter_raw, frontmatter, body, author, created_at, content_hash
         from versions where repo_id = ? and path_norm = ? and next_id is null`,
      )
      .get(repo_id, normalizeKey(path)) as VersionRawRow | undefined;
    return row ? hydrateVersion(row) : null;
  }

  async versions_current_by_paths(
    repo_id: number,
    paths: readonly string[],
  ): Promise<VersionRow[]> {
    if (paths.length === 0) return [];
    const norms = paths.map(normalizeKey);
    const ph = norms.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `select id, document_id, repo_id, prev_id, next_id, path,
                frontmatter_raw, frontmatter, body, author, created_at, content_hash
         from versions
         where repo_id = ? and next_id is null and path_norm in (${ph})`,
      )
      .all(repo_id, ...norms) as VersionRawRow[];
    return rows.map(hydrateVersion);
  }

  async versions_live_by_repo(repo_id: number): Promise<VersionRow[]> {
    const rows = this.db
      .prepare(
        `select id, document_id, repo_id, prev_id, next_id, path,
                frontmatter_raw, frontmatter, body, author, created_at, content_hash
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

  // Links derived index (design §11.2, migration 0005_links.sql).

  async links_replace(
    repo_id: number,
    source_id: number,
    edges: readonly LinkEdgeInput[],
  ): Promise<void> {
    return this.tx(async () => {
      this.db.prepare("delete from links where source_id = ?").run(source_id);
      if (edges.length === 0) return;
      const insert = this.db.prepare(
        `insert into links (repo_id, source_id, ord, field, target_raw, target_norm, target_id)
         values (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const e of edges) {
        insert.run(repo_id, source_id, e.ord, e.field, e.target_raw, e.target_norm, e.target_id);
      }
    });
  }

  async links_clear(source_id: number): Promise<void> {
    this.db.prepare("delete from links where source_id = ?").run(source_id);
  }

  async links_resolve_dangling(
    repo_id: number,
    target_norm: string,
    document_id: number,
  ): Promise<number> {
    const res = this.db
      .prepare(
        `update links set target_id = ?
         where repo_id = ? and target_norm = ? and target_id is null
           and source_id <> ?`,
      )
      .run(document_id, repo_id, target_norm, document_id);
    return res.changes;
  }

  async links_by_source(source_id: number): Promise<LinkRow[]> {
    return this.db
      .prepare(
        `select repo_id, source_id, ord, field, target_raw, target_norm, target_id
         from links where source_id = ? order by ord`,
      )
      .all(source_id) as LinkRow[];
  }

  async links_by_repo(repo_id: number): Promise<LinkRow[]> {
    return this.db
      .prepare(
        `select repo_id, source_id, ord, field, target_raw, target_norm, target_id
         from links where repo_id = ? order by source_id, ord`,
      )
      .all(repo_id) as LinkRow[];
  }

  async links_adjacent_out(
    repo_id: number,
    source_ids: readonly number[],
  ): Promise<AdjacentLink[]> {
    // Chunk the id batch under SQLITE_MAX_VARIABLE_NUMBER (§graph WS1): a
    // hub-heavy repo's neighbor fan-out can exceed the bound-variable cap.
    // Chunks are disjoint by source_id, so unioning the DISTINCT results needs
    // no further dedup.
    return chunkedInList<AdjacentLink>(
      source_ids,
      (ph, ids) =>
        this.db
          .prepare(
            `select distinct source_id, target_id, field
           from links
           where repo_id = ? and target_id is not null and source_id in (${ph})`,
          )
          .all(repo_id, ...ids) as AdjacentLink[],
    );
  }

  async links_adjacent_in(repo_id: number, target_ids: readonly number[]): Promise<AdjacentLink[]> {
    return chunkedInList<AdjacentLink>(
      target_ids,
      (ph, ids) =>
        this.db
          .prepare(
            `select distinct source_id, target_id, field
           from links
           where repo_id = ? and target_id is not null and target_id in (${ph})`,
          )
          .all(repo_id, ...ids) as AdjacentLink[],
    );
  }

  async versions_current_by_documents(
    repo_id: number,
    document_ids: readonly number[],
  ): Promise<VersionRow[]> {
    const rows = await chunkedInList<VersionRawRow>(
      document_ids,
      (ph, ids) =>
        this.db
          .prepare(
            `select id, document_id, repo_id, prev_id, next_id, path,
                  frontmatter_raw, frontmatter, body, author, created_at, content_hash
           from versions
           where repo_id = ? and next_id is null and document_id in (${ph})`,
          )
          .all(repo_id, ...ids) as VersionRawRow[],
    );
    return rows.map(hydrateVersion);
  }

  async versions_live_document_ids_matching(
    repo_id: number,
    path_regexes: readonly string[],
  ): Promise<number[]> {
    if (path_regexes.length === 0) return [];
    // Match live paths in SQL via the regexp() UDF — one OR'd term per pattern.
    // Pattern lists are tiny (a graph call's root globs), so no chunking; the
    // repo-scoped row set is what could be large, and it never leaves SQLite.
    const ors = path_regexes.map(() => "regexp(?, path)").join(" OR ");
    const rows = this.db
      .prepare(
        `select document_id from versions
         where repo_id = ? and next_id is null and (${ors})`,
      )
      .all(repo_id, ...path_regexes) as { document_id: number }[];
    return rows.map((r) => r.document_id);
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
           frontmatter_raw, frontmatter, body, author, created_at, content_hash, depth
         ) as (
           select id, document_id, repo_id, prev_id, next_id, path,
                  frontmatter_raw, frontmatter, body, author, created_at, content_hash, 0
             from versions
             where document_id = ? and next_id is null
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
      )
      .all(...params) as VersionRawRow[];
    return rows.map(hydrateVersion);
  }

  async versions_list(opts: VersionsListOptions): Promise<VersionRow[]> {
    // 1. Select the document ids in scope. Empty path_regexes → every doc in
    //    the repo; otherwise match paths via the regexp() UDF (same engine the
    //    scope-glob compiler uses). `ever` decides whether a match on ANY
    //    version counts, or only the current one.
    const hasGlob = opts.path_regexes.length > 0;
    const ors = opts.path_regexes.map(() => "regexp(?, path)").join(" OR ");
    let docIds: number[];
    if (!hasGlob) {
      docIds = (
        this.db
          .prepare("select distinct document_id from versions where repo_id = ?")
          .all(opts.repo_id) as { document_id: number }[]
      ).map((r) => r.document_id);
    } else {
      const liveClause = opts.ever ? "" : " and next_id is null";
      docIds = (
        this.db
          .prepare(
            `select distinct document_id from versions
             where repo_id = ?${liveClause} and (${ors})`,
          )
          .all(opts.repo_id, ...opts.path_regexes) as { document_id: number }[]
      ).map((r) => r.document_id);
    }
    if (docIds.length === 0) return [];

    // 2. Walk those documents' versions, interleaved by id, within the cursor
    //    bounds. `ever: false` still returns the WHOLE chain of a selected live
    //    document (history of what lives here now); the path filter only chose
    //    the documents, not which of their versions to include.
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (opts.after_id !== undefined) {
      clauses.push("id > ?");
      params.push(opts.after_id);
    }
    if (opts.until_id !== undefined) {
      clauses.push("id <= ?");
      params.push(opts.until_id);
    }
    const rows = chunkedInList<VersionRawRow>(docIds, (ph, chunk) => {
      const where = [`document_id in (${ph})`, ...clauses].join(" and ");
      return this.db
        .prepare(
          `select id, document_id, repo_id, prev_id, next_id, path,
                  frontmatter_raw, frontmatter, body, author, created_at, content_hash
           from versions where ${where}
           order by id ${opts.order === "desc" ? "desc" : "asc"}
           limit ?`,
        )
        .all(...chunk, ...params, opts.limit) as VersionRawRow[];
    });
    // chunkedInList concatenates per-chunk results; re-sort + re-limit so the
    // global ordering/limit holds when docIds span multiple chunks.
    rows.sort((a, b) => (opts.order === "desc" ? b.id - a.id : a.id - b.id));
    return rows.slice(0, opts.limit).map(hydrateVersion);
  }

  async versions_since(opts: VersionsSinceOptions): Promise<VersionsSinceResult> {
    // Gaps are global, so scan the global id sequence (id, repo, age) — the
    // repo filter never affects gap detection, only the delivered rows. A
    // bounded scan keeps each poll cheap; truncating early only under-delivers
    // (the next poll continues), never crosses a hole.
    const light = this.db
      .prepare(
        `select id, repo_id, created_at from versions
         where id > ? order by id asc limit ?`,
      )
      .all(opts.after_id, GLOBAL_SCAN_CAP) as {
      id: number;
      repo_id: number;
      created_at: string;
    }[];
    const { upper_id } = safeFrontier(
      light.map((r) => ({
        id: r.id,
        repo_id: r.repo_id,
        created_at_ms: Date.parse(r.created_at),
      })),
      opts.after_id,
      opts.repo_id,
      opts.limit,
      opts.now_ms,
      opts.window_ms,
    );
    if (upper_id <= opts.after_id) return { rows: [], next_id: opts.after_id };
    const repoClause = opts.repo_id === undefined ? "" : " and repo_id = ?";
    const params: number[] =
      opts.repo_id === undefined
        ? [opts.after_id, upper_id]
        : [opts.after_id, upper_id, opts.repo_id];
    const rows = this.db
      .prepare(
        `select id, document_id, repo_id, prev_id, next_id, path,
                frontmatter_raw, frontmatter, body, author, created_at, content_hash
         from versions
         where id > ? and id <= ?${repoClause}
         order by id asc`,
      )
      .all(...params) as VersionRawRow[];
    return { rows: rows.map(hydrateVersion), next_id: upper_id };
  }

  async versions_paths_by_ids(ids: readonly number[]): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    const rows = chunkedInList<{ id: number; path: string }>(
      ids,
      (ph, chunk) =>
        this.db.prepare(`select id, path from versions where id in (${ph})`).all(...chunk) as {
          id: number;
          path: string;
        }[],
    );
    for (const r of rows) map.set(r.id, r.path);
    return map;
  }

  async versions_safe_head(now_ms: number, window_ms: number): Promise<number> {
    // The recent tail is all that can hold a hot (unsettled) gap; older gaps
    // are burned and settled by construction.
    const tail = this.db
      .prepare("select id, created_at from versions order by id desc limit ?")
      .all(SAFE_HEAD_TAIL) as { id: number; created_at: string }[];
    tail.reverse(); // ascending by id
    return safeHeadFromTail(
      tail.map((r) => ({ id: r.id, repo_id: 0, created_at_ms: Date.parse(r.created_at) })),
      now_ms,
      window_ms,
    );
  }

  async versions_live_index(opts: {
    repo_id: number;
    through_id: number;
    after_id: number;
    limit: number;
  }): Promise<{ id: number; path: string; content_hash: string | null }[]> {
    return this.db
      .prepare(
        `select id, path, content_hash from versions
         where repo_id = ? and next_id is null and id > ? and id <= ?
         order by id asc limit ?`,
      )
      .all(opts.repo_id, opts.after_id, opts.through_id, opts.limit) as {
      id: number;
      path: string;
      content_hash: string | null;
    }[];
  }

  async versions_missing_content_hash(opts: {
    repo_id?: number;
    after_id: number;
    limit: number;
  }): Promise<{ id: number; frontmatter_raw: string; body: string }[]> {
    const repoClause = opts.repo_id === undefined ? "" : " and repo_id = ?";
    const params =
      opts.repo_id === undefined
        ? [opts.after_id, opts.limit]
        : [opts.after_id, opts.repo_id, opts.limit];
    return this.db
      .prepare(
        `select id, frontmatter_raw, body from versions
         where content_hash is null and id > ?${repoClause}
         order by id asc limit ?`,
      )
      .all(...params) as { id: number; frontmatter_raw: string; body: string }[];
  }

  async versions_set_content_hash(
    updates: readonly { id: number; content_hash: string }[],
  ): Promise<void> {
    if (updates.length === 0) return;
    return this.tx(async () => {
      const stmt = this.db.prepare("update versions set content_hash = ? where id = ?");
      for (const u of updates) stmt.run(u.content_hash, u.id);
    });
  }

  // Verify scans (docs/verify-plan.md §4). Read-only, keyset by id.

  async versions_all(opts: {
    repo_id?: number;
    after_id: number;
    limit: number;
  }): Promise<VersionRow[]> {
    const repoClause = opts.repo_id === undefined ? "" : " and repo_id = ?";
    const params =
      opts.repo_id === undefined
        ? [opts.after_id, opts.limit]
        : [opts.after_id, opts.repo_id, opts.limit];
    const rows = this.db
      .prepare(
        `select id, document_id, repo_id, prev_id, next_id, path,
                frontmatter_raw, frontmatter, body, author, created_at, content_hash
         from versions
         where id > ?${repoClause}
         order by id asc limit ?`,
      )
      .all(...params) as VersionRawRow[];
    return rows.map(hydrateVersion);
  }

  async documents_all(opts: {
    repo_id?: number;
    after_id: number;
    limit: number;
  }): Promise<DocumentRow[]> {
    const repoClause = opts.repo_id === undefined ? "" : " and repo_id = ?";
    const params =
      opts.repo_id === undefined
        ? [opts.after_id, opts.limit]
        : [opts.after_id, opts.repo_id, opts.limit];
    return this.db
      .prepare(
        `select id, repo_id from documents
         where id > ?${repoClause}
         order by id asc limit ?`,
      )
      .all(...params) as DocumentRow[];
  }

  async chunks_all_version_ids(opts: { after_id: number; limit: number }): Promise<number[]> {
    const rows = this.db
      .prepare(
        `select distinct version_id from chunks
         where version_id > ?
         order by version_id asc limit ?`,
      )
      .all(opts.after_id, opts.limit) as { version_id: number }[];
    return rows.map((r) => r.version_id);
  }

  async backlog_all_version_ids(opts: { after_id: number; limit: number }): Promise<number[]> {
    const rows = this.db
      .prepare(
        `select version_id from embedding_backlog
         where version_id > ?
         order by version_id asc limit ?`,
      )
      .all(opts.after_id, opts.limit) as { version_id: number }[];
    return rows.map((r) => r.version_id);
  }

  // fts verify scans (VerifyFtsScans capability, verify-plan §2.4). SQLite-only:
  // the version↔fts_docs rowid bijection can drift here (trigger-maintained
  // external-content table), unlike Postgres's generated fts_tsv column.
  //
  // Membership is read from the FTS5 shadow table `fts_docs_docsize` (one row
  // per indexed rowid), NOT by scanning `fts_docs` itself: an external-content
  // FTS5 table resolves each row's columns by joining back to `versions`, so a
  // `select rowid from fts_docs` for an orphaned rowid returns nothing (the
  // content row is gone) — it can't surface the very orphans we're hunting.
  // The shadow table is the authoritative index-membership set.

  async fts_missing_rowids(opts: { after_id: number; limit: number }): Promise<number[]> {
    const rows = this.db
      .prepare(
        `select v.id as id from versions v
         left join fts_docs_docsize d on d.id = v.id
         where v.id > ? and d.id is null
         order by v.id asc limit ?`,
      )
      .all(opts.after_id, opts.limit) as { id: number }[];
    return rows.map((r) => r.id);
  }

  async fts_orphan_rowids(opts: { after_id: number; limit: number }): Promise<number[]> {
    const rows = this.db
      .prepare(
        `select d.id as id from fts_docs_docsize d
         left join versions v on v.id = d.id
         where d.id > ? and v.id is null
         order by d.id asc limit ?`,
      )
      .all(opts.after_id, opts.limit) as { id: number }[];
    return rows.map((r) => r.id);
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

  /**
   * Refuse to open a pre-noauth database. Such a file carries an
   * `api_tokens` table (and `user_version = 5`); the collapsed migration
   * chain starts at 0001, so it would skip migration and run against a
   * mismatched schema. Probe for the legacy marker and refuse with a clear
   * message (noauth plan §1 — no upgrade path; re-ingest into a fresh db).
   */
  assertNotLegacy(): void {
    const row = this.db
      .prepare("select name from sqlite_master where type = 'table' and name = 'api_tokens'")
      .get() as { name: string } | undefined;
    if (row) {
      throw new Error(
        "this database predates the no-auth schema (found legacy api_tokens table). " +
          "Pre-noauth databases are unsupported — re-ingest into a fresh database.",
      );
    }
  }
}

export const sqliteAdapter: StorageAdapter = {
  scheme: "sqlite",
  async open(config: OpenConfig): Promise<Storage> {
    const path = parseSqliteUrl(config.database);
    const storage = new SqliteStorage(path);
    storage.assertNotLegacy();
    await storage.migrate();
    return storage;
  },
};
