/**
 * history.since — the global change feed (sync/history plan §3.3): op
 * derivation, prev_path resolution, resume, repo filter, and scope visibility.
 */

import { describe, expect, it } from "vitest";
import { sqliteAdapter } from "../storage-sqlite/adapter.js";
import type { Storage } from "../storage/types.js";
import type { CallContext } from "./context.js";
import { deriveOp } from "./history.js";
import { createKernel } from "./kernel.js";

async function bootstrap() {
  const storage: Storage = await sqliteAdapter.open({ database: "sqlite::memory:" });
  const kernel = createKernel(storage);
  await storage.repos_create({ slug: "notes", created_at: "2026-08-14T00:00:00Z" });
  const actor: CallContext = {};
  return { storage, kernel, actor };
}

describe("deriveOp", () => {
  const sys = (p: string) => p.startsWith(":");
  it("no prev → create", () => {
    expect(deriveOp(false, "a.md", null, sys)).toBe("create");
  });
  it("same path → update", () => {
    expect(deriveOp(true, "a.md", "a.md", sys)).toBe("update");
  });
  it("new path in system namespace → delete", () => {
    expect(deriveOp(true, ":deleted/a-v3.md", "a.md", sys)).toBe("delete");
  });
  it("other new path → move", () => {
    expect(deriveOp(true, "b.md", "a.md", sys)).toBe("move");
  });
});

describe("history.since", () => {
  it("emits create then update ops with resume", async () => {
    const { kernel, actor } = await bootstrap();
    const v1 = await kernel.docs.create(actor, "notes", "a.md", {
      body: "1\n",
      frontmatter_raw: "",
    });
    await kernel.docs.put(actor, "notes", v1.version_id, "a.md", {
      body: "2\n",
      frontmatter_raw: "",
    });
    const page = await kernel.history.since(actor, { after_version: "" });
    expect(page.refs.map((r) => r.op)).toEqual(["create", "update"]);
    expect(page.refs[0]?.path).toBe("a.md");
    expect(page.refs[1]?.prev_path).toBe("a.md");
    // content_hash travels on refs.
    expect(page.refs[0]?.content_hash).toBe(v1.content_hash);
    // Resuming from next_since yields nothing new.
    const again = await kernel.history.since(actor, { after_version: page.next_since });
    expect(again.refs).toEqual([]);
    expect(again.next_since).toBe(page.next_since);
  });

  it("derives move and delete ops with both path endpoints", async () => {
    const { kernel, actor } = await bootstrap();
    const v1 = await kernel.docs.create(actor, "notes", "a.md", {
      body: "x\n",
      frontmatter_raw: "",
    });
    const v2 = await kernel.docs.put(actor, "notes", v1.version_id, "b.md", {
      body: "x\n",
      frontmatter_raw: "",
    });
    await kernel.docs.delete(actor, "notes", v2.version_id);
    const page = await kernel.history.since(actor, { after_version: "" });
    const move = page.refs.find((r) => r.op === "move");
    expect(move?.prev_path).toBe("a.md");
    expect(move?.path).toBe("b.md");
    const del = page.refs.find((r) => r.op === "delete");
    expect(del?.prev_path).toBe("b.md");
    expect(del?.path.startsWith(":deleted/")).toBe(true);
  });

  it("respects the limit and resumes across pages", async () => {
    const { kernel, actor } = await bootstrap();
    for (const p of ["a.md", "b.md", "c.md"]) {
      await kernel.docs.create(actor, "notes", p, { body: "x\n", frontmatter_raw: "" });
    }
    const first = await kernel.history.since(actor, { after_version: "", limit: 2 });
    expect(first.refs.map((r) => r.path)).toEqual(["a.md", "b.md"]);
    const rest = await kernel.history.since(actor, { after_version: first.next_since });
    expect(rest.refs.map((r) => r.path)).toEqual(["c.md"]);
  });

  it("filters by repo", async () => {
    const { storage, kernel, actor } = await bootstrap();
    await storage.repos_create({ slug: "other", created_at: "2026-08-14T00:00:00Z" });
    await kernel.docs.create(actor, "notes", "n.md", { body: "x\n", frontmatter_raw: "" });
    await kernel.docs.create(actor, "other", "o.md", { body: "x\n", frontmatter_raw: "" });
    const page = await kernel.history.since(actor, { after_version: "", repo: "notes" });
    expect(page.refs.map((r) => r.repo)).toEqual(["notes"]);
    expect(page.refs.map((r) => r.path)).toEqual(["n.md"]);
  });
});

describe("history.index", () => {
  it("enumerates the live set with content_hash, capturing R on the first call", async () => {
    const { kernel, actor } = await bootstrap();
    const va = await kernel.docs.create(actor, "notes", "a.md", {
      body: "1\n",
      frontmatter_raw: "",
    });
    await kernel.docs.create(actor, "notes", "b.md", { body: "2\n", frontmatter_raw: "" });
    const page = await kernel.history.index(actor, { repo: "notes" });
    expect(page.items.map((i) => i.path)).toEqual(["a.md", "b.md"]);
    expect(page.items[0]?.content_hash).toBe(va.content_hash);
    expect(page.through_version).not.toBe("v0");
    expect(page.next_after_version).toBeUndefined(); // single final page
  });

  it("reflects only the current version of an updated doc (not history)", async () => {
    const { kernel, actor } = await bootstrap();
    const v1 = await kernel.docs.create(actor, "notes", "a.md", {
      body: "1\n",
      frontmatter_raw: "",
    });
    const v2 = await kernel.docs.put(actor, "notes", v1.version_id, "a.md", {
      body: "2\n",
      frontmatter_raw: "",
    });
    const page = await kernel.history.index(actor, { repo: "notes" });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.version_id).toBe(v2.version_id);
  });

  it("excludes deleted (system-namespace) documents", async () => {
    const { kernel, actor } = await bootstrap();
    const v = await kernel.docs.create(actor, "notes", "gone.md", {
      body: "x\n",
      frontmatter_raw: "",
    });
    await kernel.docs.delete(actor, "notes", v.version_id);
    await kernel.docs.create(actor, "notes", "live.md", { body: "y\n", frontmatter_raw: "" });
    const page = await kernel.history.index(actor, { repo: "notes" });
    expect(page.items.map((i) => i.path)).toEqual(["live.md"]);
  });

  it("keyset-paginates through R and echoes it across pages", async () => {
    const { kernel, actor } = await bootstrap();
    for (const p of ["a.md", "b.md", "c.md", "d.md"]) {
      await kernel.docs.create(actor, "notes", p, { body: "x\n", frontmatter_raw: "" });
    }
    const p1 = await kernel.history.index(actor, { repo: "notes", limit: 2 });
    expect(p1.items.map((i) => i.path)).toEqual(["a.md", "b.md"]);
    expect(p1.next_after_version).toBeDefined();
    const p2 = await kernel.history.index(actor, {
      repo: "notes",
      through_version: p1.through_version,
      after_version: p1.next_after_version,
      limit: 2,
    });
    expect(p2.through_version).toBe(p1.through_version); // R echoed
    expect(p2.items.map((i) => i.path)).toEqual(["c.md", "d.md"]);
    expect(p2.next_after_version).toBeUndefined();
  });

  it("handoff invariant: a doc created after R is absent from index but on the feed exactly once", async () => {
    const { kernel, actor } = await bootstrap();
    await kernel.docs.create(actor, "notes", "a.md", { body: "1\n", frontmatter_raw: "" });
    // First page captures R at the current tip.
    const p1 = await kernel.history.index(actor, { repo: "notes", limit: 1 });
    const R = p1.through_version;
    // A concurrent create lands AFTER R.
    await kernel.docs.create(actor, "notes", "late.md", { body: "2\n", frontmatter_raw: "" });
    // Continue paginating the index through the SAME R: late.md must not appear.
    let after = p1.next_after_version;
    const indexPaths = [...p1.items.map((i) => i.path)];
    while (after !== undefined) {
      const page = await kernel.history.index(actor, {
        repo: "notes",
        through_version: R,
        after_version: after,
        limit: 1,
      });
      indexPaths.push(...page.items.map((i) => i.path));
      after = page.next_after_version;
    }
    expect(indexPaths).toEqual(["a.md"]); // late.md excluded (id > R)
    // history.since(R) delivers late.md exactly once.
    const feed = await kernel.history.since(actor, { after_version: R });
    expect(feed.refs.map((r) => r.path)).toEqual(["late.md"]);
  });
});
