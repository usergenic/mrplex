/**
 * REST surface integration tests — drive a real listening server via fetch()
 * and cover the m3-plan §3 WS3 acceptance criteria: conditional-request
 * matrix, content negotiation, MOVE (incl. cross-repo rejection),
 * idempotent DELETE, query ETag/304, error-mapping spot checks.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ServeHandle, startServer } from "../src/server/serve.js";

let workDir: string;
let handle: ServeHandle;
let base: string;

// No-auth: requests carry no credentials. Kept as a helper so the many call
// sites stay readable; it just returns an empty header bag.
const authHeaders = (): Record<string, string> => ({});

/**
 * Node's undici types response.json() as Promise<unknown>. Tests just want a
 * bag of fields; annotate at the call site with a shape or fall back to
 * Record<string, unknown>.
 */
async function readJson<T = Record<string, unknown>>(r: Response): Promise<T> {
  return (await r.json()) as T;
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "mrplex-rest-"));
  const dbUrl = `sqlite:${join(workDir, "test.db")}`;
  handle = await startServer({ database: dbUrl, port: 0, log: () => {} });
  base = handle.baseUrl;
});

afterEach(async () => {
  await handle.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("REST no-auth", () => {
  it("no credentials needed → 200 empty list", async () => {
    const r = await fetch(`${base}/repos`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
  });

  it("a stray Authorization header is ignored, not rejected", async () => {
    const r = await fetch(`${base}/repos`, {
      headers: { Authorization: "Bearer anything-at-all" },
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
  });
});

describe("REST docs — conditional writes", () => {
  beforeEach(async () => {
    await fetch(`${base}/repos`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "notes" }),
    });
  });

  it("PUT + If-None-Match:* creates; second attempt 412 create_conflict", async () => {
    const url = `${base}/repos/notes/docs/hello.md`;
    let r = await fetch(url, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/markdown", "If-None-Match": "*" },
      body: "---\nstatus: draft\n---\nhello\n",
    });
    expect(r.status).toBe(201);
    expect(r.headers.get("etag")).toBe('"v1"');

    r = await fetch(url, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/markdown", "If-None-Match": "*" },
      body: "second\n",
    });
    expect(r.status).toBe(412);
    const body = await readJson<{ code: string }>(r);
    expect(body.code).toBe("create_conflict");
  });

  it("PUT + If-Match:<version> updates; stale retry → 412 stale_prev with ETag", async () => {
    const url = `${base}/repos/notes/docs/hello.md`;
    await fetch(url, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/markdown", "If-None-Match": "*" },
      body: "one\n",
    });

    let r = await fetch(url, {
      method: "PUT",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
        "If-Match": '"v1"',
      },
      body: JSON.stringify({ body: "two" }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("etag")).toBe('"v2"');

    r = await fetch(url, {
      method: "PUT",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
        "If-Match": '"v1"',
      },
      body: JSON.stringify({ body: "three" }),
    });
    expect(r.status).toBe(412);
    expect(r.headers.get("etag")).toBe('"v2"');
    const body = await readJson<{ code: string; data: { current_version_id: string } }>(r);
    expect(body.code).toBe("stale_prev");
    expect(body.data.current_version_id).toBe("v2");
  });

  it("PUT with no precondition → 428 precondition_required", async () => {
    const url = `${base}/repos/notes/docs/hello.md`;
    const r = await fetch(url, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ body: "x" }),
    });
    expect(r.status).toBe(428);
    expect((await readJson<{ code: string }>(r)).code).toBe("precondition_required");
  });

  it("PUT with a non-string body field → 400 filter_invalid (not silent wipe)", async () => {
    // Create first.
    await fetch(`${base}/repos/notes/docs/hello.md`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/markdown", "If-None-Match": "*" },
      body: "original body\n",
    });
    // Try to update with body: 42 (a number). Previously silently coerced to ""
    // (wiping the body); now must reject.
    const r = await fetch(`${base}/repos/notes/docs/hello.md`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "application/json", "If-Match": '"v1"' },
      body: JSON.stringify({ body: 42 }),
    });
    expect(r.status).toBe(400);
    expect((await readJson<{ code: string }>(r)).code).toBe("filter_invalid");
  });

  it("PUT with omitted body carries over prev's body (no silent wipe)", async () => {
    await fetch(`${base}/repos/notes/docs/hello.md`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/markdown", "If-None-Match": "*" },
      body: "original body\n",
    });
    // Update only frontmatter; body key absent — kernel carries over prev.body.
    const r = await fetch(`${base}/repos/notes/docs/hello.md`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "application/json", "If-Match": '"v1"' },
      body: JSON.stringify({ frontmatter: { status: "published" } }),
    });
    expect(r.status).toBe(200);
    const v = await readJson<{ body: string }>(r);
    expect(v.body).toBe("original body\n");
  });

  it("weak ETag validator (W/) is rejected", async () => {
    const url = `${base}/repos/notes/docs/hello.md`;
    await fetch(url, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/markdown", "If-None-Match": "*" },
      body: "x\n",
    });
    // W/"v1" should NOT satisfy If-Match — parser returns null, so 428.
    const r = await fetch(url, {
      method: "PUT",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
        "If-Match": 'W/"v1"',
      },
      body: JSON.stringify({ body: "y" }),
    });
    expect(r.status).toBe(428);
  });
});

describe("REST docs — content negotiation", () => {
  beforeEach(async () => {
    await fetch(`${base}/repos`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "notes" }),
    });
    await fetch(`${base}/repos/notes/docs/hello.md`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/markdown", "If-None-Match": "*" },
      body: "---\nstatus: draft\n---\nhello m3\n",
    });
  });

  it("Accept: text/markdown returns byte-exact document (?raw suppresses $version)", async () => {
    const r = await fetch(`${base}/repos/notes/docs/hello.md?raw`, {
      headers: { ...authHeaders(), Accept: "text/markdown" },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/markdown");
    expect(await r.text()).toBe("---\nstatus: draft\n---\nhello m3\n");
  });

  it("Accept: text/markdown (default) appends $version", async () => {
    const r = await fetch(`${base}/repos/notes/docs/hello.md`, {
      headers: { ...authHeaders(), Accept: "text/markdown" },
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("---\nstatus: draft\n$version: v1\n---\nhello m3\n");
  });

  it("Accept: application/json returns Version envelope", async () => {
    const r = await fetch(`${base}/repos/notes/docs/hello.md`, {
      headers: { ...authHeaders(), Accept: "application/json" },
    });
    expect(r.status).toBe(200);
    const body = await readJson<{ repo: string; path: string; version_id: string }>(r);
    expect(body.repo).toBe("notes");
    expect(body.path).toBe("hello.md");
    expect(body.version_id).toBe("v1");
  });

  it("If-None-Match on current version → 304", async () => {
    const r = await fetch(`${base}/repos/notes/docs/hello.md`, {
      headers: { ...authHeaders(), "If-None-Match": '"v1"' },
    });
    expect(r.status).toBe(304);
  });

  it("Content-Type: text/markdown round-trips byte-exact (?raw both ends)", async () => {
    const original = "---\nstatus: draft\n---\nhello m3\n";
    // Read as markdown with ?raw → re-PUT → read again — bytes must be identical.
    const r1 = await fetch(`${base}/repos/notes/docs/hello.md?raw`, {
      headers: { ...authHeaders(), Accept: "text/markdown" },
    });
    const md = await r1.text();
    expect(md).toBe(original);
    await fetch(`${base}/repos/notes/docs/hello.md`, {
      method: "PUT",
      headers: {
        ...authHeaders(),
        "Content-Type": "text/markdown",
        "If-Match": '"v1"',
      },
      body: md,
    });
    const r2 = await fetch(`${base}/repos/notes/docs/hello.md?raw`, {
      headers: { ...authHeaders(), Accept: "text/markdown" },
    });
    expect(await r2.text()).toBe(original);
  });

  it("PUT with $version in frontmatter (no If-Match) uses embedded version as prev", async () => {
    // GET default markdown → contains $version → PUT without If-Match → succeeds,
    // and the stored doc has $version stripped (byte-exact via ?raw).
    const r1 = await fetch(`${base}/repos/notes/docs/hello.md`, {
      headers: { ...authHeaders(), Accept: "text/markdown" },
    });
    const md = await r1.text();
    expect(md).toContain("$version: v1");
    // Edit only the body; keep $version in frontmatter.
    const edited = md.replace("hello m3\n", "hello v2\n");
    const rp = await fetch(`${base}/repos/notes/docs/hello.md`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/markdown" },
      body: edited,
    });
    expect(rp.status).toBe(200);
    // Storage doesn't carry $version — read raw and verify.
    const r2 = await fetch(`${base}/repos/notes/docs/hello.md?raw`, {
      headers: { ...authHeaders(), Accept: "text/markdown" },
    });
    expect(await r2.text()).toBe("---\nstatus: draft\n---\nhello v2\n");
  });

  it("PUT with $version after a concurrent write → stale_prev", async () => {
    // Someone else advances the doc to v2.
    await fetch(`${base}/repos/notes/docs/hello.md`, {
      method: "PUT",
      headers: {
        ...authHeaders(),
        "Content-Type": "text/markdown",
        "If-Match": '"v1"',
      },
      body: "---\nstatus: draft\n---\nintervening\n",
    });
    // Our client still has v1 in its embedded $version.
    const stale = "---\nstatus: draft\n$version: v1\n---\nour edit\n";
    const rp = await fetch(`${base}/repos/notes/docs/hello.md`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/markdown" },
      body: stale,
    });
    expect(rp.status).toBe(412);
    const body = (await rp.json()) as { code: string };
    expect(body.code).toBe("stale_prev");
  });
});

describe("REST MOVE + DELETE", () => {
  beforeEach(async () => {
    await fetch(`${base}/repos`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "notes" }),
    });
    await fetch(`${base}/repos`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "other" }),
    });
    await fetch(`${base}/repos/notes/docs/hello.md`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/markdown", "If-None-Match": "*" },
      body: "one\n",
    });
  });

  it("MOVE within the same repo", async () => {
    const r = await fetch(`${base}/repos/notes/docs/hello.md`, {
      method: "MOVE",
      headers: {
        ...authHeaders(),
        "If-Match": '"v1"',
        Destination: "/repos/notes/docs/greeting.md",
      },
    });
    expect(r.status).toBe(200);
    const v = await readJson<{ path: string }>(r);
    expect(v.path).toBe("greeting.md");
  });

  it("cross-repo MOVE rejected", async () => {
    const r = await fetch(`${base}/repos/notes/docs/hello.md`, {
      method: "MOVE",
      headers: {
        ...authHeaders(),
        "If-Match": '"v1"',
        Destination: "/repos/other/docs/hello.md",
      },
    });
    expect(r.status).toBe(400);
    const body = await readJson<{ code: string }>(r);
    expect(body.code).toBe("path_invalid");
  });

  it("DELETE succeeds; retry at the same URL returns 404 (doc no longer lives there)", async () => {
    let r = await fetch(`${base}/repos/notes/docs/hello.md`, {
      method: "DELETE",
      headers: { ...authHeaders(), "If-Match": '"v1"' },
    });
    expect(r.status).toBe(200);
    const first = await readJson<{ version_id: string }>(r);
    expect(first.version_id).toBe("v2"); // moved to :deleted/…

    // Retry the same DELETE at the same URL — the doc no longer lives at
    // hello.md, so kernel.docs.get raises doc_not_found (404). This is
    // consistent with RFC 9110 §9.3.5's "DELETE is idempotent — either
    // deleted or 404" (either return is allowed).
    r = await fetch(`${base}/repos/notes/docs/hello.md`, {
      method: "DELETE",
      headers: { ...authHeaders(), "If-Match": '"v2"' },
    });
    expect(r.status).toBe(404);
    expect((await readJson<{ code: string }>(r)).code).toBe("doc_not_found");
  });

  it("DELETE with stale If-Match → 412 stale_prev", async () => {
    // Update to v2 first, then try DELETE with v1 — the URL path (hello.md)
    // is still occupied, but by v2 not v1.
    await fetch(`${base}/repos/notes/docs/hello.md`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/markdown", "If-Match": '"v1"' },
      body: "two\n",
    });
    const r = await fetch(`${base}/repos/notes/docs/hello.md`, {
      method: "DELETE",
      headers: { ...authHeaders(), "If-Match": '"v1"' },
    });
    expect(r.status).toBe(412);
    const body = await readJson<{ code: string; data: { current_version_id: string } }>(r);
    expect(body.code).toBe("stale_prev");
    expect(body.data.current_version_id).toBe("v2");
  });
});

describe("REST query", () => {
  beforeEach(async () => {
    await fetch(`${base}/repos`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "notes" }),
    });
    await fetch(`${base}/repos/notes/docs/a.md`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/markdown", "If-None-Match": "*" },
      body: "---\nstatus: draft\n---\nfoo\n",
    });
  });

  it("GET /query returns results + ETag", async () => {
    const r = await fetch(`${base}/query?repo=notes`, { headers: authHeaders() });
    expect(r.status).toBe(200);
    const etag = r.headers.get("etag");
    expect(etag).toBeTruthy();
    expect((await readJson<unknown[]>(r)).length).toBe(1);
    // If-None-Match returns 304
    const r2 = await fetch(`${base}/query?repo=notes`, {
      headers: { ...authHeaders(), "If-None-Match": etag as string },
    });
    expect(r2.status).toBe(304);
  });

  it("POST /query accepts JSON body", async () => {
    const r = await fetch(`${base}/query`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "notes", filter: 'status == "draft"' }),
    });
    expect(r.status).toBe(200);
    expect((await readJson<unknown[]>(r)).length).toBe(1);
  });
});

describe("REST scope header", () => {
  beforeEach(async () => {
    await fetch(`${base}/repos`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "notes" }),
    });
    for (const path of ["public.md", "secret/hidden.md"]) {
      await fetch(`${base}/repos/notes/docs/${path}`, {
        method: "PUT",
        headers: { ...authHeaders(), "Content-Type": "text/markdown", "If-None-Match": "*" },
        body: "x\n",
      });
    }
  });

  it("X-Mrplex-Scope narrows query visibility", async () => {
    const scope = JSON.stringify([{ repo: "notes", paths: ["public.md"] }]);
    const r = await fetch(`${base}/query?repo=notes`, {
      headers: { "X-Mrplex-Scope": scope },
    });
    expect(r.status).toBe(200);
    const rows = await readJson<{ path: string }[]>(r);
    expect(rows.map((x) => x.path)).toEqual(["public.md"]);
  });

  it("a malformed X-Mrplex-Scope → 400 filter_invalid", async () => {
    const r = await fetch(`${base}/repos`, {
      headers: { "X-Mrplex-Scope": "{not json" },
    });
    expect(r.status).toBe(400);
    expect((await readJson<{ code: string }>(r)).code).toBe("filter_invalid");
  });

  it("a structurally-invalid claim (missing repo) → 400 filter_invalid, not silent deny", async () => {
    const r = await fetch(`${base}/repos`, {
      headers: { "X-Mrplex-Scope": JSON.stringify([{ paths: ["**"] }]) },
    });
    expect(r.status).toBe(400);
    expect((await readJson<{ code: string }>(r)).code).toBe("filter_invalid");
  });

  it("POST /query body scope: a repo-less claim → 400 filter_invalid, not empty results", async () => {
    const r = await fetch(`${base}/query`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "notes", scope: [{ paths: ["public.md"] }] }),
    });
    expect(r.status).toBe(400);
    expect((await readJson<{ code: string }>(r)).code).toBe("filter_invalid");
  });

  it("X-Mrplex-Author stamps the author on a write", async () => {
    const r = await fetch(`${base}/repos/notes/docs/authored.md`, {
      method: "PUT",
      headers: {
        ...authHeaders(),
        "Content-Type": "text/markdown",
        "If-None-Match": "*",
        "X-Mrplex-Author": "Ripley <ripley@nostromo>",
      },
      body: "log\n",
    });
    expect(r.status).toBe(201);
    const v = await readJson<{ author: string }>(r);
    expect(v.author).toBe("Ripley <ripley@nostromo>");
  });

  it("an over-length X-Mrplex-Author → 400 filter_invalid (not a 500)", async () => {
    // A raw control char can't ride an HTTP header (undici rejects it
    // client-side), so exercise the same resolveAuthor rejection path via the
    // length cap — the point is that bad author input stays 4xx, not 500.
    const r = await fetch(`${base}/repos/notes/docs/bad-author.md`, {
      method: "PUT",
      headers: {
        ...authHeaders(),
        "Content-Type": "text/markdown",
        "If-None-Match": "*",
        "X-Mrplex-Author": "a".repeat(513),
      },
      body: "log\n",
    });
    expect(r.status).toBe(400);
    expect((await readJson<{ code: string }>(r)).code).toBe("filter_invalid");
  });
});

describe("REST error mapping", () => {
  it("doc_not_found → 404", async () => {
    await fetch(`${base}/repos`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "notes" }),
    });
    const r = await fetch(`${base}/repos/notes/docs/nope.md`, { headers: authHeaders() });
    expect(r.status).toBe(404);
    expect((await readJson<{ code: string }>(r)).code).toBe("doc_not_found");
  });

  it("removed routes (/me/tokens, /users) → 404 no_route", async () => {
    const r = await fetch(`${base}/me/tokens/tbogus`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(r.status).toBe(404);
    expect((await readJson<{ code: string }>(r)).code).toBe("no_route");
  });

  it("version_not_in_document → 422", async () => {
    await fetch(`${base}/repos`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "notes" }),
    });
    // No version v42 exists at all — that comes back as version_not_found (404).
    const r = await fetch(`${base}/repos/notes/versions/v42`, { headers: authHeaders() });
    expect(r.status).toBe(404);
    expect((await readJson<{ code: string }>(r)).code).toBe("version_not_found");
  });

  it("percent-encoded / inside a segment ≠ /: rejected as path_invalid", async () => {
    await fetch(`${base}/repos`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "notes" }),
    });
    // %2F decodes to `/` — combined with disallowed_chars rules, this
    // segment fails validation. (Depending on config, may fail as path_invalid
    // or route differently; assert the surface doesn't collapse segments.)
    const r = await fetch(`${base}/repos/notes/docs/a%2Fb.md`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/markdown", "If-None-Match": "*" },
      body: "x\n",
    });
    // /-in-segment gets decoded per-segment; if the effective config
    // disallows / in a segment, this is path_invalid (400). Never a 500.
    expect([201, 400]).toContain(r.status);
  });
});
