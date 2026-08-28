# mrplex

*Markdown Repos, plexed.* A queryable, versioned store for Markdown documents with YAML frontmatter.

Two layers: a **full-trust kernel** (no in-engine auth — whoever reaches it can do anything) and an **access-and-identity shell** that wraps it (API keys / OIDC, per-path write policy, an audit log). See [docs/security.md](docs/archive/security.md) for the trust model and deployment shapes. Prior design docs live in [docs/archive/](docs/archive/) — including the original [design.md](docs/archive/design.md) — and may be out of date where later work supersedes them.

## Features

- **Versioned Markdown store.** Every write inserts a new version; nothing is overwritten; any past state is addressable. `docs.put` handles both in-place update and move (path may differ from the previous version).
- **Byte-exact frontmatter.** Writes supply `frontmatter_raw` (verbatim YAML) OR `frontmatter` (structured JSON) — exactly one; the other is derived. Round-trips are byte-exact via the raw form.
- **Optimistic concurrency.** Every write supplies the `prev_version_id` it observed; a stale prev is rejected with `stale_prev` and the current version returned.
- **Deletion is a move to a system-namespace path** (`:deleted/…/foo-v45129.md`, extension-aware). Restore is a `docs.put` back to a user-territory path. `docs.delete` is idempotent.
- **Unified diff** between any two versions of the same document via `docs.diff` — kernel op, `/repos/{repo}/diff/{path}?from=&to=` REST route (JSON envelope or `Accept: text/plain` raw patch), `docs_diff` MCP tool, `mrplex docs diff` CLI. `patch(1)`-applicable output.
- **CEL filter queries** over frontmatter fields and `$`-prefixed intrinsics (`$path`, `$updated_at`, `$body`). `list()` polymorphism handles scalar-or-list frontmatter uniformly.
- **Link graph** — a derived index over Markdown links (CommonMark inline/reference, wikilinks `[[page]]`, and opt-in frontmatter reference fields), maintained in the write transaction and bound to document *identity* so backlinks survive renames. Query it in CEL with possession-language intrinsics: `$in(glob)` / `$has(glob)` (membership, optional field restriction) and `$backlinks()` / `$links()` collections (`.size()`, `.exists()`, `.all()`). Composes as set algebra: `$in("moc/**") && !$in("moc/contractors.md")`, `!$in("**")` (orphans), `$links().size() == 0` (leaves). Every predicate respects the caller's read scope — the visible graph equals the readable graph. `mrplex links stale` / `repair` fix link *text* after a move (the graph itself never breaks). See §11.2.
  - **`$in` today means links you wrote; later it will also include dynamic membership.** A document denotes a set — the docs it links to — and a future release lets a document *also* define members via embedded queries. When that lands, `$in` (and `$has`/`$backlinks()`/`$links()`) transparently widen to the union of written links **and** query-derived membership. If you want to match **only** statically-written links, now and forever, use the `_static` forms (`$in_static`, `--in-static`); they never widen. The `_dyn`-only forms are reserved until that release.
- **Graph exploration** — where a CEL query answers *which* documents match, `graph` answers *how* documents connect: a read-only BFS neighborhood expansion over the link index. From a root set, expand outward under a direction lens (`out`/`in`/`both`) up to N hops, returning the reached **documents** and the **links** between them, a `frontier` for cursorless continuation, and truncation metadata. `filter` is *visibility* (a non-matching doc is hidden and blocks paths through it) and gains a graph-only `$degrees` intrinsic — e.g. `$degrees <= 1 || type == "person"` expands everything one hop but keeps following person docs. Kernel op, `graph` MCP tool, `/repos/{repo}/graph` REST route (GET + POST), and `mrplex graph --render summary|yaml|mermaid|json` CLI. See §11.3 / `docs/archive/graph-plan.md`.
- **Full-text search** over document body — SQLite FTS5 (porter+unicode61) or Postgres `websearch_to_tsquery`. Composes with filter via AND. Portable syntax subset across both engines: bare terms and quoted phrases.
- **Semantic rank via embeddings** — pluggable hook (`--embed-url` HTTP or `--embed-cmd` subprocess); mrplex never calls a provider itself. Chunker + backlog worker + brute-force cosine k-NN over `sqlite-vec`; results current-version only, deduped by content hash. Composes with filter/text/scope/sigil-exclusion. No hook configured → `rank_unavailable` (no zero-vector default — silent garbage is worse than a visible gap).
- **Full-trust kernel — no in-engine auth.** mrplex authenticates nothing: any caller that can reach the engine can do anything. Authentication, users, and tokens live in a *shell* around it — the OS process boundary for local/stdio use, or a fronting proxy for networked deployments (never expose mrplex directly to an untrusted network). Identity is one opaque `author` string per write (default `"mrplex"`; convention is git's `Full Name <email>`). Read visibility can still be narrowed per call with a `ScopeClaim[]` — repo/path globs (gitignore-style, with negation) evaluated at call time.
- **HTTP surfaces.** Protocol-true MCP server at `/mcp` (Streamable HTTP + optional STDIO), and a resource-oriented REST surface with `If-Match` / `If-None-Match`, content negotiation (`application/json` or `text/markdown`), `MOVE`, and sibling `/versions` / `/history` / `/diff` roots. Query responses carry ETags for `If-None-Match` → 304.
- **`mrplex` CLI** — thin client over MCP. `--database` for local embedded mode; `--server` for remote mode against a running server. Every command works identically over both transports.
- **Two v1 storage adapters — SQLite and Postgres+pgvector.** `--database sqlite:./mrplex.db` (bare path defaults to sqlite) or `--database postgres://user:pw@host:5432/db`. Both pass the same kernel test suite.
- **Configurable path policy** — hardcoded defaults → server config → per-repo override. `disallowed_chars`, `system_sigils`, `hidden_sigils`, all with sensible defaults (Obsidian's cross-platform-safe rule).
- **Case-insensitive paths and slugs** — identity is Unicode-normalized (NFC) and case-insensitive (`Alice.md` and `alice.md` are the same document; `docs.get NOTES/alice.md` finds it), while storage preserves the exact case you write.

## Quickstart

Install and link the `mrplex` command:

```bash
npm install
npm link          # puts `mrplex` on your PATH; alternatively, `npm install -g` after publish
```

No bootstrap, no token for local use — the kernel is full-trust (whoever can run
the binary or reach the port is trusted). Add authentication for shared or
networked deployments with the shell (see [Authentication](#authentication)).
Point every command at the same database and target repo by exporting once:

```bash
export MRPLEX_DATABASE=./mrplex.db
export MRPLEX_REPO=notes                  # default repo for `docs *` commands
export MRPLEX_AUTHOR="Ada Lovelace <ada@example.com>"   # optional; stamped on writes (default "mrplex")
```

`docs *` commands read the target repo from `MRPLEX_REPO`; override any call
with `-r / --repo <slug>`.

**Prefer a config file to environment variables?** `mrplex config set-*` writes
`$XDG_CONFIG_HOME/mrplex/config.json` (defaults to `~/.config/mrplex/config.json`):

```bash
mrplex config set-database ./mrplex.db
mrplex config set-repo notes
mrplex config set-author "Ada Lovelace <ada@example.com>"   # optional; identity on writes
mrplex config set-server http://127.0.0.1:8321             # optional — for remote mode
mrplex config show                                         # summary
```

Each setting is resolved **flag → env → config file → hardcoded default**, so a
one-off `-r other-repo`, `--author "…"`, or `--server https://…` overrides the
persisted value without editing anything.

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

Narrow read visibility for a single call with `--scope` (a JSON `ScopeClaim[]` of
repo/path globs, evaluated at call time). Absent scope = full visibility; a
present claim silently filters `query` and 403s out-of-claim reads:

```bash
mrplex query --repo notes --filter 'status == "published"' \
    --scope '[{"repo":"notes","paths":["**","!secret/**"]}]'
```

There are no users, tokens, or per-path write policy in the engine — those are
the shell's job. For multi-user or networked setups, run the built-in
authenticating shell instead of the raw kernel — see
[Authentication](#authentication) below and [docs/security.md](docs/archive/security.md).
Never expose the raw kernel (`serve --unsafe`) directly to an untrusted network.

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

# Path glob — gitignore-style (design §8.2)
mrplex query --repo notes --path 'horses.md'      # bare name → any depth
mrplex query --repo notes --path '/horses.md'     # leading / → root only
mrplex query --repo notes --path '**/horses.md'   # any depth incl. root
mrplex query --repo notes --path 'guides/*'       # one level under guides/
mrplex query --repo notes --path 'drafts/**'      # anywhere under drafts/

# --path composes with --filter (AND)
mrplex query --repo notes --path '*.md' --filter 'status == "published"'

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

Query and maintain the link graph (§11.2):

```bash
# Documents referenced by a map-of-content; set algebra composes.
mrplex query -r notes --filter '$in("moc/employees.md")'
mrplex query -r notes --filter '$in("moc/**") && !$in("moc/contractors.md")'

# Orphans (in nobody's set) and leaves (link to nothing).
mrplex query -r notes --filter '!$in("**")'
mrplex query -r notes --filter '$links().size() == 0'

# Docs a draft cites; docs referencing any project via their `parent` field.
mrplex query -r notes --filter '$backlinks().exists(d, d.status == "draft")'
mrplex query -r notes --filter '$has("projects/**", "parent")'

# Pin to statically-written links only (never widens to dynamic membership).
mrplex query -r notes --filter '$in_static("moc/employees.md")'

# After moving a target, fix stale link *text* (the graph itself never broke).
mrplex -r notes links stale
mrplex -r notes links repair --dry-run
mrplex -r notes links repair

# Rebuild the index from scratch (e.g. after changing link_config).
mrplex -r notes links backfill
```

Explore *how* documents connect — `graph` neighborhood expansion (§11.3):

```bash
# What a map-of-content reaches, two hops out (the contents tree).
mrplex graph -r notes --roots 'moc/**' --degrees 2 --direction out

# filter is visibility, and $degrees binds: expand everything one hop, but
# keep following person docs deeper (a non-match also blocks paths through it).
mrplex graph -r notes --roots moc/employees.md \
    --filter '$degrees <= 1 || type == "person"'

# Co-citation: root → shared-target ← sibling appears under the undirected lens.
mrplex graph -r notes --roots people/sam.md --direction both --degrees 2

# Renderings are a surface choice, not a call parameter.
mrplex graph -r notes --roots moc/employees.md --render mermaid   # showable
mrplex graph -r notes --roots moc/employees.md --render yaml
```

Serve the HTTP surfaces and drive the CLI remotely. `serve` must spell out its
trust posture — exactly one of `--policy <file>` (the authenticating shell) or
`--unsafe` (the raw full-trust kernel). It refuses to start with neither or both,
so full trust is never a forgotten-flag accident:

```bash
# Full-trust local dev (no auth). --unsafe is deliberate and explicit.
mrplex serve --unsafe --port 8321 &

# Same commands, now over the network — --server takes precedence over --database
mrplex --server http://127.0.0.1:8321 docs get greetings/hi.md
mrplex --server http://127.0.0.1:8321 query -r notes --filter 'status == "published"'
mrplex --server http://127.0.0.1:8321 docs diff greetings/hi.md --from v1 --to v3
```

## Authentication

For anything beyond single-user local use, run the **authenticating shell** —
`serve --policy`. It reads a declarative YAML policy (roles, principals, grants,
key hashes, OIDC bindings), authenticates each request, and dispatches against a
per-principal *guarded* kernel: read visibility is narrowed, write and
destructive ops are enforced per-path, the author is derived from the credential
(never the client's word), and every call is audited. The kernel never learns
any of this exists.

```yaml
# policy.yaml
roles:
  editor:
    grants:
      - repo: notes
        read: "**"
        write: ["drafts/**", "inbox/**"]
  operator:
    grants:
      - { repo: "*", read: "**", write: "**" }
    destructive: true

principals:
  brendan:
    author: Brendan Baldwin <brendan@example.com>
    roles: [operator]
    keys:
      - sha256:...        # `mrplex key mint brendan --policy policy.yaml`
  ann:
    roles: [editor]
    oidc: { email: ann@example.com }   # author derived from the JWT
```

```bash
# Mint an API key — prints the plaintext ONCE, appends the hash to the policy.
mrplex key mint brendan --policy policy.yaml

# Inspect a principal's effective entitlement ("why can't X write Y").
mrplex policy check brendan --policy policy.yaml

# Run the authenticating shell (embedded — no separate engine process).
mrplex serve --policy policy.yaml --audit audit.jsonl --port 8321 &

# Clients present a bearer credential; the server's policy governs them.
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:8321/repos

# Accept IdP-issued JWTs too (OIDC): pin issuer + audience.
mrplex serve --policy policy.yaml \
    --oidc-issuer https://idp.example.com --oidc-audience https://mrplex.example.com
mrplex login --client-id mrplex-cli \
    --device-authorization-endpoint https://idp.example.com/oauth/device/code \
    --token-endpoint https://idp.example.com/oauth/token \
    --audience https://mrplex.example.com     # match the server's --oidc-audience
```

Three deployment shapes — **embedded** (`serve --policy`, one process, no engine
listener), **launcher** (`mcp-stdio --policy`, a guarded stdio MCP session), and
**fronting proxy** (`proxy --policy --upstream`, for topologies that must run the
engine separately). Edit the policy file and `kill -HUP` the server to reload
grants and key revocations without a restart. Full details, trust boundaries,
and the header-injection contract are in [docs/security.md](docs/archive/security.md).

### Walkthrough: OIDC login with Auth0

A concrete end-to-end for wiring an IdP. Auth0 is used here; the shape is the
same for Okta, Keycloak, Entra, etc. — only the endpoint URLs differ.

**1. In the Auth0 dashboard.**

- Create an **API** (Applications → APIs). Its **Identifier** is the `audience`
  — e.g. `https://mrplex.example.com`. Note the tenant issuer, which is your
  tenant domain with a trailing slash: `https://YOUR_TENANT.us.auth0.com/`.
- Create an application of type **Native** (the device flow needs a public
  client). Enable the **Device Code** grant under its Advanced → Grant Types.
  Note its **Client ID**.

**2. Point the server at the tenant.** The issuer's JWKS is discovered at
`<issuer>/.well-known/jwks.json`, so only issuer + audience are required:

```bash
mrplex serve --policy policy.yaml \
    --oidc-issuer   https://YOUR_TENANT.us.auth0.com/ \
    --oidc-audience https://mrplex.example.com \
    --port 8321 &
```

**3. Bind a principal by claim.** Auth0 puts the user's email in the token; the
shell only trusts it when `email_verified` is true (see [docs/security.md](docs/archive/security.md)),
so bind by `email` for verified users, or by the issuer-stable `sub` otherwise:

```yaml
principals:
  ann:
    roles: [editor]
    oidc: { email: ann@example.com }        # author derived as "Name <ann@example.com>"
  ci-bot:
    author: ci-bot <ci@example.com>
    roles: [editor]
    oidc: { sub: "auth0|4b1c..." }           # service account: bind by sub
```

**4. Sign in from the CLI.** `--audience` is **required for Auth0** — without it
Auth0 returns an *opaque* access token that fails JWKS verification; passing the
API identifier makes it mint a verifiable JWT. Use the same value as the
server's `--oidc-audience`:

```bash
mrplex login \
    --client-id  YOUR_NATIVE_CLIENT_ID \
    --device-authorization-endpoint https://YOUR_TENANT.us.auth0.com/oauth/device/code \
    --token-endpoint                https://YOUR_TENANT.us.auth0.com/oauth/token \
    --audience   https://mrplex.example.com \
    --scope "openid email profile offline_access"
# → visit the URL, enter the code; the token is cached (mode 600).
```

**5. Use the token.** `mcp-stdio` picks up the cached token automatically (or
pass `--token` / `MRPLEX_SHELL_TOKEN` explicitly); over HTTP, present it as a
bearer:

```bash
TOKEN=$(mrplex login ... && cat "${XDG_CONFIG_HOME:-$HOME/.config}/mrplex/token.json" | jq -r .access_token)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8321/repos
```

Troubleshooting: a 401 with a token that *looks* valid almost always means the
token is opaque (missing `--audience`) or the issuer/audience don't match the
server's pins exactly (Auth0 issuers include the trailing slash).

> Prefer not to `npm link`? Use `npx mrplex …` from the repo, or add
> `./node_modules/.bin` to your `PATH`. Every `mrplex …` command in
> this README is equivalent to `npx mrplex …` or
> `npm run --silent cli -- …`.

## Embeddings

mrplex never calls an embedding provider itself — you wire one up. It doesn't install one by default either, but it does bundle a ready-to-use local provider ([`packages/embedder`](packages/embedder), see [below](#local-embedder-no-service-no-gpu)) you can opt into, and rolling your own is just implementing one of two hook shapes:

```bash
# HTTP endpoint — server POSTs { chunks: [...] } and expects
# { vectors: [[...]], model: "…", dim: N }.
mrplex serve --unsafe --embed-url http://127.0.0.1:8399

# Subprocess — one JSON line in / one JSON line out over stdin/stdout.
mrplex serve --unsafe --embed-cmd "path/to/embedder --stdio"
```

(The `--policy` shell accepts the same `--embed-*` flags.)

Either flag can also come from `MRPLEX_EMBED_URL` / `MRPLEX_EMBED_CMD` env or CLI config. `--embed-url` and `--embed-cmd` are mutually exclusive.

### Local embedder (no service, no GPU)

[`packages/embedder`](packages/embedder) is a ready-to-use `--embed-cmd` provider: a resident Node subprocess running `bge-small-en-v1.5` (384-dim) on CPU via ONNX. It's a **separate package** so its `fastembed` dependency stays out of mrplex's core dependency graph — install it only if you want local embeddings:

```bash
cd packages/embedder && npm install   # its own deps + lockfile, not mrplex's

mrplex serve --unsafe --embed-cmd "node packages/embedder/embedder.mjs --stdio"
```

See [packages/embedder/README.md](packages/embedder/README.md) for model flags (`--model`, `--dim`) and a note on the `tar` advisory scope.

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
npm test          # invariants, kernel suite, writes, read scopes, query, rank, diff, chunker, worker, HTTP surfaces, CLI
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
mrplex serve --unsafe

# Other lifecycle scripts: `pg:down` (stop), `pg:reset` (wipe volume), `pg:logs`.

# Run the parity suite against the live PG (adds ~16 kernel tests).
MRPLEX_TEST_POSTGRES_URL=postgres://mrplex:mrplex@localhost:5432/mrplex npm test
```

The adapter passes any `postgres://…` URL through unchanged, so `sslmode`, `application_name`, and other libpq options work as expected. The `vector` extension is required in the target database (create it once as `create extension if not exists vector;`).

## License

TBD.
