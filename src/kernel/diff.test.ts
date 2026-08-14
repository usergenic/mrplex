/**
 * docs.diff — kernel unit tests.
 */

import { describe, expect, it } from "vitest";
import { sqliteAdapter } from "../storage-sqlite/adapter.js";
import type { Storage } from "../storage/types.js";
import type { Actor } from "./auth/actor.js";
import { KernelError } from "./errors.js";
import { createKernel } from "./kernel.js";

function bootstrap(): { storage: Storage; kernel: ReturnType<typeof createKernel>; actor: Actor } {
  const storage = sqliteAdapter.open({ database: "sqlite::memory:" });
  const kernel = createKernel(storage);
  const u = storage.users_create({ slug: "alice", created_at: "2026-08-14T00:00:00Z" });
  storage.repos_create({ slug: "notes", created_at: "2026-08-14T00:00:00Z" });
  const actor: Actor = { user_id: u.id, admin: true, scopes: [] };
  return { storage, kernel, actor };
}

describe("docs.diff", () => {
  it("returns a unified diff over serialized document text", () => {
    const { kernel, actor } = bootstrap();
    const v1 = kernel.docs.create(actor, "notes", "a.md", {
      body: "hello world\n",
      frontmatter_raw: "",
    });
    const v2 = kernel.docs.put(actor, "notes", v1.version_id, "a.md", {
      body: "hello CHANGED world\n",
      frontmatter_raw: "",
    });
    const d = kernel.docs.diff(actor, "notes", "a.md", v1.version_id, v2.version_id);
    expect(d.from_version_id).toBe(v1.version_id);
    expect(d.to_version_id).toBe(v2.version_id);
    expect(d.patch).toContain(`a.md@${v1.version_id}`);
    expect(d.patch).toContain(`a.md@${v2.version_id}`);
    expect(d.patch).toContain("-hello world");
    expect(d.patch).toContain("+hello CHANGED world");
  });

  it("identical from/to → empty-hunk patch, not an error", () => {
    const { kernel, actor } = bootstrap();
    const v = kernel.docs.create(actor, "notes", "a.md", {
      body: "hello",
      frontmatter_raw: "",
    });
    const d = kernel.docs.diff(actor, "notes", "a.md", v.version_id, v.version_id);
    // jsdiff emits a header even for identical inputs, but no hunks (no
    // @@ marker) — assert that.
    expect(d.patch).not.toMatch(/^@@/m);
  });

  it("version_not_in_document when from is a different document", () => {
    const { kernel, actor } = bootstrap();
    const v1 = kernel.docs.create(actor, "notes", "a.md", {
      body: "hello",
      frontmatter_raw: "",
    });
    const other = kernel.docs.create(actor, "notes", "b.md", {
      body: "world",
      frontmatter_raw: "",
    });
    try {
      kernel.docs.diff(actor, "notes", "a.md", other.version_id, v1.version_id);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(KernelError);
      expect((err as KernelError).code).toBe("version_not_in_document");
    }
  });

  it("doc_not_found when the live path has nothing", () => {
    const { kernel, actor } = bootstrap();
    try {
      kernel.docs.diff(actor, "notes", "nothing-here.md", "v1", "v2");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as KernelError).code).toBe("doc_not_found");
    }
  });

  it("version_not_found when a version_id is malformed / unknown", () => {
    const { kernel, actor } = bootstrap();
    const v = kernel.docs.create(actor, "notes", "a.md", {
      body: "x",
      frontmatter_raw: "",
    });
    try {
      kernel.docs.diff(actor, "notes", "a.md", "bogus", v.version_id);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as KernelError).code).toBe("version_not_found");
    }
  });

  it("captures a move across the chain — headers show old and new paths", () => {
    const { kernel, actor } = bootstrap();
    const v1 = kernel.docs.create(actor, "notes", "old.md", {
      body: "same content",
      frontmatter_raw: "",
    });
    // Move to new path — same doc identity.
    const v2 = kernel.docs.put(actor, "notes", v1.version_id, "new.md", {
      body: "same content",
      frontmatter_raw: "",
    });
    const d = kernel.docs.diff(actor, "notes", "new.md", v1.version_id, v2.version_id);
    expect(d.patch).toContain(`old.md@${v1.version_id}`);
    expect(d.patch).toContain(`new.md@${v2.version_id}`);
  });
});
