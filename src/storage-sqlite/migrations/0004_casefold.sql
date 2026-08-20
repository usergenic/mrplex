-- Case-insensitive, Unicode-normalized identity — design §3.5.1 amendment
-- (case-folding-plan.md WS2).
--
-- Storage stays case- and form-preserving: versions.path / repos.slug /
-- users.slug keep the author's exact bytes. Identity (uniqueness + by-key
-- lookup) runs off a DERIVED normalized key computed IN THE KERNEL
-- (normalizeKey = NFC + locale-invariant lowercase, src/kernel/casefold.ts).
-- The key is never surfaced on the wire.
--
-- Kernel-side normalization (not SQL lower()/COLLATE NOCASE) is deliberate:
-- SQLite's lower() is ASCII-only without ICU while Postgres's is
-- locale-aware, so a functional index would diverge and break §7.2 parity.
-- Both adapters store the pre-computed key the kernel hands them.
--
-- Columns are nullable so the migration is safe on a corpus with existing
-- rows; the kernel populates them on every write, and a backfill fills any
-- pre-existing rows before these unique indexes can meaningfully enforce.

alter table versions add column path_norm text;
alter table repos    add column slug_norm text;
alter table users    add column slug_norm text;

-- One live document per NORMALIZED path in a repo (the case-insensitive
-- twin of versions_repo_path_current_uidx). Live rows only (next_id null);
-- deleted rows are exempt, so freeing a name by deletion frees its key too.
create unique index versions_repo_pathnorm_current_uidx
  on versions(repo_id, path_norm) where next_id is null;

-- Case-insensitive slug uniqueness for repos and users.
create unique index repos_slugnorm_uidx on repos(slug_norm);
create unique index users_slugnorm_uidx on users(slug_norm);
