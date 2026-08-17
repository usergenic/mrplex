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

Install and link the `mrplex` command:

```bash
npm install
npm link          # puts `mrplex` on your PATH; alternatively, `npm install -g` after publish
```

Point every command at the same database, token, and target repo by exporting once:

```bash
export MRPLEX_DATABASE=./mrplex.db
export MRPLEX_TOKEN=$(mrplex bootstrap)   # mints the root admin token exactly once
export MRPLEX_REPO=notes                  # default repo for `docs *` commands
```

`docs *` commands read the target repo from `MRPLEX_REPO`; override any call
with `-r / --repo <slug>`.

**Prefer a config file to environment variables?** `mrplex config set-*` writes
`$XDG_CONFIG_HOME/mrplex/config.json` (defaults to `~/.config/mrplex/config.json`;
token stored chmod 600):

```bash
mrplex config set-database ./mrplex.db
mrplex config set-token "$(mrplex bootstrap)"
mrplex config set-repo notes
mrplex config set-server http://127.0.0.1:8321   # optional — for remote mode
mrplex config show                               # summary; token shown as (set) / (unset), never plaintext
```

Each setting is resolved **flag → env → config file → hardcoded default**, so a
one-off `-r other-repo` or `--server https://…` overrides the persisted value
without editing anything.

Create the repo and walk a doc through its lifecycle:

```bash
mrplex repos create notes

# create → update → move → delete → restore
V=$(printf '%s\n' '---' 'title: Hello' '---' '' 'body v1' \
    | mrplex --json docs create hello.md --from-file - | jq -r .version_id)

V=$(mrplex --json docs put hello.md --prev "$V" --from-file - <<'EOF' | jq -r .version_id
---
title: Hello
---
body v2
EOF
)

V=$(mrplex --json docs mv greetings/hi.md --prev "$V" | jq -r .version_id)
V=$(mrplex --json docs delete --prev "$V" | jq -r .version_id)
V=$(mrplex --json docs put greetings/hi.md --prev "$V" | jq -r .version_id)

# History now has 5 versions in reverse chain order:
mrplex docs history greetings/hi.md
```

Mint a narrower token for an agent (subset of your own scope):

```bash
mrplex tokens create --label "obsidian-plugin" --scope "notes:read=**,write=inbox/**"
```

Multi-user: the admin creates each user and mints their first token; hand it to
them out-of-band. From then on the user manages their own tokens (list,
revoke, mint sub-tokens no wider than what they hold).

```bash
mrplex users create alice
ALICE_TOKEN=$(mrplex --json tokens create \
    --for-user alice \
    --label "alice-primary" \
    --scope "notes:read=**,write=inbox/**" \
  | jq -r .token)

# Alice now uses her own token — no admin bit, scope only on notes/inbox.
MRPLEX_TOKEN=$ALICE_TOKEN mrplex docs create inbox/hi.md --from-file - <<< $'---\n---\nhi\n'
MRPLEX_TOKEN=$ALICE_TOKEN mrplex tokens create \
    --label "alice-obsidian" --scope "notes:read=**,write=inbox/**"
```

Query — CEL filters + FTS + rank composed:

```bash
# Filter only
mrplex query --repo notes --filter 'status == "published"'

# Text only (FTS5, porter-stemmed)
mrplex query --repo notes --text 'welcome OR intro'

# Filter + text composed
mrplex query --repo notes --filter '"pricing" in list(tags)' --text pricing

# Polymorphic frontmatter — matches tags: pricing AND tags: [pricing, saas]
mrplex query --repo notes --filter '"pricing" in list(tags)'

# $-prefixed intrinsics
mrplex query --repo notes --filter '$path.startsWith("guides/")'

# Semantic rank (requires an embedding hook — see below)
mrplex query --repo notes --rank 'tiered SaaS pricing'

# All three composed
mrplex query --repo notes \
    --filter 'status == "published"' --text pricing --rank 'subscription fees'
```

Diff any two versions of a document — history + diff give you the versioned reader:

```bash
mrplex docs history greetings/hi.md
mrplex docs diff greetings/hi.md --from v1 --to v3
```

Serve the HTTP surfaces and drive the CLI remotely:

```bash
# Start the server (REST + MCP Streamable HTTP on :8321 by default)
mrplex serve --port 8321 &

# Same commands, now over the network — --server takes precedence over --database
mrplex --server http://127.0.0.1:8321 docs get greetings/hi.md
mrplex --server http://127.0.0.1:8321 query -r notes --filter 'status == "published"'
mrplex --server http://127.0.0.1:8321 docs diff greetings/hi.md --from v1 --to v3
```

> Prefer not to `npm link`? Use `npx mrplex …` from the repo, or add
> `./node_modules/.bin` to your `PATH`. Every `mrplex …` command in
> this README is equivalent to `npx mrplex …` or
> `npm run --silent cli -- …`.

## Embeddings

mrplex ships **no** embedding provider — you wire one up. Two hook shapes:

```bash
# HTTP endpoint — server POSTs { chunks: [...] } and expects
# { vectors: [[...]], model: "…", dim: N }.
mrplex serve --embed-url http://127.0.0.1:8399

# Subprocess — one JSON line in / one JSON line out over stdin/stdout.
mrplex serve --embed-cmd "path/to/embedder --stdio"
```

Either flag can also come from `MRPLEX_EMBED_URL` / `MRPLEX_EMBED_CMD` env or CLI config. `--embed-url` and `--embed-cmd` are mutually exclusive.

Backlog + backfill for retrofitting an existing corpus:

```bash
# Re-chunk + re-embed a repo's current versions that are missing chunks.
mrplex embed backfill --repo notes --embed-url http://127.0.0.1:8399

# Inspect the queue — counts, models present, recent errors.
mrplex embed status
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
# Start a persistent Postgres+pgvector (data survives `pg:down`).
npm run pg:up

# Point mrplex at it (`--database` also honored per-command).
export MRPLEX_DATABASE=postgres://mrplex:mrplex@localhost:5432/mrplex
mrplex bootstrap
mrplex serve

# Other lifecycle scripts: `pg:down` (stop), `pg:reset` (wipe volume), `pg:logs`.

# Run the parity suite against the live PG (adds ~16 kernel tests).
MRPLEX_TEST_POSTGRES_URL=postgres://mrplex:mrplex@localhost:5432/mrplex npm test
```

The adapter passes any `postgres://…` URL through unchanged, so `sslmode`, `application_name`, and other libpq options work as expected. The `vector` extension is required in the target database (create it once as `create extension if not exists vector;`).

## License

TBD.
