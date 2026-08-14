import { describe, expect, it } from "vitest";
import { KernelError } from "../errors.js";
import { type Actor, SYSTEM_ACTOR } from "./actor.js";
import { authorize } from "./authorize.js";

function expectForbidden(fn: () => void): void {
  try {
    fn();
    throw new Error("expected forbidden");
  } catch (err) {
    expect(err).toBeInstanceOf(KernelError);
    expect((err as KernelError).code).toBe("forbidden");
  }
}

describe("authorize — admin short-circuit", () => {
  it("admin can do read on server", () => {
    expect(() => authorize(SYSTEM_ACTOR, "read", { kind: "server" })).not.toThrow();
  });
  it("admin can do admin on server_admin", () => {
    expect(() => authorize(SYSTEM_ACTOR, "admin", { kind: "server_admin" })).not.toThrow();
  });
  it("admin can do write on any move", () => {
    expect(() =>
      authorize(SYSTEM_ACTOR, "write", {
        kind: "move",
        repo_id: 1,
        source: "a.md",
        destination: "b.md",
      }),
    ).not.toThrow();
  });
});

describe("authorize — non-admin actor", () => {
  const reader: Actor = {
    user_id: 1,
    admin: false,
    scopes: [{ repos: [1], read: ["**"] }],
  };
  const writer: Actor = {
    user_id: 2,
    admin: false,
    scopes: [{ repos: [1], read: ["**"], write: ["inbox/**"] }],
  };
  const narrow: Actor = {
    user_id: 3,
    admin: false,
    scopes: [{ repos: [1], read: ["drafts/**"] }],
  };

  it("reads at the server level are always allowed (surface filters)", () => {
    expect(() => authorize(reader, "read", { kind: "server" })).not.toThrow();
  });

  it("server_admin is forbidden for non-admin", () => {
    expectForbidden(() => authorize(reader, "read", { kind: "server_admin" }));
    expectForbidden(() => authorize(reader, "admin", { kind: "server_admin" }));
  });

  it("admin action is forbidden for non-admin, regardless of target", () => {
    expectForbidden(() => authorize(reader, "admin", { kind: "server" }));
    expectForbidden(() => authorize(reader, "admin", { kind: "repo", repo_id: 1 }));
  });

  it("read on repo scoped to caller → allowed", () => {
    expect(() => authorize(reader, "read", { kind: "repo", repo_id: 1 })).not.toThrow();
  });

  it("read on repo NOT scoped to caller → forbidden", () => {
    expectForbidden(() => authorize(reader, "read", { kind: "repo", repo_id: 42 }));
  });

  it("read on path in-scope → allowed", () => {
    expect(() =>
      authorize(reader, "read", { kind: "path", repo_id: 1, path: "notes/hi.md" }),
    ).not.toThrow();
  });

  it("read on path outside scope → forbidden", () => {
    expectForbidden(() =>
      authorize(narrow, "read", { kind: "path", repo_id: 1, path: "notes/hi.md" }),
    );
  });

  it("read does not imply write", () => {
    expectForbidden(() =>
      authorize(reader, "write", { kind: "path", repo_id: 1, path: "inbox/x.md" }),
    );
  });

  it("write on path in-scope → allowed", () => {
    expect(() =>
      authorize(writer, "write", { kind: "path", repo_id: 1, path: "inbox/foo.md" }),
    ).not.toThrow();
  });

  it("write on path outside write scope → forbidden even if reader can see it", () => {
    expectForbidden(() =>
      authorize(writer, "write", { kind: "path", repo_id: 1, path: "drafts/foo.md" }),
    );
  });
});

describe("authorize — move + system-namespace carve-out", () => {
  const writer: Actor = {
    user_id: 2,
    admin: false,
    scopes: [{ repos: [1], write: ["**"] }],
  };
  const narrow: Actor = {
    user_id: 3,
    admin: false,
    scopes: [{ repos: [1], write: ["notes/**"] }],
  };

  it("user-to-user move: both endpoints must be in write scope", () => {
    expect(() =>
      authorize(writer, "write", {
        kind: "move",
        repo_id: 1,
        source: "a.md",
        destination: "b.md",
      }),
    ).not.toThrow();
  });

  it("user-to-user move: one endpoint out of scope → forbidden", () => {
    expectForbidden(() =>
      authorize(narrow, "write", {
        kind: "move",
        repo_id: 1,
        source: "notes/a.md",
        destination: "elsewhere.md",
      }),
    );
  });

  it("delete: user-territory → system endpoint; only source is checked", () => {
    // narrow only has write access under notes/; deleting from notes/ is OK
    // even though the destination :deleted/... is not in its glob.
    expect(() =>
      authorize(narrow, "write", {
        kind: "move",
        repo_id: 1,
        source: "notes/a.md",
        destination: ":deleted/notes/a-v1.md",
      }),
    ).not.toThrow();
  });

  it("delete requires write on the user-territory endpoint", () => {
    expectForbidden(() =>
      authorize(narrow, "write", {
        kind: "move",
        repo_id: 1,
        source: "elsewhere.md",
        destination: ":deleted/elsewhere-v1.md",
      }),
    );
  });

  it("restore: system → user-territory endpoint; only destination is checked", () => {
    expect(() =>
      authorize(narrow, "write", {
        kind: "move",
        repo_id: 1,
        source: ":deleted/notes/a-v1.md",
        destination: "notes/restored.md",
      }),
    ).not.toThrow();
    expectForbidden(() =>
      authorize(narrow, "write", {
        kind: "move",
        repo_id: 1,
        source: ":deleted/elsewhere-v1.md",
        destination: "elsewhere.md",
      }),
    );
  });

  it("read action on a move target is forbidden (moves are writes)", () => {
    expectForbidden(() =>
      authorize(writer, "read", {
        kind: "move",
        repo_id: 1,
        source: "a.md",
        destination: "b.md",
      }),
    );
  });
});
