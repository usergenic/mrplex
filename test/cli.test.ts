/**
 * CLI smoke tests. Exercise the end-to-end path from a seeded database
 * through the CLI to stdout/stderr + exit code — the definition-of-done
 * transcript from docs/m0-plan.md §6 (plus M1's bootstrap-first posture).
 *
 * M1 removes the SYSTEM_ACTOR anonymous fallback: the CLI now requires a
 * real bearer token, so beforeEach() bootstraps the root token before the
 * seed script populates data (seed writes adapter-level, bypassing auth).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrap } from "../src/cli/bootstrap.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(REPO_ROOT, "src", "cli", "main.ts");
const SEED = join(REPO_ROOT, "scripts", "seed.ts");

let workDir: string;
let dbUrl: string;
let rootToken: string;

function run(...args: string[]): { stdout: string; stderr: string; status: number } {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MRPLEX_TOKEN: rootToken,
    // Most `docs *` tests target the seeded `notes` repo; individual tests
    // override with an explicit `-r <slug>` when they need something else.
    MRPLEX_REPO: "notes",
    // Point config at the workdir so per-user ~/.config doesn't leak into tests.
    XDG_CONFIG_HOME: workDir,
  };
  const res = spawnSync("npx", ["--no-install", "tsx", CLI, "--database", dbUrl, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env,
  });
  return { stdout: res.stdout, stderr: res.stderr, status: res.status ?? 1 };
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "mrplex-cli-"));
  mkdirSync(workDir, { recursive: true });
  dbUrl = `sqlite:${join(workDir, "cli.db")}`;
  // Bootstrap FIRST so an admin token exists, then seed adapter-level data.
  const { token } = await bootstrap(dbUrl);
  rootToken = token;
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
    const out = run("docs", "get", "welcome.md");
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/^---\n/);
    expect(out.stdout).toContain("title: Welcome");
    expect(out.stdout).toContain("# Welcome");
  });

  it("docs get --json — returns a Version envelope", () => {
    const out = run("--json", "docs", "get", "welcome.md");
    expect(out.status).toBe(0);
    const v = JSON.parse(out.stdout);
    expect(v.repo).toBe("notes");
    expect(v.path).toBe("welcome.md");
    expect(v.version_id).toMatch(/^v\d+$/);
    expect(v.next_version_id).toBeNull();
    expect(v.author).toEqual({ user: "alice" });
  });

  it("docs history — newest-first with the current-marker", () => {
    const out = run("docs", "history", "welcome.md");
    expect(out.status).toBe(0);
    // Two lines of data (the second welcome revision has 2 versions).
    expect(out.stdout).toMatch(/current/);
  });

  it("doc_not_found exits 4", () => {
    const out = run("docs", "get", "missing.md");
    expect(out.status).toBe(4);
    expect(out.stderr).toContain("doc_not_found");
  });

  it("repo_not_found exits 4", () => {
    const out = run("-r", "nope", "docs", "get", "welcome.md");
    expect(out.status).toBe(4);
    expect(out.stderr).toContain("repo_not_found");
  });

  it("version_not_found exits 4 for malformed id", () => {
    const out = run("docs", "get-version", "not-a-version");
    expect(out.status).toBe(4);
    expect(out.stderr).toContain("version_not_found");
  });

  it("--limit rejects non-integer / partial-parse / non-positive values", () => {
    for (const bad of ["2x", "abc", "0", "-1", "1.5", ""]) {
      const out = run("docs", "history", "welcome.md", "--limit", bad);
      expect(out.status).not.toBe(0);
      expect(out.stderr).toMatch(/positive integer/);
    }
  });

  it("docs get emits exactly one trailing newline (no blank line at end)", () => {
    const out = run("docs", "get", "welcome.md");
    expect(out.status).toBe(0);
    // Body already ends in \n; the CLI must add zero extras.
    expect(out.stdout.endsWith("\n")).toBe(true);
    expect(out.stdout.endsWith("\n\n")).toBe(false);
  });

  it("no token → exit 3 (unauthorized) — the removed fallback", () => {
    const res = spawnSync(
      "npx",
      ["--no-install", "tsx", CLI, "--database", dbUrl, "repos", "list"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...(process.env as Record<string, string>),
          MRPLEX_TOKEN: "",
          XDG_CONFIG_HOME: workDir,
        },
      },
    );
    expect(res.status).toBe(3);
    expect(res.stderr).toContain("unauthorized");
  });
});
