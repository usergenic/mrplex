/**
 * Local → remote push pass (sync/history plan §4.4, §4.6, §4.7). Drives the
 * real pushPath against a local-kernel KernelClient and an in-memory FileStore,
 * exercising: clean no-op, dirty edit, create, move-via-put, witnessed delete
 * (present in map, absent on disk), stale_prev on delete, untracked unlink,
 * occupied-path adopt vs. conflict, and the create_conflict downgrade.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KernelClient } from "../src/client/kernel-client.js";
import { openLocalClient } from "../src/client/local.js";
import { type RemoteMap, pushBurst, pushPath } from "../src/sync/push.js";
import type { FileStore } from "../src/sync/reconcile.js";

let client: KernelClient;

function memStore(initial?: Record<string, string>): FileStore & { files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    files,
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
    },
  };
}

beforeEach(async () => {
  client = await openLocalClient({ database: "sqlite::memory:", context: {} });
  await client.repos.create("notes");
});

afterEach(async () => {
  await client.close();
});

function push(path: string, store: FileStore, map: RemoteMap) {
  return pushPath(path, { client, store, repo: "notes", map });
}

/** Materialize a Version as a file (docs.get injects intrinsics). */
function materialized(v: { frontmatter_raw: string; body: string }): string {
  if (v.frontmatter_raw === "") return v.body;
  const raw = v.frontmatter_raw.endsWith("\n") ? v.frontmatter_raw : `${v.frontmatter_raw}\n`;
  return `---\n${raw}---\n${v.body}`;
}

describe("pushPath — create / clean / edit", () => {
  it("creates a new local file with no provenance and no remote doc", async () => {
    const store = memStore({ "new.md": "hello\n" });
    const map: RemoteMap = new Map();
    expect(await push("new.md", store, map)).toBe("created");
    const remote = await client.docs.get("notes", "new.md");
    expect(remote.body).toBe("hello\n");
    // Local file rewritten with provenance; map updated.
    expect(store.files.get("new.md")).toContain(`$version: ${remote.version_id}`);
    expect(map.get("new.md")?.version_id).toBe(remote.version_id);
  });

  it("no-ops a clean file (hash gate) and tracks it in the map", async () => {
    const v = await client.docs.create("notes", "a.md", { body: "x\n", frontmatter_raw: "" });
    const store = memStore({
      "a.md": materialized(await client.docs.get_version("notes", v.version_id)),
    });
    const map: RemoteMap = new Map();
    expect(await push("a.md", store, map)).toBe("clean");
    expect(map.get("a.md")?.version_id).toBe(v.version_id);
  });

  it("pushes a dirty edit as an optimistic put", async () => {
    const v1 = await client.docs.create("notes", "a.md", { body: "one\n", frontmatter_raw: "" });
    const dirty = materialized(await client.docs.get_version("notes", v1.version_id)).replace(
      "one",
      "two",
    );
    const store = memStore({ "a.md": dirty });
    const map: RemoteMap = new Map();
    expect(await push("a.md", store, map)).toBe("updated");
    const cur = await client.docs.get("notes", "a.md");
    expect(cur.body).toBe("two\n");
    expect(cur.prev_version_id).toBe(v1.version_id);
  });
});

describe("pushPath — move (§4.7)", () => {
  it("a file carrying provenance at a new path pushes a move via put", async () => {
    const v1 = await client.docs.create("notes", "old.md", { body: "x\n", frontmatter_raw: "" });
    // Simulate `mv old.md new.md`: the file at new.md still embeds v1, and its
    // body differs enough to be dirty is NOT required — a move is a put with a
    // new path. Make it dirty so the hash gate doesn't short-circuit.
    const moved = materialized(await client.docs.get_version("notes", v1.version_id)).replace(
      "x",
      "x moved",
    );
    const store = memStore({ "new.md": moved });
    const map: RemoteMap = new Map([
      ["old.md", { version_id: v1.version_id, content_hash: v1.content_hash }],
    ]);
    expect(await push("new.md", store, map)).toBe("updated"); // move rides a put
    const cur = await client.docs.get("notes", "new.md");
    expect(cur.prev_version_id).toBe(v1.version_id); // identity preserved
  });

  it("a clean rename (same bytes, new path) still pushes a move", async () => {
    const v1 = await client.docs.create("notes", "old.md", { body: "x\n", frontmatter_raw: "" });
    const store = memStore({
      "new.md": materialized(await client.docs.get_version("notes", v1.version_id)),
    });
    const map: RemoteMap = new Map([
      ["old.md", { version_id: v1.version_id, content_hash: v1.content_hash }],
    ]);
    expect(await push("new.md", store, map)).toBe("updated");
    const cur = await client.docs.get("notes", "new.md");
    expect(cur.prev_version_id).toBe(v1.version_id);
    expect(cur.body).toBe("x\n");
    await expect(client.docs.get("notes", "old.md")).rejects.toThrow();
    expect(map.has("old.md")).toBe(false);
    expect(map.get("new.md")?.version_id).toBe(cur.version_id);
  });

  it("after a premature delete, a late add at the new path restores from :deleted", async () => {
    const v1 = await client.docs.create("notes", "Untitled.md", {
      body: "Gribblepibbly\n",
      frontmatter_raw: "",
    });
    const renamed = materialized(await client.docs.get_version("notes", v1.version_id));
    const store = memStore();
    const map: RemoteMap = new Map([
      ["Untitled.md", { version_id: v1.version_id, content_hash: v1.content_hash }],
    ]);
    expect(await push("Untitled.md", store, map)).toBe("deleted");
    store.files.set("brand-new-idea.md", renamed);
    expect(await push("brand-new-idea.md", store, map)).toBe("updated");
    const cur = await client.docs.get("notes", "brand-new-idea.md");
    expect(cur.body).toBe("Gribblepibbly\n");
    await expect(client.docs.get("notes", "Untitled.md")).rejects.toThrow();
  });

  it("after a premature delete, a dirty late add restores with the new bytes", async () => {
    const v1 = await client.docs.create("notes", "Untitled.md", {
      body: "x\n",
      frontmatter_raw: "",
    });
    const stamped = materialized(await client.docs.get_version("notes", v1.version_id));
    const store = memStore();
    const map: RemoteMap = new Map([
      ["Untitled.md", { version_id: v1.version_id, content_hash: v1.content_hash }],
    ]);
    expect(await push("Untitled.md", store, map)).toBe("deleted");
    store.files.set("brand-new-idea.md", stamped.replace("x", "Gribblepibbly"));
    expect(await push("brand-new-idea.md", store, map)).toBe("updated");
    const cur = await client.docs.get("notes", "brand-new-idea.md");
    expect(cur.body).toBe("Gribblepibbly\n");
  });
});

describe("pushBurst — rename pairing (§4.7)", () => {
  it("unlink+add of the same identity in one burst is a move, not a delete", async () => {
    const v1 = await client.docs.create("notes", "Untitled.md", {
      body: "idea\n",
      frontmatter_raw: "",
    });
    const text = materialized(await client.docs.get_version("notes", v1.version_id));
    const store = memStore({ "brand-new-idea.md": text });
    const map: RemoteMap = new Map([
      ["Untitled.md", { version_id: v1.version_id, content_hash: v1.content_hash }],
    ]);
    // Unlink first in the array — burst must still process the dest before delete.
    const results = await pushBurst(["Untitled.md", "brand-new-idea.md"], {
      client,
      store,
      repo: "notes",
      map,
    });
    expect(results).toContain("updated");
    expect(results).not.toContain("deleted");
    const cur = await client.docs.get("notes", "brand-new-idea.md");
    expect(cur.prev_version_id).toBe(v1.version_id);
    await expect(client.docs.get("notes", "Untitled.md")).rejects.toThrow();
  });

  it("a burst that is only an unlink still deletes", async () => {
    const v = await client.docs.create("notes", "gone.md", { body: "x\n", frontmatter_raw: "" });
    const store = memStore();
    const map: RemoteMap = new Map([
      ["gone.md", { version_id: v.version_id, content_hash: v.content_hash }],
    ]);
    const results = await pushBurst(["gone.md"], { client, store, repo: "notes", map });
    expect(results).toEqual(["deleted"]);
    await expect(client.docs.get("notes", "gone.md")).rejects.toThrow();
  });
});

describe("pushPath — witnessed delete (§4.6)", () => {
  it("an absent file tracked in the map → docs.delete", async () => {
    const v = await client.docs.create("notes", "gone.md", { body: "x\n", frontmatter_raw: "" });
    const store = memStore(); // file absent (the unlink already happened)
    const map: RemoteMap = new Map([
      ["gone.md", { version_id: v.version_id, content_hash: v.content_hash }],
    ]);
    expect(await push("gone.md", store, map)).toBe("deleted");
    await expect(client.docs.get("notes", "gone.md")).rejects.toThrow();
    expect(map.has("gone.md")).toBe(false);
  });

  it("an absent file NOT in the map (untracked unlink) → no-op", async () => {
    const store = memStore();
    const map: RemoteMap = new Map();
    expect(await push("never-tracked.md", store, map)).toBe("no-op-untracked-unlink");
  });

  it("delete raced by a remote change (stale_prev) → skip + drop map entry", async () => {
    const v1 = await client.docs.create("notes", "a.md", { body: "1\n", frontmatter_raw: "" });
    // Remote advanced past v1; our map still points at v1.
    await client.docs.put("notes", v1.version_id, "a.md", { body: "2\n", frontmatter_raw: "" });
    const store = memStore(); // locally deleted
    const map: RemoteMap = new Map([
      ["a.md", { version_id: v1.version_id, content_hash: v1.content_hash }],
    ]);
    expect(await push("a.md", store, map)).toBe("skip");
    // Doc still live remotely (delete was skipped); stale map entry dropped.
    expect((await client.docs.get("notes", "a.md")).body).toBe("2\n");
    expect(map.has("a.md")).toBe(false);
  });
});

describe("pushPath — occupied path, no provenance (§4.4)", () => {
  it("hash-equal clean copy → adopt in place, no server write", async () => {
    const v = await client.docs.create("notes", "a.md", { body: "same\n", frontmatter_raw: "" });
    // Local file has identical bytes but NO embedded provenance.
    const store = memStore({ "a.md": "same\n" });
    const map: RemoteMap = new Map();
    expect(await push("a.md", store, map)).toBe("clean");
    // Provenance injected; still the original version (no new write).
    expect(store.files.get("a.md")).toContain(`$version: ${v.version_id}`);
    expect((await client.docs.get("notes", "a.md")).version_id).toBe(v.version_id);
  });

  it("divergent bytes → occupied-path conflict (park remote sibling)", async () => {
    const v = await client.docs.create("notes", "a.md", {
      body: "remote body\n",
      frontmatter_raw: "",
    });
    const store = memStore({ "a.md": "different local bytes\n" });
    const map: RemoteMap = new Map();
    expect(await push("a.md", store, map)).toBe("conflict");
    expect(store.files.get("a.md")).toBe("different local bytes\n");
    expect(store.files.get(`a-${v.version_id}.md`)).toContain("remote body");
    expect(store.files.get(`a-${v.version_id}.md`)).toContain("$sync: ignore");
  });
});

describe("pushPath — dirty edit racing remote (stale_prev)", () => {
  it("a put whose embedded version is superseded → conflict park", async () => {
    const v1 = await client.docs.create("notes", "a.md", { body: "base\n", frontmatter_raw: "" });
    // Local file: dirty, embeds v1.
    const dirty = materialized(await client.docs.get_version("notes", v1.version_id)).replace(
      "base",
      "my edit",
    );
    // Remote advances to v2 out of band.
    const v2 = await client.docs.put("notes", v1.version_id, "a.md", {
      body: "remote edit\n",
      frontmatter_raw: "",
    });
    const store = memStore({ "a.md": dirty });
    const map: RemoteMap = new Map();
    expect(await push("a.md", store, map)).toBe("conflict");
    expect(store.files.get("a.md")).toBe(dirty); // local preserved
    expect(store.files.get(`a-${v2.version_id}.md`)).toContain("remote edit");
  });
});
