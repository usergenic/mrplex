# mrplex

*Markdown Repos, plexed.*

**Turn ordinary Markdown folders into queryable, versioned, graph-aware knowledge stores — without giving up files.** Your notes stay plain `.md` on disk; agents and humans share the same repository, every write is versioned, and links survive renames.

## Install

Node ≥ 20.11:

```bash
npm install -g mrplex
```

Prefer not to install globally? `npx mrplex …` works the same way.

Point every command at a database and default repo once (the tour below uses `starship`):

```bash
export MRPLEX_DATABASE=./demo.db
export MRPLEX_REPO=starship
```

Or persist settings in `~/.config/mrplex/config.json`:

```bash
mrplex config set-database ./demo.db
mrplex config set-repo starship
```

Each setting resolves **flag → env → config file → default**, so one-off overrides never require editing anything.

> **From a git checkout?** Run `npm install && npm link` (or `npm run cli -- …`). Every `mrplex …` command below is equivalent to `npx mrplex …`.

## A five-minute tour

This walkthrough uses the **USS Meridian** — a sample starship knowledge base in [`fixtures/starship/`](fixtures/starship/): crew files, mission records, officer logs, and equipment status, all ordinary Markdown with YAML frontmatter.

### 1. Sync the sample corpus

Clone the repo (for the fixture files), install, and sync the folder into a fresh mrplex repo:

```bash
git clone https://github.com/usergenic/mrplex
cd mrplex
npm install && npm link    # skip if you installed globally above

export MRPLEX_DATABASE=./demo.db
export MRPLEX_REPO=starship

mrplex repos create starship
mrplex sync fixtures/starship --once -r starship
```

`sync` is the normal way to load a Markdown folder: it pushes local files into the repo, materializes version metadata, and keeps a cursor for two-way updates. Frontmatter values written as repo-root paths (`/crew/foo.md`) and embedded wikilinks/inline links are indexed automatically — no link-config setup step.

No bootstrap, no token — local mode is full-trust (whoever can run the binary owns the database).

### 2. Query it like data

Frontmatter is queryable with [CEL](https://github.com/google/cel-spec) filters:

```bash
# What's broken or offline right now?
mrplex query --filter 'status == "damaged" || status == "offline"'

# Who reports directly to the captain?
mrplex query --filter '$has_static("crew/kestrel-vance.md", "reports_to")'
```

```text
PATH                              STATUS
equipment/plasma-manifold-3.md    damaged
equipment/shuttle-corvid.md       offline
…

PATH                    TITLE
crew/aria-okonkwo.md    Commander Aria Okonkwo
crew/dax-thorne.md      Lieutenant Commander Dax Thorne
crew/quill-vasquez.md   Doctor Quill Vasquez
```

Compose with full-text search — filter, text, and semantic (when configured) all AND together:

```bash
mrplex query --text 'manifold coolant'
mrplex query --filter 'type == "mission"' --text 'Halloway'
```

### 3. Follow the links as a graph

Markdown links, wikilinks, and frontmatter repo-root paths (`/crew/foo.md`) build a derived index bound to document *identity*, so backlinks survive renames. Query membership in CEL:

```bash
# Every mission indexed by the mission log MOC
mrplex query --filter '$in_static("moc/missions.md")'

# What touches the damaged plasma manifold? (maintainer field, body links, logs…)
mrplex query --filter '$has_static("equipment/plasma-manifold-3.md")'
```

Explore *how* documents connect — neighborhood expansion from a root set:

```bash
mrplex graph --roots missions/the-hollow-signal.md --degrees 2 --direction both --render summary
```

The missing officer, his mission, the encounter, and the logs that mention him appear as a connected neighborhood — the kind of thread a flat file listing can't give you.

Mermaid for slides or docs:

```bash
mrplex graph --roots crew/kestrel-vance.md --degrees 2 --direction out --render mermaid
```

### 4. Change something safely

Every write inserts a new version; nothing is overwritten. Rename a document and the link graph follows its identity:

```bash
# See current version id, then move the manifold note
V=$(mrplex --json docs get equipment/plasma-manifold-3.md | jq -r .version_id)
mrplex docs mv equipment/manifold-3.md --prev "$V"

# Backlinks still resolve — the graph never broke; link text may need repair
mrplex query --filter '$has_static("equipment/manifold-3.md")'
mrplex links stale
```

History and unified diff between any two versions:

```bash
mrplex docs history equipment/manifold-3.md
mrplex docs diff equipment/manifold-3.md --from v1 --to v2
```

Deletion moves a document to a system-namespace path (`:deleted/…`); restore is a normal `docs put` back to user territory.

### 5. Connect an agent

CLI, MCP, and REST are surfaces over the same model. Point Cursor (or any MCP client) at your local database:

```json
{
  "mcpServers": {
    "mrplex": {
      "command": "mrplex",
      "args": ["mcp-stdio", "--unsafe", "--database", "./demo.db"],
      "env": { "MRPLEX_REPO": "starship" }
    }
  }
}
```

An agent can now ask relational questions — *"What's broken on the ship, who maintains it, and which missions were affected?"* — and recover structured answers through `query` and `graph` instead of reading every file into context.

Serve HTTP for remote clients or Streamable HTTP MCP:

```bash
mrplex serve --unsafe --port 8321 &
mrplex --server http://127.0.0.1:8321 query --filter 'status == "missing"'
```

For shared or networked deployments, run the authenticating shell instead — see [Authentication](#authentication) below. Never expose the raw kernel (`serve --unsafe`) directly to an untrusted network.

## How it works

| Concept | What it means |
|--------|----------------|
| **Document** | One Markdown file with YAML frontmatter, addressed by repo-relative path |
| **Version** | Every write appends; `prev_version_id` optimistic concurrency rejects stale writes |
| **Query** | CEL filters over frontmatter + `$path` / `$body` / `$updated_at` intrinsics; composes with FTS and semantic search |
| **Link graph** | Derived index over inline links, wikilinks, and frontmatter repo-root paths; `$in`, `$has`, `$backlinks`, `$links` in CEL |
| **Graph** | BFS neighborhood expansion over the link index — *how* things connect, not just *which* match |
| **Surfaces** | `mrplex` CLI (local or `--server`), MCP at `/mcp` or `mcp-stdio`, REST at `/repos/{repo}/…` |

Two layers: a **full-trust kernel** (no in-engine auth) and an optional **access-and-identity shell** (API keys, OIDC, per-path write policy, audit log). See [docs/archive/security.md](docs/archive/security.md) for trust boundaries and deployment shapes.

## Features

<details>
<summary>Full feature list</summary>

- **Versioned Markdown store** — every write inserts; `docs.put` handles in-place update and move; any past state is addressable
- **Byte-exact frontmatter** — `frontmatter_raw` (verbatim YAML) or `frontmatter` (JSON); exactly one; round-trips are byte-exact via raw
- **Optimistic concurrency** — stale `prev_version_id` → `stale_prev` with current version returned
- **Deletion as move** — `:deleted/…` paths; idempotent delete; restore via `docs.put`
- **Unified diff** — `docs.diff`, REST `/diff`, MCP `docs_diff`, CLI `mrplex docs diff`; `patch(1)`-applicable output
- **CEL filter queries** — frontmatter fields + `$`-intrinsics; `list()` polymorphism for scalar-or-list fields
- **Link graph** — inline, wikilink, and frontmatter path extraction (no per-field config); backlinks survive renames; set algebra (`$in("moc/**") && !$in("moc/draft.md")`); `$in_static` for link-only membership; `links stale` / `repair` / `backfill`
- **Graph exploration** — BFS with direction lens, visibility filter, graph-only `$degrees` intrinsic; CLI `--render summary|yaml|mermaid|json`
- **Full-text search** — SQLite FTS5 or Postgres `websearch_to_tsquery`; composes with filter via AND
- **Semantic search** — pluggable `--embedder` hook; chunker + backlog worker; `$semantic_score` in `select`; no hook → `semantic_unavailable`
- **HTTP surfaces** — MCP (Streamable HTTP + STDIO), REST with `If-Match` / content negotiation / `MOVE`
- **CLI** — thin MCP client; `--database` local or `--server` remote; identical commands over both
- **Storage** — SQLite (default) or Postgres+pgvector; same kernel test suite on both
- **Path policy** — configurable sigils and disallowed chars; NFC + case-insensitive identity, case-preserved storage
- **Canonical paths** — API responses use slashless repo-relative paths; leading `/` accepted as root alias on input only

Prior design docs in [docs/archive/](docs/archive/) may be out of date where later work supersedes them.

</details>

## Authentication

For anything beyond single-user local use, run the **authenticating shell** — `serve --policy`. It reads declarative YAML (roles, principals, grants, key hashes, OIDC bindings), authenticates each request, and dispatches against a per-principal *guarded* kernel: read visibility narrowed, writes enforced per-path, author derived from the credential, every call audited.

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
    oidc: { email: ann@example.com }
```

```bash
mrplex key mint brendan --policy policy.yaml
mrplex serve --policy policy.yaml --audit audit.jsonl --port 8321 &
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:8321/repos
```

Three deployment shapes — **embedded** (`serve --policy`), **launcher** (`mcp-stdio --policy`), and **fronting proxy** (`proxy --policy --upstream`). Edit the policy and `kill -HUP` to reload grants without restart. OIDC device-flow login via `mrplex login`. Full details in [docs/archive/security.md](docs/archive/security.md).

## Embeddings

mrplex never calls an embedding provider itself — wire one with `--embedder` (subprocess command or HTTP URL). For local CPU embeddings:

```bash
npm install -g @mrplex/embedder
export MRPLEX_EMBEDDER=mrplex-embedder

mrplex serve --unsafe --embedder mrplex-embedder
mrplex embed backfill -r starship
mrplex query -r starship --semantic 'distress beacon star map'
```

Resolution: **flag → `MRPLEX_EMBEDDER` → `mrplex config set-embedder` → unset**. See [packages/embedder/README.md](packages/embedder/README.md) for protocol details.

## Development

```bash
npm install
npm link
npm test
npm run typecheck
npm run lint
npm run build
```

Seed the full dev fixture set (notes + starship):

```bash
npm run seed -- --database ./mrplex.db
```

CI runs typecheck + lint + tests on Ubuntu & macOS × Node 20 & 22, plus Postgres+pgvector parity. If tests fail with a `NODE_MODULE_VERSION` error from `better-sqlite3`, run `npm rebuild better-sqlite3`.

### Postgres locally

```bash
npm run pg:up
export MRPLEX_DATABASE=postgres://mrplex:mrplex@localhost:5432/mrplex
mrplex serve --unsafe
```

## License

MIT — see [LICENSE](LICENSE).
