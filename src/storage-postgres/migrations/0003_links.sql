-- Links derived index — design §11.2 (Phase 1, links-plan.md WS1).
-- Postgres dialect; parity with storage-sqlite/migrations/0004_links.sql.
--
-- One row per outbound STATIC edge from the live corpus, doc-keyed. Binds
-- to target document identity (target_id), so moves never churn inbound
-- edges; dangling rows (target_id NULL) are first-class and re-resolved
-- when a document appears at target_raw's path. Never source of truth.

create table links (
  source_id  bigint not null references documents(id),
  ord        integer not null,
  field      text    not null,
  target_raw text    not null,
  target_id  bigint           references documents(id),
  primary key (source_id, ord)
);

-- Backlinks direction (others → me).
create index links_target_id_idx on links(target_id) where target_id is not null;

-- Dangling re-resolution lookups (§11.2).
create index links_target_raw_idx on links(target_raw) where target_id is null;

-- Per-repo link-extraction override (§11.2 config cascade, mirrors
-- repos.path_config jsonb). NULL = inherit server + hardcoded defaults.
alter table repos add column link_config jsonb;
