/**
 * Graph query surface — $in_static / $has_static / $backlinks_static() /
 * $links_static() (design §11.2, links-plan.md WS4).
 *
 * Drives the full kernel query path against the SQLite adapter and asserts
 * which documents a graph filter returns. Redundant-by-design coverage of
 * membership, set algebra, field restriction, collections, and scope.
 * WS7 lifts the cross-cutting cases into the shared kernel suite for
 * Postgres parity.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CallContext } from "../src/kernel/context.js";
import { KernelError } from "../src/kernel/errors.js";
import { type Kernel, createKernel } from "../src/kernel/kernel.js";
import { sqliteAdapter } from "../src/storage-sqlite/adapter.js";
import type { Storage } from "../src/storage/types.js";

let storage: Storage;
let kernel: Kernel;
let repoId: number;

async function fresh(): Promise<Storage> {
  return sqliteAdapter.open({
    database: `sqlite:${join(tmpdir(), `mrplex-graph-${Date.now()}-${Math.random()}.db`)}`,
  });
}

function create(
  path: string,
  input: { body?: string; frontmatter?: Record<string, unknown> } = {},
) {
  const fm = input.frontmatter ? { frontmatter: input.frontmatter } : { frontmatter_raw: "" };
  return kernel.docs.create({}, "notes", path, { ...fm, body: input.body ?? "" });
}

async function fields(...fs: string[]): Promise<void> {
  await storage.repos_set_link_config(repoId, JSON.stringify({ fields: fs }));
}

/** Query with a filter; return the matching paths, sorted. */
async function q(filter: string, ctx: CallContext = {}): Promise<string[]> {
  const rows = await kernel.query(ctx, { repo: "notes", filter });
  return rows.map((r) => r.$path as string).sort();
}

beforeEach(async () => {
  storage = await fresh();
  kernel = createKernel(storage);
  const notes = await storage.repos_create({ slug: "notes", created_at: "2026-08-14T00:00:01Z" });
  repoId = notes.id;
});

afterEach(async () => {
  await storage.close();
});

describe("$in_static — others → me (I'm in X's set)", () => {
  it("finds documents referenced by a specific source", async () => {
    await create("alice.md");
    await create("bob.md");
    await create("moc/employees.md", { body: "- [[alice]]\n- [[bob]]" });
    expect(await q('$in_static("moc/employees.md")')).toEqual(["alice.md", "bob.md"]);
  });

  it("supports a glob over a family of sources", async () => {
    await create("x.md");
    // Repo-absolute target so both moc/* docs reference the same x.md.
    await create("moc/a.md", { body: "[x](/x.md)" });
    await create("moc/b.md", { body: "[x](/x.md)" });
    // x.md is in some moc/* set.
    expect(await q('$in_static("moc/**")')).toEqual(["x.md"]);
  });

  it("does not match a document nobody references", async () => {
    await create("lonely.md");
    await create("moc.md", { body: "no links" });
    expect(await q('$in_static("moc.md")')).toEqual([]);
  });

  it('orphan detection: !$in_static("**")', async () => {
    await create("referenced.md");
    await create("orphan.md", { body: "no inbound" });
    await create("moc.md", { body: "[r](referenced.md)" });
    // orphan.md and moc.md are in nobody's set; referenced.md is.
    expect(await q('!$in_static("**")')).toEqual(["moc.md", "orphan.md"]);
  });
});

describe("MOC set algebra", () => {
  beforeEach(async () => {
    await create("alice.md");
    await create("bob.md");
    await create("carol.md");
    await create("moc/employees.md", { body: "[[alice]] [[bob]] [[carol]]" });
    await create("moc/contractors.md", { body: "[[bob]]" });
    await create("moc/on-call.md", { body: "[[alice]]" });
  });

  it("set difference", async () => {
    expect(await q('$in_static("moc/employees.md") && !$in_static("moc/contractors.md")')).toEqual([
      "alice.md",
      "carol.md",
    ]);
  });

  it("intersection", async () => {
    expect(await q('$in_static("moc/employees.md") && $in_static("moc/on-call.md")')).toEqual([
      "alice.md",
    ]);
  });

  it("union via glob", async () => {
    expect(await q('$in_static("moc/**")')).toEqual(["alice.md", "bob.md", "carol.md"]);
  });
});

describe("$has_static — me → others (X is in my set)", () => {
  it("finds documents that reference a target", async () => {
    await create("horses.md");
    await create("note1.md", { body: "[h](horses.md)" });
    await create("note2.md", { body: "no link" });
    expect(await q('$has_static("horses.md")')).toEqual(["note1.md"]);
  });

  it("matches even when the target is dangling (never created)", async () => {
    await create("note.md", { body: "[g](ghost.md)" });
    expect(await q('$has_static("ghost.md")')).toEqual(["note.md"]);
  });

  it("supports a glob over targets", async () => {
    await create("projects/p1.md");
    await create("active.md", {
      frontmatter: { status: "active" },
      body: "[p](projects/p1.md)",
    });
    await create("idle.md", { frontmatter: { status: "idle" }, body: "no project" });
    // active docs referencing any project — composes with a frontmatter filter.
    expect(await q('$has_static("projects/**") && status == "active"')).toEqual(["active.md"]);
  });
});

describe("field restriction (optional 2nd argument)", () => {
  it("$has_static(glob, field) restricts to a frontmatter field edge", async () => {
    await fields("parent", "related");
    await create("moc/employees.md");
    await create("alice.md", {
      frontmatter: { parent: "moc/employees.md" },
      body: "[e](/moc/employees.md)", // also a body edge to the same target
    });
    await create("bob.md", { frontmatter: { related: "moc/employees.md" } });
    // Only docs naming employees.md via their `parent` field (alice, not bob
    // who uses `related`, and the restriction excludes alice's body edge).
    expect(await q('$has_static("moc/employees.md", "parent")')).toEqual(["alice.md"]);
  });

  it('$has_static(glob, "$body") restricts to body-derived edges', async () => {
    await fields("parent");
    await create("target.md");
    await create("viabody.md", { body: "[t](target.md)" });
    await create("viafm.md", { frontmatter: { parent: "target.md" } });
    expect(await q('$has_static("target.md", "$body")')).toEqual(["viabody.md"]);
  });
});

describe("$links_static() / $backlinks_static() collections", () => {
  it("leaf node: $links_static().size() == 0", async () => {
    await create("a.md");
    await create("hub.md", { body: "[a](a.md)" });
    // a.md links to nothing; hub.md links to a.md.
    expect(await q("$links_static().size() == 0")).toEqual(["a.md"]);
  });

  it("counts outbound resolved links", async () => {
    await create("a.md");
    await create("b.md");
    await create("hub.md", { body: "[a](a.md) [b](b.md)" });
    expect(await q("$links_static().size() == 2")).toEqual(["hub.md"]);
  });

  it("$backlinks_static().size() counts inbound references", async () => {
    await create("popular.md");
    await create("r1.md", { body: "[p](popular.md)" });
    await create("r2.md", { body: "[p](popular.md)" });
    expect(await q("$backlinks_static().size() == 2")).toEqual(["popular.md"]);
  });

  it('$backlinks_static().exists(d, d.status == "draft") — a draft cites me', async () => {
    await create("cited.md");
    await create("uncited.md");
    await create("draft.md", { frontmatter: { status: "draft" }, body: "[c](cited.md)" });
    expect(await q('$backlinks_static().exists(d, d.status == "draft")')).toEqual(["cited.md"]);
  });

  it('$backlinks_static().all(d, d.status == "published") — every citer published', async () => {
    await create("target.md");
    await create("other.md");
    await create("pub.md", { frontmatter: { status: "published" }, body: "[t](target.md)" });
    // target.md's only backlink is published → true. other.md has no
    // backlinks → all() is vacuously true.
    const res = await q('$backlinks_static().all(d, d.status == "published")');
    expect(res).toContain("target.md");
    expect(res).toContain("other.md");
  });

  it('$links_static().exists(d, d.$path.startsWith("archive/"))', async () => {
    await create("archive/old.md");
    await create("live.md");
    await create("hub.md", { body: "[o](archive/old.md) [l](live.md)" });
    expect(await q('$links_static().exists(d, d.$path.startsWith("archive/"))')).toEqual([
      "hub.md",
    ]);
  });
});

describe("bare names ship now (static today, static∪dynamic later)", () => {
  it("$in behaves like $in_static in Phase 1", async () => {
    await create("alice.md");
    await create("moc.md", { body: "[[alice]]" });
    expect(await q('$in("moc.md")')).toEqual(await q('$in_static("moc.md")'));
    expect(await q('$in("moc.md")')).toEqual(["alice.md"]);
  });

  it("$has behaves like $has_static", async () => {
    await create("horses.md");
    await create("note.md", { body: "[h](horses.md)" });
    expect(await q('$has("horses.md")')).toEqual(["note.md"]);
  });

  it("$backlinks() and $links() collections work bare", async () => {
    await create("leaf.md");
    await create("hub.md", { body: "[l](leaf.md)" });
    expect(await q("$links().size() == 0")).toEqual(["leaf.md"]);
    expect(await q("$backlinks().size() == 1")).toEqual(["leaf.md"]);
  });

  it("bare + _static compose together (same static set today)", async () => {
    await create("alice.md");
    await create("bob.md");
    await create("moc/all.md", { body: "[[alice]] [[bob]]" });
    await create("moc/contractors.md", { body: "[[bob]]" });
    // bare $in on the left, _static on the right — bob is excluded.
    expect(await q('$in("moc/all.md") && !$in_static("moc/contractors.md")')).toEqual(["alice.md"]);
  });
});

describe("only _dyn names are reserved (need Phase 2 embedded queries)", () => {
  const reserved = ['$in_dyn("x")', '$has_dyn("x")', "$backlinks_dyn()", "$links_dyn()"];
  for (const f of reserved) {
    it(`${f} → filter_invalid`, async () => {
      await create("x.md");
      try {
        await q(f);
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(KernelError);
        expect((err as KernelError).code).toBe("filter_invalid");
        expect((err as KernelError).data).toMatchObject({
          reason: expect.stringMatching(/Phase 2|_static/),
        });
      }
    });
  }
});

describe("scope: the visible graph is the readable graph (§5 decision 5)", () => {
  it("hides an inbound edge whose source the caller cannot read", async () => {
    // secret/moc.md references public.md, but the caller can't read secret/*.
    await create("public.md");
    await create("secret/moc.md", { body: "[p](/public.md)" });

    const scoped: CallContext = {
      scope: [{ repo: "notes", paths: ["**", "!secret/**"] }],
    };
    // public.md is referenced only by an unreadable source → not "in" it.
    expect(await q('$in_static("**")', scoped)).toEqual([]);
    // Sanity: an admin sees the edge.
    expect(await q('$in_static("**")')).toEqual(["public.md"]);
  });

  it("hides an outbound edge whose (resolved) target the caller cannot read", async () => {
    await create("secret/target.md");
    await create("note.md", { body: "[t](secret/target.md)" });
    const scoped: CallContext = {
      scope: [{ repo: "notes", paths: ["**", "!secret/**"] }],
    };
    // note.md links to a secret target → $has_static hides it for the caller.
    expect(await q('$has_static("secret/**")', scoped)).toEqual([]);
  });
});
