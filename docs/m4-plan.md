# M4 Implementation Plan — Semantic (Chunking + Embeddings + Vector Search) + `docs.diff`

Target: milestone **M4** from [design.md §10](design.md): *Chunking + embeddings + vector search. Also picks up `docs.diff`, deferred from M3: the kernel op (§6.1), `/diff` route (§6.3), `docs_diff` tool (§6.2), CLI `docs diff` (§7.3).*

M4 makes the third query mode real. M2 shipped `filter` (CEL) and `text` (FTS) and left `rank` returning `filter_invalid` with a "deferred to M4" message; M3 passed that behavior through both HTTP surfaces unchanged. M4 builds the §5.3 pipeline behind it: a deterministic server-side **chunker**, the operator-supplied **embedding hook** (mrplex never calls a model provider itself), a **backlog worker** that embeds outside the write path, and **vector search** over `sqlite-vec` wired into `kernel.query` — completing §7.1's "surfaces + worker" process shape for `mrplex serve`. Alongside it lands `docs.diff`, the one piece of the v1 surface contract M3 deferred: a pure derived read, added across all four layers (kernel, REST, MCP, CLI) at once. The `chunks` and `embedding_backlog` tables have existed since M0 (`0001_init.sql`); M4 is the first code that writes them.

## 1. Scope

**In:**

- **Chunker** (§5.3): fixed, deterministic, server-side — the hook sees chunk text, never policy. Body-only (frontmatter is the structured/query side already). Splits on heading and blank-line block boundaries, greedy-packs blocks to a max chunk size, hard-splits oversized single blocks. Pure function of `body`; same input → same chunks, always (dedup depends on this).
- **Embedding hook contract** (§5.3): `embed(chunks: string[]) → { vectors: float[][], model: string, dim: int }`. Two of the three invocation shapes ship (resolving the §5.3 `[OPEN]`): **HTTP endpoint** (`--embed-url`, server POSTs `{ chunks }`) and **subprocess STDIO** (`--embed-cmd`, JSON-lines over stdin/stdout). In-process plugin deferred (see §5 decision 2).
- **Backlog worker** (§5.3): every committed `docs.create` / `docs.put` enqueues into `embedding_backlog`; a single in-process worker drains it — dequeue → skip if superseded (current-only) → chunk → **dedup by `(model, text_hash)`** against existing `chunks` rows → hook call for genuinely-new text only → `chunks_upsert`. Failures retain the row with `attempts`, `last_error`, exponential `next_retry_at`. Embedding failure never fails a write.
- **Vector storage + search**: `sqlite-vec` loaded into the existing better-sqlite3 connection; embeddings stored as float32 BLOBs in the existing `chunks.embedding` column; k-NN is a brute-force `ORDER BY vec_distance_cosine(...)` over current versions — exactly the "sqlite-vec is brute-force in v1" posture the §7.2.1 parity table already records.
- **`rank` in `kernel.query`** (§5.1): embed the rank string via the hook at query time, filter chunks to that response's `model`, intersect with `filter`/`text`/scope-globs/sigil-exclusion (all existing machinery — hidden/system exclusion applies uniformly per §5.1), order by best chunk score per document, current versions only. Result ordering precedence lands as designed: rank > text > `$created_at`.
- **Adapter surface** (§7.2.2): `chunks_upsert`, `vector_search`, and backlog methods (`backlog_enqueue`, `backlog_dequeue`, `backlog_retain`, `backlog_status`) added to the storage contract and the SQLite adapter.
- **CLI `embed` commands** (§7.3): `mrplex embed backfill --repo <slug>` (re-chunk + re-embed current versions missing chunks) and `mrplex embed status` (resolving its `[OPEN]` shape — see §5 decision 6).
- **Model changes** (§5.3): a hook response with a new `model` logs a warning and stores alongside old vectors (the `chunks.model` column keys both dedup and search); mixed-`dim` writes within one model are refused. Query-time model selection is implicit: chunks are filtered by the model the hook reports when embedding the rank string — no persisted "current model" state.
- **`docs.diff`**: `kernel.docs.diff(repo, path, from, to) → UnifiedDiff` (§6.1) — unified diff over the byte-exact serialized documents (via `frontmatter.join`, the single serializer). Emits `version_not_in_document` (reserved since M1, HTTP-mapped since M3) when either version doesn't belong to the document at `(repo, path)`. Surfaces: `GET /repos/{repo}/diff/{path}?from=&to=` (§6.3, joining the sibling roots), `docs_diff` MCP tool (§6.2 — tool count 20 → 21), `mrplex docs diff <repo> <path> --from <v> --to <v>` (§7.3), both local and `--server` modes.
- **`serve` integration** (§7.1): the worker starts inside `mrplex serve` when an embed hook is configured; graceful shutdown drains the in-flight batch. No hook configured → surfaces run exactly as in M3, worker idles off, `rank` returns `rank_unavailable` (§5 decision 4).

**Out (deliberately):**

- **In-process plugin hook** (§5.3 shape 3) — couples the plugin's dependency tree to the server process; the HTTP and subprocess shapes cover its use cases with a process boundary. Additive later.
- **Bundled no-op zero-vector hook** — the §5.3 `[OPEN]` leaned yes; M4 pins **no** (see §5 decision 4). A dev stub embedder ships as a script instead.
- **ANN indexes / tuning** — brute-force is the contract for SQLite in v1 (§7.2.1); HNSW/IVFFlat arrive with M5's pgvector adapter.
- **Historical vector search** — `rank` hits current versions only (§5.1); historical chunk rows persist for dedup but aren't searched. Time-machine search stays post-v1 (§11).
- **Rank scores on the wire** — the `Version` wire type (§6.4) carries no score field; ordering conveys rank. Adding a score envelope later is additive.
- **Multi-worker coordination** — §7.1: run a single embedding worker. `SELECT … FOR UPDATE SKIP LOCKED`-style claiming is an M5/Postgres concern; SQLite deployments are single-process by nature.
- **Merge helpers / block tree** — `docs.diff` is the read primitive; everything that consumes it for merging is post-v1 (§11).

## 2. Repo layout — what M4 adds

```
src/
  embed/
    hook.ts                         # EmbedHook interface + response validation (vectors/model/dim contract)
    http-hook.ts                    # --embed-url: fetch POST { chunks } → contract response
    cmd-hook.ts                     # --embed-cmd: long-lived subprocess, JSON-lines request/response
    chunker.ts                      # deterministic body → chunk[] (+ text_hash)
    chunker.test.ts
    worker.ts                       # backlog drain loop: dequeue → current-check → dedup → hook → upsert
    worker.test.ts
    backfill.ts                     # shared by `embed backfill` and worker bootstrap
  kernel/
    diff.ts                         # docs.diff: resolve versions, membership check, unified diff
    diff.test.ts
  storage-sqlite/
    vec.ts                          # sqlite-vec extension loading; float32 BLOB encode/decode
scripts/
  stub-embedder.mjs                 # dev/test stub: deterministic hash-projection vectors; --http PORT | --stdio
test/
  embed.test.ts                     # chunk/dedup/backlog/worker integration against a stub hook
  rank.test.ts                      # kernel.query rank: intersection, ordering, scopes, sigil exclusion
  diff.test.ts                      # docs.diff across kernel + REST + MCP + CLI
```

**Tooling additions (runtime deps):**

- **`sqlite-vec`** — the loadable extension the design pins for SQLite vector storage (§3.2, §7.2). Ships prebuilt binaries loaded via better-sqlite3's `loadExtension`; used here only for `vec_distance_cosine` over float32 BLOBs (no `vec0` virtual table in v1 — see §5 decision 3).
- **`diff`** (jsdiff) — unified-diff generation for `docs.diff`. Hand-rolling Myers diff is pure liability; the library is small, stable, and dependency-free.
- **No HTTP client dep** — the HTTP hook uses built-in `fetch` (Node ≥ 20).

## 3. Workstreams

### WS1 — Storage: vectors + backlog adapter surface

`src/storage-sqlite/vec.ts` loads `sqlite-vec` at `open()` and owns float32 `Float32Array` ⇄ BLOB conversion. Adapter methods added to `src/storage/types.ts` + `adapter.ts`:

- `chunks_upsert(version_id, chunks)` — replace-all per version (delete + insert in one tx); refuse mixed `dim` within a `model` (count a mismatched insert as a contract error, not a silent write).
- `chunks_by_hash(model, text_hashes)` — the dedup lookup: existing `(model, text_hash) → embedding` pairs (served by the `chunks_hash_model_idx` index from M0).
- `vector_search(repo_ids, model, embedding, k)` — brute-force k-NN joined to current versions (`next_id is null`), returning `{ version_id, chunk_ix, score }` per §7.2.2.
- `backlog_enqueue(version_id)` (upsert; resets `next_retry_at`), `backlog_dequeue(now, limit)` (due rows), `backlog_retain(version_id, attempts, error, next_retry_at)`, `backlog_delete(version_id)`, `backlog_status()`.

No schema migration expected — `chunks` and `embedding_backlog` have been in place since `0001_init.sql`; only code learns to use them. If `sqlite-vec` turns out to need any DDL, it lands as `0004_*.sql` under the existing idempotent-migration regime.

Acceptance: adapter round-trips a float32 vector byte-exactly; `vector_search` returns correct top-k on a hand-computed fixture; superseded versions never appear in results; mixed-dim upsert throws.

### WS2 — Chunker + hooks

`src/embed/chunker.ts`: split body into blocks at ATX headings and blank lines; greedy-pack consecutive blocks into chunks of at most **2,000 characters**; a single block over the cap hard-splits at the cap. `ix` is 0-based document order; `text_hash` is `sha256(text)` (same primitive as token hashing). Deterministic and total — empty body → zero chunks (a valid state: the doc simply never ranks).

`src/embed/hook.ts` defines the contract type and validates every response: `vectors.length === chunks.length`, every vector `length === dim`, non-empty `model`. Violation → the batch fails and retains in backlog (never partial-writes).

- `http-hook.ts`: `POST { chunks: string[] }` to `--embed-url`; JSON response per contract; per-request timeout.
- `cmd-hook.ts`: spawn `--embed-cmd` once, write one JSON line per batch, read one JSON line back; respawn on crash with backoff. Stderr passes through to the server log.

Batching, rate limiting, and provider retries live inside the hook implementation per §5.3 — the worker only paces dispatch.

Acceptance: chunker property tests (determinism, cap, ix contiguity, hash correctness); both hook shapes drive `scripts/stub-embedder.mjs` and return identical vectors for identical text; malformed responses (wrong count, ragged dims) reject cleanly.

### WS3 — Worker + enqueue + `embed` CLI

Enqueue: the kernel calls `backlog_enqueue(new_version_id)` after every committed `docs.create` / `docs.put` (deletes are puts; dedup makes their re-embed free since body is unchanged). Enqueue is unconditional — one cheap upsert — whether or not a hook is configured; `embed backfill` covers corpora written before a hook existed.

`src/embed/worker.ts` — the drain loop (single instance, in-process with `serve`):

1. `backlog_dequeue` due entries (small batch).
2. Skip any version no longer current (`next_id` set) — the superseding write enqueued its own entry; a save burst collapses to one pass over the final state (§5.3).
3. Chunk; look up `(model, text_hash)` reuse via `chunks_by_hash` — in the common case an edit touches one or two chunks and the rest reuse the previous version's vectors without a hook call.
4. Call the hook for the remainder; `chunks_upsert`; `backlog_delete`.
5. On failure: `backlog_retain` with incremented `attempts`, `last_error`, exponential backoff (base 30s, cap 1h).

A new-`model` response logs a warning once and proceeds (vectors stored under the new model alongside old ones, per §5.3).

CLI: `mrplex embed backfill --repo <slug>` enqueues every current version in the repo missing chunks and drains synchronously, printing progress to stderr; `mrplex embed status` prints backlog counts (pending / due / failing), oldest entry age, and the most recent `last_error`s, `--json` for scripting. Both require an embed hook configured except bare `status`. Hook configuration resolves uniformly for `serve` and embedded-CLI mode: `--embed-url` / `--embed-cmd` flags → `MRPLEX_EMBED_URL` / `MRPLEX_EMBED_CMD` env → CLI config file; the two are mutually exclusive (same rule as `--database`/`--server`, §5 decision 9 of the M3 plan).

Acceptance: a write with the worker running produces chunks with vectors; a burst of 10 puts to one doc calls the hook once (for the final state); an unreachable hook retains with backoff and `embed status` shows it; backfill embeds a pre-existing seeded corpus; hook recovery drains the backlog without intervention.

### WS4 — `rank` in `kernel.query`

Remove the M2 `filter_invalid` guard in `src/kernel/query/query.ts` and compile `rank`:

1. No hook configured → `rank_unavailable` (new kernel error; §5 decision 4). Hook configured but erroring/unreachable at query time → also `rank_unavailable` with the cause in `data` (a query can't run without embedding its input — unlike write-side failure, there is nothing to defer).
2. Embed the rank string (one-element batch); the response's `model` selects which chunk rows participate.
3. Compile to SQL joined with the existing pipeline: candidate rows still satisfy filter AST, FTS match, scope path-globs, and hidden/system sigil exclusion (§5.1 — uniform across all three modes); documents without chunks under the selected model are silently absent from `rank` results but still reachable via `filter`/`text` (§5.3).
4. Score = best (minimum cosine distance) chunk per document; order ascending; `limit` applies after intersection. Ordering precedence: rank > text > `$created_at` desc.

Surfaces need no route/tool changes — `rank` already passes through REST (`?rank=`), MCP (`query` tool), and CLI (`--rank`) since M2/M3; only the kernel behavior behind it changes, plus the `rank_unavailable` HTTP mapping (503) in `src/server/http-error.ts` and the stale "deferred to M4" strings in `src/mcp/tools.ts` / CLI help.

Acceptance: `rank.test.ts` seeds a corpus through the stub embedder and asserts: rank-only ordering matches hand-computed cosine distances; rank ∧ filter ∧ text intersects; out-of-scope and sigil-path docs never appear; unembedded docs appear in `filter` but not `rank`; no hook → `rank_unavailable` end-to-end (CLI exit code 1 family, REST 503, MCP in-band tool error).

### WS5 — `docs.diff` (kernel → REST → MCP → CLI)

`src/kernel/diff.ts`:

- Resolve `(repo, path)` to the live document (`doc_not_found` otherwise); resolve `from` and `to` (`version_not_found`); both must belong to that document → else `version_not_in_document` (§4.3, finally emitted).
- Read scope is checked against the lookup `path` **and** each version's own path (§8.2 — globs match the path at the version being accessed), so a doc renamed out of a caller's scope doesn't leak history through diff.
- Serialize both versions byte-exact via `frontmatter.join`, produce a unified diff (jsdiff `createTwoFilesPatch`) with headers `{path}@{version_id}` on each side. Identical versions (including `from === to`) → empty-hunk patch, not an error.
- Wire type `UnifiedDiff = { repo, path, from_version_id, to_version_id, patch }` (pinning the §6.4 shape left unelaborated in the design; §5 decision 8).

Surfaces:

- REST: `GET /repos/{repo}/diff/{path}?from=&to=` — sibling root beside `/versions` and `/history` per §6.3. `Accept: application/json` (default) → the envelope; `Accept: text/plain` → the raw patch body.
- MCP: `docs_diff(repo, path, from, to)` tool — 21st tool, schema + render like the rest.
- CLI: `mrplex docs diff <repo> <path> --from <v> --to <v>` — raw patch on stdout (pipe-friendly), `--json` for the envelope. Works over both `KernelClient` transports.

Acceptance: diff across a create → update → move chain shows content and (via headers) path changes; `version_not_in_document` maps to 422/tool-error/exit-1 across surfaces; text/plain patch applies cleanly with `patch -p0` against the serialized old version.

### WS6 — `serve` worker lifecycle

`src/server/serve.ts` grows the worker: constructed when an embed hook resolves at startup, started after migrations, stopped on SIGINT/SIGTERM after the in-flight batch settles (bounded drain timeout). Worker log lines go to stderr — `--mcp-stdio` stdout hygiene (M3) already covers this rule; the worker must not regress it. `serve` startup line reports the embed configuration (`embed: http://…`, `embed: cmd …`, or `embed: off`).

Acceptance: `serve --embed-url …` embeds writes arriving over REST and MCP; `serve` without embed config behaves byte-identically to M3 plus a `rank_unavailable` on rank queries; Ctrl-C during a hook call exits cleanly.

## 4. Sequencing

```
WS1 (storage: vec + backlog) ──► WS2 (chunker + hooks) ──► WS3 (worker + embed CLI) ──► WS4 (rank in query) ──► WS6 (serve lifecycle)

WS5 (docs.diff) ─── independent; any time
```

The semantic chain is strictly ordered — each workstream consumes the previous one's surface. **WS5 is fully parallel** to all of it (zero shared files beyond route/tool registries) and is a good first PR to land while WS1 is under review.

## 5. Design decisions to pin during M4

Record in the decision log (design.md §9):

1. **Hook shapes shipping in v1: HTTP endpoint + subprocess STDIO** (resolves the §5.3 `[OPEN]`). In-process plugin deferred — it couples plugin dependencies to the server process, and the subprocess shape gives local single-binary setups the same latency without that coupling.
2. **No bundled no-op hook** (resolves the §5.3 `[OPEN]`, superseding its "leaning yes"). Zero vectors don't just hide misconfiguration — they make every rank result a tie, which is garbage that *looks* like output. Instead: the server starts cleanly with embedding off, `rank` fails loudly (`rank_unavailable`), and `scripts/stub-embedder.mjs` (deterministic hash-projection vectors, both hook shapes) covers dev and test.
3. **Vectors live in `chunks.embedding` as float32 BLOBs; k-NN is brute-force `vec_distance_cosine`** — no `vec0` virtual table in v1. A shadow virtual table means a second store to keep in sync with the version chain; brute force over the current-version join is already the §7.2.1 contract for SQLite, and M5's pgvector adapter is where indexed ANN belongs.
4. **New kernel error `rank_unavailable` → HTTP 503.** Emitted when a rank query arrives with no hook configured or the hook fails at query time (`data` carries which). Distinct from `filter_invalid` (the query is well-formed) and from write-path embedding failure (which never errors — backlog absorbs it).
5. **Enqueue is unconditional; drain is conditional.** Every committed write upserts its backlog row whether or not a hook is configured — one cheap statement — so configuring a hook later starts from an honest queue. `embed backfill` remains the recovery path for corpora predating M4.
6. **`embed status` shape** (resolves the §5.3 `[OPEN]`): backlog counts (pending / due-now / failing i.e. `attempts > 0`), oldest entry age, distinct models present in `chunks`, and the most recent `last_error` values; `--json` emits the raw structure.
7. **Chunking policy v1: heading/blank-line blocks, greedy-packed to ≤ 2,000 chars, no overlap.** Deterministic and cheap; the constant is a code constant (not config) so `text_hash` dedup stays stable across restarts. Revisiting chunk size/overlap later only costs a backfill.
8. **`UnifiedDiff` wire shape:** `{ repo, path, from_version_id, to_version_id, patch }`, where `patch` is a standard unified diff over the byte-exact serialized documents with `{path}@{version_id}` headers. Diffing the serialized whole (frontmatter block + body) rather than fields separately keeps one canonical representation (§3.2) and makes the patch `patch(1)`-applicable.
9. **Query-time model selection is implicit in the hook response.** No persisted "current model" row: the model that embeds the rank string is the model searched. Swapping models is therefore: point the hook at the new model, run `embed backfill`, done — old vectors coexist until pruned.
10. **`docs.diff` read scope checks the lookup path and both version paths** (§8.2's "path at the version being accessed", applied to a two-version read).

## 6. Definition of done

```bash
# Fresh db, bootstrap + seed, stub embedder, serve with the worker on.
rm -f ./m4.db
export MRPLEX_TOKEN=$(npm run --silent cli -- --database ./m4.db bootstrap)
npm run --silent seed -- --database ./m4.db
node scripts/stub-embedder.mjs --http 8399 &
npm run --silent cli -- --database ./m4.db serve --port 8321 --embed-url http://127.0.0.1:8399 &

AUTH="Authorization: Bearer $MRPLEX_TOKEN"
BASE=http://127.0.0.1:8321

# Backfill the seeded corpus, inspect the backlog.
npm run --silent cli -- --server $BASE embed backfill --repo notes
npm run --silent cli -- --server $BASE embed status

# Semantic query — all three modes composed, over both transports.
npm run --silent cli -- --server $BASE query --repo notes --rank 'tiered SaaS pricing'
npm run --silent cli -- --server $BASE query --repo notes \
    --filter 'status == "published"' --text pricing --rank 'subscription fees'
curl -sf "$BASE/query?repo=notes&rank=tiered%20SaaS%20pricing" -H "$AUTH"

# docs.diff across the M1 lifecycle chain (create → update → move survive in one patch view).
npm run --silent cli -- --server $BASE docs history notes greetings/hi.md --limit 5
npm run --silent cli -- --server $BASE docs diff notes greetings/hi.md --from <v1> --to <v3>
curl -sf "$BASE/repos/notes/diff/greetings/hi.md?from=<v1>&to=<v3>" -H "$AUTH" -H 'Accept: text/plain'

# Failure honesty: no embedder → rank is a clean 503, filter/text unaffected.
kill %1   # stop the stub
curl -s -o /dev/null -w '%{http_code}' "$BASE/query?repo=notes&rank=x" -H "$AUTH"        # → 503
curl -sf "$BASE/query?repo=notes&filter=status%20%3D%3D%20%22published%22" -H "$AUTH"    # → 200
```

- Write-path invariant: with the stub down, `docs put` succeeds and `embed status` shows the retained backlog row; restarting the stub drains it without intervention.
- Dedup invariant: N rapid puts to one doc → one hook batch over the final state; an edit touching one chunk re-embeds one chunk.
- All 21 MCP tools listed with valid schemas; `docs_diff` and `rank` proven with the SDK client; `version_not_in_document` observed on the wire for the first time.
- Kernel error catalog and §6.3 mapping table updated (`rank_unavailable` → 503); design.md §9 gains this plan's decisions; §5.3's two `[OPEN]`s and the `UnifiedDiff` shape resolved in place.
- Full suite green on Ubuntu + macOS × Node 20 + 22 — including `sqlite-vec` extension loading on every matrix cell.
- Runtime deps added: `sqlite-vec`, `diff` — nothing else.

## 7. Risks & watchouts

- **`sqlite-vec` extension loading is the platform risk.** Prebuilt binaries must load via better-sqlite3's `loadExtension` on every CI cell (Ubuntu + macOS × Node 20 + 22, both arches). Prove it in WS1 before anything stacks on top; if a platform gap appears, the fallback is computing cosine distance in a registered JS UDF (same mechanism as the existing `regexp` UDF) — slower, semantically identical, and invisible above the adapter.
- **Sync storage, async hooks.** better-sqlite3 is synchronous; hook calls are not. Keep the boundary clean: the worker does async I/O (hook calls) strictly *between* synchronous storage transactions — never hold a write tx across an `await`. `chunks_upsert` is one atomic sync tx after the vectors arrive.
- **Query-time hook latency lands on the read path.** `rank` pays one embedding round-trip per query — fine for a local sidecar, noticeable for a remote API. Timeout must be tight (a few seconds) and produce `rank_unavailable`, not a hung request. Document the shape; don't cache rank-string embeddings in v1 (premature).
- **Dedup correctness is load-bearing for cost.** A `text_hash` mismatch bug silently re-embeds everything (expensive, invisible). The worker tests must assert *hook call counts*, not just resulting vectors.
- **Superseded-while-queued races.** The current-only check happens at dequeue, but a version can be superseded between dequeue and upsert. Harmless if `chunks_upsert` is keyed by `version_id` (stale vectors on a non-current version are never searched — `vector_search` joins `next_id is null`), but assert that in a test rather than assuming it.
- **Backlog growth when no hook is configured.** Decision 5 enqueues unconditionally; a hookless deployment accumulates one row per write (bounded by write count, upsert-deduped per version… but rows for superseded versions linger). Have the worker — or backfill — prune entries whose version is no longer current; `embed status` makes any leak visible.
- **Float32 round-tripping.** Vectors cross JSON (float64) → Float32Array → BLOB and back; distance comparisons in tests need an epsilon, and the stored form must be pinned little-endian float32 so a future non-JS reader agrees.
- **Diff on pathological inputs.** Huge bodies or binary-ish content make Myers diff slow; jsdiff is fine at markdown scale, but the REST route should still respect the server's existing payload posture — diff output size is bounded by input sizes, which are already capped at write time.
- **Stub embedder honesty.** The stub must exercise the real contract (batching, model/dim echo, both transports) — a stub that's friendlier than a real provider validates nothing. Give it flags to inject failures (`--fail-rate`, `--slow`) for the backoff tests.
- **Worker/stdio hygiene regression.** M3 pinned "stdout belongs to the protocol" for `--mcp-stdio`; the worker adds a new chatty component. Its logger goes to stderr unconditionally — add it to the existing stdio-hygiene test rather than trusting convention.
