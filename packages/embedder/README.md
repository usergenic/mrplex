# @mrplex/embedder

A ready-to-use local embedding provider for mrplex's `--embed-cmd` hook. It runs
`bge-small-en-v1.5` (384-dim) on CPU via ONNX — no GPU, no separate service.
mrplex spawns it once and keeps it resident, so the model loads a single time
and each batch is one JSON line in / one JSON line out.

## Why a separate package

This lives in its own package with its own `package.json` and lockfile so that
its dependency — `fastembed`, and `fastembed`'s transitive `tar` — never enters
mrplex's core dependency graph. A plain `npm install` (or `npm ci`) at the
mrplex root stays clean; you only pull these deps if you opt in to local
embeddings by installing here.

## Install

```bash
cd packages/embedder
npm install
```

The model (~130 MB) auto-downloads and caches on first run.

## Use with mrplex

Point either embedding entrypoint at the script (from the mrplex repo root):

```bash
# Serve with the hook — every write auto-embeds.
mrplex serve --unsafe \
  --embed-cmd "node packages/embedder/embedder.mjs --stdio"

# One-off backfill of an existing repo.
mrplex embed backfill -r notes \
  --embed-cmd "node packages/embedder/embedder.mjs --stdio"

# Or make it ambient.
export MRPLEX_EMBED_CMD="node packages/embedder/embedder.mjs --stdio"
```

## Flags

- `--stdio` — required transport (one JSON line per batch over stdin/stdout).
- `--model KEY` — any `fastembed` model key. Default `fast-bge-small-en-v1.5`.
  Others include `fast-all-MiniLM-L6-v2`, `fast-bge-base-en-v1.5`,
  `fast-multilingual-e5-large`.
- `--dim N` — truncate + re-normalize each vector to `N` dims (for Matryoshka
  models). The truncation is encoded into the reported model string
  (`<key>@<N>`) so mrplex treats a dim change as a model change and re-embeds.

## Protocol

Reads `{ "chunks": ["…", …] }` lines, writes
`{ "vectors": [[…], …], "model": "…", "dim": N }` lines. Vectors are
mean-pooled and L2-normalized (unit length) so mrplex's brute-force cosine
ranking is stable. A malformed input line still gets one `{ "error": "…" }`
line back so the caller never hangs.

## Security note

`fastembed` depends on `tar` (used to extract the model archive it downloads
from HuggingFace on first run). The pinned `tar` carries published advisories
(`GHSA-*`, path-traversal / DoS classes). The exposure here is low: this is
opt-in developer tooling — not part of mrplex's shipped runtime — and `tar`
only ever processes archives fetched from HuggingFace, not attacker-supplied
input. `npm audit fix --force` would downgrade `fastembed` (breaking); revisit
if a `fastembed` release adopts a patched `tar`.
