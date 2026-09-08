/**
 * Verify scan surface (docs/verify-plan.md §4) — direct adapter tests, parity
 * across SQLite and (when MRPLEX_TEST_POSTGRES_URL is set) Postgres. These pin
 * the read-only storage contract the verify check families (WS3) build on:
 * versions_all / documents_all / chunks_all_version_ids /
 * backlog_all_version_ids, plus the SQLite-only VerifyFtsScans capability.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sqliteAdapter } from "../src/storage-sqlite/adapter.js";
import { type Storage, hasVerifyFtsScans } from "../src/storage/types.js";
import { PG_URL, openTestPostgres } from "./pg-harness.js";

type Factory = {
  name: string;
  open: () => Promise<{ storage: Storage; cleanup?: () => Promise<void> }>;
};

// Each SQLite factory tracks its file path so a corruption test can open a
// second raw handle and mutate fts_docs behind the adapter's back (WAL lets a
// second connection see committed rows). Keyed per-open so parallel tests don't
// collide.
const sqlitePaths = new Map<Storage, string>();

const factories: Factory[] = [
  {
    name: "sqlite",
    open: async () => {
      const path = join(tmpdir(), `mrplex-verify-scans-${Date.now()}-${Math.random()}.db`);
      const storage = await sqliteAdapter.open({ database: `sqlite:${path}` });
      sqlitePaths.set(storage, path);
      return { storage };
    },
  },
];

if (PG_URL) {
  factories.push({
    name: "postgres",
    open: async () => {
      const { storage, cleanup } = await openTestPostgres();
      return { storage, cleanup };
    },
  });
}

const T = (sec: number): string => new Date(Date.UTC(2026, 7, 14, 0, 0, sec)).toISOString();

/** Insert a fresh document + one version; return {docId, versionId}. */
async function seedDoc(
  storage: Storage,
  repoId: number,
  path: string,
  body: string,
): Promise<{ docId: number; versionId: number }> {
  const doc = await storage.documents_create(repoId);
  const v = await storage.version_insert({
    document_id: doc.id,
    repo_id: repoId,
    prev_id: null,
    path,
    frontmatter_raw: "",
    frontmatter: {},
    body,
    author: "alice",
    created_at: T(1),
  });
  return { docId: doc.id, versionId: v.id };
}

for (const factory of factories) {
  describe(`verify scans [${factory.name}]`, () => {
    let storage: Storage;
    let cleanup: (() => Promise<void>) | undefined;
    let repoId: number;
    let otherRepoId: number;

    beforeEach(async () => {
      const opened = await factory.open();
      storage = opened.storage;
      cleanup = opened.cleanup;
      repoId = (await storage.repos_create({ slug: "notes", created_at: T(0) })).id;
      otherRepoId = (await storage.repos_create({ slug: "other", created_at: T(0) })).id;
    });

    afterEach(async () => {
      if (cleanup) await cleanup();
      else await storage.close();
    });

    describe("versions_all", () => {
      it("returns all versions (live and superseded) in id order", async () => {
        const doc = await storage.documents_create(repoId);
        const v1 = await storage.version_insert({
          document_id: doc.id,
          repo_id: repoId,
          prev_id: null,
          path: "a.md",
          frontmatter_raw: "",
          frontmatter: {},
          body: "one\n",
          author: "alice",
          created_at: T(1),
        });
        const v2 = await storage.version_insert({
          document_id: doc.id,
          repo_id: repoId,
          prev_id: v1.id,
          path: "a.md",
          frontmatter_raw: "",
          frontmatter: {},
          body: "two\n",
          author: "alice",
          created_at: T(2),
        });
        const rows = await storage.versions_all({ after_id: 0, limit: 100 });
        // Both the superseded v1 and the live v2 come back.
        expect(rows.map((r) => r.id)).toEqual([v1.id, v2.id]);
      });

      it("keyset-paginates by id", async () => {
        const a = await seedDoc(storage, repoId, "a.md", "a");
        const b = await seedDoc(storage, repoId, "b.md", "b");
        const c = await seedDoc(storage, repoId, "c.md", "c");
        const page1 = await storage.versions_all({ after_id: 0, limit: 2 });
        expect(page1.map((r) => r.id)).toEqual([a.versionId, b.versionId]);
        const page2 = await storage.versions_all({ after_id: page1[1]!.id, limit: 2 });
        expect(page2.map((r) => r.id)).toEqual([c.versionId]);
      });

      it("scopes to repo_id when given", async () => {
        await seedDoc(storage, repoId, "a.md", "a");
        const other = await seedDoc(storage, otherRepoId, "x.md", "x");
        const rows = await storage.versions_all({ repo_id: otherRepoId, after_id: 0, limit: 100 });
        expect(rows.map((r) => r.id)).toEqual([other.versionId]);
      });
    });

    describe("documents_all", () => {
      it("returns document rows in id order, optionally scoped", async () => {
        const a = await seedDoc(storage, repoId, "a.md", "a");
        const b = await seedDoc(storage, repoId, "b.md", "b");
        const other = await seedDoc(storage, otherRepoId, "x.md", "x");

        const all = await storage.documents_all({ after_id: 0, limit: 100 });
        expect(all.map((d) => d.id)).toEqual([a.docId, b.docId, other.docId]);

        const scoped = await storage.documents_all({
          repo_id: repoId,
          after_id: 0,
          limit: 100,
        });
        expect(scoped.map((d) => d.id)).toEqual([a.docId, b.docId]);
      });

      it("includes a document with zero versions (orphan)", async () => {
        const orphan = await storage.documents_create(repoId);
        const rows = await storage.documents_all({ after_id: 0, limit: 100 });
        expect(rows.map((d) => d.id)).toContain(orphan.id);
      });
    });

    describe("chunks_all_version_ids / backlog_all_version_ids", () => {
      it("returns distinct version ids present in each table, keyset by id", async () => {
        const a = await seedDoc(storage, repoId, "a.md", "a");
        const b = await seedDoc(storage, repoId, "b.md", "b");

        await storage.chunks_upsert(a.versionId, "m", [
          { ix: 0, text: "a0", text_hash: "h0", model: "m", embedding: [1, 0] },
          { ix: 1, text: "a1", text_hash: "h1", model: "m", embedding: [0, 1] },
        ]);
        await storage.backlog_enqueue(b.versionId);

        const chunkIds = await storage.chunks_all_version_ids({ after_id: 0, limit: 100 });
        expect(chunkIds).toEqual([a.versionId]); // distinct — two chunks collapse to one id

        const backlogIds = await storage.backlog_all_version_ids({ after_id: 0, limit: 100 });
        expect(backlogIds).toEqual([b.versionId]);
      });

      it("returns empty arrays when the tables are empty", async () => {
        expect(await storage.chunks_all_version_ids({ after_id: 0, limit: 100 })).toEqual([]);
        expect(await storage.backlog_all_version_ids({ after_id: 0, limit: 100 })).toEqual([]);
      });
    });

    describe("VerifyFtsScans capability", () => {
      it("is present on SQLite and absent on Postgres", () => {
        expect(hasVerifyFtsScans(storage)).toBe(factory.name === "sqlite");
      });

      it("reports no missing/orphan rowids on a healthy SQLite store", async () => {
        if (!hasVerifyFtsScans(storage)) return;
        await seedDoc(storage, repoId, "a.md", "a");
        await seedDoc(storage, repoId, "b.md", "b");
        expect(await storage.fts_missing_rowids({ after_id: 0, limit: 100 })).toEqual([]);
        expect(await storage.fts_orphan_rowids({ after_id: 0, limit: 100 })).toEqual([]);
      });

      it("detects a missing rowid (a version with no fts_docs row)", async () => {
        if (!hasVerifyFtsScans(storage)) return;
        const a = await seedDoc(storage, repoId, "a.md", "a");
        // Simulate a trigger that didn't fire: delete this version's fts row via
        // a second raw handle. external-content FTS5 delete uses the special
        // 'delete' command with the OLD body.
        const path = sqlitePaths.get(storage) as string;
        const raw = new Database(path);
        raw
          .prepare("insert into fts_docs(fts_docs, rowid, body) values('delete', ?, ?)")
          .run(a.versionId, "a");
        raw.close();
        expect(await storage.fts_missing_rowids({ after_id: 0, limit: 100 })).toEqual([
          a.versionId,
        ]);
        expect(await storage.fts_orphan_rowids({ after_id: 0, limit: 100 })).toEqual([]);
      });

      it("detects an orphan rowid (an fts_docs row with no version)", async () => {
        if (!hasVerifyFtsScans(storage)) return;
        await seedDoc(storage, repoId, "a.md", "a");
        const path = sqlitePaths.get(storage) as string;
        const raw = new Database(path);
        // Insert an fts row for a rowid that no version claims.
        raw.prepare("insert into fts_docs(rowid, body) values (?, ?)").run(9999, "ghost");
        raw.close();
        expect(await storage.fts_orphan_rowids({ after_id: 0, limit: 100 })).toEqual([9999]);
        expect(await storage.fts_missing_rowids({ after_id: 0, limit: 100 })).toEqual([]);
      });
    });
  });
}
