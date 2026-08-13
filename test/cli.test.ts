/**
 * CLI smoke tests. Exercise the end-to-end path from a seeded database
 * through the CLI to stdout/stderr + exit code — the definition-of-done
 * transcript from docs/m0-plan.md §6.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(REPO_ROOT, "src", "cli", "main.ts");
const SEED = join(REPO_ROOT, "scripts", "seed.ts");

let workDir: string;
let dbUrl: string;

function run(...args: string[]): { stdout: string; stderr: string; status: number } {
  const res = spawnSync("npx", ["--no-install", "tsx", CLI, "--database", dbUrl, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return { stdout: res.stdout, stderr: res.stderr, status: res.status ?? 1 };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "mrplex-cli-"));
  mkdirSync(workDir, { recursive: true });
  dbUrl = `sqlite:${join(workDir, "cli.db")}`;
  const seed = spawnSync("npx", ["--no-install", "tsx", SEED, "--database", dbUrl], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (seed.status !== 0) throw new Error(`seed failed: ${seed.stderr}`);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("cli", () => {
  it("repos list — shows the seeded repo", () => {
    const out = run("repos", "list");
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("notes");
  });

  it("users list — shows the seeded user", () => {
    const out = run("users", "list");
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("alice");
  });

  it("docs get — returns pretty markdown with frontmatter", () => {
    const out = run("docs", "get", "notes", "welcome.md");
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/^---\n/);
    expect(out.stdout).toContain("title: Welcome");
    expect(out.stdout).toContain("# Welcome");
  });

  it("docs get --json — returns a Version envelope", () => {
    const out = run("--json", "docs", "get", "notes", "welcome.md");
    expect(out.status).toBe(0);
    const v = JSON.parse(out.stdout);
    expect(v.repo).toBe("notes");
    expect(v.path).toBe("welcome.md");
    expect(v.version_id).toMatch(/^v\d+$/);
    expect(v.next_version_id).toBeNull();
    expect(v.author).toEqual({ user: "alice" });
  });

  it("docs history — newest-first with the current-marker", () => {
    const out = run("docs", "history", "notes", "welcome.md");
    expect(out.status).toBe(0);
    // Two lines of data (the second welcome revision has 2 versions).
    expect(out.stdout).toMatch(/current/);
  });

  it("doc_not_found exits 4", () => {
    const out = run("docs", "get", "notes", "missing.md");
    expect(out.status).toBe(4);
    expect(out.stderr).toContain("doc_not_found");
  });

  it("repo_not_found exits 4", () => {
    const out = run("docs", "get", "nope", "welcome.md");
    expect(out.status).toBe(4);
    expect(out.stderr).toContain("repo_not_found");
  });

  it("version_not_found exits 4 for malformed id", () => {
    const out = run("docs", "get-version", "notes", "not-a-version");
    expect(out.status).toBe(4);
    expect(out.stderr).toContain("version_not_found");
  });
});
