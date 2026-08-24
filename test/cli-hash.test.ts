/**
 * `mrplex hash backfill` — compute $content_hash for pre-0002 rows
 * (sync/history plan §2.6). version_insert already populates the column, so we
 * null it out directly to simulate a pre-backfill database.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(REPO_ROOT, "src", "cli", "main.ts");

let workDir: string;
let dbFile: string;
let dbUrl: string;

function run(...args: string[]): { stdout: string; stderr: string; status: number } {
  const res = spawnSync("node", ["--import", "tsx", CLI, "--database", dbUrl, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...(process.env as Record<string, string>), XDG_CONFIG_HOME: workDir },
  });
  return { stdout: res.stdout, stderr: res.stderr, status: res.status ?? 1 };
}

function createDoc(repo: string, path: string, markdown: string): void {
  const res = spawnSync(
    "node",
    [
      "--import",
      "tsx",
      CLI,
      "--database",
      dbUrl,
      "-r",
      repo,
      "docs",
      "create",
      path,
      "--from-file",
      "-",
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      input: markdown,
      env: { ...(process.env as Record<string, string>), XDG_CONFIG_HOME: workDir },
    },
  );
  if ((res.status ?? 1) !== 0) throw new Error(`create failed: ${res.stderr}`);
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "mrplex-hash-"));
  mkdirSync(workDir, { recursive: true });
  dbFile = join(workDir, "hash.db");
  dbUrl = `sqlite:${dbFile}`;
  expect(run("repos", "create", "notes").status).toBe(0);
  createDoc("notes", "a.md", "one\n");
  createDoc("notes", "b.md", "two\n");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function countNullHashes(): number {
  const db = new Database(dbFile);
  const row = db.prepare("select count(*) as n from versions where content_hash is null").get() as {
    n: number;
  };
  db.close();
  return row.n;
}

function nullOutHashes(): void {
  const db = new Database(dbFile);
  db.prepare("update versions set content_hash = null").run();
  db.close();
}

describe("mrplex hash backfill", () => {
  it("backfills null content_hash rows and reports the count", () => {
    nullOutHashes();
    expect(countNullHashes()).toBe(2);
    const out = run("--json", "hash", "backfill");
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).hashed).toBe(2);
    expect(countNullHashes()).toBe(0);
  });

  it("is a no-op when nothing is missing", () => {
    const out = run("--json", "hash", "backfill");
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).hashed).toBe(0);
  });

  it("--repo scopes the backfill to one repo", () => {
    expect(run("repos", "create", "other").status).toBe(0);
    createDoc("other", "z.md", "z\n");
    nullOutHashes();
    expect(countNullHashes()).toBe(3);
    // The repo filter rides the global -r/--repo flag.
    const out = run("--json", "-r", "notes", "hash", "backfill");
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).hashed).toBe(2);
    expect(countNullHashes()).toBe(1); // other/z.md still null
  });
});
