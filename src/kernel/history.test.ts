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
