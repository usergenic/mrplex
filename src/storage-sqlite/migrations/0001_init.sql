-- mrplex schema (SQLite) — see docs/design.md §3.2.
--
-- Fresh no-auth baseline: the pre-noauth migration chain (0001 init, 0002
-- admin-token flag, 0003 FTS, 0004 casefold, 0005 links) is collapsed into
-- this single file. There is no users or api_tokens table — mrplex trusts
-- its caller (design §8); authorship is one opaque string on versions.author.
-- Pre-noauth databases are refused at open (adapter probes for api_tokens).
-- Future migrations resume at 0002.
--
-- Dialect notes for SQLite:
--   * JSON columns are TEXT with a CHECK (json_valid(...)) constraint.
--   * Timestamps are TEXT in ISO 8601 UTC (per §6.4 wire types).
--   * Case-folded identity runs off derived *_norm columns computed in the
--     kernel (normalizeKey = NFC + locale-invariant lowercase). Storage stays
--     case- and form-preserving; the key never crosses the wire (§3.5.1).

create table repos (
  id          integer primary key,
  slug        text not null unique,
  slug_norm   text not null,
  path_config text check (path_config is null or json_valid(path_config)),
  link_config text check (link_config is null or json_valid(link_config)),
  created_at  text not null
);

-- Case-insensitive slug uniqueness (§3.5.1).
create unique index repos_slugnorm_uidx on repos(slug_norm);

create table documents (
  id      integer primary key,
  repo_id integer not null references repos(id)
);

create index documents_repo_id_idx on documents(repo_id);

create table versions (
  id              integer primary key,
  document_id     integer not null references documents(id),
  repo_id         integer not null references repos(id),
  prev_id         integer      references versions(id),
  next_id         integer      references versions(id),
  path            text    not null,
  path_norm       text    not null,
  frontmatter_raw text    not null,
  frontmatter     text    not null check (json_valid(frontmatter)),
  body            text    not null,
  author          text    not null,            -- opaque caller-supplied string
  created_at      text    not null
);

-- exactly one current version per document (design §3.2)
create unique index versions_document_current_uidx
  on versions(document_id) where next_id is null;

-- at most one live document per path in a repo (design §3.2)
create unique index versions_repo_path_current_uidx
  on versions(repo_id, path) where next_id is null;

-- history walks: iterating a document's versions by chain
create index versions_document_id_idx on versions(document_id);

-- One live document per NORMALIZED path in a repo (case-insensitive twin of
-- versions_repo_path_current_uidx). Live rows only; deleted rows exempt (§3.5.1).
create unique index versions_repo_pathnorm_current_uidx
  on versions(repo_id, path_norm) where next_id is null;

create table chunks (
  version_id integer not null references versions(id),
  ix         integer not null,
  text       text    not null,
  text_hash  text    not null,
  model      text    not null,
  embedding  blob,
  primary key (version_id, ix)
);

create index chunks_hash_model_idx on chunks(text_hash, model);

create table embedding_backlog (
  version_id    integer primary key references versions(id),
  attempts      integer not null,
  last_error    text,
  next_retry_at text
);

-- FTS5 index over versions.body — design §5.1, §7.2. External-content
-- virtual table so we don't duplicate body storage. Triggers mirror
-- INSERT/DELETE on versions; fts_search filters next_id IS NULL at query time.
create virtual table fts_docs using fts5(
  body,
  content='versions',
  content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 1'
);

create trigger fts_docs_ai after insert on versions begin
  insert into fts_docs(rowid, body) values (new.id, new.body);
end;

create trigger fts_docs_ad after delete on versions begin
  insert into fts_docs(fts_docs, rowid, body) values('delete', old.id, old.body);
end;

-- Links derived index — design §11.2. One row per outbound STATIC edge from
-- the live corpus, doc-keyed. Binds to target document identity (target_id),
-- so moves never churn inbound edges; dangling rows (target_id NULL) rebind
-- when a document appears at target_norm's folded path. Never source of truth.
create table links (
  repo_id     integer not null references repos(id),
  source_id   integer not null references documents(id),
  ord         integer not null,
  field       text    not null,
  target_raw  text    not null,
  target_norm text    not null,
  target_id   integer          references documents(id),
  primary key (source_id, ord)
);

-- Backlinks direction (others → me). Partial — danglers served by target_norm.
create index links_target_id_idx on links(target_id) where target_id is not null;

-- Dangling re-resolution (§11.2): repo-scoped, folded-target lookup.
create index links_dangling_idx on links(repo_id, target_norm) where target_id is null;
