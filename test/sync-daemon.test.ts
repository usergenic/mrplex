/**
 * The two-way sync daemon (sync/history plan §4.3–4.8, M8). Drives the real
 * daemon against a local-kernel client and a temp vault, exercising the watcher
 * (local → remote) and the poll loop (remote → local) with short timings.
 */

import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KernelClient } from "../src/client/kernel-client.js";
import { openLocalClient } from "../src/client/local.js";
import { type Daemon, startDaemon } from "../src/sync/daemon.js";

let client: KernelClient;
let vault: string;
let daemon: Daemon | undefined;

beforeEach(async () => {
  vault = mkdtempSync(join(tmpdir(), "mrplex-daemon-"));
  client = await openLocalClient({ database: "sqlite::memory:", context: {} });
  await client.repos.create("notes");
});

afterEach(async () => {
  if (daemon) await daemon.stop();
  daemon = undefined;
  await client.close();
  rmSync(vault, { recursive: true, force: true });
});

async function start(): Promise<Daemon> {
  const d = startDaemon(client, {
    root: vault,
    repo: "notes",
    intervalMs: 100,
    debounceMs: 50,
  });
  await d.ready;
  return d;
}

/** Poll `fn` until it returns truthy or the deadline passes. */
async function waitFor<T>(
  fn: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 3000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("sync daemon", () => {
  it("materializes a remote change into the vault via the poll loop", async () => {
    daemon = await start();
    // Create a doc remotely AFTER the daemon is running.
    await client.docs.create("notes", "remote.md", { body: "hello\n", frontmatter_raw: "" });
    const text = await waitFor(() => {
      try {
        return readFileSync(join(vault, "remote.md"), "utf8");
      } catch {
        return undefined;
      }
    });
    expect(text).toContain("hello");
    expect(text).toMatch(/\$version: v\d+/);
  });

  it("pushes a new local file to the remote via the watcher", async () => {
    daemon = await start();
    writeFileSync(join(vault, "local.md"), "brand new\n");
    const v = await waitFor(async () => {
      try {
        return await client.docs.get("notes", "local.md");
      } catch {
        return undefined;
      }
    });
    expect(v.body).toBe("brand new\n");
    // The local file gets its provenance rewritten by the ack.
    const text = await waitFor(() => {
      const t = readFileSync(join(vault, "local.md"), "utf8");
      return t.includes("$version") ? t : undefined;
    });
    expect(text).toMatch(/\$version: v\d+/);
  });

  it("witnessed local delete propagates to a remote delete", async () => {
    // Seed a doc and let the daemon materialize it.
    await client.docs.create("notes", "gone.md", { body: "x\n", frontmatter_raw: "" });
    daemon = await start();
    await waitFor(() => {
      try {
        readFileSync(join(vault, "gone.md"), "utf8");
        return true;
      } catch {
        return false;
      }
    });
    // Now delete the local file — a witnessed unlink.
    unlinkSync(join(vault, "gone.md"));
    await waitFor(async () => {
      try {
        await client.docs.get("notes", "gone.md");
        return false; // still live
      } catch {
        return true; // doc_not_found → deleted
      }
    });
  });

  it("a local edit round-trips and re-materializes with new provenance", async () => {
    const v1 = await client.docs.create("notes", "a.md", { body: "one\n", frontmatter_raw: "" });
    daemon = await start();
    // Wait for the initial materialization.
    await waitFor(() => {
      try {
        return readFileSync(join(vault, "a.md"), "utf8").includes("one");
      } catch {
        return false;
      }
    });
    // Edit the body locally (keep the embedded $version line so it's a put).
    const original = readFileSync(join(vault, "a.md"), "utf8");
    writeFileSync(join(vault, "a.md"), original.replace("one", "two"));
    const v2 = await waitFor(async () => {
      const cur = await client.docs.get("notes", "a.md");
      return cur.body === "two\n" ? cur : undefined;
    });
    expect(v2.prev_version_id).toBe(v1.version_id);
  });
});
