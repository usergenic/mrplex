/**
 * MCP surface integration tests — m3-plan §3 WS2 acceptance criteria.
 * Uses the SDK's own client (a stand-in for "any MCP client").
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ServeHandle, startServer } from "../src/server/serve.js";

let workDir: string;
let handle: ServeHandle;
let client: Client;

async function connectClient(): Promise<Client> {
  const url = new URL(`${handle.baseUrl}/mcp`);
  const c = new Client({ name: "test-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(url);
  await c.connect(transport);
  return c;
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "mrplex-mcp-"));
  const dbUrl = `sqlite:${join(workDir, "test.db")}`;
  handle = await startServer({ database: dbUrl, port: 0, log: () => {} });
  client = await connectClient();
});

afterEach(async () => {
  await client.close();
  await handle.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("MCP lifecycle + tools/list", () => {
  it("lists 18 tools (no user/token tools after noauth; links_* + set_link_config)", async () => {
    const r = await client.listTools();
    expect(r.tools.length).toBe(18);
    // Sample the important names.
    const names = new Set(r.tools.map((t) => t.name));
    for (const name of [
      "repos_list",
      "repos_create",
      "docs_get",
      "docs_create",
      "docs_put",
      "docs_delete",
      "docs_diff",
      "query",
      "links_backfill",
      "links_stale",
      "links_repair",
      "repos_set_link_config",
    ]) {
      expect(names.has(name)).toBe(true);
    }
    // The user/token tools are gone (no-auth).
    for (const gone of ["users_list", "tokens_create", "tokens_revoke"]) {
      expect(names.has(gone)).toBe(false);
    }
  });

  it("every tool has an object inputSchema", async () => {
    const r = await client.listTools();
    for (const t of r.tools) {
      expect(t.inputSchema.type).toBe("object");
    }
  });
});

describe("MCP tools/call round-trip", () => {
  it("repos_create → repos_get → docs_create → docs_get", async () => {
    await client.callTool({ name: "repos_create", arguments: { repo: "notes" } });
    const got = await client.callTool({ name: "repos_get", arguments: { repo: "notes" } });
    expect((got.structuredContent as { repo: string }).repo).toBe("notes");

    const created = await client.callTool({
      name: "docs_create",
      arguments: {
        repo: "notes",
        path: "a.md",
        body: "hi",
        frontmatter: { status: "draft" },
      },
    });
    const v = created.structuredContent as { version_id: string };
    expect(v.version_id).toBe("v1");

    const fetched = await client.callTool({
      name: "docs_get",
      arguments: { repo: "notes", path: "a.md" },
    });
    expect((fetched.structuredContent as { version_id: string }).version_id).toBe("v1");
  });

  it("list results wrap as { items: [...] } (structuredContent must be an object)", async () => {
    await client.callTool({ name: "repos_create", arguments: { repo: "notes" } });
    const r = await client.callTool({ name: "repos_list", arguments: {} });
    const items = (r.structuredContent as { items: unknown[] }).items;
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBe(1);
  });
});

describe("MCP $version round-trip", () => {
  it("docs_get injects $version into frontmatter_raw by default; raw suppresses it", async () => {
    await client.callTool({ name: "repos_create", arguments: { repo: "notes" } });
    await client.callTool({
      name: "docs_create",
      arguments: {
        repo: "notes",
        path: "a.md",
        body: "hi",
        frontmatter: { status: "draft" },
      },
    });
    const injected = await client.callTool({
      name: "docs_get",
      arguments: { repo: "notes", path: "a.md" },
    });
    const iRaw = (injected.structuredContent as { frontmatter_raw: string }).frontmatter_raw;
    expect(iRaw).toContain("$version: v1");

    const rawResp = await client.callTool({
      name: "docs_get",
      arguments: { repo: "notes", path: "a.md", raw: true },
    });
    const rRaw = (rawResp.structuredContent as { frontmatter_raw: string }).frontmatter_raw;
    expect(rRaw).not.toContain("$version");
  });

  it("docs_put uses embedded $version when prev_version_id is omitted", async () => {
    await client.callTool({ name: "repos_create", arguments: { repo: "notes" } });
    await client.callTool({
      name: "docs_create",
      arguments: {
        repo: "notes",
        path: "a.md",
        body: "hi",
        frontmatter: { status: "draft" },
      },
    });
    const got = await client.callTool({
      name: "docs_get",
      arguments: { repo: "notes", path: "a.md" },
    });
    const gotFm = (got.structuredContent as { frontmatter_raw: string }).frontmatter_raw;
    // Feed the injected frontmatter_raw straight back into docs_put with no prev.
    const put = await client.callTool({
      name: "docs_put",
      arguments: {
        repo: "notes",
        path: "a.md",
        frontmatter_raw: gotFm,
        body: "edited",
      },
    });
    expect(put.isError).toBeFalsy();
    const v = put.structuredContent as { version_id: string; frontmatter_raw: string };
    expect(v.version_id).toBe("v2");
    // Stored frontmatter must not carry $version — verify via raw read.
    const rawResp = await client.callTool({
      name: "docs_get",
      arguments: { repo: "notes", path: "a.md", raw: true },
    });
    const rRaw = (rawResp.structuredContent as { frontmatter_raw: string }).frontmatter_raw;
    expect(rRaw).not.toContain("$version");
  });
});

describe("MCP in-band errors", () => {
  it("stale prev_version_id → isError: true with parseable payload", async () => {
    await client.callTool({ name: "repos_create", arguments: { repo: "notes" } });
    const r = await client.callTool({
      name: "docs_put",
      arguments: {
        repo: "notes",
        path: "hello.md",
        prev_version_id: "v9999",
        body: "x",
      },
    });
    expect(r.isError).toBe(true);
    const content = (r.content as { type: string; text: string }[])[0];
    expect(content).toBeDefined();
    const parsed = JSON.parse((content as { text: string }).text);
    expect(parsed.code).toBe("version_not_found");
  });

  it("unknown tool → in-band error, not transport failure", async () => {
    const r = await client.callTool({ name: "bogus", arguments: {} });
    expect(r.isError).toBe(true);
  });

  it("stale_prev after real write has current_version_id in data", async () => {
    await client.callTool({ name: "repos_create", arguments: { repo: "notes" } });
    const first = await client.callTool({
      name: "docs_create",
      arguments: { repo: "notes", path: "hello.md", body: "one", frontmatter: {} },
    });
    const firstV = first.structuredContent as { version_id: string };
    await client.callTool({
      name: "docs_put",
      arguments: {
        repo: "notes",
        path: "hello.md",
        prev_version_id: firstV.version_id,
        body: "two",
      },
    });
    // Now retry with the STALE prev.
    const stale = await client.callTool({
      name: "docs_put",
      arguments: {
        repo: "notes",
        path: "hello.md",
        prev_version_id: firstV.version_id,
        body: "three",
      },
    });
    expect(stale.isError).toBe(true);
    const payload = JSON.parse(((stale.content as { text: string }[])[0] as { text: string }).text);
    expect(payload.code).toBe("stale_prev");
    expect(payload.data.current_version_id).toBe("v2");
  });
});

describe("MCP query round-trip", () => {
  it("query returns items array", async () => {
    await client.callTool({ name: "repos_create", arguments: { repo: "notes" } });
    await client.callTool({
      name: "docs_create",
      arguments: {
        repo: "notes",
        path: "a.md",
        body: "hi",
        frontmatter: { status: "draft" },
      },
    });
    const r = await client.callTool({
      name: "query",
      arguments: { repo: "notes", filter: 'status == "draft"' },
    });
    const items = (r.structuredContent as { items: unknown[] }).items;
    expect(items.length).toBe(1);
  });
});
