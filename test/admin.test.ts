/**
 * Admin write flows through the kernel — repos.{create,rename,delete,
 * set_path_config}, users.{create,rename,delete}, tokens.{list,create,revoke}.
 * Exercises §3.4 (system-namespace slug renames), §8.2 (admin gating +
 * child-scope subset), and §8.1 (SHA-256 tokens end-to-end).
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Actor, StoredScope } from "../src/kernel/auth/actor.js";
import { generateSecret, hashSecret, resolveActor } from "../src/kernel/auth/tokens.js";
import type { KernelError } from "../src/kernel/errors.js";
import { type Kernel, createKernel } from "../src/kernel/kernel.js";
import { sqliteAdapter } from "../src/storage-sqlite/adapter.js";
import type { Storage } from "../src/storage/types.js";

let storage: Storage;
let kernel: Kernel;
let admin: Actor;

beforeEach(async () => {
  storage = await sqliteAdapter.open({
    database: `sqlite:${join(tmpdir(), `mrplex-admin-${Date.now()}-${Math.random()}.db`)}`,
  });
  kernel = createKernel(storage);
  // Seed the system user + a real admin token, so we can also test resolveActor
  // and non-admin flows without adapter shortcuts.
  const system = await storage.users_create({
    slug: "system",
    created_at: "2026-08-14T00:00:00Z",
  });
  admin = { user_id: system.id, admin: true, scopes: [] };
});

afterEach(async () => {
  await storage.close();
});

describe("repos.create/rename/delete", () => {
  it("create + list", async () => {
    await kernel.repos.create(admin, "notes");
    await kernel.repos.create(admin, "team-alpha");
    const list = (await kernel.repos.list(admin)).map((r) => r.repo);
    expect(list).toEqual(["notes", "team-alpha"]);
  });

  it("rejects duplicate slug → slug_taken", async () => {
    await kernel.repos.create(admin, "notes");
    try {
      await kernel.repos.create(admin, "notes");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("slug_taken");
    }
  });

  it("rejects invalid slug → slug_invalid", async () => {
    try {
      await kernel.repos.create(admin, ":deleted-forbidden");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("slug_invalid");
    }
  });

  it("rename preserves documents inside", async () => {
    await kernel.repos.create(admin, "notes");
    const v = await kernel.docs.create(admin, "notes", "hello.md", {
      frontmatter_raw: "",
      body: "hi\n",
    });
    await kernel.repos.rename(admin, "notes", "notes-archive");
    // Old slug is gone.
    try {
      await kernel.docs.get(admin, "notes", "hello.md");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("repo_not_found");
    }
    // New slug still holds the doc.
    const stillThere = await kernel.docs.get(admin, "notes-archive", "hello.md");
    expect(stillThere.body).toBe("hi\n");
    expect(stillThere.version_id).toBe(v.version_id);
  });

  it("delete renames to system-namespace slug; original slug is freed", async () => {
    await kernel.repos.create(admin, "notes");
    const deleted = await kernel.repos.delete(admin, "notes");
    expect(deleted.repo).toMatch(/^:deleted-notes-/);
    // list default hides system-namespaced repos.
    expect((await kernel.repos.list(admin)).map((r) => r.repo)).not.toContain(deleted.repo);
    // include_system surfaces it.
    expect((await kernel.repos.list(admin, { include_system: true })).map((r) => r.repo)).toContain(
      deleted.repo,
    );
    // The old slug is now free — a fresh repo can claim it.
    const fresh = await kernel.repos.create(admin, "notes");
    expect(fresh.repo).toBe("notes");
  });

  it("delete is idempotent — deleting a system-namespaced slug is a no-op", async () => {
    await kernel.repos.create(admin, "notes");
    const deleted = await kernel.repos.delete(admin, "notes");
    const again = await kernel.repos.delete(admin, deleted.repo);
    expect(again.repo).toBe(deleted.repo);
  });

  it("non-admin cannot create/rename/delete → forbidden", async () => {
    await kernel.repos.create(admin, "notes");
    const nonAdmin: Actor = {
      user_id: 1,
      admin: false,
      scopes: [{ repos: "*", read: ["**"] }],
    };
    for (const call of [
      () => kernel.repos.create(nonAdmin, "another"),
      () => kernel.repos.rename(nonAdmin, "notes", "renamed"),
      () => kernel.repos.delete(nonAdmin, "notes"),
    ]) {
      try {
        await call();
        throw new Error("expected forbidden");
      } catch (err) {
        expect((err as KernelError).code).toBe("forbidden");
      }
    }
  });
});

describe("repos.set_path_config", () => {
  it("stores an override and returns no warnings when config is null", async () => {
    await kernel.repos.create(admin, "notes");
    const result = await kernel.repos.set_path_config(admin, "notes", null);
    expect(result.repo.path_config).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it("stores a partial override (merges with server config)", async () => {
    await kernel.repos.create(admin, "notes");
    const result = await kernel.repos.set_path_config(admin, "notes", {
      hidden_sigils: [".", "_"],
    });
    expect(result.repo.path_config).toEqual({ hidden_sigils: [".", "_"] });
  });

  it("returns advisory warnings for live paths that fail new validation", async () => {
    await kernel.repos.create(admin, "notes");
    // Create a doc with a name containing '_'
    await kernel.docs.create(admin, "notes", "notes_with_underscore.md", {
      frontmatter_raw: "",
      body: "hi\n",
    });
    // Tighten disallowed_chars to include '_' — the existing path becomes invalid.
    const result = await kernel.repos.set_path_config(admin, "notes", {
      disallowed_chars: ["\\", "<", ">", ":", "|", "?", '"', "_"],
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.path).toBe("notes_with_underscore.md");
    expect(result.warnings[0]?.reason).toMatch(/_/);
  });

  it("rejects an override that would violate a startup invariant", async () => {
    await kernel.repos.create(admin, "notes");
    // Setting hidden_sigil that shadows a system sigil.
    await expect(
      kernel.repos.set_path_config(admin, "notes", { hidden_sigils: [":h"] }),
    ).rejects.toThrow(/prefix/);
  });
});

describe("users.create/rename/delete", () => {
  it("create + list", async () => {
    await kernel.users.create(admin, "alice");
    await kernel.users.create(admin, "bob");
    const list = (await kernel.users.list(admin)).map((u) => u.user);
    expect(list).toContain("alice");
    expect(list).toContain("bob");
  });

  it("rejects duplicate → slug_taken", async () => {
    await kernel.users.create(admin, "alice");
    try {
      await kernel.users.create(admin, "alice");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("slug_taken");
    }
  });

  it("delete renames to system-namespace and revokes tokens", async () => {
    const alice = await kernel.users.create(admin, "alice");
    // Mint a token for alice using an "as-alice" actor
    const aliceRow = await storage.users_by_slug(alice.user);
    if (!aliceRow) throw new Error("seed");
    const aliceActor: Actor = { user_id: aliceRow.id, admin: false, scopes: [] };
    await kernel.repos.create(admin, "notes");
    // Give her scope so the child-subset check clears
    const parent: Actor = {
      user_id: aliceRow.id,
      admin: false,
      scopes: [{ repos: "*", read: ["**"] }],
    };
    const { token } = await kernel.tokens.create(parent, "alice-cli", [{ repo: "*", read: "**" }]);
    expect(await resolveActor(token, storage)).not.toBeNull();
    await kernel.users.delete(admin, "alice");
    expect(await resolveActor(token, storage)).toBeNull();
    void aliceActor;
  });
});

describe("tokens.create/list/revoke", () => {
  it("create returns a plaintext secret exactly once, plus wire meta", async () => {
    await kernel.repos.create(admin, "notes");
    const result = await kernel.tokens.create(admin, "test", [{ repo: "notes", read: "**" }]);
    expect(result.token).toMatch(/^mrplex_[A-Za-z0-9_-]+$/);
    expect(result.meta.id).toMatch(/^t\d+$/);
    expect(result.meta.label).toBe("test");
    expect(result.meta.admin).toBe(false);
    expect(result.meta.scopes[0]?.repos).toEqual(["notes"]);
    expect(result.meta.scopes[0]?.read).toEqual(["**"]);
  });

  it("dynamic '*' repos stays dynamic on the wire", async () => {
    const result = await kernel.tokens.create(admin, "t", [{ repo: "*", read: "**" }]);
    expect(result.meta.scopes[0]?.repos).toBe("*");
  });

  it("issued secret hashes to a lookup-able hash → resolveActor round-trips", async () => {
    await kernel.repos.create(admin, "notes");
    const { token, meta } = await kernel.tokens.create(admin, "t", [
      { repo: "notes", read: "**", write: "inbox/**" },
    ]);
    // Verify DB has the exact hash.
    const row = await storage.tokens_by_hash(hashSecret(token));
    expect(row).not.toBeNull();
    expect(row?.id).toBe(Number.parseInt(meta.id.slice(1), 10));
    // resolveActor should hydrate an actor with the right scopes.
    const actor = await resolveActor(token, storage);
    expect(actor?.admin).toBe(false);
    expect(actor?.scopes[0]?.read).toEqual(["**"]);
  });

  it("list returns caller's own tokens (revoked hidden)", async () => {
    await kernel.repos.create(admin, "notes");
    const a = await kernel.tokens.create(admin, "one", [{ repo: "*", read: "**" }]);
    const b = await kernel.tokens.create(admin, "two", [{ repo: "*", read: "**" }]);
    let listed = await kernel.tokens.list(admin);
    expect(listed.map((t) => t.id).sort()).toEqual([a.meta.id, b.meta.id].sort());
    await kernel.tokens.revoke(admin, a.meta.id);
    listed = await kernel.tokens.list(admin);
    expect(listed.map((t) => t.id)).toEqual([b.meta.id]);
  });

  it("non-admin cannot mint admin child", async () => {
    const nonAdmin: Actor = {
      user_id: admin.user_id,
      admin: false,
      scopes: [{ repos: "*", read: ["**"], write: ["**"] }],
    };
    await expect(
      kernel.tokens.create(nonAdmin, "t", [{ repo: "*", read: "**" }], { admin: true }),
    ).rejects.toThrow(/admin/);
  });

  it("child scope must be a subset of parent (verbatim)", async () => {
    await kernel.repos.create(admin, "notes");
    const notesRow = await storage.repos_by_slug("notes");
    if (!notesRow) throw new Error("seed");
    const parentScopes: StoredScope[] = [{ repos: [notesRow.id], read: ["drafts/**"] }];
    const nonAdmin: Actor = { user_id: admin.user_id, admin: false, scopes: parentScopes };
    // Requesting a broader glob → not covered.
    await expect(
      kernel.tokens.create(nonAdmin, "t", [{ repo: "notes", read: "**" }]),
    ).rejects.toThrow(/not covered/);
    // Requesting the exact same glob → OK.
    await expect(
      kernel.tokens.create(nonAdmin, "t", [{ repo: "notes", read: "drafts/**" }]),
    ).resolves.toBeDefined();
  });

  it("revoke: self is always allowed; cross-user requires admin", async () => {
    const bob = await kernel.users.create(admin, "bob");
    const bobRow = await storage.users_by_slug(bob.user);
    if (!bobRow) throw new Error("seed");
    const bobActor: Actor = { user_id: bobRow.id, admin: false, scopes: [] };
    // Create a token AS admin, belonging to admin — bob shouldn't revoke it.
    const adminToken = await kernel.tokens.create(admin, "admin-tok", [{ repo: "*", read: "**" }]);
    try {
      await kernel.tokens.revoke(bobActor, adminToken.meta.id);
      throw new Error("expected forbidden");
    } catch (err) {
      expect((err as KernelError).code).toBe("forbidden");
    }
    // Bob revoking his own token: mint one for bob via admin (test shortcut
    // — direct storage since bob has no scope). Then bob revokes.
    const secret = generateSecret();
    const bobToken = await storage.tokens_create({
      user_id: bobRow.id,
      secret_hash: hashSecret(secret),
      label: "bob-tok",
      scopes: "[]",
      admin: false,
      expires_at: null,
      created_at: "2026-08-14T00:00:00Z",
    });
    const revoked = await kernel.tokens.revoke(bobActor, `t${bobToken.id}`);
    expect(revoked.id).toBe(`t${bobToken.id}`);
  });
});
