/**
 * links.stale + mrplex links repair (design §11.2, links-plan.md WS5).
 *
 * A move is identity-bound, so an inbound edge stays resolved but its
 * written text goes stale; links.stale surfaces that and links repair
 * rewrites the destination as a normal optimistic docs.put. Coverage errs
 * toward redundancy: staleness detection, surgical rewrite of inline +
 * wikilink destinations, anchor preservation, dry-run, conflict handling,
 * and scope.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CallContext } from "../src/kernel/context.js";
import { type Kernel, createKernel } from "../src/kernel/kernel.js";
import { sqliteAdapter } from "../src/storage-sqlite/adapter.js";
import type { Storage } from "../src/storage/types.js";

let storage: Storage;
let kernel: Kernel;

const ctx: CallContext = { author: "alice" };

async function fresh(): Promise<Storage> {
  return sqliteAdapter.open({
    database: `sqlite:${join(tmpdir(), `mrplex-repair-${Date.now()}-${Math.random()}.db`)}`,
  });
}

function create(path: string, body: string) {
  return kernel.docs.create(ctx, "notes", path, { frontmatter_raw: "", body });
}

async function bodyAt(path: string): Promise<string> {
  const v = await kernel.docs.get(ctx, "notes", path);
  return v.body;
}

beforeEach(async () => {
  storage = await fresh();
  kernel = createKernel(storage);
  await storage.repos_create({ slug: "notes", created_at: "2026-08-14T00:00:01Z" });
});

afterEach(async () => {
  await storage.close();
});

describe("links.stale", () => {
  it("is empty when nothing has moved", async () => {
    await create("horses.md", "neigh");
    await create("note.md", "[h](horses.md)");
    expect(await kernel.links.stale(ctx, "notes")).toEqual([]);
  });

  it("reports an inline link whose target moved", async () => {
    const target = await create("horses.md", "neigh");
    await create("note.md", "see [h](horses.md)");
    await kernel.docs.put(ctx, "notes", target.version_id, "animals/horses.md", {});

    const stale = await kernel.links.stale(ctx, "notes");
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({
      repo: "notes",
      source_path: "note.md",
      written: "horses.md",
      current: "animals/horses.md",
    });
  });

  it("reports a wikilink whose target moved", async () => {
    const target = await create("alice.md", "hi");
    await create("moc.md", "- [[alice]]");
    await kernel.docs.put(ctx, "notes", target.version_id, "people/alice.md", {});
    const stale = await kernel.links.stale(ctx, "notes");
    expect(stale).toHaveLength(1);
    expect(stale[0]?.source_path).toBe("moc.md");
    expect(stale[0]?.current).toBe("people/alice.md");
  });

  it("does not report dangling links (no current target path)", async () => {
    await create("note.md", "[g](ghost.md)");
    expect(await kernel.links.stale(ctx, "notes")).toEqual([]);
  });

  it("does not report a pure recasing of the target (case-insensitive identity)", async () => {
    const target = await create("horses.md", "neigh");
    await create("note.md", "[h](horses.md)");
    // Recase only — folded path unchanged.
    await kernel.docs.put(ctx, "notes", target.version_id, "Horses.md", {});
    expect(await kernel.links.stale(ctx, "notes")).toEqual([]);
  });
});

describe("mrplex links repair", () => {
  it("rewrites an inline destination to the target's current path", async () => {
    const target = await create("horses.md", "neigh");
    await create("note.md", "see [h](horses.md) today");
    await kernel.docs.put(ctx, "notes", target.version_id, "animals/horses.md", {});

    const res = await kernel.links.repair(ctx, "notes");
    expect(res.repaired).toEqual([{ path: "note.md", edges: 1 }]);
    expect(res.skipped).toEqual([]);
    expect(await bodyAt("note.md")).toBe("see [h](animals/horses.md) today");
    // And the index is now fresh.
    expect(await kernel.links.stale(ctx, "notes")).toEqual([]);
  });

  it("rewrites a wikilink destination without the .md extension", async () => {
    const target = await create("alice.md", "hi");
    await create("moc.md", "- [[alice]] is here");
    await kernel.docs.put(ctx, "notes", target.version_id, "people/alice.md", {});

    await kernel.links.repair(ctx, "notes");
    expect(await bodyAt("moc.md")).toBe("- [[people/alice]] is here");
  });

  it("preserves an anchor when rewriting", async () => {
    const target = await create("horses.md", "neigh");
    await create("note.md", "[h](horses.md#gaits)");
    await kernel.docs.put(ctx, "notes", target.version_id, "animals/horses.md", {});
    await kernel.links.repair(ctx, "notes");
    expect(await bodyAt("note.md")).toBe("[h](animals/horses.md#gaits)");
  });

  it("rewrites a reference-style link by editing its [id]: definition", async () => {
    const target = await create("horses.md", "neigh");
    await create("note.md", "See [horses][h].\n\n[h]: horses.md");
    await kernel.docs.put(ctx, "notes", target.version_id, "animals/horses.md", {});
    const res = await kernel.links.repair(ctx, "notes");
    expect(res.repaired).toEqual([{ path: "note.md", edges: 1 }]);
    expect(await bodyAt("note.md")).toBe("See [horses][h].\n\n[h]: animals/horses.md");
    expect(await kernel.links.stale(ctx, "notes")).toEqual([]);
  });

  it("two references sharing one definition rewrite it once (no double-splice)", async () => {
    const target = await create("horses.md", "neigh");
    await create("note.md", "[one][h] and [two][h].\n\n[h]: horses.md");
    await kernel.docs.put(ctx, "notes", target.version_id, "animals/horses.md", {});
    const res = await kernel.links.repair(ctx, "notes");
    // One rewrite (the shared definition span), not two.
    expect(res.repaired).toEqual([{ path: "note.md", edges: 1 }]);
    expect(await bodyAt("note.md")).toBe("[one][h] and [two][h].\n\n[h]: animals/horses.md");
  });

  it("rewrites multiple stale destinations in one document (right-to-left splice)", async () => {
    const a = await create("a.md", "a");
    const b = await create("b.md", "b");
    await create("note.md", "[a](a.md) and [b](b.md)");
    await kernel.docs.put(ctx, "notes", a.version_id, "x/a.md", {});
    await kernel.docs.put(ctx, "notes", b.version_id, "y/b.md", {});

    const res = await kernel.links.repair(ctx, "notes");
    expect(res.repaired).toEqual([{ path: "note.md", edges: 2 }]);
    expect(await bodyAt("note.md")).toBe("[a](x/a.md) and [b](y/b.md)");
  });

  it("leaves fresh links untouched (rewrites only the stale one)", async () => {
    const a = await create("a.md", "a");
    await create("b.md", "b");
    await create("note.md", "[a](a.md) and [b](b.md)");
    await kernel.docs.put(ctx, "notes", a.version_id, "x/a.md", {});

    await kernel.links.repair(ctx, "notes");
    expect(await bodyAt("note.md")).toBe("[a](x/a.md) and [b](b.md)");
  });

  it("dry_run reports the plan but writes nothing", async () => {
    const target = await create("horses.md", "neigh");
    await create("note.md", "[h](horses.md)");
    await kernel.docs.put(ctx, "notes", target.version_id, "animals/horses.md", {});

    const res = await kernel.links.repair(ctx, "notes", { dry_run: true });
    expect(res.dry_run).toBe(true);
    expect(res.repaired).toEqual([{ path: "note.md", edges: 1 }]);
    // Body unchanged; still stale.
    expect(await bodyAt("note.md")).toBe("[h](horses.md)");
    expect(await kernel.links.stale(ctx, "notes")).toHaveLength(1);
  });

  it("is a no-op when nothing is stale", async () => {
    await create("horses.md", "neigh");
    await create("note.md", "[h](horses.md)");
    const res = await kernel.links.repair(ctx, "notes");
    expect(res.repaired).toEqual([]);
    expect(res.skipped).toEqual([]);
  });

  it("every repair is a normal authored version (advances the chain)", async () => {
    const target = await create("horses.md", "neigh");
    const note = await create("note.md", "[h](horses.md)");
    await kernel.docs.put(ctx, "notes", target.version_id, "animals/horses.md", {});
    await kernel.links.repair(ctx, "notes");
    const after = await kernel.docs.get(ctx, "notes", "note.md");
    expect(after.prev_version_id).toBe(note.version_id);
    expect(after.author).toBe("alice");
  });

  it("skips documents the caller cannot read (scope)", async () => {
    const target = await create("horses.md", "neigh");
    await create("locked/note.md", "[h](/horses.md)");
    await kernel.docs.put(ctx, "notes", target.version_id, "animals/horses.md", {});

    const scoped: CallContext = {
      author: "alice",
      scope: [{ repo: "notes", read: ["**", "!locked/**"] }],
    };
    const res = await kernel.links.repair(scoped, "notes");
    expect(res.repaired).toEqual([]);
    expect(res.skipped).toEqual([{ path: "locked/note.md", reason: "forbidden" }]);
    // Body untouched.
    expect(await bodyAt("locked/note.md")).toBe("[h](/horses.md)");
  });
});
