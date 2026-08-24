/**
 * `mrplex sync --once` — end-to-end against a real vault on disk. Verifies
 * bidirectional reconciliation (local creations pushed, remote docs
 * materialized), the self-describing intrinsics, and the persisted cursor.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(REPO_ROOT, "src", "cli", "main.ts");

let workDir: string;
let vault: string;
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
  workDir = mkdtempSync(join(tmpdir(), "mrplex-sync-"));
  vault = join(workDir, "vault");
  mkdirSync(vault, { recursive: true });
  dbUrl = `sqlite:${join(workDir, "sync.db")}`;
  expect(run("repos", "create", "notes").status).toBe(0);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("mrplex sync --once", () => {
  it("materializes remote docs into an empty vault and writes the cursor", () => {
    createDoc("notes", "hello.md", "# Hello\n\nfrom server\n");
    const out = run("-r", "notes", "sync", vault, "--once");
    expect(out.status).toBe(0);
    const file = readFileSync(join(vault, "hello.md"), "utf8");
    expect(file).toContain("from server");
    expect(file).toMatch(/\$version: v\d+/);
    expect(file).toMatch(/\$content_hash: [0-9a-f]{64}/);
    // Cursor persisted.
    const cursor = JSON.parse(readFileSync(join(vault, ".mrplex/sync.json"), "utf8"));
    expect(cursor.repo).toBe("notes");
    expect(cursor.last_synced_version_id).toMatch(/^v\d+$/);
  });

  it("pushes a new local file to the remote", () => {
    writeFileSync(join(vault, "local.md"), "brand new\n");
    const out = run("-r", "notes", "sync", vault, "--once");
    expect(out.status).toBe(0);
    // The remote now has it.
    const got = run("--json", "-r", "notes", "docs", "get", "local.md");
    expect(got.status).toBe(0);
    expect(JSON.parse(got.stdout).body).toBe("brand new\n");
    // The local file was rewritten with provenance.
    const file = readFileSync(join(vault, "local.md"), "utf8");
    expect(file).toMatch(/\$version: v\d+/);
  });

  it("is idempotent — a second --once run reports no changes", () => {
    createDoc("notes", "a.md", "aaa\n");
    writeFileSync(join(vault, "b.md"), "bbb\n");
    expect(run("-r", "notes", "sync", vault, "--once").status).toBe(0);
    const second = run("--json", "-r", "notes", "sync", vault, "--once");
    expect(second.status).toBe(0);
    const report = JSON.parse(second.stdout);
    const changed = report.actions.filter(
      (a: { verdict: string }) => a.verdict !== "clean" && a.verdict !== "skip",
    );
    expect(changed).toEqual([]);
  });

  it("--dry-run changes nothing on disk or remote", () => {
    createDoc("notes", "remote.md", "r\n");
    writeFileSync(join(vault, "local.md"), "l\n");
    const out = run("-r", "notes", "sync", vault, "--once", "--dry-run");
    expect(out.status).toBe(0);
    // Remote doc was NOT materialized; local file was NOT pushed.
    expect(() => readFileSync(join(vault, "remote.md"), "utf8")).toThrow();
    const got = run("-r", "notes", "docs", "get", "local.md");
    expect(got.status).not.toBe(0);
  });
});
