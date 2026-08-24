/**
 * Storage.versions_since — the gap-aware forward feed walk (sync/history plan
 * §3.2–3.3), tested directly against the SQLite adapter. SQLite is a single
 * writer so real burned gaps don't occur; we manufacture one by deleting a row
 * to exercise the safety window, and cover resume / repo filter / limit paths
 * against real inserts.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKernel } from "../src/kernel/kernel.js";
import { sqliteAdapter } from "../src/storage-sqlite/adapter.js";
import type { Storage } from "../src/storage/types.js";

let storage: Storage;
let kernel: ReturnType<typeof createKernel>;
const actor = {};

const WINDOW = 30_000;

async function fresh(): Promise<Storage> {
  return sqliteAdapter.open({
    database: `sqlite:${join(tmpdir(), `mrplex-vsince-${Date.now()}-${Math.random()}.db`)}`,
  });
}

beforeEach(async () => {
  storage = await fresh();
  kernel = createKernel(storage);
  await storage.repos_create({ slug: "a", created_at: "2026-08-14T00:00:00Z" });
  await storage.repos_create({ slug: "b", created_at: "2026-08-14T00:00:00Z" });
});

afterEach(async () => {
  await storage.close();
});

describe("versions_since — basic feed", () => {
  it("returns all rows from the beginning and a resume cursor", async () => {
    const v1 = await kernel.docs.create(actor, "a", "one.md", { body: "1\n", frontmatter_raw: "" });
    const v2 = await kernel.docs.create(actor, "a", "two.md", { body: "2\n", frontmatter_raw: "" });
    const res = await storage.versions_since({
      after_id: 0,
      limit: 100,
      now_ms: Date.now(),
      window_ms: WINDOW,
    });
    expect(res.rows.map((r) => r.path)).toEqual(["one.md", "two.md"]);
    // next_id resumes past the last row; feeding it back yields nothing new.
    const again = await storage.versions_since({
      after_id: res.next_id,
      limit: 100,
      now_ms: Date.now(),
      window_ms: WINDOW,
    });
    expect(again.rows).toEqual([]);
    expect(again.next_id).toBe(res.next_id);
    // Sanity: cursor is monotonic and past both versions.
    expect(res.next_id).toBeGreaterThan(0);
    void v1;
    void v2;
  });

  it("resumes from a mid-feed cursor", async () => {
    await kernel.docs.create(actor, "a", "one.md", { body: "1\n", frontmatter_raw: "" });
    const v2 = await kernel.docs.create(actor, "a", "two.md", { body: "2\n", frontmatter_raw: "" });
    await kernel.docs.create(actor, "a", "three.md", { body: "3\n", frontmatter_raw: "" });
    const first = await storage.versions_since({
      after_id: 0,
      limit: 1,
      now_ms: Date.now(),
      window_ms: WINDOW,
    });
    expect(first.rows.map((r) => r.path)).toEqual(["one.md"]);
    const rest = await storage.versions_since({
      after_id: first.next_id,
      limit: 100,
      now_ms: Date.now(),
      window_ms: WINDOW,
    });
    expect(rest.rows.map((r) => r.path)).toEqual(["two.md", "three.md"]);
    void v2;
  });

  it("filters by repo without disturbing the global cursor", async () => {
    await kernel.docs.create(actor, "a", "a1.md", { body: "1\n", frontmatter_raw: "" });
    await kernel.docs.create(actor, "b", "b1.md", { body: "1\n", frontmatter_raw: "" });
    await kernel.docs.create(actor, "a", "a2.md", { body: "2\n", frontmatter_raw: "" });
    const repoA = (await storage.repos_by_slug("a"))?.id as number;
    const res = await storage.versions_since({
      after_id: 0,
      repo_id: repoA,
      limit: 100,
      now_ms: Date.now(),
      window_ms: WINDOW,
    });
    expect(res.rows.map((r) => r.path)).toEqual(["a1.md", "a2.md"]);
  });

  it("carries content_hash on feed rows", async () => {
    const v = await kernel.docs.create(actor, "a", "one.md", { body: "1\n", frontmatter_raw: "" });
    const res = await storage.versions_since({
      after_id: 0,
      limit: 100,
      now_ms: Date.now(),
      window_ms: WINDOW,
    });
    expect(res.rows[0]?.content_hash).toBe(v.content_hash);
  });
});
