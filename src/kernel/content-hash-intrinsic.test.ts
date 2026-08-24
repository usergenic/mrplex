/**
 * $content_hash — end-to-end intrinsic behavior (sync/history plan §2.4–2.5):
 * the wire value matches contentHashOfFile of an injected materialization, and
 * the same value is filterable via `$content_hash`.
 */

import { describe, expect, it } from "vitest";
import { contentHashOfFile } from "../markdown/content-hash.js";
import { appendSystemProperty, join } from "../markdown/frontmatter.js";
import { sqliteAdapter } from "../storage-sqlite/adapter.js";
import type { CallContext } from "./context.js";
import { createKernel } from "./kernel.js";

async function bootstrap() {
  const storage = await sqliteAdapter.open({ database: "sqlite::memory:" });
  const kernel = createKernel(storage);
  await storage.repos_create({ slug: "notes", created_at: "2026-08-14T00:00:00Z" });
  const actor: CallContext = {};
  return { kernel, actor };
}

describe("$content_hash intrinsic", () => {
  it("wire content_hash equals contentHashOfFile of the injected materialization", async () => {
    const { kernel, actor } = await bootstrap();
    const v = await kernel.docs.create(actor, "notes", "a.md", {
      body: "# Title\n\nbody text\n",
      frontmatter_raw: "status: draft\n",
    });
    // Materialize as a read surface would: inject $version then $content_hash.
    let raw = appendSystemProperty(v.frontmatter_raw, "version", v.version_id);
    raw = appendSystemProperty(raw, "content_hash", v.content_hash);
    const fileText = join({ frontmatter_raw: raw, body: v.body });
    expect(contentHashOfFile(fileText)).toBe(v.content_hash);
  });

  it("is filterable via $content_hash == <hash>", async () => {
    const { kernel, actor } = await bootstrap();
    const v = await kernel.docs.create(actor, "notes", "a.md", {
      body: "hello\n",
      frontmatter_raw: "",
    });
    await kernel.docs.create(actor, "notes", "b.md", {
      body: "different\n",
      frontmatter_raw: "",
    });
    const hits = await kernel.query(actor, {
      repo: "notes",
      filter: `$content_hash == "${v.content_hash}"`,
      select: ["$path", "$content_hash"],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.$path).toBe("a.md");
    expect(hits[0]?.$content_hash).toBe(v.content_hash);
  });
});
