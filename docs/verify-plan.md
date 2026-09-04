# Verify Implementation Plan — `mrplex verify`, an integrity scrub over the store

Target: the **`mrplex verify`** bullet in [design.md §11](archive/design.md) ("Future work"):

> **`mrplex verify`.** Integrity scrub over the version chain: walk each document oldest-to-newest, recompute body/frontmatter hashes, confirm `frontmatter_raw` ↔ `frontmatter` round-trips byte-exact (§3.2), check `prev_id`/`next_id` symmetry, verify FTS/chunk/link derived tables against their source versions, report orphans. No writes. CLI + kernel op + optional CI mode that exits non-zero on any inconsistency. Cheap insurance for an append-only store where the chain *is* the guarantee.

In an append-only store the version chain **is** the source of truth, and every other table (`fts_docs`, `chunks`, `embedding_backlog`, `links`) is a derived index that can silently drift out of agreement with it — a bad migration, a hand-edited DB, a bug in in-tx maintenance, a partial crash. Nothing today detects that drift. `verify` is mrplex's `git fsck`: a read-only scan that re-derives what should be derivable and diffs it against what's stored, plus a set of structural-invariant checks that the partial indexes (§3.2) are *supposed* to make impossible but which a corrupted database can still violate.

The logic mostly exists already, scattered: `test/invariants.test.ts` asserts the index invariants at the storage layer; `contentHash` (`src/markdown/content-hash.ts`) and `extractEdges` (`src/links/extract.ts`) are the pure re-derivation functions; `split`/`join` (`src/markdown/frontmatter.ts`) drive the round-trip. `verify` is chiefly **wiring these into a runtime kernel op + CLI command**, held to SQLite/Postgres parity by the shared kernel suite (§7.2).

Branch `verify` is cut from `main`.

## 1. Scope

**In:**

- **`kernel.verify(ctx, spec)`** — a new read-only kernel op returning a structured `VerifyReport` (findings + counts), never throwing on inconsistency (a finding is data, not an error). Kernel-level so all three surfaces reach it; CLI is the primary consumer.
- **Six check families** (§2), each independently toggleable, each emitting `Finding` rows with a stable `check` code, severity, the offending `version_id`/`document_id`/`path`, and a `detail` payload.
- **A read-only adapter surface** (§4) — new `Storage` methods that stream rows for scanning (whole version chains, derived-table membership) without materializing the corpus. Keyset-paginated, id-ordered, on both adapters.
- **`mrplex verify` CLI** (§5) — human table + `--json` structured output; `--ci` exits non-zero on any finding at or above a threshold severity; `--repo`, `--check`, `--severity` filters.
- **Scope-respecting.** Like every read op, `verify` narrows to the caller's read claims (§8.2): a scoped caller verifies only the slice it can read. `--unsafe` / full-trust verifies everything. (§2.7 covers the one wrinkle: derived-table orphans that reference *unreadable* versions.)
- **SQLite + Postgres parity.** Same findings on the same corrupted fixture across both engines; enforced by the shared kernel suite.

**Out (deliberately):**

- **Repair.** `verify` never writes. Fixing what it finds is a separate concern: derived-index drift is repaired by the existing backfills (`mrplex links backfill`, `mrplex embed backfill`, `mrplex hash backfill`); structural chain corruption is not auto-repairable and warrants a human (or a future `mrplex repair` that re-ingests into a fresh DB). The plan defines a **`suggested_fix` hint** per finding (§3) so the report *points at* the remedy without performing it.
- **Cross-repo / cross-database checks.** Links are repo-local (§11.2); `verify` is too. Comparing two databases (e.g. a Postgres follower vs. its primary) is a replication concern, not this.
- **Semantic/vector *quality* checks.** `verify` confirms a chunk row's *existence and provenance* (belongs to a live version, model recorded), not that the embedding vector is "good." Vector correctness isn't checkable without re-running the hook, and the hook is non-deterministic across models.
- **Filesystem/sync-state checks.** The sync daemon's on-disk `$version`/`$content_hash` provenance and cursor files are a client concern (§4 sync), not store integrity. A future `mrplex sync verify` could diff a vault against the store; out of scope here.
- **Performance guarantees on pathological chains.** `verify` is O(total versions) — it walks history, unlike everything else in the read path which is O(live set). This is inherent (see §6) and documented, not optimized away in v1.

## 2. The six check families

Each family has a stable `check` code (the string clients discriminate on) and a default severity. Severity is one of `error` (a real inconsistency — the store is lying) or `warn` (suspicious but possibly benign — e.g. a legacy row a backfill would fix). A `--ci` run fails on `error` by default; `--severity warn` lowers the bar.

### 2.1 `chain` — version-chain structural integrity

Per document, walk `version_history` oldest→newest and confirm the doubly-linked `prev_id`/`next_id` chain is well-formed (design §3.2: *"writing a new version Y with `prev_id = X` also sets `X.next_id = Y` in the same transaction"*). This is the family that catches what the partial indexes can't (a directly-corrupted DB, an FK left dangling by a bad migration).

| `check` code | Severity | Condition |
|---|---|---|
| `chain.prev_next_asymmetry` | error | `X.next_id = Y` but `Y.prev_id ≠ X` (or vice-versa) — the inverse-link invariant broke. |
| `chain.multiple_current` | error | A document has >1 version with `next_id IS NULL`. The partial unique index (§3.2) should forbid this; a finding means the index is missing/corrupt. |
| `chain.no_current` | error | A document has ≥1 version but none with `next_id IS NULL` — a headless chain. |
| `chain.broken_prev` | error | A non-root version's `prev_id` points at a nonexistent version, or one in a different document. |
| `chain.cycle` | error | The `prev_id` walk revisits a version — a loop, not a chain. |
| `chain.repo_mismatch` | error | A version's `repo_id` disagrees with its document's `repo_id` (the denormalized column §3.2 drifted). |
| `chain.orphan_document` | warn | A `documents` row with zero versions. Benign-ish (invisible to every query) but shouldn't exist. |
| `chain.multiple_live_at_path` | error | Two live versions share `(repo_id, path_norm)` — the second partial unique index (§3.2) broke. |

### 2.2 `hash` — content-fingerprint fidelity

Recompute `contentHash(frontmatter_raw, body)` (`src/markdown/content-hash.ts`) for every version and compare to the stored `content_hash` column. This is the fingerprint sync relies on (`$content_hash` clean-state detection) — a mismatch means an outside writer or a bug corrupted it.

| `check` code | Severity | Condition |
|---|---|---|
| `hash.mismatch` | error | Stored `content_hash ≠` recomputed. `detail: { stored, computed }`. |
| `hash.missing` | warn | `content_hash IS NULL` on a row written before migration 0002 (§2.6). `suggested_fix: "mrplex hash backfill"`. |

Only the two families that check *stored derived scalars* (`hash`, and `links` resolution) need to re-run pure functions; both are cheap CPU.

### 2.3 `frontmatter` — raw ↔ parsed round-trip

Design §3.2 stores frontmatter twice by design: `frontmatter_raw` (byte-verbatim YAML) and `frontmatter` (parsed JSON, the query index). `verify` re-parses `frontmatter_raw` and confirms it still yields the stored `frontmatter` JSON — catching a YAML-parser upgrade that changed semantics, or a write that let the two diverge.

| `check` code | Severity | Condition |
|---|---|---|
| `frontmatter.parse_error` | error | Stored `frontmatter_raw` no longer parses as YAML at all. |
| `frontmatter.divergence` | error | Re-parsed raw ≠ stored `frontmatter` JSON (deep-equal). `detail: { keys_differing }`. |
| `frontmatter.system_leak` | error | A `$`-prefixed key is present in stored `frontmatter_raw`/`frontmatter` — `$*` intrinsics must be stripped at write time (`canonicalizeFrontmatter`) and never persisted (sync/history §2.4). A leak corrupts `$content_hash` and re-injection. |

### 2.4 `fts` — full-text index membership

The FTS index (`fts_docs`, external-content mode, trigger-maintained — `migrations/0003_fts_docs.sql`) must cover **exactly the current versions' bodies**: one FTS row per live version, none for superseded/deleted-out-of-namespace versions, none orphaned.

| `check` code | Severity | Condition |
|---|---|---|
| `fts.missing` | error | A live version has no FTS row. `suggested_fix: "rebuild FTS (reindex)"`. |
| `fts.orphan` | error | An FTS row references a version that isn't live (or doesn't exist). |

`fts.missing` / `fts.orphan` need only id-set membership (which live versions have/lack an FTS row), so they hold at full SQLite/Postgres parity. A body-content freshness check (`fts.stale_body` — "the indexed text matches the live body") is **deliberately not in v1**: SQLite's FTS5 runs in external-content mode and doesn't store the body redundantly (the `versions` table is the content source), so there's no cheap way to compare stored FTS text on SQLite, and a parity-breaking Postgres-only check isn't worth it here. Deferred; additive if a cheap path appears.

### 2.5 `chunks` — embedding provenance

Chunks + the embedding backlog (§5.3). `verify` checks *structural* consistency, not vector quality (§1 Out):

| `check` code | Severity | Condition |
|---|---|---|
| `chunks.orphan` | error | A `chunks` row references a non-live or nonexistent version. |
| `chunks.backlog_orphan` | error | An `embedding_backlog` row references a nonexistent version. |
| `chunks.unembedded` | warn | A live version has neither chunk rows nor a backlog entry — it fell out of the embedding pipeline. `suggested_fix: "mrplex embed backfill"`. **Only runs when an embedder is configured** (see below); otherwise skipped entirely, not reported clean. |
| `chunks.mixed_dim` | error | Chunk rows for one version carry vectors of differing dimensionality (§5.3 "refuse mixed-dim writes" — a finding means that guard was bypassed). |

**Embedder-gated coverage.** `chunks.unembedded` is meaningful only when embedding is actually intended for this store. A corpus that never configured an embedder has *every* live version "unembedded" — that's noise, not a finding. The check therefore runs **only when an embedder is configured**, resolved through the standard precedence (flag → `MRPLEX_EMBEDDER` env → config `embedder` → none; the §"Configuration" resolution the whole CLI already uses). No embedder configured ⇒ `chunks.unembedded` is *skipped* (the report notes it was skipped for lack of an embedder — not silently omitted, not reported clean). The orphan/provenance checks (`chunks.orphan`, `chunks.backlog_orphan`, `chunks.mixed_dim`) are unconditional: stray chunk rows referencing dead versions are a real inconsistency whether or not an embedder is *currently* wired up (they'd be residue from a past one).

### 2.6 `links` — link index vs. re-extraction

Re-run `extractEdges({ body, frontmatter, config })` (`src/links/extract.ts`) for each live version under the repo's **effective link-config** (`effectiveLinkConfig`, §11.2 cascade) and diff the resolved edge set against the stored `links` rows. Then check resolution correctness against the live path set — the class of bug that would make `graph` / `$backlinks()` quietly wrong.

| `check` code | Severity | Condition |
|---|---|---|
| `links.set_mismatch` | error | Re-extracted `(ord, field, target_raw)` set ≠ stored rows for the source. `detail: { missing, extra }`. In-tx maintenance drifted from extraction. |
| `links.misresolved_dangling` | error | An edge is `target_id IS NULL` but a live document *does* exist at its folded `target_norm` — a dangler that should have bound (missed `links_resolve_dangling`). |
| `links.misresolved_bound` | error | An edge's `target_id` points at a document whose current path's fold ≠ the edge's `target_norm`, **or** at a nonexistent/non-live document. Identity binding went stale in a way renames alone can't explain. |
| `links.self_link` | warn | `source_id == target_id` — excluded by construction (§11.2 `source_id <> document_id`); a finding means one slipped in. |
| `links.deleted_source_has_outbound` | error | A document currently in the system namespace (`:deleted/…`) still has outbound `links` rows — `docs.delete` should `links_clear` them (§11.2). |

### 2.7 Scope interaction (all families)

`verify` respects read scope (§8.2), which creates one honest subtlety: a **derived-table orphan** (`fts.orphan`, `chunks.orphan`, `links.misresolved_bound`) may reference a version the caller *can't read*. Rule: a scoped caller sees an orphan finding only when it can read the referenced version; otherwise the row is silently dropped (same posture as `links.stale`, kernel.ts:753 — *"surface a stale link only when the caller can read both endpoints"*). The finding is still discoverable by a full-trust (`--unsafe`) verify, which is the intended operator context for integrity scrubs anyway. Document this so a scoped `verify` reporting "clean" is understood as "clean within your scope," not "clean globally."

## 3. Report shape (wire types)

New in `src/kernel/wire.ts`:

```ts
export type VerifySeverity = "error" | "warn";

export type VerifyFinding = {
  check: string;              // stable code, e.g. "chain.prev_next_asymmetry"
  severity: VerifySeverity;
  repo: string;               // slug
  document_id?: string;       // opaque, when the finding is doc-scoped
  version_id?: string;        // opaque, when version-scoped
  path?: string;              // the offending version's path, when known
  detail: Record<string, unknown>;   // check-specific payload (stored vs computed, etc.)
  suggested_fix?: string;     // human hint, e.g. "mrplex hash backfill" — never auto-run
};

export type VerifyReport = {
  findings: VerifyFinding[];
  counts: {
    versions_scanned: number;
    documents_scanned: number;
    by_check: Record<string, number>;      // findings per check code
    by_severity: Record<VerifySeverity, number>;
  };
  truncated: boolean;         // true if max_findings capped the list (counts stay exact)
};
```

Design notes:
- **Findings are data, never exceptions.** `verify` returns a report even when the store is on fire; the only throws are the usual pre-flight ones (`repo_not_found` for a bad `--repo`, `forbidden` for scope). This mirrors `links.repair` returning `{ repaired, skipped }` rather than throwing on a skip.
- **`counts` stay exact even when `findings` is truncated.** A corpus with a million broken rows shouldn't OOM the report; `max_findings` (default e.g. 10_000) caps the emitted list but the scan still tallies `counts` and sets `truncated: true`. The operator learns the true scale and re-runs with `--check X` to enumerate one family.
- **Opaque ids only.** `document_id`/`version_id` cross the wire as encoded strings (`encodeVersionId`), consistent with §3.3 — internal integer ids never leak.

`VerifySpec` (input):

```ts
export type VerifySpec = {
  repo?: string;                 // omitted = every repo the caller can see
  checks?: string[];             // family prefixes ("chain", "links") or full codes; omitted = all
  min_severity?: VerifySeverity; // filter findings below this (counts still full); default "warn"
  max_findings?: number;         // cap emitted findings; default 10_000
};
```

## 4. Adapter surface

`verify` reads a lot but must not materialize the corpus. New `Storage` methods (both adapters, parity-tested), all keyset-paginated by id and read-only:

- **`versions_all(opts: { repo_id?; after_id; limit })`** → full `VersionRow[]` in id order. The backbone scan for `hash`, `frontmatter`, and `links` re-derivation (they need `frontmatter_raw`, `frontmatter`, `body`). This is the one place mrplex walks *all* versions including superseded ones; keyset by id so batches don't re-scan.
- **`documents_all(opts: { repo_id?; after_id; limit })`** → `{ id, repo_id }[]` for the `chain` family's per-document walk and `chain.orphan_document`. Existing `version_history(document_id)` walks each chain.
- **`fts_all_refs(opts)`** → `{ version_id, has_row: bool, text_hash? }` sufficient to compute `fts.missing`/`fts.orphan`/`fts.stale_body` by joining against the live set. (SQLite external-content FTS makes stored-text retrieval awkward — if `stale_body` can't be done cheaply, the method returns `text_hash: null` and the check is skipped with a one-line report note, not a silent omission.)
- **`chunks_all_version_ids(opts)`** and **`backlog_all_version_ids(opts)`** → the id sets for `chunks.*` orphan/coverage checks; intersect with live-version ids in the kernel.
- **Reuse existing** `links_by_repo(repo_id)` (already returns every link row ordered by `(source_id, ord)` — tests use it) and `versions_live_by_repo(repo_id)` for the `links` family; `versions_current_by_documents` to resolve `target_id` → current path for `links.misresolved_bound`.

No new indexes required — every scan is either an existing partial index (live set) or a full id-ordered table walk (history), which is acceptable for an operator-invoked scrub (§6).

The kernel op composes these behind `kernel.verify`, applies scope (§2.7), runs the pure re-derivation functions (`contentHash`, `extractEdges`, YAML parse via `frontmatter.ts`), and assembles the `VerifyReport`. The heavy comparison logic lives in a new `src/kernel/verify/` module (mirroring `src/kernel/query/`), pure and unit-testable against hand-built corrupted fixtures.

## 5. Surfaces

### CLI — `mrplex verify`

```
mrplex verify [--repo <slug>] [--check <family|code>]... [--severity error|warn]
              [--max-findings <n>] [--json] [--ci]
```

- Default: human table grouped by `check`, a summary line (`scanned N versions across M docs; K findings (E error, W warn)`), and per-finding `path` + `detail`.
- `--json`: the full `VerifyReport` (the MCP/REST structured shape), for piping.
- `--ci`: exit non-zero when any finding at or above the threshold severity exists. Reuses the exit-code families (`src/cli/exit-codes.ts`): a clean run exits 0; findings exit **1** (validation family — "the data failed validation"). A pre-flight `repo_not_found` still exits 4, `forbidden` exits 3, unchanged. This keeps `mrplex verify --ci` a drop-in CI gate.
- `--check` repeatable; accepts a family prefix (`chain`) or a full code (`links.set_mismatch`).

Registered under the top-level program alongside `hash`/`links`/`embed` (main.ts) — it's a maintenance command, not a `docs` subcommand.

### MCP — `verify` tool

A read tool mirroring the kernel op (the §6.2 one-to-one pattern), `outputSchema` = `VerifyReport`. Description leads with *"Read-only integrity scrub — re-derives FTS/links/hashes and checks the version chain, reporting inconsistencies as structured findings; never writes."* An agent maintaining a corpus (the worknotes AGENTS.md discipline) can call this after a batch of writes to confirm it didn't corrupt the graph. Scope arg + `X-Mrplex-Scope` header as every other read tool.

### REST — `GET /repos/{repo}/verify`

Read-only, so a plain `GET` with query params (`?check=chain&severity=error`). Returns the JSON envelope. A whole-database verify (no repo) is `GET /verify`. ETag semantics: none — a verify result is a point-in-time scan, not a cacheable resource (document this; don't emit a misleading ETag).

## 6. Cost and the honest limit

`verify` is **O(total versions)**, not O(live set) — it's the one read path that walks history. On a corpus with heavy edit history (an Obsidian vault synced through autosave storms — the exact case the §11 rollup bullet worries about) that's a real cost. Mitigations, in order of preference:

1. **Scoping by `--check` and `--repo`.** The `chain`/`hash`/`frontmatter` families need the full walk; `fts`/`chunks`/`links` only touch the live set + derived tables and are far cheaper. Default to running everything, but let an operator target the cheap families for a frequent smoke check and reserve the full history walk for periodic/CI runs.
2. **Keyset pagination throughout** (§4) so memory stays bounded regardless of corpus size — the scan streams, the report caps findings, counts stay exact.
3. **No write locks.** `verify` runs in ordinary read transactions; a concurrent write during a scan simply means the scan reflects a slightly-earlier snapshot per document, which is fine — findings are advisory, not transactional guarantees.

This is inherent to "the chain is the guarantee": verifying the guarantee means reading the chain. v1 documents the cost rather than hiding it; a future incremental mode (verify only versions with id > last-verified watermark) is additive and noted as follow-up.

## 7. Workstreams

- **WS1 — wire types + kernel skeleton.** `VerifyReport`/`VerifyFinding`/`VerifySpec` in `wire.ts`; `kernel.verify` returning an empty report; `src/kernel/verify/` module scaffold. Scope + pre-flight (`repo_not_found`, `forbidden`) wired.
- **WS2 — adapter reads + parity.** `versions_all`, `documents_all`, `fts_all_refs`, `chunks_all_version_ids`, `backlog_all_version_ids` on both adapters; kernel-suite parity tests on a shared corrupted fixture.
- **WS3 — the six check families.** Each family as a pure function over the scanned rows + re-derivation helpers; exhaustive unit tests with hand-built corrupt inputs (a chain with a broken `next_id`, a hash-mismatched row, a divergent frontmatter, an orphaned FTS row, a mixed-dim chunk set, a misresolved dangling link). This is the bulk of the work and where correctness is proven.
- **WS4 — surfaces.** CLI (`--json`/`--ci`/filters, exit codes), MCP tool + `outputSchema`, REST route. CLI tests in `test/cli-verify.test.ts` asserting exit codes and JSON shape against a seeded-then-corrupted DB.
- **WS5 — docs.** README "How it works" gets a one-liner; a `mrplex verify` section near the sync/history material; flip the §11 bullet to **shipped** with an inline note (the links-plan.md precedent).

## 8. Resolved decisions

The design questions from the first draft are settled:

- **`fts.stale_body` — dropped from v1.** SQLite's external-content FTS5 doesn't store the body redundantly, so a body-freshness check has no cheap SQLite path and a Postgres-only check isn't worth the parity break. Ship `fts.missing`/`fts.orphan` (id-set membership, full parity) only; a freshness check is an additive follow-up if a cheap path appears (§2.4).
- **`chunks.unembedded` — gated on embedder configuration.** The check runs only when an embedder is configured (flag → `MRPLEX_EMBEDDER` → config `embedder`); with no embedder it's *skipped and noted as skipped*, never reported clean and never firing on every version. The `chunks` orphan/mixed-dim checks stay unconditional — stray rows are residue worth flagging regardless (§2.5).
- **Incremental-verify watermark — deferred, not designed in.** `verify` runs during maintenance or when an issue is suspected, and in exactly those moments a **full** analysis is what's wanted, not an incremental slice trusting a prior clean watermark. v1 always does the complete O(total-versions) walk (§6); an incremental mode can be added later without disturbing this shape, but isn't a v1 concern.
- **`frontmatter.divergence` — strict, always an `error`.** In a correct store `frontmatter_raw` and `frontmatter` are written together in one transaction and can't drift, so this check should essentially never fire; when it does, it means the query index is lying about a document's content. It stays strict with no "parser tolerance" fudge. The one scenario that could mass-trigger it — a deliberate YAML-parser upgrade that reparses old bytes differently — is a **migration event**: any such upgrade ships with a bulk re-parse-and-rewrite backfill, so a divergence finding always means real trouble, never an expected upgrade artifact (§2.3).

## 9. Open questions

None outstanding — the §8 decisions are settled. Implementation can proceed from WS1.
