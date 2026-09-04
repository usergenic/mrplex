![mrplex](https://i.imgur.com/C82h0Wg.jpeg)

# a plex of [m]arkdown [r]epos → mrplex

mrplex turns a folder of Markdown files into a queryable, versioned knowledge store — without taking your files hostage. Your notes stay ordinary `.md` on disk, readable and editable by any tool you already use. On top of that folder mrplex adds four things a plain directory can't give you:

- **Search** over your YAML frontmatter — filter with a small expression language, run full-text search across bodies, and (optionally) rank by meaning.
- **Versions** — every write is kept, so you can see history, diff two points, and never lose an overwrite to a race.
- **A link graph** that tracks how your documents connect and survives renames, so moving a file doesn't break the links pointing at it.
- **One model over three surfaces** — the same store is reachable from the CLI, from an MCP server, and over REST.

That last point is the reason mrplex exists: it gives an AI agent a way to *explore and maintain* a vault the way a person would — by asking precise questions and following relationships — instead of grepping around and guessing.

## Quickstart

Install it (Node 20.11 or newer):

```sh
$ npm install -g mrplex
```

Point it at a folder of Markdown and start asking questions:

```sh
$ mrplex repos create notes
created repo notes
$ mrplex config set-repo notes          # remember the default; no more -r on every command
config: repo set
$ mrplex sync ~/notes --once
sync notes @ ~/notes: through=v0 actions=128 feed=0
$ mrplex query --text 'that thing you half remember'
$path
---------------------------
projects/roadmap.md
meeting-notes/2026-08-12.md
```

That's the whole loop: create a repo, load a folder into it, then query. A repo is just a named collection of documents inside one database (which defaults to `./mrplex.db` — no configuration needed). Any folder of `.md` works, Obsidian vaults included.

`sync` is two-way. With `--once` it reconciles the folder and the store a single time and exits; drop the flag and it keeps running, watching for changes on both sides. To do that it records a little bookkeeping — two keys, `$version` and `$content_hash` — in each file's frontmatter. That's how a file on disk remembers which stored version it came from, so edits made outside mrplex are matched up correctly on the next sync.

## A guided tour: the USS Meridian

The repository ships a demo vault in `fixtures/starship/` — the crew, missions, logs, and equipment of a fictional survey starship, all short interlinked notes. It's the easiest way to see what the queries actually do.

First copy it out of the checkout and load it. (Copy rather than sync in place: `sync` writes those `$version` tracking keys into the files, and there's no reason to dirty the committed fixture.)

```sh
$ git clone https://github.com/usergenic/mrplex
$ cp -r mrplex/fixtures/starship .
$ mrplex repos create starship
created repo starship
$ mrplex config set-repo starship
config: repo set
$ mrplex sync starship --once
sync starship @ starship: through=v0 actions=30 feed=0
```

### Ask about your frontmatter

Filters are written in [CEL](https://cel.dev/) — a small, safe expression language — and evaluated against each document's frontmatter, plus a few built-in fields like `$path` and `$body`. So "what equipment is broken right now?" is a plain boolean expression over the `status` field. Use `-s` (repeatable) to choose which fields come back in the table:

```sh
$ mrplex query --filter 'status == "damaged" || status == "offline"' -s title -s status -s maintainer
title                         status   maintainer
----------------------------  -------  -------------------
Shuttle Corvid                offline  /crew/dax-thorne.md
Number Three Plasma Manifold  damaged  /crew/bexley-orr.md
```

### Ask about the links between documents

Some questions are about *relationships* rather than fields — "who reports to the captain?" The frontmatter in each crew file has a `reports_to` link, and mrplex indexes those into a graph you can query directly. `$has(target, field)` means "which documents link to `target` through `field`":

```sh
$ mrplex query --filter '$has("crew/kestrel-vance.md", "reports_to")'
$path
---------------------
crew/quill-vasquez.md
crew/dax-thorne.md
crew/aria-okonkwo.md
```

### Combine filters, text, and meaning

A filter, a full-text search, and a semantic search can all be given at once; results must satisfy all of them (they combine with AND). Here: log entries — `type == "log"` — that also mention "coolant":

```sh
$ mrplex query --filter 'type == "log"' --text 'coolant'
$path
---------------------
logs/orr-4413-1.md
logs/thorne-4413-2.md
```

By default a query returns just the paths of the matches. You then fetch the full content of only the documents you actually need. This keeps result sets small — which matters a lot when the thing running the query is an agent paying by the token.

### Rename a file without breaking its backlinks

This is the payoff of tracking links as a graph. mrplex ties each link to a document's *identity*, not to the path string someone typed. Rename a document and everything that pointed at it still points at it.

`docs mv` moves a document. The `--prev` flag is how mrplex prevents two writers from clobbering each other: you pass the version you're basing your change on, and the write is rejected if someone else moved first (more on that below).

```sh
$ V=$(mrplex --json docs get equipment/plasma-manifold-3.md | jq -r .version_id)
$ mrplex docs mv equipment/manifold-3.md --prev "$V"
v31
wrote starship/equipment/manifold-3.md @ v31 (author: mrplex)
```

Seven documents linked to the old path. Ask the graph who links to the *new* path, and all seven are already there — the relationships followed the document:

```sh
$ mrplex query --filter '$has("equipment/manifold-3.md")'
$path
---------------------------
missions/the-cinder-run.md
logs/thorne-4413-2.md
logs/orr-4420-1.md
logs/orr-4413-1.md
equipment/coolant-loop-b.md
crew/dax-thorne.md
crew/bexley-orr.md
```

The graph is correct, but the *link text* those files still contain on disk (`equipment/plasma-manifold-3.md`) is now out of date. `links stale` shows you exactly where, and `links repair` rewrites it for you:

```sh
$ mrplex links stale
crew/bexley-orr.md: "equipment/plasma-manifold-3.md" → "equipment/manifold-3.md"
crew/dax-thorne.md: "equipment/plasma-manifold-3.md" → "equipment/manifold-3.md"
equipment/coolant-loop-b.md: "equipment/plasma-manifold-3.md" → "equipment/manifold-3.md"
logs/orr-4413-1.md: "equipment/plasma-manifold-3.md" → "equipment/manifold-3.md"
logs/orr-4420-1.md: "equipment/plasma-manifold-3.md" → "equipment/manifold-3.md"
logs/thorne-4413-2.md: "equipment/plasma-manifold-3.md" → "equipment/manifold-3.md"
missions/the-cinder-run.md: "equipment/plasma-manifold-3.md" → "equipment/manifold-3.md"
$ mrplex links repair
repaired 7 doc(s), skipped 0
```

### Explore a neighborhood

`query` finds documents that match. `graph` shows you how a document connects — the links going out of it and coming into it, out to a chosen number of hops. `--render summary` prints it as an indented outline (`→` is a link out, `←` a link in, and the parenthetical is the field the link came from):

```sh
$ mrplex graph --roots equipment/manifold-3.md --degrees 1 --render summary
equipment/manifold-3.md (0)
  →($body) equipment/coolant-loop-b.md, missions/the-cinder-run.md
  →(maintainer) crew/bexley-orr.md
  →(related) equipment/coolant-loop-b.md
  ←($body) crew/bexley-orr.md, crew/dax-thorne.md, equipment/coolant-loop-b.md, logs/orr-4413-1.md, ...
... (each neighbor expands the same way, out to the requested degree)
```

Use `--render mermaid` instead to get a diagram you can paste into any Markdown renderer.

### Versions, always

Every write appends a new version rather than overwriting — so history is never lost. That's also what makes `--prev` work: it's *optimistic concurrency*. You tell a write which version you started from; if someone else has written in the meantime, yours is rejected and you're handed the current version to reconcile against, instead of silently clobbering their change. Deleting a document moves it aside to `:deleted/…` rather than erasing it, so a delete can be undone with an ordinary write. When you need the record, `docs history` lists a document's versions and `docs diff --from v1 --to v2` shows what changed.

## Connect an agent

The CLI, the MCP server, and the REST API are three doors into the same store. For a database only you touch, the quickest way to give an agent access is MCP over local stdio — for example, in a client's MCP configuration:

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

`--unsafe` runs the store with no authentication — every caller has full access. That's an acceptable choice for a private database file on your own machine, and the wrong choice for anything reachable over a network. The next section is what you use instead — when more than one principal is involved, or when you want to guard against a destructive agent mishap.

For **remote** clients that only speak HTTPS MCP (ChatGPT custom connectors, Grok, and similar), run `mrplex serve --policy` on a public host and point the connector at `/mcp`. Connectors that cannot set an `Authorization` header can put the API key in the URL instead: `https://host/k/<token>/mcp`. A full walkthrough — including a [zo.computer](https://www.zo.computer) Services setup — is in [docs/remote-http-mcp.md](docs/remote-http-mcp.md).

## Access control

When you need real principals — say, an agent that may read and write documents, plus a separate admin identity that can create and delete repos — mrplex generates a starter policy and signing keys for you, so there's no YAML to write by hand:

```sh
$ mrplex policy create policy.yaml --principal agent
wrote policy.yaml
$ mrplex key mint agent --policy policy.yaml     # a day-to-day key for the agent
$ mrplex serve --policy policy.yaml --audit audit.jsonl
```

`policy create` takes the filename to write and scaffolds two roles: a `maintainer` (the `--principal` you name) for everyday reads and writes, and an `operator` admin for repo management. `policy check` validates a policy and can print out exactly what a given principal is allowed to do.

You can enforce that policy in three arrangements: embedded in the server (`serve --policy`), in front of the stdio launcher (`mcp-stdio --policy`), or as a standalone proxy ahead of an existing engine (`proxy --policy --upstream`). Edit the file and send the server `SIGHUP` (`kill -HUP`) to reload it without downtime; `mrplex login` signs in through an OIDC device flow. Full details are in [docs/archive/security.md](docs/archive/security.md).

One rule worth repeating: never expose `serve --unsafe` to an untrusted network — it is, by definition, an open door.

## How it works

mrplex is built from a few concepts:

| Concept        | What it is                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------ |
| **Document**   | One Markdown file with YAML frontmatter, addressed by its path within a repo               |
| **Version**    | Every write appends a new one; `--prev` rejects a write based on a stale version           |
| **Query**      | A CEL filter over frontmatter and `$path` / `$body` / `$updated_at`, combined with full-text and semantic search |
| **Link graph** | Links from Markdown syntax, wikilinks, and frontmatter paths, tracked by identity so renames don't break them |
| **Graph walk** | A breadth-first tour of that link graph — *how* documents connect, not just which ones match |
| **Surfaces**   | The CLI, an MCP server, and a REST API, all over the same store                            |

Underneath, mrplex is two layers. The **kernel** is the store itself — documents, versions, queries, the graph — and it is full-trust: it has no notion of users, so whoever holds the database file holds everything. Around it is an optional **access-and-identity shell** that adds keys, OIDC, per-path permissions, and an audit log when you need them. The store runs on SQLite by default, or Postgres with pgvector when you want it; the same test suite runs against both, so behavior matches.

## Semantic search

mrplex never calls an embedding provider on its own — you decide what does the embedding by wiring in a hook. The companion package `@mrplex/embedder` runs a small local model on CPU, which is enough to get started:

```sh
$ npm install -g @mrplex/embedder
$ mrplex serve --unsafe --embedder mrplex-embedder
$ mrplex embed backfill                       # embed everything already in the repo
$ mrplex query --semantic 'distress beacon star map'
```

Point `--embedder` at a command (like the one above) or at an `http(s)://` URL for a remote embedding service. If no hook is configured, a semantic query returns a clear `semantic_unavailable` error rather than silently ranking by nothing. And treat semantic results as a shortlist of candidates worth reading, not a final answer — skim the top hits before you rely on them. The hook protocol is documented in [packages/embedder/README.md](packages/embedder/README.md).

## Configuration

Every setting resolves in the same order: a command-line **flag**, then an **environment variable**, then the **config file**, then a built-in default. Save the defaults you're tired of typing:

```sh
$ mrplex config set-database ./mrplex.db
$ mrplex config set-author "Ada Lovelace <ada@example.com>"
```

The matching environment variables are `MRPLEX_DATABASE`, `MRPLEX_REPO`, `MRPLEX_AUTHOR`, and `MRPLEX_EMBEDDER`.

A note on repo scope: your default repo (from `config set-repo` or `MRPLEX_REPO`) applies to every command, `query` included. To search more than one repo, say so on that command: `query -r` can be repeated and accepts glob patterns, and `-r '*'` searches every repo in the database. The wildcard only works as an explicit flag — a saved default can never quietly widen a search to your whole database.

## Development

```sh
$ npm install && npm link
$ npm test
$ npm run typecheck && npm run lint && npm run build
```

CI runs typecheck, lint, and tests on Ubuntu and macOS across Node 20 and 22, plus a Postgres + pgvector parity run (`npm run pg:up` starts a local instance). If `better-sqlite3` reports a `NODE_MODULE_VERSION` mismatch, rebuild it with `npm rebuild better-sqlite3`.

## License

MIT — see [LICENSE](LICENSE).
