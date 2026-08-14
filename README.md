# mrplex

*Markdown Repos, plexed.* A queryable, versioned store for Markdown documents with YAML frontmatter.

**Status:** M0 (walking skeleton) — schema, SQLite adapter, kernel reads, CLI. Writes and auth arrive with M1. See [docs/design.md](docs/design.md) for the full design and [docs/m0-plan.md](docs/m0-plan.md) for the milestone plan.

## Quickstart

```bash
npm install
npm run seed -- --database ./demo.db

npm run cli -- --database ./demo.db repos list
npm run cli -- --database ./demo.db users list
npm run cli -- --database ./demo.db docs get notes welcome.md
npm run cli -- --database ./demo.db docs history notes welcome.md
npm run cli -- --database ./demo.db --json docs get notes welcome.md | jq .version_id
```

The seed script populates a fresh SQLite database from `fixtures/notes/` — one user (`alice`), one repo (`notes`), three documents, four versions (welcome.md gets two revisions so `docs history` has something to show).

## What's in M0

- **Schema** — the full [design §3.2](docs/design.md) schema translated to SQLite. Both partial unique indexes (`(document_id) where next_id is null` and `(repo_id, path) where next_id is null`) are enforced by the storage engine, not application code.
- **SQLite storage adapter** — WAL + foreign_keys + busy_timeout; `tx()` uses `BEGIN IMMEDIATE` and nested tx via savepoints. `version_insert` advances the chain atomically (a three-statement dance keeps the "one current per document" partial index satisfied at every step).
- **Kernel reads** — `repos.list/get`, `users.list`, `docs.get`, `docs.get_version`, `docs.history`. Slug↔id resolution at the kernel boundary; opaque `v{integer}` version ids on the wire. `authorize()` is an allow-all stub called at every op so M1 auth drops in without touching call sites.
- **Frontmatter round-trip utility** — split/parse/join with a byte-exact `join(split(x)) === x` property test.
- **CLI reads** — `mrplex` with global `--database` / `--json`, pretty markdown output on `docs get`, tables elsewhere; kernel errors surface as `{code, data}` on stderr with per-family exit codes.
- **Adapter-parameterized kernel test suite** — the design §7.2.1 parity mechanism, ready for the Postgres adapter (M5) to register into unchanged.

Not in M0: the kernel write surface (`docs.create`/`put`/`delete`), auth, query/CEL/FTS, HTTP surfaces, embeddings, Postgres — see the [design](docs/design.md) roadmap.

## Development

```bash
npm test          # 64 tests (invariants, kernel suite, CLI smoke, frontmatter, migrations)
npm run typecheck # tsc --noEmit, strict
npm run lint      # biome check
npm run build     # emit dist/
```

CI runs typecheck + lint + tests on Ubuntu & macOS × Node 20 & 22.

## License

TBD.
