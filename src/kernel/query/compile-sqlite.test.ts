/**
 * CEL AST → SQLite SQL compiler tests. Compiles design examples and runs
 * the resulting SQL against a real SQLite database — that's what proves
 * both the SQL syntax AND the semantic mapping (json1 quirks, LIKE
 * escaping, list() polymorphism against mixed-shape frontmatter, etc.)
 * are correct end-to-end.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sqliteAdapter } from "../../storage-sqlite/adapter.js";
import type { Storage, UserRow } from "../../storage/types.js";
import { KernelError } from "../errors.js";
import { parseCel } from "./cel-parse.js";
import { compileFilter } from "./compile-sqlite.js";

let storage: Storage;
let user: UserRow;
let repoId: number;

function seed(
  entries: { path: string; frontmatter: Record<string, unknown>; body?: string }[],
): number[] {
  const ids: number[] = [];
  let clock = 0;
  for (const e of entries) {
    const doc = storage.documents_create(repoId);
    const v = storage.version_insert({
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

function runQuery(filter: string): number[] {
  const ast = parseCel(filter);
  const compiled = compileFilter(ast.expr!);
  // Get access to raw db via a small dance — we need the connection for
  // ad-hoc prepared statements. The Storage interface doesn't expose it,
  // but the SqliteStorage impl uses better-sqlite3; we invoke via a
  // versions query.
  //
  // Simpler: use the adapter's private db via a fresh raw prepare here.
  // The compileFilter tests validate the SQL against a REAL sqlite by
  // opening our own connection to the same db file. To avoid mixing
  // WAL-mode connections, we reuse `storage` and cheat by exec'ing SQL
  // through a workaround — actually the cleanest path is: expose the db
  // in test-only via Object.getOwnPropertyDescriptor... no. Just open a
  // second Database handle to the same file, WAL-mode is shared.
  return runOnFreshHandle(compiled.sql, compiled.params);
}

function runOnFreshHandle(where: string, params: unknown[]): number[] {
  // Use the adapter's own handle by reaching into it — test-only shortcut.
  // storage.__db is not part of the public interface; we cast to any here.
  // biome-ignore lint/suspicious/noExplicitAny: test-only backdoor
  const db = (storage as any).db as import("better-sqlite3").Database;
  const rows = db
    .prepare(
      `SELECT versions.id as id FROM versions
       WHERE versions.next_id IS NULL AND versions.repo_id = ? AND (${where})
       ORDER BY versions.id`,
    )
    .all(repoId, ...params) as { id: number }[];
  return rows.map((r) => r.id);
}

beforeEach(() => {
  storage = sqliteAdapter.open({
    database: `sqlite:${join(tmpdir(), `mrplex-compile-${Date.now()}-${Math.random()}.db`)}`,
  });
  user = storage.users_create({ slug: "alice", created_at: "2026-08-14T00:00:00Z" });
  repoId = storage.repos_create({ slug: "notes", created_at: "2026-08-14T00:00:01Z" }).id;
});

afterEach(() => {
  storage.close();
});

// -----------------------------------------------------------------------------
// Basic comparisons + logic
// -----------------------------------------------------------------------------

describe("comparisons on frontmatter fields", () => {
  it("== on string equality", () => {
    const [a, b] = seed([
      { path: "a.md", frontmatter: { status: "draft" } },
      { path: "b.md", frontmatter: { status: "published" } },
    ]);
    expect(runQuery('status == "draft"')).toEqual([a]);
    expect(runQuery('status != "draft"')).toEqual([b]);
  });

  it("<, <=, >, >= on numbers", () => {
    const [a, b, c] = seed([
      { path: "a.md", frontmatter: { count: 1 } },
      { path: "b.md", frontmatter: { count: 5 } },
      { path: "c.md", frontmatter: { count: 10 } },
    ]);
    expect(runQuery("count > 3")).toEqual([b, c]);
    expect(runQuery("count <= 5")).toEqual([a, b]);
  });

  it("&& and || combine", () => {
    const [a, b, c] = seed([
      { path: "a.md", frontmatter: { status: "draft", pinned: true } },
      { path: "b.md", frontmatter: { status: "published", pinned: false } },
      { path: "c.md", frontmatter: { status: "draft", pinned: false } },
    ]);
    expect(runQuery('status == "draft" && pinned == true')).toEqual([a]);
    expect(runQuery('status == "published" || pinned == true')).toEqual([a, b]);
  });

  it("! negates", () => {
    const [a, b] = seed([
      { path: "a.md", frontmatter: { pinned: true } },
      { path: "b.md", frontmatter: { pinned: false } },
    ]);
    expect(runQuery("!(pinned == true)")).toEqual([b]);
  });

  it("missing frontmatter key → predicate false", () => {
    const [a] = seed([{ path: "a.md", frontmatter: { other: "x" } }]);
    void a;
    expect(runQuery('status == "draft"')).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// $-intrinsics
// -----------------------------------------------------------------------------

describe("intrinsics", () => {
  it("$path.startsWith(...)", () => {
    const [a, _b, c] = seed([
      { path: "drafts/one.md", frontmatter: {} },
      { path: "notes/two.md", frontmatter: {} },
      { path: "drafts/three.md", frontmatter: {} },
    ]);
    void _b;
    expect(runQuery('$path.startsWith("drafts/")')).toEqual([a, c]);
  });

  it("$created_at comparison", () => {
    const [a, b] = seed([
      { path: "a.md", frontmatter: {} },
      { path: "b.md", frontmatter: {} },
    ]);
    // JS Date.toISOString emits "...:00.000Z" — string-compare uses the
    // literal representation. Match the exact format the seeder produced.
    expect(runQuery('$created_at < "2026-08-14T00:00:01.000Z"')).toEqual([a]);
    expect(runQuery('$created_at <= "2026-08-14T00:00:01.000Z"')).toEqual([a, b]);
  });

  it("unknown $-intrinsic → filter_invalid", () => {
    try {
      runQuery("$bogus == 1");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(KernelError);
      expect((err as KernelError).code).toBe("filter_invalid");
    }
  });
});

// -----------------------------------------------------------------------------
// list() polymorphism (§5.2)
// -----------------------------------------------------------------------------

describe("list() polymorphism", () => {
  it('"pricing" in list(tags) matches both scalar and list frontmatter', () => {
    const [a, b, _c] = seed([
      { path: "a.md", frontmatter: { tags: "pricing" } }, // scalar
      { path: "b.md", frontmatter: { tags: ["pricing", "saas"] } }, // list
      { path: "c.md", frontmatter: { tags: ["other"] } },
    ]);
    void _c;
    expect(runQuery('"pricing" in list(tags)')).toEqual([a, b]);
  });

  it("size(list(tags)) counts scalar as 1, list as its length, missing as 0", () => {
    const [_a, b, _c] = seed([
      { path: "a.md", frontmatter: { tags: "one" } }, // 1
      { path: "b.md", frontmatter: { tags: ["a", "b", "c"] } }, // 3
      { path: "c.md", frontmatter: {} }, // 0
    ]);
    void _a;
    void _c;
    expect(runQuery("size(list(tags)) > 2")).toEqual([b]);
  });

  it("list(tags).all(t, t.startsWith('p'))", () => {
    const [a, _b] = seed([
      { path: "a.md", frontmatter: { tags: ["pricing", "product"] } },
      { path: "b.md", frontmatter: { tags: ["pricing", "saas"] } },
    ]);
    void _b;
    expect(runQuery("list(tags).all(t, t.startsWith('p'))")).toEqual([a]);
  });

  it("list(tags).exists(t, t == 'x')", () => {
    const [a, _b, c] = seed([
      { path: "a.md", frontmatter: { tags: ["x", "y"] } },
      { path: "b.md", frontmatter: { tags: ["y"] } },
      { path: "c.md", frontmatter: { tags: "x" } }, // scalar
    ]);
    void _b;
    expect(runQuery("list(tags).exists(t, t == 'x')")).toEqual([a, c]);
  });

  it("@in without list() → filter_invalid", () => {
    try {
      runQuery('"x" in tags');
      throw new Error("expected throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("filter_invalid");
    }
  });
});

// -----------------------------------------------------------------------------
// String methods on frontmatter + body
// -----------------------------------------------------------------------------

describe("string methods", () => {
  it("startsWith on a frontmatter string", () => {
    const [a, _b] = seed([
      { path: "a.md", frontmatter: { title: "Welcome" } },
      { path: "b.md", frontmatter: { title: "Farewell" } },
    ]);
    void _b;
    expect(runQuery('title.startsWith("Wel")')).toEqual([a]);
  });

  it("contains on $body", () => {
    const [a, _b] = seed([
      { path: "a.md", frontmatter: {}, body: "the quick fox" },
      { path: "b.md", frontmatter: {}, body: "the slow turtle" },
    ]);
    void _b;
    expect(runQuery('contains($body, "quick")')).toEqual([a]);
  });

  it("startsWith literal is LIKE-escaped for wildcard characters", () => {
    // A literal '%' should NOT be treated as a wildcard.
    const [a, _b] = seed([
      { path: "a.md", frontmatter: { title: "50% off" } },
      { path: "b.md", frontmatter: { title: "50x off" } },
    ]);
    void _b;
    expect(runQuery('title.startsWith("50%")')).toEqual([a]);
  });

  it("matches regex via the regexp user function", () => {
    const [a, _b] = seed([
      { path: "a.md", frontmatter: { slug: "v1.2.3" } },
      { path: "b.md", frontmatter: { slug: "abc" } },
    ]);
    void _b;
    expect(runQuery('slug.matches("^v\\\\d+\\\\.\\\\d+\\\\.\\\\d+$")')).toEqual([a]);
  });

  it("matches is ReDoS-safe (RE2JS linear-time — a catastrophic pattern completes instantly)", () => {
    // This pattern + input would take multiple SECONDS in JS's built-in
    // RegExp (exponential backtracking). RE2JS returns in microseconds.
    // If we ever regress the regexp UDF to JS RegExp, this test hangs the
    // whole vitest run — canary by design.
    const [_a] = seed([{ path: "a.md", frontmatter: { slug: `${"a".repeat(30)}b` } }]);
    void _a;
    const start = Date.now();
    const result = runQuery('slug.matches("^(a+)+$")');
    const elapsed = Date.now() - start;
    expect(result).toEqual([]);
    // Generous ceiling — RE2JS runs in <1ms on typical hardware; a
    // failing RegExp swap here would take seconds.
    expect(elapsed).toBeLessThan(500);
  });
});

// -----------------------------------------------------------------------------
// Parameterization + safety
// -----------------------------------------------------------------------------

describe("SQL safety", () => {
  it("string literals are parameterized (SQL injection would appear as a literal match)", () => {
    seed([{ path: "a.md", frontmatter: { title: "hi" } }]);
    // If the compiler naively interpolated the string, the trailing '; DROP TABLE
    // would execute — the test would fail because versions no longer exists.
    // With parameterization, the "trailing DROP" is just part of the string
    // and matches nothing.
    expect(runQuery('title == "hi\'; DROP TABLE versions; --"')).toEqual([]);
    // Sanity: versions still exists and the good query still works.
    expect(runQuery('title == "hi"').length).toBe(1);
  });
});
