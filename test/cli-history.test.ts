/**
 * `mrplex history` — the scoped, document-spanning walk (sync/history §3.5),
 * and `docs history` folded onto it. Exercised end-to-end through the CLI.
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

function run(...args: string[]): { stdout: string; stderr: string; status: number } {
  const res = spawnSync("node", ["--import", "tsx", CLI, "--database", dbUrl, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...(process.env as Record<string, string>),
      MRPLEX_REPO: "notes",
      XDG_CONFIG_HOME: workDir,
    },
  });
  return { stdout: res.stdout, stderr: res.stderr, status: res.status ?? 1 };
}

function createDoc(path: string, body: string): void {
  const res = spawnSync(
    "node",
    [
      "--import",
      "tsx",
      CLI,
      "--database",
      dbUrl,
      "-r",
      "notes",
      "docs",
      "create",
      path,
      "--from-file",
      "-",
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      input: body,
      env: { ...(process.env as Record<string, string>), XDG_CONFIG_HOME: workDir },
    },
  );
  if ((res.status ?? 1) !== 0) throw new Error(`create failed: ${res.stderr}`);
}

type Row = { version_id: string; path: string };

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "mrplex-hist-"));
  mkdirSync(workDir, { recursive: true });
  dbUrl = `sqlite:${join(workDir, "hist.db")}`;
  expect(run("repos", "create", "notes").status).toBe(0);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("mrplex history", () => {
  it("spans documents by glob", () => {
    createDoc("guides/a.md", "1\n");
    createDoc("other/b.md", "2\n");
    createDoc("guides/c.md", "3\n");
    const out = run("--json", "history", "guides/**", "--order", "asc");
    expect(out.status).toBe(0);
    const rows = JSON.parse(out.stdout) as Row[];
    expect(rows.map((r) => r.path)).toEqual(["guides/a.md", "guides/c.md"]);
  });

  it("--ever surfaces a moved-away document, default does not", () => {
    createDoc("old.md", "x\n");
    // Move old.md → new.md via docs put (embedded $version round-trip).
    const got = run("--json", "docs", "get", "old.md");
    const v = JSON.parse(got.stdout) as { version_id: string };
    const mv = spawnSync(
      "node",
      [
        "--import",
        "tsx",
        CLI,
        "--database",
        dbUrl,
        "-r",
        "notes",
        "docs",
        "put",
        "new.md",
        "--prev",
        v.version_id,
        "--from-file",
        "-",
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        input: "x\n",
        env: { ...(process.env as Record<string, string>), XDG_CONFIG_HOME: workDir },
      },
    );
    expect(mv.status).toBe(0);

    const live = JSON.parse(run("--json", "history", "old.md").stdout) as Row[];
    expect(live).toEqual([]);
    const ever = JSON.parse(run("--json", "history", "old.md", "--ever").stdout) as Row[];
    expect(ever.length).toBe(2);
  });

  it("docs history reproduces a single-path walk", () => {
    createDoc("a.md", "1\n");
    const v1 = JSON.parse(run("--json", "docs", "get", "a.md").stdout) as { version_id: string };
    const put = spawnSync(
      "node",
      [
        "--import",
        "tsx",
        CLI,
        "--database",
        dbUrl,
        "-r",
        "notes",
        "docs",
        "put",
        "a.md",
        "--prev",
        v1.version_id,
        "--from-file",
        "-",
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        input: "2\n",
        env: { ...(process.env as Record<string, string>), XDG_CONFIG_HOME: workDir },
      },
    );
    expect(put.status).toBe(0);
    const rows = JSON.parse(run("--json", "docs", "history", "a.md").stdout) as Row[];
    // Newest-first, whole chain.
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.path === "a.md")).toBe(true);
  });
});
