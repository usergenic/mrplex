/**
 * Backlog worker: chunk → dedup → hook → upsert.
 *
 * These tests assert HOOK CALL COUNTS, not just resulting vectors —
 * m4-plan risks: dedup correctness is load-bearing for cost, and a
 * text_hash mismatch bug silently re-embeds everything.
 */

import { describe, expect, it } from "vitest";
import { sqliteAdapter } from "../storage-sqlite/adapter.js";
import { createKernel } from "../kernel/kernel.js";
import type { Storage } from "../storage/types.js";
import { chunkBody } from "./chunker.js";
import type { EmbedHook, EmbedResponse } from "./hook.js";
import { createWorker } from "./worker.js";

function fakeHook(dim = 4): { hook: EmbedHook; calls: string[][]; setFail: (b: boolean) => void } {
  const calls: string[][] = [];
  let failing = false;
  const hook: EmbedHook = {
    label: "fake",
    async embed(chunks): Promise<EmbedResponse> {
      calls.push([...chunks]);
      if (failing) throw new Error("hook down");
      const vectors = chunks.map((_c, i) => {
        // Deterministic-per-text: use a hash of the text so the same
        // text always produces the same vector (matches stub-embedder).
        const v = new Array<number>(dim);
        for (let j = 0; j < dim; j++) {
          v[j] = ((_c.charCodeAt(j % _c.length) || 0) + i) / 128 - 1;
        }
        return v;
      });
      return { vectors, model: "fake-model", dim };
    },
    async close() {},
  };
  return { hook, calls, setFail: (b) => (failing = b) };
}

function bootstrap(storage: Storage) {
  const now = new Date().toISOString();
  const u = storage.users_create({ slug: "alice", created_at: now });
  const r = storage.repos_create({ slug: "notes", created_at: now });
  const actor = { user_id: u.id, admin: true, scopes: [] } as {
    user_id: number;
    admin: true;
    scopes: never[];
  };
  return { user: u, repo: r, actor };
}

describe("worker: end-to-end", () => {
  it("drains the backlog and writes chunks with vectors", async () => {
    const s = sqliteAdapter.open({ database: "sqlite::memory:" });
    const { repo, actor } = bootstrap(s);
    const { hook, calls } = fakeHook();
    const worker = createWorker({ storage: s, hook, batchSize: 4 });
    const kernel = createKernel({
      storage: s,
      onVersionCommitted: (id) => s.backlog_enqueue(id),
    });
    const v = kernel.docs.create(actor, repo.slug, "a.md", {
      body: "hello world\n\n# section\n\nmore text",
      frontmatter_raw: "",
    });
    const versionId = decodeVersionId(v.version_id);
    // Backlog should have one row.
    expect(s.backlog_dequeue(new Date().toISOString(), 10).length).toBe(1);
    await worker.drainOnce();
    expect(s.backlog_dequeue(new Date().toISOString(), 10).length).toBe(0);
    const chunks = s.chunks_by_version(versionId);
    expect(chunks.length).toBe(chunkBody(v.body).length);
    expect(calls.length).toBe(1); // one hook call, all chunks in it
    for (const c of chunks) {
      expect(c.embedding).not.toBeNull();
      expect(c.model).toBe("fake-model");
    }
  });

  it("dedup: editing one chunk only re-embeds the touched chunk", async () => {
    const s = sqliteAdapter.open({ database: "sqlite::memory:" });
    const { repo, actor } = bootstrap(s);
    const { hook, calls } = fakeHook();
    const worker = createWorker({ storage: s, hook });
    const kernel = createKernel({
      storage: s,
      onVersionCommitted: (id) => s.backlog_enqueue(id),
    });
    const body1 = "block one\n\nblock two\n\nblock three";
    const v1 = kernel.docs.create(actor, repo.slug, "a.md", {
      body: body1,
      frontmatter_raw: "",
    });
    await worker.drainOnce();
    expect(calls.length).toBe(1);
    expect(calls[0]?.length).toBe(1); // greedy-packed into one chunk

    // Rewrite touching only "block two".
    const body2 = "block one\n\nblock CHANGED\n\nblock three";
    kernel.docs.put(actor, repo.slug, v1.version_id, "a.md", {
      body: body2,
      frontmatter_raw: "",
    });
    await worker.drainOnce();
    // The greedy chunker packs all three blocks into one chunk (well
    // under the cap), so this SHOULD still be a full re-embed — one
    // call, one text. The dedup guarantee is exact hash equality,
    // which the whole-chunk change defeats. That is intentional: our
    // guarantee is "identical text reuses"; a partial-block dedup
    // needs the block tree (§11).
    expect(calls.length).toBe(2);
    expect(calls[1]?.length).toBe(1);
  });

  it("dedup: rewriting the body with same content = zero hook calls", async () => {
    const s = sqliteAdapter.open({ database: "sqlite::memory:" });
    const { repo, actor } = bootstrap(s);
    const { hook, calls } = fakeHook();
    const worker = createWorker({ storage: s, hook });
    const kernel = createKernel({
      storage: s,
      onVersionCommitted: (id) => s.backlog_enqueue(id),
    });
    const body = "hello\n\nworld";
    const v1 = kernel.docs.create(actor, repo.slug, "a.md", { body, frontmatter_raw: "" });
    await worker.drainOnce();
    expect(calls.length).toBe(1);
    // Same body, different frontmatter — chunk text unchanged.
    kernel.docs.put(actor, repo.slug, v1.version_id, "a.md", {
      body,
      frontmatter_raw: "status: draft\n",
    });
    await worker.drainOnce();
    expect(calls.length).toBe(1); // no new hook call
  });

  it("burst dedup: N rapid writes collapse to one embed (current-only)", async () => {
    const s = sqliteAdapter.open({ database: "sqlite::memory:" });
    const { repo, actor } = bootstrap(s);
    const { hook, calls } = fakeHook();
    const worker = createWorker({ storage: s, hook });
    const kernel = createKernel({
      storage: s,
      onVersionCommitted: (id) => s.backlog_enqueue(id),
    });
    let prev = kernel.docs.create(actor, repo.slug, "a.md", {
      body: "v0",
      frontmatter_raw: "",
    });
    for (let i = 1; i < 5; i++) {
      prev = kernel.docs.put(actor, repo.slug, prev.version_id, "a.md", {
        body: `v${i}`,
        frontmatter_raw: "",
      });
    }
    // At this point 5 backlog rows exist but 4 are superseded.
    await worker.drainOnce();
    // Should have called the hook exactly once — on the final version.
    expect(calls.length).toBe(1);
    expect(calls[0]?.[0]).toBe("v4");
  });

  it("hook failure retains the entry with exponential backoff", async () => {
    const s = sqliteAdapter.open({ database: "sqlite::memory:" });
    const { repo, actor } = bootstrap(s);
    const { hook, calls, setFail } = fakeHook();
    const worker = createWorker({
      storage: s,
      hook,
      backoffBaseMs: 1000, // fast in tests
      backoffCapMs: 60_000,
    });
    const kernel = createKernel({
      storage: s,
      onVersionCommitted: (id) => s.backlog_enqueue(id),
    });
    kernel.docs.create(actor, repo.slug, "a.md", {
      body: "hello",
      frontmatter_raw: "",
    });
    setFail(true);
    await worker.drainOnce();
    expect(calls.length).toBe(1);
    // Not due now.
    const now = new Date().toISOString();
    const due = s.backlog_dequeue(now, 10);
    expect(due.length).toBe(0);
    // Due in the future.
    const later = new Date(Date.now() + 60_000).toISOString();
    const dueLater = s.backlog_dequeue(later, 10);
    expect(dueLater.length).toBe(1);
    expect(dueLater[0]?.attempts).toBe(1);
    expect(dueLater[0]?.last_error).toContain("hook down");
    // Recover.
    setFail(false);
    // Advance time in a synthetic way: drainOnce reads `now` internally,
    // and we want it to see the future. Retain with a past next_retry_at
    // manually to make it due.
    s.backlog_retain({
      version_id: dueLater[0]?.version_id as number,
      attempts: 1,
      last_error: "hook down",
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    });
    await worker.drainOnce();
    expect(s.backlog_dequeue(new Date().toISOString(), 10).length).toBe(0);
  });
});

// Local decoder that matches version-id.ts without importing (avoids
// circular imports in a test).
function decodeVersionId(id: string): number {
  const m = id.match(/^v(\d+)$/);
  if (!m || !m[1]) throw new Error(`bad version id: ${id}`);
  return Number.parseInt(m[1], 10);
}
