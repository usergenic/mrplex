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
 *   mrplex serve --unsafe --embed-cmd "node packages/embedder/embedder.mjs --stdio"
 *   mrplex embed backfill -r notes --embed-cmd "node packages/embedder/embedder.mjs --stdio"
 *
 * Model: bge-small-en-v1.5 (384-dim) by default — strong retrieval quality for
 * its size, and small vectors keep mrplex's brute-force cosine scan fast. Runs
 * on CPU via ONNX; no GPU or separate service required.
 *
 * Flags:
 *   --stdio            required transport (parity with stub-embedder.mjs)
 *   --model KEY        fastembed model key (default fast-bge-small-en-v1.5)
 *   --dim N            truncate + re-normalize to N dims (Matryoshka models only)
 *
 * This lives in its own package (packages/embedder) with its own dependencies
 * so `fastembed` — and its transitive `tar` — never enter mrplex's core graph.
 * Install once: `cd packages/embedder && npm install`.
 */

import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const has = (name) => argv.includes(name);

const modelKey = flag("--model", "fast-bge-small-en-v1.5");
const truncateDim = argv.includes("--dim") ? Number.parseInt(flag("--dim", ""), 10) : null;

if (!has("--stdio")) {
  console.error("usage: embedder.mjs --stdio [--model KEY] [--dim N]");
  process.exit(2);
}
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

async function handleBatch(chunks) {
  let vectors = await embedAll(chunks);
  if (truncateDim !== null) {
    vectors = vectors.map((v) => truncate(v, truncateDim));
  }
  const dim = vectors[0]?.length ?? truncateDim ?? 0;
  // Encode the truncation in the model string so a dim change is treated as a
  // model change by the worker (src/embed/worker.ts) and triggers re-embed.
  const modelName = truncateDim !== null ? `${modelKey}@${truncateDim}` : modelKey;
  return { vectors, model: modelName, dim };
}

// Warm up so the first real batch isn't disproportionately slow.
await handleBatch(["warmup"]);

async function respond(line) {
  try {
    const { chunks } = JSON.parse(line);
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
