/**
 * Vector encode/decode + adapter chunks/backlog round-trip.
 *
 * The mission of this file is the M4 storage layer's honesty:
 * float32 BLOBs round-trip byte-exact, dedup keys correctly on
 * (model, text_hash), vector search returns brute-force top-k under
 * cosine distance filtered to current versions, and the backlog
 * behaves as a queue with retry.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { sqliteAdapter } from "./adapter.js";
import { decodeVectorBlob, encodeVectorBlob } from "./vec.js";

function seed() {
  const s = sqliteAdapter.open({ database: "sqlite::memory:" });
  const now = new Date().toISOString();
  const u = s.users_create({ slug: "alice", created_at: now });
  const r = s.repos_create({ slug: "notes", created_at: now });
  const d = s.documents_create(r.id);
  const v = s.version_insert({
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
  it("upserts chunks and finds the nearest under cosine distance", () => {
    const { s, r, v } = seed();
    const e1 = encodeVectorBlob([1, 0, 0]);
    const e2 = encodeVectorBlob([0, 1, 0]);
    const e3 = encodeVectorBlob([0, 0, 1]);
    s.chunks_upsert(v.id, "m", [
      { ix: 0, text: "x-axis", text_hash: "h1", model: "m", embedding: e1 },
      { ix: 1, text: "y-axis", text_hash: "h2", model: "m", embedding: e2 },
      { ix: 2, text: "z-axis", text_hash: "h3", model: "m", embedding: e3 },
    ]);

    // Query for x-axis — chunk 0 must win with distance ≈ 0.
    const hits = s.vector_search([r.id], "m", encodeVectorBlob([1, 0, 0]), 3);
    expect(hits.length).toBe(1); // only one version has chunks
    expect(hits[0]?.version_id).toBe(v.id);
    expect(hits[0]?.chunk_ix).toBe(0);
    expect(hits[0]?.score).toBeCloseTo(0, 5);
  });

  it("filters vector_search to current-version chunks only", () => {
    const { s, r, u, v } = seed();
    const now = new Date().toISOString();
    const e = encodeVectorBlob([1, 0, 0]);
    s.chunks_upsert(v.id, "m", [
      { ix: 0, text: "old", text_hash: "h_old", model: "m", embedding: e },
    ]);
    // Advance the version chain — v is no longer current.
    const v2 = s.version_insert({
      document_id: v.document_id,
      repo_id: r.id,
      prev_id: v.id,
      path: "a.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "hello v2",
      author_id: u.id,
      created_at: now,
    });
    // v2 has no chunks yet — the old chunks on v must NOT surface.
    expect(s.vector_search([r.id], "m", e, 5).length).toBe(0);
    // After embedding v2, we see v2's chunk.
    s.chunks_upsert(v2.id, "m", [
      { ix: 0, text: "new", text_hash: "h_new", model: "m", embedding: e },
    ]);
    const hits = s.vector_search([r.id], "m", e, 5);
    expect(hits.length).toBe(1);
    expect(hits[0]?.version_id).toBe(v2.id);
  });

  it("refuses mixed dimensions in one upsert batch", () => {
    const { s, v } = seed();
    expect(() =>
      s.chunks_upsert(v.id, "m", [
        { ix: 0, text: "a", text_hash: "h", model: "m", embedding: encodeVectorBlob([1, 0]) },
        { ix: 1, text: "b", text_hash: "h2", model: "m", embedding: encodeVectorBlob([1, 0, 0]) },
      ]),
    ).toThrow(/mixed embedding dimensions/);
  });

  it("chunks_by_hash returns one row per hash for the given model", () => {
    const { s, v } = seed();
    const e = encodeVectorBlob([1, 0, 0]);
    s.chunks_upsert(v.id, "m", [
      { ix: 0, text: "a", text_hash: "h1", model: "m", embedding: e },
      { ix: 1, text: "b", text_hash: "h2", model: "m", embedding: e },
    ]);
    const hits = s.chunks_by_hash("m", ["h1", "h_missing", "h2"]);
    const hashes = hits.map((r) => r.text_hash).sort();
    expect(hashes).toEqual(["h1", "h2"]);
    // Wrong model → no hits.
    expect(s.chunks_by_hash("other-model", ["h1"]).length).toBe(0);
  });

  it("empty chunks_upsert wipes prior chunks", () => {
    const { s, v } = seed();
    const e = encodeVectorBlob([1, 0, 0]);
    s.chunks_upsert(v.id, "m", [{ ix: 0, text: "a", text_hash: "h1", model: "m", embedding: e }]);
    s.chunks_upsert(v.id, "m", []);
    expect(s.chunks_by_version(v.id).length).toBe(0);
  });
});

describe("adapter: backlog", () => {
  it("enqueue → dequeue → retain → dequeue reflects backoff", () => {
    const { s, v } = seed();
    s.backlog_enqueue(v.id);
    const now = new Date().toISOString();
    const due = s.backlog_dequeue(now, 10);
    expect(due.length).toBe(1);
    expect(due[0]?.attempts).toBe(0);

    // Retain with a future retry — should not appear as due yet.
    const future = new Date(Date.now() + 60_000).toISOString();
    s.backlog_retain({
      version_id: v.id,
      attempts: 1,
      last_error: "hook down",
      next_retry_at: future,
    });
    expect(s.backlog_dequeue(now, 10).length).toBe(0);
    // But is due once now moves past `future`.
    const later = new Date(Date.now() + 120_000).toISOString();
    expect(s.backlog_dequeue(later, 10).length).toBe(1);
  });

  it("enqueue resets attempts + next_retry_at (superseding write flushes backoff)", () => {
    const { s, v } = seed();
    s.backlog_enqueue(v.id);
    s.backlog_retain({
      version_id: v.id,
      attempts: 5,
      last_error: "boom",
      next_retry_at: new Date(Date.now() + 60_000).toISOString(),
    });
    s.backlog_enqueue(v.id); // simulate the superseding write's enqueue
    const now = new Date().toISOString();
    const due = s.backlog_dequeue(now, 10);
    expect(due.length).toBe(1);
    expect(due[0]?.attempts).toBe(0);
    expect(due[0]?.last_error).toBeNull();
    expect(due[0]?.next_retry_at).toBeNull();
  });

  it("backlog_status summarizes counts + models", () => {
    const { s, v } = seed();
    s.backlog_enqueue(v.id);
    s.backlog_retain({
      version_id: v.id,
      attempts: 2,
      last_error: "e",
      next_retry_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const e = encodeVectorBlob([1, 0]);
    s.chunks_upsert(v.id, "m", [{ ix: 0, text: "a", text_hash: "h1", model: "m", embedding: e }]);
    const status = s.backlog_status(new Date().toISOString());
    expect(status.pending).toBe(1);
    expect(status.due).toBe(0);
    expect(status.failing).toBe(1);
    expect(status.models).toEqual([{ model: "m", chunk_count: 1 }]);
    expect(status.recent_errors.length).toBe(1);
  });
});
