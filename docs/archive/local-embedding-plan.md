# Local Embedding Plan — resident Node subprocess via `--embed-cmd`

Status: **implemented**. Goal: enable semantic `rank` on live mrplex repos with
the least operational surface. Decision: ship a self-contained Node script wired
through the existing `--embed-cmd` subprocess hook, running `bge-small-en-v1.5`
(384-dim) on CPU. No separate service, no GPU, no Python. The script lives in its
own package (`packages/embedder`) so its `fastembed` dependency stays out of
mrplex's core dependency graph (§3).

## 0. Why this shape

The embedding infrastructure already exists (`src/embed/`). What's missing is a
*provider* — a script that turns chunk text into vectors. Two facts make the
resident-subprocess approach the clear winner over an HTTP service:

1. **`--embed-cmd` spawns one long-lived process, not one per call.**
   `createCmdEmbedHook` (`src/embed/cmd-hook.ts:35`, `ensureProc()`) spawns the
   command once and reuses it for every batch — one JSON line in on stdin, one
   JSON line out on stdout. The model loads **once** at startup and stays
   resident. The "expensive cold-start per embedding call" fear does not apply.

2. **The subprocess speaks mrplex's contract directly.** The stdio path expects
   exactly `{chunks:[...]}` → `{vectors,model,dim}` (`scripts/stub-embedder.mjs`
   is the reference). An Ollama HTTP endpoint returns a *different* shape
   (`{embeddings:[...]}`), so it would still require a translating adapter —
   plus a separate always-on daemon mrplex doesn't own. The Node script trades
   nothing away and removes a moving part.

### Simplicity comparison (recorded for posterity)

| | Node `--embed-cmd` script | Ollama HTTP adapter |
|---|---|---|
| Moving parts | 1 (mrplex spawns & owns it) | 2–3 (daemon + adapter + pulls) |
| Protocol match | direct — no translation | needs adapter (`{embeddings}`→`{vectors,dim}`) |
| Lifecycle | tied to `mrplex serve` | separate daemon to keep running |
| Accel | CPU (fine at personal scale) | Metal GPU |
| Best when | single personal repo | large corpus / shared across machines |

At worknotes scale (hundreds–low-thousands of chunks) the GPU speedup is
irrelevant and model-swapping convenience isn't worth the extra daemon.

## 1. Model choice — `bge-small-en-v1.5`

- **384 dimensions.** Storage is dimensionless (postgres `vector` with no fixed
  dim, sqlite `blob` — `storage-*/migrations/0001_init.sql`) and rank is
  brute-force cosine k-NN (README §Semantic rank). Smaller vectors scan faster,
  so 384-dim is both cheaper and strong on retrieval quality-per-byte.
- **~130 MB**, downloads once and caches (`~/.cache/huggingface` or the
  fastembed cache) on first run.
- Comfortably covers the chunker's 2000-char (~500-token) cap
  (`src/embed/chunker.ts:23`) — no truncation concerns.
- Alternatives if quality/size ever needs tuning: `all-MiniLM-L6-v2` (384d,
  smaller/weaker) or `nomic-embed-text-v1.5` (768d, higher ceiling, slower
  scans). Swapping models is one backfill (see §5).

## 2. The embedder script

`packages/embedder/embedder.mjs`, mirroring `scripts/stub-embedder.mjs`'s stdio
framing so it drops into the exact same hook path. Shape (see the file for the
implemented version):

```js
#!/usr/bin/env node
// mrplex embed hook: reads {chunks:[...]} lines, writes {vectors,model,dim}.
import { createInterface } from "node:readline";
import { FlagEmbedding, EmbeddingModel } from "fastembed";

const embedder = await FlagEmbedding.init({
  model: EmbeddingModel.BGESmallENV15, // "fast-bge-small-en-v1.5"
  maxLength: 512,
});

// embed() is an async generator yielding batches; collect + serialize per line.
async function handleBatch(chunks) {
  const vectors = [];
  for await (const batch of embedder.embed(chunks, chunks.length)) {
    for (const v of batch) vectors.push(Array.from(v)); // already L2-normalized
  }
  return { vectors, model: "fast-bge-small-en-v1.5", dim: vectors[0]?.length ?? 384 };
}
```

The implemented script adds: a warmup embed at startup, `--model`/`--dim`
flags, a lazy import with a friendly "npm install fastembed" message, input
validation exits, and a promise-chain that serializes batches so output lines
stay in input order.

Contract obligations enforced by `validateEmbedResponse`
(`src/embed/hook.ts:41`) — the script must honor all of them or the whole batch
is rejected:

- [ ] `vectors.length === chunks.length` (batch alignment).
- [ ] every `vectors[i].length === dim` (uniform, positive-integer dim).
- [ ] every element a finite number (no NaN/Inf — mean-pool + normalize is safe).
- [ ] non-empty `model` string.
- [ ] emit exactly one line per input line, even on error.

## 3. Dependency & library decision

- [x] **ONNX runtime library: `fastembed`.** Two candidates were evaluated:
  - `@huggingface/transformers` (transformers.js v3) — **rejected.** It pulls
    `sharp` (a native image library) as a transitive dependency, which fails to
    `node-gyp` build from source on a clean install ("Please add node-addon-api")
    — an unacceptable first-run hurdle for end-users.
  - `fastembed` (v2.1.0) — **chosen.** Embedding-specific, npm-only, no native
    image deps. bge/MiniLM/e5 models are first-class enum keys. API is
    `FlagEmbedding.init({model})` then an `embed(texts, batchSize)` async
    generator (not `pipeline()`); output vectors are already mean-pooled +
    L2-normalized.
- [x] **Isolated in its own package (`packages/embedder`), not a mrplex
  dependency.** `fastembed` transitively depends on `tar@6.2.1`, which carries
  critical/high advisories (`tar <=7.5.20`; no patched 6.x exists). Rather than
  drag that into mrplex's graph — even as a devDependency, where it would still
  affect `npm ci` and audit at the root — the script and its `fastembed`
  dependency live in a standalone package with its own `package.json` +
  lockfile. It is **not** a workspace member, so a root `npm install` never
  pulls it. Users opt in: `cd packages/embedder && npm install`.
  - Exposure is low and contained: dev-only tooling, and `tar` only extracts
    model archives fetched from HuggingFace (trusted), never attacker input.
  - `npm audit fix --force` would downgrade `fastembed` (breaking). Revisit if a
    `fastembed` release adopts a patched `tar`, or pin `tar` via `overrides` in
    the package if the advisory scope changes.

## 4. Wiring it up

```bash
# First, install the embedder package's own deps (once).
cd packages/embedder && npm install && cd ../..

# One-off backfill of an existing repo (chunks + embeds current versions).
mrplex embed backfill --repo worknotes \
  --embed-cmd "node packages/embedder/embedder.mjs --stdio"

# Steady state: serve with the hook so every write auto-embeds.
mrplex serve --unsafe \
  --embed-cmd "node packages/embedder/embedder.mjs --stdio" &

# Or make it ambient so every command picks it up:
export MRPLEX_EMBED_CMD="node packages/embedder/embedder.mjs --stdio"
```

- [x] Confirm the `--stdio` flag convention (the stub uses `--http|--stdio`;
      the real script only needs stdio, but accepting the flag keeps parity).
- [ ] `mrplex embed status` to watch the backlog drain and confirm the model
      string appears.
- [ ] Smoke test: `mrplex query -r worknotes --rank "…natural language…"`.

## 5. Model changes later

Per `src/embed/worker.ts` (model-change handling) and `backfill.ts` header: a
model swap is (a) point `--embed-cmd` at the new model, (b) delete the repo's
chunks, (c) re-run `embed backfill`. The worker already detects a changed
`model` string in a response and re-embeds rather than mixing vector spaces
(`worker.ts:146`). So model choice here is low-commitment.

## 6. Open loops

- [x] Warmup embed at startup so the first real batch isn't slow — implemented.
- [x] `--model` flag for painless experimentation — implemented (plus `--dim`).
- [ ] Validate real embedding latency for a full worknotes backfill; confirm
      CPU is acceptable before considering Ollama/GPU. (Unit-latency verified:
      a 2-chunk batch returns correct 384-dim unit vectors; end-to-end backfill
      against a live repo not yet timed.)
- [ ] Run `mrplex embed backfill -r worknotes` end-to-end and confirm a
      `--rank` query returns sensible hits (needs a server + repo, not done in
      the isolated script test).
