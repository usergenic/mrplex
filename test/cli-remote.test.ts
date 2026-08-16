/**
 * CLI --server (remote MCP) integration tests — m3-plan §3 WS5 acceptance:
 * spawn `mrplex serve`, then run CLI commands with --server and verify
 * byte-identical behavior vs local mode.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrap } from "../src/cli/bootstrap.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(REPO_ROOT, "src", "cli", "main.ts");

// Prefer `node --import tsx` over `npx tsx` — `npx` prints a safe-chain
// warning to stdout on some machines, which contaminates command output.
const LOADER_ARGS = ["--import", "tsx", CLI];

function runCli(
  args: string[],
  env: Record<string, string>,
): { stdout: string; stderr: string; status: number } {
  const r = spawnSync("node", [...LOADER_ARGS, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...(process.env as Record<string, string>), ...env },
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status ?? 1 };
}

async function waitForServer(url: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 200) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server at ${url} not ready within ${timeoutMs}ms`);
}

let workDir: string;
let dbUrl: string;
let rootToken: string;
let serveProc: ChildProcess | null = null;
let baseUrl: string;
const PORT = 18400 + Math.floor(Math.random() * 100);

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "mrplex-cli-remote-"));
  mkdirSync(workDir, { recursive: true });
  dbUrl = `sqlite:${join(workDir, "test.db")}`;
  const b = await bootstrap(dbUrl);
  rootToken = b.token;

  serveProc = spawn(
    "node",
    [...LOADER_ARGS, "--database", dbUrl, "serve", "--port", String(PORT)],
    {
      cwd: REPO_ROOT,
      env: {
        ...(process.env as Record<string, string>),
        XDG_CONFIG_HOME: workDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  baseUrl = `http://127.0.0.1:${PORT}`;
  await waitForServer(baseUrl);
});

afterEach(async () => {
  if (serveProc) {
    serveProc.kill("SIGTERM");
    await new Promise((r) => {
      if (!serveProc || serveProc.exitCode !== null) return r(undefined);
      serveProc.once("exit", () => r(undefined));
      setTimeout(() => r(undefined), 2000);
    });
    serveProc = null;
  }
  rmSync(workDir, { recursive: true, force: true });
});

describe("CLI --server round-trip", () => {
  it("repos create/list via --server", () => {
    const env: Record<string, string> = {
      MRPLEX_TOKEN: rootToken,
      MRPLEX_REPO: "notes",
      XDG_CONFIG_HOME: workDir,
    };
    let r = runCli(["--server", baseUrl, "repos", "create", "notes"], env);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("created repo notes");

    r = runCli(["--server", baseUrl, "repos", "list", "--json"], env);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.length).toBe(1);
    expect(parsed[0].repo).toBe("notes");
  });

  it("docs create + get via --server matches local", () => {
    const env: Record<string, string> = {
      MRPLEX_TOKEN: rootToken,
      MRPLEX_REPO: "notes",
      XDG_CONFIG_HOME: workDir,
    };
    runCli(["--server", baseUrl, "repos", "create", "notes"], env);

    // Create via remote using --from-file with markdown-with-frontmatter.
    const docPath = join(workDir, "doc.md");
    const original = "---\nstatus: draft\n---\nhello m3\n";
    writeFileSync(docPath, original);

    let r = runCli(
      ["--server", baseUrl, "docs", "create", "hello.md", "--from-file", docPath],
      env,
    );
    expect(r.status).toBe(0);
    const versionId = r.stdout.trim();
    expect(versionId).toMatch(/^v\d+$/);

    // Read via remote — pretty output is the markdown itself.
    r = runCli(["--server", baseUrl, "docs", "get", "hello.md"], env);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(original);

    // Compare with local read on the same db.
    const local = runCli(["--database", dbUrl, "docs", "get", "hello.md"], env);
    expect(local.status).toBe(0);
    expect(local.stdout).toBe(r.stdout);
  });

  it("query via --server", () => {
    const env: Record<string, string> = {
      MRPLEX_TOKEN: rootToken,
      MRPLEX_REPO: "notes",
      XDG_CONFIG_HOME: workDir,
    };
    runCli(["--server", baseUrl, "repos", "create", "notes"], env);
    const docPath = join(workDir, "doc.md");
    writeFileSync(docPath, "---\nstatus: published\n---\nhi\n");
    runCli(["--server", baseUrl, "docs", "create", "a.md", "--from-file", docPath], env);

    const r = runCli(
      [
        "--server",
        baseUrl,
        "query",
        "--repo",
        "notes",
        "--filter",
        'status == "published"',
        "--json",
      ],
      env,
    );
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.length).toBe(1);
    expect(parsed[0].path).toBe("a.md");
  });

  it("stale_prev over remote surfaces as exit 2 with code", () => {
    const env: Record<string, string> = {
      MRPLEX_TOKEN: rootToken,
      MRPLEX_REPO: "notes",
      XDG_CONFIG_HOME: workDir,
    };
    runCli(["--server", baseUrl, "repos", "create", "notes"], env);
    const docPath = join(workDir, "doc.md");
    writeFileSync(docPath, "one\n");
    runCli(["--server", baseUrl, "docs", "create", "hello.md", "--from-file", docPath], env);

    // Update to v2, then try to put again with v1 — stale.
    writeFileSync(docPath, "two\n");
    runCli(
      ["--server", baseUrl, "docs", "put", "hello.md", "--prev", "v1", "--from-file", docPath],
      env,
    );

    writeFileSync(docPath, "three\n");
    const r = runCli(
      ["--server", baseUrl, "docs", "put", "hello.md", "--prev", "v1", "--from-file", docPath],
      env,
    );
    expect(r.status).toBe(2);
    const errPayload = JSON.parse(r.stderr.trim());
    expect(errPayload.code).toBe("stale_prev");
    expect(errPayload.data.current_version_id).toBe("v2");
  });

  it("--database + --server → exit 1 with clear message", () => {
    const env: Record<string, string> = {
      MRPLEX_TOKEN: rootToken,
      MRPLEX_REPO: "notes",
      XDG_CONFIG_HOME: workDir,
    };
    const r = runCli(["--database", dbUrl, "--server", baseUrl, "repos", "list"], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("mutually exclusive");
  });

  it("bad --server URL → exit 10 (network)", () => {
    const env: Record<string, string> = {
      MRPLEX_TOKEN: "fake",
      MRPLEX_REPO: "notes",
      XDG_CONFIG_HOME: workDir,
    };
    const r = runCli(["--server", "http://127.0.0.1:59999", "repos", "list"], env);
    expect(r.status).toBe(10);
    expect(r.stderr).toContain("network:");
  });
});
