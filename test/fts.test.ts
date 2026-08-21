/**
 * FTS integration tests — SQLite FTS5 through versions_search.
 *
 * Two things to prove:
 *  1. The AFTER INSERT trigger stays in sync with the version_insert
 *     three-statement dance (placeholder update, insert, prev update).
 *  2. versions_search's FTS branch returns only CURRENT versions (§5.1's
 *     "search indexes cover current versions only"), scoped to the given
 *     repo set, ordered by BM25 (best first).
 *
 * We test through versions_search rather than a lower-level primitive so
 * there's one production path — no risk of the tests exercising code
 * kernel.query doesn't touch.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sqliteAdapter } from "../src/storage-sqlite/adapter.js";
import type { RepoRow, Storage } from "../src/storage/types.js";

let storage: Storage;
let repo: RepoRow;
let otherRepo: RepoRow;

const NOW = "2026-08-14T00:00:00Z";
const LATER = "2026-08-14T00:00:01Z";

async function fresh(): Promise<Storage> {
  const path = join(tmpdir(), `mrplex-fts-${Date.now()}-${Math.random()}.db`);
  return sqliteAdapter.open({ database: `sqlite:${path}` });
}

/** Search-and-return ids via the same versions_search path kernel.query uses. */
async function ftsIds(repoIds: readonly number[], text: string): Promise<number[]> {
  const rows = await storage.versions_search({
    repo_ids: repoIds,
    limit: 100,
    text,
    sigils: [],
    scope: { kind: "allow_all" },
  });
  return rows.map((v) => v.id);
}

beforeEach(async () => {
  storage = await fresh();
  repo = await storage.repos_create({ slug: "notes", created_at: NOW });
  otherRepo = await storage.repos_create({ slug: "other", created_at: NOW });
});

afterEach(async () => {
  await storage.close();
});

describe("fts trigger sync with version_insert", () => {
  it("indexes a new version's body via AFTER INSERT trigger", async () => {
    const doc = await storage.documents_create(repo.id);
    const v = await storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: null,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "The quick brown fox jumps over the lazy dog.",
      author: "alice",
      created_at: NOW,
    });
    expect(await ftsIds([repo.id], "quick")).toEqual([v.id]);
  });

  it("indexes every version — the three-statement dance doesn't double-insert or drop", async () => {
    const doc = await storage.documents_create(repo.id);
    const v1 = await storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: null,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "apple pear cherry",
      author: "alice",
      created_at: NOW,
    });
    const v2 = await storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: v1.id,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "apple banana cherry",
      author: "alice",
      created_at: LATER,
    });
    // Searching for apple returns only v2 — v1 also contains "apple" but is
    // superseded (next_id set).
    expect(await ftsIds([repo.id], "apple")).toEqual([v2.id]);
  });
});

describe("versions_search — FTS branch, current-only filter", () => {
  it("skips versions whose next_id is not null", async () => {
    const doc = await storage.documents_create(repo.id);
    const v1 = await storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: null,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "uniquetokenv1",
      author: "alice",
      created_at: NOW,
    });
    await storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: v1.id,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "unrelated content",
      author: "alice",
      created_at: LATER,
    });
    expect(await ftsIds([repo.id], "uniquetokenv1")).toEqual([]);
  });

  it("restricts to the given repo set", async () => {
    const docA = await storage.documents_create(repo.id);
    const docB = await storage.documents_create(otherRepo.id);
    await storage.version_insert({
      document_id: docA.id,
      repo_id: repo.id,
      prev_id: null,
      path: "a.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "sharedterm in notes",
      author: "alice",
      created_at: NOW,
    });
    await storage.version_insert({
      document_id: docB.id,
      repo_id: otherRepo.id,
      prev_id: null,
      path: "b.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "sharedterm in other",
      author: "alice",
      created_at: LATER,
    });
    expect(await ftsIds([repo.id], "sharedterm")).toHaveLength(1);
    expect(await ftsIds([otherRepo.id], "sharedterm")).toHaveLength(1);
    expect(await ftsIds([repo.id, otherRepo.id], "sharedterm")).toHaveLength(2);
  });

  it("returns [] for an empty repo set", async () => {
    const doc = await storage.documents_create(repo.id);
    await storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: null,
      path: "x.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "anything",
      author: "alice",
      created_at: NOW,
    });
    expect(await ftsIds([], "anything")).toEqual([]);
  });

  it("returns [] for a MATCH that hits nothing", async () => {
    const doc = await storage.documents_create(repo.id);
    await storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: null,
      path: "x.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "the corpus contains only these words",
      author: "alice",
      created_at: NOW,
    });
    expect(await ftsIds([repo.id], "nonexistentterm")).toEqual([]);
  });
});

describe("versions_search — FTS ranking + query syntax", () => {
  it("returns rows ordered by BM25 — best first", async () => {
    const doc1 = await storage.documents_create(repo.id);
    const doc2 = await storage.documents_create(repo.id);
    await storage.version_insert({
      document_id: doc1.id,
      repo_id: repo.id,
      prev_id: null,
      path: "one.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "some notes about pricing and other things",
      author: "alice",
      created_at: NOW,
    });
    const v2 = await storage.version_insert({
      document_id: doc2.id,
      repo_id: repo.id,
      prev_id: null,
      path: "two.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "pricing pricing pricing — this doc is about pricing",
      author: "alice",
      created_at: LATER,
    });
    const ids = await ftsIds([repo.id], "pricing");
    expect(ids).toHaveLength(2);
    // The more-relevant doc (v2, 4× pricing) should come first.
    expect(ids[0]).toBe(v2.id);
  });

  it("supports FTS5 boolean operators (OR)", async () => {
    const doc1 = await storage.documents_create(repo.id);
    const doc2 = await storage.documents_create(repo.id);
    await storage.version_insert({
      document_id: doc1.id,
      repo_id: repo.id,
      prev_id: null,
      path: "one.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "content about welcome and greeting",
      author: "alice",
      created_at: NOW,
    });
    await storage.version_insert({
      document_id: doc2.id,
      repo_id: repo.id,
      prev_id: null,
      path: "two.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "content about pricing and fees",
      author: "alice",
      created_at: LATER,
    });
    expect(await ftsIds([repo.id], "welcome OR pricing")).toHaveLength(2);
  });

  it("porter-stemmed English — plurals + verb forms match root", async () => {
    const doc = await storage.documents_create(repo.id);
    await storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: null,
      path: "x.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "the running dogs jumped over fences",
      author: "alice",
      created_at: NOW,
    });
    // porter stems: run/running/runs → run; dog/dogs → dog
    expect(await ftsIds([repo.id], "run")).toHaveLength(1);
    expect(await ftsIds([repo.id], "dog")).toHaveLength(1);
  });
});

describe("fts_index (no-op in SQLite)", () => {
  it("callable but does nothing (triggers handle it)", async () => {
    await expect(storage.fts_index(9999, "arbitrary body")).resolves.toBeUndefined();
  });
});
