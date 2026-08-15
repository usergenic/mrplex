/**
 * Adapter-parameterized kernel test suite. Design §7.2.1 says adapter parity
 * is kept honest by a shared test suite that runs against every adapter —
 * this file *is* that suite. Under m5-plan WS1 both the factory `open` and
 * every storage/kernel call is async.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SYSTEM_ACTOR } from "../src/kernel/auth/actor.js";
import { KernelError } from "../src/kernel/errors.js";
import { type Kernel, createKernel } from "../src/kernel/kernel.js";
import type { Storage } from "../src/storage/types.js";

export type AdapterFactory = {
  name: string;
  /**
   * Returns a live Storage plus an optional teardown that the suite
   * runs after each test. Teardown owns any per-test resources the
   * adapter allocates outside the Storage instance (e.g. the PG
   * harness drops its per-test schema here).
   */
  open: () => Promise<{ storage: Storage; teardown?: () => Promise<void> }>;
};

const T = (sec: number): string => new Date(Date.UTC(2026, 7, 13, 0, 0, sec)).toISOString();

export function runKernelSuite(factory: AdapterFactory): void {
  describe(`kernel [${factory.name}]`, () => {
    let storage: Storage;
    let kernel: Kernel;
    let teardown: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      const opened = await factory.open();
      storage = opened.storage;
      teardown = opened.teardown;
      kernel = createKernel(storage);

      const alice = await storage.users_create({ slug: "alice", created_at: T(0) });
      await storage.users_create({ slug: "bob", created_at: T(1) });
      const notes = await storage.repos_create({ slug: "notes", created_at: T(2) });
      await storage.repos_create({ slug: ":deleted-old", created_at: T(3) });

      // welcome.md — three versions
      const welcome = await storage.documents_create(notes.id);
      const w1 = await storage.version_insert({
        document_id: welcome.id,
        repo_id: notes.id,
        prev_id: null,
        path: "welcome.md",
        frontmatter_raw: "title: Welcome\n",
        frontmatter: { title: "Welcome" },
        body: "one\n",
        author_id: alice.id,
        created_at: T(10),
      });
      const w2 = await storage.version_insert({
        document_id: welcome.id,
        repo_id: notes.id,
        prev_id: w1.id,
        path: "welcome.md",
        frontmatter_raw: "title: Welcome\n",
        frontmatter: { title: "Welcome" },
        body: "two\n",
        author_id: alice.id,
        created_at: T(11),
      });
      await storage.version_insert({
        document_id: welcome.id,
        repo_id: notes.id,
        prev_id: w2.id,
        path: "welcome.md",
        frontmatter_raw: "title: Welcome\n",
        frontmatter: { title: "Welcome" },
        body: "three\n",
        author_id: alice.id,
        created_at: T(12),
      });

      // readme.md — one version, no frontmatter
      const readme = await storage.documents_create(notes.id);
      await storage.version_insert({
        document_id: readme.id,
        repo_id: notes.id,
        prev_id: null,
        path: "readme.md",
        frontmatter_raw: "",
        frontmatter: {},
        body: "hello world\n",
        author_id: alice.id,
        created_at: T(20),
      });
    });

    afterEach(async () => {
      if (teardown) await teardown();
      else await storage.close();
    });

    describe("repos.list", () => {
      it("hides system-namespaced repos by default", async () => {
        const repos = await kernel.repos.list(SYSTEM_ACTOR);
        expect(repos.map((r) => r.repo)).toEqual(["notes"]);
      });

      it("surfaces system-namespaced repos when include_system: true", async () => {
        const repos = await kernel.repos.list(SYSTEM_ACTOR, { include_system: true });
        expect(repos.map((r) => r.repo)).toEqual([":deleted-old", "notes"]);
      });
    });

    describe("repos.get", () => {
      it("returns the repo envelope", async () => {
        expect(await kernel.repos.get(SYSTEM_ACTOR, "notes")).toEqual({
          repo: "notes",
          path_config: null,
        });
      });

      it("throws repo_not_found for an unknown slug", async () => {
        try {
          await kernel.repos.get(SYSTEM_ACTOR, "nope");
          throw new Error("expected throw");
        } catch (err) {
          expect(err).toBeInstanceOf(KernelError);
          expect((err as KernelError).code).toBe("repo_not_found");
          expect((err as KernelError).data).toEqual({ slug: "nope" });
        }
      });
    });

    describe("users.list", () => {
      it("returns all users, ordered by slug", async () => {
        expect(await kernel.users.list(SYSTEM_ACTOR)).toEqual([{ user: "alice" }, { user: "bob" }]);
      });
    });

    describe("docs.get", () => {
      it("returns the current version at a path with the full envelope", async () => {
        const v = await kernel.docs.get(SYSTEM_ACTOR, "notes", "welcome.md");
        expect(v.body).toBe("three\n");
        expect(v.next_version_id).toBeNull();
        expect(v.prev_version_id).toMatch(/^v\d+$/);
        expect(v.version_id).toMatch(/^v\d+$/);
        expect(v.repo).toBe("notes");
        expect(v.path).toBe("welcome.md");
        expect(v.frontmatter).toEqual({ title: "Welcome" });
        expect(v.frontmatter_raw).toBe("title: Welcome\n");
        expect(v.author).toEqual({ user: "alice" });
      });

      it("returns a document with empty frontmatter", async () => {
        const v = await kernel.docs.get(SYSTEM_ACTOR, "notes", "readme.md");
        expect(v.frontmatter).toEqual({});
        expect(v.frontmatter_raw).toBe("");
        expect(v.body).toBe("hello world\n");
      });

      it("throws doc_not_found for an unknown path", async () => {
        try {
          await kernel.docs.get(SYSTEM_ACTOR, "notes", "missing.md");
          throw new Error("expected throw");
        } catch (err) {
          expect((err as KernelError).code).toBe("doc_not_found");
          expect((err as KernelError).data).toEqual({
            repo: "notes",
            path: "missing.md",
          });
        }
      });

      it("throws repo_not_found for an unknown repo", async () => {
        try {
          await kernel.docs.get(SYSTEM_ACTOR, "nope", "welcome.md");
          throw new Error("expected throw");
        } catch (err) {
          expect((err as KernelError).code).toBe("repo_not_found");
        }
      });
    });

    describe("docs.get_version", () => {
      it("returns a historical version by id", async () => {
        const current = await kernel.docs.get(SYSTEM_ACTOR, "notes", "welcome.md");
        const prevId = current.prev_version_id;
        if (!prevId) throw new Error("expected prev version");
        const prev = await kernel.docs.get_version(SYSTEM_ACTOR, "notes", prevId);
        expect(prev.body).toBe("two\n");
        expect(prev.next_version_id).toBe(current.version_id);
      });

      it("throws version_not_found for a malformed id", async () => {
        try {
          await kernel.docs.get_version(SYSTEM_ACTOR, "notes", "not-a-version");
          throw new Error("expected throw");
        } catch (err) {
          expect((err as KernelError).code).toBe("version_not_found");
        }
      });

      it("throws version_not_found for an id in a different repo", async () => {
        const other = await storage.repos_create({ slug: "other", created_at: T(30) });
        const doc = await storage.documents_create(other.id);
        const alice = await storage.users_by_slug("alice");
        if (!alice) throw new Error("expected alice");
        const v = await storage.version_insert({
          document_id: doc.id,
          repo_id: other.id,
          prev_id: null,
          path: "elsewhere.md",
          frontmatter_raw: "",
          frontmatter: {},
          body: "x\n",
          author_id: alice.id,
          created_at: T(31),
        });
        try {
          await kernel.docs.get_version(SYSTEM_ACTOR, "notes", `v${v.id}`);
          throw new Error("expected throw");
        } catch (err) {
          expect((err as KernelError).code).toBe("version_not_found");
        }
      });
    });

    describe("docs.history", () => {
      it("returns all versions of a document newest-first", async () => {
        const history = await kernel.docs.history(SYSTEM_ACTOR, "notes", "welcome.md");
        expect(history.map((v) => v.body)).toEqual(["three\n", "two\n", "one\n"]);
      });

      it("honors --limit", async () => {
        const history = await kernel.docs.history(SYSTEM_ACTOR, "notes", "welcome.md", {
          limit: 2,
        });
        expect(history).toHaveLength(2);
        expect(history[0]?.body).toBe("three\n");
      });

      it("honors --before", async () => {
        const history = await kernel.docs.history(SYSTEM_ACTOR, "notes", "welcome.md", {
          before: T(12),
        });
        expect(history.map((v) => v.body)).toEqual(["two\n", "one\n"]);
      });

      it("throws doc_not_found when the path has no live document", async () => {
        try {
          await kernel.docs.history(SYSTEM_ACTOR, "notes", "missing.md");
          throw new Error("expected throw");
        } catch (err) {
          expect((err as KernelError).code).toBe("doc_not_found");
        }
      });
    });
  });
}
