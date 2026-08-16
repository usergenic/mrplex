/**
 * CLI end-to-end M1 flow — the m1-plan §6 acceptance transcript.
 *
 * bootstrap → create user/repo → create doc → put (update) → mv → delete →
 * restore → history. Also exercises tokens list/create/revoke and the
 * per-family exit codes.
 *
 * Spawns tsx directly (not npm) so we don't fight the environment's
 * safe-chain shim or other npm-side chatter.
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
let rootToken: string;

function run(
  args: string[],
  opts?: { stdin?: string; token?: string; env?: Record<string, string> },
): { stdout: string; stderr: string; status: number } {
  const token = opts?.token ?? rootToken;
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...opts?.env,
  };
  if (token) env.MRPLEX_TOKEN = token;
  // Default MRPLEX_REPO=notes: every scenario in this file uses the `notes`
  // repo. Callers can override via `opts.env` when needed.
  if (env.MRPLEX_REPO === undefined) env.MRPLEX_REPO = "notes";
  // Isolate the CLI config to the workdir so per-user ~/.config doesn't leak
  // in between test runs.
  env.XDG_CONFIG_HOME = workDir;
  const res = spawnSync("npx", ["--no-install", "tsx", CLI, "--database", dbUrl, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    input: opts?.stdin,
    env,
  });
  return { stdout: res.stdout, stderr: res.stderr, status: res.status ?? 1 };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "mrplex-cli-m1-"));
  mkdirSync(workDir, { recursive: true });
  dbUrl = `sqlite:${join(workDir, "m1.db")}`;
  // Bootstrap. First call has no token; bootstrap writes to stdout.
  const boot = run(["bootstrap", "--json"], { token: "" });
  if (boot.status !== 0) {
    throw new Error(`bootstrap failed: ${boot.stderr}`);
  }
  const parsed = JSON.parse(boot.stdout) as { token: string };
  rootToken = parsed.token;
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("cli m1 — end-to-end flow", () => {
  it("bootstrap → create → put → mv → delete → restore → history", () => {
    // Create user + repo.
    expect(run(["users", "create", "alice"]).status).toBe(0);
    expect(run(["repos", "create", "notes"]).status).toBe(0);

    // docs create — read frontmatter from stdin.
    const created = run(["--json", "docs", "create", "hello.md", "--from-file", "-"], {
      stdin: "---\ntitle: Hello\n---\nbody v1\n",
    });
    expect(created.status).toBe(0);
    const v1 = JSON.parse(created.stdout) as { version_id: string; body: string; path: string };
    expect(v1.body).toBe("body v1\n");
    expect(v1.path).toBe("hello.md");

    // docs put — update the body.
    const put = run(
      ["--json", "docs", "put", "hello.md", "--prev", v1.version_id, "--from-file", "-"],
      { stdin: "---\ntitle: Hello\n---\nbody v2\n" },
    );
    expect(put.status).toBe(0);
    const v2 = JSON.parse(put.stdout) as { version_id: string; body: string };
    expect(v2.body).toBe("body v2\n");

    // docs mv — move to a new path.
    const mv = run([
      "--json",
      "docs",
      "mv",
      "hello.md",
      "greetings/hi.md",
      "--prev",
      v2.version_id,
    ]);
    expect(mv.status).toBe(0);
    const v3 = JSON.parse(mv.stdout) as { version_id: string; path: string };
    expect(v3.path).toBe("greetings/hi.md");

    // docs delete.
    const del = run(["--json", "docs", "delete", "greetings/hi.md", "--prev", v3.version_id]);
    expect(del.status).toBe(0);
    const v4 = JSON.parse(del.stdout) as { version_id: string; path: string };
    expect(v4.path).toMatch(/^:deleted\//);

    // docs put — restore.
    const restore = run(["--json", "docs", "put", "greetings/hi.md", "--prev", v4.version_id]);
    expect(restore.status).toBe(0);
    const v5 = JSON.parse(restore.stdout) as { version_id: string; path: string };
    expect(v5.path).toBe("greetings/hi.md");

    // docs history — should have 5 entries in reverse chain order.
    const hist = run(["--json", "docs", "history", "greetings/hi.md"]);
    expect(hist.status).toBe(0);
    const history = JSON.parse(hist.stdout) as { version_id: string; path: string }[];
    expect(history).toHaveLength(5);
    expect(history[0]?.version_id).toBe(v5.version_id);
  });

  it("stale_prev exits 2 with current attached", () => {
    expect(run(["repos", "create", "notes"]).status).toBe(0);
    const created = run(["--json", "docs", "create", "x.md", "--from-file", "-"], {
      stdin: "---\n---\nv1\n",
    });
    const v1 = JSON.parse(created.stdout) as { version_id: string };
    // First put advances.
    const put1 = run(
      ["--json", "docs", "put", "x.md", "--prev", v1.version_id, "--from-file", "-"],
      { stdin: "---\n---\nv2\n" },
    );
    expect(put1.status).toBe(0);
    // Second put with the STALE v1 → exit 2.
    const put2 = run(["docs", "put", "x.md", "--prev", v1.version_id, "--from-file", "-"], {
      stdin: "---\n---\nv3\n",
    });
    expect(put2.status).toBe(2);
    expect(put2.stderr).toContain("stale_prev");
    expect(put2.stderr).toContain("current_version_id");
  });

  it("path_invalid exits 1", () => {
    expect(run(["repos", "create", "notes"]).status).toBe(0);
    const res = run(["docs", "create", ":deleted/nope.md", "--from-file", "-"], {
      stdin: "---\n---\nb\n",
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("path_invalid");
  });

  it("forbidden exits 3 (non-admin cannot create a repo)", () => {
    // Create a narrow token that has no admin bit.
    expect(run(["repos", "create", "notes"]).status).toBe(0);
    const scoped = run([
      "--json",
      "tokens",
      "create",
      "--label",
      "narrow",
      "--scope",
      "notes:read=**",
    ]);
    expect(scoped.status).toBe(0);
    const { token } = JSON.parse(scoped.stdout) as { token: string };
    // Try to create another repo with the narrow token → forbidden.
    const denied = run(["repos", "create", "another"], { token });
    expect(denied.status).toBe(3);
    expect(denied.stderr).toContain("forbidden");
  });

  it("tokens list/create/revoke round-trip", () => {
    // Create a token — the plaintext is the whole stdout line.
    const created = run(["--json", "tokens", "create", "--label", "test", "--scope", "*:read=**"]);
    expect(created.status).toBe(0);
    const { meta } = JSON.parse(created.stdout) as {
      token: string;
      meta: { id: string; label: string };
    };
    expect(meta.label).toBe("test");
    // list includes it.
    const listed = run(["--json", "tokens", "list"]);
    const list = JSON.parse(listed.stdout) as { id: string }[];
    expect(list.some((t) => t.id === meta.id)).toBe(true);
    // revoke it.
    const revoked = run(["--json", "tokens", "revoke", meta.id]);
    expect(revoked.status).toBe(0);
    // list no longer includes it.
    const listedAgain = run(["--json", "tokens", "list"]);
    const list2 = JSON.parse(listedAgain.stdout) as { id: string }[];
    expect(list2.some((t) => t.id === meta.id)).toBe(false);
  });

  it("bootstrap refuses on non-empty database (exit 1)", () => {
    const second = run(["bootstrap"], { token: "" });
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("not empty");
  });
});
