/**
 * The two-way sync daemon (sync/history plan §4.3–4.8, M8). Drives the real
 * daemon against a local-kernel client and a temp vault, exercising the watcher
 * (local → remote) and the poll loop (remote → local) with short timings.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
    // Poll the filesystem instead of using the native backend. On macOS the
    // fsevents stream silently drops events under the parallel suite's CPU
    // load (even after chokidar's `ready` fires and the stream is armed), which
    // made these tests hang until timeout — a *lost* event, not a slow one, so
    // no cap could fix it. Polling cannot miss a change; it only observes it up
    // to one interval late. A tight interval keeps the tests fast. Production
    // keeps the native backend and relies on the periodic rescan safety-net.
    usePolling: true,
    watchIntervalMs: 15,
  });
  await d.ready;
  return d;
}

/**
 * The propagation cap for every daemon assertion below. These tests all wait
 * on an explicit condition (the expected version/verdict appearing), never a
 * fixed sleep, so a generous cap only costs wall-clock time on a genuine hang.
 * One shared knob rather than per-call overrides.
 *
 * With the polling watcher (see `start`) propagation is reliably ~1s even under
 * the loaded parallel suite, so this only needs headroom for a slow CI worker,
 * not for the old lost-event hangs. Kept under vitest's `testTimeout` so a real
 * hang fails here with a clear "waitFor timed out" rather than the opaque outer
 * test timeout.
 */
const PROPAGATION_TIMEOUT_MS = 15_000;

/** Poll `fn` until it returns truthy or the deadline passes. */
async function waitFor<T>(
  fn: () => T | undefined | Promise<T | undefined>,
  timeoutMs = PROPAGATION_TIMEOUT_MS,
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

  it("with a cursor marker present, skips the index scan (offline deletes are lazy, §4.9)", async () => {
    // A remote doc exists but is NOT on the local disk. Write a cursor marker
    // whose position is already past that doc's create, so the feed-from-cursor
    // delivers nothing. If the daemon (wrongly) ran a full index reconciliation
    // it would materialize the doc; with a marker present it must not.
    const v = await client.docs.create("notes", "server-only.md", {
      body: "on server\n",
      frontmatter_raw: "",
    });
    mkdirSync(join(vault, ".mrplex"), { recursive: true });
    writeFileSync(
      join(vault, ".mrplex/sync.json"),
      `${JSON.stringify({ repo: "notes", last_synced_version_id: v.version_id })}\n`,
    );
    daemon = await start();
    // Give the startup path time to (not) materialize.
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(join(vault, "server-only.md"))).toBe(false);
  });

  it("a local rename of a clean file is a move, not a delete", async () => {
    const v1 = await client.docs.create("notes", "Untitled.md", {
      body: "This is a brand new idea.\n",
      frontmatter_raw: "",
    });
    daemon = await start();
    await waitFor(() => {
      try {
        return readFileSync(join(vault, "Untitled.md"), "utf8").includes("$version");
      } catch {
        return false;
      }
    });
    renameSync(join(vault, "Untitled.md"), join(vault, "brand-new-idea.md"));
    // A rename is detected as a move only when chokidar delivers unlink(old)+
    // add(new) inside one debounce burst, so pushBurst can suppress the delete
    // (§4.7). Under load those fs events can be delayed or split across bursts,
    // in which case the move completes via the slower recoverStalePut
    // restore-from-`:deleted` path — same eventual result, just later. Covered
    // by the shared PROPAGATION_TIMEOUT_MS headroom.
    const moved = await waitFor(async () => {
      try {
        return await client.docs.get("notes", "brand-new-idea.md");
      } catch {
        return undefined;
      }
    });
    expect(moved.prev_version_id).toBe(v1.version_id);
    expect(moved.body).toBe("This is a brand new idea.\n");
    await expect(client.docs.get("notes", "Untitled.md")).rejects.toThrow();
  });

  it("with a marker present, pushes an offline local edit via the dirty walk", async () => {
    // Materialize a doc, stop, edit offline, then restart with the marker.
    const v1 = await client.docs.create("notes", "a.md", { body: "one\n", frontmatter_raw: "" });
    daemon = await start();
    await waitFor(() => {
      try {
        return readFileSync(join(vault, "a.md"), "utf8").includes("one");
      } catch {
        return false;
      }
    });
    await daemon.stop();
    daemon = undefined;
    // Offline edit (daemon not running).
    const original = readFileSync(join(vault, "a.md"), "utf8");
    writeFileSync(join(vault, "a.md"), original.replace("one", "offline edit"));
    // Restart: the marker is present, so the local dirty walk should push it.
    daemon = await start();
    const cur = await waitFor(async () => {
      const c = await client.docs.get("notes", "a.md");
      return c.body === "offline edit\n" ? c : undefined;
    });
    expect(cur.prev_version_id).toBe(v1.version_id);
  });
});
