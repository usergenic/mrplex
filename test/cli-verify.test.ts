/**
 * CLI `mrplex verify` end-to-end (docs/verify-plan.md §5). Spawns the CLI in
 * local mode against a SQLite db, asserts the human/JSON output, the --ci exit
 * code, and repo-scoped skip notes. Corruption is injected via a raw
 * better-sqlite3 handle (the store's own write path won't produce these states).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VerifyReport } from "../src/kernel/wire.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(REPO_ROOT, "src", "cli", "main.ts");

let workDir: string;
let dbFile: string;
let dbUrl: string;

function run(args: string[], input?: string): { stdout: string; stderr: string; status: number } {
  const res = spawnSync("node", ["--import", "tsx", CLI, "--database", dbUrl, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    ...(input !== undefined && { input }),
    env: {
      ...(process.env as Record<string, string>),
      XDG_CONFIG_HOME: workDir,
      MRPLEX_EMBEDDER: "",
    },
  });
  return { stdout: res.stdout, stderr: res.stderr, status: res.status ?? 1 };
}

function createDoc(path: string, body: string): void {
  const out = run(["-r", "notes", "docs", "create", path, "--from-file", "-"], body);
  if (out.status !== 0) throw new Error(`create ${path} failed: ${out.stderr}`);
}

/** Mutate the db via a raw handle (corruption the write path won't produce). */
function corrupt(sql: string): void {
  const db = new Database(dbFile);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "mrplex-cli-verify-"));
  mkdirSync(workDir, { recursive: true });
  dbFile = join(workDir, "verify.db");
  dbUrl = `sqlite:${dbFile}`;
  run(["repos", "create", "notes"]);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("cli verify", () => {
  it("reports clean on a healthy store and exits 0 under --ci", () => {
    createDoc("a.md", "see [B](b.md)");
    createDoc("b.md", "hi");
    const out = run(["verify", "--ci"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("clean — no findings");
    expect(out.stdout).toContain("scanned 2 versions across 2 documents");
  });

  it("emits a structured report with --json", () => {
    createDoc("a.md", "body");
    const out = run(["--json", "verify"]);
    expect(out.status).toBe(0);
    const report = JSON.parse(out.stdout) as VerifyReport;
    expect(report.findings).toEqual([]);
    expect(report.counts.documents_scanned).toBe(1);
    // No embedder in this env → chunks.unembedded skipped-and-noted.
    expect(report.checks_skipped).toContainEqual({
      check: "chunks.unembedded",
      reason: "no embedder configured",
    });
  });

  it("finds a hash mismatch and exits 1 under --ci", () => {
    createDoc("a.md", "real body");
    corrupt("update versions set content_hash = 'deadbeef' where path = 'a.md'");
    const out = run(["verify", "--check", "hash", "--ci"]);
    expect(out.status).toBe(1);
    expect(out.stdout).toContain("hash.mismatch");
    expect(out.stdout).toContain("1 error");
  });

  it("--json surfaces the finding detail", () => {
    createDoc("a.md", "real body");
    corrupt("update versions set content_hash = 'deadbeef' where path = 'a.md'");
    const out = run(["--json", "verify", "--check", "hash.mismatch"]);
    const report = JSON.parse(out.stdout) as VerifyReport;
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.check).toBe("hash.mismatch");
    expect(report.findings[0]?.detail.stored).toBe("deadbeef");
  });

  it("skips the fts family with a note under a --repo filter", () => {
    createDoc("a.md", "body");
    const out = run(["-r", "notes", "verify", "--check", "fts"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("skipped fts");
  });

  it("rejects a glob repo", () => {
    const out = run(["-r", "note*", "verify"]);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("pattern");
  });

  it("rejects a bad --severity value", () => {
    const out = run(["verify", "--severity", "loud"]);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("severity");
  });
});
