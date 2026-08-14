/**
 * End-to-end write flows through the kernel — design §4.
 *
 * The tests exercise the whole life-cycle of a document (create → update →
 * move → delete → restore) as the kernel presents it, so this is the
 * strongest signal that the WS1–WS6 pieces compose correctly.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Actor, SYSTEM_ACTOR } from "../src/kernel/auth/actor.js";
import type { KernelError } from "../src/kernel/errors.js";
import { type Kernel, createKernel } from "../src/kernel/kernel.js";
import { sqliteAdapter } from "../src/storage-sqlite/adapter.js";
import type { Storage } from "../src/storage/types.js";

let storage: Storage;
let kernel: Kernel;
let actor: Actor;

function fresh(): Storage {
  return sqliteAdapter.open({
    database: `sqlite:${join(tmpdir(), `mrplex-writes-${Date.now()}-${Math.random()}.db`)}`,
  });
}

beforeEach(() => {
  storage = fresh();
  kernel = createKernel(storage);
  // Seed a user + a repo; the kernel doesn't have create-user yet (WS7), so
  // reach into the adapter. WS7 will replace this with kernel calls.
  const alice = storage.users_create({ slug: "alice", created_at: "2026-08-14T00:00:00Z" });
  storage.repos_create({ slug: "notes", created_at: "2026-08-14T00:00:01Z" });
  actor = { user_id: alice.id, admin: true, scopes: [] };
});

afterEach(() => {
  storage.close();
});

// -----------------------------------------------------------------------------
// docs.create
// -----------------------------------------------------------------------------

describe("docs.create", () => {
  it("creates a new document from raw frontmatter", () => {
    const v = kernel.docs.create(actor, "notes", "hello.md", {
      frontmatter_raw: "title: Hi\n",
      body: "body\n",
    });
    expect(v.repo).toBe("notes");
    expect(v.path).toBe("hello.md");
    expect(v.frontmatter).toEqual({ title: "Hi" });
    expect(v.frontmatter_raw).toBe("title: Hi\n");
    expect(v.body).toBe("body\n");
    expect(v.prev_version_id).toBeNull();
    expect(v.next_version_id).toBeNull();
    expect(v.author.user).toBe("alice");
  });

  it("creates from structured frontmatter, serializing to canonical YAML", () => {
    const v = kernel.docs.create(actor, "notes", "hello.md", {
      frontmatter: { title: "Hi", tags: ["a", "b"] },
      body: "b\n",
    });
    expect(v.frontmatter).toEqual({ title: "Hi", tags: ["a", "b"] });
    // Serialized YAML should be parseable back to the same object; exact
    // formatting is the serializer's choice.
    expect(v.frontmatter_raw).toMatch(/title/);
    expect(v.frontmatter_raw).toMatch(/tags/);
  });

  it("empty-frontmatter body is fine — frontmatter_raw becomes ''", () => {
    const v = kernel.docs.create(actor, "notes", "readme.md", {
      frontmatter: {},
      body: "hi\n",
    });
    expect(v.frontmatter_raw).toBe("");
  });

  it("rejects supplying both frontmatter forms → frontmatter_invalid", () => {
    try {
      kernel.docs.create(actor, "notes", "hello.md", {
        frontmatter: { a: 1 },
        frontmatter_raw: "a: 1\n",
        body: "",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("frontmatter_invalid");
    }
  });

  it("rejects supplying neither frontmatter form → frontmatter_invalid", () => {
    try {
      kernel.docs.create(actor, "notes", "hello.md", { body: "b\n" } as never);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("frontmatter_invalid");
    }
  });

  it("rejects malformed raw YAML → frontmatter_invalid", () => {
    try {
      kernel.docs.create(actor, "notes", "hello.md", {
        frontmatter_raw: "title: [unclosed",
        body: "b\n",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("frontmatter_invalid");
    }
  });

  it("rejects invalid paths → path_invalid", () => {
    try {
      kernel.docs.create(actor, "notes", ":deleted/nope.md", {
        frontmatter_raw: "",
        body: "",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("path_invalid");
    }
  });

  it("rejects duplicate path → create_conflict with current_version_id", () => {
    const first = kernel.docs.create(actor, "notes", "hello.md", {
      frontmatter_raw: "",
      body: "one\n",
    });
    try {
      kernel.docs.create(actor, "notes", "hello.md", {
        frontmatter_raw: "",
        body: "two\n",
      });
      throw new Error("expected throw");
    } catch (err) {
      const ke = err as KernelError<{ current_version_id: string }>;
      expect(ke.code).toBe("create_conflict");
      expect(ke.data.current_version_id).toBe(first.version_id);
    }
  });
});

// -----------------------------------------------------------------------------
// docs.put (update + move + restore)
// -----------------------------------------------------------------------------

describe("docs.put", () => {
  function makeDoc(path = "hello.md", body = "one\n") {
    return kernel.docs.create(actor, "notes", path, {
      frontmatter_raw: "title: Hi\n",
      body,
    });
  }

  it("in-place update advances the chain and preserves document identity", () => {
    const v1 = makeDoc();
    const v2 = kernel.docs.put(actor, "notes", v1.version_id, "hello.md", {
      body: "two\n",
    });
    expect(v2.path).toBe("hello.md");
    expect(v2.prev_version_id).toBe(v1.version_id);
    expect(v2.body).toBe("two\n");
    // Frontmatter carried over (input omitted both forms).
    expect(v2.frontmatter).toEqual({ title: "Hi" });
    expect(v2.frontmatter_raw).toBe("title: Hi\n");
  });

  it("caller can override frontmatter without touching body", () => {
    const v1 = makeDoc();
    const v2 = kernel.docs.put(actor, "notes", v1.version_id, "hello.md", {
      frontmatter_raw: "title: Renamed\n",
    });
    expect(v2.frontmatter).toEqual({ title: "Renamed" });
    expect(v2.body).toBe("one\n"); // body carried over
  });

  it("move advances the chain AND changes the path in one operation", () => {
    const v1 = makeDoc("hello.md");
    const v2 = kernel.docs.put(actor, "notes", v1.version_id, "greetings/hi.md", {});
    expect(v2.path).toBe("greetings/hi.md");
    expect(v2.prev_version_id).toBe(v1.version_id);
    // Same document — history has both.
    const history = kernel.docs.history(actor, "notes", "greetings/hi.md");
    expect(history.map((h) => h.body)).toEqual(["one\n", "one\n"]);
  });

  it("move + content change in one call", () => {
    const v1 = makeDoc();
    const v2 = kernel.docs.put(actor, "notes", v1.version_id, "moved.md", {
      body: "moved and edited\n",
    });
    expect(v2.path).toBe("moved.md");
    expect(v2.body).toBe("moved and edited\n");
  });

  it("stale prev → stale_prev with current_version_id and current_path", () => {
    const v1 = makeDoc();
    kernel.docs.put(actor, "notes", v1.version_id, "hello.md", { body: "two\n" });
    // v1 is now stale.
    try {
      kernel.docs.put(actor, "notes", v1.version_id, "hello.md", { body: "three\n" });
      throw new Error("expected throw");
    } catch (err) {
      const ke = err as KernelError<{
        current_version_id: string;
        current_path: string;
        submitted_prev_version_id: string;
      }>;
      expect(ke.code).toBe("stale_prev");
      expect(ke.data.submitted_prev_version_id).toBe(v1.version_id);
      expect(ke.data.current_version_id).not.toBe(v1.version_id);
      expect(ke.data.current_path).toBe("hello.md");
    }
  });

  it("moving into a path occupied by ANOTHER doc → path_taken", () => {
    const a = kernel.docs.create(actor, "notes", "a.md", {
      frontmatter_raw: "",
      body: "a\n",
    });
    kernel.docs.create(actor, "notes", "b.md", {
      frontmatter_raw: "",
      body: "b\n",
    });
    try {
      kernel.docs.put(actor, "notes", a.version_id, "b.md", {});
      throw new Error("expected throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("path_taken");
    }
  });

  it("unknown prev → version_not_found", () => {
    try {
      kernel.docs.put(actor, "notes", "v99999", "hello.md", {});
      throw new Error("expected throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("version_not_found");
    }
  });

  it("malformed prev → version_not_found", () => {
    try {
      kernel.docs.put(actor, "notes", "notavalidid", "hello.md", {});
      throw new Error("expected throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("version_not_found");
    }
  });
});

// -----------------------------------------------------------------------------
// docs.delete + restore
// -----------------------------------------------------------------------------

describe("docs.delete", () => {
  it("moves the document to the system-namespace path", () => {
    const v1 = kernel.docs.create(actor, "notes", "hello.md", {
      frontmatter_raw: "",
      body: "hi\n",
    });
    const deleted = kernel.docs.delete(actor, "notes", v1.version_id);
    expect(deleted.path).toBe(`:deleted/hello-${v1.version_id}.md`);
    expect(deleted.prev_version_id).toBe(v1.version_id);
  });

  it("frees the original path for a new document to take", () => {
    const v1 = kernel.docs.create(actor, "notes", "hello.md", {
      frontmatter_raw: "",
      body: "one\n",
    });
    kernel.docs.delete(actor, "notes", v1.version_id);
    // New doc at the freed path — fresh document identity.
    const v2 = kernel.docs.create(actor, "notes", "hello.md", {
      frontmatter_raw: "",
      body: "fresh\n",
    });
    expect(v2.body).toBe("fresh\n");
    expect(v2.prev_version_id).toBeNull(); // NEW document, not a restore
  });

  it("deleting an ALREADY-deleted document is a no-op", () => {
    const v1 = kernel.docs.create(actor, "notes", "hello.md", {
      frontmatter_raw: "",
      body: "hi\n",
    });
    const deleted = kernel.docs.delete(actor, "notes", v1.version_id);
    // Calling delete with the deleted-version id: no state change, current
    // version returned.
    const again = kernel.docs.delete(actor, "notes", deleted.version_id);
    expect(again.version_id).toBe(deleted.version_id);
    expect(again.path).toBe(deleted.path);
  });

  it("delete with a STALE trashed-version prev → stale_prev (not no-op)", () => {
    // Cycle: create → delete → restore → delete-again. Now call delete with
    // the FIRST trashed version — it's system-namespaced but no longer
    // current. Must fail stale_prev, not be treated as an already-deleted
    // no-op.
    const v1 = kernel.docs.create(actor, "notes", "hello.md", {
      frontmatter_raw: "",
      body: "one\n",
    });
    const trashed1 = kernel.docs.delete(actor, "notes", v1.version_id);
    const restored = kernel.docs.put(actor, "notes", trashed1.version_id, "hello.md", {});
    const trashed2 = kernel.docs.delete(actor, "notes", restored.version_id);
    // trashed1 is a system-namespaced prev, but no longer current.
    try {
      kernel.docs.delete(actor, "notes", trashed1.version_id);
      throw new Error("expected stale_prev");
    } catch (err) {
      expect((err as KernelError).code).toBe("stale_prev");
      const data = (err as KernelError<{ current_version_id: string }>).data;
      expect(data.current_version_id).toBe(trashed2.version_id);
    }
  });

  it("restore: docs.put from a trashed prev back to a user-territory path", () => {
    const v1 = kernel.docs.create(actor, "notes", "hello.md", {
      frontmatter_raw: "",
      body: "hi\n",
    });
    const trashed = kernel.docs.delete(actor, "notes", v1.version_id);
    const restored = kernel.docs.put(actor, "notes", trashed.version_id, "hello.md", {});
    // Same document — history is one continuous chain (v1 → trashed → restored).
    expect(restored.path).toBe("hello.md");
    const history = kernel.docs.history(actor, "notes", "hello.md");
    expect(history).toHaveLength(3);
    expect(history[0]?.path).toBe("hello.md");
    expect(history[1]?.path).toMatch(/^:deleted\//);
    expect(history[2]?.path).toBe("hello.md");
  });
});

// -----------------------------------------------------------------------------
// Auth-shaped scenarios — non-admin actor
// -----------------------------------------------------------------------------

describe("auth-shaped writes (non-admin actor)", () => {
  let alice: Actor;
  let repoId: number;

  beforeEach(() => {
    const row = storage.repos_by_slug("notes");
    if (!row) throw new Error("seed");
    repoId = row.id;
    const u = storage.users_by_slug("alice");
    if (!u) throw new Error("seed");
    alice = {
      user_id: u.id,
      admin: false,
      scopes: [{ repos: [repoId], read: ["**"], write: ["inbox/**"] }],
    };
  });

  it("write-in-scope: creating under inbox/ succeeds", () => {
    const v = kernel.docs.create(alice, "notes", "inbox/incoming.md", {
      frontmatter_raw: "",
      body: "in\n",
    });
    expect(v.path).toBe("inbox/incoming.md");
  });

  it("write-out-of-scope: create at a path the token doesn't cover → forbidden", () => {
    try {
      kernel.docs.create(alice, "notes", "elsewhere.md", {
        frontmatter_raw: "",
        body: "",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("forbidden");
    }
  });

  it("delete via carve-out: user can delete a doc they can write, without needing write on :deleted/…", () => {
    const v = kernel.docs.create(alice, "notes", "inbox/x.md", {
      frontmatter_raw: "",
      body: "",
    });
    expect(() => kernel.docs.delete(alice, "notes", v.version_id)).not.toThrow();
  });

  it("delete when the source path is out of write scope → forbidden", () => {
    // Create as admin, then attempt delete as alice — alice has write only
    // under inbox/, but the doc is at elsewhere.md.
    const v = kernel.docs.create(actor, "notes", "elsewhere.md", {
      frontmatter_raw: "",
      body: "",
    });
    try {
      kernel.docs.delete(alice, "notes", v.version_id);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("forbidden");
    }
  });
});
