# M2 Implementation Plan — Query (CEL Filter + FTS)

Target: milestone **M2** from [design.md §10](design.md): *CEL filter + FTS; `kernel.query` end-to-end; CLI `query` command.*

M2 makes the versioned store **queryable**. M0 shipped point reads and history; M1 shipped writes and auth. M2 wires up the design's three-mode query surface (§5) — with two of the three modes live (**filter** via CEL, **text** via FTS); **rank** waits for M4's embedding worker. The kernel gets a single `kernel.query(spec, actor)` op that composes filter, text, scope-filter, default sigil exclusion, ordering, and limit; the CLI gets a `mrplex query` command.

## 1. Scope

**In:**

- CEL parser via **`cel-go` compiled to WASM** (design §7.1 decision). Pure parse/typecheck lives in the WASM module; TS owns the AST→SQL translation and everything that touches the database. The `$`-prefixed intrinsics (`$path`, `$created_at`) land via a minimal, vendored patch to the `cel-go` lexer (§5.1).
- CEL→SQL compiler for the **SQLite dialect** — the Postgres branch (§5.2 / §7.2 parity table) waits for M5's Postgres adapter.
- **FTS via SQLite FTS5**: an `fts_docs` external-content virtual table backed by `versions.body`, populated on every `version_insert` via the adapter's `fts_index` hook, queried by the adapter's `fts_search`.
- **`kernel.query(spec, actor)`**: composes `filter` (CEL), `text` (FTS), scope-filter (§8.2's implicit `read`-glob AND), and default sigil exclusion (§5.1 hidden/system) into one query. Ordering per §5.1 (FTS score when text present, else `$created_at desc`). `limit` from the spec.
- **Polymorphic frontmatter** via the `list(x)` CEL function (§5.2). SQLite branch: scalar equality OR `json_each` scan; expression index on the scalar branch.
- **Scope integration** (§8.2): `query` appends the token's `read` globs as an implicit path filter; results outside scope are silently dropped, not 403'd. Compiled to SQL — enforced in the adapter (§7.2.2 obligation #5) so the engine can push the filter into indexes.
- **CLI**: `mrplex query --repo <slug-or-glob> [--filter EXPR] [--text Q] [--limit N] [--include-hidden] [--include-system]` per §7.3.
- Design's `[OPEN]` **result-ordering pin** (§5.1) resolved: FTS score → `$created_at desc`; cursor pagination stays deferred.

**Out (deliberately):**

- **`rank` mode** (semantic search) — waits for M4 (embeddings). The QuerySpec accepts the field but returns `filter_invalid` in M2 with a clear "rank arrives in M4" message.
- **Postgres CEL→SQL branch** — M5. The compiler is structured so the second dialect is a swap-in.
- **HTTP surfaces** — M3.
- **`as_of` reads** — post-v1 (§11).
- **Cursor pagination** — `[OPEN]` in design; M2 ships `limit`-only per §5.1.
- **`filter_invalid` for undefined bindings during type check** — M2 checks name resolution (frontmatter field vs intrinsic) at compile time, but doesn't enforce a frontmatter schema (the design never says it should). Type mismatches (`tags == 42` when `tags` is a list) surface as false rows, not compile errors, matching CEL's `[dyn]` typing.
- **Multi-repo query hardening**: cross-repo queries work in M2 (the spec's `repo` accepts a glob per m1), but each repo's effective path config is evaluated independently for sigil exclusion (§3.5.5). No new work; just noting.

## 2. Repo layout — what M2 adds

```
tools/
  cel-wasm/
    go.mod                          # vendored cel-go with the $-lexer patch
    main.go                          # exposes parse() via WASM exports
    Makefile                         # `make build` → dist/cel.wasm
    patches/
      0001-lex-dollar-identifiers.patch   # minimal, versioned change
src/
  kernel/
    query/
      cel-wasm.ts                   # loads dist/cel.wasm, exposes parseCel(source)
      ast.ts                        # TS-side CEL AST types (mirrors cel-go's)
      compile.ts                    # AST → { sql, params } per dialect
      compile-sqlite.ts             # SQLite-specific translation (§5.2 SQLite branch)
      polymorphic.ts                # list() coercion + SQL emission
      intrinsics.ts                 # $-namespace binding: $path, $created_at
      scope-filter.ts               # append read globs as SQL path filter
      exclusion.ts                  # default hidden/system sigil clauses
      ordering.ts                   # rank → text-score → $created_at ordering
      query.ts                      # kernel.query implementation
  storage/
    types.ts                        # extend with QuerySpec + query adapter method
  storage-sqlite/
    adapter.ts                      # fts_index, fts_search, query implementations
    migrations/
      0003_fts_docs.sql             # create the FTS5 virtual table + triggers
dist/
  cel.wasm                          # built artifact — committed OR built in CI
test/
  query.test.ts                     # kernel.query end-to-end
  cel-compile.test.ts               # CEL AST → SQL compilation, per feature
scripts/
  build-cel-wasm.sh                 # invokes tools/cel-wasm/Makefile
```

**Tooling additions:**

- **Go toolchain in CI** — `actions/setup-go@v5` in the CI matrix, but only in a `build-artifacts` job that runs once and uploads `dist/cel.wasm`; test jobs consume the artifact so they don't need Go. Local dev either checks in `dist/cel.wasm` OR runs `scripts/build-cel-wasm.sh` on first `npm install` (`postinstall` script).
- **No new npm deps** at runtime — `WebAssembly` is a Node built-in. Dev-time only: nothing new; tests use vitest and better-sqlite3 exactly as they already do.

## 3. Workstreams

### WS1 — cel-go WASM artifact

Vendor `cel-go` into `tools/cel-wasm/`. Write the minimal lexer patch (`patches/0001-lex-dollar-identifiers.patch`) that admits `$` as an identifier head character (design §5.1 — grammar-not-policy). Ship `main.go` exposing a single `parse(source: string) → ast_json` function through WASM exports.

Concretely: `main.go` takes a UTF-8 string via WASM memory, runs cel-go's parser + type-checker, serializes the resulting AST (or the cel-go-generated protobuf) to JSON, writes it back to WASM memory, and returns the offset+length. TS reads that back into a JS object shaped like the CEL AST spec.

`Makefile`: `GOOS=wasip1 GOARCH=wasm go build -o ../../dist/cel.wasm ./main.go` (or `js/wasm` if Node's WASI support is inadequate — pick at implementation time).

Acceptance: `dist/cel.wasm` builds; loading it in a Node test shows a single `parse` export.

### WS2 — TS-side WASM loader + AST types

`src/kernel/query/cel-wasm.ts` — a one-shot module-level loader that reads `dist/cel.wasm` (via `readFile`), instantiates it once, and exports `parseCel(source: string): CelAst`. Errors from the parser (syntax or type-check) surface as `KernelError("filter_invalid", { source, error })`.

`src/kernel/query/ast.ts` — TS types for the CEL AST subset we handle: `Expr`, `Call`, `Ident`, `Const`, `Select`, `Comprehension`. Small; only what the SQL compiler traverses.

Acceptance: `parseCel('status == "draft"')` returns a shaped AST; malformed input returns `filter_invalid` with the parser's error message.

### WS3 — CEL AST → SQL compiler (SQLite dialect)

`compile-sqlite.ts` — the core translation. Supports:

- **Comparison operators**: `==`, `!=`, `<`, `<=`, `>`, `>=`
- **Logic**: `&&`, `||`, `!`
- **Membership**: `in` (with `list()` polymorphism — see WS4)
- **String functions**: `contains(haystack, needle)`, `startsWith`, `endsWith`, `size()`, `matches(re)` (`matches` compiles to SQLite's `REGEXP` — `[OPEN]` whether to require the regexp extension or ship a small user-function)
- **Comprehensions**: `.all`, `.exists`, `.exists_one`
- **Intrinsics**: `$path`, `$created_at` (see WS5)
- **Frontmatter access**: bare identifier → `json_extract(versions.frontmatter, '$."<name>"')`. The key is single-quoted verbatim; JSON path escaping handled per §5.2.

Output shape: `{ sql: string, params: SqliteValue[] }` — parameterized so nothing user-supplied is inlined into the SQL string. The compiler emits WHERE-clause fragments only; the query op wraps them.

Acceptance: table-driven tests over the design's examples (`§5.1`, `§5.2`) each produce compilable SQL that returns expected rows on a seeded database.

### WS4 — Polymorphic `list()` coercion (§5.2)

`polymorphic.ts` — when the compiler encounters `list(field)`, it emits the design's SQLite branch OR:

```sql
json_extract(versions.frontmatter, '$."tags"') = ?           -- scalar branch
OR EXISTS (SELECT 1 FROM json_each(versions.frontmatter, '$."tags"') WHERE value = ?)  -- list branch
```

The `list()` call itself doesn't materialize on the SQL side — it's a compile-time hint that the FOLLOWING expression should compile against both shapes. So `"pricing" in list(tags)` produces the OR above; `size(list(tags)) > 2` produces a `COALESCE(json_array_length(...), 1) > 2` shape when the underlying value could be scalar; and comprehensions (`list(tags).all(t, ...)`) compile to `NOT EXISTS (... WHERE NOT (predicate))` over `json_each`.

Missing key → both branches false → predicate false (§5.2 rule). Number/object at that key → both false. No runtime type-checking.

Acceptance: the design's four examples in §5.2 all produce SQL that returns the right rows on a corpus with mixed scalar/list frontmatter shapes.

### WS5 — Intrinsics (`$path`, `$created_at`)

`intrinsics.ts` — the `$`-prefixed identifier binding table. `$path` → `versions.path`; `$created_at` → `versions.created_at`. Compiler-time symbol table: on an unknown `$xxx` intrinsic, `filter_invalid` with a "no such intrinsic; did you mean $path?" message.

The `$` lexer patch from WS1 makes these parse; this workstream is just the symbol-to-column map + the "no such intrinsic" error path. Bare identifiers (no `$`) always route to `frontmatter->'<name>'` — never colliding with intrinsics (§5.1 design rationale).

Acceptance: `$path.startsWith("drafts/")` compiles to `versions.path LIKE 'drafts/%'`; `$created_at < '2026-06-01T00:00:00Z'` compiles to a plain range predicate; `$bogus == 1` returns `filter_invalid`.

### WS6 — FTS integration (SQLite FTS5)

Migration `0003_fts_docs.sql`:

```sql
CREATE VIRTUAL TABLE fts_docs USING fts5(
  body,
  content='versions',
  content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 1'
);

-- Triggers keep fts_docs in sync with versions. INSERT covers new writes;
-- DELETE covers repo/user deletion cascades if we ever get them.
CREATE TRIGGER fts_docs_ai AFTER INSERT ON versions BEGIN
  INSERT INTO fts_docs(rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER fts_docs_ad AFTER DELETE ON versions BEGIN
  INSERT INTO fts_docs(fts_docs, rowid, body) VALUES('delete', old.id, old.body);
END;
```

Note the design's "search indexes cover current versions only" (§5.1). The trigger-based population indexes every version. FTS_search filters to `next_id IS NULL` at query time — cheaper than trying to keep the FTS index only current-rows, and consistent with §7.2.2's obligation to keep FTS "result set portable."

Adapter methods:

- `fts_index(version_id, body)` — a no-op in SQLite (the trigger handles it). Kept for interface symmetry with a future engine that needs an explicit call.
- `fts_search(repo_ids, query)` — `SELECT rowid, bm25(fts_docs) as score FROM fts_docs WHERE fts_docs MATCH ? AND rowid IN (SELECT id FROM versions WHERE repo_id IN ... AND next_id IS NULL) ORDER BY score`.

Query syntax passed straight through to FTS5 — porter-stemmed English by default; users can escape with quoted phrases and use FTS5's `AND`/`OR`/`NOT` operators (§5.1's "pricing OR fees" example works). The stemmer is a `[OPEN]` per §5.1's parity table — different from PG's tsvector; ranking scores are not portable across adapters.

Acceptance: text-only queries return expected documents; text + filter compose via AND.

### WS7 — kernel.query end-to-end

`query.ts` — the orchestration layer:

1. Validate the QuerySpec shape; `filter_invalid` on unknown fields, `rank` present → `filter_invalid` with "rank arrives in M4".
2. Resolve the `repo` field (slug / glob / list / omitted) to a set of repo ids the caller can address (via the token's scopes — §8.2's `repos.list` filter shape).
3. For each repo id, load its effective path config for sigil exclusion.
4. Compile filter (if present) to `{ sql, params }` via WS3–5.
5. Build the base query: `SELECT versions.* FROM versions WHERE next_id IS NULL AND repo_id IN (...)`.
6. AND in the compiled filter.
7. AND in the default exclusion clauses per repo (§5.1) — one `NOT (path LIKE 'X%' OR path LIKE '%/X%')` per configured sigil, unless the corresponding `include_hidden` / `include_system` flag is true.
8. AND in the scope-glob path filter (§8.2 — silently dropped, not errored) — see `scope-filter.ts`.
9. If `text` is present: JOIN against `fts_search`, ordering by BM25.
10. Else order by `$created_at DESC` per the §5.1 pin.
11. Apply `limit`.
12. Return `Version[]`, wire-shaped.

The compiled SQL is parameterized end-to-end — no user input reaches the SQL string literally.

Acceptance: table-driven end-to-end tests over a seeded corpus covering: filter only, text only, filter + text, `list()` polymorphism (scalar + list frontmatter), scope enforcement dropping rows silently, sigil exclusion (default AND with flags), multi-repo query, `rank` field returning `filter_invalid`.

### WS8 — CLI `query` command

Extending `src/cli/main.ts`:

```
mrplex query [--repo <slug-or-glob>[,<slug-or-glob>...]]
             [--filter EXPR]
             [--text Q]
             [--limit N]
             [--include-hidden]
             [--include-system]
```

Repo argument omitted = every repo the token's scopes cover (per m1-plan §5.1 and design §5.1). Output: `--json` returns the full `Version[]`; pretty output is a small table (repo, path, version_id, author, created_at). No body in pretty mode — bodies are shown by `docs get`.

Acceptance: the CLI command works end-to-end against a seeded database, driven by the same M1 bootstrap flow tests. Filter parse errors surface as exit code 1 (validation family) with `filter_invalid` on stderr.

## 4. Sequencing

```
WS1 (cel-go WASM build) ──► WS2 (loader + AST types) ──► WS3 (AST → SQL)
                                                            │
                                                            ▼
                                                        WS4 (list())
                                                            │
                                                            ▼
                                                        WS5 (intrinsics)
                                                            │
WS6 (FTS migration + adapter methods) ─────────────────►    │
                                                            ▼
                                                        WS7 (kernel.query)
                                                            │
                                                            ▼
                                                        WS8 (CLI query)
```

Suggested attack order: **WS6 first** (FTS is smallest and independent; getting migration + trigger + adapter method landed early proves the storage plumbing without waiting on WASM). Then WS1 → WS2 → WS3 → WS4 → WS5 → WS7 → WS8.

## 5. Design decisions to pin during M2

Deferred by design.md to implementation; record in the decision log (§9):

1. **Result ordering when only `filter` is present.** Design §5.1 pinned "`$created_at desc`" — confirm and encode. This IS a pin, not a proposal. (Cursor pagination stays `[OPEN]`.)
2. **`rank` in M2**: returned as `filter_invalid` with a specific `reason` string. Alternative rejected: silent no-op (misleading), returning `null` for score (breaks type safety, promises future when M4 lands).
3. **`matches()` regex support**: proposal — ship a small user-defined SQLite function via `db.function("regexp", (pattern, input) => ...)` that uses Node's regex engine. Avoids the SQLite REGEXP extension setup, matches CEL's semantics, portable to Postgres (which has `~`) via the same compiler shape.
4. **CEL parser artifact distribution**: proposal — commit `dist/cel.wasm` to the repo (small, <1MB), rebuild in CI on tools/cel-wasm/** changes. Alternative: build in `postinstall` requires Go on every consumer's machine — bad tradeoff.
5. **FTS tokenizer**: proposal — `porter unicode61 remove_diacritics 1` per §5.1's "markdown is prose" intent. Portable enough; documented as SQLite-specific in §7.2 parity ("ranking scores not portable").
6. **`repo` polymorphism on the CLI**: comma-separated per WS8. Design §5.1 says "slug, glob, or list thereof"; slugs contain no comma (disallowed_chars), so this is unambiguous.
7. **What happens on `filter` with an unknown frontmatter key.** CEL's spec says missing map field is a runtime error; the design (§5.2 for `list()`) implies "missing key → false predicate" is what we want. Proposal: the compiler emits `json_extract(...) IS NOT NULL AND ...` guards around bare-field accesses, so missing keys silently fail the predicate rather than raising `filter_invalid`.

## 6. Definition of done

```bash
# Fresh db, bootstrap + seed as in M1.
rm -f ./m2.db
export TOK=$(npm run --silent cli -- --database ./m2.db bootstrap)
export MRPLEX_TOKEN=$TOK
npm run --silent seed -- --database ./m2.db

# Filter only
npm run --silent cli -- --database ./m2.db query --repo notes \
    --filter 'status == "published"'

# Text only
npm run --silent cli -- --database ./m2.db query --repo notes --text 'welcome OR intro'

# Filter + text composed
npm run --silent cli -- --database ./m2.db query --repo notes \
    --filter '"intro" in list(tags)' --text welcome

# Polymorphic frontmatter — a fixture with tags: pricing AND tags: [pricing, saas] both match
npm run --silent cli -- --database ./m2.db query --repo notes \
    --filter '"pricing" in list(tags)'

# Intrinsic access
npm run --silent cli -- --database ./m2.db query --repo notes \
    --filter '$path.startsWith("guides/")'

# Include hidden/system (usually hidden)
npm run --silent cli -- --database ./m2.db query --repo notes \
    --filter 'true' --include-system

# Scope enforcement — mint a narrow token, run same query, silent drop
NARROW=$(npm run --silent cli -- --database ./m2.db --json tokens create \
    --label narrow --scope 'notes:read=guides/**' | jq -r .token)
MRPLEX_TOKEN=$NARROW npm run --silent cli -- --database ./m2.db query \
    --repo notes --filter 'true'
# → only guides/** rows returned; no forbidden, no error

# rank returns filter_invalid
npm run --silent cli -- --database ./m2.db --json query --repo notes --rank 'anything'
# exit 1, stderr contains filter_invalid
```

- All commands behave per §5.1 and §7.3.
- Full test suite green on Ubuntu + macOS × Node 20 + 22.
- Every M1 boundary invariant still holds — grep-provably.
- No new NPM dependencies at runtime.

## 7. Risks & watchouts

- **Go toolchain in CI**. Adds a `build-artifacts` job to CI. Keep it in a separate job so test jobs stay fast; publish `dist/cel.wasm` as a CI artifact for downstream jobs. Local dev: check `dist/cel.wasm` into git; rebuild via `scripts/build-cel-wasm.sh` on demand.
- **WASM startup cost**. `WebAssembly.instantiate` runs once per Node process. Not a per-query cost; cache the instance at module scope. Should add microseconds, not milliseconds.
- **cel-go patch maintenance**. The lexer patch is small (one file, ~10 lines of added rules) and unlikely to conflict with upstream in the CEL grammar layer. Pin cel-go by commit hash in `go.mod`. When we bump, `git apply` the patch; if it fails, the build fails loudly.
- **FTS trigger correctness under `version_insert`'s three-statement dance**. The dance updates a row (temp self-loop), inserts a new row, and updates prev.next_id. The `AFTER INSERT` trigger fires once — on the new row. Good. The `AFTER UPDATE` trigger doesn't exist; we don't need one (body doesn't change on the placeholder update). Worth a regression test explicitly asserting fts_docs stays in sync.
- **`list()` compile-time hint scope**. It applies only to the immediately-enclosing expression — `"pricing" in list(tags)` compiles polymorphically, but `list(tags) == list(other)` doesn't (that's a list-equality comparison, not a `list()` hint). Document + test.
- **Scope-glob append**. The path-filter WHERE clause can get long for tokens with many read globs. Cheap; SQLite's query planner handles it. If it becomes hot, we can precompute a normalized regex per token and store on `api_tokens.scope_regex` — deferred.
- **Adapter parity for M5**: the query() adapter method takes an already-compiled AST. When M5's Postgres adapter lands, it re-uses WS3's compile.ts entry point but swaps in compile-postgres.ts. The AST format is the seam; keep it stable.
