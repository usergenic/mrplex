/**
 * Links backfill (design §11.2, links-plan.md WS3).
 *
 * Backfill rebuilds the derived index from a repo's live versions. Tested
 * by wiping the index out from under a populated corpus and rebuilding it,
 * plus the config-change re-extraction path.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Kernel, createKernel } from "../src/kernel/kernel.js";
import { backfillRepoLinks } from "../src/links/backfill.js";
import {
  HARDCODED_DEFAULTS,
  effectiveLinkConfig,
  parseRepoOverride,
} from "../src/links/link-config.js";
import { sqliteAdapter } from "../src/storage-sqlite/adapter.js";
import type { Storage } from "../src/storage/types.js";

let storage: Storage;
let kernel: Kernel;
let repoId: number;

async function fresh(): Promise<Storage> {
  return sqliteAdapter.open({
    database: `sqlite:${join(tmpdir(), `mrplex-links-bf-${Date.now()}-${Math.random()}.db`)}`,
  });
}

function create(path: string, input: { body: string; frontmatter?: Record<string, unknown> }) {
  const fm = input.frontmatter ? { frontmatter: input.frontmatter } : { frontmatter_raw: "" };
  return kernel.docs.create({}, "notes", path, { ...fm, body: input.body });
}

async function effectiveConfig() {
  const repo = await storage.repos_by_slug("notes");
  if (!repo) throw new Error("no repo");
  return effectiveLinkConfig(HARDCODED_DEFAULTS, parseRepoOverride(repo.link_config));
}

/** Erase the whole index (simulating a corpus that predates the feature). */
async function wipeIndex(): Promise<void> {
  for (const row of await storage.links_by_repo(repoId)) {
    await storage.links_clear(row.source_id);
  }
}

async function docIdAt(path: string): Promise<number> {
  const v = await storage.version_current(repoId, path);
  if (!v) throw new Error(`no live doc at ${path}`);
  return v.document_id;
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

describe("backfillRepoLinks", () => {
  it("rebuilds the index identically after a wipe", async () => {
    await create("a.md", { body: "a" });
    await create("b.md", { body: "b" });
    await create("note.md", { body: "[a](a.md) and [b](b.md)" });

    const before = await storage.links_by_repo(repoId);
    expect(before).toHaveLength(2);

    await wipeIndex();
    expect(await storage.links_by_repo(repoId)).toEqual([]);

    const report = await backfillRepoLinks(storage, repoId, await effectiveConfig());
    expect(report.documents).toBe(3); // a.md, b.md, note.md
    expect(report.edges).toBe(2);

    const after = await storage.links_by_repo(repoId);
    // Same rows (order-stable by source_id, ord).
    expect(after).toEqual(before);
  });

  it("resolves all edges in one pass since every live doc already exists", async () => {
    await create("target.md", { body: "t" });
    await create("note.md", { body: "[t](target.md)" });
    await wipeIndex();

    await backfillRepoLinks(storage, repoId, await effectiveConfig());
    const edges = await storage.links_by_source(await docIdAt("note.md"));
    expect(edges[0]?.target_id).toBe(await docIdAt("target.md"));
  });

  it("leaves a genuinely-absent target dangling after backfill", async () => {
    await create("note.md", { body: "[gone](gone.md)" });
    await wipeIndex();
    await backfillRepoLinks(storage, repoId, await effectiveConfig());
    const edges = await storage.links_by_source(await docIdAt("note.md"));
    expect(edges[0]?.target_id).toBeNull();
  });

  it("is idempotent — re-running produces the same rows", async () => {
    await create("a.md", { body: "a" });
    await create("note.md", { body: "[a](a.md)" });
    const cfg = await effectiveConfig();
    await backfillRepoLinks(storage, repoId, cfg);
    const first = await storage.links_by_repo(repoId);
    await backfillRepoLinks(storage, repoId, cfg);
    const second = await storage.links_by_repo(repoId);
    expect(second).toEqual(first);
  });

  it("re-extracts under a changed config (frontmatter fields opted in)", async () => {
    await create("moc.md", { body: "m" });
    await create("child.md", { frontmatter: { parent: "moc.md" }, body: "c" });
    // Default config has no frontmatter fields, so no parent edge yet.
    expect(await storage.links_by_source(await docIdAt("child.md"))).toEqual([]);

    // Opt in and re-backfill under the new config.
    await storage.repos_set_link_config(repoId, JSON.stringify({ fields: ["parent"] }));
    await backfillRepoLinks(storage, repoId, await effectiveConfig());

    const edges = await storage.links_by_source(await docIdAt("child.md"));
    expect(edges).toHaveLength(1);
    expect(edges[0]?.field).toBe("parent");
    expect(edges[0]?.target_id).toBe(await docIdAt("moc.md"));
  });

  it("reports zero for an empty repo", async () => {
    const report = await backfillRepoLinks(storage, repoId, await effectiveConfig());
    expect(report).toEqual({ documents: 0, edges: 0 });
  });
});
