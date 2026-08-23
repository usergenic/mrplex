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
  it("lists 20 tools (no user/token tools after noauth; links_* + set_link_config + query_syntax + graph)", async () => {
    const r = await client.listTools();
    expect(r.tools.length).toBe(20);
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
      "query_syntax",
      "graph",
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

  it("every tool has an object inputSchema and declares an object outputSchema", async () => {
    const r = await client.listTools();
    for (const t of r.tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema?.type, `${t.name} outputSchema`).toBe("object");
    }
  });

  it("initialize surfaces server instructions covering the key conventions", async () => {
    const instructions = client.getInstructions();
    expect(instructions).toBeDefined();
    for (const needle of ["$version", "stale_prev", "query_syntax", "frontmatter_raw"]) {
      expect(instructions).toContain(needle);
    }
  });

  it("the query tool description teaches the filter language and points at query_syntax", async () => {
    const r = await client.listTools();
    const query = r.tools.find((t) => t.name === "query");
    expect(query?.description).toContain("query_syntax");
    expect(query?.description).toContain("$path");
    const filterDesc = (query?.inputSchema.properties as Record<string, { description?: string }>)
      .filter?.description;
    expect(filterDesc).toContain("list(");
    expect(filterDesc).toContain("$backlinks()");
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

  it("filter_invalid carries a hint pointing at query_syntax", async () => {
    await client.callTool({ name: "repos_create", arguments: { repo: "notes" } });
    const r = await client.callTool({
      name: "query",
      arguments: { repo: "notes", filter: "status ==" },
    });
    expect(r.isError).toBe(true);
    const payload = JSON.parse(((r.content as { text: string }[])[0] as { text: string }).text);
    expect(payload.code).toBe("filter_invalid");
    expect(payload.data.hint).toContain("query_syntax");
  });

  it("every tool's structuredContent conforms to its outputSchema (SDK client-side validation)", async () => {
    // listTools caches per-tool output validators in the SDK client; every
    // callTool after this throws if structuredContent violates the schema.
    // Walking all 20 tools proves the declared shapes match reality.
    await client.listTools();
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args });
      expect(r.isError, `${name} errored: ${JSON.stringify(r.content)}`).toBeFalsy();
      return r.structuredContent as Record<string, unknown>;
    };
    await call("repos_create", { repo: "notes" });
    await call("repos_list");
    await call("repos_get", { repo: "notes" });
    await call("repos_set_path_config", { repo: "notes", config: null });
    await call("repos_set_link_config", { repo: "notes", config: null });
    const v1 = (await call("docs_create", {
      repo: "notes",
      path: "a.md",
      body: "see [b](b.md)",
      frontmatter: { status: "draft" },
    })) as { version_id: string };
    await call("docs_get", { repo: "notes", path: "a.md" });
    await call("docs_get_version", { repo: "notes", version_id: v1.version_id });
    const v2 = (await call("docs_put", {
      repo: "notes",
      path: "a.md",
      prev_version_id: v1.version_id,
      body: "two",
    })) as { version_id: string };
    await call("docs_history", { repo: "notes", path: "a.md" });
    await call("docs_diff", {
      repo: "notes",
      path: "a.md",
      from: v1.version_id,
      to: v2.version_id,
    });
    await call("query", { repo: "notes", filter: 'status == "draft"' });
    await call("query_syntax");
    await call("graph", { repo: "notes", roots: "a.md", degrees: 1 });
    await call("links_backfill", { repo: "notes" });
    await call("links_stale", { repo: "notes" });
    await call("links_repair", { repo: "notes", dry_run: true });
    await call("docs_delete", { repo: "notes", prev_version_id: v2.version_id });
    await call("repos_rename", { repo: "notes", new_repo: "notes2" });
    await call("repos_delete", { repo: "notes2" });
  });

  it("error results carry no structuredContent (outputSchema-safe) and still parse from text", async () => {
    // With outputSchema declared and validators cached, a structuredContent
    // mirror of the error payload would fail SDK client-side validation —
    // so errors must travel text-only. (A repo must exist: query resolves
    // repos before parsing the filter and returns [] on an empty set.)
    await client.listTools();
    await client.callTool({ name: "repos_create", arguments: { repo: "notes" } });
    const r = await client.callTool({ name: "query", arguments: { filter: "status ==" } });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    const payload = JSON.parse(((r.content as { text: string }[])[0] as { text: string }).text);
    expect(payload.code).toBe("filter_invalid");
  });

  it("query_syntax returns the filter-language reference", async () => {
    const r = await client.callTool({ name: "query_syntax", arguments: {} });
    expect(r.isError).toBeFalsy();
    const reference = (r.structuredContent as { reference: string }).reference;
    for (const needle of ["$path", "$updated_at", "$body", "list(", "$in(", "$backlinks()"]) {
      expect(reference).toContain(needle);
    }
    // The text content mirrors the structured form so text-only clients
    // (and models reading tool output as text) get the same doc.
    expect(((r.content as { text: string }[])[0] as { text: string }).text).toBe(reference);
  });

  it("query_syntax documents the graph-only $degrees intrinsic", async () => {
    const r = await client.callTool({ name: "query_syntax", arguments: {} });
    const reference = (r.structuredContent as { reference: string }).reference;
    expect(reference).toContain("$degrees");
    expect(reference).toContain("graph mode only");
  });
});

describe("MCP graph round-trip", () => {
  beforeEach(async () => {
    await client.callTool({ name: "repos_create", arguments: { repo: "notes" } });
    await client.callTool({
      name: "docs_create",
      arguments: { repo: "notes", path: "leaf.md", body: "", frontmatter: { title: "Leaf" } },
    });
    await client.callTool({
      name: "docs_create",
      arguments: {
        repo: "notes",
        path: "root.md",
        body: "[leaf](leaf.md)",
        frontmatter: { title: "Root" },
      },
    });
  });

  it("returns documents, induced links, frontier, and truncation metadata", async () => {
    await client.listTools(); // cache the outputSchema validator
    const r = await client.callTool({
      name: "graph",
      arguments: { repo: "notes", roots: "root.md", direction: "out", degrees: 1 },
    });
    expect(r.isError).toBeFalsy();
    const result = r.structuredContent as {
      documents: { $path: string; $degrees: number; title?: string }[];
      links: { source: string; target: string; field: string }[];
      frontier: string[];
      complete_degrees: number;
      truncated: boolean;
    };
    expect(result.documents.map((d) => d.$path)).toEqual(["root.md", "leaf.md"]);
    expect(result.documents[0]?.title).toBe("Root");
    expect(result.links).toEqual([{ source: "root.md", target: "leaf.md", field: "$body" }]);
    expect(result.complete_degrees).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("the text half is the adjacency summary", async () => {
    const r = await client.callTool({
      name: "graph",
      arguments: { repo: "notes", roots: "root.md", direction: "out", degrees: 1 },
    });
    const text = ((r.content as { text: string }[])[0] as { text: string }).text;
    expect(text).toContain("root.md (0)");
    expect(text).toContain("→($body) leaf.md");
    expect(text).toContain("complete through 1 degree");
  });

  it("a $degrees filter is accepted (graph-only intrinsic)", async () => {
    const r = await client.callTool({
      name: "graph",
      arguments: {
        repo: "notes",
        roots: "root.md",
        direction: "out",
        degrees: 3,
        filter: "$degrees <= 1",
      },
    });
    expect(r.isError).toBeFalsy();
  });

  it("a bad filter surfaces filter_invalid with the query_syntax hint", async () => {
    const r = await client.callTool({
      name: "graph",
      arguments: { repo: "notes", roots: "root.md", filter: "status ==" },
    });
    expect(r.isError).toBe(true);
    const payload = JSON.parse(((r.content as { text: string }[])[0] as { text: string }).text);
    expect(payload.code).toBe("filter_invalid");
    expect(payload.data.hint).toContain("query_syntax");
  });
});
