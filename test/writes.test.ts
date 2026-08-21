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
import type { CallContext } from "../src/kernel/context.js";
import type { KernelError } from "../src/kernel/errors.js";
import { type Kernel, createKernel } from "../src/kernel/kernel.js";
import { sqliteAdapter } from "../src/storage-sqlite/adapter.js";
import type { Storage } from "../src/storage/types.js";

let storage: Storage;
let kernel: Kernel;
const actor: CallContext = { author: "alice" };

async function fresh(): Promise<Storage> {
  return sqliteAdapter.open({
    database: `sqlite:${join(tmpdir(), `mrplex-writes-${Date.now()}-${Math.random()}.db`)}`,
  });
}

beforeEach(async () => {
  storage = await fresh();
  kernel = createKernel(storage);
  await storage.repos_create({ slug: "notes", created_at: "2026-08-14T00:00:01Z" });
});

afterEach(async () => {
  await storage.close();
});

// -----------------------------------------------------------------------------
// docs.create
// -----------------------------------------------------------------------------

describe("docs.create", () => {
  it("creates a new document from raw frontmatter", async () => {
    const v = await kernel.docs.create(actor, "notes", "hello.md", {
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
    expect(v.author).toBe("alice");
  });

  it("creates from structured frontmatter, serializing to canonical YAML", async () => {
    const v = await kernel.docs.create(actor, "notes", "hello.md", {
      frontmatter: { title: "Hi", tags: ["a", "b"] },
      body: "b\n",
    });
    expect(v.frontmatter).toEqual({ title: "Hi", tags: ["a", "b"] });
    // Serialized YAML should be parseable back to the same object; exact
    // formatting is the serializer's choice.
    expect(v.frontmatter_raw).toMatch(/title/);
    expect(v.frontmatter_raw).toMatch(/tags/);
  });

  it("empty-frontmatter body is fine — frontmatter_raw becomes ''", async () => {
    const v = await kernel.docs.create(actor, "notes", "readme.md", {
      frontmatter: {},
      body: "hi\n",
    });
    expect(v.frontmatter_raw).toBe("");
  });

  it("rejects supplying both frontmatter forms → frontmatter_invalid", async () => {
    try {
      await kernel.docs.create(actor, "notes", "hello.md", {
        frontmatter: { a: 1 },
        frontmatter_raw: "a: 1\n",
        body: "",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("frontmatter_invalid");
    }
  });

  it("rejects supplying neither frontmatter form → frontmatter_invalid", async () => {
    try {
      await kernel.docs.create(actor, "notes", "hello.md", { body: "b\n" } as never);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("frontmatter_invalid");
    }
  });

  it("rejects malformed raw YAML → frontmatter_invalid", async () => {
    try {
      await kernel.docs.create(actor, "notes", "hello.md", {
        frontmatter_raw: "title: [unclosed",
        body: "b\n",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("frontmatter_invalid");
    }
  });

  it("rejects invalid paths → path_invalid", async () => {
    try {
      await kernel.docs.create(actor, "notes", ":deleted/nope.md", {
        frontmatter_raw: "",
        body: "",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("path_invalid");
    }
  });

  it("rejects duplicate path → create_conflict with current_version_id", async () => {
    const first = await kernel.docs.create(actor, "notes", "hello.md", {
      frontmatter_raw: "",
      body: "one\n",
    });
    try {
      await kernel.docs.create(actor, "notes", "hello.md", {
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

  it("in-place update advances the chain and preserves document identity", async () => {
    const v1 = await makeDoc();
    const v2 = await kernel.docs.put(actor, "notes", v1.version_id, "hello.md", {
      body: "two\n",
    });
    expect(v2.path).toBe("hello.md");
    expect(v2.prev_version_id).toBe(v1.version_id);
    expect(v2.body).toBe("two\n");
    // Frontmatter carried over (input omitted both forms).
    expect(v2.frontmatter).toEqual({ title: "Hi" });
    expect(v2.frontmatter_raw).toBe("title: Hi\n");
  });

  it("caller can override frontmatter without touching body", async () => {
    const v1 = await makeDoc();
    const v2 = await kernel.docs.put(actor, "notes", v1.version_id, "hello.md", {
      frontmatter_raw: "title: Renamed\n",
    });
    expect(v2.frontmatter).toEqual({ title: "Renamed" });
    expect(v2.body).toBe("one\n"); // body carried over
  });

  it("move advances the chain AND changes the path in one operation", async () => {
    const v1 = await makeDoc("hello.md");
    const v2 = await kernel.docs.put(actor, "notes", v1.version_id, "greetings/hi.md", {});
    expect(v2.path).toBe("greetings/hi.md");
    expect(v2.prev_version_id).toBe(v1.version_id);
    // Same document — history has both.
    const history = await kernel.docs.history(actor, "notes", "greetings/hi.md");
    expect(history.map((h) => h.body)).toEqual(["one\n", "one\n"]);
  });

  it("move + content change in one call", async () => {
    const v1 = await makeDoc();
    const v2 = await kernel.docs.put(actor, "notes", v1.version_id, "moved.md", {
      body: "moved and edited\n",
    });
    expect(v2.path).toBe("moved.md");
    expect(v2.body).toBe("moved and edited\n");
  });

  it("stale prev → stale_prev with current_version_id and current_path", async () => {
    const v1 = await makeDoc();
    await kernel.docs.put(actor, "notes", v1.version_id, "hello.md", { body: "two\n" });
    // v1 is now stale.
    try {
      await kernel.docs.put(actor, "notes", v1.version_id, "hello.md", { body: "three\n" });
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

  it("moving into a path occupied by ANOTHER doc → path_taken", async () => {
    const a = await kernel.docs.create(actor, "notes", "a.md", {
      frontmatter_raw: "",
      body: "a\n",
    });
    await kernel.docs.create(actor, "notes", "b.md", {
      frontmatter_raw: "",
      body: "b\n",
    });
    try {
      await kernel.docs.put(actor, "notes", a.version_id, "b.md", {});
      throw new Error("expected throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("path_taken");
    }
  });

  it("unknown prev → version_not_found", async () => {
    try {
      await kernel.docs.put(actor, "notes", "v99999", "hello.md", {});
      throw new Error("expected throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("version_not_found");
    }
  });

  it("malformed prev → version_not_found", async () => {
    try {
      await kernel.docs.put(actor, "notes", "notavalidid", "hello.md", {});
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
  it("moves the document to the system-namespace path", async () => {
    const v1 = await kernel.docs.create(actor, "notes", "hello.md", {
      frontmatter_raw: "",
      body: "hi\n",
    });
    const deleted = await kernel.docs.delete(actor, "notes", v1.version_id);
    expect(deleted.path).toBe(`:deleted/hello-${v1.version_id}.md`);
    expect(deleted.prev_version_id).toBe(v1.version_id);
  });

  it("frees the original path for a new document to take", async () => {
    const v1 = await kernel.docs.create(actor, "notes", "hello.md", {
      frontmatter_raw: "",
      body: "one\n",
    });
    await kernel.docs.delete(actor, "notes", v1.version_id);
    // New doc at the freed path — fresh document identity.
    const v2 = await kernel.docs.create(actor, "notes", "hello.md", {
      frontmatter_raw: "",
      body: "fresh\n",
    });
    expect(v2.body).toBe("fresh\n");
    expect(v2.prev_version_id).toBeNull(); // NEW document, not a restore
  });

  it("deleting an ALREADY-deleted document is a no-op", async () => {
    const v1 = await kernel.docs.create(actor, "notes", "hello.md", {
      frontmatter_raw: "",
      body: "hi\n",
    });
    const deleted = await kernel.docs.delete(actor, "notes", v1.version_id);
    // Calling delete with the deleted-version id: no state change, current
    // version returned.
    const again = await kernel.docs.delete(actor, "notes", deleted.version_id);
    expect(again.version_id).toBe(deleted.version_id);
    expect(again.path).toBe(deleted.path);
  });

  it("delete with a STALE trashed-version prev → stale_prev (not no-op)", async () => {
    // Cycle: create → delete → restore → delete-again. Now call delete with
    // the FIRST trashed version — it's system-namespaced but no longer
    // current. Must fail stale_prev, not be treated as an already-deleted
    // no-op.
    const v1 = await kernel.docs.create(actor, "notes", "hello.md", {
      frontmatter_raw: "",
      body: "one\n",
    });
    const trashed1 = await kernel.docs.delete(actor, "notes", v1.version_id);
    const restored = await kernel.docs.put(actor, "notes", trashed1.version_id, "hello.md", {});
    const trashed2 = await kernel.docs.delete(actor, "notes", restored.version_id);
    // trashed1 is a system-namespaced prev, but no longer current.
    try {
      await kernel.docs.delete(actor, "notes", trashed1.version_id);
      throw new Error("expected stale_prev");
    } catch (err) {
      expect((err as KernelError).code).toBe("stale_prev");
      const data = (err as KernelError<{ current_version_id: string }>).data;
      expect(data.current_version_id).toBe(trashed2.version_id);
    }
  });

  it("restore: docs.put from a trashed prev back to a user-territory path", async () => {
    const v1 = await kernel.docs.create(actor, "notes", "hello.md", {
      frontmatter_raw: "",
      body: "hi\n",
    });
    const trashed = await kernel.docs.delete(actor, "notes", v1.version_id);
    const restored = await kernel.docs.put(actor, "notes", trashed.version_id, "hello.md", {});
    // Same document — history is one continuous chain (v1 → trashed → restored).
    expect(restored.path).toBe("hello.md");
    const history = await kernel.docs.history(actor, "notes", "hello.md");
    expect(history).toHaveLength(3);
    expect(history[0]?.path).toBe("hello.md");
    expect(history[1]?.path).toMatch(/^:deleted\//);
    expect(history[2]?.path).toBe("hello.md");
  });
});
