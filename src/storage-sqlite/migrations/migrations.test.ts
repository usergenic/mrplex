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
    const names = tables.map((t) => t.name).filter((n) => !n.startsWith("sqlite_"));
    expect(names).toEqual(
      [
        "api_tokens",
        "chunks",
        "documents",
        "embedding_backlog",
        "repos",
        "users",
        "versions",
      ].sort(),
    );
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

  it("creates the two partial unique indexes from §3.2", () => {
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
    ]);
  });
});
