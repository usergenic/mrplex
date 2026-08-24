/**
 * Content-hash backfill (sync/history plan §2.6). version_insert always
 * populates content_hash now, so to simulate pre-0002 rows we null the column
 * out directly, then verify backfill recomputes exactly the shared-function
 * value and the compute-on-read fallback matched it all along.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKernel } from "../src/kernel/kernel.js";
import { contentHash } from "../src/markdown/content-hash.js";
import { backfillContentHashes } from "../src/markdown/hash-backfill.js";
import { sqliteAdapter } from "../src/storage-sqlite/adapter.js";
import type { Storage } from "../src/storage/types.js";

let storage: Storage;
let kernel: ReturnType<typeof createKernel>;
let dbPath: string;
const actor = {};

beforeEach(async () => {
  dbPath = join(tmpdir(), `mrplex-hashbf-${Date.now()}-${Math.random()}.db`);
  storage = await sqliteAdapter.open({ database: `sqlite:${dbPath}` });
  kernel = createKernel(storage);
  await storage.repos_create({ slug: "notes", created_at: "2026-08-14T00:00:00Z" });
});

afterEach(async () => {
  await storage.close();
});

/** Force rows into the pre-backfill state by nulling their content_hash. */
function nullOutHashes(): void {
  const db = new Database(dbPath);
  db.prepare("update versions set content_hash = null").run();
  db.close();
}

describe("hash backfill", () => {
  it("recomputes null content_hash to the shared-function value", async () => {
    const va = await kernel.docs.create(actor, "notes", "a.md", {
      body: "# A\n\nbody\n",
      frontmatter_raw: "title: A\n",
    });
    const vb = await kernel.docs.create(actor, "notes", "b.md", {
      body: "plain\n",
      frontmatter_raw: "",
    });
    // Capture the correct hashes, then simulate pre-0002 rows.
    const expectedA = contentHash("title: A\n", "# A\n\nbody\n");
    const expectedB = contentHash("", "plain\n");
    expect(va.content_hash).toBe(expectedA);
    expect(vb.content_hash).toBe(expectedB);

    nullOutHashes();
    // Compute-on-read fallback still returns the right value pre-backfill.
    const readA = await kernel.docs.get(actor, "notes", "a.md");
    expect(readA.content_hash).toBe(expectedA);

    const report = await backfillContentHashes(storage);
    expect(report.hashed).toBe(2);

    // The column is now authoritative — filter finds the doc by hash.
    const hits = await kernel.query(actor, {
      repo: "notes",
      filter: `$content_hash == "${expectedA}"`,
      select: ["$path"],
    });
    expect(hits.map((h) => h.$path)).toEqual(["a.md"]);
  });

  it("is idempotent and a no-op once every row is hashed", async () => {
    await kernel.docs.create(actor, "notes", "a.md", { body: "x\n", frontmatter_raw: "" });
    // Rows already carry hashes from version_insert → nothing to do.
    const first = await backfillContentHashes(storage);
    expect(first.hashed).toBe(0);
    nullOutHashes();
    const second = await backfillContentHashes(storage);
    expect(second.hashed).toBe(1);
    const third = await backfillContentHashes(storage);
    expect(third.hashed).toBe(0);
  });

  it("scopes to one repo when repo_id is given", async () => {
    await storage.repos_create({ slug: "other", created_at: "2026-08-14T00:00:00Z" });
    await kernel.docs.create(actor, "notes", "n.md", { body: "n\n", frontmatter_raw: "" });
    await kernel.docs.create(actor, "other", "o.md", { body: "o\n", frontmatter_raw: "" });
    nullOutHashes();
    const notesId = (await storage.repos_by_slug("notes"))?.id as number;
    const report = await backfillContentHashes(storage, { repo_id: notesId });
    expect(report.hashed).toBe(1);
    // The other repo's row is still null → a second unscoped pass hashes it.
    const rest = await backfillContentHashes(storage);
    expect(rest.hashed).toBe(1);
  });

  it("crosses batch boundaries (keyset advance)", async () => {
    for (let i = 0; i < 5; i++) {
      await kernel.docs.create(actor, "notes", `d${i}.md`, {
        body: `${i}\n`,
        frontmatter_raw: "",
      });
    }
    nullOutHashes();
    const report = await backfillContentHashes(storage, { batch: 2 });
    expect(report.hashed).toBe(5);
    const rest = await backfillContentHashes(storage, { batch: 2 });
    expect(rest.hashed).toBe(0);
  });
});
