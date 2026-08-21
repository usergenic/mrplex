/**
 * docs.diff — kernel unit tests.
 */

import { describe, expect, it } from "vitest";
import { sqliteAdapter } from "../storage-sqlite/adapter.js";
import type { Storage } from "../storage/types.js";
import type { CallContext } from "./context.js";
import { KernelError } from "./errors.js";
import { createKernel } from "./kernel.js";

async function bootstrap(): Promise<{
  storage: Storage;
  kernel: ReturnType<typeof createKernel>;
  actor: CallContext;
}> {
  const storage = await sqliteAdapter.open({ database: "sqlite::memory:" });
  const kernel = createKernel(storage);
  await storage.repos_create({ slug: "notes", created_at: "2026-08-14T00:00:00Z" });
  const actor: CallContext = {};
  return { storage, kernel, actor };
}

describe("docs.diff", () => {
  it("returns a unified diff over serialized document text", async () => {
    const { kernel, actor } = await bootstrap();
    const v1 = await kernel.docs.create(actor, "notes", "a.md", {
      body: "hello world\n",
      frontmatter_raw: "",
    });
    const v2 = await kernel.docs.put(actor, "notes", v1.version_id, "a.md", {
      body: "hello CHANGED world\n",
      frontmatter_raw: "",
    });
    const d = await kernel.docs.diff(actor, "notes", "a.md", v1.version_id, v2.version_id);
    expect(d.from_version_id).toBe(v1.version_id);
    expect(d.to_version_id).toBe(v2.version_id);
    expect(d.patch).toContain(`a.md@${v1.version_id}`);
    expect(d.patch).toContain(`a.md@${v2.version_id}`);
    expect(d.patch).toContain("-hello world");
    expect(d.patch).toContain("+hello CHANGED world");
  });

  it("identical from/to → empty-hunk patch, not an error", async () => {
    const { kernel, actor } = await bootstrap();
    const v = await kernel.docs.create(actor, "notes", "a.md", {
      body: "hello",
      frontmatter_raw: "",
    });
    const d = await kernel.docs.diff(actor, "notes", "a.md", v.version_id, v.version_id);
    // jsdiff emits a header even for identical inputs, but no hunks (no
    // @@ marker) — assert that.
    expect(d.patch).not.toMatch(/^@@/m);
  });

  it("version_not_in_document when from is a different document", async () => {
    const { kernel, actor } = await bootstrap();
    const v1 = await kernel.docs.create(actor, "notes", "a.md", {
      body: "hello",
      frontmatter_raw: "",
    });
    const other = await kernel.docs.create(actor, "notes", "b.md", {
      body: "world",
      frontmatter_raw: "",
    });
    try {
      await kernel.docs.diff(actor, "notes", "a.md", other.version_id, v1.version_id);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(KernelError);
      expect((err as KernelError).code).toBe("version_not_in_document");
    }
  });

  it("doc_not_found when the live path has nothing", async () => {
    const { kernel, actor } = await bootstrap();
    try {
      await kernel.docs.diff(actor, "notes", "nothing-here.md", "v1", "v2");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as KernelError).code).toBe("doc_not_found");
    }
  });

  it("version_not_found when a version_id is malformed / unknown", async () => {
    const { kernel, actor } = await bootstrap();
    const v = await kernel.docs.create(actor, "notes", "a.md", {
      body: "x",
      frontmatter_raw: "",
    });
    try {
      await kernel.docs.diff(actor, "notes", "a.md", "bogus", v.version_id);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as KernelError).code).toBe("version_not_found");
    }
  });

  it("captures a move across the chain — headers show old and new paths", async () => {
    const { kernel, actor } = await bootstrap();
    const v1 = await kernel.docs.create(actor, "notes", "old.md", {
      body: "same content",
      frontmatter_raw: "",
    });
    // Move to new path — same doc identity.
    const v2 = await kernel.docs.put(actor, "notes", v1.version_id, "new.md", {
      body: "same content",
      frontmatter_raw: "",
    });
    const d = await kernel.docs.diff(actor, "notes", "new.md", v1.version_id, v2.version_id);
    expect(d.patch).toContain(`old.md@${v1.version_id}`);
    expect(d.patch).toContain(`new.md@${v2.version_id}`);
  });
});
