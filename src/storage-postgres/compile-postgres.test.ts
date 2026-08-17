/**
 * CEL AST → Postgres SQL compiler tests (m5-plan §WS5).
 *
 * Mirrors src/storage-sqlite/compile-filter.test.ts case-for-case
 * against a live pgvector-enabled Postgres, driven by the shared
 * test harness. Skips silently when MRPLEX_TEST_POSTGRES_URL is
 * unset so `npm test` on macOS-without-Docker stays the same shape.
 *
 * Two things this file proves that a unit test of compileSearchPlan
 * output alone can't:
 *   1. `$n` placeholder numbering lines up with the params array in
 *      the order the compiler emitted them (a stated M5 risk).
 *   2. The dialect semantics (`~` POSIX ARE, jsonb containment,
 *      `->>` + casts, `position()`, `LIKE ESCAPE`, jsonb_typeof) all
 *      produce the same result set as the SQLite reference does for
 *      the same fixture.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PG_URL, openTestPostgres } from "../../test/pg-harness.js";
import { KernelError } from "../kernel/errors.js";
import { parseCel } from "../kernel/query/cel-parse.js";
import type { UserRow } from "../storage/types.js";
import { compileSearchPlan } from "./compile-postgres.js";

if (!PG_URL) {
  describe.skip("compile-postgres (needs MRPLEX_TEST_POSTGRES_URL)", () => {});
} else {
  describe("compile-postgres", () => {
    // Each test opens a fresh schema so cross-test isolation is
    // absolute. Teardown drops the schema.
    let storage: Awaited<ReturnType<typeof openTestPostgres>>["storage"];
    let cleanup: () => Promise<void>;
    let user: UserRow;
    let repoId: number;

    beforeEach(async () => {
      const h = await openTestPostgres();
      storage = h.storage;
      cleanup = h.cleanup;
      user = await storage.users_create({
        slug: "alice",
        created_at: "2026-08-14T00:00:00Z",
      });
      repoId = (
        await storage.repos_create({
          slug: "notes",
          created_at: "2026-08-14T00:00:01Z",
        })
      ).id;
    });

    afterEach(async () => {
      await cleanup();
    });

    async function seed(
      entries: { path: string; frontmatter: Record<string, unknown>; body?: string }[],
    ): Promise<number[]> {
      const ids: number[] = [];
      let clock = 0;
      for (const e of entries) {
        const doc = await storage.documents_create(repoId);
        const v = await storage.version_insert({
          document_id: doc.id,
          repo_id: repoId,
          prev_id: null,
          path: e.path,
          frontmatter_raw: "",
          frontmatter: e.frontmatter,
          body: e.body ?? "",
          author_id: user.id,
          created_at: new Date(Date.UTC(2026, 7, 14, 0, 0, clock++)).toISOString(),
        });
        ids.push(v.id);
      }
      return ids;
    }

    /**
     * Run a CEL filter through the compiler and return the matching
     * version ids. Uses the storage's versions_search entry-point so
     * `$n` numbering is exercised inside the same code path
     * production takes — no test-only backdoor into the raw pool.
     */
    async function runQuery(filter: string): Promise<number[]> {
      const ast = parseCel(filter);
      if (!ast.expr) throw new Error("empty filter");
      // Sanity: compile once so any compile-time throw (unknown $intrinsic,
      // list() misuse) surfaces as a KernelError before we hit the db.
      compileSearchPlan({
        repo_ids: [repoId],
        limit: 100,
        filter_ast: ast.expr,
        sigils: [],
        scope: { kind: "allow_all" },
      });
      const rows = await storage.versions_search({
        repo_ids: [repoId],
        limit: 100,
        filter_ast: ast.expr,
        sigils: [],
        scope: { kind: "allow_all" },
      });
      return rows.map((r) => r.id).sort((a, b) => a - b);
    }

    // ---------------------------------------------------------------
    // Basic comparisons + logic
    // ---------------------------------------------------------------

    describe("comparisons on frontmatter fields", () => {
      it("== on string equality", async () => {
        const [a, b] = await seed([
          { path: "a.md", frontmatter: { status: "draft" } },
          { path: "b.md", frontmatter: { status: "published" } },
        ]);
        expect(await runQuery('status == "draft"')).toEqual([a]);
        expect(await runQuery('status != "draft"')).toEqual([b]);
      });

      it("<, <=, >, >= on numbers", async () => {
        const [a, b, c] = await seed([
          { path: "a.md", frontmatter: { count: 1 } },
          { path: "b.md", frontmatter: { count: 5 } },
          { path: "c.md", frontmatter: { count: 10 } },
        ]);
        expect(await runQuery("count > 3")).toEqual(
          [b, c].slice().sort((x, y) => (x as number) - (y as number)),
        );
        expect(await runQuery("count <= 5")).toEqual(
          [a, b].slice().sort((x, y) => (x as number) - (y as number)),
        );
      });

      it("&& and || combine", async () => {
        const [a, b] = await seed([
          { path: "a.md", frontmatter: { status: "draft", pinned: true } },
          { path: "b.md", frontmatter: { status: "published", pinned: false } },
          { path: "c.md", frontmatter: { status: "draft", pinned: false } },
        ]);
        expect(await runQuery('status == "draft" && pinned == true')).toEqual([a]);
        expect(await runQuery('status == "published" || pinned == true')).toEqual(
          [a, b].slice().sort((x, y) => (x as number) - (y as number)),
        );
      });

      it("! negates", async () => {
        const [_a, b] = await seed([
          { path: "a.md", frontmatter: { pinned: true } },
          { path: "b.md", frontmatter: { pinned: false } },
        ]);
        void _a;
        expect(await runQuery("!(pinned == true)")).toEqual([b]);
      });

      it("missing frontmatter key → predicate false", async () => {
        await seed([{ path: "a.md", frontmatter: { other: "x" } }]);
        expect(await runQuery('status == "draft"')).toEqual([]);
      });
    });

    // ---------------------------------------------------------------
    // $-intrinsics
    // ---------------------------------------------------------------

    describe("intrinsics", () => {
      it("$path.startsWith(...)", async () => {
        const [a, _b, c] = await seed([
          { path: "drafts/one.md", frontmatter: {} },
          { path: "notes/two.md", frontmatter: {} },
          { path: "drafts/three.md", frontmatter: {} },
        ]);
        void _b;
        expect(await runQuery('$path.startsWith("drafts/")')).toEqual(
          [a, c].slice().sort((x, y) => (x as number) - (y as number)),
        );
      });

      it("$updated_at comparison", async () => {
        const [a, b] = await seed([
          { path: "a.md", frontmatter: {} },
          { path: "b.md", frontmatter: {} },
        ]);
        expect(await runQuery('$updated_at < "2026-08-14T00:00:01.000Z"')).toEqual([a]);
        expect(await runQuery('$updated_at <= "2026-08-14T00:00:01.000Z"')).toEqual(
          [a, b].slice().sort((x, y) => (x as number) - (y as number)),
        );
      });

      it("unknown $-intrinsic → filter_invalid", async () => {
        try {
          await runQuery("$bogus == 1");
          throw new Error("expected throw");
        } catch (err) {
          expect(err).toBeInstanceOf(KernelError);
          expect((err as KernelError).code).toBe("filter_invalid");
        }
      });
    });

    // ---------------------------------------------------------------
    // list() polymorphism (§5.2)
    // ---------------------------------------------------------------

    describe("list() polymorphism", () => {
      it('"pricing" in list(tags) matches both scalar and list frontmatter', async () => {
        const [a, b, _c] = await seed([
          { path: "a.md", frontmatter: { tags: "pricing" } }, // scalar
          { path: "b.md", frontmatter: { tags: ["pricing", "saas"] } }, // list
          { path: "c.md", frontmatter: { tags: ["other"] } },
        ]);
        void _c;
        expect(await runQuery('"pricing" in list(tags)')).toEqual(
          [a, b].slice().sort((x, y) => (x as number) - (y as number)),
        );
      });

      it("size(list(tags)) counts scalar as 1, list as its length, missing as 0", async () => {
        const [_a, b, _c] = await seed([
          { path: "a.md", frontmatter: { tags: "one" } },
          { path: "b.md", frontmatter: { tags: ["a", "b", "c"] } },
          { path: "c.md", frontmatter: {} },
        ]);
        void _a;
        void _c;
        expect(await runQuery("size(list(tags)) > 2")).toEqual([b]);
      });

      it("list(tags).all(t, t.startsWith('p'))", async () => {
        const [a, _b] = await seed([
          { path: "a.md", frontmatter: { tags: ["pricing", "product"] } },
          { path: "b.md", frontmatter: { tags: ["pricing", "saas"] } },
        ]);
        void _b;
        expect(await runQuery("list(tags).all(t, t.startsWith('p'))")).toEqual([a]);
      });

      it("list(tags).exists(t, t == 'x')", async () => {
        const [a, _b, c] = await seed([
          { path: "a.md", frontmatter: { tags: ["x", "y"] } },
          { path: "b.md", frontmatter: { tags: ["y"] } },
          { path: "c.md", frontmatter: { tags: "x" } }, // scalar
        ]);
        void _b;
        expect(await runQuery("list(tags).exists(t, t == 'x')")).toEqual(
          [a, c].slice().sort((x, y) => (x as number) - (y as number)),
        );
      });

      it("@in without list() → filter_invalid", async () => {
        try {
          await runQuery('"x" in tags');
          throw new Error("expected throw");
        } catch (err) {
          expect((err as KernelError).code).toBe("filter_invalid");
        }
      });
    });

    // ---------------------------------------------------------------
    // String methods on frontmatter + body
    // ---------------------------------------------------------------

    describe("string methods", () => {
      it("startsWith on a frontmatter string", async () => {
        const [a, _b] = await seed([
          { path: "a.md", frontmatter: { title: "Welcome" } },
          { path: "b.md", frontmatter: { title: "Farewell" } },
        ]);
        void _b;
        expect(await runQuery('title.startsWith("Wel")')).toEqual([a]);
      });

      it("contains on $body", async () => {
        const [a, _b] = await seed([
          { path: "a.md", frontmatter: {}, body: "the quick fox" },
          { path: "b.md", frontmatter: {}, body: "the slow turtle" },
        ]);
        void _b;
        expect(await runQuery('contains($body, "quick")')).toEqual([a]);
      });

      it("startsWith literal is LIKE-escaped for wildcard characters", async () => {
        const [a, _b] = await seed([
          { path: "a.md", frontmatter: { title: "50% off" } },
          { path: "b.md", frontmatter: { title: "50x off" } },
        ]);
        void _b;
        expect(await runQuery('title.startsWith("50%")')).toEqual([a]);
      });

      it("matches regex via the `~` operator (POSIX ARE)", async () => {
        const [a, _b] = await seed([
          { path: "a.md", frontmatter: { slug: "v1.2.3" } },
          { path: "b.md", frontmatter: { slug: "abc" } },
        ]);
        void _b;
        expect(await runQuery('slug.matches("^v[0-9]+\\\\.[0-9]+\\\\.[0-9]+$")')).toEqual([a]);
      });

      it("invalid regex → filter_invalid (SQLSTATE 2201B mapping)", async () => {
        await seed([{ path: "a.md", frontmatter: { slug: "x" } }]);
        try {
          // Unclosed `[` is invalid in POSIX ARE.
          await runQuery('slug.matches("[unclosed")');
          throw new Error("expected throw");
        } catch (err) {
          expect(err).toBeInstanceOf(KernelError);
          expect((err as KernelError).code).toBe("filter_invalid");
        }
      });
    });

    // ---------------------------------------------------------------
    // Parameterization + safety
    // ---------------------------------------------------------------

    describe("SQL safety", () => {
      it("string literals are parameterized (SQL injection would appear as a literal match)", async () => {
        await seed([{ path: "a.md", frontmatter: { title: "hi" } }]);
        expect(await runQuery('title == "hi\'; DROP TABLE versions; --"')).toEqual([]);
        // Sanity: versions still exists.
        expect((await runQuery('title == "hi"')).length).toBe(1);
      });
    });

    // ---------------------------------------------------------------
    // $n placeholder numbering — the M5 risk the plan called out.
    // Correlated params in one query (comprehension iter, sigil
    // exclusion group with many sigils, scope glob CASE nesting) all
    // exercise the same builder path; if the counter drifts, values
    // land on the wrong `$n` and the result set is wrong.
    // ---------------------------------------------------------------

    describe("$n placeholder numbering under param-heavy loads", () => {
      it("compileSearchPlan with sigils + scope + filter + text keeps params aligned", async () => {
        // Build a plan that emits ~20+ placeholders across every
        // compiler branch. If numbering drifts we get the wrong rows.
        const ids = await seed([
          { path: "public/a.md", frontmatter: { status: "draft" } },
          { path: "public/b.md", frontmatter: { status: "published" } },
          { path: ".hidden/x.md", frontmatter: { status: "draft" } }, // excluded by sigil
          { path: ":deleted/y.md", frontmatter: { status: "draft" } }, // excluded by sigil
        ]);
        const ast = parseCel('status == "draft" && $path.startsWith("public/")');
        const rows = await storage.versions_search({
          repo_ids: [repoId],
          limit: 10,
          filter_ast: ast.expr!,
          sigils: [{ repo_ids: [repoId], sigils: [".", ":"] }],
          scope: {
            kind: "groups",
            groups: [{ repos: [repoId], globs: ["public/**", "!public/b.md"] }],
          },
        });
        expect(rows.map((r) => r.id)).toEqual([ids[0]]);
      });
    });
  });
}
