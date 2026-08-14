/**
 * Embed hook contract: HTTP + subprocess against the stub embedder.
 *
 * The stub is the honest test double — same code path both hooks would
 * hit in production, deterministic vectors so we can assert exact hash
 * behavior in worker tests.
 */

import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCmdEmbedHook } from "./cmd-hook.js";
import { validateEmbedResponse } from "./hook.js";
import { createHttpEmbedHook } from "./http-hook.js";

const STUB = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "stub-embedder.mjs",
);

describe("validateEmbedResponse", () => {
  it("accepts a well-formed response", () => {
    const r = validateEmbedResponse({ vectors: [[1, 2, 3]], model: "m", dim: 3 }, ["hello"]);
    expect(r.model).toBe("m");
  });

  it("rejects vectors.length mismatch", () => {
    expect(() =>
      validateEmbedResponse({ vectors: [[1, 2]], model: "m", dim: 2 }, ["a", "b"]),
    ).toThrow(/vectors\.length/);
  });

  it("rejects ragged per-vector dim", () => {
    expect(() =>
      validateEmbedResponse({ vectors: [[1, 2, 3]], model: "m", dim: 4 }, ["x"]),
    ).toThrow(/dim/);
  });

  it("rejects empty model", () => {
    expect(() => validateEmbedResponse({ vectors: [[1]], model: "", dim: 1 }, ["x"])).toThrow(
      /model/,
    );
  });

  it("rejects non-finite values", () => {
    expect(() =>
      validateEmbedResponse({ vectors: [[1, Number.NaN, 3]], model: "m", dim: 3 }, ["x"]),
    ).toThrow(/finite/);
  });
});

describe("http hook (against the stub embedder)", () => {
  let proc: ReturnType<typeof spawn>;
  let port: number;
  beforeAll(async () => {
    // Pick an ephemeral port and hand it to the stub.
    const { createServer } = await import("node:net");
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, () => r()));
    port = (server.address() as AddressInfo).port;
    server.close();
    proc = spawn(process.execPath, [STUB, "--http", String(port), "--dim", "8"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    // Wait for the stub to log its "http on" line — stderr signals ready.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("stub embedder failed to start")), 5000);
      proc.stderr?.setEncoding("utf8");
      proc.stderr?.on("data", (c: string) => {
        if (c.includes("stub-embedder http on")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  });

  afterAll(() => {
    proc?.kill();
  });

  it("round-trips a batch: same text → same vectors", async () => {
    const hook = createHttpEmbedHook({ url: `http://127.0.0.1:${port}` });
    const r1 = await hook.embed(["alpha", "beta"]);
    const r2 = await hook.embed(["alpha", "beta"]);
    expect(r1.model).toBe("stub-embedder-8d");
    expect(r1.dim).toBe(8);
    expect(r1.vectors.length).toBe(2);
    expect(r1.vectors[0]).toEqual(r2.vectors[0]);
    expect(r1.vectors[0]).not.toEqual(r1.vectors[1]);
    await hook.close();
  });
});

describe("cmd hook (against the stub embedder)", () => {
  it("round-trips a batch via JSON-lines over stdio", async () => {
    const hook = createCmdEmbedHook({
      command: process.execPath,
      args: [STUB, "--stdio", "--dim", "4"],
    });
    const r = await hook.embed(["hello", "world"]);
    expect(r.model).toBe("stub-embedder-4d");
    expect(r.dim).toBe(4);
    expect(r.vectors.length).toBe(2);
    // Determinism across batches.
    const r2 = await hook.embed(["hello"]);
    expect(r2.vectors[0]).toEqual(r.vectors[0]);
    await hook.close();
  });
});
