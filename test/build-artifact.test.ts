/**
 * Build-artifact smoke test. `tsc` doesn't copy .sql files, so the compiled
 * migration loader would find zero migrations without the copy-assets step.
 * This test builds, then imports the compiled loader and applies it to an
 * in-memory database — proving the artifact ships bootable.
 *
 * Slow-ish (invokes npm run build) so it lives in its own file; skipped in
 * watch mode by tagging with a longer test timeout only for this file.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const DIST_MIGRATIONS = join(REPO_ROOT, "dist", "storage-sqlite", "migrations");
const DIST_LOADER = join(DIST_MIGRATIONS, "index.js");

describe("build artifact", () => {
  beforeAll(() => {
    const res = spawnSync("npm", ["run", "build"], { cwd: REPO_ROOT, encoding: "utf8" });
    if (res.status !== 0) {
      throw new Error(`build failed: ${res.stderr}\n${res.stdout}`);
    }
  }, 60_000);

  it("copies migration .sql files into dist/", () => {
    expect(existsSync(join(DIST_MIGRATIONS, "0001_init.sql"))).toBe(true);
  });

  it("the compiled loader can migrate an in-memory database", async () => {
    // Dynamic import from the compiled artifact — this is what an installed
    // package would run.
    const module = (await import(DIST_LOADER)) as {
      migrate: (db: Database.Database) => void;
    };
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    module.migrate(db);
    const tables = db
      .prepare("select name from sqlite_master where type='table' order by name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name).filter((n) => !n.startsWith("sqlite_"));
    expect(names).toContain("versions");
    expect(names).toContain("documents");
    db.close();
  });
});
