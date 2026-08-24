/**
 * CLI links commands + graph-filter query end-to-end (links-plan.md WS6).
 * Spawns the CLI in local mode against a bootstrapped SQLite db.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(REPO_ROOT, "src", "cli", "main.ts");

let workDir: string;
let dbUrl: string;

function run(args: string[], input?: string): { stdout: string; stderr: string; status: number } {
  const res = spawnSync("node", ["--import", "tsx", CLI, "--database", dbUrl, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    ...(input !== undefined && { input }),
    env: {
      ...(process.env as Record<string, string>),
      XDG_CONFIG_HOME: workDir,
    },
  });
  return { stdout: res.stdout, stderr: res.stderr, status: res.status ?? 1 };
}

// `docs create` reads the document from stdin (--from-file -); body only, no
// frontmatter delimiter needed for these tests. Repo is the global -r flag.
function createDoc(path: string, body: string): void {
  const out = run(["-r", "notes", "docs", "create", path, "--from-file", "-"], body);
  if (out.status !== 0) throw new Error(`create ${path} failed: ${out.stderr}`);
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "mrplex-cli-links-"));
  mkdirSync(workDir, { recursive: true });
  dbUrl = `sqlite:${join(workDir, "links.db")}`;
  run(["repos", "create", "notes"]);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("cli links", () => {
  it("graph filter query returns membership", async () => {
    createDoc("alice.md", "hi");
    createDoc("moc.md", "- [[alice]]");
    const out = run(["--json", "-r", "notes", "query", "--filter", '$in_static("moc.md")']);
    expect(out.status).toBe(0);
    const rows = JSON.parse(out.stdout) as { $path: string }[];
    expect(rows.map((r) => r.$path)).toEqual(["alice.md"]);
  });

  it("bare $in works (== $in_static today)", async () => {
    createDoc("alice.md", "hi");
    createDoc("moc.md", "- [[alice]]");
    const out = run(["--json", "-r", "notes", "query", "--filter", '$in("moc.md")']);
    expect(out.status).toBe(0);
    expect((JSON.parse(out.stdout) as { $path: string }[]).map((r) => r.$path)).toEqual([
      "alice.md",
    ]);
  });

  it("reserved _dyn name errors with a clear message (exit 1)", async () => {
    createDoc("x.md", "hi");
    const out = run(["-r", "notes", "query", "--filter", '$in_dyn("x.md")']);
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/Phase 2|_static/);
  });

  it("links backfill rebuilds the index", async () => {
    createDoc("a.md", "a");
    createDoc("note.md", "[a](a.md)");
    const out = run(["--json", "-r", "notes", "links", "backfill"]);
    expect(out.status).toBe(0);
    const report = JSON.parse(out.stdout) as { documents: number; edges: number };
    expect(report.documents).toBe(2);
    expect(report.edges).toBe(1);
  });

  it("links stale + repair round-trip", async () => {
    createDoc("horses.md", "neigh");
    createDoc("note.md", "see [h](horses.md)");
    // Move the target so note.md's link text goes stale.
    const getJson = run(["--json", "-r", "notes", "docs", "get", "horses.md"]);
    const version = (JSON.parse(getJson.stdout) as { version_id: string }).version_id;
    const mv = run(["-r", "notes", "docs", "mv", "animals/horses.md", "--prev", version]);
    expect(mv.status).toBe(0);

    // stale lists it.
    const stale = run(["--json", "-r", "notes", "links", "stale"]);
    expect(stale.status).toBe(0);
    const staleRows = JSON.parse(stale.stdout) as { source_path: string; current: string }[];
    expect(staleRows).toHaveLength(1);
    expect(staleRows[0]?.current).toBe("animals/horses.md");

    // dry-run changes nothing.
    const dry = run(["--json", "-r", "notes", "links", "repair", "--dry-run"]);
    expect(dry.status).toBe(0);
    expect((JSON.parse(dry.stdout) as { dry_run: boolean }).dry_run).toBe(true);
    const stillStale = run(["--json", "-r", "notes", "links", "stale"]);
    expect((JSON.parse(stillStale.stdout) as unknown[]).length).toBe(1);

    // repair rewrites, then stale is empty.
    const repair = run(["--json", "-r", "notes", "links", "repair"]);
    expect(repair.status).toBe(0);
    const afterStale = run(["--json", "-r", "notes", "links", "stale"]);
    expect((JSON.parse(afterStale.stdout) as unknown[]).length).toBe(0);

    // note.md now points at the new path.
    const note = run(["--json", "-r", "notes", "docs", "get", "note.md"]);
    expect((JSON.parse(note.stdout) as { body: string }).body).toContain("animals/horses.md");
  });
});
