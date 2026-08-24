/**
 * `mrplex tail` — the reference change-feed consumer (sync/history plan §3.6).
 * NDJSON of VersionRefs, one per line; crash-resume via `--since`.
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
    env: { ...(process.env as Record<string, string>), XDG_CONFIG_HOME: workDir },
  });
  return { stdout: res.stdout, stderr: res.stderr, status: res.status ?? 1 };
}

/** Create a doc by piping its markdown over stdin (`--from-file -`). */
function createDoc(
  repo: string,
  path: string,
  markdown: string,
): { stdout: string; stderr: string; status: number } {
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
  return { stdout: res.stdout, stderr: res.stderr, status: res.status ?? 1 };
}

type Ref = { version_id: string; path: string; op: string; content_hash: string; repo: string };

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "mrplex-tail-"));
  mkdirSync(workDir, { recursive: true });
  dbUrl = `sqlite:${join(workDir, "tail.db")}`;
  // Build a small known history rather than the full seed.
  expect(run("repos", "create", "notes").status).toBe(0);
  expect(createDoc("notes", "a.md", "one\n").status).toBe(0);
  expect(createDoc("notes", "b.md", "two\n").status).toBe(0);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("mrplex tail", () => {
  it("emits one NDJSON VersionRef per line from the beginning", () => {
    const out = run("tail");
    expect(out.status).toBe(0);
    const lines = out.stdout.trim().split("\n").filter(Boolean);
    const refs = lines.map((l) => JSON.parse(l) as Ref);
    expect(refs.map((r) => r.path)).toEqual(["a.md", "b.md"]);
    expect(refs.every((r) => r.op === "create")).toBe(true);
    expect(refs.every((r) => /^[0-9a-f]{64}$/.test(r.content_hash))).toBe(true);
  });

  it("--since resumes past a cursor (crash-resume)", () => {
    const all = run("tail").stdout.trim().split("\n").filter(Boolean);
    const first = JSON.parse(all[0] as string) as Ref;
    const rest = run("tail", "--since", first.version_id);
    expect(rest.status).toBe(0);
    const refs = rest.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Ref);
    expect(refs.map((r) => r.path)).toEqual(["b.md"]);
  });

  it("--repo filters the feed", () => {
    expect(run("repos", "create", "other").status).toBe(0);
    expect(createDoc("other", "z.md", "z\n").status).toBe(0);
    // The repo filter rides the global -r/--repo flag.
    const out = run("-r", "notes", "tail");
    const refs = out.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Ref);
    expect(refs.every((r) => r.repo === "notes")).toBe(true);
    expect(refs.map((r) => r.path)).toEqual(["a.md", "b.md"]);
  });
});
