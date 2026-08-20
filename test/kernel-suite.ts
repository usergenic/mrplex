/**
 * Adapter-parameterized kernel test suite. Design §7.2.1 says adapter parity
 * is kept honest by a shared test suite that runs against every adapter —
 * this file *is* that suite. Under m5-plan WS1 both the factory `open` and
 * every storage/kernel call is async.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../src/kernel/auth/actor.js";
import { SYSTEM_ACTOR } from "../src/kernel/auth/actor.js";
import { KernelError } from "../src/kernel/errors.js";
import { type Kernel, createKernel } from "../src/kernel/kernel.js";
import { decodeVersionId } from "../src/kernel/version-id.js";
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

    // -----------------------------------------------------------------
    // WS7 parity additions — the seams M5 introduced deserve dedicated
    // cross-adapter coverage: writes, query/filter, portable-FTS, rank
    // (with deterministic stub vectors), scope, and the partial-index
    // race case.
    // -----------------------------------------------------------------

    async function aliceActor(): Promise<Actor> {
      const alice = await storage.users_by_slug("alice");
      if (!alice) throw new Error("alice not seeded");
      return { user_id: alice.id, admin: true, scopes: [] };
    }

    describe("docs.create / put / delete round-trip", () => {
      it("create + put + delete advances the chain and toggles current_path", async () => {
        const actor = await aliceActor();
        const v1 = await kernel.docs.create(actor, "notes", "greetings/hi.md", {
          frontmatter: { title: "Hi" },
          body: "one\n",
        });
        const v2 = await kernel.docs.put(actor, "notes", v1.version_id, "greetings/hi.md", {
          body: "two\n",
        });
        expect(v2.prev_version_id).toBe(v1.version_id);
        expect(v2.body).toBe("two\n");
        expect(v2.frontmatter).toEqual({ title: "Hi" }); // carried over
        const deleted = await kernel.docs.delete(actor, "notes", v2.version_id);
        expect(deleted.path).toMatch(/^:deleted\/greetings\/hi-v\d+\.md$/);
        // Live path no longer resolves.
        try {
          await kernel.docs.get(actor, "notes", "greetings/hi.md");
          throw new Error("expected throw");
        } catch (err) {
          expect((err as KernelError).code).toBe("doc_not_found");
        }
      });

      it("create at an occupied path → create_conflict", async () => {
        const actor = await aliceActor();
        await kernel.docs.create(actor, "notes", "dup.md", {
          frontmatter_raw: "",
          body: "a",
        });
        try {
          await kernel.docs.create(actor, "notes", "dup.md", {
            frontmatter_raw: "",
            body: "b",
          });
          throw new Error("expected throw");
        } catch (err) {
          expect((err as KernelError).code).toBe("create_conflict");
        }
      });

      it("put with a stale prev → stale_prev", async () => {
        const actor = await aliceActor();
        const v1 = await kernel.docs.create(actor, "notes", "stale.md", {
          frontmatter_raw: "",
          body: "one",
        });
        await kernel.docs.put(actor, "notes", v1.version_id, "stale.md", { body: "two" });
        try {
          await kernel.docs.put(actor, "notes", v1.version_id, "stale.md", { body: "three" });
          throw new Error("expected throw");
        } catch (err) {
          expect((err as KernelError).code).toBe("stale_prev");
        }
      });
    });

    describe("query — CEL filter", () => {
      it("filter over frontmatter with polymorphic list()", async () => {
        const actor = await aliceActor();
        await kernel.docs.create(actor, "notes", "one.md", {
          frontmatter: { status: "draft", tags: ["pricing"] },
          body: "a",
        });
        await kernel.docs.create(actor, "notes", "two.md", {
          frontmatter: { status: "draft", tags: "pricing" }, // scalar
          body: "b",
        });
        await kernel.docs.create(actor, "notes", "three.md", {
          frontmatter: { status: "published", tags: ["other"] },
          body: "c",
        });
        const rows = await kernel.query(actor, {
          repo: "notes",
          filter: 'status == "draft" && "pricing" in list(tags)',
        });
        expect(rows.map((r) => r.path).sort()).toEqual(["one.md", "two.md"]);
      });

      it("$path intrinsic", async () => {
        const actor = await aliceActor();
        await kernel.docs.create(actor, "notes", "drafts/x.md", {
          frontmatter_raw: "",
          body: "",
        });
        await kernel.docs.create(actor, "notes", "published/y.md", {
          frontmatter_raw: "",
          body: "",
        });
        const rows = await kernel.query(actor, {
          repo: "notes",
          filter: '$path.startsWith("drafts/")',
        });
        expect(rows.map((r) => r.path)).toEqual(["drafts/x.md"]);
      });

      it("missing frontmatter key → predicate false", async () => {
        const actor = await aliceActor();
        await kernel.docs.create(actor, "notes", "nokey.md", {
          frontmatter: { other: "x" },
          body: "",
        });
        const rows = await kernel.query(actor, {
          repo: "notes",
          filter: 'status == "draft"',
        });
        expect(rows).toEqual([]);
      });
    });

    describe("query — portable FTS subset", () => {
      // Both adapters agree on the two portable syntaxes: bare terms
      // and quoted phrases. Boolean operators / per-column filters
      // are engine-specific and covered in adapter-local tests.
      beforeEach(async () => {
        const actor = await aliceActor();
        await kernel.docs.create(actor, "notes", "a.md", {
          frontmatter_raw: "",
          body: "the quick brown fox jumps over the lazy dog",
        });
        await kernel.docs.create(actor, "notes", "b.md", {
          frontmatter_raw: "",
          body: "another note without the animal words",
        });
        await kernel.docs.create(actor, "notes", "c.md", {
          frontmatter_raw: "",
          body: "quick foxes are common in some parts",
        });
      });

      it("bare word matches any document containing that term", async () => {
        const actor = await aliceActor();
        const rows = await kernel.query(actor, { repo: "notes", text: "quick" });
        expect(rows.map((r) => r.path).sort()).toEqual(["a.md", "c.md"]);
      });

      it("quoted phrase matches only adjacent occurrences", async () => {
        const actor = await aliceActor();
        const rows = await kernel.query(actor, {
          repo: "notes",
          text: '"quick brown"',
        });
        expect(rows.map((r) => r.path)).toEqual(["a.md"]);
      });

      it("stem-neutral: fox / foxes both hit under both engines", async () => {
        const actor = await aliceActor();
        const rows = await kernel.query(actor, { repo: "notes", text: "fox" });
        // SQLite porter stems "foxes" → "fox"; PG english snowball
        // does the same. Any doc mentioning either form matches.
        expect(rows.map((r) => r.path).sort()).toEqual(["a.md", "c.md"]);
      });
    });

    describe("query — rank (deterministic stub vectors)", () => {
      it("orders results by cosine distance to the query vector", async () => {
        const actor = await aliceActor();
        // Create three docs whose vectors are the standard basis.
        const model = "test-3d";
        async function seedRankable(path: string, body: string, vec: readonly number[]) {
          const v = await kernel.docs.create(actor, "notes", path, {
            frontmatter_raw: "",
            body,
          });
          const id = decodeVersionId(v.version_id) as number;
          await storage.chunks_upsert(id, model, [
            {
              ix: 0,
              text: body,
              text_hash: `h_${path}`,
              model,
              embedding: vec,
            },
          ]);
          return id;
        }
        await seedRankable("x.md", "x-axis document", [1, 0, 0]);
        await seedRankable("y.md", "y-axis document", [0, 1, 0]);
        await seedRankable("z.md", "z-axis document", [0, 0, 1]);

        // Build a rank-enabled kernel that returns a fixed query vector
        // close to x.
        const rankKernel = createKernel({
          storage,
          queryEmbed: async () => ({ vector: [0.9, 0.1, 0], model, dim: 3 }),
        });
        const rows = await rankKernel.query(actor, { repo: "notes", rank: "close to x" });
        expect(rows.map((r) => r.path)).toEqual(["x.md", "y.md", "z.md"]);
      });

      it("rank without a hook → rank_unavailable", async () => {
        const actor = await aliceActor();
        try {
          await kernel.query(actor, { repo: "notes", rank: "anything" });
          throw new Error("expected throw");
        } catch (err) {
          expect(err).toBeInstanceOf(KernelError);
          expect((err as KernelError).code).toBe("rank_unavailable");
        }
      });
    });

    describe("query — scope (§8.2 silent drop)", () => {
      it("non-admin caller sees only rows their read globs cover", async () => {
        const admin = await aliceActor();
        await kernel.docs.create(admin, "notes", "public.md", { frontmatter_raw: "", body: "" });
        await kernel.docs.create(admin, "notes", "secret/hidden.md", {
          frontmatter_raw: "",
          body: "",
        });
        const repo = await storage.repos_by_slug("notes");
        if (!repo) throw new Error("notes not seeded");
        const scoped: Actor = {
          user_id: admin.user_id,
          admin: false,
          scopes: [{ repos: [repo.id], read: ["public.md"] }],
        };
        const rows = await kernel.query(scoped, { repo: "notes" });
        expect(rows.map((r) => r.path)).toEqual(["public.md"]);
      });

      it("no scopes at all → empty result (deny_all), never a 403", async () => {
        const admin = await aliceActor();
        await kernel.docs.create(admin, "notes", "any.md", { frontmatter_raw: "", body: "" });
        const empty: Actor = { user_id: admin.user_id, admin: false, scopes: [] };
        // Empty scopes → actorBindsRepo excludes notes entirely, so
        // targetRepos = [] and result = []. No forbidden thrown.
        const rows = await kernel.query(empty, { repo: "notes" });
        expect(rows).toEqual([]);
      });
    });

    describe("partial-index race (§3.2 invariants)", () => {
      it("versions_document_current_uidx: a second live version at the same document is rejected", async () => {
        const actor = await aliceActor();
        const v = await kernel.docs.create(actor, "notes", "race-doc.md", {
          frontmatter_raw: "",
          body: "",
        });
        const inserted = await storage.version_by_id(decodeVersionId(v.version_id) as number);
        if (!inserted) throw new Error("expected inserted version");
        // Direct storage-level insert bypassing the kernel: try to add
        // another live row for the same document. The partial unique
        // index must reject it.
        const alice = await storage.users_by_slug("alice");
        const notes = await storage.repos_by_slug("notes");
        if (!alice || !notes) throw new Error("expected seeded fixtures");
        await expect(
          storage.version_insert({
            document_id: inserted.document_id,
            repo_id: notes.id,
            prev_id: null,
            path: "race-doc.md",
            frontmatter_raw: "",
            frontmatter: {},
            body: "b",
            author_id: alice.id,
            created_at: T(200),
          }),
        ).rejects.toThrow();
      });

      it("versions_repo_path_current_uidx: two live documents at the same (repo, path) rejected", async () => {
        const alice = await storage.users_by_slug("alice");
        const notes = await storage.repos_by_slug("notes");
        if (!alice || !notes) throw new Error("expected seeded fixtures");
        const docA = await storage.documents_create(notes.id);
        const docB = await storage.documents_create(notes.id);
        await storage.version_insert({
          document_id: docA.id,
          repo_id: notes.id,
          prev_id: null,
          path: "collide.md",
          frontmatter_raw: "",
          frontmatter: {},
          body: "a",
          author_id: alice.id,
          created_at: T(210),
        });
        await expect(
          storage.version_insert({
            document_id: docB.id,
            repo_id: notes.id,
            prev_id: null,
            path: "collide.md",
            frontmatter_raw: "",
            frontmatter: {},
            body: "b",
            author_id: alice.id,
            created_at: T(211),
          }),
        ).rejects.toThrow();
      });
    });

    // -----------------------------------------------------------------
    // Case & Unicode folding — case-insensitive, NFC-normalized identity
    // with case-preserving storage (design §3.5.1; case-folding-plan.md).
    // -----------------------------------------------------------------
    describe("case & unicode folding", () => {
      it("path identity is case-insensitive — create at a folding-equal path conflicts", async () => {
        const actor = await aliceActor();
        await kernel.docs.create(actor, "notes", "Alice.md", { frontmatter_raw: "", body: "a" });
        try {
          await kernel.docs.create(actor, "notes", "alice.md", { frontmatter_raw: "", body: "b" });
          throw new Error("expected throw");
        } catch (err) {
          expect((err as KernelError).code).toBe("create_conflict");
        }
      });

      it("lookup folds the key but returns the stored (case-preserved) path", async () => {
        const actor = await aliceActor();
        await kernel.docs.create(actor, "notes", "People/Bob.md", {
          frontmatter_raw: "",
          body: "b",
        });
        const v = await kernel.docs.get(actor, "notes", "people/bob.MD");
        expect(v.path).toBe("People/Bob.md"); // stored case, not the folded key
      });

      it("NFC and NFD spellings of a path address the same document", async () => {
        const actor = await aliceActor();
        const nfc = "caf\u00e9.md"; // e + acute, composed (NFC)
        const nfd = "cafe\u0301.md"; // e + combining acute (NFD)
        await kernel.docs.create(actor, "notes", nfc, { frontmatter_raw: "", body: "x" });
        const v = await kernel.docs.get(actor, "notes", nfd);
        expect(v.path).toBe(nfc);
      });

      it("moving onto a folding-equal occupied path → path_taken", async () => {
        const actor = await aliceActor();
        await kernel.docs.create(actor, "notes", "Home.md", { frontmatter_raw: "", body: "h" });
        const other = await kernel.docs.create(actor, "notes", "other.md", {
          frontmatter_raw: "",
          body: "o",
        });
        try {
          await kernel.docs.put(actor, "notes", other.version_id, "home.md", { body: "o" });
          throw new Error("expected throw");
        } catch (err) {
          expect((err as KernelError).code).toBe("path_taken");
        }
      });

      it("recasing a document's own path is allowed (same identity)", async () => {
        const actor = await aliceActor();
        const v1 = await kernel.docs.create(actor, "notes", "recase.md", {
          frontmatter_raw: "",
          body: "r",
        });
        const v2 = await kernel.docs.put(actor, "notes", v1.version_id, "Recase.md", { body: "r" });
        expect(v2.path).toBe("Recase.md");
        expect(v2.prev_version_id).toBe(v1.version_id);
      });

      it("deleting a document frees its folded path key for reuse", async () => {
        const actor = await aliceActor();
        const v = await kernel.docs.create(actor, "notes", "Reuse.md", {
          frontmatter_raw: "",
          body: "1",
        });
        await kernel.docs.delete(actor, "notes", v.version_id);
        // A differently-cased create at the freed key now succeeds.
        const again = await kernel.docs.create(actor, "notes", "reuse.md", {
          frontmatter_raw: "",
          body: "2",
        });
        expect(again.path).toBe("reuse.md");
      });

      it("repo slug identity is case-insensitive", async () => {
        try {
          await kernel.repos.create(SYSTEM_ACTOR, "Notes"); // "notes" seeded
          throw new Error("expected throw");
        } catch (err) {
          expect((err as KernelError).code).toBe("slug_taken");
        }
      });

      it("repo lookup folds the key but returns the stored slug", async () => {
        const repo = await kernel.repos.get(SYSTEM_ACTOR, "NOTES");
        expect(repo.repo).toBe("notes");
      });

      it("recasing a repo slug is allowed (same identity)", async () => {
        const renamed = await kernel.repos.rename(SYSTEM_ACTOR, "notes", "Notes");
        expect(renamed.repo).toBe("Notes");
      });

      it("user slug identity is case-insensitive", async () => {
        try {
          await kernel.users.create(SYSTEM_ACTOR, "Alice"); // "alice" seeded
          throw new Error("expected throw");
        } catch (err) {
          expect((err as KernelError).code).toBe("slug_taken");
        }
      });
    });
  });
}
