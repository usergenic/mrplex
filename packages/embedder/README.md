# @mrplex/embedder

A ready-to-use local embedding provider for [mrplex](https://github.com/usergenic/mrplex)'s
`--embedder` hook. It runs `bge-small-en-v1.5` (384-dim) on CPU via ONNX — no GPU, no
separate service. mrplex spawns it once and keeps it resident, so the model loads a single
time and each batch is one JSON line in / one JSON line out.

## Why a separate package

This lives in its own package with its own `package.json` and lockfile so that
its dependency — `fastembed`, and `fastembed`'s transitive `tar` — never enters
mrplex's core dependency graph. A plain `npm install` (or `npm ci`) at the
mrplex root stays clean; you only pull these deps if you opt in to local
embeddings.

## Install

```bash
npm install -g @mrplex/embedder
```

The model (~130 MB) auto-downloads and caches on first run (typically under
`~/.cache/huggingface` or fastembed's cache directory).

**From the mrplex monorepo** (development):

```bash
cd packages/embedder && npm install
```

## Use with mrplex

After a global install:

```bash
# Serve with the hook — every write auto-embeds.
mrplex serve --unsafe --embedder mrplex-embedder

# One-off backfill of an existing repo.
mrplex embed backfill -r notes --embedder mrplex-embedder

# Or make it ambient for every mrplex command:
export MRPLEX_EMBEDDER=mrplex-embedder
# mrplex config set-embedder mrplex-embedder   # same thing, persisted
```

**Monorepo / local checkout** (no global install):

```bash
mrplex serve --unsafe --embedder "node packages/embedder/embedder.mjs"
```

### Different models

```bash
# Stronger, slower (768-dim).
export MRPLEX_EMBEDDER="mrplex-embedder --model fast-bge-base-en-v1.5"

# Matryoshka truncation (re-embed after changing --dim).
export MRPLEX_EMBEDDER="mrplex-embedder --dim 256"
```

List supported model keys:

```bash
mrplex-embedder --list-models
```

## Flags

- `--model KEY` — any `fastembed` model key. Default `fast-bge-small-en-v1.5`.
  Others include `fast-all-MiniLM-L6-v2`, `fast-bge-base-en-v1.5`,
  `fast-multilingual-e5-large`. Run `--list-models` for the full set.
- `--dim N` — truncate + re-normalize each vector to `N` dims (for Matryoshka
  models). The truncation is encoded into the reported model string
  (`<key>@<N>`) so mrplex treats a dim change as a model change and re-embeds.
- `--stdio` — optional no-op; stdio is the default transport (one JSON line
  per batch over stdin/stdout).
- `--list-models` — print supported `--model` keys and exit.
- `--help`, `--version` — usage and version.

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
input. `npm audit` will flag this; `npm audit fix --force` would downgrade
`fastembed` (breaking). Revisit if a `fastembed` release adopts a patched
`tar`.
