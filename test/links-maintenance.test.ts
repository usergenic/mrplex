/**
 * Links write-path maintenance (design §11.2, links-plan.md WS3).
 *
 * Exercises the in-transaction link index: extraction + resolution on
 * create/put, identity-bound moves, delete clearing outbound edges, and
 * dangling re-resolution on create/move-in/restore. Runs against the
 * SQLite adapter directly and inspects the `links` rows the kernel wrote;
 * WS7 lifts the cross-cutting cases into the shared kernel suite for
 * Postgres parity.
 *
 * Coverage errs deliberately toward redundancy — the index must be exactly
 * consistent with the live corpus after every write.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../src/kernel/auth/actor.js";
import { type Kernel, createKernel } from "../src/kernel/kernel.js";
import { BODY_FIELD } from "../src/links/extract.js";
import { sqliteAdapter } from "../src/storage-sqlite/adapter.js";
import type { LinkRow, Storage } from "../src/storage/types.js";

let storage: Storage;
let kernel: Kernel;
let actor: Actor;
let repoId: number;

async function fresh(): Promise<Storage> {
  return sqliteAdapter.open({
    database: `sqlite:${join(tmpdir(), `mrplex-links-${Date.now()}-${Math.random()}.db`)}`,
  });
}

// A repo whose link config opts into two frontmatter reference fields, so
// frontmatter-edge extraction is exercised too.
async function withFrontmatterFields(): Promise<void> {
  await storage.repos_set_link_config(repoId, JSON.stringify({ fields: ["parent", "related"] }));
}

async function withFields(...fields: string[]): Promise<void> {
  await storage.repos_set_link_config(repoId, JSON.stringify({ fields }));
}

beforeEach(async () => {
  storage = await fresh();
  kernel = createKernel(storage);
  const alice = await storage.users_create({ slug: "alice", created_at: "2026-08-14T00:00:00Z" });
  const notes = await storage.repos_create({ slug: "notes", created_at: "2026-08-14T00:00:01Z" });
  repoId = notes.id;
  actor = { user_id: alice.id, admin: true, scopes: [] };
});

afterEach(async () => {
  await storage.close();
});

/**
 * create() shorthand — supplies empty frontmatter by default so tests read
 * cleanly. Pass `frontmatter` explicitly to exercise frontmatter edges.
 */
function create(path: string, input: { body: string; frontmatter?: Record<string, unknown> }) {
  const fm = input.frontmatter ? { frontmatter: input.frontmatter } : { frontmatter_raw: "" };
  return kernel.docs.create(actor, "notes", path, { ...fm, body: input.body });
}

/** Document id of the live doc at `path`. */
async function docIdAt(path: string): Promise<number> {
  const v = await storage.version_current(repoId, path);
  if (!v) throw new Error(`no live doc at ${path}`);
  return v.document_id;
}

/** Outbound edges of the doc currently at `path`, ordered. */
async function edgesFrom(path: string): Promise<LinkRow[]> {
  return storage.links_by_source(await docIdAt(path));
}

describe("outbound extraction on create", () => {
  it("records an inline link as a $body edge, resolved to the target doc", async () => {
    const target = await create("horses.md", { body: "neigh" });
    await create("note.md", { body: "see [horses](horses.md)" });

    const edges = await edgesFrom("note.md");
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      field: BODY_FIELD,
      target_raw: "horses.md",
      target_norm: "horses.md",
    });
    // Bound to the target's document identity.
    const targetDocId = await docIdAt("horses.md");
    expect(edges[0]?.target_id).toBe(targetDocId);
    // sanity: the wire version_id belongs to that document
    expect(target.repo).toBe("notes");
  });

  it("records a link to a not-yet-existing target as dangling (target_id null)", async () => {
    await create("note.md", { body: "see [ghost](ghost.md)" });
    const edges = await edgesFrom("note.md");
    expect(edges).toHaveLength(1);
    expect(edges[0]?.target_id).toBeNull();
    expect(edges[0]?.target_norm).toBe("ghost.md");
  });

  it("records multiple edges in document order with dense ords", async () => {
    await create("a.md", { body: "a" });
    await create("b.md", { body: "b" });
    await create("note.md", {
      body: "[a](a.md) then [ext](https://example.com) then [b](b.md)",
    });
    const edges = await edgesFrom("note.md");
    // The external link is dropped; ords stay dense 0,1.
    expect(edges.map((e) => e.target_raw)).toEqual(["a.md", "b.md"]);
    expect(edges.map((e) => e.ord)).toEqual([0, 1]);
  });

  it("records a wikilink resolved via .md elision", async () => {
    await create("alice.md", { body: "hi" });
    await create("moc.md", { body: "- [[alice]]" });
    const edges = await edgesFrom("moc.md");
    expect(edges).toHaveLength(1);
    expect(edges[0]?.target_raw).toBe("alice.md");
    expect(edges[0]?.target_id).toBe(await docIdAt("alice.md"));
  });

  it("records frontmatter-field edges when the repo opts in", async () => {
    await withFrontmatterFields();
    await create("moc/employees.md", { body: "team" });
    await create("alice.md", {
      frontmatter: { parent: "moc/employees.md", related: ["bob.md"] },
      body: "hi",
    });
    const edges = await edgesFrom("alice.md");
    expect(edges.map((e) => ({ field: e.field, target: e.target_raw }))).toEqual([
      { field: "parent", target: "moc/employees.md" },
      { field: "related", target: "bob.md" },
    ]);
    // parent resolves (target exists); related is dangling (bob.md absent).
    expect(edges[0]?.target_id).toBe(await docIdAt("moc/employees.md"));
    expect(edges[1]?.target_id).toBeNull();
  });

  it("resolves a nested-object frontmatter field (project.lead) to identity", async () => {
    await withFields("project.lead");
    await create("people/lead.md", { body: "the lead" });
    await create("proj.md", {
      frontmatter: { project: { lead: "people/lead.md" } },
      body: "a project",
    });
    const edges = await edgesFrom("proj.md");
    expect(edges).toHaveLength(1);
    expect(edges[0]?.field).toBe("project.lead");
    expect(edges[0]?.target_id).toBe(await docIdAt("people/lead.md"));
  });

  it("resolves a frontmatter reference RELATIVE to the source doc's directory", async () => {
    // A bare (non-absolute) frontmatter path resolves like a CommonMark
    // relative link — against the source's own directory, not the repo root.
    await withFields("parent");
    await create("team/lead.md", { body: "lead" });
    await create("team/alice.md", {
      frontmatter: { parent: "lead.md" }, // relative → team/lead.md
      body: "alice",
    });
    const edges = await edgesFrom("team/alice.md");
    expect(edges[0]?.target_raw).toBe("team/lead.md");
    expect(edges[0]?.target_id).toBe(await docIdAt("team/lead.md"));
  });

  it("resolves a repo-absolute frontmatter reference (leading slash) from the root", async () => {
    await withFields("parent");
    await create("moc.md", { body: "root moc" });
    await create("deep/nested/note.md", {
      frontmatter: { parent: "/moc.md" }, // absolute → moc.md at root
      body: "note",
    });
    const edges = await edgesFrom("deep/nested/note.md");
    expect(edges[0]?.target_raw).toBe("moc.md");
    expect(edges[0]?.target_id).toBe(await docIdAt("moc.md"));
  });

  it("a dangling frontmatter field re-binds when its target is created", async () => {
    await withFields("parent");
    await create("child.md", { frontmatter: { parent: "/hub.md" }, body: "c" });
    expect((await edgesFrom("child.md"))[0]?.target_id).toBeNull();
    await create("hub.md", { body: "hub" });
    expect((await edgesFrom("child.md"))[0]?.target_id).toBe(await docIdAt("hub.md"));
  });

  it("writes no edges for a document with no links", async () => {
    await create("plain.md", { body: "no links here" });
    expect(await edgesFrom("plain.md")).toEqual([]);
  });

  it("drops links inside code fences (extraction is a real parse)", async () => {
    await create("code.md", {
      body: "```\n[nope](nope.md)\n```\nbut [yes](yes.md)",
    });
    const edges = await edgesFrom("code.md");
    expect(edges.map((e) => e.target_raw)).toEqual(["yes.md"]);
  });
});

describe("self-links are never indexed (noise suppression)", () => {
  it("drops an inline link to the document's own path", async () => {
    await create("self.md", { body: "see [me](self.md) and [other](other.md)" });
    // Only the edge to other.md survives; the self-edge is dropped, ords dense.
    const edges = await edgesFrom("self.md");
    expect(edges.map((e) => e.target_raw)).toEqual(["other.md"]);
    expect(edges.map((e) => e.ord)).toEqual([0]);
  });

  it("drops a self-link written as a bare relative path", async () => {
    await create("dir/note.md", { body: "[self](note.md)" }); // resolves to dir/note.md
    expect(await edgesFrom("dir/note.md")).toEqual([]);
  });

  it("drops a self-link written repo-absolute", async () => {
    await create("dir/note.md", { body: "[self](/dir/note.md)" });
    expect(await edgesFrom("dir/note.md")).toEqual([]);
  });

  it("drops a self-referential wikilink", async () => {
    await create("alice.md", { body: "I am [[alice]]" });
    expect(await edgesFrom("alice.md")).toEqual([]);
  });

  it("drops a self-link via a frontmatter field", async () => {
    await withFields("canonical");
    await create("page.md", { frontmatter: { canonical: "page.md" }, body: "x" });
    expect(await edgesFrom("page.md")).toEqual([]);
  });

  it("keeps a self-referencing anchor out of the index too", async () => {
    // [top](self.md#intro) still targets the same document → dropped.
    await create("self.md", { body: "[top](self.md#intro)" });
    expect(await edgesFrom("self.md")).toEqual([]);
  });

  it("a doc does NOT appear in its own $backlinks / $links", async () => {
    await create("hub.md", { body: "[me](hub.md) and [a](a.md)" });
    await create("a.md", { body: "x" });
    const docId = await docIdAt("hub.md");
    const rows = await storage.links_by_source(docId);
    // Only the a.md edge; none pointing back at hub.md.
    expect(rows.every((r) => r.target_id !== docId)).toBe(true);
  });

  it("a self-link created BEFORE the doc existed at that path stays dropped on move", async () => {
    // b.md links to (future) c.md — dangling. Move b.md → c.md: the edge now
    // targets the doc itself and must NOT bind as a self-link.
    const b = await create("b.md", { body: "[future](c.md)" });
    expect((await edgesFrom("b.md"))[0]?.target_id).toBeNull();
    await kernel.docs.put(actor, "notes", b.version_id, "c.md", {});
    // After the move the doc lives at c.md; its own edge to c.md is dropped.
    expect(await edgesFrom("c.md")).toEqual([]);
  });
});

describe("re-extraction on put (in-place update)", () => {
  it("replaces the outbound set when the body changes", async () => {
    await create("a.md", { body: "a" });
    await create("b.md", { body: "b" });
    const v1 = await create("note.md", { body: "[a](a.md)" });
    expect((await edgesFrom("note.md")).map((e) => e.target_raw)).toEqual(["a.md"]);

    await kernel.docs.put(actor, "notes", v1.version_id, "note.md", { body: "[b](b.md)" });
    expect((await edgesFrom("note.md")).map((e) => e.target_raw)).toEqual(["b.md"]);
  });

  it("clears edges when an update removes all links", async () => {
    await create("a.md", { body: "a" });
    const v1 = await create("note.md", { body: "[a](a.md)" });
    expect(await edgesFrom("note.md")).toHaveLength(1);
    await kernel.docs.put(actor, "notes", v1.version_id, "note.md", { body: "no more links" });
    expect(await edgesFrom("note.md")).toEqual([]);
  });

  it("re-extracts frontmatter edges when frontmatter changes", async () => {
    await withFrontmatterFields();
    await create("p1.md", { body: "1" });
    await create("p2.md", { body: "2" });
    const v1 = await create("child.md", {
      frontmatter: { parent: "p1.md" },
      body: "c",
    });
    expect((await edgesFrom("child.md"))[0]?.target_id).toBe(await docIdAt("p1.md"));

    await kernel.docs.put(actor, "notes", v1.version_id, "child.md", {
      frontmatter: { parent: "p2.md" },
    });
    const edges = await edgesFrom("child.md");
    expect(edges).toHaveLength(1);
    expect(edges[0]?.target_raw).toBe("p2.md");
    expect(edges[0]?.target_id).toBe(await docIdAt("p2.md"));
  });
});

describe("moves are identity-bound (no inbound churn)", () => {
  it("keeps an inbound edge resolved after the target moves", async () => {
    const target = await create("horses.md", { body: "neigh" });
    await create("note.md", { body: "[h](horses.md)" });
    const targetDocId = await docIdAt("horses.md");
    expect((await edgesFrom("note.md"))[0]?.target_id).toBe(targetDocId);

    // Move the target; the inbound edge must still resolve to the same doc id.
    await kernel.docs.put(actor, "notes", target.version_id, "animals/horses.md", {});
    const edges = await edgesFrom("note.md");
    expect(edges[0]?.target_id).toBe(targetDocId); // unchanged — identity-bound
    // The written link text is now stale (still says horses.md) — that's a
    // links.stale/repair concern (WS5), not a re-extraction concern.
    expect(edges[0]?.target_raw).toBe("horses.md");
  });

  it("recasing the source path re-extracts under the same document", async () => {
    await create("a.md", { body: "a" });
    const v1 = await create("note.md", { body: "[a](a.md)" });
    const docId = await docIdAt("note.md");
    await kernel.docs.put(actor, "notes", v1.version_id, "Note.md", {});
    // Same document, edges preserved.
    expect(await docIdAt("Note.md")).toBe(docId);
    expect((await storage.links_by_source(docId)).map((e) => e.target_raw)).toEqual(["a.md"]);
  });
});

describe("dangling re-resolution", () => {
  it("binds a waiting dangler when the target is created", async () => {
    await create("note.md", { body: "[future](future.md)" });
    expect((await edgesFrom("note.md"))[0]?.target_id).toBeNull();

    await create("future.md", { body: "arrived" });
    const futureDocId = await docIdAt("future.md");
    expect((await edgesFrom("note.md"))[0]?.target_id).toBe(futureDocId);
  });

  it("binds a waiting dangler when a doc MOVES into the named path", async () => {
    await create("note.md", { body: "[t](target.md)" });
    const other = await create("elsewhere.md", { body: "x" });
    expect((await edgesFrom("note.md"))[0]?.target_id).toBeNull();

    await kernel.docs.put(actor, "notes", other.version_id, "target.md", {});
    expect((await edgesFrom("note.md"))[0]?.target_id).toBe(await docIdAt("target.md"));
  });

  it("binds a dangler case-insensitively (Alice.md ← [[alice]])", async () => {
    await create("moc.md", { body: "[[alice]]" });
    expect((await edgesFrom("moc.md"))[0]?.target_id).toBeNull();
    // A differently-cased document satisfies the folded target key.
    await create("Alice.md", { body: "hi" });
    expect((await edgesFrom("moc.md"))[0]?.target_id).toBe(await docIdAt("Alice.md"));
  });

  it("binds multiple waiting danglers from different sources at once", async () => {
    await create("n1.md", { body: "[t](hub.md)" });
    await create("n2.md", { body: "[[hub]]" });
    expect((await edgesFrom("n1.md"))[0]?.target_id).toBeNull();
    expect((await edgesFrom("n2.md"))[0]?.target_id).toBeNull();

    await create("hub.md", { body: "central" });
    const hub = await docIdAt("hub.md");
    expect((await edgesFrom("n1.md"))[0]?.target_id).toBe(hub);
    expect((await edgesFrom("n2.md"))[0]?.target_id).toBe(hub);
  });
});

describe("delete clears outbound, preserves inbound", () => {
  it("clears the deleted doc's outbound edges", async () => {
    await create("a.md", { body: "a" });
    const v = await create("note.md", { body: "[a](a.md)" });
    const docId = await docIdAt("note.md");
    expect(await storage.links_by_source(docId)).toHaveLength(1);

    await kernel.docs.delete(actor, "notes", v.version_id);
    expect(await storage.links_by_source(docId)).toEqual([]);
  });

  it("leaves inbound edges bound after the target is deleted (visibility hides them)", async () => {
    const target = await create("horses.md", { body: "neigh" });
    await create("note.md", { body: "[h](horses.md)" });
    const targetDocId = await docIdAt("horses.md");
    expect((await edgesFrom("note.md"))[0]?.target_id).toBe(targetDocId);

    await kernel.docs.delete(actor, "notes", target.version_id);
    // Inbound edge is still bound to the (now-deleted) document id.
    expect((await edgesFrom("note.md"))[0]?.target_id).toBe(targetDocId);
  });

  it("re-binds inbound danglers when a document is restored to its path", async () => {
    const target = await create("horses.md", { body: "neigh" });
    await create("note.md", { body: "[h](horses.md)" });
    const deleted = await kernel.docs.delete(actor, "notes", target.version_id);
    // Restore: put the deleted version back to a user-territory path.
    await kernel.docs.put(actor, "notes", deleted.version_id, "horses.md", {});
    // The (kept-bound) inbound edge still resolves; the restored doc keeps
    // its identity, so nothing needed rebinding — assert it resolves live.
    const restoredDocId = await docIdAt("horses.md");
    expect((await edgesFrom("note.md"))[0]?.target_id).toBe(restoredDocId);
  });
});

describe("index stays consistent with the live corpus (redundant end-to-end)", () => {
  it("a full lifecycle leaves exactly the expected edges", async () => {
    await create("a.md", { body: "a" });
    const note = await create("note.md", {
      body: "[a](a.md) and [b](b.md)",
    });
    // b.md dangling initially
    let edges = await edgesFrom("note.md");
    expect(edges.map((e) => e.target_id !== null)).toEqual([true, false]);

    // create b.md → dangler binds
    await create("b.md", { body: "b" });
    edges = await edgesFrom("note.md");
    expect(edges.map((e) => e.target_id !== null)).toEqual([true, true]);

    // update note to drop the a.md link
    await kernel.docs.put(actor, "notes", note.version_id, "note.md", { body: "only [b](b.md)" });
    edges = await edgesFrom("note.md");
    expect(edges.map((e) => e.target_raw)).toEqual(["b.md"]);
    expect(edges[0]?.target_id).toBe(await docIdAt("b.md"));
  });
});
