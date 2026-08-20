import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "./index.js";

describe("migrate", () => {
  it("creates all §3.2 tables on a fresh database", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    const tables = db
      .prepare("select name from sqlite_master where type='table' order by name")
      .all() as { name: string }[];
    // FTS5 virtual tables generate shadow tables (fts_docs_config,
    // fts_docs_data, fts_docs_idx, fts_docs_docsize, fts_docs_content) —
    // filter those out; we only assert our schema tables are present.
    const names = tables
      .map((t) => t.name)
      .filter((n) => !n.startsWith("sqlite_") && !n.startsWith("fts_docs"));
    expect(names.sort()).toEqual(
      [
        "api_tokens",
        "chunks",
        "documents",
        "embedding_backlog",
        "links",
        "repos",
        "users",
        "versions",
      ].sort(),
    );
  });

  it("creates the FTS5 virtual table + triggers (migration 0003)", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    // Virtual table itself
    const ftsTable = db
      .prepare("select name from sqlite_master where type='table' and name='fts_docs'")
      .get() as { name: string } | undefined;
    expect(ftsTable?.name).toBe("fts_docs");
    // Triggers
    const triggers = db
      .prepare(
        "select name from sqlite_master where type='trigger' and tbl_name='versions' order by name",
      )
      .all() as { name: string }[];
    expect(triggers.map((t) => t.name)).toEqual(["fts_docs_ad", "fts_docs_ai"]);
  });

  it("creates the links table + partial indexes and the repos.link_config column (migration 0005)", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    const linksTable = db
      .prepare("select name from sqlite_master where type='table' and name='links'")
      .get() as { name: string } | undefined;
    expect(linksTable?.name).toBe("links");

    const linkIndexes = db
      .prepare(
        "select name from sqlite_master where type='index' and tbl_name='links' and name like 'links_%' order by name",
      )
      .all() as { name: string }[];
    expect(linkIndexes.map((i) => i.name)).toEqual(["links_target_id_idx", "links_target_raw_idx"]);

    const repoCols = db.prepare("pragma table_info(repos)").all() as { name: string }[];
    expect(repoCols.map((c) => c.name)).toContain("link_config");
  });

  it("is idempotent — running twice is a no-op", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    const versionAfterFirst = db.pragma("user_version", { simple: true });
    migrate(db);
    const versionAfterSecond = db.pragma("user_version", { simple: true });
    expect(versionAfterSecond).toBe(versionAfterFirst);
    expect(versionAfterFirst).toBeGreaterThan(0);
  });

  it("creates the two partial unique indexes from §3.2 (plus the casefold twin)", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    const indexes = db
      .prepare(
        "select name from sqlite_master where type='index' and tbl_name='versions' and name like '%uidx%' order by name",
      )
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toEqual([
      "versions_document_current_uidx",
      "versions_repo_path_current_uidx",
      "versions_repo_pathnorm_current_uidx",
    ]);
  });

  it("creates the norm columns + case-insensitive unique indexes (migration 0004)", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);

    const versionCols = db.prepare("pragma table_info(versions)").all() as { name: string }[];
    expect(versionCols.map((c) => c.name)).toContain("path_norm");
    const repoCols = db.prepare("pragma table_info(repos)").all() as { name: string }[];
    expect(repoCols.map((c) => c.name)).toContain("slug_norm");
    const userCols = db.prepare("pragma table_info(users)").all() as { name: string }[];
    expect(userCols.map((c) => c.name)).toContain("slug_norm");

    const slugIndexes = db
      .prepare(
        "select name from sqlite_master where type='index' and name like '%slugnorm%' order by name",
      )
      .all() as { name: string }[];
    expect(slugIndexes.map((i) => i.name)).toEqual(["repos_slugnorm_uidx", "users_slugnorm_uidx"]);
  });
});
