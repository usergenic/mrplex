# mrplex

*Markdown Repos, plexed.* A queryable, versioned store for Markdown documents with YAML frontmatter.

See [docs/design.md](docs/design.md) for the full design.

## Features

- **Versioned Markdown store.** Every write inserts a new version; nothing is overwritten; any past state is addressable. `docs.put` handles both in-place update and move (path may differ from the previous version).
- **Byte-exact frontmatter.** Writes supply `frontmatter_raw` (verbatim YAML) OR `frontmatter` (structured JSON) — exactly one; the other is derived. Round-trips are byte-exact via the raw form.
- **Optimistic concurrency.** Every write supplies the `prev_version_id` it observed; a stale prev is rejected with `stale_prev` and the current version returned.
- **Deletion is a move to a system-namespace path** (`:deleted/…/foo-v45129.md`, extension-aware). Restore is a `docs.put` back to a user-territory path. `docs.delete` is idempotent.
- **CEL filter queries** over frontmatter fields and `$`-prefixed intrinsics (`$path`, `$created_at`, `$body`). `list()` polymorphism handles scalar-or-list frontmatter uniformly.
- **Full-text search** over document body via SQLite FTS5 (porter+unicode61 tokenizer). Composes with filter via AND.
- **Bearer-token auth** with capability scopes — repo-scoped `read` / `write` path globs (gitignore-style, with negation), admin bit, per-token subset semantics for self-issued tokens.
- **HTTP surfaces.** Protocol-true MCP server at `/mcp` (Streamable HTTP + optional STDIO), and a resource-oriented REST surface with `If-Match` / `If-None-Match`, content negotiation (`application/json` or `text/markdown`), `MOVE`, and sibling `/versions` / `/history` roots. Query responses carry ETags for `If-None-Match` → 304.
- **`mrplex` CLI** — thin client over MCP. `--database` for local embedded mode against a SQLite file; `--server` for remote mode against a running server. Every command works identically over both transports.
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

Query — CEL filters + FTS composed:

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
```

Serve the HTTP surfaces and drive the CLI remotely:

```bash
# Start the server (REST + MCP Streamable HTTP on :8321 by default)
npm run --silent cli -- --database ./mrplex.db serve --port 8321 &

# Same commands, now over the network
npm run --silent cli -- --server http://127.0.0.1:8321 docs get notes greetings/hi.md
npm run --silent cli -- --server http://127.0.0.1:8321 query --repo notes --filter 'status == "published"'
```

## Development

```bash
npm test          # invariants, kernel suite, writes, admin, auth, query, HTTP surfaces, CLI
npm run typecheck # tsc --noEmit, strict
npm run lint      # biome check
npm run build     # emit dist/
```

CI runs typecheck + lint + tests on Ubuntu & macOS × Node 20 & 22.

## License

TBD.
