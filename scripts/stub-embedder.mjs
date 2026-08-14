#!/usr/bin/env node
/**
 * Deterministic stub embedder for M4 dev + tests.
 *
 * Speaks BOTH hook shapes so we exercise the real contract:
 *   node scripts/stub-embedder.mjs --http 8399
 *   node scripts/stub-embedder.mjs --stdio
 *
 * Vector algorithm: sha256 the chunk, split the digest into `dim`
 * float32 lanes normalized to [-1, 1]. Then L2-normalize (so cosine
 * distance is stable at unit length). Deterministic — same text →
 * same vector, always. Non-zero and non-degenerate (unlike the design
 * doc's original "no-op" hook proposal, which we deliberately DON'T
 * ship; see m4-plan §5 decision 2).
 *
 * Optional failure-injection flags exercise the worker's backoff:
 *   --fail-rate 0.5   fail 50% of batches (deterministic per-batch)
 *   --slow-ms 200     add latency to every batch
 *   --model NAME      override the model string in the response
 *   --dim N           override the dimensionality (default 32)
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const has = (name) => argv.includes(name);

const dim = Number.parseInt(flag("--dim", "32"), 10);
const modelName = flag("--model", `stub-embedder-${dim}d`);
const failRate = Number.parseFloat(flag("--fail-rate", "0"));
const slowMs = Number.parseInt(flag("--slow-ms", "0"), 10);
let batchCounter = 0;

async function maybeSlow() {
  if (slowMs > 0) await new Promise((r) => setTimeout(r, slowMs));
}

function shouldFail() {
  if (failRate <= 0) return false;
  batchCounter++;
  // Deterministic per-batch: use the counter, not Math.random.
  const digest = createHash("sha256").update(`batch-${batchCounter}`).digest();
  const roll = digest[0] / 255;
  return roll < failRate;
}

function embed(chunks) {
  const vectors = chunks.map((text) => {
    const digest = createHash("sha256").update(text, "utf8").digest();
    const raw = new Float32Array(dim);
    for (let i = 0; i < dim; i++) {
      // Extend the 32-byte digest by hashing again with the lane index.
      const source =
        i < 32
          ? digest[i]
          : createHash("sha256").update(digest).update(String(i)).digest()[i % 32];
      raw[i] = (source - 127.5) / 127.5;
    }
    // L2-normalize to unit length.
    let sum = 0;
    for (let i = 0; i < dim; i++) sum += raw[i] * raw[i];
    const norm = Math.sqrt(sum) || 1;
    const out = new Array(dim);
    for (let i = 0; i < dim; i++) out[i] = raw[i] / norm;
    return out;
  });
  return { vectors, model: modelName, dim };
}

async function handleBatch(chunks) {
  await maybeSlow();
  if (shouldFail()) {
    throw new Error("stub-embedder: injected failure");
  }
  return embed(chunks);
}

if (has("--http")) {
  const port = Number.parseInt(flag("--http", "8399"), 10);
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end("method not allowed");
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", async () => {
      try {
        const { chunks } = JSON.parse(body);
        const out = await handleBatch(chunks);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(out));
      } catch (err) {
        res.statusCode = 500;
        res.end(String(err));
      }
    });
  });
  server.listen(port, "127.0.0.1", () => {
    console.error(`stub-embedder http on 127.0.0.1:${port} model=${modelName} dim=${dim}`);
  });
} else if (has("--stdio")) {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (line.trim().length === 0) return;
    try {
      const { chunks } = JSON.parse(line);
      const out = await handleBatch(chunks);
      process.stdout.write(`${JSON.stringify(out)}\n`);
    } catch (err) {
      // Framing convention: a batch that fails still emits one line so
      // the peer never hangs waiting.
      process.stdout.write(`${JSON.stringify({ error: String(err) })}\n`);
    }
  });
  console.error(`stub-embedder stdio model=${modelName} dim=${dim}`);
} else {
  console.error("usage: stub-embedder.mjs (--http PORT | --stdio) [--dim N] [--model NAME] [--fail-rate F] [--slow-ms MS]");
  process.exit(2);
}
