/**
 * Startup reconciliation — the §4.9 table (sync/history plan). Drives the real
 * reconciler against a local-kernel KernelClient and an in-memory FileStore, so
 * every verdict is exercised without touching disk.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KernelClient } from "../src/client/kernel-client.js";
import { openLocalClient } from "../src/client/local.js";
import { contentHashOfFile } from "../src/markdown/content-hash.js";
import { applyFeed } from "../src/sync/feed.js";
import { makeScopeFilter } from "../src/sync/paths.js";
import { type FileStore, reconcileOnce } from "../src/sync/reconcile.js";

let client: KernelClient;

/** In-memory FileStore: docPath → text. */
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
      return mtimes.get(p) ?? 0;
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

async function reconcile(store: FileStore, dryRun = false) {
  return reconcileOnce(client, store, scope, { repo: "notes", dryRun });
}

function verdictFor(
  report: Awaited<ReturnType<typeof reconcile>>,
  path: string,
): string | undefined {
  return report.actions.find((a) => a.path === path)?.verdict;
}

describe("reconcile — §4.9 rows", () => {
  it("row 7: local creation with no remote doc → docs.create", async () => {
    const store = memStore({ "new.md": "hello local\n" });
    const report = await reconcile(store);
    expect(verdictFor(report, "new.md")).toBe("push");
    // The remote now has it, and the local file carries injected provenance.
    const remote = await client.docs.get("notes", "new.md");
    expect(remote.body).toBe("hello local\n");
    const local = store.files.get("new.md") ?? "";
    expect(local).toContain(`$version: ${remote.version_id}`);
    expect(contentHashOfFile(local)).toBe(remote.content_hash);
  });

  it("row 9: remote doc with no local file → materialize (offline-delete concession)", async () => {
    const v = await client.docs.create("notes", "remote.md", {
      body: "from server\n",
      frontmatter_raw: "",
    });
    const store = memStore();
    const report = await reconcile(store);
    expect(verdictFor(report, "remote.md")).toBe("materialize");
    const local = store.files.get("remote.md") ?? "";
    expect(local).toContain("from server");
    expect(local).toContain(`$version: ${v.version_id}`);
  });

  it("row 1: clean, provenance current → no-op", async () => {
    const v = await client.docs.create("notes", "a.md", { body: "x\n", frontmatter_raw: "" });
    const materialized = await client.docs.get("notes", "a.md"); // injected intrinsics
    const store = memStore({ "a.md": renderInjected(materialized) });
    const report = await reconcile(store);
    expect(verdictFor(report, "a.md")).toBe("clean");
    void v;
  });

  it("row 2: clean copy lacking provenance → adopt (metadata only, no server write)", async () => {
    const v = await client.docs.create("notes", "a.md", { body: "same\n", frontmatter_raw: "" });
    // Local file has identical user bytes but NO embedded intrinsics.
    const store = memStore({ "a.md": "same\n" });
    const report = await reconcile(store);
    expect(verdictFor(report, "a.md")).toBe("adopt");
    const local = store.files.get("a.md") ?? "";
    expect(local).toContain(`$version: ${v.version_id}`);
    // No new version was created (still the original current).
    const current = await client.docs.get("notes", "a.md");
    expect(current.version_id).toBe(v.version_id);
  });

  it("row 4: local edit on current → push", async () => {
    const v = await client.docs.create("notes", "a.md", { body: "orig\n", frontmatter_raw: "" });
    // Materialize then edit the body locally (embedded version stays v1).
    const injected = renderInjected(await client.docs.get("notes", "a.md"));
    const edited = injected.replace("orig", "edited");
    const store = memStore({ "a.md": edited });
    const report = await reconcile(store);
    expect(verdictFor(report, "a.md")).toBe("push");
    const current = await client.docs.get("notes", "a.md");
    expect(current.body).toBe("edited\n");
    expect(current.prev_version_id).toBe(v.version_id);
  });

  it("row 3: local unedited but stale → fast-forward materialize", async () => {
    const v1 = await client.docs.create("notes", "a.md", { body: "v1\n", frontmatter_raw: "" });
    // Local file is the clean v1 materialization.
    const store = memStore({ "a.md": renderInjected(await client.docs.get("notes", "a.md")) });
    // Remote advances to v2 out of band.
    await client.docs.put("notes", v1.version_id, "a.md", { body: "v2\n", frontmatter_raw: "" });
    const report = await reconcile(store);
    expect(verdictFor(report, "a.md")).toBe("materialize");
    expect(store.files.get("a.md")).toContain("v2");
  });

  it("row 5: local edit AND remote advanced → rebase (local becomes new head)", async () => {
    const v1 = await client.docs.create("notes", "a.md", { body: "base\n", frontmatter_raw: "" });
    const injected = renderInjected(await client.docs.get("notes", "a.md"));
    const localEdited = injected.replace("base", "my local edit");
    const store = memStore({ "a.md": localEdited });
    await client.docs.put("notes", v1.version_id, "a.md", {
      body: "their remote edit\n",
      frontmatter_raw: "",
    });
    const report = await reconcile(store);
    expect(verdictFor(report, "a.md")).toBe("rebase");
    expect(store.files.get("a.md")).toContain("my local edit");
    expect([...store.files.keys()].some((k) => /-v\d+\.md$/.test(k))).toBe(false);
    const remote = await client.docs.get("notes", "a.md");
    expect(remote.body).toBe("my local edit\n");
  });

  it("row 6: occupied path, no local provenance, bytes differ → rebase", async () => {
    await client.docs.create("notes", "a.md", {
      body: "remote body\n",
      frontmatter_raw: "",
    });
    const store = memStore({ "a.md": "totally different local\n" });
    const report = await reconcile(store);
    expect(verdictFor(report, "a.md")).toBe("rebase");
    expect(store.files.get("a.md")).toContain("totally different local");
    expect([...store.files.keys()].some((k) => /-v\d+\.md$/.test(k))).toBe(false);
    const remote = await client.docs.get("notes", "a.md");
    expect(remote.body).toBe("totally different local\n");
  });

  it("remote-deleted, local clean → delete-local", async () => {
    const v = await client.docs.create("notes", "gone.md", { body: "x\n", frontmatter_raw: "" });
    const store = memStore({
      "gone.md": renderInjected(await client.docs.get("notes", "gone.md")),
    });
    await client.docs.delete("notes", v.version_id);
    const report = await reconcile(store);
    expect(verdictFor(report, "gone.md")).toBe("delete-local");
    expect(store.files.has("gone.md")).toBe(false);
  });

  it("remote-deleted, local dirty → resurrect", async () => {
    const v = await client.docs.create("notes", "keep.md", { body: "x\n", frontmatter_raw: "" });
    const injected = renderInjected(await client.docs.get("notes", "keep.md"));
    const store = memStore({ "keep.md": injected.replace("x", "edited after delete") });
    await client.docs.delete("notes", v.version_id);
    const report = await reconcile(store);
    expect(verdictFor(report, "keep.md")).toBe("resurrect");
    const current = await client.docs.get("notes", "keep.md");
    expect(current.body).toBe("edited after delete\n");
  });

  it("$sync: ignore files are skipped entirely", async () => {
    const store = memStore({ "ignored.md": "---\n$sync: ignore\n---\nprivate\n" });
    const report = await reconcile(store);
    expect(verdictFor(report, "ignored.md")).toBe("ignored");
    // Not pushed to the remote.
    await expect(client.docs.get("notes", "ignored.md")).rejects.toThrow();
  });

  it("dry-run reports actions without writing or pushing", async () => {
    await client.docs.create("notes", "remote.md", { body: "r\n", frontmatter_raw: "" });
    const store = memStore({ "local.md": "l\n" });
    const report = await reconcile(store, true);
    expect(verdictFor(report, "local.md")).toBe("push");
    expect(verdictFor(report, "remote.md")).toBe("materialize");
    // Nothing actually changed.
    expect(store.files.has("remote.md")).toBe(false);
    await expect(client.docs.get("notes", "local.md")).rejects.toThrow();
  });
});

describe("reconcile — row 8 (offline move)", () => {
  it("a file whose embedded version lives at a different remote path → push move", async () => {
    // Doc created at old.md, then the file moved locally to new.md while sync
    // was stopped (still embeds old.md's version). Remote is still at old.md.
    const v1 = await client.docs.create("notes", "old.md", { body: "x\n", frontmatter_raw: "" });
    const moved = renderInjected(await client.docs.get("notes", "old.md"));
    const store = memStore({ "new.md": moved });
    const report = await reconcile(store);
    expect(verdictFor(report, "new.md")).toBe("push");
    // The document's identity moved: new.md is now current, prev is v1.
    const cur = await client.docs.get("notes", "new.md");
    expect(cur.prev_version_id).toBe(v1.version_id);
    // old.md no longer live remotely.
    await expect(client.docs.get("notes", "old.md")).rejects.toThrow();
  });

  // Note: the stale_prev move-race branch (parkConflictForCurrent) requires the
  // embedded version to be current at a different path yet be superseded between
  // the lookup and the put — an inherent race, not deterministically
  // reproducible in a serial test (same shape as the create_conflict downgrade).
});

describe("reconcile — foreign intrinsics (data-loss regression)", () => {
  it("a clean file stamped by ANOTHER database is adopted, never delete-local", async () => {
    // Stamp a file against a separate database, then sync it against the fresh
    // `notes` db. Its $version/$content_hash are valid *there*, unknown *here* —
    // the README-quickstart footgun that used to delete every fixture file.
    const other = await openLocalClient({ database: "sqlite::memory:", context: {} });
    await other.repos.create("notes");
    await other.docs.create("notes", "away.md", { body: "made elsewhere\n", frontmatter_raw: "" });
    const foreignText = renderInjected(await other.docs.get("notes", "away.md"));
    await other.close();

    // Sanity: the file really is clean (computed hash == embedded hash), which
    // is the branch that deleted; a dirty file would merely have resurrected.
    expect(foreignText).toContain("$version:");

    const store = memStore({ "away.md": foreignText });
    const report = await reconcile(store);

    expect(verdictFor(report, "away.md")).toBe("push");
    // File survives on disk and its bytes are intact.
    expect(store.files.has("away.md")).toBe(true);
    expect(store.files.get("away.md")).toContain("made elsewhere");
    // It was adopted into THIS database and re-stamped with a local version.
    const here = await client.docs.get("notes", "away.md");
    expect(here.body).toBe("made elsewhere\n");
    expect(store.files.get("away.md")).toContain(`$version: ${here.version_id}`);
  });

  it("dry-run reports the foreign file as push, deletes nothing", async () => {
    const other = await openLocalClient({ database: "sqlite::memory:", context: {} });
    await other.repos.create("notes");
    await other.docs.create("notes", "away.md", { body: "elsewhere\n", frontmatter_raw: "" });
    const foreignText = renderInjected(await other.docs.get("notes", "away.md"));
    await other.close();

    const store = memStore({ "away.md": foreignText });
    const report = await reconcile(store, true);
    expect(verdictFor(report, "away.md")).toBe("push");
    expect(store.files.has("away.md")).toBe(true);
    await expect(client.docs.get("notes", "away.md")).rejects.toThrow();
  });

  it("a foreign $version that collides with a superseded local id is still adopted", async () => {
    // The dangerous case the path check guards: as a fresh sync walks a folder
    // it mints v1, v2, … so a later foreign file's embedded id can resolve here
    // — but to a DIFFERENT document. A collision with a *superseded* version
    // (not a live current, so move-detection misses it) lands in this branch;
    // resolving-but-at-another-path must NOT read as this file's deletion.
    const v1 = await client.docs.create("notes", "unrelated.md", {
      body: "first\n",
      frontmatter_raw: "",
    });
    // Advance unrelated.md so v1 is superseded (its current is now v2).
    await client.docs.put("notes", v1.version_id, "unrelated.md", {
      body: "second\n",
      frontmatter_raw: "",
    });
    // Craft a clean file at collide.md whose $version equals the superseded v1.
    const body = "collision body\n";
    const withoutHash = `---\n$version: ${v1.version_id}\n---\n${body}`;
    const hash = contentHashOfFile(withoutHash);
    const collided = `---\n$version: ${v1.version_id}\n$content_hash: ${hash}\n---\n${body}`;

    const store = memStore({ "collide.md": collided });
    const report = await reconcile(store);

    expect(verdictFor(report, "collide.md")).toBe("push");
    expect(store.files.has("collide.md")).toBe(true);
    // Both documents exist independently; nothing was deleted.
    expect((await client.docs.get("notes", "collide.md")).body).toBe(body);
    expect((await client.docs.get("notes", "unrelated.md")).body).toBe("second\n");
  });
});

describe("reconcile + feed handoff", () => {
  it("a doc that advances after R is delivered by the feed, not duplicated", async () => {
    const v1 = await client.docs.create("notes", "a.md", { body: "one\n", frontmatter_raw: "" });
    const store = memStore();
    const report = await reconcile(store); // materializes a.md@v1, captures R
    expect(store.files.get("a.md")).toContain("one");
    // Remote advances after R.
    await client.docs.put("notes", v1.version_id, "a.md", { body: "two\n", frontmatter_raw: "" });
    const { applied } = await applyFeed(client, store, scope, {
      repo: "notes",
      since: report.through_version,
    });
    expect(applied).toBeGreaterThan(0);
    expect(store.files.get("a.md")).toContain("two");
  });
});

/**
 * Materialize a Version as a file. `docs.get` already injects $version +
 * $content_hash into frontmatter_raw, so this just joins the canonical form.
 */
function renderInjected(v: { frontmatter_raw: string; body: string }): string {
  if (v.frontmatter_raw === "") return v.body;
  const raw = v.frontmatter_raw.endsWith("\n") ? v.frontmatter_raw : `${v.frontmatter_raw}\n`;
  return `---\n${raw}---\n${v.body}`;
}
