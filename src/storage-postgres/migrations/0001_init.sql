-- mrplex schema (Postgres) — parity with docs/design.md §3.2.
--
-- Fresh no-auth baseline: the pre-noauth migration chain (0001 init, 0002
-- casefold, 0003 links) is collapsed into this single file. There is no
-- users or api_tokens table — mrplex trusts its caller (design §8); authorship
-- is one opaque string on versions.author. Pre-noauth databases are refused at
-- open (adapter probes for api_tokens). Future migrations resume at 0002.
--
-- Dialect notes:
--   * Ids are bigserial — internal, never crossing the wire (§3.3).
--   * Timestamps are text in ISO 8601 UTC — byte-exact parity with SQLite.
--   * Frontmatter is jsonb + a single GIN index (§5.2).
--   * Vector column is dimensionless (§7.2.1) — v1 is brute-force.
--   * `fts_tsv` is a generated tsvector; GIN over it powers the text branch.
--   * Case-folded identity runs off derived *_norm columns computed in the
--     kernel (normalizeKey, NFC + invariant lowercase), not SQL lower()/citext,
--     to stay byte-identical with SQLite (§3.5.1, §7.2 parity).

create extension if not exists vector;

create table repos (
  id          bigserial primary key,
  slug        text not null unique,
  slug_norm   text not null,
  path_config jsonb,
  link_config jsonb,
  created_at  text not null
);

create unique index repos_slugnorm_uidx on repos(slug_norm);

create table documents (
  id      bigserial primary key,
  repo_id bigint not null references repos(id)
);

create index documents_repo_id_idx on documents(repo_id);

create table versions (
  id              bigserial primary key,
  document_id     bigint not null references documents(id),
  repo_id         bigint not null references repos(id),
  prev_id         bigint      references versions(id),
  next_id         bigint      references versions(id),
  path            text   not null,
  path_norm       text   not null,
  frontmatter_raw text   not null,
  frontmatter     jsonb  not null,
  body            text   not null,
  author          text   not null,            -- opaque caller-supplied string
  created_at      text   not null,
  fts_tsv         tsvector generated always as (to_tsvector('english', body)) stored
);

-- Partial unique indexes — verbatim §3.2:
create unique index versions_document_current_uidx
  on versions(document_id) where next_id is null;

create unique index versions_repo_path_current_uidx
  on versions(repo_id, path) where next_id is null;

create index versions_document_id_idx on versions(document_id);

-- One live document per NORMALIZED path in a repo (case-insensitive twin;
-- live rows only, deleted rows exempt — §3.5.1).
create unique index versions_repo_pathnorm_current_uidx
  on versions(repo_id, path_norm) where next_id is null;

-- Frontmatter jsonb GIN (§5.2 — one index for both scalar `=` and list `?|`).
create index versions_frontmatter_gin on versions using gin (frontmatter jsonb_path_ops);

-- FTS index over current versions' bodies; the query filters next_id IS NULL.
create index versions_fts_gin on versions using gin (fts_tsv);

create table chunks (
  version_id bigint not null references versions(id),
  ix         integer not null,
  text       text   not null,
  text_hash  text   not null,
  model      text   not null,
  embedding  vector,
  primary key (version_id, ix)
);

create index chunks_hash_model_idx on chunks(text_hash, model);

create table embedding_backlog (
  version_id    bigint primary key references versions(id),
  attempts      integer not null,
  last_error    text,
  next_retry_at text
);

-- Links derived index — design §11.2. One row per outbound STATIC edge from
-- the live corpus, doc-keyed. Binds to target document identity (target_id),
-- so moves never churn inbound edges; dangling rows (target_id NULL) rebind
-- when a document appears at target_norm's folded path. Never source of truth.
create table links (
  repo_id     bigint not null references repos(id),
  source_id   bigint not null references documents(id),
  ord         integer not null,
  field       text    not null,
  target_raw  text    not null,
  target_norm text    not null,
  target_id   bigint           references documents(id),
  primary key (source_id, ord)
);

-- Backlinks direction (others → me).
create index links_target_id_idx on links(target_id) where target_id is not null;

-- Dangling re-resolution (§11.2): repo-scoped, folded-target lookup.
create index links_dangling_idx on links(repo_id, target_norm) where target_id is null;
