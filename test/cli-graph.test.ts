/**
 * CLI `mrplex graph` end-to-end (docs/graph-plan.md §WS5). Spawns tsx directly
 * against a local SQLite db and checks the structured (--json) result plus the
 * three surface renders (summary default, --render yaml/mermaid).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKernel } from "../src/kernel/kernel.js";
import { sqliteAdapter } from "../src/storage-sqlite/adapter.js";
import type { Storage } from "../src/storage/types.js";

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

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "mrplex-cli-graph-"));
  mkdirSync(workDir, { recursive: true });
  dbUrl = `sqlite:${join(workDir, "g.db")}`;
  const storage: Storage = await sqliteAdapter.open({ database: dbUrl });
  const kernel = createKernel(storage);
  await kernel.repos.create({}, "notes");
  await kernel.docs.create({}, "notes", "leaf.md", { frontmatter: { title: "Leaf" }, body: "" });
  await kernel.docs.create({}, "notes", "root.md", {
    frontmatter: { title: "Root" },
    body: "[leaf](leaf.md)\n",
  });
  await storage.close();
});

afterEach(async () => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("cli graph", () => {
  it("--json returns the structured result", async () => {
    const out = run(
      "--json",
      "graph",
      "--repo",
      "notes",
      "--roots",
      "root.md",
      "--direction",
      "out",
    );
    expect(out.status).toBe(0);
    const result = JSON.parse(out.stdout) as {
      documents: { $path: string }[];
      links: { source: string; target: string; field: string }[];
      complete_degrees: number;
    };
    expect(result.documents.map((d) => d.$path)).toEqual(["root.md", "leaf.md"]);
    expect(result.links).toEqual([{ source: "root.md", target: "leaf.md", field: "$body" }]);
  });

  it("default render is the adjacency summary", async () => {
    const out = run("graph", "--repo", "notes", "--roots", "root.md", "--direction", "out");
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("root.md (0)");
    expect(out.stdout).toContain("→($body) leaf.md");
    expect(out.stdout).toContain("complete through 1 degree");
  });

  it("--render mermaid sanitizes ids (path only as a quoted label)", async () => {
    const out = run(
      "graph",
      "--repo",
      "notes",
      "--roots",
      "root.md",
      "--direction",
      "out",
      "--render",
      "mermaid",
    );
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("flowchart LR");
    expect(out.stdout).toContain('d0["root.md"]:::root');
    expect(out.stdout).toContain('d0 -->|"$body"| d1');
    expect(out.stdout).toContain("classDef root");
  });

  it("--render yaml dumps the structured payload", async () => {
    const out = run(
      "graph",
      "--repo",
      "notes",
      "--roots",
      "root.md",
      "--direction",
      "out",
      "--render",
      "yaml",
    );
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("documents:");
    expect(out.stdout).toContain("$path: root.md");
    expect(out.stdout).toContain("title: Root");
  });

  it("--filter accepts the graph-only $degrees intrinsic", async () => {
    const out = run(
      "--json",
      "graph",
      "--repo",
      "notes",
      "--roots",
      "root.md",
      "--direction",
      "out",
      "--degrees",
      "3",
      "--filter",
      "$degrees <= 1",
    );
    expect(out.status).toBe(0);
  });
});
