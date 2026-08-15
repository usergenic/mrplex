/**
 * Vector encode/decode + adapter chunks/backlog round-trip.
 *
 * The mission of this file is the M4 storage layer's honesty:
 * float32 BLOBs round-trip byte-exact inside the adapter, dedup keys
 * correctly on (model, text_hash), vector search returns brute-force
 * top-k under cosine distance filtered to current versions, and the
 * backlog behaves as a queue with retry.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { sqliteAdapter } from "./adapter.js";
import { decodeVectorBlob, encodeVectorBlob } from "./vec.js";

async function seed() {
  const s = await sqliteAdapter.open({ database: "sqlite::memory:" });
  const now = new Date().toISOString();
  const u = await s.users_create({ slug: "alice", created_at: now });
  const r = await s.repos_create({ slug: "notes", created_at: now });
  const d = await s.documents_create(r.id);
  const v = await s.version_insert({
    document_id: d.id,
    repo_id: r.id,
    prev_id: null,
    path: "a.md",
    frontmatter_raw: "",
    frontmatter: {},
    body: "hello",
    author_id: u.id,
    created_at: now,
  });
  return { s, u, r, d, v };
}

describe("vec: encode/decode", () => {
  it("round-trips [1, 0, 0] byte-exact", () => {
    const enc = encodeVectorBlob([1, 0, 0]);
    expect(enc.byteLength).toBe(12);
    const dec = decodeVectorBlob(enc);
    expect(Array.from(dec)).toEqual([1, 0, 0]);
  });

  it("accepts Float32Array input and returns a Float32Array (no aliasing)", () => {
    const src = Float32Array.from([0.5, -0.25, 0.87543]);
    const enc = encodeVectorBlob(src);
    src[0] = 999; // must not affect the encoded blob
    const dec = decodeVectorBlob(enc);
    expect(dec).toBeInstanceOf(Float32Array);
    expect(dec[0]).toBeCloseTo(0.5, 5);
    expect(dec[1]).toBeCloseTo(-0.25, 5);
    expect(dec[2]).toBeCloseTo(0.87543, 4);
  });

  it("throws on BLOB whose length is not a multiple of 4", () => {
    expect(() => decodeVectorBlob(Buffer.from([1, 2, 3]))).toThrow(/multiple of 4/);
  });
});

describe("adapter: chunks + vector_search", () => {
  it("upserts chunks and finds the nearest under cosine distance", async () => {
    const { s, r, v } = await seed();
    await s.chunks_upsert(v.id, "m", [
      { ix: 0, text: "x-axis", text_hash: "h1", model: "m", embedding: [1, 0, 0] },
      { ix: 1, text: "y-axis", text_hash: "h2", model: "m", embedding: [0, 1, 0] },
      { ix: 2, text: "z-axis", text_hash: "h3", model: "m", embedding: [0, 0, 1] },
    ]);

    const hits = await s.vector_search([r.id], "m", [1, 0, 0], 3);
    expect(hits.length).toBe(1);
    expect(hits[0]?.version_id).toBe(v.id);
    expect(hits[0]?.chunk_ix).toBe(0);
    expect(hits[0]?.score).toBeCloseTo(0, 5);
  });

  it("returns the chunk_ix of the winning chunk (not an arbitrary one)", async () => {
    const { s, r, v } = await seed();
    await s.chunks_upsert(v.id, "m", [
      { ix: 0, text: "far", text_hash: "h1", model: "m", embedding: [1, 0, 0] },
      { ix: 1, text: "mid", text_hash: "h2", model: "m", embedding: [0, 1, 0] },
      { ix: 2, text: "hit", text_hash: "h3", model: "m", embedding: [0, 0, 1] },
    ]);
    const hits = await s.vector_search([r.id], "m", [0, 0, 1], 5);
    expect(hits.length).toBe(1);
    expect(hits[0]?.chunk_ix).toBe(2);
    expect(hits[0]?.score).toBeCloseTo(0, 5);
  });

  it("filters vector_search to current-version chunks only", async () => {
    const { s, r, u, v } = await seed();
    const now = new Date().toISOString();
    const vec: readonly number[] = [1, 0, 0];
    await s.chunks_upsert(v.id, "m", [
      { ix: 0, text: "old", text_hash: "h_old", model: "m", embedding: vec },
    ]);
    // Supersede v with a new version at the same path.
    const v2 = await s.version_insert({
      document_id: v.document_id,
      repo_id: r.id,
      prev_id: v.id,
      path: "a.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "new",
      author_id: u.id,
      created_at: now,
    });
    // v is no longer current — its chunks must not appear.
    let hits = await s.vector_search([r.id], "m", vec, 5);
    expect(hits.length).toBe(0);

    await s.chunks_upsert(v2.id, "m", [
      { ix: 0, text: "new", text_hash: "h_new", model: "m", embedding: vec },
    ]);
    hits = await s.vector_search([r.id], "m", vec, 5);
    expect(hits.length).toBe(1);
    expect(hits[0]?.version_id).toBe(v2.id);
  });

  it("chunks_upsert refuses mixed-dim embeddings in one batch", async () => {
    const { s, v } = await seed();
    await expect(
      s.chunks_upsert(v.id, "m", [
        { ix: 0, text: "a", text_hash: "h1", model: "m", embedding: [1, 0, 0] },
        { ix: 1, text: "b", text_hash: "h2", model: "m", embedding: [1, 0] },
      ]),
    ).rejects.toThrow(/mixed embedding dimensions/);
  });

  it("chunks_by_hash returns one row per hash", async () => {
    const { s, v } = await seed();
    await s.chunks_upsert(v.id, "m", [
      { ix: 0, text: "a", text_hash: "h1", model: "m", embedding: [1, 0, 0] },
      { ix: 1, text: "b", text_hash: "h2", model: "m", embedding: [0, 1, 0] },
    ]);
    const rows = await s.chunks_by_hash("m", ["h1", "h2", "missing"]);
    const hashes = rows.map((r) => r.text_hash).sort();
    expect(hashes).toEqual(["h1", "h2"]);
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.embedding).toBeInstanceOf(Float32Array);
    }
  });

  it("chunks_upsert with an empty list wipes prior chunks for the version", async () => {
    const { s, v } = await seed();
    await s.chunks_upsert(v.id, "m", [
      { ix: 0, text: "a", text_hash: "h1", model: "m", embedding: [1, 0, 0] },
    ]);
    await s.chunks_upsert(v.id, "", []);
    expect((await s.chunks_by_version(v.id)).length).toBe(0);
  });
});

describe("adapter: backlog", () => {
  it("dequeue returns rows due now, ordered oldest-first", async () => {
    const { s, v } = await seed();
    await s.backlog_enqueue(v.id);
    const rows = await s.backlog_dequeue(new Date().toISOString(), 10);
    expect(rows.length).toBe(1);
    expect(rows[0]?.version_id).toBe(v.id);
  });

  it("backlog_retain updates attempts + next_retry_at", async () => {
    const { s, v } = await seed();
    await s.backlog_enqueue(v.id);
    await s.backlog_retain({
      version_id: v.id,
      attempts: 3,
      last_error: "boom",
      next_retry_at: "2099-01-01T00:00:00.000Z",
    });
    const rows = await s.backlog_dequeue(new Date().toISOString(), 10);
    expect(rows.length).toBe(0); // not due
  });

  it("backlog_status summarizes counts + models", async () => {
    const { s, v } = await seed();
    await s.backlog_enqueue(v.id);
    await s.backlog_retain({
      version_id: v.id,
      attempts: 2,
      last_error: "e",
      next_retry_at: new Date(Date.now() + 60_000).toISOString(),
    });
    await s.chunks_upsert(v.id, "m", [
      { ix: 0, text: "a", text_hash: "h1", model: "m", embedding: [1, 0] },
    ]);
    const status = await s.backlog_status(new Date().toISOString());
    expect(status.pending).toBe(1);
    expect(status.due).toBe(0);
    expect(status.failing).toBe(1);
    expect(status.models).toEqual([{ model: "m", chunk_count: 1 }]);
    expect(status.recent_errors.length).toBe(1);
  });
});
