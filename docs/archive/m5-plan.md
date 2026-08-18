# M5 — Postgres Backend: Implementation Plan

## Context

mrplex's design (docs/design.md §7.2) promises two v1 storage adapters — SQLite and Postgres+pgvector — held to semantic parity by a shared kernel test suite. M0–M4 shipped everything on SQLite; §10's last milestone is the one-line stub "M5 — Postgres backend." Branch `m5-postgres` is cut from main.

Exploration found the interface seam is real (`Storage` in [src/storage/types.ts](src/storage/types.ts), ~45 methods; `test/kernel-suite.ts` already parameterized over adapters), but three structural debts block a drop-in adapter:

1. **`Storage` and the kernel are synchronous** (built on better-sqlite3); every Node PG driver is async.
2. **The kernel emits SQLite SQL strings** — `compile-sqlite.ts` lives in `src/kernel/query/`, and `versions_search` receives raw `where_sql`/`where_params` (`?` placeholders), diverging from m2-plan.md:293's intended AST seam.
3. **Raw FTS5 syntax** flows from CLI/REST/MCP into `MATCH`; Postgres tsquery syntax differs.

User-confirmed scope decisions: **defer ANN indexes** (brute-force `<=>` in M5; per-model HNSW is a fast-follow), **defer SKIP LOCKED** (single-worker contract stands), **FTS syntax is adapter-owned** (parity narrows to a portable subset: bare terms + quoted phrases).

## Deliverables overview

The milestone lands as: (a) `docs/m5-plan.md` following the m0–m4 template, committed as the first commit of the PR branch (M3/M4 precedent); (b) the refactors + Postgres adapter; (c) design.md/README amendments. PR title convention: `M5: postgres backend (#N)`.

## Workstreams (attack order)

### WS0 — Write docs/m5-plan.md
Follow the exact m0–m4 skeleton (Target quote from §10 → §1 Scope In/Out → §2 Repo layout + runtime deps → §3 Workstreams with Acceptance lines → §4 Sequencing ASCII graph → §5 "Design decisions to pin… Record in the decision log (design.md §9)" → §6 Definition of done bash transcript → §7 Risks). Content = WS1–WS8 below.

### WS1 — Async `Storage` and async kernel (L, mechanical)
- [src/storage/types.ts](src/storage/types.ts): every method → `Promise<T>`; `tx<T>(fn: () => Promise<T>): Promise<T>`; `StorageAdapter.open(config): Promise<Storage>`.
- SQLite adapter stays sync internally; methods become `async` returning resolved values. `tx()` keeps `begin immediate` + savepoints — safe because kernel tx bodies only call storage (verify the three `storage.tx` sites in [src/kernel/kernel.ts](src/kernel/kernel.ts)); add a contract comment: never await foreign I/O inside `tx`.
- Kernel methods all become async; `resolveActor` ([src/kernel/auth/tokens.ts](src/kernel/auth/tokens.ts)) async; [src/client/local.ts](src/client/local.ts) drops its `Promise.resolve` shim; [src/embed/worker.ts](src/embed/worker.ts), [src/cli/bootstrap.ts](src/cli/bootstrap.ts), scripts/seed.ts await.
- Tests: `test/kernel-suite.ts` factory becomes async; ~25 direct-storage test files gain mechanical awaits. No assertion changes.
- **Acceptance:** full existing suite green on SQLite, zero behavioral diffs.

### WS2 — Structured search plan; compilation moves behind the adapter (M–L, delicate)
- New `src/storage/search-plan.ts`: `VersionsSearchInput` becomes `{ repo_ids, limit, text?, filter_ast? (parsed CEL), scope (glob-regex-source entries | allow_all | deny_all), sigil_groups, candidate_ids? }`. Kernel keeps glob→regex-source compilation (policy); regex→SQL is dialect.
- [src/kernel/query/query.ts](src/kernel/query/query.ts) sheds all SQL emission (scope CASE/regexp, sigil NOT LIKE, `sql:"0"` sentinels, rank `IN (?,…)`) — emits structured data instead. Kernel still parses CEL eagerly so `filter_invalid` surfaces before storage.
- Move [src/kernel/query/compile-sqlite.ts](src/kernel/query/compile-sqlite.ts) (+test) → `src/storage-sqlite/`; SQLite adapter's `versions_search` compiles the plan, preserving current SQL byte-for-byte where practical so the compile tests pass with import-path edits only.
- **Acceptance:** SQLite suite green; no SQL strings or storage-sqlite imports left in `src/kernel/`.

### WS3 — Embedding type fix: `Float32Array` in shared types (S)
- `ChunkRow.embedding: Float32Array | null`, `chunks_by_hash`, `ChunkUpsertInput` likewise; `Buffer` encode/decode becomes private to [src/storage-sqlite/vec.ts](src/storage-sqlite/vec.ts) (byte-identical on disk, no migration). Re-key the worker's reuse map.
- **Acceptance:** vec/worker/rank tests green; no `Buffer` in src/storage/types.ts or src/embed/worker.ts.

### WS4 — Postgres adapter core (L, highest risk)
New `src/storage-postgres/`:
- `migrations/0001_init.sql`: §3.2 schema in PG dialect — bigserial ids; ISO-8601 `text` timestamps (byte-exact round-trips beat timestamptz purism); `frontmatter jsonb` + single GIN (§5.2); `admin boolean` (adapter surfaces 0/1); the two partial unique indexes verbatim (`WHERE next_id IS NULL`); tsvector companion mirroring `fts_docs` (generated column + GIN, maintained in `version_insert`; `fts_index` stays a no-op); `chunks.embedding vector` (dimensionless); `CREATE EXTENSION IF NOT EXISTS vector`.
- `migrations/index.ts`: `schema_migrations` table + `pg_advisory_xact_lock`, forward-only, idempotent. Register dir in `scripts/copy-assets.mjs` and test/build-artifact.test.ts.
- `adapter.ts`: `pg.Pool`; int8 parser → JS number with `Number.isSafeInteger` guard (preserves `v{id}` ETags); `tx()` = `BEGIN ISOLATION LEVEL REPEATABLE READ`, client routed via `AsyncLocalStorage<PoolClient>`, retry ×3 with jitter on SQLSTATE 40001/40P01 (design.md:762's qualifying recipe); nested tx via savepoints; `version_insert` maps 23505 per-index to the same kernel conflict errors SQLite raises; `hydrateVersion` skips `JSON.parse` (jsonb arrives parsed).
- `errors.ts`: SQLSTATE map — 23505 → conflict, 2201B (bad regex) → `filter_invalid`, 40001/40P01 → retry-then-surface, else rethrow.
- Runtime dep: **`pg`** only (+`@types/pg` dev). Chosen over postgres.js: plain parameterized-query API matches compiled SQL, pure JS, ubiquitous.
- **Acceptance:** non-search kernel-suite methods pass on live PG; concurrent `version_insert` race resolved by the partial index; `migrate()` idempotent + lock-safe under parallel invocation.

### WS5 — `compile-postgres.ts` + PG search (L, high risk)
- CEL AST → PG SQL: `$n` placeholders with reuse (no param duplication); §5.2's exact jsonb translation (`frontmatter->'k' = '"x"'::jsonb OR frontmatter->'k' @> '["x"]'::jsonb`, one GIN serves both); `->>`+casts mirroring json_extract semantics (missing/null/type-mismatch parity — the shared suite is the referee); `~` for `matches()` and scope-glob regexes; `position()`/`LIKE ESCAPE` for contains/startsWith/endsWith; real booleans (never 1/0 predicates).
- `versions_search`: `next_id IS NULL AND repo_id = ANY($1)` + compiled plan; FTS via `websearch_to_tsquery('english', $n)` + `ts_rank` ordering (websearch never throws on user input).
- `vector_search`: `embedding <=> $n` filtered by model, ROW_NUMBER-per-version collapse (SQLite adapter already wrote this shape portably); score = cosine distance 0..2.
- **Acceptance:** `compile-postgres.test.ts` mirrors compile-sqlite.test.ts case-for-case; full kernel suite (query/scope/sigil/portable-FTS/rank) green on PG. Give the PG compile tests a small test-only exec hook instead of propagating the `(storage as any).db` hack.

### WS6 — Scheme registry + call-site wiring (S)
- New `src/storage/registry.ts`: `normalizeDatabaseUrl()` (single copy of the bare-path→`sqlite:` rule) + `openStorage(url)` dispatching `sqlite:`/`postgres:`/`postgresql:`, clean error on unknown scheme. Finally reads `StorageAdapter.scheme`.
- Convert the 7 call sites: [src/client/local.ts:40](src/client/local.ts:40), [src/server/serve.ts:73](src/server/serve.ts:73), [src/cli/bootstrap.ts:39](src/cli/bootstrap.ts:39), src/cli/main.ts:680/:710, scripts/seed.ts:58; delete the 3 duplicated normalizers (main.ts:96-99, serve.ts:57-60, seed.ts:24-25).
- **Acceptance:** `mrplex serve --database postgres://…` works; only the registry imports `sqliteAdapter` outside sqlite-internal code.

### WS7 — Tests + CI (M)
- `test/pg-harness.ts`: reads `MRPLEX_TEST_POSTGRES_URL`; schema-per-test (`mrplex_test_<random>`, `search_path=<schema>,public` so the `vector` type resolves), `migrate()` on open, drop-cascade on close.
- `test/kernel-postgres.test.ts`: `describe.skipIf(!env)` + `runKernelSuite({ name: "postgres", open })` — the promised ~12-line registration.
- Parity additions to kernel-suite.ts: portable-FTS cases (bare words, quoted phrase, stem-neutral fixtures), rank parity with deterministic stub vectors, partial-index race case. SQLite-only FTS5 syntax tests stay in test/fts.test.ts.
- `docker-compose.test.yml` with `pgvector/pgvector:pg17` (pinned) for local dev.
- CI: existing matrix untouched (PG skips); new `ci-postgres` job (ubuntu, Node 22, pgvector service container, env var set). The job must **fail loudly, not skip**, if env is set but DB unreachable.
- **Acceptance:** `npm test` without env = today's suite exactly (macOS-safe); with env = both adapters full suite; new CI job green.

### WS8 — Docs amendments (S)
- design.md: §7.2.2 signatures async + search-plan shape; :774 honest edit ("no kernel changes" now true *because* M5 moved the seams — note M5 was the one-time break); §7.2.1 new row "FTS query syntax: adapter-owned, portable subset = bare terms + quoted phrases"; §9 decision-log entries (async storage; AST/search-plan seam; adapter-owned FTS; dimensionless vector + brute-force, ANN deferred; Float32Array types; text timestamps/bigserial/boolean-admin; REPEATABLE READ + retry, `pg` driver, schema_migrations + advisory lock; SKIP LOCKED deferred); §10 M5 line expanded.
- Correct src/storage/types.ts:258 comment (ANN no longer "arrives with M5").
- README: `--database postgres://…`, docker-compose note, pgvector extension requirement, `sslmode` passthrough.

## Sequencing

```
WS0 plan doc ─► WS1 async ─► WS2 search-plan ─► WS4 PG core ─► WS5 compile-pg ─► WS7 tests/CI ─► WS8 docs
                     WS3 Float32Array ──┘ (before WS4 vec)      WS6 registry ──┘ (after adapter exists)
```

WS1–WS3 are pure refactors, each landed as an independent green commit verified by the existing SQLite suite before any PG code. Scaffold WS7's harness early inside WS4 so the adapter is developed suite-first.

## Verification

```bash
docker compose -f docker-compose.test.yml up -d
mrplex bootstrap --database postgres://mrplex:mrplex@localhost:5432/mrplex
npm run seed -- --database postgres://mrplex:mrplex@localhost:5432/mrplex
mrplex serve --database postgres://… --embed-cmd <stub> &
mrplex --server http://localhost:8080 query --repo notes --filter '"pricing" in list(tags)'
mrplex --server http://localhost:8080 query --text '"hello world"'   # portable FTS subset
mrplex --server http://localhost:8080 query --rank 'introduction'    # pgvector <=>
MRPLEX_TEST_POSTGRES_URL=postgres://… npm test    # both adapters, one suite
npm test                                          # no env: PG skips, all green (macOS parity)
```

Invariants: shared suite green on both adapters; partial unique indexes enforce one-current/one-live at the engine (race test); no `where_sql` anywhere; kernel imports nothing from storage-*; only new runtime dep is `pg`; no doc still claims sync Storage or "M5 needed no kernel changes".

## Key risks

- **Async tx discipline** — never await foreign I/O in a tx body; pin with comment + concurrency test.
- **RE2 (SQLite UDF) vs POSIX ARE (`~`) regex edge divergence** on user `matches()` patterns — kernel glob regexes use a safe subset; document, parity-test representatives, map 2201B → filter_invalid.
- **jsonb key-dedup/order normalization** vs SQLite text-JSON — frontmatter is a derived index (raw is source of truth); add a parity case.
- **Stemmer set-divergence** (porter vs english snowball) can change match *sets*, not just rank — stem-neutral fixtures; §7.2.2 #6 amended for the portable subset.
- **`pg` int8-as-string default** silently breaks ETags — lock with an adapter test.
- **`$n` numbering off-by-ones** in compile-postgres — mirror every compile-sqlite test case.
