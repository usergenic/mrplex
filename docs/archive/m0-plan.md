# M0 Implementation Plan — Kernel + Skeleton

Target: milestone **M0** from [design.md §10](design.md): *Schema, SQLite storage, kernel reads (`repos.list`, `users.list`, `docs.get`, `docs.history`), `mrplex` CLI reading directly from the kernel. Slug/id split enforced.*

M0 is a **walking skeleton**: the thinnest vertical slice that proves the layering (CLI → kernel → storage adapter) and bakes the schema invariants in from day one. Everything after M0 adds surface area to a shape that already works end to end.

## 1. Scope

**In:**

- Full §3.2 schema + migrations (all tables, including `chunks` / `api_tokens` / `embedding_backlog`, even though M0 doesn't use them — the schema is small and freezing it now avoids migration churn in M1/M4).
- SQLite storage adapter: lifecycle, transactions, and the read methods — **plus the storage-level write primitives** (`version_insert`, `document_create`, `repos_create`, `users_create`), because tests and the seed script need to put data in. These are adapter methods, not kernel operations.
- Kernel read operations: `repos.list`, `repos.get`, `users.list`, `docs.get`, `docs.get_version`, `docs.history`, with the not-found error subset.
- Frontmatter utility: split raw file → `(frontmatter_raw, body)`, parse raw → JSON, re-join for output. Byte-exact round-trip (§3.2).
- CLI reads against a local SQLite file (in-process kernel; no `--server` until M3).
- Dev seed script (fixtures → database, via the adapter).
- Test foundation: schema-invariant tests + the kernel suite structured to run against any adapter (the §7.2.1 parity mechanism, with one adapter registered).
- CI: typecheck, lint, tests.

**Out (deliberately):** kernel write surface with `prev_version_id` enforcement and path/slug validation (M1), auth (M1), query/CEL/FTS (M2), HTTP surfaces (M3), embeddings (M4), Postgres (M5). The kernel write surface being absent is a feature of M0, not a gap — the seed script writes through the adapter so the M1 boundary stays clean.

## 2. Repo layout

```
src/
  kernel/           # operations, error catalog, wire types, slug↔id resolution
  storage/          # StorageAdapter interface — types only, no implementation
  storage-sqlite/   # the adapter; owns migrations/ (numbered .sql files)
  markdown/         # frontmatter split/parse/join
  cli/              # command tree, formatting, exit codes
scripts/
  seed.ts           # fixture loader (adapter-level writes)
fixtures/           # sample repo of .md files used by seed + tests
test/               # kernel suite (adapter-parameterized) + invariants
docs/               # design.md, this plan
```

**Tooling** (proposals; pin in WS1): Node LTS, pure ESM, TypeScript strict. `better-sqlite3` (synchronous API pairs naturally with `BEGIN IMMEDIATE`; note `node:sqlite` as a possible future swap). `yaml` for frontmatter parsing (we keep raw text ourselves, so the parser only feeds the JSON index). `vitest` for tests, `commander` for the CLI, Biome for lint/format, GitHub Actions for CI. No CEL/WASM toolchain yet — that arrives in M2.

## 3. Workstreams

### WS1 — Scaffold

`package.json`, `tsconfig`, lint/format config, vitest config, CI workflow (typecheck + lint + test on Linux and macOS), `README.md` stub with the quickstart that §7 of this plan promises. Acceptance: `npm test` runs an empty suite green in CI.

### WS2 — Schema + migrations

Translate §3.2 verbatim into `storage-sqlite/migrations/0001_init.sql`, including both partial unique indexes:

```sql
create unique index ... on versions (document_id) where next_id is null;
create unique index ... on versions (repo_id, path) where next_id is null;
```

Migration mechanism: numbered SQL files applied in order, tracked via `PRAGMA user_version`; `migrate()` idempotent and forward-only (§7.2.2 obligation 7). Acceptance: `migrate()` twice on a fresh file is a no-op the second time; the two indexes reject duplicates (proven in WS7, but wired here).

### WS3 — SQLite adapter

Implement the M0 subset of the §7.2.2 contract:

- `open(config)` / `close()` / `migrate()`
- `tx(fn)` — `BEGIN IMMEDIATE`, savepoints for nesting (obligation 3)
- `users_list` / `users_create` / `users_by_slug`; `repos_list` / `repos_create` / `repos_by_slug`
- `document_create(repo_id)`
- `version_insert({...})` — the hot path: insert + set `prev.next_id` in one transaction (obligation 1); relies on the WS2 indexes, never application checks (obligation 2)
- `version_by_id` / `version_current` / `version_history`

Acceptance: adapter-level tests pass, including the invariant tests in WS7.

### WS4 — Kernel reads

- Slug↔id resolution at the kernel boundary; integer ids never escape (§3.3).
- **`version_id` wire encoding** — decide and implement (see §6 below).
- Operations: `repos.list(include_system?)` (filters system-namespaced slugs by sigil prefix), `repos.get`, `users.list`, `docs.get`, `docs.get_version`, `docs.history(limit?, before?)`.
- Error catalog subset: `repo_not_found`, `user_not_found`, `doc_not_found`, `version_not_found` — as typed errors carrying `{ code, data }` per §4.3.
- `authorize(actor, action, target)` **stub**: allow-all, but called at every operation so M1 drops in without touching call sites. Kernel signatures take `actor` from day one.

Acceptance: kernel tests over seeded fixtures return correct Version envelopes (`frontmatter` + `frontmatter_raw` + `author` + chain ids).

### WS5 — Markdown/frontmatter utility

- `split(text) → { frontmatter_raw, body }` — leading `---` block extraction; absent block → empty raw.
- `parse(frontmatter_raw) → json` — YAML, must be a map or empty (§3.2, §4.3 `frontmatter_invalid` shape, even though the kernel doesn't emit it until M1).
- `join({ frontmatter_raw, body }) → text` — inverse of `split`.

Acceptance: property test — `join(split(x)) === x` byte-for-byte over the fixture corpus and generated cases (§3.2's round-trip guarantee, proven at the unit level before any surface depends on it).

### WS6 — CLI (reads)

- `mrplex repos list [--include-system]`, `mrplex users list`, `mrplex docs get <repo> <path>`, `mrplex docs get-version <repo> <version-id>`, `mrplex docs history <repo> <path> [--limit N] [--before <ts>]`
- Global: `--database` / `MRPLEX_DATABASE`, `--json`, exit-code families per §7.3 (1 validation, 4 not-found, 10 transport — others reserved).
- Output: pretty markdown (YAML block + body) for `docs get`; tables for lists; raw JSON under `--json`.
- Config file loading (`~/.config/mrplex/config.toml`) can stub to "not found is fine" — config *write* commands are M1+.

Acceptance: the quickstart transcript in §7 works against a seeded database.

### WS7 — Tests + CI wiring

- **Invariant tests** (adapter level): second current version for a document → constraint violation; second live document at a path → constraint violation; `version_insert` leaves no observable half-state (assert `prev.next_id` set within the same tx or not at all); history walks the chain in order.
- **Kernel suite** shaped as `runKernelSuite(adapterFactory)` — parameterized over adapters even though only SQLite registers in M0. This *is* the §7.2.1 parity mechanism; Postgres (M5) registers into it unchanged.
- Round-trip property tests from WS5.

### WS8 — Seed script

`scripts/seed.ts`: create a `system` user + `notes` repo, walk `fixtures/**/*.md`, `split` each file, insert via `document_create` + `version_insert`. Include at least one document with multiple versions (to exercise `docs history`) and one with no frontmatter. Doubles as the demo dataset.

## 4. Sequencing

```
WS1 ──► WS2 ──► WS3 ──► WS4 ──► WS6
                  │       ▲
                  ├──► WS8┘        (seed feeds CLI + kernel tests)
                  └──► WS7         (invariants start at WS3; kernel tests at WS4)
WS5 is independent after WS1; required by WS4/WS8.
```

Suggested order of attack: WS1 → WS2 → WS5 → WS3 (+invariant tests) → WS8 → WS4 (+kernel tests) → WS6 → polish/CI.

## 5. Design decisions to pin during M0

Deferred by design.md to implementation; decide once, record in the decision log (§9):

1. **`version_id` encoding.** Proposal: `v{integer id}` (e.g. `v45129`) — opaque by contract (§3.3: clients echo, never parse), and already the form design.md's deletion-path examples use. Trivially decodable is acceptable; the opacity claim is about client *contract*, not cryptography.
2. **Slug hygiene numbers** (§3.5.6 "max length, etc.") — proposal: ≤ 64 chars, no leading/trailing whitespace.
3. **Default database path** when `--database` and `MRPLEX_DATABASE` are absent — proposal: `./mrplex.db` (explicit beats hidden state in `~/.local`).
4. **npm package name** availability check (`mrplex`).

## 6. Definition of done

```bash
npm run seed -- --database ./demo.db
mrplex --database ./demo.db repos list
mrplex --database ./demo.db docs get notes welcome.md
mrplex --database ./demo.db docs history notes welcome.md
mrplex --database ./demo.db docs get notes welcome.md --json | jq .version_id
```

- All five commands behave per §6.1/§7.3, including pretty and `--json` output and correct exit codes on a missing repo/path.
- Invariant, kernel, and round-trip suites green in CI on Linux + macOS.
- README quickstart matches the transcript above.
- No kernel write surface exists (grep-provable: no `docs.put` outside the design doc).

## 7. Risks & watchouts

- **`better-sqlite3` native builds** — prebuilt binaries cover common platforms; CI on two OSes catches regressions early. Fallback documented: `node:sqlite`.
- **Scope creep into M1** — the tempting shortcut is "just add `docs.create` so the CLI can write." Don't; the seed script exists precisely so M0 ships without write semantics, validation, or auth half-done.
- **Adapter interface drift** — WS3 should implement against the `storage/` types exactly as §7.2.2 spells them, even where M0 only needs a subset; M5's Postgres adapter is the payoff.
- **ESM/CJS friction** — pure ESM from the first commit; retrofits are painful.
