/**
 * Embedded shell serve, end-to-end — auth-shell plan WS3. A real HTTP server
 * over a real sqlite kernel with a real policy file; requests carry API keys
 * as bearer tokens. Asserts the full pipeline: unauthenticated → 401, key →
 * principal → entitlement → guarded kernel, read/write/destructive policy
 * enforced over the wire, author stamped, audit emitted, SIGHUP-style reload.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileAuditSink } from "./audit.js";
import { mintKey } from "./keys.js";
import { type ShellServeHandle, startShellServer } from "./serve.js";

let dir: string;
let dbPath: string;
let policyPath: string;
let auditPath: string;
let handle: ShellServeHandle;
let base: string;

// Minted keys — hashes go in the policy, plaintext presented as bearer.
const editorKey = mintKey();
const operatorKey = mintKey();

function writePolicy(): void {
  const p = `
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
    keys:
      - ${editorKey.hash}
  op:
    author: Op <op@example.com>
    roles: [operator]
    keys:
      - ${operatorKey.hash}
`;
  writeFileSync(policyPath, p);
}

async function req(
  method: string,
  path: string,
  opts: { key?: string; body?: string; contentType?: string; create?: boolean } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
  if (opts.contentType) headers["Content-Type"] = opts.contentType;
  // REST requires an optimistic-concurrency precondition on PUT: If-None-Match:*
  // means "create" (m3-plan decision 5 / §6.3).
  if (opts.create) headers["If-None-Match"] = "*";
  return fetch(`${base}${path}`, { method, headers, body: opts.body });
}

async function json(r: Response): Promise<Record<string, unknown>> {
  return (await r.json()) as Record<string, unknown>;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mrplex-shell-serve-"));
  dbPath = join(dir, "mrplex.db");
  policyPath = join(dir, "policy.yaml");
  auditPath = join(dir, "audit.jsonl");
  writePolicy();
  handle = await startShellServer({
    database: `sqlite:${dbPath}`,
    policyPath,
    host: "127.0.0.1",
    port: 0,
    auditPath,
    auditSinkFor: (principal) => fileAuditSink(auditPath, principal),
    log: () => {},
  });
  base = handle.baseUrl;
  // Seed a repo + a draft doc through the raw kernel (bypasses the shell).
  await handle.kernel.repos.create({}, "notes");
  await handle.kernel.docs.create({}, "notes", "drafts/seed.md", { frontmatter_raw: "", body: "" });
});

afterEach(async () => {
  await handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("authentication", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const r = await req("GET", "/repos");
    expect(r.status).toBe(401);
    expect((await json(r)).code).toBe("unauthorized");
  });

  it("rejects an unknown key with 401", async () => {
    const r = await req("GET", "/repos", { key: mintKey().plaintext });
    expect(r.status).toBe(401);
  });

  it("accepts a valid key", async () => {
    const r = await req("GET", "/repos", { key: editorKey.plaintext });
    expect(r.status).toBe(200);
  });
});

describe("token in URL path (/k/<token>/…)", () => {
  it("authenticates a read via the path prefix — no Authorization header", async () => {
    const r = await fetch(`${base}/k/${encodeURIComponent(editorKey.plaintext)}/repos`);
    expect(r.status).toBe(200);
  });

  it("routes /k/<token>/mcp to the MCP surface (not 404)", async () => {
    const r = await fetch(`${base}/k/${encodeURIComponent(operatorKey.plaintext)}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "0" },
        },
      }),
    });
    // The point is it reached the authenticated MCP surface — not 401/404.
    expect(r.status).toBe(200);
  });

  it("enforces policy on a path-authenticated write", async () => {
    // Editor may write drafts/** but not published/**.
    const ok = await fetch(
      `${base}/k/${encodeURIComponent(editorKey.plaintext)}/repos/notes/docs/drafts/p.md`,
      {
        method: "PUT",
        headers: { "Content-Type": "text/markdown", "If-None-Match": "*" },
        body: "x",
      },
    );
    expect(ok.status).toBe(201);
    const denied = await fetch(
      `${base}/k/${encodeURIComponent(editorKey.plaintext)}/repos/notes/docs/published/p.md`,
      {
        method: "PUT",
        headers: { "Content-Type": "text/markdown", "If-None-Match": "*" },
        body: "x",
      },
    );
    expect(denied.status).toBe(403);
  });

  it("401s a bad token in the path", async () => {
    const r = await fetch(`${base}/k/${encodeURIComponent(mintKey().plaintext)}/repos`);
    expect(r.status).toBe(401);
  });

  it("still 401s a /k/ prefix with an empty token (falls through to no-credential)", async () => {
    const r = await fetch(`${base}/k//repos`);
    expect(r.status).toBe(401);
  });
});

describe("write policy over the wire", () => {
  it("allows an editor to create inside drafts/**", async () => {
    const r = await req("PUT", "/repos/notes/docs/drafts/new.md", {
      key: editorKey.plaintext,
      body: "hi",
      contentType: "text/markdown",
      create: true,
    });
    expect(r.status).toBe(201);
  });

  it("forbids an editor writing outside its write scope", async () => {
    const r = await req("PUT", "/repos/notes/docs/published/x.md", {
      key: editorKey.plaintext,
      body: "hi",
      contentType: "text/markdown",
      create: true,
    });
    expect(r.status).toBe(403);
    expect((await json(r)).code).toBe("forbidden");
  });

  it("stamps the principal's author, not a client-supplied one", async () => {
    const r = await req("PUT", "/repos/notes/docs/drafts/authored.md", {
      key: editorKey.plaintext,
      body: "x",
      contentType: "text/markdown",
      create: true,
    });
    expect(r.status).toBe(201);
    const v = await json(r);
    expect(v.author).toBe("Ed <ed@example.com>");
  });
});

describe("destructive gating over the wire", () => {
  it("forbids an editor from creating a repo", async () => {
    const r = await req("POST", "/repos", {
      key: editorKey.plaintext,
      body: JSON.stringify({ slug: "newrepo" }),
      contentType: "application/json",
    });
    expect(r.status).toBe(403);
  });

  it("allows an operator to create a repo", async () => {
    const r = await req("POST", "/repos", {
      key: operatorKey.plaintext,
      body: JSON.stringify({ slug: "newrepo" }),
      contentType: "application/json",
    });
    expect(r.status).toBe(201);
  });
});

describe("audit log", () => {
  it("appends a JSONL line per authenticated call", async () => {
    await req("PUT", "/repos/notes/docs/drafts/audited.md", {
      key: editorKey.plaintext,
      body: "x",
      contentType: "text/markdown",
      create: true,
    });
    const lines = readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean);
    const rec = lines.map((l) => JSON.parse(l)).find((r) => r.path === "drafts/audited.md");
    expect(rec).toMatchObject({
      principal: "ed",
      op: "docs.create",
      repo: "notes",
      path: "drafts/audited.md",
      outcome: "ok",
    });
    expect(typeof rec.ts).toBe("string");
  });

  it("records a forbidden outcome", async () => {
    await req("PUT", "/repos/notes/docs/published/nope.md", {
      key: editorKey.plaintext,
      body: "x",
      contentType: "text/markdown",
      create: true,
    });
    const lines = readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean);
    const rec = lines.map((l) => JSON.parse(l)).find((r) => r.path === "published/nope.md");
    expect(rec.outcome).toBe("forbidden");
  });
});

describe("policy reload", () => {
  it("picks up a revoked key after reloadPolicy", async () => {
    // Before: the editor key works.
    expect((await req("GET", "/repos", { key: editorKey.plaintext })).status).toBe(200);
    // Revoke: rewrite the policy without the editor's keys block, then reload.
    const revoked = readFileSync(policyPath, "utf8").replace(
      `    keys:\n      - ${editorKey.hash}\n`,
      "",
    );
    writeFileSync(policyPath, revoked);
    handle.reloadPolicy();
    expect((await req("GET", "/repos", { key: editorKey.plaintext })).status).toBe(401);
    // The operator key still works.
    expect((await req("GET", "/repos", { key: operatorKey.plaintext })).status).toBe(200);
  });
});
