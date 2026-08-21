/**
 * CLI smoke tests. Exercise the end-to-end path from a seeded database
 * through the CLI to stdout/stderr + exit code.
 *
 * No-auth (noauth plan): there is no bootstrap and no token requirement.
 * beforeEach just seeds the database; the CLI opens it directly.
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
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // Most `docs *` tests target the seeded `notes` repo; individual tests
    // override with an explicit `-r <slug>` when they need something else.
    MRPLEX_REPO: "notes",
    // Point config at the workdir so per-user ~/.config doesn't leak into tests.
    XDG_CONFIG_HOME: workDir,
  };
  // `node --import tsx` avoids the npx safe-chain warning that some npx
  // versions print to stdout and contaminate test assertions.
  const res = spawnSync("node", ["--import", "tsx", CLI, "--database", dbUrl, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env,
  });
  return { stdout: res.stdout, stderr: res.stderr, status: res.status ?? 1 };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "mrplex-cli-"));
  mkdirSync(workDir, { recursive: true });
  dbUrl = `sqlite:${join(workDir, "cli.db")}`;
  const seed = spawnSync("node", ["--import", "tsx", SEED, "--database", dbUrl], {
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
    expect(v.author).toBe("alice");
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

  it("--author stamps the author on writes", () => {
    const out = run("--json", "--author", "Ripley <ripley@nostromo>", "docs", "create", "log.md");
    expect(out.status).toBe(0);
    const v = JSON.parse(out.stdout);
    expect(v.author).toBe("Ripley <ripley@nostromo>");
  });

  it("writes with no --author default to the mrplex identity", () => {
    const out = run("--json", "docs", "create", "note.md");
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).author).toBe("mrplex");
  });
});
