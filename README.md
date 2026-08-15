# mrplex

*Markdown Repos, plexed.* A queryable, versioned store for Markdown documents with YAML frontmatter.

See [docs/design.md](docs/design.md) for the full design.

## Features

- **Versioned Markdown store.** Every write inserts a new version; nothing is overwritten; any past state is addressable. `docs.put` handles both in-place update and move (path may differ from the previous version).
- **Byte-exact frontmatter.** Writes supply `frontmatter_raw` (verbatim YAML) OR `frontmatter` (structured JSON) — exactly one; the other is derived. Round-trips are byte-exact via the raw form.
- **Optimistic concurrency.** Every write supplies the `prev_version_id` it observed; a stale prev is rejected with `stale_prev` and the current version returned.
- **Deletion is a move to a system-namespace path** (`:deleted/…/foo-v45129.md`, extension-aware). Restore is a `docs.put` back to a user-territory path. `docs.delete` is idempotent.
- **Unified diff** between any two versions of the same document via `docs.diff` — kernel op, `/repos/{repo}/diff/{path}?from=&to=` REST route (JSON envelope or `Accept: text/plain` raw patch), `docs_diff` MCP tool, `mrplex docs diff` CLI. `patch(1)`-applicable output.
- **CEL filter queries** over frontmatter fields and `$`-prefixed intrinsics (`$path`, `$created_at`, `$body`). `list()` polymorphism handles scalar-or-list frontmatter uniformly.
- **Full-text search** over document body — SQLite FTS5 (porter+unicode61) or Postgres `websearch_to_tsquery`. Composes with filter via AND. Portable syntax subset across both engines: bare terms and quoted phrases.
- **Semantic rank via embeddings** — pluggable hook (`--embed-url` HTTP or `--embed-cmd` subprocess); mrplex never calls a provider itself. Chunker + backlog worker + brute-force cosine k-NN over `sqlite-vec`; results current-version only, deduped by content hash. Composes with filter/text/scope/sigil-exclusion. No hook configured → `rank_unavailable` (no zero-vector default — silent garbage is worse than a visible gap).
- **Bearer-token auth** with capability scopes — repo-scoped `read` / `write` path globs (gitignore-style, with negation), admin bit, per-token subset semantics for self-issued tokens.
- **HTTP surfaces.** Protocol-true MCP server at `/mcp` (Streamable HTTP + optional STDIO), and a resource-oriented REST surface with `If-Match` / `If-None-Match`, content negotiation (`application/json` or `text/markdown`), `MOVE`, and sibling `/versions` / `/history` / `/diff` roots. Query responses carry ETags for `If-None-Match` → 304.
- **`mrplex` CLI** — thin client over MCP. `--database` for local embedded mode; `--server` for remote mode against a running server. Every command works identically over both transports.
- **Two v1 storage adapters — SQLite and Postgres+pgvector.** `--database sqlite:./mrplex.db` (bare path defaults to sqlite) or `--database postgres://user:pw@host:5432/db`. Both pass the same kernel test suite.
- **Configurable path policy** — hardcoded defaults → server config → per-repo override. `disallowed_chars`, `system_sigils`, `hidden_sigils`, all with sensible defaults (Obsidian's cross-platform-safe rule).
- **Bootstrap** — `mrplex bootstrap` mints the root admin token on a fresh database.

## Quickstart

```bash
npm install
```

Bootstrap a fresh database — this mints the root admin token exactly once:

```bash
export TOK=$(npm run --silent cli -- --database ./mrplex.db bootstrap)
export MRPLEX_TOKEN="$TOK"
```

Create a user + repo, then walk a doc through its lifecycle:

```bash
# Admin ops.
npm run --silent cli -- --database ./mrplex.db users create alice
npm run --silent cli -- --database ./mrplex.db repos create notes

# create → update → move → delete → restore
V=$(printf '%s\n' '---' 'title: Hello' '---' '' 'body v1' | \
    npm run --silent cli -- --database ./mrplex.db --json docs create notes hello.md --from-file - \
    | jq -r .version_id)

V=$(npm run --silent cli -- --database ./mrplex.db --json docs put notes hello.md --prev "$V" \
    --from-file - <<'EOF' | jq -r .version_id
---
title: Hello
---
body v2
EOF
)

V=$(npm run --silent cli -- --database ./mrplex.db --json docs mv notes hello.md greetings/hi.md --prev "$V" | jq -r .version_id)
V=$(npm run --silent cli -- --database ./mrplex.db --json docs delete notes greetings/hi.md --prev "$V" | jq -r .version_id)
V=$(npm run --silent cli -- --database ./mrplex.db --json docs put notes greetings/hi.md --prev "$V" | jq -r .version_id)

# History now has 5 versions in reverse chain order:
npm run --silent cli -- --database ./mrplex.db docs history notes greetings/hi.md
```

Mint a scoped token for an agent:

```bash
npm run --silent cli -- --database ./mrplex.db tokens create \
    --label "obsidian-plugin" \
    --scope "notes:read=**,write=inbox/**"
```

Query — CEL filters + FTS + rank composed:

```bash
# Filter only
npm run --silent cli -- --database ./mrplex.db query --repo notes \
    --filter 'status == "published"'

# Text only (FTS5, porter-stemmed)
npm run --silent cli -- --database ./mrplex.db query --repo notes --text 'welcome OR intro'

# Filter + text composed
npm run --silent cli -- --database ./mrplex.db query --repo notes \
    --filter '"pricing" in list(tags)' --text pricing

# Polymorphic frontmatter — matches tags: pricing AND tags: [pricing, saas]
npm run --silent cli -- --database ./mrplex.db query --repo notes \
    --filter '"pricing" in list(tags)'

# $-prefixed intrinsics
npm run --silent cli -- --database ./mrplex.db query --repo notes \
    --filter '$path.startsWith("guides/")'

# Semantic rank (requires an embedding hook — see below)
npm run --silent cli -- --database ./mrplex.db query --repo notes \
    --rank 'tiered SaaS pricing'

# All three composed
npm run --silent cli -- --database ./mrplex.db query --repo notes \
    --filter 'status == "published"' --text pricing --rank 'subscription fees'
```

Diff any two versions of a document — history + diff give you the versioned reader:

```bash
npm run --silent cli -- --database ./mrplex.db docs history notes greetings/hi.md
npm run --silent cli -- --database ./mrplex.db docs diff notes greetings/hi.md \
    --from v1 --to v3
```

Serve the HTTP surfaces and drive the CLI remotely:

```bash
# Start the server (REST + MCP Streamable HTTP on :8321 by default)
npm run --silent cli -- --database ./mrplex.db serve --port 8321 &

# Same commands, now over the network
npm run --silent cli -- --server http://127.0.0.1:8321 docs get notes greetings/hi.md
npm run --silent cli -- --server http://127.0.0.1:8321 query --repo notes --filter 'status == "published"'
npm run --silent cli -- --server http://127.0.0.1:8321 docs diff notes greetings/hi.md --from v1 --to v3
```

## Embeddings

mrplex ships **no** embedding provider — you wire one up. Two hook shapes:

```bash
# HTTP endpoint — server POSTs { chunks: [...] } and expects
# { vectors: [[...]], model: "…", dim: N }.
mrplex serve --database ./mrplex.db --embed-url http://127.0.0.1:8399

# Subprocess — one JSON line in / one JSON line out over stdin/stdout.
mrplex serve --database ./mrplex.db --embed-cmd "path/to/embedder --stdio"
```

Either flag can also come from `MRPLEX_EMBED_URL` / `MRPLEX_EMBED_CMD` env or CLI config. `--embed-url` and `--embed-cmd` are mutually exclusive.

Backlog + backfill for retrofitting an existing corpus:

```bash
# Re-chunk + re-embed a repo's current versions that are missing chunks.
mrplex embed backfill --database ./mrplex.db --repo notes --embed-url http://127.0.0.1:8399

# Inspect the queue — counts, models present, recent errors.
mrplex embed status --database ./mrplex.db
```

For dev + tests, `scripts/stub-embedder.mjs` speaks both hook shapes with deterministic hash-projection vectors (and `--fail-rate`, `--slow-ms` for exercising backoff):

```bash
node scripts/stub-embedder.mjs --http 8399
```

Writes done while a hook is configured trigger the in-process worker automatically; a hookless server still enqueues each write so a later `embed backfill` doesn't have to walk history. Rank queries with no hook return `rank_unavailable` — there is no zero-vector fallback (design §5.3).

## Development

```bash
npm test          # invariants, kernel suite, writes, admin, auth, query, rank, diff, chunker, worker, HTTP surfaces, CLI
npm run typecheck # tsc --noEmit, strict
npm run lint      # biome check
npm run build     # emit dist/
```

CI runs typecheck + lint + tests on Ubuntu & macOS × Node 20 & 22, plus a `ci-postgres` job that spins up a `pgvector/pgvector:pg17` service and runs the shared kernel suite against a live Postgres. `sqlite-vec` is loaded via better-sqlite3's `loadExtension` on every cell; if a platform gap ever appears, the fallback is computing cosine distance in a JS UDF — invisible above the adapter.

### Postgres locally

```bash
# Start a throwaway Postgres+pgvector.
docker compose -f docker-compose.test.yml up -d

# Bootstrap + serve against it.
mrplex bootstrap --database postgres://mrplex:mrplex@localhost:5432/mrplex
mrplex serve --database postgres://mrplex:mrplex@localhost:5432/mrplex

# Run the parity suite against the live PG (adds ~16 kernel tests).
MRPLEX_TEST_POSTGRES_URL=postgres://mrplex:mrplex@localhost:5432/mrplex npm test
```

The adapter passes any `postgres://…` URL through unchanged, so `sslmode`, `application_name`, and other libpq options work as expected. The `vector` extension is required in the target database (create it once as `create extension if not exists vector;`).

## License

TBD.
