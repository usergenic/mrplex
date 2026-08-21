/**
 * Repo-management write flows through the kernel — repos.{create,rename,
 * delete,set_path_config}. Exercises §3.4 (system-namespace slug renames).
 *
 * No-auth (noauth plan): there is no admin gating, no users, no tokens. Every
 * caller is trusted; these ops are reachable = allowed. An empty CallContext is
 * full access with the default author.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CallContext } from "../src/kernel/context.js";
import type { KernelError } from "../src/kernel/errors.js";
import { type Kernel, createKernel } from "../src/kernel/kernel.js";
import { sqliteAdapter } from "../src/storage-sqlite/adapter.js";
import type { Storage } from "../src/storage/types.js";

let storage: Storage;
let kernel: Kernel;
const ctx: CallContext = {};

beforeEach(async () => {
  storage = await sqliteAdapter.open({
    database: `sqlite:${join(tmpdir(), `mrplex-admin-${Date.now()}-${Math.random()}.db`)}`,
  });
  kernel = createKernel(storage);
});

afterEach(async () => {
  await storage.close();
});

describe("repos.create/rename/delete", () => {
  it("create + list", async () => {
    await kernel.repos.create(ctx, "notes");
    await kernel.repos.create(ctx, "team-alpha");
    const list = (await kernel.repos.list(ctx)).map((r) => r.repo);
    expect(list).toEqual(["notes", "team-alpha"]);
  });

  it("rejects duplicate slug → slug_taken", async () => {
    await kernel.repos.create(ctx, "notes");
    try {
      await kernel.repos.create(ctx, "notes");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("slug_taken");
    }
  });

  it("rejects invalid slug → slug_invalid", async () => {
    try {
      await kernel.repos.create(ctx, ":deleted-forbidden");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("slug_invalid");
    }
  });

  it("rename preserves documents inside", async () => {
    await kernel.repos.create(ctx, "notes");
    const v = await kernel.docs.create(ctx, "notes", "hello.md", {
      frontmatter_raw: "",
      body: "hi\n",
    });
    await kernel.repos.rename(ctx, "notes", "notes-archive");
    // Old slug is gone.
    try {
      await kernel.docs.get(ctx, "notes", "hello.md");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("repo_not_found");
    }
    // New slug still holds the doc.
    const stillThere = await kernel.docs.get(ctx, "notes-archive", "hello.md");
    expect(stillThere.body).toBe("hi\n");
    expect(stillThere.version_id).toBe(v.version_id);
  });

  it("delete renames to system-namespace slug; original slug is freed", async () => {
    await kernel.repos.create(ctx, "notes");
    const deleted = await kernel.repos.delete(ctx, "notes");
    expect(deleted.repo).toMatch(/^:deleted-notes-/);
    // list default hides system-namespaced repos.
    expect((await kernel.repos.list(ctx)).map((r) => r.repo)).not.toContain(deleted.repo);
    // include_system surfaces it.
    expect((await kernel.repos.list(ctx, { include_system: true })).map((r) => r.repo)).toContain(
      deleted.repo,
    );
    // The old slug is now free — a fresh repo can claim it.
    const fresh = await kernel.repos.create(ctx, "notes");
    expect(fresh.repo).toBe("notes");
  });

  it("delete is idempotent — deleting a system-namespaced slug is a no-op", async () => {
    await kernel.repos.create(ctx, "notes");
    const deleted = await kernel.repos.delete(ctx, "notes");
    const again = await kernel.repos.delete(ctx, deleted.repo);
    expect(again.repo).toBe(deleted.repo);
  });
});

describe("repos.set_path_config", () => {
  it("stores an override and returns no warnings when config is null", async () => {
    await kernel.repos.create(ctx, "notes");
    const result = await kernel.repos.set_path_config(ctx, "notes", null);
    expect(result.repo.path_config).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it("stores a partial override (merges with server config)", async () => {
    await kernel.repos.create(ctx, "notes");
    const result = await kernel.repos.set_path_config(ctx, "notes", {
      hidden_sigils: [".", "_"],
    });
    expect(result.repo.path_config).toEqual({ hidden_sigils: [".", "_"] });
  });

  it("returns advisory warnings for live paths that fail new validation", async () => {
    await kernel.repos.create(ctx, "notes");
    // Create a doc with a name containing '_'
    await kernel.docs.create(ctx, "notes", "notes_with_underscore.md", {
      frontmatter_raw: "",
      body: "hi\n",
    });
    // Tighten disallowed_chars to include '_' — the existing path becomes invalid.
    const result = await kernel.repos.set_path_config(ctx, "notes", {
      disallowed_chars: ["\\", "<", ">", ":", "|", "?", '"', "_"],
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.path).toBe("notes_with_underscore.md");
    expect(result.warnings[0]?.reason).toMatch(/_/);
  });

  it("rejects an override that would violate a startup invariant", async () => {
    await kernel.repos.create(ctx, "notes");
    // Setting hidden_sigil that shadows a system sigil.
    await expect(
      kernel.repos.set_path_config(ctx, "notes", { hidden_sigils: [":h"] }),
    ).rejects.toThrow(/prefix/);
  });
});
