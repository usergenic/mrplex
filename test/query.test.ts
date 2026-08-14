/**
 * kernel.query end-to-end — design §5. Exercises the whole path from
 * spec parsing through CEL compilation, FTS composition, scope filter,
 * sigil exclusion, ordering, and limit.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Actor, SYSTEM_ACTOR } from "../src/kernel/auth/actor.js";
import type { KernelError } from "../src/kernel/errors.js";
import { type Kernel, createKernel } from "../src/kernel/kernel.js";
import { sqliteAdapter } from "../src/storage-sqlite/adapter.js";
import type { Storage } from "../src/storage/types.js";

let storage: Storage;
let kernel: Kernel;
let admin: Actor;

function seedDoc(
  repoSlug: string,
  path: string,
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const v = kernel.docs.create(admin, repoSlug, path, {
    frontmatter,
    body,
  });
  return v.version_id;
}

beforeEach(() => {
  storage = sqliteAdapter.open({
    database: `sqlite:${join(tmpdir(), `mrplex-query-${Date.now()}-${Math.random()}.db`)}`,
  });
  kernel = createKernel(storage);
  const alice = storage.users_create({ slug: "alice", created_at: "2026-08-14T00:00:00Z" });
  admin = { user_id: alice.id, admin: true, scopes: [] };
  storage.repos_create({ slug: "notes", created_at: "2026-08-14T00:00:00Z" });
});

afterEach(() => {
  storage.close();
});

// -----------------------------------------------------------------------------
// Filter mode
// -----------------------------------------------------------------------------

describe("query — filter mode", () => {
  it("returns docs matching a CEL predicate", async () => {
    seedDoc("notes", "a.md", { status: "draft" }, "");
    seedDoc("notes", "b.md", { status: "published" }, "");
    seedDoc("notes", "c.md", { status: "draft" }, "");
    const results = await kernel.query(admin, {
      repo: "notes",
      filter: 'status == "draft"',
    });
    expect(results.map((v) => v.path).sort()).toEqual(["a.md", "c.md"]);
  });

  it("supports the design's §5.1 example — status && list membership", async () => {
    seedDoc("notes", "one.md", { status: "draft", tags: ["pricing"] }, "");
    seedDoc("notes", "two.md", { status: "draft", tags: ["other"] }, "");
    seedDoc("notes", "three.md", { status: "published", tags: ["pricing"] }, "");
    const results = await kernel.query(admin, {
      repo: "notes",
      filter: 'status == "draft" && "pricing" in list(tags)',
    });
    expect(results.map((v) => v.path)).toEqual(["one.md"]);
  });

  it("$path intrinsic", async () => {
    seedDoc("notes", "drafts/one.md", {}, "");
    seedDoc("notes", "published/two.md", {}, "");
    const results = await kernel.query(admin, {
      repo: "notes",
      filter: '$path.startsWith("drafts/")',
    });
    expect(results.map((v) => v.path)).toEqual(["drafts/one.md"]);
  });
});

// -----------------------------------------------------------------------------
// Text mode
// -----------------------------------------------------------------------------

describe("query — text mode", () => {
  it("returns docs whose body matches an FTS5 query", async () => {
    seedDoc("notes", "a.md", {}, "The quick brown fox");
    seedDoc("notes", "b.md", {}, "Nothing to see here");
    seedDoc("notes", "c.md", {}, "another quick note");
    const results = await kernel.query(admin, { repo: "notes", text: "quick" });
    expect(results.map((v) => v.path).sort()).toEqual(["a.md", "c.md"]);
  });

  it("filter + text compose via AND", async () => {
    seedDoc("notes", "a.md", { status: "draft" }, "quick brown fox");
    seedDoc("notes", "b.md", { status: "published" }, "quick brown fox");
    seedDoc("notes", "c.md", { status: "draft" }, "another topic");
    const results = await kernel.query(admin, {
      repo: "notes",
      filter: 'status == "draft"',
      text: "quick",
    });
    expect(results.map((v) => v.path)).toEqual(["a.md"]);
  });

  it("returns [] when the FTS query matches nothing", async () => {
    seedDoc("notes", "a.md", {}, "just some content");
    const results = await kernel.query(admin, { repo: "notes", text: "nonexistent" });
    expect(results).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Sigil exclusion (§5.1)
// -----------------------------------------------------------------------------

describe("query — sigil exclusion", () => {
  it("hides hidden-sigil paths by default", async () => {
    seedDoc("notes", "visible.md", {}, "");
    seedDoc("notes", ".obsidian/config.md", {}, "");
    const results = await kernel.query(admin, { repo: "notes" });
    expect(results.map((v) => v.path)).toEqual(["visible.md"]);
  });

  it("include_hidden surfaces .-prefixed paths", async () => {
    seedDoc("notes", "visible.md", {}, "");
    seedDoc("notes", ".obsidian/config.md", {}, "");
    const results = await kernel.query(admin, { repo: "notes", include_hidden: true });
    expect(results.map((v) => v.path).sort()).toEqual([".obsidian/config.md", "visible.md"]);
  });

  it("hides system-sigil paths (trashed docs) by default", async () => {
    const v = kernel.docs.create(admin, "notes", "hello.md", {
      frontmatter: {},
      body: "hi\n",
    });
    kernel.docs.delete(admin, "notes", v.version_id);
    // Now :deleted/hello-v1.md is in the corpus; default query hides it.
    const results = await kernel.query(admin, { repo: "notes" });
    expect(results).toEqual([]);
    const withSystem = await kernel.query(admin, { repo: "notes", include_system: true });
    expect(withSystem.map((v) => v.path)).toEqual([
      expect.stringMatching(/^:deleted\/hello-v\d+\.md$/),
    ]);
  });
});

// -----------------------------------------------------------------------------
// Scope filtering (§8.2)
// -----------------------------------------------------------------------------

describe("query — scope filter (§8.2)", () => {
  it("silently drops rows outside a non-admin's read globs", async () => {
    seedDoc("notes", "public.md", {}, "");
    seedDoc("notes", "secret/hidden.md", {}, "");
    const repoRow = storage.repos_by_slug("notes");
    if (!repoRow) throw new Error("seed");
    const scoped: Actor = {
      user_id: admin.user_id,
      admin: false,
      scopes: [{ repos: [repoRow.id], read: ["public.md"] }],
    };
    const results = await kernel.query(scoped, { repo: "notes" });
    expect(results.map((v) => v.path)).toEqual(["public.md"]);
  });

  it("admins bypass scope", async () => {
    seedDoc("notes", "a.md", {}, "");
    seedDoc("notes", "b.md", {}, "");
    const results = await kernel.query(admin, { repo: "notes" });
    expect(results.map((v) => v.path).sort()).toEqual(["a.md", "b.md"]);
  });

  it("scope filter honors ! negation with last-match-wins semantics", async () => {
    seedDoc("notes", "drafts/one.md", {}, "");
    seedDoc("notes", "drafts/pinned/two.md", {}, "");
    seedDoc("notes", "drafts/three.md", {}, "");
    const repoRow = storage.repos_by_slug("notes");
    if (!repoRow) throw new Error("seed");
    const scoped: Actor = {
      user_id: admin.user_id,
      admin: false,
      scopes: [{ repos: [repoRow.id], read: ["drafts/**", "!drafts/pinned/**"] }],
    };
    const results = await kernel.query(scoped, { repo: "notes" });
    expect(results.map((v) => v.path).sort()).toEqual(["drafts/one.md", "drafts/three.md"]);
  });

  it("scope filter respects limit under narrow scope (no silent under-count)", async () => {
    // 10 rows in scope, 10 rows out — limit 5 must return 5 in-scope rows,
    // not 5 minus scope drops. The pre-fix implementation would overfetch
    // and slice, silently returning fewer than 5 when out-of-scope rows
    // dominated the top of the created_at ordering.
    for (let i = 0; i < 10; i++) seedDoc("notes", `out/${i}.md`, {}, "");
    for (let i = 0; i < 10; i++) seedDoc("notes", `in/${i}.md`, {}, "");
    const repoRow = storage.repos_by_slug("notes");
    if (!repoRow) throw new Error("seed");
    const scoped: Actor = {
      user_id: admin.user_id,
      admin: false,
      scopes: [{ repos: [repoRow.id], read: ["in/**"] }],
    };
    const results = await kernel.query(scoped, { repo: "notes", limit: 5 });
    expect(results).toHaveLength(5);
    expect(results.every((v) => v.path.startsWith("in/"))).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Per-repo sigil exclusion (§3.5.5)
// -----------------------------------------------------------------------------

describe("query — per-repo sigil exclusion", () => {
  it("respects per-repo hidden_sigils override", async () => {
    // Second repo overrides hidden_sigils to include "_" too.
    storage.repos_create({
      slug: "custom",
      created_at: "2026-08-14T00:00:01Z",
    });
    kernel.repos.set_path_config(admin, "custom", {
      hidden_sigils: [".", "_"],
    });
    seedDoc("notes", "_notes_hidden_by_custom_only.md", {}, "");
    seedDoc("custom", "_hidden_in_custom.md", {}, "");
    // On notes (server default hidden=["."]), the _-prefixed file is NOT
    // hidden. On custom (override hidden=[".","_"]), it IS hidden.
    const notesResults = await kernel.query(admin, { repo: "notes" });
    expect(notesResults.map((v) => v.path)).toEqual(["_notes_hidden_by_custom_only.md"]);
    const customResults = await kernel.query(admin, { repo: "custom" });
    expect(customResults).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Multi-repo
// -----------------------------------------------------------------------------

describe("query — multi-repo", () => {
  it("resolves a repo glob to multiple repos", async () => {
    storage.repos_create({ slug: "team-alpha", created_at: "2026-08-14T00:00:01Z" });
    storage.repos_create({ slug: "team-beta", created_at: "2026-08-14T00:00:02Z" });
    seedDoc("team-alpha", "one.md", { pinned: true }, "");
    seedDoc("team-beta", "two.md", { pinned: true }, "");
    seedDoc("notes", "three.md", { pinned: true }, "");
    const results = await kernel.query(admin, {
      repo: "team-*",
      filter: "pinned == true",
    });
    expect(results.map((v) => `${v.repo}/${v.path}`).sort()).toEqual([
      "team-alpha/one.md",
      "team-beta/two.md",
    ]);
  });

  it("omitted repo = every repo the caller can address", async () => {
    storage.repos_create({ slug: "other", created_at: "2026-08-14T00:00:01Z" });
    seedDoc("notes", "n1.md", {}, "unique1");
    seedDoc("other", "o1.md", {}, "unique1");
    const results = await kernel.query(admin, { text: "unique1" });
    expect(results.map((v) => v.repo).sort()).toEqual(["notes", "other"]);
  });
});

// -----------------------------------------------------------------------------
// Ordering + limit
// -----------------------------------------------------------------------------

describe("query — ordering + limit", () => {
  it("orders by $created_at desc when no text", async () => {
    // Create in order — created_at increments per docs.create call.
    const v1 = seedDoc("notes", "a.md", {}, "");
    const v2 = seedDoc("notes", "b.md", {}, "");
    const v3 = seedDoc("notes", "c.md", {}, "");
    const results = await kernel.query(admin, { repo: "notes" });
    expect(results.map((v) => v.version_id)).toEqual([v3, v2, v1]);
  });

  it("respects limit", async () => {
    seedDoc("notes", "a.md", {}, "");
    seedDoc("notes", "b.md", {}, "");
    seedDoc("notes", "c.md", {}, "");
    const results = await kernel.query(admin, { repo: "notes", limit: 2 });
    expect(results).toHaveLength(2);
  });

  it("limit=0 returns []", async () => {
    seedDoc("notes", "a.md", {}, "");
    expect(await kernel.query(admin, { repo: "notes", limit: 0 })).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Validation + rank_unavailable (M4)
// -----------------------------------------------------------------------------

describe("query — validation", () => {
  it("rank field without a hook returns rank_unavailable (m4-plan §5 decision 4)", async () => {
    try {
      await kernel.query(admin, { rank: "anything" });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("rank_unavailable");
      const data = (err as KernelError<{ reason: string }>).data;
      expect(data.reason).toMatch(/hook/);
    }
  });

  it("rank empty string returns filter_invalid (malformed)", async () => {
    try {
      await kernel.query(admin, { rank: "  " });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("filter_invalid");
    }
  });

  it("malformed filter returns filter_invalid", async () => {
    try {
      await kernel.query(admin, { filter: "this is not [ valid cel" });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("filter_invalid");
    }
  });

  it("negative limit returns filter_invalid", async () => {
    try {
      await kernel.query(admin, { limit: -1 });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("filter_invalid");
    }
  });

  it("unknown QuerySpec fields return filter_invalid", async () => {
    try {
      await kernel.query(admin, { limit_typo: 5 } as never);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("filter_invalid");
      const data = (err as KernelError<{ reason: string }>).data;
      expect(data.reason).toContain("limit_typo");
    }
  });

  it("bare list() outside a hint context returns filter_invalid", async () => {
    try {
      await kernel.query(admin, { repo: "notes", filter: 'list(tags) == "foo"' });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("filter_invalid");
      const data = (err as KernelError<{ reason: string }>).data;
      expect(data.reason).toMatch(/list\(\)/);
    }
  });

  it("member access on a comprehension iter-var returns filter_invalid", async () => {
    // Would otherwise silently compile a.name as a top-level frontmatter
    // key path — wrong data with no user signal.
    try {
      await kernel.query(admin, {
        repo: "notes",
        filter: 'list(authors).all(a, a.name == "alice")',
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("filter_invalid");
      const data = (err as KernelError<{ reason: string }>).data;
      expect(data.reason).toMatch(/iter-var/);
    }
  });

  it("SYSTEM_ACTOR is trusted end-to-end", async () => {
    seedDoc("notes", "a.md", {}, "");
    const results = await kernel.query(SYSTEM_ACTOR, { repo: "notes" });
    expect(results.map((v) => v.path)).toEqual(["a.md"]);
  });
});
