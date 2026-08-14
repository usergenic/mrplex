/**
 * FTS integration tests — SQLite FTS5 adapter methods + trigger behavior.
 *
 * Two things to prove:
 *  1. The AFTER INSERT trigger stays in sync with the version_insert
 *     three-statement dance (placeholder update, insert, prev update).
 *  2. fts_search returns only CURRENT versions (design §5.1's
 *     "search indexes cover current versions only"), scoped to the given
 *     repo set, ordered by BM25 (best first).
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sqliteAdapter } from "../src/storage-sqlite/adapter.js";
import type { RepoRow, Storage, UserRow } from "../src/storage/types.js";

let storage: Storage;
let user: UserRow;
let repo: RepoRow;
let otherRepo: RepoRow;

const NOW = "2026-08-14T00:00:00Z";
const LATER = "2026-08-14T00:00:01Z";
const LATEST = "2026-08-14T00:00:02Z";

function fresh(): Storage {
  const path = join(tmpdir(), `mrplex-fts-${Date.now()}-${Math.random()}.db`);
  return sqliteAdapter.open({ database: `sqlite:${path}` });
}

beforeEach(() => {
  storage = fresh();
  user = storage.users_create({ slug: "alice", created_at: NOW });
  repo = storage.repos_create({ slug: "notes", created_at: NOW });
  otherRepo = storage.repos_create({ slug: "other", created_at: NOW });
});

afterEach(() => {
  storage.close();
});

describe("fts trigger sync with version_insert", () => {
  it("indexes a new version's body via AFTER INSERT trigger", () => {
    const doc = storage.documents_create(repo.id);
    const v = storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: null,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "The quick brown fox jumps over the lazy dog.",
      author_id: user.id,
      created_at: NOW,
    });
    const hits = storage.fts_search([repo.id], "quick");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.version_id).toBe(v.id);
  });

  it("indexes every version — the three-statement dance doesn't double-insert or drop", () => {
    const doc = storage.documents_create(repo.id);
    const v1 = storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: null,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "apple pear cherry",
      author_id: user.id,
      created_at: NOW,
    });
    const v2 = storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: v1.id,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "apple banana cherry",
      author_id: user.id,
      created_at: LATER,
    });
    // Searching for apple should return v2 only — even though v1 also
    // contains "apple", it's superseded (next_id is not null).
    const hits = storage.fts_search([repo.id], "apple");
    expect(hits.map((h) => h.version_id)).toEqual([v2.id]);
  });
});

describe("fts_search — current-only filter", () => {
  it("skips versions whose next_id is not null", () => {
    const doc = storage.documents_create(repo.id);
    const v1 = storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: null,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "uniquetokenv1",
      author_id: user.id,
      created_at: NOW,
    });
    storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: v1.id,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "unrelated content",
      author_id: user.id,
      created_at: LATER,
    });
    // v1 is in the FTS index, but next_id is set — should not appear.
    const hits = storage.fts_search([repo.id], "uniquetokenv1");
    expect(hits).toEqual([]);
  });

  it("restricts to the given repo set", () => {
    const docA = storage.documents_create(repo.id);
    const docB = storage.documents_create(otherRepo.id);
    storage.version_insert({
      document_id: docA.id,
      repo_id: repo.id,
      prev_id: null,
      path: "a.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "sharedterm in notes",
      author_id: user.id,
      created_at: NOW,
    });
    storage.version_insert({
      document_id: docB.id,
      repo_id: otherRepo.id,
      prev_id: null,
      path: "b.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "sharedterm in other",
      author_id: user.id,
      created_at: LATER,
    });
    const notesHits = storage.fts_search([repo.id], "sharedterm");
    expect(notesHits).toHaveLength(1);
    const otherHits = storage.fts_search([otherRepo.id], "sharedterm");
    expect(otherHits).toHaveLength(1);
    const bothHits = storage.fts_search([repo.id, otherRepo.id], "sharedterm");
    expect(bothHits).toHaveLength(2);
  });

  it("returns [] for an empty repo set (avoids `IN ()` syntax errors)", () => {
    const doc = storage.documents_create(repo.id);
    storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: null,
      path: "x.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "anything",
      author_id: user.id,
      created_at: NOW,
    });
    expect(storage.fts_search([], "anything")).toEqual([]);
  });

  it("returns [] for a MATCH that hits nothing", () => {
    const doc = storage.documents_create(repo.id);
    storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: null,
      path: "x.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "the corpus contains only these words",
      author_id: user.id,
      created_at: NOW,
    });
    expect(storage.fts_search([repo.id], "nonexistentterm")).toEqual([]);
  });
});

describe("fts_search — ranking + query syntax", () => {
  it("returns rows ordered by BM25 — best first (higher normalized score)", () => {
    const doc1 = storage.documents_create(repo.id);
    const doc2 = storage.documents_create(repo.id);
    // doc1 has "pricing" once; doc2 has "pricing" three times → doc2 more relevant.
    storage.version_insert({
      document_id: doc1.id,
      repo_id: repo.id,
      prev_id: null,
      path: "one.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "some notes about pricing and other things",
      author_id: user.id,
      created_at: NOW,
    });
    storage.version_insert({
      document_id: doc2.id,
      repo_id: repo.id,
      prev_id: null,
      path: "two.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "pricing pricing pricing — this doc is about pricing",
      author_id: user.id,
      created_at: LATER,
    });
    const hits = storage.fts_search([repo.id], "pricing");
    expect(hits).toHaveLength(2);
    // doc2 (id=2) should be ranked first (better BM25 = more negative raw → higher after negation).
    // The exact score depends on the tokenizer + corpus stats, but ordering is stable.
    const firstScore = hits[0]?.score ?? 0;
    const secondScore = hits[1]?.score ?? 0;
    expect(firstScore).toBeGreaterThanOrEqual(secondScore);
  });

  it("supports FTS5 boolean operators (OR)", () => {
    const doc1 = storage.documents_create(repo.id);
    const doc2 = storage.documents_create(repo.id);
    storage.version_insert({
      document_id: doc1.id,
      repo_id: repo.id,
      prev_id: null,
      path: "one.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "content about welcome and greeting",
      author_id: user.id,
      created_at: NOW,
    });
    storage.version_insert({
      document_id: doc2.id,
      repo_id: repo.id,
      prev_id: null,
      path: "two.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "content about pricing and fees",
      author_id: user.id,
      created_at: LATER,
    });
    const hits = storage.fts_search([repo.id], "welcome OR pricing");
    expect(hits).toHaveLength(2);
  });

  it("porter-stemmed English — plurals + verb forms match root", () => {
    const doc = storage.documents_create(repo.id);
    storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: null,
      path: "x.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "the running dogs jumped over fences",
      author_id: user.id,
      created_at: NOW,
    });
    // porter stemmer maps "runs", "running", "run" all to "run"
    expect(storage.fts_search([repo.id], "run")).toHaveLength(1);
    expect(storage.fts_search([repo.id], "dog")).toHaveLength(1);
  });
});

describe("fts_index (no-op in SQLite)", () => {
  it("callable but does nothing (triggers handle it)", () => {
    expect(() => storage.fts_index(9999, "arbitrary body")).not.toThrow();
  });
});
