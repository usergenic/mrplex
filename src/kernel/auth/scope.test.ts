import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sqliteAdapter } from "../../storage-sqlite/adapter.js";
import type { Storage } from "../../storage/types.js";
import type { StoredScope } from "./actor.js";
import {
  type ScopeInput,
  assertAdminSubset,
  assertChildScopeSubset,
  moveEndpointsToCheck,
  resolveScopeInput,
  resolveScopeInputs,
  scopesGrant,
  scopesGrantRepo,
} from "./scope.js";

describe("resolveScopeInput", () => {
  let storage: Storage;

  beforeEach(async () => {
    storage = await sqliteAdapter.open({
      database: `sqlite:${join(tmpdir(), `mrplex-scope-${Date.now()}-${Math.random()}.db`)}`,
    });
    // Seed a repo family for pattern-resolution tests.
    await storage.repos_create({ slug: "notes", created_at: "2026-08-14T00:00:00Z" });
    await storage.repos_create({ slug: "team-alpha", created_at: "2026-08-14T00:00:01Z" });
    await storage.repos_create({ slug: "team-beta", created_at: "2026-08-14T00:00:02Z" });
  });

  afterEach(async () => {
    await storage.close();
  });

  it('the literal "*" stays as the dynamic wildcard', async () => {
    const scope = await resolveScopeInput({ repo: "*", read: "**" }, storage);
    expect(scope.repos).toBe("*");
    expect(scope.read).toEqual(["**"]);
  });

  it("a slug pattern resolves to the matching repo ids (creation-time snapshot)", async () => {
    const scope = await resolveScopeInput({ repo: "team-*", read: "**" }, storage);
    expect(Array.isArray(scope.repos)).toBe(true);
    expect((scope.repos as number[]).length).toBe(2);
  });

  it("a repo created AFTER resolution is NOT covered (non-* is a snapshot)", async () => {
    const scope = await resolveScopeInput({ repo: "team-*", read: "**" }, storage);
    const before = new Set(scope.repos as number[]);
    await storage.repos_create({ slug: "team-gamma", created_at: "2026-08-14T00:00:03Z" });
    // Resolve fresh — includes the new one.
    const after = await resolveScopeInput({ repo: "team-*", read: "**" }, storage);
    expect((after.repos as number[]).length).toBe(3);
    // But the original scope still has only the two it saw at creation.
    expect(before.size).toBe(2);
  });

  it('a list containing "*" collapses to dynamic', async () => {
    const scope = await resolveScopeInput({ repo: ["team-*", "*"], read: "**" }, storage);
    expect(scope.repos).toBe("*");
  });

  it("polymorphic scalar-or-list on read/write is normalized to list", async () => {
    const scope = await resolveScopeInput(
      { repo: "notes", read: "**", write: ["inbox/**", "!inbox/pinned/**"] },
      storage,
    );
    expect(scope.read).toEqual(["**"]);
    expect(scope.write).toEqual(["inbox/**", "!inbox/pinned/**"]);
  });

  it("omitted read/write are absent (not empty arrays)", async () => {
    const scope = await resolveScopeInput({ repo: "notes" }, storage);
    expect(scope.read).toBeUndefined();
    expect(scope.write).toBeUndefined();
  });

  it("empty repo list throws", async () => {
    await expect(resolveScopeInput({ repo: [] }, storage)).rejects.toThrow(/no repo pattern/);
  });

  it("resolveScopeInputs maps over an array", async () => {
    const inputs: ScopeInput[] = [
      { repo: "notes", read: "**" },
      { repo: "team-*", write: "inbox/**" },
    ];
    const scopes = await resolveScopeInputs(inputs, storage);
    expect(scopes).toHaveLength(2);
  });
});

describe("assertChildScopeSubset", () => {
  const parent: StoredScope[] = [{ repos: [1, 2, 3], read: ["**"], write: ["inbox/**"] }];

  it("permits a child that is a strict subset", async () => {
    const child: StoredScope[] = [{ repos: [1], read: ["**"] }];
    expect(() => assertChildScopeSubset(parent, child)).not.toThrow();
  });

  it("rejects a child claiming a repo the parent doesn't have", async () => {
    const child: StoredScope[] = [{ repos: [999], read: ["**"] }];
    expect(() => assertChildScopeSubset(parent, child)).toThrow(/not covered/);
  });

  it("rejects a child claiming a glob the parent doesn't have", async () => {
    const child: StoredScope[] = [{ repos: [1], write: ["drafts/**"] }];
    expect(() => assertChildScopeSubset(parent, child)).toThrow(/not covered/);
  });

  it("verbatim glob equality — a subsuming glob does NOT count", async () => {
    // Parent has drafts/*; child asks for drafts/*/notes.md — even though the
    // paths would ultimately match parent's *, verbatim subset rejects.
    const p: StoredScope[] = [{ repos: [1], read: ["drafts/*"] }];
    const c: StoredScope[] = [{ repos: [1], read: ["drafts/*/notes.md"] }];
    expect(() => assertChildScopeSubset(p, c)).toThrow(/not covered/);
  });

  it('parent "*" covers any child repo binding', async () => {
    const p: StoredScope[] = [{ repos: "*", read: ["**"] }];
    const c: StoredScope[] = [{ repos: [42], read: ["**"] }];
    expect(() => assertChildScopeSubset(p, c)).not.toThrow();
  });

  it("parent concrete cannot cover child '*'", async () => {
    const p: StoredScope[] = [{ repos: [1, 2], read: ["**"] }];
    const c: StoredScope[] = [{ repos: "*", read: ["**"] }];
    expect(() => assertChildScopeSubset(p, c)).toThrow(/not covered/);
  });

  it("empty child scopes is trivially covered", async () => {
    expect(() => assertChildScopeSubset(parent, [])).not.toThrow();
  });
});

describe("assertAdminSubset", () => {
  it("admin parent can mint admin child", async () => {
    expect(() => assertAdminSubset(true, true)).not.toThrow();
  });
  it("admin parent can mint non-admin child", async () => {
    expect(() => assertAdminSubset(true, false)).not.toThrow();
  });
  it("non-admin parent CANNOT mint admin child", async () => {
    expect(() => assertAdminSubset(false, true)).toThrow(/admin/);
  });
  it("non-admin parent can mint non-admin child", async () => {
    expect(() => assertAdminSubset(false, false)).not.toThrow();
  });
});

describe("scopesGrant", () => {
  it("returns false for empty scopes", async () => {
    expect(scopesGrant([], "read", 1, "foo.md")).toBe(false);
  });

  it("matches when scope covers repo and glob covers path", async () => {
    const scopes: StoredScope[] = [{ repos: [1], read: ["**"] }];
    expect(scopesGrant(scopes, "read", 1, "foo.md")).toBe(true);
  });

  it("does not match when scope covers different repo", async () => {
    const scopes: StoredScope[] = [{ repos: [2], read: ["**"] }];
    expect(scopesGrant(scopes, "read", 1, "foo.md")).toBe(false);
  });

  it("does not confuse read vs write", async () => {
    const scopes: StoredScope[] = [{ repos: [1], read: ["**"] }];
    expect(scopesGrant(scopes, "write", 1, "foo.md")).toBe(false);
  });

  it("multiple scope entries union", async () => {
    const scopes: StoredScope[] = [
      { repos: [1], read: ["drafts/**"] },
      { repos: [1], read: ["published/**"] },
    ];
    expect(scopesGrant(scopes, "read", 1, "drafts/x.md")).toBe(true);
    expect(scopesGrant(scopes, "read", 1, "published/y.md")).toBe(true);
    expect(scopesGrant(scopes, "read", 1, "elsewhere.md")).toBe(false);
  });

  it('"*" repos matches any repo id', async () => {
    const scopes: StoredScope[] = [{ repos: "*", read: ["**"] }];
    expect(scopesGrant(scopes, "read", 999, "foo.md")).toBe(true);
  });

  it("negation via ! in the glob list", async () => {
    const scopes: StoredScope[] = [{ repos: [1], write: ["drafts/**", "!drafts/pinned/**"] }];
    expect(scopesGrant(scopes, "write", 1, "drafts/foo.md")).toBe(true);
    expect(scopesGrant(scopes, "write", 1, "drafts/pinned/foo.md")).toBe(false);
  });
});

describe("scopesGrantRepo", () => {
  it("true when any scope binds the repo", async () => {
    const scopes: StoredScope[] = [{ repos: [1, 2], read: ["**"] }];
    expect(scopesGrantRepo(scopes, 1)).toBe(true);
    expect(scopesGrantRepo(scopes, 3)).toBe(false);
  });

  it("true for any repo when scope is '*'", async () => {
    expect(scopesGrantRepo([{ repos: "*" }], 42)).toBe(true);
  });
});

describe("moveEndpointsToCheck (system-namespace carve-out)", () => {
  it("both user-territory endpoints → both checked", async () => {
    expect(moveEndpointsToCheck("a.md", "b.md", [":"])).toEqual(["a.md", "b.md"]);
  });
  it("source is system, dest is user → only dest (restore)", async () => {
    expect(moveEndpointsToCheck(":deleted/a-v1.md", "a.md", [":"])).toEqual(["a.md"]);
  });
  it("source is user, dest is system → only source (delete)", async () => {
    expect(moveEndpointsToCheck("a.md", ":deleted/a-v1.md", [":"])).toEqual(["a.md"]);
  });
  it("both system → nothing checked (kernel-only move; shouldn't happen from a user call)", async () => {
    expect(moveEndpointsToCheck(":deleted/a-v1.md", ":deleted/a-v2.md", [":"])).toEqual([]);
  });
});
