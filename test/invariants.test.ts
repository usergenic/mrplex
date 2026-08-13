/**
 * Adapter-level invariant tests. These prove that the two partial unique
 * indexes from design §3.2 are load-bearing — that no application-level check
 * is what enforces "one current version per document" and "one live document
 * per (repo, path)".
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sqliteAdapter } from "../src/storage-sqlite/adapter.js";
import type { RepoRow, Storage, UserRow, VersionRow } from "../src/storage/types.js";

function fresh(): Storage {
  const path = join(tmpdir(), `mrplex-invariants-${Date.now()}-${Math.random()}.db`);
  return sqliteAdapter.open({ database: `sqlite:${path}` });
}

let storage: Storage;
let user: UserRow;
let repo: RepoRow;

const NOW = "2026-08-13T00:00:00Z";
const LATER = "2026-08-13T00:00:01Z";
const LATER_STILL = "2026-08-13T00:00:02Z";

beforeEach(() => {
  storage = fresh();
  user = storage.users_create({ slug: "alice", created_at: NOW });
  repo = storage.repos_create({ slug: "notes", created_at: NOW });
});

afterEach(() => {
  storage.close();
});

describe("versions partial index: one current per document", () => {
  it("permits the first version (no other row exists for the document)", () => {
    const doc = storage.documents_create(repo.id);
    const v = storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: null,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "hi\n",
      author_id: user.id,
      created_at: NOW,
    });
    expect(v.next_id).toBeNull();
  });

  it("advances the chain atomically: prev.next_id is set in the same tx", () => {
    const doc = storage.documents_create(repo.id);
    const v1 = storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: null,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "one\n",
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
      body: "two\n",
      author_id: user.id,
      created_at: LATER,
    });
    // v1 should be reloaded with next_id = v2.id; v2 is current.
    const v1Now = storage.version_by_id(v1.id);
    expect(v1Now?.next_id).toBe(v2.id);
    expect(v2.next_id).toBeNull();
    const current = storage.version_current(repo.id, "hello.md");
    expect(current?.id).toBe(v2.id);
  });

  it("rejects a second version whose prev is stale (no longer current)", () => {
    const doc = storage.documents_create(repo.id);
    const v1 = storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: null,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "one\n",
      author_id: user.id,
      created_at: NOW,
    });
    // First advance: valid.
    storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: v1.id,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "two\n",
      author_id: user.id,
      created_at: LATER,
    });
    // Second advance using v1 (now stale) as prev must fail — v1 no longer
    // has next_id=NULL, so the temporary self-loop update finds no rows.
    expect(() =>
      storage.version_insert({
        document_id: doc.id,
        repo_id: repo.id,
        prev_id: v1.id,
        path: "hello.md",
        frontmatter_raw: "",
        frontmatter: {},
        body: "three\n",
        author_id: user.id,
        created_at: LATER_STILL,
      }),
    ).toThrow();
  });
});

describe("versions partial index: one live doc per (repo, path)", () => {
  it("rejects a second live document at the same path in the same repo", () => {
    const docA = storage.documents_create(repo.id);
    const docB = storage.documents_create(repo.id);
    storage.version_insert({
      document_id: docA.id,
      repo_id: repo.id,
      prev_id: null,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "a\n",
      author_id: user.id,
      created_at: NOW,
    });
    expect(() =>
      storage.version_insert({
        document_id: docB.id,
        repo_id: repo.id,
        prev_id: null,
        path: "hello.md",
        frontmatter_raw: "",
        frontmatter: {},
        body: "b\n",
        author_id: user.id,
        created_at: LATER,
      }),
    ).toThrow();
  });

  it("permits the same path in a different repo", () => {
    const otherRepo = storage.repos_create({ slug: "other", created_at: NOW });
    const docA = storage.documents_create(repo.id);
    const docB = storage.documents_create(otherRepo.id);
    storage.version_insert({
      document_id: docA.id,
      repo_id: repo.id,
      prev_id: null,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "a\n",
      author_id: user.id,
      created_at: NOW,
    });
    const b = storage.version_insert({
      document_id: docB.id,
      repo_id: otherRepo.id,
      prev_id: null,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "b\n",
      author_id: user.id,
      created_at: LATER,
    });
    expect(b.next_id).toBeNull();
  });
});

describe("uniqueness: slugs are unique for users and repos", () => {
  it("rejects duplicate user slug", () => {
    expect(() => storage.users_create({ slug: "alice", created_at: NOW })).toThrow();
  });

  it("rejects duplicate repo slug", () => {
    expect(() => storage.repos_create({ slug: "notes", created_at: NOW })).toThrow();
  });
});

describe("history walks the chain in order", () => {
  it("returns versions newest-first for a document with multiple versions", () => {
    const doc = storage.documents_create(repo.id);
    const v1 = storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: null,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "one\n",
      author_id: user.id,
      created_at: "2026-08-13T00:00:00Z",
    });
    const v2 = storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: v1.id,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "two\n",
      author_id: user.id,
      created_at: "2026-08-13T00:00:01Z",
    });
    const v3 = storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: v2.id,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "three\n",
      author_id: user.id,
      created_at: "2026-08-13T00:00:02Z",
    });
    const history = storage.version_history(doc.id);
    expect(history.map((v: VersionRow) => v.id)).toEqual([v3.id, v2.id, v1.id]);
  });

  it("honors --before and --limit", () => {
    const doc = storage.documents_create(repo.id);
    const v1 = storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: null,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "one\n",
      author_id: user.id,
      created_at: "2026-08-13T00:00:00Z",
    });
    const v2 = storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: v1.id,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "two\n",
      author_id: user.id,
      created_at: "2026-08-13T00:00:01Z",
    });
    storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: v2.id,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "three\n",
      author_id: user.id,
      created_at: "2026-08-13T00:00:02Z",
    });
    const filtered = storage.version_history(doc.id, {
      before: "2026-08-13T00:00:02Z",
      limit: 1,
    });
    expect(filtered.map((v: VersionRow) => v.body)).toEqual(["two\n"]);
  });
});

describe("tx rollback on error leaves no half-state", () => {
  it("rolls back both the placeholder update and any partial insert on failure", () => {
    const doc = storage.documents_create(repo.id);
    const v1 = storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: null,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "one\n",
      author_id: user.id,
      created_at: NOW,
    });
    // Force the second insert to fail by supplying an invalid author_id (FK).
    expect(() =>
      storage.version_insert({
        document_id: doc.id,
        repo_id: repo.id,
        prev_id: v1.id,
        path: "hello.md",
        frontmatter_raw: "",
        frontmatter: {},
        body: "two\n",
        author_id: 9_999_999,
        created_at: LATER,
      }),
    ).toThrow();
    // v1 must still be current — no self-loop leftover.
    const v1Reloaded = storage.version_by_id(v1.id);
    expect(v1Reloaded?.next_id).toBeNull();
    const current = storage.version_current(repo.id, "hello.md");
    expect(current?.id).toBe(v1.id);
  });
});

describe("nested tx via savepoint", () => {
  it("commits inner and outer together on success", () => {
    storage.tx(() => {
      storage.users_create({ slug: "outer", created_at: NOW });
      storage.tx(() => {
        storage.users_create({ slug: "inner", created_at: NOW });
      });
    });
    expect(storage.users_by_slug("outer")).not.toBeNull();
    expect(storage.users_by_slug("inner")).not.toBeNull();
  });

  it("rolls back only the inner scope when the inner throws and is caught", () => {
    storage.tx(() => {
      storage.users_create({ slug: "outer2", created_at: NOW });
      try {
        storage.tx(() => {
          storage.users_create({ slug: "inner2", created_at: NOW });
          throw new Error("boom");
        });
      } catch {
        // swallow
      }
    });
    expect(storage.users_by_slug("outer2")).not.toBeNull();
    expect(storage.users_by_slug("inner2")).toBeNull();
  });
});
