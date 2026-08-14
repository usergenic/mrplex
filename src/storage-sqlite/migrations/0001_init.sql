-- mrplex schema — see docs/design.md §3.2
--
-- Dialect notes for SQLite:
--   * JSON columns are TEXT with a CHECK (json_valid(...)) constraint.
--   * Timestamps are TEXT in ISO 8601 UTC (per §6.4 wire types).
--   * vector storage arrives in M4; embedding is BLOB (nullable) for now.

create table users (
  id         integer primary key,
  slug       text not null unique,
  created_at text not null
);

create table repos (
  id          integer primary key,
  slug        text not null unique,
  path_config text check (path_config is null or json_valid(path_config)),
  created_at  text not null
);

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
  frontmatter_raw text    not null,
  frontmatter     text    not null check (json_valid(frontmatter)),
  body            text    not null,
  author_id       integer not null references users(id),
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

create table api_tokens (
  id           integer primary key,
  user_id      integer not null references users(id),
  secret_hash  text    not null unique,
  label        text,
  scopes       text    not null check (json_valid(scopes)),
  expires_at   text,
  revoked_at   text,
  created_at   text    not null,
  last_used_at text
);

create index api_tokens_user_id_idx on api_tokens(user_id);

create table embedding_backlog (
  version_id    integer primary key references versions(id),
  attempts      integer not null,
  last_error    text,
  next_retry_at text
);
