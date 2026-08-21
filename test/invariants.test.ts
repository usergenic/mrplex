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
import type { RepoRow, Storage, VersionRow } from "../src/storage/types.js";

async function fresh(): Promise<Storage> {
  const path = join(tmpdir(), `mrplex-invariants-${Date.now()}-${Math.random()}.db`);
  return sqliteAdapter.open({ database: `sqlite:${path}` });
}

let storage: Storage;
let repo: RepoRow;

const NOW = "2026-08-13T00:00:00Z";
const LATER = "2026-08-13T00:00:01Z";
const LATER_STILL = "2026-08-13T00:00:02Z";

beforeEach(async () => {
  storage = await fresh();
  repo = await storage.repos_create({ slug: "notes", created_at: NOW });
});

afterEach(async () => {
  await storage.close();
});

describe("versions partial index: one current per document", () => {
  it("permits the first version (no other row exists for the document)", async () => {
    const doc = await storage.documents_create(repo.id);
    const v = await storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: null,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "hi\n",
      author: "alice",
      created_at: NOW,
    });
    expect(v.next_id).toBeNull();
  });

  it("advances the chain atomically: prev.next_id is set in the same tx", async () => {
    const doc = await storage.documents_create(repo.id);
    const v1 = await storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: null,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "one\n",
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
      body: "two\n",
      author: "alice",
      created_at: LATER,
    });
    // v1 should be reloaded with next_id = v2.id; v2 is current.
    const v1Now = await storage.version_by_id(v1.id);
    expect(v1Now?.next_id).toBe(v2.id);
    expect(v2.next_id).toBeNull();
    const current = await storage.version_current(repo.id, "hello.md");
    expect(current?.id).toBe(v2.id);
  });

  it("rejects a second version whose prev is stale (no longer current)", async () => {
    const doc = await storage.documents_create(repo.id);
    const v1 = await storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: null,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "one\n",
      author: "alice",
      created_at: NOW,
    });
    // First advance: valid.
    await storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: v1.id,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "two\n",
      author: "alice",
      created_at: LATER,
    });
    // Second advance using v1 (now stale) as prev must fail — v1 no longer
    // has next_id=NULL, so the temporary self-loop update finds no rows.
    await expect(
      storage.version_insert({
        document_id: doc.id,
        repo_id: repo.id,
        prev_id: v1.id,
        path: "hello.md",
        frontmatter_raw: "",
        frontmatter: {},
        body: "three\n",
        author: "alice",
        created_at: LATER_STILL,
      }),
    ).rejects.toThrow();
  });
});

describe("versions cross-document prev rejection", () => {
  it("refuses prev_id from a DIFFERENT document, even if it is current", async () => {
    const docA = await storage.documents_create(repo.id);
    const docB = await storage.documents_create(repo.id);
    const a1 = await storage.version_insert({
      document_id: docA.id,
      repo_id: repo.id,
      prev_id: null,
      path: "a.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "a\n",
      author: "alice",
      created_at: NOW,
    });
    // Passing docA's current version as prev while advancing docB must fail:
    // otherwise the update would advance docA's chain and mis-assign the new
    // version to docB.
    await expect(
      storage.version_insert({
        document_id: docB.id,
        repo_id: repo.id,
        prev_id: a1.id,
        path: "b.md",
        frontmatter_raw: "",
        frontmatter: {},
        body: "b\n",
        author: "alice",
        created_at: LATER,
      }),
    ).rejects.toThrow();
    // docA must still be intact: a1 is still current.
    expect((await storage.version_by_id(a1.id))?.next_id).toBeNull();
    expect((await storage.version_current(repo.id, "a.md"))?.id).toBe(a1.id);
  });
});

describe("versions partial index: one live doc per (repo, path)", () => {
  it("rejects a second live document at the same path in the same repo", async () => {
    const docA = await storage.documents_create(repo.id);
    const docB = await storage.documents_create(repo.id);
    await storage.version_insert({
      document_id: docA.id,
      repo_id: repo.id,
      prev_id: null,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "a\n",
      author: "alice",
      created_at: NOW,
    });
    await expect(
      storage.version_insert({
        document_id: docB.id,
        repo_id: repo.id,
        prev_id: null,
        path: "hello.md",
        frontmatter_raw: "",
        frontmatter: {},
        body: "b\n",
        author: "alice",
        created_at: LATER,
      }),
    ).rejects.toThrow();
  });

  it("permits the same path in a different repo", async () => {
    const otherRepo = await storage.repos_create({ slug: "other", created_at: NOW });
    const docA = await storage.documents_create(repo.id);
    const docB = await storage.documents_create(otherRepo.id);
    await storage.version_insert({
      document_id: docA.id,
      repo_id: repo.id,
      prev_id: null,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "a\n",
      author: "alice",
      created_at: NOW,
    });
    const b = await storage.version_insert({
      document_id: docB.id,
      repo_id: otherRepo.id,
      prev_id: null,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "b\n",
      author: "alice",
      created_at: LATER,
    });
    expect(b.next_id).toBeNull();
  });
});

describe("uniqueness: slugs are unique for repos", () => {
  it("rejects duplicate repo slug", async () => {
    await expect(storage.repos_create({ slug: "notes", created_at: NOW })).rejects.toThrow();
  });
});

describe("history walks the chain in order", () => {
  it("returns versions newest-first for a document with multiple versions", async () => {
    const doc = await storage.documents_create(repo.id);
    const v1 = await storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: null,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "one\n",
      author: "alice",
      created_at: "2026-08-13T00:00:00Z",
    });
    const v2 = await storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: v1.id,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "two\n",
      author: "alice",
      created_at: "2026-08-13T00:00:01Z",
    });
    const v3 = await storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: v2.id,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "three\n",
      author: "alice",
      created_at: "2026-08-13T00:00:02Z",
    });
    const history = await storage.version_history(doc.id);
    expect(history.map((v: VersionRow) => v.id)).toEqual([v3.id, v2.id, v1.id]);
  });

  it("orders by chain, not created_at (backdated edits stay chain-ordered)", async () => {
    // If two versions land with created_at going BACKWARDS in wall-clock,
    // history should still respect chain order (v3 → v2 → v1), not sort
    // by the timestamps.
    const doc = await storage.documents_create(repo.id);
    const v1 = await storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: null,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "one\n",
      author: "alice",
      created_at: "2026-08-13T00:00:10Z",
    });
    const v2 = await storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: v1.id,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "two\n",
      author: "alice",
      created_at: "2026-08-13T00:00:05Z", // BEFORE v1
    });
    const v3 = await storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: v2.id,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "three\n",
      author: "alice",
      created_at: "2026-08-13T00:00:07Z", // between them
    });
    const history = await storage.version_history(doc.id);
    // Chain order: current (v3) → v2 → v1, regardless of timestamps.
    expect(history.map((v: VersionRow) => v.id)).toEqual([v3.id, v2.id, v1.id]);
  });

  it("honors --before and --limit", async () => {
    const doc = await storage.documents_create(repo.id);
    const v1 = await storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: null,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "one\n",
      author: "alice",
      created_at: "2026-08-13T00:00:00Z",
    });
    const v2 = await storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: v1.id,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "two\n",
      author: "alice",
      created_at: "2026-08-13T00:00:01Z",
    });
    await storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: v2.id,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "three\n",
      author: "alice",
      created_at: "2026-08-13T00:00:02Z",
    });
    const filtered = await storage.version_history(doc.id, {
      before: "2026-08-13T00:00:02Z",
      limit: 1,
    });
    expect(filtered.map((v: VersionRow) => v.body)).toEqual(["two\n"]);
  });
});

describe("tx rollback on error leaves no half-state", () => {
  it("rolls back both the placeholder update and any partial insert on failure", async () => {
    const doc = await storage.documents_create(repo.id);
    const v1 = await storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: null,
      path: "hello.md",
      frontmatter_raw: "",
      frontmatter: {},
      body: "one\n",
      author: "alice",
      created_at: NOW,
    });
    // Force the second insert to fail by supplying an invalid repo_id (FK).
    await expect(
      storage.version_insert({
        document_id: doc.id,
        repo_id: 9_999_999,
        prev_id: v1.id,
        path: "hello.md",
        frontmatter_raw: "",
        frontmatter: {},
        body: "two\n",
        author: "alice",
        created_at: LATER,
      }),
    ).rejects.toThrow();
    // v1 must still be current — no self-loop leftover.
    const v1Reloaded = await storage.version_by_id(v1.id);
    expect(v1Reloaded?.next_id).toBeNull();
    const current = await storage.version_current(repo.id, "hello.md");
    expect(current?.id).toBe(v1.id);
  });
});

describe("nested tx via savepoint", () => {
  it("commits inner and outer together on success", async () => {
    await storage.tx(async () => {
      await storage.repos_create({ slug: "outer", created_at: NOW });
      await storage.tx(async () => {
        await storage.repos_create({ slug: "inner", created_at: NOW });
      });
    });
    expect(await storage.repos_by_slug("outer")).not.toBeNull();
    expect(await storage.repos_by_slug("inner")).not.toBeNull();
  });

  it("rolls back only the inner scope when the inner throws and is caught", async () => {
    await storage.tx(async () => {
      await storage.repos_create({ slug: "outer2", created_at: NOW });
      try {
        await storage.tx(async () => {
          await storage.repos_create({ slug: "inner2", created_at: NOW });
          throw new Error("boom");
        });
      } catch {
        // swallow
      }
    });
    expect(await storage.repos_by_slug("outer2")).not.toBeNull();
    expect(await storage.repos_by_slug("inner2")).toBeNull();
  });
});
