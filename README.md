# mrplex

*Markdown Repos, plexed.*

mrplex is not a better notes app. It is a small kernel that leaves your files as files and makes the folder a multi-agent substrate.

You keep working with ordinary `.md` with YAML frontmatter. mrplex adds versions, optimistic concurrency, CEL filters, full-text search, optional embeddings, and a link graph bound to document identity so renames do not smash backlinks. CLI, MCP, and REST are the same model with different sockets.

If you wanted an Obsidian clone, this is the wrong repo.  If you're an Obsidian user, now your agents can utilize and manage your vault through mrplex's MCP interface.

## Install

Node ≥ 20.11:

```bash
npm install -g mrplex
```

`npx mrplex …` works. From a git checkout: `npm install && npm link`.

Point every command at a database and a default repo:

```bash
export MRPLEX_DATABASE=./demo.db
export MRPLEX_REPO=starship
```

Or persist it:

```bash
mrplex config set-database ./demo.db
mrplex config set-repo starship
```

Resolution is always **flag → env → config file → default**.

Local mode is full-trust. Whoever can run the binary owns the database. That is intentional.

## Five minutes on the USS Meridian

The fixture in `fixtures/starship/` is a starship knowledge base: crew, missions, logs, equipment. Ordinary Markdown. The product is the questions you can ask without opening every file.

```bash
git clone https://github.com/usergenic/mrplex
cd mrplex
npm install && npm link

export MRPLEX_DATABASE=./demo.db
export MRPLEX_REPO=starship

mrplex repos create starship
mrplex sync fixtures/starship --once -r starship
```

`sync` loads a folder, versions it, and keeps a cursor for two-way updates. Wikilinks, inline links, and frontmatter values written as repo-root paths (`/crew/foo.md`) are indexed automatically.

### Ask the folder like data

```bash
# What's broken?
mrplex query --filter 'status == "damaged" || status == "offline"'

# Who reports to the captain?
mrplex query --filter '$has("crew/kestrel-vance.md", "reports_to")'

# Filter AND full-text
mrplex query --filter 'type == "mission"' --text 'Halloway'
```

`query` returns lean hits. Default projection is paths, not bodies. Hydrate what you need. That is how an agent stays cheap.

Filter, text, and semantic compose with AND. Semantic rank is a shortlist, not an oracle. Inspect the top hits; do not treat cosine as authority.

### Follow the graph

Links live on document identity, not on the string you typed. Move a file and the graph still knows who pointed at it. The written text may go stale; the relation does not.

```bash
# Everything a map-of-content claims
mrplex query --filter '$in("moc/missions.md")'

# What touches the damaged manifold?
mrplex query --filter '$has("equipment/plasma-manifold-3.md")'

# Neighborhood, not a file listing
mrplex graph --roots missions/the-hollow-signal.md --degrees 2 --direction both --render summary
mrplex graph --roots crew/kestrel-vance.md --degrees 2 --direction out --render mermaid
```

### Write without clobbering

Every write inserts a version. `prev_version_id` is optimistic concurrency. Stale prev loses; the current version comes back. Delete is a move to `:deleted/…`. Restore is a normal put.

```bash
V=$(mrplex --json docs get equipment/plasma-manifold-3.md | jq -r .version_id)
mrplex docs mv equipment/manifold-3.md --prev "$V"

mrplex query --filter '$has("equipment/manifold-3.md")'
mrplex links stale

mrplex docs history equipment/manifold-3.md
mrplex docs diff equipment/manifold-3.md --from v1 --to v2
```

## Connect an agent

CLI, MCP, and REST are surfaces over one kernel. Local stdio is the right first attachment:

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

`--unsafe` means full-trust kernel: no auth in-process. That is correct for a database only you can touch. It is not a networked default.

The questions that justify the extra process are relational: *what is broken, who maintains it, which missions were hit?* Query and graph first. `docs get` / `docs_get_many` only for the hits you will actually use.

## Networked use: policy first

`serve` requires an explicit trust posture. For anything that binds a port other people can reach, use the authenticating shell.

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
      - sha256:...        # mrplex key mint brendan --policy policy.yaml
  ann:
    roles: [editor]
    oidc: { email: ann@example.com }
```

```bash
mrplex key mint brendan --policy policy.yaml
mrplex serve --policy policy.yaml --audit audit.jsonl --port 8321 &
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:8321/repos
```

Three shapes: **embedded** (`serve --policy`), **launcher** (`mcp-stdio --policy`), **fronting proxy** (`proxy --policy --upstream`). Edit the policy and `kill -HUP` to reload. OIDC device flow via `mrplex login`. Details in [docs/archive/security.md](docs/archive/security.md).

Local HTTP against a private database:

```bash
mrplex serve --unsafe --port 8321 &
mrplex --server http://127.0.0.1:8321 query --filter 'status == "missing"'
```

Never expose `serve --unsafe` to an untrusted network. The flag is loud on purpose. Do not copy the MCP snippet above onto a shared host and call it done.

## How it works

| Piece          | Job                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------- |
| **Document**   | One Markdown file with YAML frontmatter, addressed by repo-relative path                 |
| **Version**    | Every write appends. `prev_version_id` rejects stale writers                             |
| **Query**      | CEL over frontmatter + `$path` / `$body` / `$updated_at`; AND with FTS and semantic      |
| **Link graph** | Derived from inline links, wikilinks, and frontmatter repo-root paths. Bound to identity |
| **Graph**      | BFS neighborhood. *How* things connect, not only *which* match                           |
| **Surfaces**   | CLI (`--database` or `--server`), MCP (`/mcp` or `mcp-stdio`), REST                      |

Two layers: a **full-trust kernel** and an optional **access-and-identity shell** (keys, OIDC, per-path grants, audit). The kernel does not pretend to be a user system.

What ships today:

- Versioned Markdown store; byte-exact `frontmatter_raw` or structured `frontmatter`
- Optimistic concurrency; delete-as-move; unified diff
- CEL + `list()` for scalar-or-list fields; `$in` / `$has` / `$backlinks` / `$links` (membership is a filter, not a separate CLI flag)
- FTS5 or Postgres `websearch_to_tsquery`
- Pluggable embedder; no hook → `semantic_unavailable` instead of silent junk vectors
- SQLite default or Postgres+pgvector; same kernel suite on both
- NFC + case-insensitive identity, case-preserved storage


## Embeddings

mrplex never calls an embedding vendor. Wire a hook.

```bash
npm install -g @mrplex/embedder
export MRPLEX_EMBEDDER=mrplex-embedder

mrplex serve --unsafe --embedder mrplex-embedder
mrplex embed backfill -r starship
mrplex query -r starship --semantic 'distress beacon star map'
```

Resolution: **flag → `MRPLEX_EMBEDDER` → config → unset**. With `--server`, configure the embedder on the host. Protocol: [packages/embedder/README.md](packages/embedder/README.md).

Use semantic search to generate candidates. Then filter, hydrate, and read. Rank without inspection is how agents launder a guess into a citation.

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
export MRPLEX_DATABASE=postgres://mrplex:mrplex@localhost:5432/mrplex
mrplex serve --unsafe
```

## License

MIT — see [LICENSE](LICENSE).

