# mrplex

*Markdown Repos, plexed.* A queryable, versioned store for Markdown documents with YAML frontmatter.

**Status:** M2 (query) in progress. CEL filter + FTS + `mrplex query`. See [docs/design.md](docs/design.md) for the full design and [docs/m2-plan.md](docs/m2-plan.md) for the milestone plan.

## Quickstart

```bash
npm install
```

Bootstrap a fresh database — this mints the root admin token exactly once:

```bash
export TOK=$(npm run --silent cli -- --database ./m1.db bootstrap)
export MRPLEX_TOKEN="$TOK"
```

Create a user + repo, then walk a doc through its lifecycle:

```bash
# Admin ops.
npm run --silent cli -- --database ./m1.db users create alice
npm run --silent cli -- --database ./m1.db repos create notes

# create → update → move → delete → restore
V=$(printf '%s\n' '---' 'title: Hello' '---' '' 'body v1' | \
    npm run --silent cli -- --database ./m1.db --json docs create notes hello.md --from-file - \
    | jq -r .version_id)

V=$(npm run --silent cli -- --database ./m1.db --json docs put notes hello.md --prev "$V" \
    --from-file - <<'EOF' | jq -r .version_id
---
title: Hello
---
body v2
EOF
)

V=$(npm run --silent cli -- --database ./m1.db --json docs mv notes hello.md greetings/hi.md --prev "$V" | jq -r .version_id)
V=$(npm run --silent cli -- --database ./m1.db --json docs delete notes greetings/hi.md --prev "$V" | jq -r .version_id)
V=$(npm run --silent cli -- --database ./m1.db --json docs put notes greetings/hi.md --prev "$V" | jq -r .version_id)

# History now has 5 versions in reverse chain order:
npm run --silent cli -- --database ./m1.db docs history notes greetings/hi.md
```

Mint a scoped token for an agent:

```bash
npm run --silent cli -- --database ./m1.db tokens create \
    --label "obsidian-plugin" \
    --scope "notes:read=**,write=inbox/**"
```

Query — CEL filters + FTS composed:

```bash
# Filter only
npm run --silent cli -- --database ./m1.db query --repo notes \
    --filter 'status == "published"'

# Text only (FTS5, porter-stemmed)
npm run --silent cli -- --database ./m1.db query --repo notes --text 'welcome OR intro'

# Filter + text composed
npm run --silent cli -- --database ./m1.db query --repo notes \
    --filter '"pricing" in list(tags)' --text pricing

# Polymorphic frontmatter — matches tags: pricing AND tags: [pricing, saas]
npm run --silent cli -- --database ./m1.db query --repo notes \
    --filter '"pricing" in list(tags)'

# $-prefixed intrinsics
npm run --silent cli -- --database ./m1.db query --repo notes \
    --filter '$path.startsWith("guides/")'
```

## What's in M2

- **CEL filter** via **`@bufbuild/cel`** (TypeScript-native; supersedes the design's `cel-go`/WASM choice — see [docs/design.md](docs/design.md) §7.1 for the rationale). Full CEL parser emitting the canonical protobuf `ParsedExpr` AST; the AST→SQL compiler is portable if we ever swap the parser.
- **`$`-prefixed intrinsics** — `$path`, `$created_at`, `$body`. Introduced via a small string-aware preprocessor that mangles `$foo` before the parser sees it; no grammar patch.
- **`list()` polymorphism** — `"pricing" in list(tags)`, `size(list(tags))`, `list(tags).all(...)`, `list(tags).exists(...)` all handle scalar-or-list frontmatter shapes (§5.2).
- **FTS via SQLite FTS5** — external-content virtual table on `versions.body` with AFTER INSERT/DELETE triggers; porter+unicode61 tokenizer. Restricted to current versions at query time.
- **`kernel.query(spec, actor)`** — composes filter + text + scope filter (§8.2, silently drops out-of-scope rows) + default sigil exclusion + ordering + limit. `rank` reserved for M4.
- **`mrplex query` CLI** with `--repo` / `--filter` / `--text` / `--limit` / `--include-hidden` / `--include-system` and `--json` scripting mode.

## What's in M1

- **Kernel write surface** — `docs.create` / `put` / `delete` with `prev_version_id` enforcement, the "one verb several intents" folding (update / move / restore), the extension-aware deletion path (`:deleted/…/foo-v45129.md`), idempotent deletes, and `stale_prev` with `current_path` redacted for callers outside read scope.
- **Repo & user writes** — `create` / `rename` / `delete` / `set_path_config` (admin-gated). Delete is a system-namespace slug rename with a 6-char base32 uniquifier; `users.delete` also revokes all the user's tokens.
- **Path config layering** — hardcoded defaults → server config → per-repo override (replace-not-merge). Startup invariants enforced (prefix-shadowing rejected, hidden sigils can't contain disallowed chars, sigil lists must be non-empty).
- **Slug + path validation** — segment-level rules from §3.5.3 / §3.5.6, called on every write.
- **Frontmatter duality** — writes supply `frontmatter_raw` (verbatim YAML) OR `frontmatter` (structured JSON) — exactly one; the other is derived. Round-trip is byte-exact via the raw form.
- **Bearer-token auth** — SHA-256-hashed secrets (`mrplex_<base64url>`), `admin` boolean, scope grammar with gitignore-style path globs and negation, system-namespace carve-out for delete/restore moves, verbatim child-scope subset check for self-token creation.
- **Bootstrap** — `mrplex bootstrap` mints the root admin token on a fresh database, refuses on any non-empty database.
- **CLI** — full command catalog with `--token` / `MRPLEX_TOKEN` / config-file precedence, per-family exit codes (1 validation, 2 concurrency, 3 auth, 4 not-found, 10 transport), `--json` mode for scripting.

Not in M2: HTTP surfaces (M3), embeddings + `rank` mode (M4), Postgres (M5), WebDAV/point-in-time/graph (§11).

## Development

```bash
npm test          # 384 tests: invariants, kernel suite, writes, admin, auth, query, CLI
npm run typecheck # tsc --noEmit, strict
npm run lint      # biome check
npm run build     # emit dist/
```

CI runs typecheck + lint + tests on Ubuntu & macOS × Node 20 & 22.

## License

TBD.
