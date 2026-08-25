/**
 * Real-fs FileStore: provenance writes must not bump mtime, or Obsidian Sync
 * / iCloud will treat the stamped vault copy as newer than an unsynced mobile
 * buffer and push the snapshot back (clobber).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFsStore } from "../src/sync/fs-store.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mrplex-fs-store-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("createFsStore mtime", () => {
  it("preserveMtime keeps the previous mtime across a provenance rewrite", async () => {
    const abs = join(root, "note.md");
    await writeFile(abs, "hello\n", "utf8");
    const before = (await stat(abs)).mtimeMs;
    await new Promise((r) => setTimeout(r, 25));
    const store = createFsStore(root);
    await store.write("note.md", "---\n$version: v1\n---\nhello\n", { preserveMtime: true });
    const after = (await stat(abs)).mtimeMs;
    expect(Math.abs(after - before)).toBeLessThan(2);
    expect(await store.read("note.md")).toContain("$version: v1");
  });

  it("a plain write (real content change) does bump mtime", async () => {
    const abs = join(root, "note.md");
    await writeFile(abs, "hello\n", "utf8");
    const before = (await stat(abs)).mtimeMs;
    await new Promise((r) => setTimeout(r, 25));
    const store = createFsStore(root);
    await store.write("note.md", "goodbye\n");
    const after = (await stat(abs)).mtimeMs;
    expect(after).toBeGreaterThan(before);
  });
});
