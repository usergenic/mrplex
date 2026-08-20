-- Case-insensitive, Unicode-normalized identity — design §3.5.1 amendment
-- (case-folding-plan.md WS2). Postgres dialect; parity with
-- storage-sqlite/migrations/0004_casefold.sql.
--
-- Storage stays case- and form-preserving; identity runs off a derived
-- normalized key computed in the kernel (normalizeKey, NFC + invariant
-- lowercase). NOT a SQL lower()/citext — that would diverge from SQLite on
-- non-ASCII and break §7.2 parity. Both adapters store the kernel's key.

alter table versions add column path_norm text;
alter table repos    add column slug_norm text;
alter table users    add column slug_norm text;

-- One live document per normalized path in a repo (case-insensitive twin of
-- versions_repo_path_current_uidx). Live rows only; deleted rows exempt.
create unique index versions_repo_pathnorm_current_uidx
  on versions(repo_id, path_norm) where next_id is null;

create unique index repos_slugnorm_uidx on repos(slug_norm);
create unique index users_slugnorm_uidx on users(slug_norm);
