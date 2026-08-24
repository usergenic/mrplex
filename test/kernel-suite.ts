/**
 * Adapter-parameterized kernel test suite. Design §7.2.1 says adapter parity
 * is kept honest by a shared test suite that runs against every adapter —
 * this file *is* that suite. Under m5-plan WS1 both the factory `open` and
 * every storage/kernel call is async.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CallContext } from "../src/kernel/context.js";
import { KernelError } from "../src/kernel/errors.js";
import { type Kernel, createKernel } from "../src/kernel/kernel.js";
import { decodeVersionId } from "../src/kernel/version-id.js";
import type { Storage } from "../src/storage/types.js";

// Full-access context — empty context is full visibility with the default
// author (noauth plan §1). The suite's "root" caller.
const ROOT: CallContext = {};

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
        author: "alice",
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
        author: "alice",
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
        author: "alice",
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
        author: "alice",
        created_at: T(20),
      });
    });

    afterEach(async () => {
      if (teardown) await teardown();
      else await storage.close();
    });

    describe("repos.list", () => {
      it("hides system-namespaced repos by default", async () => {
        const repos = await kernel.repos.list(ROOT);
        expect(repos.map((r) => r.repo)).toEqual(["notes"]);
      });

      it("surfaces system-namespaced repos when include_system: true", async () => {
        const repos = await kernel.repos.list(ROOT, { include_system: true });
        expect(repos.map((r) => r.repo)).toEqual([":deleted-old", "notes"]);
      });
    });

    describe("repos.get", () => {
      it("returns the repo envelope", async () => {
        expect(await kernel.repos.get(ROOT, "notes")).toEqual({
          repo: "notes",
          path_config: null,
        });
      });

      it("throws repo_not_found for an unknown slug", async () => {
        try {
          await kernel.repos.get(ROOT, "nope");
          throw new Error("expected throw");
        } catch (err) {
          expect(err).toBeInstanceOf(KernelError);
          expect((err as KernelError).code).toBe("repo_not_found");
          expect((err as KernelError).data).toEqual({ slug: "nope" });
        }
      });
    });

    describe("docs.get", () => {
      it("returns the current version at a path with the full envelope", async () => {
        const v = await kernel.docs.get(ROOT, "notes", "welcome.md");
        expect(v.body).toBe("three\n");
        expect(v.next_version_id).toBeNull();
        expect(v.prev_version_id).toMatch(/^v\d+$/);
        expect(v.version_id).toMatch(/^v\d+$/);
        expect(v.repo).toBe("notes");
        expect(v.path).toBe("welcome.md");
        expect(v.frontmatter).toEqual({ title: "Welcome" });
        expect(v.frontmatter_raw).toBe("title: Welcome\n");
        expect(v.author).toBe("alice");
      });

      it("returns a document with empty frontmatter", async () => {
        const v = await kernel.docs.get(ROOT, "notes", "readme.md");
        expect(v.frontmatter).toEqual({});
        expect(v.frontmatter_raw).toBe("");
        expect(v.body).toBe("hello world\n");
      });

      it("throws doc_not_found for an unknown path", async () => {
        try {
          await kernel.docs.get(ROOT, "notes", "missing.md");
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
          await kernel.docs.get(ROOT, "nope", "welcome.md");
          throw new Error("expected throw");
        } catch (err) {
          expect((err as KernelError).code).toBe("repo_not_found");
        }
      });
    });

    describe("docs.get_version", () => {
      it("returns a historical version by id", async () => {
        const current = await kernel.docs.get(ROOT, "notes", "welcome.md");
        const prevId = current.prev_version_id;
        if (!prevId) throw new Error("expected prev version");
        const prev = await kernel.docs.get_version(ROOT, "notes", prevId);
        expect(prev.body).toBe("two\n");
        expect(prev.next_version_id).toBe(current.version_id);
      });

      it("throws version_not_found for a malformed id", async () => {
        try {
          await kernel.docs.get_version(ROOT, "notes", "not-a-version");
          throw new Error("expected throw");
        } catch (err) {
          expect((err as KernelError).code).toBe("version_not_found");
        }
      });

      it("throws version_not_found for an id in a different repo", async () => {
        const other = await storage.repos_create({ slug: "other", created_at: T(30) });
        const doc = await storage.documents_create(other.id);
        const v = await storage.version_insert({
          document_id: doc.id,
          repo_id: other.id,
          prev_id: null,
          path: "elsewhere.md",
          frontmatter_raw: "",
          frontmatter: {},
          body: "x\n",
          author: "alice",
          created_at: T(31),
        });
        try {
          await kernel.docs.get_version(ROOT, "notes", `v${v.id}`);
          throw new Error("expected throw");
        } catch (err) {
          expect((err as KernelError).code).toBe("version_not_found");
        }
      });
    });

    describe("docs.history", () => {
      it("returns all versions of a document newest-first", async () => {
        const history = await kernel.docs.history(ROOT, "notes", "welcome.md");
        expect(history.map((v) => v.body)).toEqual(["three\n", "two\n", "one\n"]);
      });

      it("honors --limit", async () => {
        const history = await kernel.docs.history(ROOT, "notes", "welcome.md", {
          limit: 2,
        });
        expect(history).toHaveLength(2);
        expect(history[0]?.body).toBe("three\n");
      });

      it("honors --before", async () => {
        const history = await kernel.docs.history(ROOT, "notes", "welcome.md", {
          before: T(12),
        });
        expect(history.map((v) => v.body)).toEqual(["two\n", "one\n"]);
      });

      it("throws doc_not_found when the path has no live document", async () => {
        try {
          await kernel.docs.history(ROOT, "notes", "missing.md");
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

    // Full-access context that stamps "alice" as the author on writes.
    async function aliceActor(): Promise<CallContext> {
      return { author: "alice" };
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
        expect(rows.map((r) => r.$path).sort()).toEqual(["one.md", "two.md"]);
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
        expect(rows.map((r) => r.$path)).toEqual(["drafts/x.md"]);
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
        expect(rows.map((r) => r.$path).sort()).toEqual(["a.md", "c.md"]);
      });

      it("quoted phrase matches only adjacent occurrences", async () => {
        const actor = await aliceActor();
        const rows = await kernel.query(actor, {
          repo: "notes",
          text: '"quick brown"',
        });
        expect(rows.map((r) => r.$path)).toEqual(["a.md"]);
      });

      it("stem-neutral: fox / foxes both hit under both engines", async () => {
        const actor = await aliceActor();
        const rows = await kernel.query(actor, { repo: "notes", text: "fox" });
        // SQLite porter stems "foxes" → "fox"; PG english snowball
        // does the same. Any doc mentioning either form matches.
        expect(rows.map((r) => r.$path).sort()).toEqual(["a.md", "c.md"]);
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
        expect(rows.map((r) => r.$path)).toEqual(["x.md", "y.md", "z.md"]);
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

    describe("query — scope claim (§8.2 silent drop)", () => {
      it("a read claim narrows results to the globs it covers", async () => {
        const admin = await aliceActor();
        await kernel.docs.create(admin, "notes", "public.md", { frontmatter_raw: "", body: "" });
        await kernel.docs.create(admin, "notes", "secret/hidden.md", {
          frontmatter_raw: "",
          body: "",
        });
        const scoped: CallContext = { scope: [{ repo: "notes", paths: ["public.md"] }] };
        const rows = await kernel.query(scoped, { repo: "notes" });
        expect(rows.map((r) => r.$path)).toEqual(["public.md"]);
      });

      it("an empty scope array → empty result (deny_all), never a 403", async () => {
        const admin = await aliceActor();
        await kernel.docs.create(admin, "notes", "any.md", { frontmatter_raw: "", body: "" });
        // No claim binds notes → targetRepos = [] and result = []. No throw.
        const rows = await kernel.query({ scope: [] }, { repo: "notes" });
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
        const notes = await storage.repos_by_slug("notes");
        if (!notes) throw new Error("expected seeded fixtures");
        await expect(
          storage.version_insert({
            document_id: inserted.document_id,
            repo_id: notes.id,
            prev_id: null,
            path: "race-doc.md",
            frontmatter_raw: "",
            frontmatter: {},
            body: "b",
            author: "alice",
            created_at: T(200),
          }),
        ).rejects.toThrow();
      });

      it("versions_repo_path_current_uidx: two live documents at the same (repo, path) rejected", async () => {
        const notes = await storage.repos_by_slug("notes");
        if (!notes) throw new Error("expected seeded fixtures");
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
          author: "alice",
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
            author: "alice",
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
          await kernel.repos.create(ROOT, "Notes"); // "notes" seeded
          throw new Error("expected throw");
        } catch (err) {
          expect((err as KernelError).code).toBe("slug_taken");
        }
      });

      it("repo lookup folds the key but returns the stored slug", async () => {
        const repo = await kernel.repos.get(ROOT, "NOTES");
        expect(repo.repo).toBe("notes");
      });

      it("recasing a repo slug is allowed (same identity)", async () => {
        const renamed = await kernel.repos.rename(ROOT, "notes", "Notes");
        expect(renamed.repo).toBe("Notes");
      });
    });

    // -----------------------------------------------------------------
    // Links — the derived graph index (design §11.2). These run on BOTH
    // adapters, so they're the Postgres-parity referee for extraction,
    // resolution, dangling rebind, moves, deletes, graph queries, and
    // repair. Deliberately broad (redundant with the SQLite-only link
    // test files) — parity is what this file exists to guarantee.
    // -----------------------------------------------------------------
    describe("links (graph index) — adapter parity", () => {
      const mk = async (
        actor: CallContext,
        path: string,
        body: string,
        frontmatter?: Record<string, unknown>,
      ) => {
        const fm = frontmatter ? { frontmatter } : { frontmatter_raw: "" };
        return kernel.docs.create(actor, "notes", path, { ...fm, body });
      };
      const paths = async (actor: CallContext, filter: string) =>
        (await kernel.query(actor, { repo: "notes", filter })).map((v) => v.$path).sort();

      it("extracts + resolves an inline link on write", async () => {
        const actor = await aliceActor();
        await mk(actor, "horses.md", "neigh");
        await mk(actor, "note.md", "see [h](horses.md)");
        expect(await paths(actor, '$has_static("horses.md")')).toEqual(["note.md"]);
        expect(await paths(actor, '$in_static("note.md")')).toEqual(["horses.md"]);
      });

      it("binds a dangling link when the target is created later", async () => {
        const actor = await aliceActor();
        await mk(actor, "note.md", "[f](future.md)");
        // Dangling: nobody is "in note's set" as a resolved target yet.
        expect(await paths(actor, '$in_static("note.md")')).toEqual([]);
        await mk(actor, "future.md", "arrived");
        expect(await paths(actor, '$in_static("note.md")')).toEqual(["future.md"]);
      });

      it("self-links are not indexed (no doc is in its own set / backlinks)", async () => {
        const actor = await aliceActor();
        await mk(actor, "self.md", "I link to [me](self.md) and [[self]]");
        // self.md is neither in its own set nor a backlink of itself.
        expect(await paths(actor, '$in_static("self.md")')).toEqual([]);
        expect(await paths(actor, "$backlinks_static().size() > 0")).not.toContain("self.md");
        expect(await paths(actor, "$links_static().size() == 0")).toContain("self.md");
      });

      it("a move keeps inbound edges resolved (identity-bound)", async () => {
        const actor = await aliceActor();
        const target = await mk(actor, "horses.md", "neigh");
        await mk(actor, "note.md", "[h](horses.md)");
        await kernel.docs.put(actor, "notes", target.version_id, "animals/horses.md", {});
        // note.md still references the (moved) target.
        expect(await paths(actor, '$has_static("horses.md")')).toEqual(["note.md"]);
      });

      it("delete clears the deleted doc's outbound edges", async () => {
        const actor = await aliceActor();
        await mk(actor, "a.md", "a");
        const note = await mk(actor, "note.md", "[a](a.md)");
        expect(await paths(actor, '$has_static("a.md")')).toEqual(["note.md"]);
        await kernel.docs.delete(actor, "notes", note.version_id);
        expect(await paths(actor, '$has_static("a.md")')).toEqual([]);
      });

      it("a source's inbound edge to a DELETED target is sigil-hidden from $has", async () => {
        // note.md links to a.md; deleting a.md moves it into the :deleted
        // namespace but leaves the inbound edge bound (identity). The edge
        // must not surface via $has_static("**") — the target is now
        // sigil-hidden, so the visible graph stays the readable graph.
        const actor = await aliceActor();
        const target = await mk(actor, "a.md", "a");
        await mk(actor, "note.md", "[a](a.md)");
        expect(await paths(actor, '$has_static("**")')).toContain("note.md");
        await kernel.docs.delete(actor, "notes", target.version_id);
        // The bound edge now points at a :deleted doc → excluded.
        expect(await paths(actor, '$has_static("**")')).not.toContain("note.md");
      });

      it("membership set algebra composes", async () => {
        const actor = await aliceActor();
        await mk(actor, "alice.md", "a");
        await mk(actor, "bob.md", "b");
        await mk(actor, "moc/all.md", "[[alice]] [[bob]]");
        await mk(actor, "moc/contractors.md", "[[bob]]");
        expect(
          await paths(actor, '$in_static("moc/all.md") && !$in_static("moc/contractors.md")'),
        ).toEqual(["alice.md"]);
      });

      it("$links_static().size() and orphan detection", async () => {
        const actor = await aliceActor();
        await mk(actor, "leaf.md", "no links");
        await mk(actor, "hub.md", "[l](leaf.md)");
        expect(await paths(actor, "$links_static().size() == 0")).toContain("leaf.md");
        // leaf.md is referenced; hub.md is an orphan (in nobody's set).
        expect(await paths(actor, '!$in_static("**")')).toContain("hub.md");
        expect(await paths(actor, '!$in_static("**")')).not.toContain("leaf.md");
      });

      it("$backlinks_static().exists(d, pred) predicates on the other doc", async () => {
        const actor = await aliceActor();
        await mk(actor, "cited.md", "c");
        await mk(actor, "draft.md", "[c](cited.md)", { status: "draft" });
        expect(await paths(actor, '$backlinks_static().exists(d, d.status == "draft")')).toEqual([
          "cited.md",
        ]);
      });

      it("dangling targets count for $has_static", async () => {
        const actor = await aliceActor();
        await mk(actor, "note.md", "[g](ghost.md)");
        expect(await paths(actor, '$has_static("ghost.md")')).toEqual(["note.md"]);
      });

      it("graph predicates respect read scope (visible = readable)", async () => {
        const admin = await aliceActor();
        await mk(admin, "public.md", "p");
        await mk(admin, "secret/moc.md", "[p](/public.md)");
        const scoped: CallContext = {
          scope: [{ repo: "notes", paths: ["**", "!secret/**"] }],
        };
        // Full-access caller sees public.md is referenced; the scoped caller
        // can't read the secret source, so the edge is invisible.
        expect(await paths(admin, '$in_static("**")')).toContain("public.md");
        expect(await paths(scoped, '$in_static("**")')).not.toContain("public.md");
      });

      it("bare names ship now (== _static in Phase 1)", async () => {
        const actor = await aliceActor();
        await mk(actor, "alice.md", "a");
        await mk(actor, "moc.md", "[[alice]]");
        const bare = (await kernel.query(actor, { repo: "notes", filter: '$in("moc.md")' })).map(
          (v) => v.$path,
        );
        expect(bare).toEqual(["alice.md"]);
      });

      it("only _dyn names are reserved (need Phase 2)", async () => {
        const actor = await aliceActor();
        await mk(actor, "x.md", "x");
        for (const filter of ['$in_dyn("x.md")', "$backlinks_dyn()"]) {
          try {
            await kernel.query(actor, { repo: "notes", filter });
            throw new Error(`expected throw for ${filter}`);
          } catch (err) {
            expect((err as KernelError).code).toBe("filter_invalid");
          }
        }
      });

      it("links.stale + repair round-trip", async () => {
        const actor = await aliceActor();
        const target = await mk(actor, "horses.md", "neigh");
        await mk(actor, "note.md", "see [h](horses.md)");
        await kernel.docs.put(actor, "notes", target.version_id, "animals/horses.md", {});

        const stale = await kernel.links.stale(actor, "notes");
        expect(stale.map((s) => s.source_path)).toEqual(["note.md"]);

        const res = await kernel.links.repair(actor, "notes");
        expect(res.repaired).toEqual([{ path: "note.md", edges: 1 }]);
        const note = await kernel.docs.get(actor, "notes", "note.md");
        expect(note.body).toContain("animals/horses.md");
        expect(await kernel.links.stale(actor, "notes")).toEqual([]);
      });

      it("backfill rebuilds the index consistently", async () => {
        const actor = await aliceActor();
        await mk(actor, "a.md", "a");
        await mk(actor, "note.md", "[a](a.md)");
        const report = await kernel.links.backfill(actor, "notes");
        expect(report.documents).toBeGreaterThanOrEqual(2);
        // Query still works after an explicit rebuild.
        expect(await paths(actor, '$has_static("a.md")')).toEqual(["note.md"]);
      });

      it("repos.set_link_config enables frontmatter-field extraction + re-extracts", async () => {
        const actor = await aliceActor();
        await mk(actor, "moc/employees.md", "team");
        await mk(actor, "alice.md", "hi", { parent: "moc/employees.md" });
        // Default config: no frontmatter fields → the parent edge isn't indexed.
        expect(await paths(actor, '$has_static("moc/employees.md", "parent")')).toEqual([]);

        // Opt into the `parent` field; the op re-extracts the whole repo.
        const res = await kernel.repos.set_link_config(actor, "notes", { fields: ["parent"] });
        expect(res.repo.repo).toBe("notes");
        expect(res.reindexed.documents).toBeGreaterThanOrEqual(2);

        // Now the field edge is queryable.
        expect(await paths(actor, '$has_static("moc/employees.md", "parent")')).toEqual([
          "alice.md",
        ]);

        // Clearing the override re-extracts back to defaults (edge gone).
        await kernel.repos.set_link_config(actor, "notes", null);
        expect(await paths(actor, '$has_static("moc/employees.md", "parent")')).toEqual([]);
      });

      it("repos.set_link_config rejects an invalid override", async () => {
        const actor = await aliceActor();
        try {
          await kernel.repos.set_link_config(actor, "notes", { fields: ["bad index[0]"] });
          throw new Error("expected throw");
        } catch (err) {
          expect((err as KernelError).code).toBe("link_config_invalid");
        }
      });
    });

    // -----------------------------------------------------------------
    // kernel.graph — the read surface (docs/graph-plan.md). Cross-cutting
    // cases lifted here so both adapters agree byte-for-byte. The
    // semantics-exhaustive suite lives in test/graph.test.ts (SQLite).
    // -----------------------------------------------------------------
    describe("graph (read surface) — adapter parity", () => {
      const mk = async (
        actor: CallContext,
        path: string,
        body: string,
        frontmatter?: Record<string, unknown>,
      ) => {
        const fm = frontmatter ? { frontmatter } : { frontmatter_raw: "" };
        return kernel.docs.create(actor, "notes", path, { ...fm, body });
      };
      const gpaths = async (
        actor: CallContext,
        spec: Omit<Parameters<Kernel["graph"]>[1], "repo">,
      ) => (await kernel.graph(actor, { repo: "notes", ...spec })).documents.map((d) => d.$path);

      it("out lens expands source→target transitively, degree-ordered", async () => {
        const actor = await aliceActor();
        await mk(actor, "leaf.md", "");
        await mk(actor, "mid.md", "[l](leaf.md)");
        await mk(actor, "root.md", "[m](mid.md)");
        expect(await gpaths(actor, { roots: "root.md", direction: "out", degrees: 2 })).toEqual([
          "root.md",
          "mid.md",
          "leaf.md",
        ]);
      });

      it("both lens surfaces a co-cited sibling at degrees 2", async () => {
        const actor = await aliceActor();
        await mk(actor, "shared.md", "");
        await mk(actor, "root.md", "[s](shared.md)");
        await mk(actor, "sibling.md", "[s](shared.md)");
        expect(await gpaths(actor, { roots: "root.md", direction: "both", degrees: 2 })).toEqual([
          "root.md",
          "shared.md",
          "sibling.md",
        ]);
      });

      it("$degrees binds as visibility and prunes deeper non-matches", async () => {
        const actor = await aliceActor();
        await mk(actor, "note.md", "", { type: "note" });
        await mk(actor, "p2.md", "[n](note.md)", { type: "person" });
        await mk(actor, "p1.md", "[p2](p2.md)", { type: "person" });
        await mk(actor, "root.md", "[p1](p1.md)");
        const r = await gpaths(actor, {
          roots: "root.md",
          direction: "out",
          degrees: 5,
          filter: '$degrees <= 1 || type == "person"',
        });
        expect(r).toEqual(["root.md", "p1.md", "p2.md"]);
      });

      it("induced links are distinct (source,target,field) over returned docs", async () => {
        const actor = await aliceActor();
        await mk(actor, "a.md", "");
        await mk(actor, "b.md", "[a](a.md)");
        await mk(actor, "root.md", "[b](b.md) and [a](a.md)");
        const r = await kernel.graph(actor, {
          repo: "notes",
          roots: "root.md",
          direction: "out",
          degrees: 2,
        });
        expect(r.links).toEqual([
          { source: "b.md", target: "a.md", field: "$body" },
          { source: "root.md", target: "a.md", field: "$body" },
          { source: "root.md", target: "b.md", field: "$body" },
        ]);
      });

      it("$links/$backlinks count distinct scope-visible documents", async () => {
        const actor = await aliceActor();
        await mk(actor, "a.md", "");
        await mk(actor, "b.md", "");
        await mk(actor, "hub.md", "[a](a.md) [b](b.md)");
        await mk(actor, "x.md", "[h](hub.md)");
        const r = await kernel.graph(actor, { repo: "notes", roots: "hub.md", degrees: 0 });
        expect(r.documents[0]?.$links).toBe(2);
        expect(r.documents[0]?.$backlinks).toBe(1);
      });

      it("scope hides an out-of-scope endpoint, its links, and shrinks counts", async () => {
        const actor = await aliceActor();
        await mk(actor, "secret.md", "");
        await mk(actor, "visible.md", "");
        await mk(actor, "root.md", "[s](secret.md) [v](visible.md)");
        const scoped: CallContext = { scope: [{ repo: "notes", paths: ["**", "!secret.md"] }] };
        const r = await kernel.graph(scoped, {
          repo: "notes",
          roots: "root.md",
          direction: "out",
          degrees: 1,
        });
        expect(r.documents.map((d) => d.$path)).toEqual(["root.md", "visible.md"]);
        expect(r.links).toEqual([{ source: "root.md", target: "visible.md", field: "$body" }]);
        expect(r.documents.find((d) => d.$path === "root.md")?.$links).toBe(1);
      });

      it("frontier lists a doc at the cap with unenumerated neighbors; a sated doc is not frontier", async () => {
        const actor = await aliceActor();
        await mk(actor, "leaf.md", "");
        await mk(actor, "mid.md", "[l](leaf.md)");
        await mk(actor, "root.md", "[m](mid.md)");
        await mk(actor, "sated.md", "");
        await mk(actor, "hub.md", "[s](sated.md)");
        const chained = await kernel.graph(actor, {
          repo: "notes",
          roots: "root.md",
          direction: "out",
          degrees: 1,
        });
        expect(chained.frontier).toEqual(["mid.md"]);
        const flat = await kernel.graph(actor, {
          repo: "notes",
          roots: "hub.md",
          direction: "out",
          degrees: 1,
        });
        expect(flat.frontier).toEqual([]);
      });

      it("is deterministic across repeated runs (byte-equal)", async () => {
        const actor = await aliceActor();
        await mk(actor, "a.md", "");
        await mk(actor, "b.md", "[a](a.md)");
        await mk(actor, "c.md", "[a](a.md) [b](b.md)");
        await mk(actor, "root.md", "[b](b.md) [c](c.md)");
        const spec = { repo: "notes", roots: "root.md", direction: "both" as const, degrees: 3 };
        const r1 = JSON.stringify(await kernel.graph(actor, spec));
        const r2 = JSON.stringify(await kernel.graph(actor, spec));
        expect(r1).toBe(r2);
      });
    });
  });
}
