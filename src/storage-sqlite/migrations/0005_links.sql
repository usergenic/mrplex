-- Links derived index — design §11.2 (Phase 1, links-plan.md WS1/WS3).
--
-- One row per outbound STATIC edge from the live corpus, doc-keyed (not
-- version-keyed): every graph query asks about the CURRENT graph, so the
-- index binds to document identity and is rebuilt in-place on each write.
-- Never source of truth — a backfill pass reconstructs it from scratch.
--
--   repo_id     the source document's repo (links are repo-local, §11.2);
--               denormalized from source_id for cheap repo-scoped
--               dangling re-resolution and scope filtering
--   source_id   the document the edge originates from
--   ord         position within the current version (document order)
--   field       '$body' for body-derived edges; a CEL field path
--               (e.g. 'parent', 'project.lead') for frontmatter edges
--   target_raw  exactly what was written (primary candidate path + anchor);
--               the canonical written form for links.stale / repair
--   target_norm folded, anchor-stripped resolution key (normalizeKey of the
--               primary candidate). Dangling rows rebind by matching a
--               newly-appeared path's folded form against this — so
--               resolution is case-insensitive, consistent with §3.5.1.
--   target_id   resolved document identity, or NULL when dangling
--
-- Identity resolution is the load-bearing decision (§11.2): edges bind to
-- target_id, so moves never churn inbound edges. Dangling rows (target_id
-- NULL) are first-class and get bound by a re-resolution pass when a
-- document later appears at target_norm's path.
--
-- External targets (scheme URIs, bare fragments) produce NO row — they
-- never enter the graph (links are repo-local). Only repo-local edges,
-- resolved or dangling, are stored.

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

-- Backlinks direction (others → me): resolve a target document's inbound
-- edges. Partial — dangling rows are served by the target_norm index below.
create index links_target_id_idx on links(target_id) where target_id is not null;

-- Dangling re-resolution (§11.2): when a document appears at a path, bind
-- the waiting danglers in the same repo whose folded target matches it.
create index links_dangling_idx on links(repo_id, target_norm) where target_id is null;

-- Per-repo link-extraction override (§11.2 config cascade, mirrors
-- repos.path_config). NULL = inherit server + hardcoded defaults.
alter table repos add column link_config text
  check (link_config is null or json_valid(link_config));
