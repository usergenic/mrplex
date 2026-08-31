/**
 * Remote → local feed application (sync/history plan §4.3). Drives the real
 * applyFeed against a local-kernel KernelClient and an in-memory FileStore,
 * exercising the corner cases the plan calls load-bearing: move, delete
 * (clean vs. dirty), conflict parking, provenance-only repair, $sync: ignore,
 * and idempotent replay (§4.3 crash-between-apply-and-advance).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KernelClient } from "../src/client/kernel-client.js";
import { openLocalClient } from "../src/client/local.js";
import { applyFeed } from "../src/sync/feed.js";
import { makeScopeFilter } from "../src/sync/paths.js";
import type { FileStore } from "../src/sync/reconcile.js";

let client: KernelClient;

function memStore(initial?: Record<string, string>): FileStore & {
  files: Map<string, string>;
  mtimes: Map<string, number>;
} {
  const files = new Map<string, string>(Object.entries(initial ?? {}));
  const mtimes = new Map<string, number>();
  return {
    files,
    mtimes,
    async list() {
      return [...files.keys()];
    },
    async read(p) {
      return files.get(p) ?? null;
    },
    async write(p, text) {
      files.set(p, text);
    },
    async remove(p) {
      files.delete(p);
      mtimes.delete(p);
    },
    async mtime(p) {
      if (!files.has(p)) return null;
      return mtimes.get(p) ?? 0; // default cold
    },
  };
}

const scope = makeScopeFilter();

beforeEach(async () => {
  client = await openLocalClient({ database: "sqlite::memory:", context: {} });
  await client.repos.create("notes");
});

afterEach(async () => {
  await client.close();
});

/** Drain the whole feed from the beginning into `store`. */
function drain(store: FileStore, map?: Parameters<typeof applyFeed>[3]["map"]) {
  return applyFeed(client, store, scope, { repo: "notes", since: "", map });
}

/** Materialize a Version as a file (docs.get injects intrinsics). */
function materialized(v: { frontmatter_raw: string; body: string }): string {
  if (v.frontmatter_raw === "") return v.body;
  const raw = v.frontmatter_raw.endsWith("\n") ? v.frontmatter_raw : `${v.frontmatter_raw}\n`;
  return `---\n${raw}---\n${v.body}`;
}

describe("applyFeed — create / update", () => {
  it("materializes creates and updates into an empty store", async () => {
    const v1 = await client.docs.create("notes", "a.md", { body: "1\n", frontmatter_raw: "" });
    await client.docs.put("notes", v1.version_id, "a.md", { body: "2\n", frontmatter_raw: "" });
    await client.docs.create("notes", "b.md", { body: "b\n", frontmatter_raw: "" });
    const store = memStore();
    const { applied } = await drain(store);
    expect(applied).toBeGreaterThan(0);
    expect(store.files.get("a.md")).toContain("2");
    expect(store.files.get("b.md")).toContain("b");
  });

  it("provenance-only repair when bytes match but embedded version lags", async () => {
    const v1 = await client.docs.create("notes", "a.md", { body: "same\n", frontmatter_raw: "" });
    const v2 = await client.docs.put("notes", v1.version_id, "a.md", {
      body: "same\n", // identical bytes → same content_hash across v1, v2
      frontmatter_raw: "",
    });
    // Local file already holds v2's bytes but is stamped with v1.
    const store = memStore({
      "a.md": materialized(await client.docs.get_version("notes", v1.version_id)),
    });
    await drain(store);
    // Repaired in place to v2 (same bytes, new provenance).
    expect(store.files.get("a.md")).toContain(`$version: ${v2.version_id}`);
  });
});

describe("applyFeed — move", () => {
  it("renames a clean source and materializes at the destination", async () => {
    const v1 = await client.docs.create("notes", "old.md", { body: "x\n", frontmatter_raw: "" });
    // Seed the store as if old.md were already materialized clean.
    const store = memStore({
      "old.md": materialized(await client.docs.get_version("notes", v1.version_id)),
    });
    // Remote move old.md → new.md.
    await client.docs.put("notes", v1.version_id, "new.md", { body: "x\n", frontmatter_raw: "" });
    // Drain only the move ref (from the cursor just before it).
    await applyFeed(client, store, scope, { repo: "notes", since: v1.version_id });
    expect(store.files.has("old.md")).toBe(false); // clean source removed
    expect(store.files.get("new.md")).toContain("x");
  });

  it("rebases a dirty destination onto the moved remote instead of parking", async () => {
    const v1 = await client.docs.create("notes", "old.md", { body: "x\n", frontmatter_raw: "" });
    const store = memStore({
      "old.md": materialized(await client.docs.get_version("notes", v1.version_id)),
      // A dirty file already occupies the destination (no provenance).
      "new.md": "my local dest work\n",
    });
    await client.docs.put("notes", v1.version_id, "new.md", {
      body: "moved body\n",
      frontmatter_raw: "",
    });
    await applyFeed(client, store, scope, { repo: "notes", since: v1.version_id });
    // Local destination bytes become the new head; no ignored sibling.
    expect(store.files.get("new.md")).toContain("my local dest work");
    expect([...store.files.keys()].some((k) => /-v\d+\.md$/.test(k))).toBe(false);
    const remote = await client.docs.get("notes", "new.md");
    expect(remote.body).toBe("my local dest work\n");
  });
});

describe("applyFeed — delete", () => {
  it("removes a clean local file on a remote delete", async () => {
    const v = await client.docs.create("notes", "gone.md", { body: "x\n", frontmatter_raw: "" });
    const store = memStore({
      "gone.md": materialized(await client.docs.get_version("notes", v.version_id)),
    });
    await client.docs.delete("notes", v.version_id);
    await applyFeed(client, store, scope, { repo: "notes", since: v.version_id });
    expect(store.files.has("gone.md")).toBe(false);
  });

  it("keeps a dirty local file on a remote delete (resurrection deferred)", async () => {
    const v = await client.docs.create("notes", "keep.md", { body: "x\n", frontmatter_raw: "" });
    const clean = materialized(await client.docs.get_version("notes", v.version_id));
    const dirty = clean.replace("x", "edited after delete");
    const store = memStore({ "keep.md": dirty });
    await client.docs.delete("notes", v.version_id);
    await applyFeed(client, store, scope, { repo: "notes", since: v.version_id });
    expect(store.files.get("keep.md")).toBe(dirty); // preserved
  });
});

describe("applyFeed — conflict + ignore", () => {
  it("rebases a dirty local file onto a newer incoming version (no sibling)", async () => {
    const v1 = await client.docs.create("notes", "a.md", { body: "base\n", frontmatter_raw: "" });
    const dirty = materialized(await client.docs.get_version("notes", v1.version_id)).replace(
      "base",
      "my local edit",
    );
    const store = memStore({ "a.md": dirty });
    await client.docs.put("notes", v1.version_id, "a.md", {
      body: "remote edit\n",
      frontmatter_raw: "",
    });
    await applyFeed(client, store, scope, { repo: "notes", since: v1.version_id });
    expect(store.files.get("a.md")).toContain("my local edit");
    expect([...store.files.keys()].some((k) => /-v\d+\.md$/.test(k))).toBe(false);
    const remote = await client.docs.get("notes", "a.md");
    expect(remote.body).toBe("my local edit\n");
  });

  it("does not park or clobber when local is dirty on the same $version (push echo)", async () => {
    const v1 = await client.docs.create("notes", "a.md", { body: "one\n", frontmatter_raw: "" });
    const dirty = materialized(await client.docs.get_version("notes", v1.version_id)).replace(
      "one",
      "one two",
    );
    const store = memStore({ "a.md": dirty });
    await applyFeed(client, store, scope, { repo: "notes", since: "" });
    expect(store.files.get("a.md")).toBe(dirty);
    expect([...store.files.keys()].some((k) => /-v\d+\.md$/.test(k))).toBe(false);
  });

  it("does not clobber a newer clean local with an older feed ref", async () => {
    const v1 = await client.docs.create("notes", "a.md", { body: "one\n", frontmatter_raw: "" });
    const v2 = await client.docs.put("notes", v1.version_id, "a.md", {
      body: "two\n",
      frontmatter_raw: "",
    });
    const store = memStore({
      "a.md": materialized(await client.docs.get_version("notes", v2.version_id)),
    });
    await applyFeed(client, store, scope, { repo: "notes", since: "" });
    expect(store.files.get("a.md")).toContain("two");
    expect(store.files.get("a.md")).not.toContain("one");
  });

  it("leaves a $sync: ignore local file untouched", async () => {
    const v1 = await client.docs.create("notes", "a.md", { body: "orig\n", frontmatter_raw: "" });
    const ignored = "---\n$sync: ignore\n---\nmy private copy\n";
    const store = memStore({ "a.md": ignored });
    await client.docs.put("notes", v1.version_id, "a.md", {
      body: "remote change\n",
      frontmatter_raw: "",
    });
    await drain(store);
    expect(store.files.get("a.md")).toBe(ignored);
  });
});

describe("applyFeed — idempotent replay (§4.3)", () => {
  it("converges to the same bytes with no duplicate siblings on full replay", async () => {
    const v1 = await client.docs.create("notes", "a.md", { body: "1\n", frontmatter_raw: "" });
    await client.docs.put("notes", v1.version_id, "a.md", { body: "2\n", frontmatter_raw: "" });
    await client.docs.create("notes", "b.md", { body: "b\n", frontmatter_raw: "" });
    const store = memStore();
    const first = await drain(store);
    const snapshot = new Map(store.files);
    const second = await drain(store); // replay from the beginning
    // The §4.3 guarantee: same bytes → same file. Final state is identical…
    expect(store.files).toEqual(snapshot);
    // …and no conflict siblings are sprayed by the replay.
    expect([...store.files.keys()].some((k) => /-v\d+\.md$/.test(k))).toBe(false);
    expect(first.cursor).toBe(second.cursor);
  });

  it("re-applying the last page (crash-before-advance) is a true no-op", async () => {
    // The realistic replay: the daemon advances the cursor only after fs
    // effects, so a crash re-applies only the current page — one ref per path,
    // each already reflected on disk → applied is 0 and nothing changes.
    await client.docs.create("notes", "a.md", { body: "1\n", frontmatter_raw: "" });
    await client.docs.create("notes", "b.md", { body: "2\n", frontmatter_raw: "" });
    const store = memStore();
    const first = await drain(store);
    const snapshot = new Map(store.files);
    // Re-apply from the SAME resume cursor the crash would have left behind
    // minus the advance — i.e. replay from the beginning of the applied page.
    const replay = await applyFeed(client, store, scope, { repo: "notes", since: "" });
    expect(replay.applied).toBe(0);
    expect(store.files).toEqual(snapshot);
    expect(replay.cursor).toBe(first.cursor);
  });
});

describe("applyFeed — settle / defer (better-sync)", () => {
  it("defers inbound rebase on a hot file and still advances the cursor", async () => {
    const v1 = await client.docs.create("notes", "a.md", { body: "base\n", frontmatter_raw: "" });
    const dirty = materialized(await client.docs.get_version("notes", v1.version_id)).replace(
      "base",
      "my local edit",
    );
    const store = memStore({ "a.md": dirty });
    store.mtimes.set("a.md", 10_000);
    const v2 = await client.docs.put("notes", v1.version_id, "a.md", {
      body: "remote edit\n",
      frontmatter_raw: "",
    });
    const deferred = new Map();
    const result = await applyFeed(client, store, scope, {
      repo: "notes",
      since: v1.version_id,
      settleMs: 5_000,
      deferred,
      nowMs: () => 12_000,
    });
    expect(store.files.get("a.md")).toBe(dirty);
    expect([...store.files.keys()].some((k) => /-v\d+\.md$/.test(k))).toBe(false);
    expect(deferred.has("a.md")).toBe(true);
    expect(deferred.get("a.md")?.ref.version_id).toBe(v2.version_id);
    expect(result.deferred).toBeGreaterThan(0);
    expect(result.cursor).not.toBe(v1.version_id);
  });

  it("does not defer when settleMs is 0 even if mtime is fresh", async () => {
    const v1 = await client.docs.create("notes", "a.md", { body: "base\n", frontmatter_raw: "" });
    const dirty = materialized(await client.docs.get_version("notes", v1.version_id)).replace(
      "base",
      "my local edit",
    );
    const store = memStore({ "a.md": dirty });
    store.mtimes.set("a.md", Date.now());
    await client.docs.put("notes", v1.version_id, "a.md", {
      body: "remote edit\n",
      frontmatter_raw: "",
    });
    const deferred = new Map();
    await applyFeed(client, store, scope, {
      repo: "notes",
      since: v1.version_id,
      settleMs: 0,
      deferred,
    });
    expect(deferred.size).toBe(0);
    expect(store.files.get("a.md")).toContain("my local edit");
    expect(await client.docs.get("notes", "a.md")).toMatchObject({ body: "my local edit\n" });
  });
});
