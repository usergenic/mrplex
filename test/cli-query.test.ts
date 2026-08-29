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
import { sqliteAdapter } from "../src/storage-sqlite/adapter.js";
import type { Storage } from "../src/storage/types.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(REPO_ROOT, "src", "cli", "main.ts");
const STUB = join(REPO_ROOT, "scripts", "stub-embedder.mjs");

let workDir: string;
let dbUrl: string;
let storage: Storage;
let notesRepoId: number;

function run(...args: string[]): { stdout: string; stderr: string; status: number } {
  const { MRPLEX_EMBEDDER: _ignored, ...parentEnv } = process.env as Record<string, string>;
  const res = spawnSync("node", ["--import", "tsx", CLI, "--database", dbUrl, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...parentEnv,
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
      author: "alice",
      created_at: new Date(Date.UTC(2026, 7, 14, 0, 0, clock++)).toISOString(),
    });
  }
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "mrplex-cli-query-"));
  mkdirSync(workDir, { recursive: true });
  dbUrl = `sqlite:${join(workDir, "q.db")}`;
  storage = await sqliteAdapter.open({ database: dbUrl });
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
    const results = JSON.parse(out.stdout) as { $path: string }[];
    expect(results.map((r) => r.$path)).toEqual(["pricing.md"]);
  });

  it("text only — FTS", async () => {
    const out = run("--json", "query", "--repo", "notes", "--text", "welcome");
    expect(out.status).toBe(0);
    const results = JSON.parse(out.stdout) as { $path: string }[];
    expect(results.map((r) => r.$path)).toEqual(["welcome.md"]);
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
    const results = JSON.parse(out.stdout) as { $path: string }[];
    expect(results.map((r) => r.$path)).toEqual(["pricing.md"]);
  });

  it('list() polymorphism — "guide" in list(tags) matches both scalar and list shapes', async () => {
    const out = run("--json", "query", "--repo", "notes", "--filter", '"guide" in list(tags)');
    expect(out.status).toBe(0);
    const results = JSON.parse(out.stdout) as { $path: string }[];
    expect(results.map((r) => r.$path)).toEqual(["guides/getting-started.md"]);
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
    const results = JSON.parse(out.stdout) as { $path: string }[];
    expect(results.map((r) => r.$path)).toEqual(["guides/getting-started.md"]);
  });

  it("--path bare basename matches at any depth", async () => {
    const out = run("--json", "query", "--repo", "notes", "--path", "getting-started.md");
    expect(out.status).toBe(0);
    const results = JSON.parse(out.stdout) as { $path: string }[];
    expect(results.map((r) => r.$path)).toEqual(["guides/getting-started.md"]);
  });

  it("--path leading / anchors to root", async () => {
    const out = run("--json", "query", "--repo", "notes", "--path", "/welcome.md");
    expect(out.status).toBe(0);
    const results = JSON.parse(out.stdout) as { $path: string }[];
    expect(results.map((r) => r.$path)).toEqual(["welcome.md"]);
  });

  it("--path segment glob does not cross /", async () => {
    const out = run("--json", "query", "--repo", "notes", "--path", "guides/*");
    expect(out.status).toBe(0);
    const results = JSON.parse(out.stdout) as { $path: string }[];
    expect(results.map((r) => r.$path)).toEqual(["guides/getting-started.md"]);
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
    const results = JSON.parse(out.stdout) as { $path: string }[];
    expect(results.map((r) => r.$path)).toEqual(["pricing.md"]);
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

  it("pretty output renders a table with the projected columns", async () => {
    const out = run("query", "--repo", "notes", "--filter", 'status == "published"');
    expect(out.status).toBe(0);
    // Default projection is $path only, so that's the single column header.
    expect(out.stdout).toContain("$path");
    expect(out.stdout).toContain("pricing.md");
  });

  it("--select projects the named columns (repeatable)", async () => {
    const out = run(
      "--json",
      "query",
      "--repo",
      "notes",
      "--filter",
      'status == "published"',
      "-s",
      "$path",
      "-s",
      "$repo",
      "-s",
      "status",
    );
    expect(out.status).toBe(0);
    const results = JSON.parse(out.stdout) as Record<string, unknown>[];
    expect(results).toEqual([{ $path: "pricing.md", $repo: "notes", status: "published" }]);
  });

  it("malformed CEL returns filter_invalid, exit 1", async () => {
    const out = run("query", "--repo", "notes", "--filter", "this is [ not valid CEL");
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("filter_invalid");
  });

  it("semantic without an embed hook → semantic_unavailable", async () => {
    const out = run("query", "--repo", "notes", "--semantic", "welcome");
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("semantic_unavailable");
  });

  it("--embedder enables semantic search in local mode", async () => {
    const embedCmd = `node ${STUB} --stdio`;
    const backfill = run("--json", "-r", "notes", "embed", "backfill", "--embed-cmd", embedCmd);
    expect(backfill.status).toBe(0);

    const out = run(
      "--json",
      "query",
      "--repo",
      "notes",
      "--semantic",
      "welcome",
      "--embed-cmd",
      embedCmd,
    );
    expect(out.status).toBe(0);
    const results = JSON.parse(out.stdout) as { $path: string }[];
    expect(results.map((r) => r.$path)).toContain("welcome.md");
  });
});
