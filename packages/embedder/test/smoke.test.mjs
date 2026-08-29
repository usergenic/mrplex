/**
 * Smoke tests for the real embedder subprocess contract.
 * Requires `npm install` in packages/embedder (pulls fastembed + model on first run).
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EMBEDDER = join(ROOT, "embedder.mjs");

/** Spawn embedder with args; wait until stderr signals readiness. */
async function spawnEmbedder(args) {
  const proc = spawn(process.execPath, [EMBEDDER, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const ready = once(proc.stderr, "data").then(([chunk]) => {
    const text = String(chunk);
    assert.match(text, /embedder stdio model=/);
    return text;
  });
  const exit = once(proc, "exit");
  return { proc, ready, exit };
}

function writeLine(proc, obj) {
  proc.stdin.write(`${JSON.stringify(obj)}\n`);
}

async function readLine(proc) {
  proc.stdout.setEncoding("utf8");
  const [chunk] = await once(proc.stdout, "data");
  return chunk.trim();
}

describe("@mrplex/embedder smoke", () => {
  it("--help and --version exit cleanly", async () => {
    const help = spawn(process.execPath, [EMBEDDER, "--help"], { stdio: ["ignore", "pipe", "pipe"] });
    const [helpErr] = await once(help.stderr, "data");
    assert.match(String(helpErr), /mrplex-embedder/);
    assert.equal((await once(help, "exit"))[0], 0);

    const ver = spawn(process.execPath, [EMBEDDER, "--version"], { stdio: ["ignore", "pipe", "pipe"] });
    const [out] = await once(ver.stdout, "data");
    assert.match(String(out).trim(), /^\d+\.\d+\.\d+$/);
    assert.equal((await once(ver, "exit"))[0], 0);
  });

  it("--list-models prints known keys", async () => {
    const proc = spawn(process.execPath, [EMBEDDER, "--list-models"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      out += chunk;
    });
    const [code] = await once(proc, "exit");
    assert.equal(code, 0);
    assert.match(out, /fast-bge-small-en-v1\.5/);
  });

  describe("stdio hook", () => {
    let proc;

    before(async () => {
      ({ proc } = await spawnEmbedder([]));
    }, { timeout: 120_000 });

    after(() => {
      proc.stdin.end();
      proc.kill();
    });

    it("embeds a batch with correct dim and model", async () => {
      writeLine(proc, { chunks: ["hello world", "second chunk"] });
      const line = await readLine(proc);
      const body = JSON.parse(line);
      assert.equal(body.model, "fast-bge-small-en-v1.5");
      assert.equal(body.dim, 384);
      assert.equal(body.vectors.length, 2);
      assert.equal(body.vectors[0].length, 384);
      for (const v of body.vectors[0]) {
        assert.equal(typeof v, "number");
        assert.ok(Number.isFinite(v));
      }
    });

    it("returns an empty vectors array for an empty chunks list", async () => {
      writeLine(proc, { chunks: [] });
      const body = JSON.parse(await readLine(proc));
      assert.deepEqual(body.vectors, []);
      assert.equal(body.model, "fast-bge-small-en-v1.5");
      assert.equal(body.dim, 384);
    });

    it("returns { error } for malformed input", async () => {
      proc.stdin.write("{not json}\n");
      const body = JSON.parse(await readLine(proc));
      assert.match(body.error, /invalid JSON/);

      writeLine(proc, { foo: 1 });
      const body2 = JSON.parse(await readLine(proc));
      assert.match(body2.error, /chunks/);
    });
  });

  it("--stdio is accepted as a backward-compatible no-op", async () => {
    const { proc, ready } = await spawnEmbedder(["--stdio"]);
    await ready;
    writeLine(proc, { chunks: ["compat"] });
    const body = JSON.parse(await readLine(proc));
    assert.equal(body.dim, 384);
    proc.stdin.end();
    proc.kill();
  }, { timeout: 120_000 });
});
