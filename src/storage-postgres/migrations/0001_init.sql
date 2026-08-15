-- mrplex Postgres schema — parity with docs/design.md §3.2 (m5-plan WS4).
--
-- Dialect notes:
--   * Ids are bigserial — internal, never crossing the wire (§3.3).
--   * Timestamps are text in ISO 8601 UTC — byte-exact parity with SQLite
--     beats timestamptz purism at the storage layer; the kernel produces
--     the exact string it stores.
--   * Frontmatter is jsonb + a single GIN index (§5.2 — both `x = "v"` and
--     `"v" in list(x)` fall under the same jsonb operator set).
--   * `admin` is a real boolean; the adapter hides SQLite's 0/1 mapping.
--   * Vector column is dimensionless (§7.2.1) — v1 is brute-force. ANN
--     is a fast-follow.
--   * `fts_tsv` is a generated tsvector kept in sync via the column
--     definition. GIN over it powers versions_search's text branch.

create extension if not exists vector;

create table users (
  id         bigserial primary key,
  slug       text not null unique,
  created_at text not null
);

create table repos (
  id          bigserial primary key,
  slug        text not null unique,
  path_config jsonb,
  created_at  text not null
);

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
  frontmatter_raw text   not null,
  frontmatter     jsonb  not null,
  body            text   not null,
  author_id       bigint not null references users(id),
  created_at      text   not null,
  fts_tsv         tsvector generated always as (to_tsvector('english', body)) stored
);

-- Partial unique indexes — verbatim §3.2:
create unique index versions_document_current_uidx
  on versions(document_id) where next_id is null;

create unique index versions_repo_path_current_uidx
  on versions(repo_id, path) where next_id is null;

create index versions_document_id_idx on versions(document_id);

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

create table api_tokens (
  id           bigserial primary key,
  user_id      bigint  not null references users(id),
  secret_hash  text    not null unique,
  label        text,
  scopes       jsonb   not null,
  admin        boolean not null default false,
  expires_at   text,
  revoked_at   text,
  created_at   text    not null,
  last_used_at text
);

create index api_tokens_user_id_idx on api_tokens(user_id);

create table embedding_backlog (
  version_id    bigint primary key references versions(id),
  attempts      integer not null,
  last_error    text,
  next_retry_at text
);
