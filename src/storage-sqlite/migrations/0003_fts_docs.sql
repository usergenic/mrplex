-- FTS5 index over versions.body — design §5.1, §7.2 (SQLite branch of the
-- adapter parity table). External-content virtual table so we don't
-- duplicate body storage.
--
-- Triggers mirror INSERT/DELETE on versions. Every version (not just
-- current) lands in the index; fts_search filters to next_id IS NULL at
-- query time — cheaper than trying to maintain a "current-only" index in
-- the face of the version_insert three-statement dance (m0 §7.2.2), and
-- consistent with "search indexes cover current versions only" (§5.1)
-- since the query filter is what enforces it.

create virtual table fts_docs using fts5(
  body,
  content='versions',
  content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 1'
);

-- INSERT trigger: the new row goes in the FTS index. version_insert's
-- three-statement dance produces exactly one INSERT per real advance;
-- the placeholder self-loop update is an UPDATE, not an INSERT, and
-- doesn't fire this trigger — see the regression test.
create trigger fts_docs_ai after insert on versions begin
  insert into fts_docs(rowid, body) values (new.id, new.body);
end;

-- DELETE trigger: not exercised in v1 (no version rows are ever deleted),
-- but kept for symmetry and for future admin cleanup ops. External-
-- content FTS5 requires the 'delete'-command form.
create trigger fts_docs_ad after delete on versions begin
  insert into fts_docs(fts_docs, rowid, body) values('delete', old.id, old.body);
end;
