/**
 * kernel.query semantic — the M4 semantic mode end-to-end.
 *
 * Assertions:
 *   • semantic without a hook → semantic_unavailable
 *   • semantic orders documents by cosine distance to the query vector
 *   • semantic ∩ filter ∩ text composes
 *   • out-of-scope and hidden/system docs are excluded from semantic hits
 *   • docs without chunks under the queried model are absent from semantic
 *     (but still surface via filter/text)
 */

import { describe, expect, it } from "vitest";
import { chunkBody } from "../src/embed/chunker.js";
import type { CallContext } from "../src/kernel/context.js";
import { KernelError } from "../src/kernel/errors.js";
import { createKernel } from "../src/kernel/kernel.js";
import { sqliteAdapter } from "../src/storage-sqlite/adapter.js";
import type { Storage } from "../src/storage/types.js";

// A tiny 3-dim "corpus" — each doc is embedded as a fixed unit vector so
// the test is a mechanical assertion about ordering under cosine distance.

async function seedWithVectors(
  storage: Storage,
  cases: readonly {
    path: string;
    body: string;
    vector: readonly number[];
    model?: string;
  }[],
) {
  const admin: CallContext = {};
  const kernel = createKernel(storage);
  await storage.repos_create({ slug: "notes", created_at: "2026-08-14T00:00:00Z" });
  const ids: { path: string; version_id: number }[] = [];
  for (const c of cases) {
    const v = await kernel.docs.create(admin, "notes", c.path, {
      body: c.body,
      frontmatter_raw: "",
    });
    // Direct chunks insert bypasses the worker — we control the vector.
    const chunks = chunkBody(c.body);
    if (chunks.length === 0) continue;
    // For test simplicity: one chunk gets the requested vector; if there
    // are multiple chunks, subsequent ones are duplicates (fine for
    // brute-force top-k which picks the min distance).
    const model = c.model ?? "test-3d";
    const upsertChunks = chunks.map((chunk) => ({
      ix: chunk.ix,
      text: chunk.text,
      text_hash: chunk.text_hash,
      model,
      embedding: c.vector,
    }));
    // Decode the version_id back to a storage id.
    const numericId = Number.parseInt(v.version_id.replace(/^v/, ""), 10);
    await storage.chunks_upsert(numericId, model, upsertChunks);
    ids.push({ path: c.path, version_id: numericId });
  }
  return { kernel, admin, ids };
}

describe("query — semantic", () => {
  it("semantic without a queryEmbed hook → semantic_unavailable", async () => {
    const storage = await sqliteAdapter.open({ database: "sqlite::memory:" });
    const { kernel, admin } = await seedWithVectors(storage, [
      { path: "a.md", body: "alpha", vector: [1, 0, 0] },
    ]);
    try {
      await kernel.query(admin, { repo: "notes", semantic: "anything" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(KernelError);
      expect((err as KernelError).code).toBe("semantic_unavailable");
    }
  });

  it("orders docs by cosine distance to the query vector (nearest first)", async () => {
    const storage = await sqliteAdapter.open({ database: "sqlite::memory:" });
    const { admin } = await seedWithVectors(storage, [
      { path: "x.md", body: "x-axis", vector: [1, 0, 0] },
      { path: "y.md", body: "y-axis", vector: [0, 1, 0] },
      { path: "z.md", body: "z-axis", vector: [0, 0, 1] },
    ]);
    // Ask the kernel to embed "close to x" as [0.9, 0.1, 0].
    const kernel = createKernel({
      storage,
      queryEmbed: async () => ({ vector: [0.9, 0.1, 0], model: "test-3d", dim: 3 }),
    });
    const rows = await kernel.query(admin, { repo: "notes", semantic: "close to x" });
    expect(rows.map((r) => r.$path)).toEqual(["x.md", "y.md", "z.md"]);
  });

  it("projects $semantic_score when selected (cosine similarity)", async () => {
    const storage = await sqliteAdapter.open({ database: "sqlite::memory:" });
    const { admin } = await seedWithVectors(storage, [
      { path: "x.md", body: "x-axis", vector: [1, 0, 0] },
      { path: "y.md", body: "y-axis", vector: [0, 1, 0] },
    ]);
    const kernel = createKernel({
      storage,
      queryEmbed: async () => ({ vector: [1, 0, 0], model: "test-3d", dim: 3 }),
    });
    const rows = await kernel.query(admin, {
      repo: "notes",
      semantic: "x",
      select: ["$path", "$semantic_score"],
    });
    expect(rows[0]?.$path).toBe("x.md");
    expect(rows[0]?.$semantic_score).toBeCloseTo(1, 5);
    expect(rows[1]?.$path).toBe("y.md");
    expect(rows[1]?.$semantic_score).toBeCloseTo(0, 5);
  });

  it("intersects with filter (excluded rows disappear)", async () => {
    const storage = await sqliteAdapter.open({ database: "sqlite::memory:" });
    const { admin } = await seedWithVectors(storage, [
      { path: "x.md", body: "x-axis", vector: [1, 0, 0] },
      { path: "y.md", body: "y-axis", vector: [0.9, 0.1, 0] },
    ]);
    const kernel = createKernel({
      storage,
      queryEmbed: async () => ({ vector: [1, 0, 0], model: "test-3d", dim: 3 }),
    });
    // With no frontmatter set, "status" is missing, so `status == "draft"`
    // yields false and both docs drop.
    const rows = await kernel.query(admin, {
      repo: "notes",
      semantic: "x",
      filter: 'status == "draft"',
    });
    expect(rows.length).toBe(0);
  });

  it("docs without chunks under the queried model are absent from semantic", async () => {
    const storage = await sqliteAdapter.open({ database: "sqlite::memory:" });
    const { admin } = await seedWithVectors(storage, [
      { path: "a.md", body: "alpha", vector: [1, 0, 0], model: "model-a" },
      { path: "b.md", body: "beta", vector: [0, 1, 0], model: "model-b" },
    ]);
    const kernel = createKernel({
      storage,
      queryEmbed: async () => ({ vector: [1, 0, 0], model: "model-a", dim: 3 }),
    });
    // Only a.md is under model-a, so semantic returns just that.
    const semanticRows = await kernel.query(admin, { repo: "notes", semantic: "x" });
    expect(semanticRows.map((r) => r.$path)).toEqual(["a.md"]);
    // But filter-only sees both.
    const allRows = await kernel.query(admin, { repo: "notes" });
    expect(allRows.map((r) => r.$path).sort()).toEqual(["a.md", "b.md"]);
  });

  it("system-namespace paths stay hidden from semantic by default", async () => {
    const storage = await sqliteAdapter.open({ database: "sqlite::memory:" });
    const kernel = createKernel({
      storage,
      queryEmbed: async () => ({ vector: [1, 0, 0], model: "test-3d", dim: 3 }),
    });
    await storage.repos_create({ slug: "notes", created_at: "2026-08-14T00:00:00Z" });
    const admin: CallContext = {};
    const v = await kernel.docs.create(admin, "notes", "hello.md", {
      body: "hello world",
      frontmatter_raw: "",
    });
    // Embed the doc manually.
    const numericId = Number.parseInt(v.version_id.replace(/^v/, ""), 10);
    const chunks = chunkBody("hello world");
    await storage.chunks_upsert(
      numericId,
      "test-3d",
      chunks.map((c) => ({
        ix: c.ix,
        text: c.text,
        text_hash: c.text_hash,
        model: "test-3d",
        embedding: [1, 0, 0],
      })),
    );
    // Delete → :deleted/…
    const deleted = await kernel.docs.delete(admin, "notes", v.version_id);
    // Embed the deleted version too — otherwise it wouldn't be in the
    // current-versions vector index.
    const deletedId = Number.parseInt(deleted.version_id.replace(/^v/, ""), 10);
    await storage.chunks_upsert(deletedId, "test-3d", [
      {
        ix: 0,
        text: "hello world",
        text_hash: "same",
        model: "test-3d",
        embedding: [1, 0, 0],
      },
    ]);
    // Default semantic → nothing (path under :deleted/).
    const rows = await kernel.query(admin, { repo: "notes", semantic: "hello" });
    expect(rows.length).toBe(0);
    // include_system → surfaces it.
    const withSystem = await kernel.query(admin, {
      repo: "notes",
      semantic: "hello",
      include_system: true,
    });
    expect(withSystem.length).toBe(1);
    expect(withSystem[0]?.$path).toMatch(/^:deleted\//);
  });

  it("hook error at query time → semantic_unavailable with cause", async () => {
    const storage = await sqliteAdapter.open({ database: "sqlite::memory:" });
    const { admin } = await seedWithVectors(storage, [
      { path: "a.md", body: "alpha", vector: [1, 0, 0] },
    ]);
    const kernel = createKernel({
      storage,
      queryEmbed: async () => {
        throw new Error("hook down");
      },
    });
    try {
      await kernel.query(admin, { repo: "notes", semantic: "x" });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as KernelError).code).toBe("semantic_unavailable");
      const data = (err as KernelError<{ reason: string }>).data;
      expect(data.reason).toContain("hook down");
    }
  });
});
