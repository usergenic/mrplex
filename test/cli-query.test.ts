/**
 * CLI query end-to-end — the m2-plan §6 acceptance transcript.
 * Spawns tsx directly (avoiding safe-chain shim noise).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrap } from "../src/cli/bootstrap.js";
import { sqliteAdapter } from "../src/storage-sqlite/adapter.js";
import type { Storage, UserRow } from "../src/storage/types.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(REPO_ROOT, "src", "cli", "main.ts");

let workDir: string;
let dbUrl: string;
let rootToken: string;
let storage: Storage;
let alice: UserRow;
let notesRepoId: number;

function run(...args: string[]): { stdout: string; stderr: string; status: number } {
  const res = spawnSync("node", ["--import", "tsx", CLI, "--database", dbUrl, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...(process.env as Record<string, string>),
      MRPLEX_TOKEN: rootToken,
      XDG_CONFIG_HOME: workDir,
    },
  });
  return { stdout: res.stdout, stderr: res.stderr, status: res.status ?? 1 };
}

async function seedAll(): Promise<void> {
  // Seed at adapter level so we can supply mixed frontmatter shapes.
  await storage.repos_create({ slug: "notes", created_at: "2026-08-14T00:00:00Z" });
  const rows = await storage.repos_by_slug("notes");
  if (!rows) throw new Error("seed");
  notesRepoId = rows.id;
  const rowsList = [
    {
      path: "welcome.md",
      fm: { title: "Welcome", tags: ["intro", "meta"] },
      body: "Welcome to mrplex",
    },
    {
      path: "guides/getting-started.md",
      fm: { title: "Getting started", tags: "guide" },
      body: "How to begin",
    },
    { path: "readme.md", fm: {}, body: "no frontmatter here" },
    { path: "pricing.md", fm: { status: "published", tags: ["pricing"] }, body: "pricing details" },
  ];
  let clock = 100;
  for (const r of rowsList) {
    const doc = await storage.documents_create(notesRepoId);
    await storage.version_insert({
      document_id: doc.id,
      repo_id: notesRepoId,
      prev_id: null,
      path: r.path,
      frontmatter_raw: "",
      frontmatter: r.fm,
      body: r.body,
      author_id: alice.id,
      created_at: new Date(Date.UTC(2026, 7, 14, 0, 0, clock++)).toISOString(),
    });
  }
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "mrplex-cli-query-"));
  mkdirSync(workDir, { recursive: true });
  dbUrl = `sqlite:${join(workDir, "q.db")}`;
  ({ token: rootToken } = await bootstrap(dbUrl));
  storage = await sqliteAdapter.open({ database: dbUrl });
  alice = await storage.users_create({ slug: "alice", created_at: "2026-08-14T00:00:00Z" });
  await seedAll();
  await storage.close();
});

afterEach(async () => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("cli query", () => {
  it("filter only — CEL predicate over frontmatter", async () => {
    const out = run("--json", "query", "--repo", "notes", "--filter", 'status == "published"');
    expect(out.status).toBe(0);
    const results = JSON.parse(out.stdout) as { path: string }[];
    expect(results.map((r) => r.path)).toEqual(["pricing.md"]);
  });

  it("text only — FTS", async () => {
    const out = run("--json", "query", "--repo", "notes", "--text", "welcome");
    expect(out.status).toBe(0);
    const results = JSON.parse(out.stdout) as { path: string }[];
    expect(results.map((r) => r.path)).toEqual(["welcome.md"]);
  });

  it("filter + text compose via AND", async () => {
    const out = run(
      "--json",
      "query",
      "--repo",
      "notes",
      "--filter",
      '"pricing" in list(tags)',
      "--text",
      "details",
    );
    expect(out.status).toBe(0);
    const results = JSON.parse(out.stdout) as { path: string }[];
    expect(results.map((r) => r.path)).toEqual(["pricing.md"]);
  });

  it('list() polymorphism — "guide" in list(tags) matches both scalar and list shapes', async () => {
    const out = run("--json", "query", "--repo", "notes", "--filter", '"guide" in list(tags)');
    expect(out.status).toBe(0);
    const results = JSON.parse(out.stdout) as { path: string }[];
    expect(results.map((r) => r.path)).toEqual(["guides/getting-started.md"]);
  });

  it("$path intrinsic", async () => {
    const out = run(
      "--json",
      "query",
      "--repo",
      "notes",
      "--filter",
      '$path.startsWith("guides/")',
    );
    expect(out.status).toBe(0);
    const results = JSON.parse(out.stdout) as { path: string }[];
    expect(results.map((r) => r.path)).toEqual(["guides/getting-started.md"]);
  });

  it("--path bare basename matches at any depth", async () => {
    const out = run("--json", "query", "--repo", "notes", "--path", "getting-started.md");
    expect(out.status).toBe(0);
    const results = JSON.parse(out.stdout) as { path: string }[];
    expect(results.map((r) => r.path)).toEqual(["guides/getting-started.md"]);
  });

  it("--path leading / anchors to root", async () => {
    const out = run("--json", "query", "--repo", "notes", "--path", "/welcome.md");
    expect(out.status).toBe(0);
    const results = JSON.parse(out.stdout) as { path: string }[];
    expect(results.map((r) => r.path)).toEqual(["welcome.md"]);
  });

  it("--path segment glob does not cross /", async () => {
    const out = run("--json", "query", "--repo", "notes", "--path", "guides/*");
    expect(out.status).toBe(0);
    const results = JSON.parse(out.stdout) as { path: string }[];
    expect(results.map((r) => r.path)).toEqual(["guides/getting-started.md"]);
  });

  it("--path composes with --filter via AND", async () => {
    const out = run(
      "--json",
      "query",
      "--repo",
      "notes",
      "--path",
      "*.md",
      "--filter",
      'status == "published"',
    );
    expect(out.status).toBe(0);
    const results = JSON.parse(out.stdout) as { path: string }[];
    expect(results.map((r) => r.path)).toEqual(["pricing.md"]);
  });

  it("--limit caps results", async () => {
    const out = run("--json", "query", "--repo", "notes", "--limit", "2");
    expect(out.status).toBe(0);
    const results = JSON.parse(out.stdout) as unknown[];
    expect(results).toHaveLength(2);
  });

  it("--limit rejects non-positive-integers", async () => {
    const out = run("query", "--repo", "notes", "--limit", "abc");
    expect(out.status).not.toBe(0);
    expect(out.stderr).toMatch(/positive integer/);
  });

  it("pretty output renders a table", async () => {
    const out = run("query", "--repo", "notes", "--filter", 'status == "published"');
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("REPO");
    expect(out.stdout).toContain("PATH");
    expect(out.stdout).toContain("pricing.md");
  });

  it("malformed CEL returns filter_invalid, exit 1", async () => {
    const out = run("query", "--repo", "notes", "--filter", "this is [ not valid CEL");
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("filter_invalid");
  });
});
