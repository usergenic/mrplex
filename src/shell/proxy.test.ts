/**
 * Fronting proxy, end-to-end — auth-shell plan WS4. A raw engine on loopback,
 * fronted by the authenticating proxy. Asserts auth, route-aware write /
 * destructive enforcement, inbound X-Mrplex-* stripping, and that reads flow
 * through with the entitlement's injected scope.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ServeHandle, startServer } from "../server/serve.js";
import { mintKey } from "./keys.js";
import { type ProxyHandle, startProxyServer } from "./proxy.js";

let dir: string;
let engine: ServeHandle;
let proxy: ProxyHandle;
let base: string;

const editorKey = mintKey();
const operatorKey = mintKey();

async function req(
  method: string,
  path: string,
  opts: {
    key?: string;
    body?: string;
    contentType?: string;
    create?: boolean;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
  if (opts.contentType) headers["Content-Type"] = opts.contentType;
  if (opts.create) headers["If-None-Match"] = "*";
  return fetch(`${base}${path}`, { method, headers, body: opts.body });
}

async function json(r: Response): Promise<Record<string, unknown>> {
  return (await r.json()) as Record<string, unknown>;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mrplex-proxy-"));
  const dbPath = join(dir, "mrplex.db");
  const policyPath = join(dir, "policy.yaml");
  writeFileSync(
    policyPath,
    `
roles:
  editor:
    grants:
      - repo: notes
        read: "**"
        write: ["drafts/**"]
  operator:
    grants:
      - { repo: "*", read: "**", write: "**" }
    destructive: true
principals:
  ed:
    author: Ed <ed@example.com>
    roles: [editor]
    keys: [${editorKey.hash}]
  op:
    author: Op <op@example.com>
    roles: [operator]
    keys: [${operatorKey.hash}]
`,
  );
  // Raw engine on loopback (the upstream). This is the "unsafe" full-trust
  // engine the proxy fronts.
  engine = await startServer({
    database: `sqlite:${dbPath}`,
    host: "127.0.0.1",
    port: 0,
    log: () => {},
  });
  await engine.kernel.repos.create({}, "notes");
  await engine.kernel.docs.create({}, "notes", "drafts/seed.md", { frontmatter_raw: "", body: "" });
  await engine.kernel.docs.create({}, "notes", "published/locked.md", {
    frontmatter_raw: "",
    body: "",
  });

  proxy = await startProxyServer({
    policyPath,
    upstream: engine.baseUrl,
    host: "127.0.0.1",
    port: 0,
    log: () => {},
  });
  base = proxy.baseUrl;
});

afterEach(async () => {
  await proxy.close();
  await engine.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("authentication", () => {
  it("401s an unauthenticated request", async () => {
    expect((await req("GET", "/repos")).status).toBe(401);
  });
  it("401s an unknown key", async () => {
    expect((await req("GET", "/repos", { key: mintKey().plaintext })).status).toBe(401);
  });
  it("passes an authenticated read through", async () => {
    const r = await req("GET", "/repos", { key: editorKey.plaintext });
    expect(r.status).toBe(200);
  });
});

describe("write enforcement", () => {
  it("allows an editor to create inside drafts/**", async () => {
    const r = await req("PUT", "/repos/notes/docs/drafts/new.md", {
      key: editorKey.plaintext,
      body: "x",
      contentType: "text/markdown",
      create: true,
    });
    expect(r.status).toBe(201);
  });

  it("forbids an editor writing outside its scope — before it reaches the engine", async () => {
    const r = await req("PUT", "/repos/notes/docs/published/x.md", {
      key: editorKey.plaintext,
      body: "x",
      contentType: "text/markdown",
      create: true,
    });
    expect(r.status).toBe(403);
    expect((await json(r)).code).toBe("forbidden");
  });

  it("stamps the entitlement author (client cannot forge X-Mrplex-Author)", async () => {
    const r = await req("PUT", "/repos/notes/docs/drafts/authored.md", {
      key: editorKey.plaintext,
      body: "x",
      contentType: "text/markdown",
      create: true,
      headers: { "X-Mrplex-Author": "attacker" },
    });
    expect(r.status).toBe(201);
    expect((await json(r)).author).toBe("Ed <ed@example.com>");
  });
});

describe("destructive enforcement", () => {
  it("forbids an editor from creating a repo", async () => {
    const r = await req("POST", "/repos", {
      key: editorKey.plaintext,
      body: JSON.stringify({ slug: "new" }),
      contentType: "application/json",
    });
    expect(r.status).toBe(403);
  });
  it("allows an operator to create a repo", async () => {
    const r = await req("POST", "/repos", {
      key: operatorKey.plaintext,
      body: JSON.stringify({ slug: "new" }),
      contentType: "application/json",
    });
    expect(r.status).toBe(201);
  });
});

describe("MCP over proxy", () => {
  it("is refused with a pointer to embedded mode", async () => {
    const r = await req("POST", "/mcp", { key: operatorKey.plaintext });
    expect(r.status).toBe(403);
    expect(((await json(r)).data as { reason: string }).reason).toMatch(/embedded/);
  });
});

describe("scope injection", () => {
  it("narrows reads to the entitlement's read scope", async () => {
    // Editor reads everything in notes; a query returns both docs. Operator too.
    // The point: the client's own X-Mrplex-Scope is stripped, so it can't widen
    // beyond the entitlement — here we just confirm the read flows and is scoped
    // by the injected header (editor read is ** on notes).
    const r = await req("GET", "/query?repo=notes", {
      key: editorKey.plaintext,
      headers: { "X-Mrplex-Scope": "[]" }, // client tries to blank its own scope
    });
    expect(r.status).toBe(200);
    const rows = (await r.json()) as { path: string }[];
    // If the client's empty scope had won, this would be []; the injected
    // entitlement scope (** on notes) wins, so both seeded docs are visible.
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});
