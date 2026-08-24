/**
 * Sync timelines. Each test is an ordered list of steps; the expect is the
 * vault after the last one.
 *
 *   write     path  body     editor save (keeps existing $version / $hash)
 *   clone     from  to       copy bytes (rename dest appears before unlink)
 *   drop      path           unlink
 *   mv        from  to       rename (bytes travel)
 *   push                     burst: pending paths, or every file if pending empty
 *   push      path...        burst of exactly these paths
 *   feed                     drain history.since(cursor)
 *   during    path  body     next kernel write: disk becomes `body` before ack
 *   remote-put path body     out-of-band remote edit (other writer)
 *
 * `bodies` = non-ignored path → user body. `ignored` = `$sync: ignore` paths.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KernelClient } from "../src/client/kernel-client.js";
import { openLocalClient } from "../src/client/local.js";
import { join, split } from "../src/markdown/frontmatter.js";
import { applyFeed } from "../src/sync/feed.js";
import { isIgnored, readFileIntrinsics } from "../src/sync/intrinsics.js";
import { makeScopeFilter } from "../src/sync/paths.js";
import { type RemoteMap, pushBurst } from "../src/sync/push.js";
import type { FileStore } from "../src/sync/reconcile.js";

type Step =
  | readonly ["write", string, string]
  | readonly ["clone", string, string]
  | readonly ["drop", string]
  | readonly ["mv", string, string]
  | readonly ["push", ...string[]]
  | readonly ["feed"]
  | readonly ["during", string, string]
  | readonly ["remote-put", string, string];

let client: KernelClient;

beforeEach(async () => {
  client = await openLocalClient({ database: "sqlite::memory:", context: {} });
  await client.repos.create("notes");
});

afterEach(async () => {
  await client.close();
});

const scope = makeScopeFilter();

async function run(steps: Step[]) {
  const files = new Map<string, string>();
  const pending = new Set<string>();
  let during: { path: string; body: string } | null = null;
  let cursor = "";
  const map: RemoteMap = new Map();

  const store: FileStore & { files: Map<string, string> } = {
    files,
    async list() {
      return [...files.keys()];
    },
    async read(p) {
      return files.get(p) ?? null;
    },
    async write(p, text) {
      files.set(p, text);
    },
    async remove(p) {
      files.delete(p);
    },
  };

  const wrapped: KernelClient = {
    ...client,
    docs: {
      ...client.docs,
      create: async (...args) => {
        const v = await client.docs.create(...args);
        applyDuring();
        return v;
      },
      put: async (...args) => {
        const v = await client.docs.put(...args);
        applyDuring();
        return v;
      },
    },
  };

  function applyDuring(): void {
    if (!during) return;
    const { path, body } = during;
    during = null;
    const existing = files.get(path);
    files.set(path, existing ? withBody(existing, body) : body);
  }

  function touch(...paths: string[]): void {
    for (const p of paths) pending.add(p);
  }

  for (const step of steps) {
    switch (step[0]) {
      case "write": {
        const [, path, body] = step;
        const existing = files.get(path);
        files.set(path, existing ? withBody(existing, body) : body);
        touch(path);
        break;
      }
      case "clone": {
        const [, from, to] = step;
        const text = files.get(from);
        if (text === undefined) throw new Error(`clone: missing ${from}`);
        files.set(to, text);
        touch(to);
        break;
      }
      case "drop": {
        files.delete(step[1]);
        touch(step[1]);
        break;
      }
      case "mv": {
        const [, from, to] = step;
        const text = files.get(from);
        if (text === undefined) throw new Error(`mv: missing ${from}`);
        files.delete(from);
        files.set(to, text);
        touch(from, to);
        break;
      }
      case "during": {
        during = { path: step[1], body: step[2] };
        break;
      }
      case "remote-put": {
        const cur = await client.docs.get("notes", step[1]);
        await client.docs.put("notes", cur.version_id, step[1], {
          body: step[2],
          frontmatter_raw: "",
        });
        break;
      }
      case "push": {
        const named = step.slice(1) as string[];
        const paths =
          named.length > 0 ? named : pending.size > 0 ? [...pending] : [...files.keys()];
        await pushBurst(paths, { client: wrapped, store, repo: "notes", map });
        for (const p of paths) pending.delete(p);
        break;
      }
      case "feed": {
        const { cursor: next } = await applyFeed(wrapped, store, scope, {
          repo: "notes",
          since: cursor,
          map,
        });
        cursor = next;
        break;
      }
      default: {
        const _never: never = step;
        throw new Error(`unknown step: ${JSON.stringify(_never)}`);
      }
    }
  }

  return {
    bodies: Object.fromEntries(
      [...files.entries()]
        .filter(([, text]) => !isIgnored(readFileIntrinsics(text)))
        .map(([path, text]) => [path, split(text.replace(/\r\n/g, "\n")).body]),
    ) as Record<string, string>,
    ignored: [...files.keys()]
      .filter((p) => isIgnored(readFileIntrinsics(files.get(p) ?? "")))
      .sort(),
    async remote(path: string): Promise<string> {
      return (await client.docs.get("notes", path)).body;
    },
  };
}

function withBody(file: string, body: string): string {
  const { frontmatter_raw } = split(file.replace(/\r\n/g, "\n"));
  return join({ frontmatter_raw, body });
}

describe("sync timelines", () => {
  it("write → push: new note stamps, remote matches, no sibling", async () => {
    const v = await run([["write", "a.md", "hello\n"], ["push"]]);
    expect(v.bodies).toEqual({ "a.md": "hello\n" });
    expect(v.ignored).toEqual([]);
    expect(await v.remote("a.md")).toBe("hello\n");
  });

  it("write → push → write → push: second edit is a put, no sibling", async () => {
    const v = await run([
      ["write", "a.md", "one\n"],
      ["push"],
      ["write", "a.md", "two\n"],
      ["push"],
    ]);
    expect(v.bodies).toEqual({ "a.md": "two\n" });
    expect(v.ignored).toEqual([]);
    expect(await v.remote("a.md")).toBe("two\n");
  });

  it("empty create → rename → push: clean move, old path gone", async () => {
    const v = await run([
      ["write", "Untitled.md", ""],
      ["push"],
      ["mv", "Untitled.md", "note.md"],
      ["push"],
    ]);
    expect(v.bodies).toEqual({ "note.md": "" });
    expect(v.ignored).toEqual([]);
    expect(await v.remote("note.md")).toBe("");
    await expect(client.docs.get("notes", "Untitled.md")).rejects.toThrow();
  });

  it("Obsidian: untitled → push → rename → type → push → feed", async () => {
    const v = await run([
      ["write", "Untitled.md", ""],
      ["push"],
      ["mv", "Untitled.md", "cool.md"],
      ["write", "cool.md", "so cool\n"],
      ["push"],
      ["feed"],
    ]);
    expect(v.bodies).toEqual({ "cool.md": "so cool\n" });
    expect(v.ignored).toEqual([]);
    expect(await v.remote("cool.md")).toBe("so cool\n");
  });

  it("Obsidian: rename → type → push → feed → type more → push → feed", async () => {
    const v = await run([
      ["write", "Untitled.md", ""],
      ["push"],
      ["mv", "Untitled.md", "cool.md"],
      ["write", "cool.md", "so cool\n"],
      ["push"],
      ["feed"],
      ["write", "cool.md", "so cool Mr Coolpants\n"],
      ["push"],
      ["feed"],
    ]);
    expect(v.bodies).toEqual({ "cool.md": "so cool Mr Coolpants\n" });
    expect(v.ignored).toEqual([]);
    expect(await v.remote("cool.md")).toBe("so cool Mr Coolpants\n");
  });

  it("stale $version + more typing → rebase, not sibling", async () => {
    const v = await run([
      ["write", "a.md", "name is #\n"],
      ["push"],
      ["write", "a.md", "name is Mr Coolpants\n"],
      ["push"],
      ["feed"],
    ]);
    expect(v.bodies).toEqual({ "a.md": "name is Mr Coolpants\n" });
    expect(v.ignored).toEqual([]);
    expect(await v.remote("a.md")).toBe("name is Mr Coolpants\n");
  });

  it("feed echo while dirty on the same $version: no sibling, no clobber", async () => {
    const v = await run([
      ["write", "a.md", "one\n"],
      ["push"],
      ["write", "a.md", "one two\n"],
      ["feed"],
    ]);
    expect(v.bodies).toEqual({ "a.md": "one two\n" });
    expect(v.ignored).toEqual([]);
  });

  it("feed replay does not clobber a newer clean local with an older ref", async () => {
    const v = await run([
      ["write", "a.md", "one\n"],
      ["push"],
      ["write", "a.md", "two\n"],
      ["push"],
      ["feed"],
    ]);
    expect(v.bodies).toEqual({ "a.md": "two\n" });
    expect(v.ignored).toEqual([]);
    expect(await v.remote("a.md")).toBe("two\n");
  });

  it("editor types during ack rewrite: later bytes survive", async () => {
    const v = await run([["write", "a.md", "one\n"], ["during", "a.md", "one two\n"], ["push"]]);
    expect(v.bodies).toEqual({ "a.md": "one two\n" });
    expect(v.ignored).toEqual([]);
    expect(await v.remote("a.md")).toBe("one\n");
  });

  it("editor types during ack, next push uploads the continuation", async () => {
    const v = await run([
      ["write", "a.md", "one\n"],
      ["during", "a.md", "one two\n"],
      ["push"],
      ["push"],
    ]);
    expect(v.bodies).toEqual({ "a.md": "one two\n" });
    expect(v.ignored).toEqual([]);
    expect(await v.remote("a.md")).toBe("one two\n");
  });

  it("drop → push: witnessed delete", async () => {
    const v = await run([["write", "gone.md", "x\n"], ["push"], ["drop", "gone.md"], ["push"]]);
    expect(v.bodies).toEqual({});
    await expect(client.docs.get("notes", "gone.md")).rejects.toThrow();
  });

  it("rename + type in one burst: move with new bytes, not delete", async () => {
    const v = await run([
      ["write", "Untitled.md", ""],
      ["push"],
      ["mv", "Untitled.md", "note.md"],
      ["write", "note.md", "typed after rename\n"],
      ["push"],
    ]);
    expect(v.bodies).toEqual({ "note.md": "typed after rename\n" });
    expect(v.ignored).toEqual([]);
    expect(await v.remote("note.md")).toBe("typed after rename\n");
    await expect(client.docs.get("notes", "Untitled.md")).rejects.toThrow();
  });

  it("unlink burst, then dest with old $version: restore from :deleted", async () => {
    const v = await run([
      ["write", "Untitled.md", "idea\n"],
      ["push"],
      ["clone", "Untitled.md", "note.md"],
      ["drop", "Untitled.md"],
      ["push", "Untitled.md"],
      ["push", "note.md"],
    ]);
    expect(v.bodies).toEqual({ "note.md": "idea\n" });
    expect(v.ignored).toEqual([]);
    expect(await v.remote("note.md")).toBe("idea\n");
  });

  it("two-writer: feed of newer remote vs dirty local parks sibling, keeps local", async () => {
    const v = await run([
      ["write", "a.md", "base\n"],
      ["push"],
      ["write", "a.md", "my local edit\n"],
      ["remote-put", "a.md", "their remote edit\n"],
      ["feed"],
    ]);
    expect(v.bodies["a.md"]).toBe("my local edit\n");
    expect(v.ignored.length).toBe(1);
  });
});
