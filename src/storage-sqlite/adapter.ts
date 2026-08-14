import Database from "better-sqlite3";
import type {
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
  VersionInsertInput,
  VersionRow,
} from "../storage/types.js";
import { migrate } from "./migrations/index.js";

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
  }

  close(): void {
    this.db.close();
  }

  migrate(): void {
    migrate(this.db);
  }

  tx<T>(fn: () => T): T {
    if (this.txDepth === 0) {
      this.db.exec("begin immediate");
      this.txDepth++;
      try {
        const result = fn();
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
      const result = fn();
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

  users_list(): UserRow[] {
    return this.db
      .prepare("select id, slug, created_at from users order by slug")
      .all() as UserRow[];
  }

  users_create(input: { slug: string; created_at: string }): UserRow {
    const row = this.db
      .prepare("insert into users(slug, created_at) values (?, ?) returning id, slug, created_at")
      .get(input.slug, input.created_at) as UserRow;
    return row;
  }

  users_rename(id: number, new_slug: string): UserRow {
    const row = this.db
      .prepare("update users set slug = ? where id = ? returning id, slug, created_at")
      .get(new_slug, id) as UserRow | undefined;
    if (!row) throw new Error(`users_rename: user ${id} not found`);
    return row;
  }

  users_by_slug(slug: string): UserRow | null {
    return (
      (this.db.prepare("select id, slug, created_at from users where slug = ?").get(slug) as
        | UserRow
        | undefined) ?? null
    );
  }

  users_by_id(id: number): UserRow | null {
    return (
      (this.db.prepare("select id, slug, created_at from users where id = ?").get(id) as
        | UserRow
        | undefined) ?? null
    );
  }

  repos_list(): RepoRow[] {
    return this.db
      .prepare("select id, slug, path_config, created_at from repos order by slug")
      .all() as RepoRow[];
  }

  repos_create(input: { slug: string; created_at: string }): RepoRow {
    const row = this.db
      .prepare(
        "insert into repos(slug, created_at) values (?, ?) returning id, slug, path_config, created_at",
      )
      .get(input.slug, input.created_at) as RepoRow;
    return row;
  }

  repos_rename(id: number, new_slug: string): RepoRow {
    const row = this.db
      .prepare("update repos set slug = ? where id = ? returning id, slug, path_config, created_at")
      .get(new_slug, id) as RepoRow | undefined;
    if (!row) throw new Error(`repos_rename: repo ${id} not found`);
    return row;
  }

  repos_set_path_config(id: number, path_config: string | null): RepoRow {
    const row = this.db
      .prepare(
        "update repos set path_config = ? where id = ? returning id, slug, path_config, created_at",
      )
      .get(path_config, id) as RepoRow | undefined;
    if (!row) throw new Error(`repos_set_path_config: repo ${id} not found`);
    return row;
  }

  repos_by_slug(slug: string): RepoRow | null {
    return (
      (this.db
        .prepare("select id, slug, path_config, created_at from repos where slug = ?")
        .get(slug) as RepoRow | undefined) ?? null
    );
  }

  repos_by_id(id: number): RepoRow | null {
    return (
      (this.db
        .prepare("select id, slug, path_config, created_at from repos where id = ?")
        .get(id) as RepoRow | undefined) ?? null
    );
  }

  documents_create(repo_id: number): DocumentRow {
    const row = this.db
      .prepare("insert into documents(repo_id) values (?) returning id, repo_id")
      .get(repo_id) as DocumentRow;
    return row;
  }

  version_insert(input: VersionInsertInput): VersionRow {
    return this.tx(() => {
      // The partial index `(document_id) where next_id is null` forbids two
      // rows sharing document_id with next_id=NULL. When advancing the chain,
      // we can't insert the new current row while the old current row still
      // has next_id=NULL — the partial-index constraint would fire.
      //
      // Trick: move the previous current out of the "current" set FIRST by
      // temporarily pointing its next_id at itself (a valid FK — the row
      // exists). Then insert the new current with next_id=NULL. Then fix the
      // prev row's next_id to the new row's id.
      //
      // Three statements, one tx, no window in which two rows share
      // (document_id, next_id=NULL). Same discipline is what the design's
      // §7.2.2 obligation #1 asks for.
      if (input.prev_id !== null) {
        // The placeholder update is also the guard that binds prev to THIS
        // document: it only matches when the referenced row belongs to the
        // input document_id AND is still current. A caller passing another
        // document's current version_id as prev fails here (0 rows changed),
        // so we can't cross-link chains or orphan a foreign document's
        // "current" pointer.
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

  version_by_id(id: number): VersionRow | null {
    const row = this.db
      .prepare(
        `select id, document_id, repo_id, prev_id, next_id, path,
                frontmatter_raw, frontmatter, body, author_id, created_at
         from versions where id = ?`,
      )
      .get(id) as VersionRawRow | undefined;
    return row ? hydrateVersion(row) : null;
  }

  version_current(repo_id: number, path: string): VersionRow | null {
    const row = this.db
      .prepare(
        `select id, document_id, repo_id, prev_id, next_id, path,
                frontmatter_raw, frontmatter, body, author_id, created_at
         from versions where repo_id = ? and path = ? and next_id is null`,
      )
      .get(repo_id, path) as VersionRawRow | undefined;
    return row ? hydrateVersion(row) : null;
  }

  versions_live_by_repo(repo_id: number): VersionRow[] {
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

  version_history(document_id: number, opts?: HistoryOptions): VersionRow[] {
    // History walks the version chain (design §3.4), not created_at, so
    // backdated edits and clock skew can't reorder the result. A recursive
    // CTE anchored at the current version follows prev_id back to the root;
    // rows come out newest-first by construction.
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

  // Tokens (design §3.2, §8). SQLite has no boolean, so `admin` stores 0/1.
  // `tokens_by_hash` / `tokens_list` filter out revoked and expired rows here
  // so the kernel never has to remember.
  tokens_create(input: TokenInsertInput): TokenRow {
    return this.db
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
      ) as TokenRow;
  }

  tokens_by_hash(hash: string): TokenRow | null {
    // Filter revoked + expired at read time.
    return (
      (this.db
        .prepare(
          `select id, user_id, secret_hash, label, scopes,
                  admin, expires_at, revoked_at, created_at, last_used_at
             from api_tokens
             where secret_hash = ?
               and revoked_at is null
               and (expires_at is null or expires_at > ?)`,
        )
        .get(hash, new Date().toISOString()) as TokenRow | undefined) ?? null
    );
  }

  tokens_by_id(id: number): TokenRow | null {
    return (
      (this.db
        .prepare(
          `select id, user_id, secret_hash, label, scopes,
                  admin, expires_at, revoked_at, created_at, last_used_at
             from api_tokens where id = ?`,
        )
        .get(id) as TokenRow | undefined) ?? null
    );
  }

  tokens_list(user_id: number): TokenRow[] {
    // Filter revoked + expired at read time (adapter contract, matching
    // tokens_by_hash) so the kernel doesn't have to remember.
    return this.db
      .prepare(
        `select id, user_id, secret_hash, label, scopes,
                admin, expires_at, revoked_at, created_at, last_used_at
           from api_tokens
           where user_id = ?
             and revoked_at is null
             and (expires_at is null or expires_at > ?)
           order by created_at desc, id desc`,
      )
      .all(user_id, new Date().toISOString()) as TokenRow[];
  }

  tokens_revoke(id: number, revoked_at: string): TokenRow | null {
    const row = this.db
      .prepare(
        `update api_tokens set revoked_at = coalesce(revoked_at, ?)
           where id = ?
         returning id, user_id, secret_hash, label, scopes,
                   admin, expires_at, revoked_at, created_at, last_used_at`,
      )
      .get(revoked_at, id) as TokenRow | undefined;
    return row ?? null;
  }

  tokens_revoke_by_user(user_id: number, revoked_at: string): void {
    this.db
      .prepare("update api_tokens set revoked_at = coalesce(revoked_at, ?) where user_id = ?")
      .run(revoked_at, user_id);
  }

  tokens_touch_last_used(id: number, when: string): void {
    // §8.5: best-effort, non-transactional. If we're inside a tx, it'll still
    // get committed with the rest — that's fine, this is a "cheap enough"
    // update on the hot auth path.
    this.db.prepare("update api_tokens set last_used_at = ? where id = ?").run(when, id);
  }
}

export const sqliteAdapter: StorageAdapter = {
  scheme: "sqlite",
  open(config: OpenConfig): Storage {
    const path = parseSqliteUrl(config.database);
    const storage = new SqliteStorage(path);
    storage.migrate();
    return storage;
  },
};
