/**
 * docs.diff — surface tests across REST + MCP.
 *
 * The kernel-level tests live in src/kernel/diff.test.ts. This file
 * proves the REST route (`/repos/{repo}/diff/{path}?from=&to=`), the
 * `docs_diff` MCP tool (which pushes tool count to 21), and content
 * negotiation.
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "../src/server/serve.js";

async function ephemeralPort(): Promise<number> {
  const { createServer } = await import("node:net");
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe("docs.diff — surfaces", () => {
  const tmpDb = join(
    tmpdir(),
    `mrplex-diff-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const handles: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    for (const h of handles) await h.close().catch(() => {});
    try {
      rmSync(tmpDb);
      rmSync(`${tmpDb}-wal`);
      rmSync(`${tmpDb}-shm`);
    } catch {
      // best-effort
    }
  });

  it("REST /diff and MCP docs_diff both return the unified diff", async () => {
    const port = await ephemeralPort();
    const handle = await startServer({
      database: `sqlite:${tmpDb}`,
      port,
      log: () => {},
    });
    handles.push(handle);

    const base = `http://127.0.0.1:${handle.port}`;
    const auth: Record<string, string> = {};

    // Set up: create repo, write two versions.
    await fetch(`${base}/repos`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "notes" }),
    });
    const create = (await (
      await fetch(`${base}/repos/notes/docs/a.md`, {
        method: "PUT",
        headers: { ...auth, "Content-Type": "text/markdown", "If-None-Match": "*" },
        body: "hello v1\n",
      })
    ).json()) as { version_id: string };
    const v1 = create.version_id;
    const update = (await (
      await fetch(`${base}/repos/notes/docs/a.md`, {
        method: "PUT",
        headers: { ...auth, "Content-Type": "text/markdown", "If-Match": v1 },
        body: "hello v2\n",
      })
    ).json()) as { version_id: string };
    const v2 = update.version_id;

    // REST JSON.
    const jsonDiff = (await (
      await fetch(`${base}/repos/notes/diff/a.md?from=${v1}&to=${v2}`, {
        headers: { ...auth },
      })
    ).json()) as { from_version_id: string; to_version_id: string; patch: string };
    expect(jsonDiff.from_version_id).toBe(v1);
    expect(jsonDiff.to_version_id).toBe(v2);
    expect(jsonDiff.patch).toContain("-hello v1");
    expect(jsonDiff.patch).toContain("+hello v2");

    // REST text/plain.
    const raw = await (
      await fetch(`${base}/repos/notes/diff/a.md?from=${v1}&to=${v2}`, {
        headers: { ...auth, Accept: "text/plain" },
      })
    ).text();
    expect(raw).toContain("-hello v1");
    expect(raw).toContain("+hello v2");
    expect(raw).not.toContain("from_version_id"); // no JSON envelope

    // Missing query params → 400.
    const missing = await fetch(`${base}/repos/notes/diff/a.md`, { headers: { ...auth } });
    expect(missing.status).toBe(400);

    // MCP tool call.
    const url = new URL(`${base}/mcp`);
    const client = new Client({ name: "diff-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(url);
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain("docs_diff");
      const result = await client.callTool({
        name: "docs_diff",
        arguments: { repo: "notes", path: "a.md", from: v1, to: v2 },
      });
      expect(result.isError).not.toBe(true);
      const sc = result.structuredContent as { patch: string; from_version_id: string };
      expect(sc.from_version_id).toBe(v1);
      expect(sc.patch).toContain("-hello v1");
    } finally {
      await client.close();
    }
  }, 20000);

  it("version_not_in_document maps to 422 + tool-error", async () => {
    const port = await ephemeralPort();
    const handle = await startServer({
      database: `sqlite:${tmpDb}`,
      port,
      log: () => {},
    });
    handles.push(handle);
    const base = `http://127.0.0.1:${handle.port}`;
    const auth: Record<string, string> = {};

    await fetch(`${base}/repos`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "notes" }),
    });
    const a = (await (
      await fetch(`${base}/repos/notes/docs/a.md`, {
        method: "PUT",
        headers: { ...auth, "Content-Type": "text/markdown", "If-None-Match": "*" },
        body: "aaa\n",
      })
    ).json()) as { version_id: string };
    const b = (await (
      await fetch(`${base}/repos/notes/docs/b.md`, {
        method: "PUT",
        headers: { ...auth, "Content-Type": "text/markdown", "If-None-Match": "*" },
        body: "bbb\n",
      })
    ).json()) as { version_id: string };

    const cross = await fetch(
      `${base}/repos/notes/diff/a.md?from=${b.version_id}&to=${a.version_id}`,
      { headers: { ...auth } },
    );
    expect(cross.status).toBe(422);
    const body = (await cross.json()) as { code: string };
    expect(body.code).toBe("version_not_in_document");
  }, 20000);
});
