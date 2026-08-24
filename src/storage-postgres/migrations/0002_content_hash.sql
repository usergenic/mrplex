-- $content_hash intrinsic (sync/history plan §2.3) — Postgres twin.
--
-- Nullable so the migration is instant; null means "not yet backfilled" and
-- reads compute on the fly during the transition. version_insert computes the
-- value inside the same tx as the insert, so no new row lacks its hash.
alter table versions add column content_hash text;
create index versions_content_hash_idx on versions(content_hash);
