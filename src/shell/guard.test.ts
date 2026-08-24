/**
 * guardKernel behavior — auth-shell plan WS2. The referee is behavioral: a
 * guarded kernel with entitlement E must behave like the old token-auth engine
 * with scopes E. We test against a REAL in-memory kernel (sqlite tmp), never a
 * mock — the whole point of the decorator is that it composes with the actual
 * engine semantics (glob filtering, move both-endpoints, sigil skipping).
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KernelError } from "../kernel/errors.js";
import { type Kernel, createKernel } from "../kernel/kernel.js";
import { sqliteAdapter } from "../storage-sqlite/adapter.js";
import type { Storage } from "../storage/types.js";
import { type AuditEvent, guardKernel } from "./guard.js";
import type { Entitlement } from "./policy.js";

const ROOT = {}; // full-trust context for seeding

let storage: Storage;
let raw: Kernel;

function ent(over: Partial<Entitlement> = {}): Entitlement {
  return {
    author: "Test <test@example.com>",
    read: [],
    write: [],
    destructive: false,
    impersonate: false,
    ...over,
  };
}

async function seed(repo: string, path: string, body = ""): Promise<string> {
  const v = await raw.docs.create(ROOT, repo, path, { frontmatter_raw: "", body });
  return v.version_id;
}

async function expectForbidden(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toMatchObject({ code: "forbidden" });
}

beforeEach(async () => {
  storage = await sqliteAdapter.open({
    database: `sqlite:${join(tmpdir(), `mrplex-guard-${Date.now()}-${Math.random()}.db`)}`,
  });
  raw = createKernel(storage);
  await storage.repos_create({ slug: "notes", created_at: "2026-08-21T00:00:00Z" });
});

afterEach(async () => {
  await storage.close();
});

// -----------------------------------------------------------------------------
// Reads forward with the entitlement's read scope
// -----------------------------------------------------------------------------

describe("read forwarding", () => {
  it("query sees only what the read scope grants", async () => {
    await seed("notes", "public.md");
    await seed("notes", "secret/hidden.md");
    const k = guardKernel(raw, ent({ read: [{ repo: "notes", paths: ["public.md"] }] }));
    const rows = await k.query(ROOT, { repo: "notes" });
    expect(rows.map((r) => r.$path)).toEqual(["public.md"]);
  });

  it("docs.get on an out-of-scope path is forbidden by the engine", async () => {
    await seed("notes", "secret/hidden.md");
    const k = guardKernel(raw, ent({ read: [{ repo: "notes", paths: ["public/**"] }] }));
    await expectForbidden(k.docs.get(ROOT, "notes", "secret/hidden.md"));
  });

  it("ignores a caller-supplied scope — the entitlement's read scope wins", async () => {
    await seed("notes", "public.md");
    await seed("notes", "secret/hidden.md");
    const k = guardKernel(raw, ent({ read: [{ repo: "notes", paths: ["public.md"] }] }));
    // Caller tries to widen its own visibility; the guard overrides it.
    const rows = await k.query({ scope: [{ repo: "*", paths: ["**"] }] }, { repo: "notes" });
    expect(rows.map((r) => r.$path)).toEqual(["public.md"]);
  });
});

// -----------------------------------------------------------------------------
// Author stamping
// -----------------------------------------------------------------------------

describe("author stamping", () => {
  const writer = () => guardKernel(raw, ent({ write: [{ repo: "notes", paths: ["**"] }] }));

  it("stamps the entitlement's author, ignoring the caller's", async () => {
    const v = await writer().docs.create({ author: "attacker" }, "notes", "a.md", {
      frontmatter_raw: "",
      body: "",
    });
    expect(v.author).toBe("Test <test@example.com>");
  });

  it("honors a caller author only under impersonate", async () => {
    const k = guardKernel(
      raw,
      ent({ write: [{ repo: "notes", paths: ["**"] }], impersonate: true }),
    );
    const v = await k.docs.create({ author: "Agent <a@x> for Bob" }, "notes", "b.md", {
      frontmatter_raw: "",
      body: "",
    });
    expect(v.author).toBe("Agent <a@x> for Bob");
  });

  it("falls back to the derived author under impersonate when caller gives none", async () => {
    const k = guardKernel(
      raw,
      ent({ write: [{ repo: "notes", paths: ["**"] }], impersonate: true }),
    );
    const v = await k.docs.create(ROOT, "notes", "c.md", { frontmatter_raw: "", body: "" });
    expect(v.author).toBe("Test <test@example.com>");
  });
});

// -----------------------------------------------------------------------------
// Write policy
// -----------------------------------------------------------------------------

describe("write policy", () => {
  it("allows a create inside the write scope", async () => {
    const k = guardKernel(raw, ent({ write: [{ repo: "notes", paths: ["drafts/**"] }] }));
    const v = await k.docs.create(ROOT, "notes", "drafts/x.md", { frontmatter_raw: "", body: "" });
    expect(v.path).toBe("drafts/x.md");
  });

  it("forbids a create outside the write scope", async () => {
    const k = guardKernel(raw, ent({ write: [{ repo: "notes", paths: ["drafts/**"] }] }));
    await expectForbidden(
      k.docs.create(ROOT, "notes", "published/x.md", { frontmatter_raw: "", body: "" }),
    );
  });

  it("write does not imply read — a write-only grant can create where it cannot see", async () => {
    // Only write on drafts/**, no read scope at all.
    const k = guardKernel(raw, ent({ write: [{ repo: "notes", paths: ["drafts/**"] }] }));
    const v = await k.docs.create(ROOT, "notes", "drafts/blind.md", {
      frontmatter_raw: "",
      body: "",
    });
    expect(v.path).toBe("drafts/blind.md");
    // ...but it cannot read it back: with an empty read scope the engine hides
    // the whole repo (out-of-claim looks like not-found, §8.4), so the read
    // fails even though the write just succeeded.
    await expect(k.docs.get(ROOT, "notes", "drafts/blind.md")).rejects.toMatchObject({
      code: "repo_not_found",
    });
  });

  it("a move checks BOTH endpoints", async () => {
    const vid = await seed("notes", "drafts/movable.md");
    // Write on drafts/** only. Moving within drafts is fine.
    const k = guardKernel(raw, ent({ write: [{ repo: "notes", paths: ["drafts/**"] }] }));
    const moved = await k.docs.put(ROOT, "notes", vid, "drafts/moved.md", {});
    expect(moved.path).toBe("drafts/moved.md");

    // Moving OUT of drafts (destination outside scope) is forbidden.
    const vid2 = await seed("notes", "drafts/other.md");
    await expectForbidden(k.docs.put(ROOT, "notes", vid2, "published/other.md", {}));
  });

  it("forbids a move whose SOURCE is outside the write scope", async () => {
    const vid = await seed("notes", "published/locked.md");
    // Write only on drafts/**; the source published/locked.md is off-limits
    // even though the destination would be in scope.
    const k = guardKernel(raw, ent({ write: [{ repo: "notes", paths: ["drafts/**"] }] }));
    await expectForbidden(k.docs.put(ROOT, "notes", vid, "drafts/here.md", {}));
  });

  it("forbids delete of a doc outside the write scope", async () => {
    const vid = await seed("notes", "published/keep.md");
    const k = guardKernel(raw, ent({ write: [{ repo: "notes", paths: ["drafts/**"] }] }));
    await expectForbidden(k.docs.delete(ROOT, "notes", vid));
  });

  it("allows delete of a doc inside the write scope", async () => {
    const vid = await seed("notes", "drafts/trash.md");
    const k = guardKernel(raw, ent({ write: [{ repo: "notes", paths: ["drafts/**"] }] }));
    const del = await k.docs.delete(ROOT, "notes", vid);
    expect(del.path.startsWith(":deleted/")).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Destructive gating
// -----------------------------------------------------------------------------

describe("destructive gating", () => {
  it("forbids repo ops without the destructive bit", async () => {
    const k = guardKernel(raw, ent({ write: [{ repo: "*", paths: ["**"] }] }));
    await expectForbidden(k.repos.create(ROOT, "new-repo"));
    await expectForbidden(k.repos.rename(ROOT, "notes", "notes2"));
    await expectForbidden(k.repos.delete(ROOT, "notes"));
    await expectForbidden(k.repos.set_path_config(ROOT, "notes", null));
    await expectForbidden(k.repos.set_link_config(ROOT, "notes", null));
  });

  it("allows repo ops with the destructive bit", async () => {
    const k = guardKernel(raw, ent({ destructive: true }));
    const r = await k.repos.create(ROOT, "fresh");
    expect(r.repo).toBe("fresh");
  });

  it("gates links.backfill and live repair, but allows dry-run repair as a read", async () => {
    await seed("notes", "a.md");
    const k = guardKernel(raw, ent({ read: [{ repo: "notes", paths: ["**"] }] }));
    await expectForbidden(k.links.backfill(ROOT, "notes"));
    await expectForbidden(k.links.repair(ROOT, "notes", { dry_run: false }));
    // dry-run is a read → allowed under a read-only entitlement.
    const plan = await k.links.repair(ROOT, "notes", { dry_run: true });
    expect(plan.dry_run).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Audit
// -----------------------------------------------------------------------------

describe("audit", () => {
  it("emits an event per call with op/repo/path/outcome", async () => {
    const events: AuditEvent[] = [];
    const k = guardKernel(raw, ent({ write: [{ repo: "notes", paths: ["drafts/**"] }] }), (e) =>
      events.push(e),
    );
    await k.docs.create(ROOT, "notes", "drafts/a.md", { frontmatter_raw: "", body: "" });
    await expectForbidden(
      k.docs.create(ROOT, "notes", "published/b.md", { frontmatter_raw: "", body: "" }),
    );
    expect(events).toEqual([
      { op: "docs.create", repo: "notes", path: "drafts/a.md", outcome: "ok" },
      { op: "docs.create", repo: "notes", path: "published/b.md", outcome: "forbidden" },
    ]);
  });

  it("records the engine error code on an allowed-but-failed call", async () => {
    const events: AuditEvent[] = [];
    const k = guardKernel(raw, ent({ read: [{ repo: "notes", paths: ["**"] }] }), (e) =>
      events.push(e),
    );
    await expect(k.docs.get(ROOT, "notes", "nope.md")).rejects.toBeInstanceOf(KernelError);
    expect(events).toEqual([
      { op: "docs.get", repo: "notes", path: "nope.md", outcome: "ok", error: "doc_not_found" },
    ]);
  });
});
