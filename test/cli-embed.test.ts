/**
 * CLI embed backfill repo-resolution regression.
 *
 * `embed backfill` used to redeclare `-r, --repo` as a subcommand
 * requiredOption on top of the root program's global -r, which in
 * Commander 12 meant the required check was never satisfied and parse
 * threw "required option '-r, --repo <slug>' not specified" no matter
 * how the flag was passed. It must resolve the repo from globals like
 * every other repo-scoped command (-r / MRPLEX_REPO / config).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(REPO_ROOT, "src", "cli", "main.ts");
const STUB = join(REPO_ROOT, "scripts", "stub-embedder.mjs");

let workDir: string;
let dbUrl: string;

function run(
  args: string[],
  extraEnv?: Record<string, string>,
): { stdout: string; stderr: string; status: number } {
  // Strip any ambient MRPLEX_REPO so it can't leak into resolution unless a
  // test sets it explicitly via extraEnv.
  const { MRPLEX_REPO: _ignored, ...parentEnv } = process.env as Record<string, string>;
  const env: Record<string, string> = {
    ...parentEnv,
    XDG_CONFIG_HOME: workDir,
    ...(extraEnv ?? {}),
  };
  const res = spawnSync("node", ["--import", "tsx", CLI, "--database", dbUrl, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env,
  });
  return { stdout: res.stdout, stderr: res.stderr, status: res.status ?? 1 };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "mrplex-cli-embed-"));
  mkdirSync(workDir, { recursive: true });
  dbUrl = `sqlite:${join(workDir, "embed.db")}`;
  run(["repos", "create", "notes"]);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("cli embed backfill repo resolution", () => {
  it("accepts -r/--repo without a parse error and runs the backfill", () => {
    const out = run([
      "--json",
      "-r",
      "notes",
      "embed",
      "backfill",
      "--embedder",
      `node ${STUB} --stdio`,
    ]);
    // The regression: parse used to fail before ever reaching the action.
    expect(out.stderr).not.toMatch(/required option '-r, --repo/);
    expect(out.status).toBe(0);
    const report = JSON.parse(out.stdout) as { enqueued: number; failed: number };
    expect(report.failed).toBe(0);
  });

  it("resolves the repo from MRPLEX_REPO when no flag is given", () => {
    const out = run(["--json", "embed", "backfill", "--embedder", `node ${STUB} --stdio`], {
      MRPLEX_REPO: "notes",
    });
    expect(out.stderr).not.toMatch(/required option '-r, --repo/);
    expect(out.status).toBe(0);
  });

  it("emits the shared friendly error when no repo source is set", () => {
    const out = run(["embed", "backfill", "--embedder", `node ${STUB} --stdio`]);
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/no repo/);
    expect(out.stderr).toMatch(/MRPLEX_REPO/);
  });
});
