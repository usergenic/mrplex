-- Links derived index — design §11.2 (Phase 1, links-plan.md WS1/WS3).
-- Postgres dialect; parity with storage-sqlite/migrations/0005_links.sql.
--
-- One row per outbound STATIC edge from the live corpus, doc-keyed. Binds
-- to target document identity (target_id), so moves never churn inbound
-- edges; dangling rows (target_id NULL) rebind when a document appears at
-- target_norm's folded path. Never source of truth.

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

-- Per-repo link-extraction override (§11.2 config cascade, mirrors
-- repos.path_config jsonb). NULL = inherit server + hardcoded defaults.
alter table repos add column link_config jsonb;
