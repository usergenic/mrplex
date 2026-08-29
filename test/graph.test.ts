/**
 * kernel.graph — the graph read surface (docs/graph-plan.md). This file is the
 * spec: every pinned decision in §5 gets a test. Drives the full kernel path
 * against the SQLite adapter.
 *
 * Determinism, the direction lenses, $degrees as visibility, filter-blocks-
 * paths, the behavioral frontier, co-citation via `both`, induced links,
 * scope-visible degree counts, and truncation all live here.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CallContext } from "../src/kernel/context.js";
import { type Kernel, createKernel } from "../src/kernel/kernel.js";
import type { GraphSpec } from "../src/kernel/wire.js";
import { sqliteAdapter } from "../src/storage-sqlite/adapter.js";
import type { Storage } from "../src/storage/types.js";

let storage: Storage;
let kernel: Kernel;
let repoId: number;

async function fresh(): Promise<Storage> {
  return sqliteAdapter.open({
    database: `sqlite:${join(tmpdir(), `mrplex-graph-kernel-${Date.now()}-${Math.random()}.db`)}`,
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

function g(spec: Partial<GraphSpec> & { roots: string | string[] }, ctx: CallContext = {}) {
  return kernel.graph(ctx, { repo: "notes", ...spec });
}

/** Sorted paths of the returned documents. */
async function paths(
  spec: Partial<GraphSpec> & { roots: string | string[] },
  ctx: CallContext = {},
): Promise<string[]> {
  const r = await g(spec, ctx);
  return r.documents.map((d) => d.$path);
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

describe("roots (§4.2)", () => {
  it("degrees 0 returns just the roots the glob matched", async () => {
    await create("moc/a.md");
    await create("moc/b.md");
    await create("other.md");
    expect(await paths({ roots: "moc/**", degrees: 0 })).toEqual(["moc/a.md", "moc/b.md"]);
  });

  it("a glob matching nothing yields an empty result, not an error", async () => {
    await create("a.md");
    const r = await g({ roots: "nope/**" });
    expect(r.documents).toEqual([]);
    expect(r.frontier).toEqual([]);
    expect(r.complete_degrees).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it("roots are marked $degrees: 0", async () => {
    await create("root.md", { body: "[a](a.md)" });
    await create("a.md");
    const r = await g({ roots: "root.md", direction: "out", degrees: 1 });
    const root = r.documents.find((d) => d.$path === "root.md");
    expect(root?.$degrees).toBe(0);
  });

  it("an unknown repo is repo_not_found", async () => {
    await expect(kernel.graph({}, { repo: "ghost", roots: "**" })).rejects.toMatchObject({
      code: "repo_not_found",
    });
  });

  it("accepts a literal root with one leading slash (exact-path alias)", async () => {
    await create("alias-root.md");
    await create("other.md");
    expect(await paths({ roots: "/alias-root.md", degrees: 0 })).toEqual(["alias-root.md"]);
  });
});

describe("direction lens (§2.1, decision 4)", () => {
  beforeEach(async () => {
    // root → mid → leaf (a contents chain)
    await create("leaf.md");
    await create("mid.md", { body: "[leaf](leaf.md)" });
    await create("root.md", { body: "[mid](mid.md)" });
  });

  it("out follows source→target transitively", async () => {
    // Ordered by ($degrees, $path): root(0), mid(1), leaf(2).
    expect(await paths({ roots: "root.md", direction: "out", degrees: 2 })).toEqual([
      "root.md",
      "mid.md",
      "leaf.md",
    ]);
  });

  it("out at degrees 1 stops after direct neighbors", async () => {
    // Ordered by ($degrees, $path): root(0), then mid(1).
    expect(await paths({ roots: "root.md", direction: "out", degrees: 1 })).toEqual([
      "root.md",
      "mid.md",
    ]);
  });

  it("in follows target→source (the backlink neighborhood)", async () => {
    expect(await paths({ roots: "leaf.md", direction: "in", degrees: 2 })).toEqual([
      "leaf.md",
      "mid.md",
      "root.md",
    ]);
  });

  it("both is undirected", async () => {
    // mid(0), then its neighbors leaf+root at degree 1 (sorted by path).
    expect(await paths({ roots: "mid.md", direction: "both", degrees: 1 })).toEqual([
      "mid.md",
      "leaf.md",
      "root.md",
    ]);
  });
});

describe("co-citation via the undirected lens (§2.1, DoD)", () => {
  beforeEach(async () => {
    // root and sibling both reference shared.md.
    await create("shared.md");
    await create("root.md", { body: "[s](shared.md)" });
    await create("sibling.md", { body: "[s](shared.md)" });
  });

  it("both/degrees 2 surfaces the sibling (root → shared ← sibling)", async () => {
    expect(await paths({ roots: "root.md", direction: "both", degrees: 2 })).toEqual([
      "root.md",
      "shared.md",
      "sibling.md",
    ]);
  });

  it("both/degrees 1 does NOT reach the sibling", async () => {
    expect(await paths({ roots: "root.md", direction: "both", degrees: 1 })).toEqual([
      "root.md",
      "shared.md",
    ]);
  });

  it("out never reaches a co-cited sibling", async () => {
    expect(await paths({ roots: "root.md", direction: "out", degrees: 5 })).toEqual([
      "root.md",
      "shared.md",
    ]);
  });
});

describe("$degrees as visibility (§2.1, decision 5)", () => {
  beforeEach(async () => {
    // chain: root → p1(person) → p2(person) → note(non-person)
    await create("note.md", { frontmatter: { type: "note" } });
    await create("p2.md", { frontmatter: { type: "person" }, body: "[n](note.md)" });
    await create("p1.md", { frontmatter: { type: "person" }, body: "[p2](p2.md)" });
    await create("root.md", { body: "[p1](p1.md)" });
  });

  it('$degrees <= 1 || type == "person" expands persons deeper, others one hop', async () => {
    // root(0) → p1(1, person, kept) → p2(2, person, kept) → note(3, not person, cut)
    const r = await g({
      roots: "root.md",
      direction: "out",
      degrees: 5,
      filter: '$degrees <= 1 || type == "person"',
    });
    expect(r.documents.map((d) => d.$path)).toEqual(["root.md", "p1.md", "p2.md"]);
  });

  it("a non-matching document blocks paths through itself", async () => {
    // Block p1 → nothing downstream is reachable.
    const r = await g({
      roots: "root.md",
      direction: "out",
      degrees: 5,
      filter: '$path != "p1.md"',
    });
    expect(r.documents.map((d) => d.$path)).toEqual(["root.md"]);
  });
});

describe("fields restrict traversal and output links (§2.1)", () => {
  beforeEach(async () => {
    await fields("parent");
    // root has a body link AND a frontmatter `parent` link (plain path value).
    await create("viaBody.md");
    await create("viaField.md");
    await create("root.md", {
      frontmatter: { parent: "viaField.md" },
      body: "[b](viaBody.md)",
    });
  });

  it("restricting to a frontmatter field follows only those edges", async () => {
    expect(
      await paths({ roots: "root.md", direction: "out", degrees: 1, fields: ["parent"] }),
    ).toEqual(["root.md", "viaField.md"]);
  });

  it("restricting to $body follows only body edges", async () => {
    expect(
      await paths({ roots: "root.md", direction: "out", degrees: 1, fields: ["$body"] }),
    ).toEqual(["root.md", "viaBody.md"]);
  });
});

describe("induced links (§2.2, decision 8)", () => {
  it("includes every distinct (source,target,field) over returned docs", async () => {
    await create("a.md");
    await create("b.md", { body: "[a](a.md)" });
    await create("root.md", { body: "[b](b.md) and [a](a.md)" });
    const r = await g({ roots: "root.md", direction: "out", degrees: 2 });
    expect(r.links).toEqual([
      { source: "b.md", target: "a.md", field: "$body" },
      { source: "root.md", target: "a.md", field: "$body" },
      { source: "root.md", target: "b.md", field: "$body" },
    ]);
  });

  it("collapses multiple occurrences of the same triple to one link", async () => {
    await create("a.md");
    await create("root.md", { body: "[a](a.md) again [a](a.md)" });
    const r = await g({ roots: "root.md", direction: "out", degrees: 1 });
    expect(r.links).toEqual([{ source: "root.md", target: "a.md", field: "$body" }]);
  });

  it("dangling links never appear (documents-only vocabulary)", async () => {
    await create("root.md", { body: "[gone](does-not-exist.md)" });
    const r = await g({ roots: "root.md", direction: "out", degrees: 1 });
    expect(r.documents.map((d) => d.$path)).toEqual(["root.md"]);
    expect(r.links).toEqual([]);
  });
});

describe("$links / $backlinks counts (§2.2, decision 7)", () => {
  it("count distinct documents, independent of this call's filter/degrees", async () => {
    // hub links to a,b,c; x and y link to hub.
    await create("a.md");
    await create("b.md");
    await create("c.md");
    await create("hub.md", { body: "[a](a.md) [b](b.md) [c](c.md)" });
    await create("x.md", { body: "[h](hub.md)" });
    await create("y.md", { body: "[h](hub.md)" });
    const r = await g({ roots: "hub.md", direction: "out", degrees: 0 });
    const hub = r.documents[0];
    expect(hub?.$links).toBe(3);
    expect(hub?.$backlinks).toBe(2);
  });

  it("three body mentions of one target count once", async () => {
    await create("t.md");
    await create("root.md", { body: "[t](t.md) [t](t.md) [t](t.md)" });
    const r = await g({ roots: "root.md", direction: "out", degrees: 0 });
    expect(r.documents[0]?.$links).toBe(1);
  });
});

describe("select projection (§2.1)", () => {
  it("projects title by default", async () => {
    await create("a.md", { frontmatter: { title: "Alpha", type: "note" } });
    const r = await g({ roots: "a.md", degrees: 0 });
    expect(r.documents[0]).toMatchObject({ $path: "a.md", title: "Alpha" });
    expect(r.documents[0]).not.toHaveProperty("type");
  });

  it("projects requested keys; a missing key is simply absent", async () => {
    await create("a.md", { frontmatter: { title: "Alpha" } });
    const r = await g({ roots: "a.md", degrees: 0, select: ["title", "type"] });
    expect(r.documents[0]).toMatchObject({ title: "Alpha" });
    expect(r.documents[0]).not.toHaveProperty("type");
  });

  it("rejects a $-prefixed select key", async () => {
    await create("a.md");
    await expect(g({ roots: "a.md", select: ["$path"] })).rejects.toMatchObject({
      code: "filter_invalid",
    });
  });
});

describe("frontier (§2.2, decision 10)", () => {
  it("lists docs at the degree cap with unenumerated neighbors", async () => {
    await create("leaf.md");
    await create("mid.md", { body: "[leaf](leaf.md)" });
    await create("root.md", { body: "[mid](mid.md)" });
    const r = await g({ roots: "root.md", direction: "out", degrees: 1 });
    // mid.md is at the cap and has an unenumerated link to leaf.md.
    expect(r.frontier).toEqual(["mid.md"]);
  });

  it("a sated doc at max degrees is NOT frontier", async () => {
    // root → a; a has no further links.
    await create("a.md");
    await create("root.md", { body: "[a](a.md)" });
    const r = await g({ roots: "root.md", direction: "out", degrees: 1 });
    expect(r.frontier).toEqual([]);
  });
});

describe("complete_degrees + truncation (§2.2, decision 11)", () => {
  it("complete_degrees == degrees on a clean full expansion", async () => {
    await create("a.md");
    await create("root.md", { body: "[a](a.md)" });
    const r = await g({ roots: "root.md", direction: "out", degrees: 2 });
    expect(r.truncated).toBe(false);
    expect(r.complete_degrees).toBe(2);
  });

  it("max_documents cutting a ring makes complete_degrees precise", async () => {
    // root → three neighbors at degree 1. Budget 2 admits root + 1 neighbor.
    await create("n1.md");
    await create("n2.md");
    await create("n3.md");
    await create("root.md", { body: "[1](n1.md) [2](n2.md) [3](n3.md)" });
    const r = await g({ roots: "root.md", direction: "out", degrees: 2, max_documents: 2 });
    expect(r.truncated).toBe(true);
    expect(r.complete_degrees).toBe(0); // the 1-ring was sampled, not exhausted
    expect(r.documents.length).toBe(2);
  });
});

describe("scope: the visible graph is the readable graph (§DoD)", () => {
  it("an out-of-scope endpoint hides the doc, its links, and shrinks counts", async () => {
    await create("secret.md");
    await create("visible.md");
    await create("root.md", { body: "[s](secret.md) [v](visible.md)" });
    // Scope grants everything except secret.md.
    const ctx: CallContext = { scope: [{ repo: "notes", paths: ["**", "!secret.md"] }] };
    const r = await g({ roots: "root.md", direction: "out", degrees: 1 }, ctx);
    expect(r.documents.map((d) => d.$path)).toEqual(["root.md", "visible.md"]);
    expect(r.links).toEqual([{ source: "root.md", target: "visible.md", field: "$body" }]);
    // $links counts only the visible neighbor.
    const root = r.documents.find((d) => d.$path === "root.md");
    expect(root?.$links).toBe(1);
  });
});

describe("determinism (§2.2 Ordering)", () => {
  it("identical inputs produce byte-identical results across runs", async () => {
    await create("a.md");
    await create("b.md", { body: "[a](a.md)" });
    await create("c.md", { body: "[a](a.md) [b](b.md)" });
    await create("root.md", { body: "[b](b.md) [c](c.md)" });
    const spec = { roots: "root.md", direction: "both" as const, degrees: 3 };
    const r1 = JSON.stringify(await g(spec));
    const r2 = JSON.stringify(await g(spec));
    expect(r1).toBe(r2);
  });

  it("documents are ordered by ($degrees, $path)", async () => {
    await create("z.md");
    await create("a.md", { body: "[z](z.md)" });
    await create("root.md", { body: "[a](a.md) [z](z.md)" });
    const r = await g({ roots: "root.md", direction: "out", degrees: 2 });
    // root(0), then degree-1 {a.md, z.md} sorted, z has no further new nodes.
    expect(r.documents.map((d) => [d.$degrees, d.$path])).toEqual([
      [0, "root.md"],
      [1, "a.md"],
      [1, "z.md"],
    ]);
  });
});

describe("validation", () => {
  it("rejects an unknown spec field", async () => {
    await create("a.md");
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: testing a rejected field
      kernel.graph({}, { repo: "notes", roots: "a.md", bogus: 1 } as any),
    ).rejects.toMatchObject({ code: "filter_invalid" });
  });

  it("rejects a bad direction", async () => {
    await create("a.md");
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: testing a rejected value
      g({ roots: "a.md", direction: "sideways" as any }),
    ).rejects.toMatchObject({ code: "filter_invalid" });
  });

  it("caps degrees at MAX_DEGREES without erroring", async () => {
    await create("a.md");
    const r = await g({ roots: "a.md", degrees: 999 });
    expect(r.complete_degrees).toBeGreaterThanOrEqual(0);
  });
});
