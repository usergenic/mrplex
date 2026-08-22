/**
 * Links storage surface (design §11.2, links-plan.md WS3) — direct adapter
 * tests, independent of the kernel write path. Redundant with
 * links-maintenance.test.ts by design: these pin the storage contract
 * (links_replace / links_clear / links_resolve_dangling / links_by_*)
 * so a future adapter change can't drift silently.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sqliteAdapter } from "../src/storage-sqlite/adapter.js";
import type { LinkEdgeInput, Storage } from "../src/storage/types.js";

let storage: Storage;
let repoId: number;
let docA: number;
let docB: number;

async function fresh(): Promise<Storage> {
  return sqliteAdapter.open({
    database: `sqlite:${join(tmpdir(), `mrplex-links-st-${Date.now()}-${Math.random()}.db`)}`,
  });
}

const edge = (over: Partial<LinkEdgeInput> & { ord: number }): LinkEdgeInput => ({
  field: "$body",
  target_raw: "x.md",
  target_norm: "x.md",
  target_id: null,
  ...over,
});

beforeEach(async () => {
  storage = await fresh();
  const repo = await storage.repos_create({ slug: "r", created_at: "2026-08-14T00:00:01Z" });
  repoId = repo.id;
  docA = (await storage.documents_create(repoId)).id;
  docB = (await storage.documents_create(repoId)).id;
});

afterEach(async () => {
  await storage.close();
});

describe("links_replace", () => {
  it("inserts edges and reads them back ordered by ord", async () => {
    await storage.links_replace(repoId, docA, [
      edge({ ord: 0, target_raw: "one.md", target_norm: "one.md" }),
      edge({ ord: 1, target_raw: "two.md", target_norm: "two.md" }),
    ]);
    const rows = await storage.links_by_source(docA);
    expect(rows.map((r) => r.target_raw)).toEqual(["one.md", "two.md"]);
    expect(rows.every((r) => r.repo_id === repoId && r.source_id === docA)).toBe(true);
  });

  it("replaces the prior edge set wholesale", async () => {
    await storage.links_replace(repoId, docA, [edge({ ord: 0, target_raw: "old.md" })]);
    await storage.links_replace(repoId, docA, [edge({ ord: 0, target_raw: "new.md" })]);
    const rows = await storage.links_by_source(docA);
    expect(rows.map((r) => r.target_raw)).toEqual(["new.md"]);
  });

  it("an empty replace clears the source's edges", async () => {
    await storage.links_replace(repoId, docA, [edge({ ord: 0 })]);
    await storage.links_replace(repoId, docA, []);
    expect(await storage.links_by_source(docA)).toEqual([]);
  });

  it("preserves a bound target_id", async () => {
    await storage.links_replace(repoId, docA, [edge({ ord: 0, target_id: docB })]);
    expect((await storage.links_by_source(docA))[0]?.target_id).toBe(docB);
  });

  it("does not touch a different source's edges", async () => {
    await storage.links_replace(repoId, docA, [edge({ ord: 0, target_raw: "a.md" })]);
    await storage.links_replace(repoId, docB, [edge({ ord: 0, target_raw: "b.md" })]);
    await storage.links_replace(repoId, docA, []);
    expect((await storage.links_by_source(docB)).map((r) => r.target_raw)).toEqual(["b.md"]);
  });
});

describe("links_clear", () => {
  it("removes only the given source's edges", async () => {
    await storage.links_replace(repoId, docA, [edge({ ord: 0 })]);
    await storage.links_replace(repoId, docB, [edge({ ord: 0 })]);
    await storage.links_clear(docA);
    expect(await storage.links_by_source(docA)).toEqual([]);
    expect(await storage.links_by_source(docB)).toHaveLength(1);
  });

  it("is a no-op on a source with no edges", async () => {
    await storage.links_clear(docA);
    expect(await storage.links_by_source(docA)).toEqual([]);
  });
});

describe("links_resolve_dangling", () => {
  it("binds only matching dangling edges, returns the count", async () => {
    await storage.links_replace(repoId, docA, [
      edge({ ord: 0, target_norm: "hub.md", target_id: null }),
      edge({ ord: 1, target_norm: "other.md", target_id: null }),
    ]);
    const bound = await storage.links_resolve_dangling(repoId, "hub.md", docB);
    expect(bound).toBe(1);
    const rows = await storage.links_by_source(docA);
    expect(rows[0]?.target_id).toBe(docB); // hub.md bound
    expect(rows[1]?.target_id).toBeNull(); // other.md still dangling
  });

  it("does not touch already-bound edges", async () => {
    const preexisting = (await storage.documents_create(repoId)).id;
    await storage.links_replace(repoId, docA, [
      edge({ ord: 0, target_norm: "hub.md", target_id: preexisting }),
    ]);
    const bound = await storage.links_resolve_dangling(repoId, "hub.md", docB);
    expect(bound).toBe(0);
    expect((await storage.links_by_source(docA))[0]?.target_id).toBe(preexisting);
  });

  it("is repo-scoped — a dangler in another repo is untouched", async () => {
    const otherRepo = await storage.repos_create({
      slug: "other",
      created_at: "2026-08-14T00:00:02Z",
    });
    const otherDoc = (await storage.documents_create(otherRepo.id)).id;
    await storage.links_replace(otherRepo.id, otherDoc, [
      edge({ ord: 0, target_norm: "hub.md", target_id: null }),
    ]);
    const bound = await storage.links_resolve_dangling(repoId, "hub.md", docB);
    expect(bound).toBe(0);
    expect((await storage.links_by_source(otherDoc))[0]?.target_id).toBeNull();
  });

  it("binds danglers across multiple sources at once", async () => {
    await storage.links_replace(repoId, docA, [edge({ ord: 0, target_norm: "hub.md" })]);
    await storage.links_replace(repoId, docB, [edge({ ord: 0, target_norm: "hub.md" })]);
    const target = (await storage.documents_create(repoId)).id;
    const bound = await storage.links_resolve_dangling(repoId, "hub.md", target);
    expect(bound).toBe(2);
  });
});

describe("links_by_repo", () => {
  it("returns all rows in the repo ordered by (source_id, ord)", async () => {
    await storage.links_replace(repoId, docB, [edge({ ord: 0, target_raw: "b0.md" })]);
    await storage.links_replace(repoId, docA, [
      edge({ ord: 1, target_raw: "a1.md" }),
      edge({ ord: 0, target_raw: "a0.md" }),
    ]);
    const rows = await storage.links_by_repo(repoId);
    // docA < docB (created first); within docA, ord 0 then 1.
    expect(rows.map((r) => r.target_raw)).toEqual(["a0.md", "a1.md", "b0.md"]);
  });

  it("returns empty for a repo with no links", async () => {
    expect(await storage.links_by_repo(repoId)).toEqual([]);
  });
});

describe("adjacency reads (graph read surface, docs/graph-plan.md WS1)", () => {
  // docA → docB (resolved) and docA → dangling; docB → docA (resolved).
  beforeEach(async () => {
    await storage.links_replace(repoId, docA, [
      edge({ ord: 0, field: "$body", target_norm: "b.md", target_id: docB }),
      edge({ ord: 1, field: "$body", target_norm: "b.md", target_id: docB }), // duplicate triple
      edge({ ord: 2, field: "parent", target_norm: "b.md", target_id: docB }), // distinct field
      edge({ ord: 3, field: "$body", target_norm: "gone.md", target_id: null }), // dangling
    ]);
    await storage.links_replace(repoId, docB, [
      edge({ ord: 0, field: "$body", target_norm: "a.md", target_id: docA }),
    ]);
  });

  it("links_adjacent_out returns distinct (source,target,field), dangling excluded", async () => {
    const rows = await storage.links_adjacent_out(repoId, [docA]);
    const norm = rows.map((r) => `${r.source_id}:${r.target_id}:${r.field}`).sort();
    // Two duplicate $body edges collapse to one; the parent edge is distinct;
    // the dangling edge is excluded.
    expect(norm).toEqual([`${docA}:${docB}:$body`, `${docA}:${docB}:parent`]);
  });

  it("links_adjacent_in returns distinct inbound triples", async () => {
    const rows = await storage.links_adjacent_in(repoId, [docB]);
    expect(rows.map((r) => `${r.source_id}:${r.target_id}:${r.field}`).sort()).toEqual([
      `${docA}:${docB}:$body`,
      `${docA}:${docB}:parent`,
    ]);
  });

  it("adjacency reads are batched over the id list", async () => {
    const out = await storage.links_adjacent_out(repoId, [docA, docB]);
    // docA→docB ($body, parent) + docB→docA ($body) = three distinct triples.
    expect(out.length).toBe(3);
  });

  it("empty id lists short-circuit to []", async () => {
    expect(await storage.links_adjacent_out(repoId, [])).toEqual([]);
    expect(await storage.links_adjacent_in(repoId, [])).toEqual([]);
    expect(await storage.versions_current_by_documents(repoId, [])).toEqual([]);
  });
});
