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

  beforeEach(() => {
    storage = sqliteAdapter.open({
      database: `sqlite:${join(tmpdir(), `mrplex-scope-${Date.now()}-${Math.random()}.db`)}`,
    });
    // Seed a repo family for pattern-resolution tests.
    storage.repos_create({ slug: "notes", created_at: "2026-08-14T00:00:00Z" });
    storage.repos_create({ slug: "team-alpha", created_at: "2026-08-14T00:00:01Z" });
    storage.repos_create({ slug: "team-beta", created_at: "2026-08-14T00:00:02Z" });
  });

  afterEach(() => {
    storage.close();
  });

  it('the literal "*" stays as the dynamic wildcard', () => {
    const scope = resolveScopeInput({ repo: "*", read: "**" }, storage);
    expect(scope.repos).toBe("*");
    expect(scope.read).toEqual(["**"]);
  });

  it("a slug pattern resolves to the matching repo ids (creation-time snapshot)", () => {
    const scope = resolveScopeInput({ repo: "team-*", read: "**" }, storage);
    expect(Array.isArray(scope.repos)).toBe(true);
    expect((scope.repos as number[]).length).toBe(2);
  });

  it("a repo created AFTER resolution is NOT covered (non-* is a snapshot)", () => {
    const scope = resolveScopeInput({ repo: "team-*", read: "**" }, storage);
    const before = new Set(scope.repos as number[]);
    storage.repos_create({ slug: "team-gamma", created_at: "2026-08-14T00:00:03Z" });
    // Resolve fresh — includes the new one.
    const after = resolveScopeInput({ repo: "team-*", read: "**" }, storage);
    expect((after.repos as number[]).length).toBe(3);
    // But the original scope still has only the two it saw at creation.
    expect(before.size).toBe(2);
  });

  it('a list containing "*" collapses to dynamic', () => {
    const scope = resolveScopeInput({ repo: ["team-*", "*"], read: "**" }, storage);
    expect(scope.repos).toBe("*");
  });

  it("polymorphic scalar-or-list on read/write is normalized to list", () => {
    const scope = resolveScopeInput(
      { repo: "notes", read: "**", write: ["inbox/**", "!inbox/pinned/**"] },
      storage,
    );
    expect(scope.read).toEqual(["**"]);
    expect(scope.write).toEqual(["inbox/**", "!inbox/pinned/**"]);
  });

  it("omitted read/write are absent (not empty arrays)", () => {
    const scope = resolveScopeInput({ repo: "notes" }, storage);
    expect(scope.read).toBeUndefined();
    expect(scope.write).toBeUndefined();
  });

  it("empty repo list throws", () => {
    expect(() => resolveScopeInput({ repo: [] }, storage)).toThrow(/no repo pattern/);
  });

  it("resolveScopeInputs maps over an array", () => {
    const inputs: ScopeInput[] = [
      { repo: "notes", read: "**" },
      { repo: "team-*", write: "inbox/**" },
    ];
    const scopes = resolveScopeInputs(inputs, storage);
    expect(scopes).toHaveLength(2);
  });
});

describe("assertChildScopeSubset", () => {
  const parent: StoredScope[] = [{ repos: [1, 2, 3], read: ["**"], write: ["inbox/**"] }];

  it("permits a child that is a strict subset", () => {
    const child: StoredScope[] = [{ repos: [1], read: ["**"] }];
    expect(() => assertChildScopeSubset(parent, child)).not.toThrow();
  });

  it("rejects a child claiming a repo the parent doesn't have", () => {
    const child: StoredScope[] = [{ repos: [999], read: ["**"] }];
    expect(() => assertChildScopeSubset(parent, child)).toThrow(/not covered/);
  });

  it("rejects a child claiming a glob the parent doesn't have", () => {
    const child: StoredScope[] = [{ repos: [1], write: ["drafts/**"] }];
    expect(() => assertChildScopeSubset(parent, child)).toThrow(/not covered/);
  });

  it("verbatim glob equality — a subsuming glob does NOT count", () => {
    // Parent has drafts/*; child asks for drafts/*/notes.md — even though the
    // paths would ultimately match parent's *, verbatim subset rejects.
    const p: StoredScope[] = [{ repos: [1], read: ["drafts/*"] }];
    const c: StoredScope[] = [{ repos: [1], read: ["drafts/*/notes.md"] }];
    expect(() => assertChildScopeSubset(p, c)).toThrow(/not covered/);
  });

  it('parent "*" covers any child repo binding', () => {
    const p: StoredScope[] = [{ repos: "*", read: ["**"] }];
    const c: StoredScope[] = [{ repos: [42], read: ["**"] }];
    expect(() => assertChildScopeSubset(p, c)).not.toThrow();
  });

  it("parent concrete cannot cover child '*'", () => {
    const p: StoredScope[] = [{ repos: [1, 2], read: ["**"] }];
    const c: StoredScope[] = [{ repos: "*", read: ["**"] }];
    expect(() => assertChildScopeSubset(p, c)).toThrow(/not covered/);
  });

  it("empty child scopes is trivially covered", () => {
    expect(() => assertChildScopeSubset(parent, [])).not.toThrow();
  });
});

describe("assertAdminSubset", () => {
  it("admin parent can mint admin child", () => {
    expect(() => assertAdminSubset(true, true)).not.toThrow();
  });
  it("admin parent can mint non-admin child", () => {
    expect(() => assertAdminSubset(true, false)).not.toThrow();
  });
  it("non-admin parent CANNOT mint admin child", () => {
    expect(() => assertAdminSubset(false, true)).toThrow(/admin/);
  });
  it("non-admin parent can mint non-admin child", () => {
    expect(() => assertAdminSubset(false, false)).not.toThrow();
  });
});

describe("scopesGrant", () => {
  it("returns false for empty scopes", () => {
    expect(scopesGrant([], "read", 1, "foo.md")).toBe(false);
  });

  it("matches when scope covers repo and glob covers path", () => {
    const scopes: StoredScope[] = [{ repos: [1], read: ["**"] }];
    expect(scopesGrant(scopes, "read", 1, "foo.md")).toBe(true);
  });

  it("does not match when scope covers different repo", () => {
    const scopes: StoredScope[] = [{ repos: [2], read: ["**"] }];
    expect(scopesGrant(scopes, "read", 1, "foo.md")).toBe(false);
  });

  it("does not confuse read vs write", () => {
    const scopes: StoredScope[] = [{ repos: [1], read: ["**"] }];
    expect(scopesGrant(scopes, "write", 1, "foo.md")).toBe(false);
  });

  it("multiple scope entries union", () => {
    const scopes: StoredScope[] = [
      { repos: [1], read: ["drafts/**"] },
      { repos: [1], read: ["published/**"] },
    ];
    expect(scopesGrant(scopes, "read", 1, "drafts/x.md")).toBe(true);
    expect(scopesGrant(scopes, "read", 1, "published/y.md")).toBe(true);
    expect(scopesGrant(scopes, "read", 1, "elsewhere.md")).toBe(false);
  });

  it('"*" repos matches any repo id', () => {
    const scopes: StoredScope[] = [{ repos: "*", read: ["**"] }];
    expect(scopesGrant(scopes, "read", 999, "foo.md")).toBe(true);
  });

  it("negation via ! in the glob list", () => {
    const scopes: StoredScope[] = [{ repos: [1], write: ["drafts/**", "!drafts/pinned/**"] }];
    expect(scopesGrant(scopes, "write", 1, "drafts/foo.md")).toBe(true);
    expect(scopesGrant(scopes, "write", 1, "drafts/pinned/foo.md")).toBe(false);
  });
});

describe("scopesGrantRepo", () => {
  it("true when any scope binds the repo", () => {
    const scopes: StoredScope[] = [{ repos: [1, 2], read: ["**"] }];
    expect(scopesGrantRepo(scopes, 1)).toBe(true);
    expect(scopesGrantRepo(scopes, 3)).toBe(false);
  });

  it("true for any repo when scope is '*'", () => {
    expect(scopesGrantRepo([{ repos: "*" }], 42)).toBe(true);
  });
});

describe("moveEndpointsToCheck (system-namespace carve-out)", () => {
  it("both user-territory endpoints → both checked", () => {
    expect(moveEndpointsToCheck("a.md", "b.md", [":"])).toEqual(["a.md", "b.md"]);
  });
  it("source is system, dest is user → only dest (restore)", () => {
    expect(moveEndpointsToCheck(":deleted/a-v1.md", "a.md", [":"])).toEqual(["a.md"]);
  });
  it("source is user, dest is system → only source (delete)", () => {
    expect(moveEndpointsToCheck("a.md", ":deleted/a-v1.md", [":"])).toEqual(["a.md"]);
  });
  it("both system → nothing checked (kernel-only move; shouldn't happen from a user call)", () => {
    expect(moveEndpointsToCheck(":deleted/a-v1.md", ":deleted/a-v2.md", [":"])).toEqual([]);
  });
});
