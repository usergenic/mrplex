# mrplex

*Markdown Repos, plexed.*

mrplex is not a better notes app. It is a small kernel that leaves your files as files and makes the folder a multi-agent substrate.

You keep working with ordinary `.md` with YAML frontmatter. mrplex adds versions, optimistic concurrency, CEL filters, full-text search, optional embeddings, and a link graph bound to document identity so renames do not smash backlinks. CLI, MCP, and REST are the same model with different sockets.

If you wanted an Obsidian clone, this is the wrong repo. If you're an Obsidian user, now your agents can utilize and manage your vault through mrplex's MCP interface.

## Install

Node ≥ 20.11:

```bash
npm install -g mrplex
```

`npx mrplex …` works. From a git checkout: `npm install && npm link`.

No config required. With no flags, the CLI uses `./mrplex.db`. Pass `-r <repo>` when a command needs a repo.

## Five minutes on the USS Meridian

The fixture in `fixtures/starship/` is a starship knowledge base: crew, missions, logs, equipment. Ordinary Markdown. The product is the questions you can ask without opening every file.

```bash
git clone https://github.com/usergenic/mrplex
cd mrplex
npm install && npm link

mrplex repos create starship
mrplex sync fixtures/starship --once -r starship
```

`sync` loads a folder, versions it, and keeps a cursor for two-way updates. Wikilinks, inline links, and frontmatter values written as repo-root paths (`/crew/foo.md`) are indexed automatically.

### Ask the folder like data

```bash
# What's broken?
mrplex -r starship query --filter 'status == "damaged" || status == "offline"'

# Who reports to the captain?
mrplex -r starship query --filter '$has("crew/kestrel-vance.md", "reports_to")'

# Filter AND full-text
mrplex -r starship query --filter 'type == "mission"' --text 'Halloway'
```

`query` returns lean hits. Default projection is paths, not bodies. Hydrate what you need. That is how an agent stays cheap.

Filter, text, and semantic compose with AND. Semantic rank is a shortlist, not an oracle. Inspect the top hits; do not treat cosine as authority.

### Follow the graph

Links live on document identity, not on the string you typed. Move a file and the graph still knows who pointed at it. The written text may go stale; the relation does not.

```bash
# Everything a map-of-content claims
mrplex -r starship query --filter '$in("moc/missions.md")'

# What touches the damaged manifold?
mrplex -r starship query --filter '$has("equipment/plasma-manifold-3.md")'

# Neighborhood, not a file listing
mrplex -r starship graph --roots missions/the-hollow-signal.md --degrees 2 --direction both --render summary
mrplex -r starship graph --roots crew/kestrel-vance.md --degrees 2 --direction out --render mermaid
```

### Write without clobbering

Every write inserts a version. `prev_version_id` is optimistic concurrency. Stale prev loses; the current version comes back. Delete is a move to `:deleted/…`. Restore is a normal put.

```bash
V=$(mrplex -r starship --json docs get equipment/plasma-manifold-3.md | jq -r .version_id)
mrplex -r starship docs mv equipment/manifold-3.md --prev "$V"

mrplex -r starship query --filter '$has("equipment/manifold-3.md")'
mrplex -r starship links stale

mrplex -r starship docs history equipment/manifold-3.md
mrplex -r starship docs diff equipment/manifold-3.md --from v1 --to v2
```

## Connect an agent

CLI, MCP, and REST are surfaces over one kernel. For a database only you can touch, local stdio with `--unsafe` is the fastest first attachment:

```json
{
  "mcpServers": {
    "mrplex": {
      "command": "mrplex",
      "args": ["mcp-stdio", "--unsafe", "--database", "./mrplex.db"]
    }
  }
}
```

`--unsafe` means full-trust kernel: no auth in-process. That is correct for a private local file. It is not a networked default.

The questions that justify the extra process are relational: *what is broken, who maintains it, which missions were hit?* Query and graph first. `docs get` / `docs_get_many` only for the hits you will actually use.

## Policy shell (local or networked)

When you want principals — MCP as maintainer, a separate admin for repo create/delete — scaffold a policy and mint keys. No YAML to copy:

```bash
mrplex policy create --principal brendan --author "Brendan Baldwin <brendan@example.com>"
# → policy.yaml with admin (operator) + brendan (maintainer)

KEY=$(mrplex key mint brendan --policy policy.yaml)   # MCP day-to-day
# mrplex key mint admin --policy policy.yaml          # when you need repos create/delete

mrplex serve --policy policy.yaml --audit audit.jsonl --port 8321 &
# or: mrplex mcp-stdio --policy policy.yaml --key "$KEY"
```

`policy create` writes the minimal file; `policy check` validates it (and can dump a principal's entitlement). Edit the file only when you outgrow the defaults.

Three shapes: **embedded** (`serve --policy`), **launcher** (`mcp-stdio --policy`), **fronting proxy** (`proxy --policy --upstream`). Edit the policy and `kill -HUP` to reload. OIDC device flow via `mrplex login`. Details in [docs/archive/security.md](docs/archive/security.md).

Never expose `serve --unsafe` to an untrusted network. The flag is loud on purpose.

## How it works

| Piece          | Job                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------- |
| **Document**   | One Markdown file with YAML frontmatter, addressed by repo-relative path                 |
| **Version**    | Every write appends. `prev_version_id` rejects stale writers                             |
| **Query**      | CEL over frontmatter + `$path` / `$body` / `$updated_at`; AND with FTS and semantic      |
| **Link graph** | Derived from inline links, wikilinks, and frontmatter repo-root paths. Bound to identity |
| **Graph**      | BFS neighborhood. *How* things connect, not only *which* match                           |
| **Surfaces**   | CLI (`--database` or `--server`), MCP (`/mcp` or `mcp-stdio`), REST                      |

Two layers: a **full-trust kernel** and an optional **access-and-identity shell** (keys, OIDC, per-path grants, audit). The kernel does not pretend to be a user system. Local CLI against a database file is full-trust — possession of the file is root.

What ships today:

- Versioned Markdown store; byte-exact `frontmatter_raw` or structured `frontmatter`
- Optimistic concurrency; delete-as-move; unified diff
- CEL + `list()` for scalar-or-list fields; `$in` / `$has` / `$backlinks` / `$links` (membership is a filter, not a separate CLI flag)
- FTS5 or Postgres `websearch_to_tsquery`
- Pluggable embedder; no hook → `semantic_unavailable` instead of silent junk vectors
- SQLite default or Postgres+pgvector; same kernel suite on both
- NFC + case-insensitive identity, case-preserved storage

## Embeddings

mrplex never calls an embedding vendor. Wire a hook:

```bash
npm install -g @mrplex/embedder

mrplex serve --unsafe --embedder mrplex-embedder
mrplex embed backfill -r starship
mrplex -r starship query --semantic 'distress beacon star map'
```

With `--server`, configure the embedder on the host. Protocol: [packages/embedder/README.md](packages/embedder/README.md).

Use semantic search to generate candidates. Then filter, hydrate, and read. Rank without inspection is how agents launder a guess into a citation.

## Config & environment

Resolution is always **flag → env → config file → default**. Defaults: database `./mrplex.db`, no default repo (pass `-r`).

Persist defaults when you are tired of typing flags:

```bash
mrplex config set-database ./mrplex.db
mrplex config set-repo starship
mrplex config set-author "Brendan Baldwin <brendan@example.com>"
```

Or with env vars: `MRPLEX_DATABASE`, `MRPLEX_REPO`, `MRPLEX_AUTHOR`, `MRPLEX_EMBEDDER`.

## Development

```bash
npm install
npm link
npm test
npm run typecheck
npm run lint
npm run build

npm run seed -- --database ./mrplex.db
```

CI: typecheck + lint + tests on Ubuntu and macOS × Node 20 and 22, plus Postgres+pgvector parity. If `better-sqlite3` throws `NODE_MODULE_VERSION`, run `npm rebuild better-sqlite3`.

```bash
npm run pg:up
mrplex --database postgres://mrplex:mrplex@localhost:5432/mrplex serve --unsafe
```

## License

MIT — see [LICENSE](LICENSE).
