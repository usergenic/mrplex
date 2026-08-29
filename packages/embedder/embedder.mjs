#!/usr/bin/env node
/**
 * Local embedding provider for mrplex's `--embed-cmd` hook.
 *
 * Speaks the subprocess contract (design §5.3): one JSON line in on stdin
 * `{ chunks: string[] }`, one JSON line out on stdout
 * `{ vectors: number[][], model: string, dim: number }`. mrplex spawns this
 * ONCE and reuses it for every batch (src/embed/cmd-hook.ts), so the model
 * loads a single time and stays resident — no per-call cold start.
 *
 *   mrplex serve --unsafe --embed-cmd "mrplex-embedder --stdio"
 *   mrplex embed backfill -r notes --embed-cmd "mrplex-embedder --stdio"
 *
 * Model: bge-small-en-v1.5 (384-dim) by default — strong retrieval quality for
 * its size, and small vectors keep mrplex's brute-force cosine scan fast. Runs
 * on CPU via ONNX; no GPU or separate service required.
 */

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "package.json"), "utf8"),
);
const VERSION = pkg.version;

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const has = (name) => argv.includes(name);

function printHelp() {
  console.error(`mrplex-embedder ${VERSION}
Local CPU embedding provider for mrplex's --embed-cmd hook.

Usage:
  mrplex-embedder --stdio [--model KEY] [--dim N]

Options:
  --stdio          required transport (one JSON line per batch over stdin/stdout)
  --model KEY      fastembed model key (default: fast-bge-small-en-v1.5)
  --dim N          truncate + re-normalize to N dims (Matryoshka models only)
  --list-models    print supported --model keys and exit
  --help, -h       show this help
  --version, -V    print version

Install:  npm install -g @mrplex/embedder
Docs:     https://github.com/usergenic/mrplex/tree/main/packages/embedder`);
}

if (has("--help") || has("-h")) {
  printHelp();
  process.exit(0);
}
if (has("--version") || has("-V")) {
  console.log(VERSION);
  process.exit(0);
}

const modelKey = flag("--model", "fast-bge-small-en-v1.5");
const truncateDim = argv.includes("--dim") ? Number.parseInt(flag("--dim", ""), 10) : null;

if (truncateDim !== null && (!Number.isInteger(truncateDim) || truncateDim <= 0)) {
  console.error(`embedder: --dim must be a positive integer (got ${flag("--dim", "")})`);
  process.exit(2);
}

// Import lazily so a missing dependency yields a clear message, not a stack
// trace before the usage check above has run.
let FlagEmbedding;
let EmbeddingModel;
try {
  ({ FlagEmbedding, EmbeddingModel } = await import("fastembed"));
} catch {
  console.error(
    "embedder: missing dependency 'fastembed'.\n  install it with:  npm install fastembed",
  );
  process.exit(3);
}

if (has("--list-models")) {
  for (const key of Object.values(EmbeddingModel)) {
    console.log(key);
  }
  process.exit(0);
}

if (!has("--stdio")) {
  printHelp();
  process.exit(2);
}

// fastembed keys its models by an enum whose values are the string keys above.
const model = Object.values(EmbeddingModel).find((v) => v === modelKey);
if (!model) {
  console.error(
    `embedder: unknown --model '${modelKey}'. known: ${Object.values(EmbeddingModel).join(", ")}`,
  );
  process.exit(2);
}

// maxLength covers the chunker's 2000-char cap (~512 tokens); bge tops out at 512.
const embedder = await FlagEmbedding.init({ model, maxLength: 512 });

/** Truncate a unit vector to `n` dims and re-normalize (Matryoshka). */
function truncate(vec, n) {
  const head = vec.slice(0, n);
  let sum = 0;
  for (const x of head) sum += x * x;
  const norm = Math.sqrt(sum) || 1;
  return head.map((x) => x / norm);
}

async function embedAll(chunks) {
  // `embed` yields batches; collect them back into one aligned array.
  const vectors = [];
  for await (const batch of embedder.embed(chunks, chunks.length)) {
    for (const v of batch) vectors.push(Array.from(v));
  }
  return vectors;
}

function reportedModelName() {
  return truncateDim !== null ? `${modelKey}@${truncateDim}` : modelKey;
}

async function handleBatch(chunks) {
  const modelName = reportedModelName();
  if (chunks.length === 0) {
    return { vectors: [], model: modelName, dim: nativeDim };
  }
  let vectors = await embedAll(chunks);
  if (truncateDim !== null) {
    vectors = vectors.map((v) => truncate(v, truncateDim));
  }
  const dim = vectors[0]?.length ?? truncateDim ?? nativeDim;
  return { vectors, model: modelName, dim };
}

function parseChunks(line) {
  let body;
  try {
    body = JSON.parse(line);
  } catch {
    throw new Error("invalid JSON");
  }
  if (typeof body !== "object" || body === null || !Array.isArray(body.chunks)) {
    throw new Error('request must be { "chunks": string[] }');
  }
  for (let i = 0; i < body.chunks.length; i++) {
    if (typeof body.chunks[i] !== "string") {
      throw new Error(`chunks[${i}] must be a string`);
    }
  }
  return body.chunks;
}

// Warm up so the first real batch isn't disproportionately slow.
const warmup = await handleBatch(["warmup"]);
const nativeDim = truncateDim ?? warmup.dim;

async function respond(line) {
  try {
    const chunks = parseChunks(line);
    const result = await handleBatch(chunks);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (err) {
    // Framing convention (stub-embedder.mjs): a failed batch still emits one
    // line so the peer never hangs waiting for a response.
    process.stdout.write(`${JSON.stringify({ error: String(err) })}\n`);
  }
}

// Serialize batches so output lines stay in input order even if several lines
// arrive buffered together — the async handler would otherwise race. (mrplex's
// cmd-hook is one-in-flight, but this keeps the script correct on its own.)
const rl = createInterface({ input: process.stdin });
let queue = Promise.resolve();
rl.on("line", (line) => {
  if (line.trim().length === 0) return;
  queue = queue.then(() => respond(line));
});

console.error(
  `embedder stdio model=${modelKey}${truncateDim !== null ? ` dim=${truncateDim}` : ""}`,
);
