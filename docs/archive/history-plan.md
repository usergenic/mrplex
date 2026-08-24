# History / Change-Feed Plan — a forward, resumable walk over versions

Status: **design** (not yet implemented). This plan introduces a unified read
primitive over the `versions` table that serves two callers from one traversal:

- **scoped history** — every version of a document (or a globbed set of
  documents), forward or backward in time; and
- **the global change feed** — every version across the store, in commit
  order, resumable by cursor — the substrate all synchronization targets
  (filesystem mirror, git, GitHub, mrplex↔mrplex) will sit on top of.

The two are the *same forward walk over the monotonic `versions.id`*, differing
only in **scope** (one document-set vs. the whole store) and in whether the
**safety window** for gap detection is engaged. This plan is the foundation for
a later `sync-plan.md`; it deliberately stops at "expose the change stream" and
does not design the sync targets themselves.

## 1. Why this exists / the substrate we already have

mrplex is already an append-only, versioned store, which is exactly the
substrate a change feed needs. Three existing properties do the work
(design §3.2):

1. **Every mutation is an immutable version.** create / put / move / delete
   (a move into `:deleted/…/`) all insert a new `versions` row; nothing is
   overwritten or destroyed.
2. **`versions.id` is a monotonic integer** — `integer primary key` on SQLite,
   `bigserial` on Postgres — global across repos. The wire form is the opaque
   `v{N}` `version_id` (`src/kernel/version-id.ts`). It is a natural log
   sequence number: a single integer is an ordered, resumable cursor.
3. **Per-document order is serialized by construction.** The partial unique
   index `versions_document_current_uidx` (one row per `document_id` where
   `next_id is null`) plus the `prev_version_id` compare-and-swap mean a
   document's chain is totally ordered and gap-free regardless of isolation
   level or concurrency.

We are *exposing* the change model we already have, not inventing one.

## 2. The one hazard: the cursor is exact only for serialized writes

`versions.id` is a reliable cursor **iff writes are serialized at the storage
layer**. This is always true on SQLite (single writer: id-assignment order ==
commit order) and true on Postgres only if there are no concurrent writers.

The failure mode under concurrent Postgres writers is **commit-visibility
skew**, and it is real, not theoretical — the Postgres adapter uses a
connection `Pool` and borrows a fresh client per top-level `tx()`
(`src/storage-postgres/adapter.ts`), so two writers commit in parallel:

1. Writer A inserts doc X → gets `id=100`, tx still open.
2. Writer B inserts doc Y → gets `id=101`, commits first.
3. A follower polls, sees 101, advances its cursor to 101.
4. A commits. `id=100` becomes visible — but the follower only ever asks for
   `id > 101`, so **row 100 is silently skipped**.

Two Postgres facts make this routine, not rare:

- `bigserial` draws from a sequence; **`nextval` fires at INSERT time, is
  non-transactional, and is never rolled back.** A rolled-back tx (the adapter
  retries on `40001`/`40P01` and on version-race violations) **permanently
  burns** its consumed id. So gaps in the `id` sequence are normal on Postgres.
- Isolation is `REPEATABLE READ`, which does not force commit order to match
  sequence-assignment order for inserts to different documents.

The gap between two ids is therefore *unreliable exactly where ordering does
not matter* (independent writes to different documents have no happens-before
relationship) and *reliable exactly where it does*: two writes that contend for
the same path are serialized by `versions_repo_path_current_uidx` — the second
cannot commit until the first is visible, so it necessarily gets a higher id
and commits later.

## 3. The design: forward walk + safety window + gap truncation

The feed returns the **longest safe contiguous run of versions after a
cursor**, up to a page limit. It is *not* "all versions since v."

### 3.1 The safety window

A missing id is either **pending** (a slow in-flight commit that will appear)
or **burned** (a rolled-back `nextval` that never will). They are
indistinguishable by inspection; only elapsed time separates them.

The window `N` is bounded by **the longest open write transaction**. If an id
was assigned more than `N` ago, its tx has either committed (and is visible) or
rolled back (burned) — it cannot still be in flight. The `Storage.tx` contract
forbids foreign I/O inside a transaction (`src/storage/types.ts`), so write
txs are sub-second; an `N` of a few seconds (30s for generous margin) exceeds
the real skew window by orders of magnitude on both backends.

**Key the window on the successor's age, not the gap's own age.** The missing
row has no timestamp, but the row *after* the gap does. If id 100 is missing,
101 is present, and 101 has been visible longer than `N`, then 100's tx — which
grabbed its id even earlier — has had ≥ `N` to resolve; it is not visible, so
it is burned → step across it. If 101 is younger than `N`, 100 might be a
sibling still committing → truncate before 101. `created_at` is an adequate
age heuristic here: `N` dwarfs both clock skew and tx duration, and it is used
only as a coarse "is this region still hot" test, never as the cursor.

### 3.2 Gap truncation and pagination do not collide

Walking `id > cursor` ascending, a page ends for exactly one reason,
whichever comes first:

- **hit the page limit** on a contiguous run → return `limit` rows;
- **reached the live tip** (ran out of rows) → return what's there;
- **hit a gap that is not safe to cross** → truncate; that gap is the end of
  this round's page.

There is no "fill across a hole mid-page." A gap that demands truncation simply
ends the round. Healing is a **between-rounds, leading-edge** decision: on the
*next* call the cursor sits just before a hole, and the successor-age test
decides whether to cross it (aged-out/burned → start the page at the successor)
or wait (hot → return an empty page, let the client retry on its own schedule).

The server exposes **no gap/status hints**. "Caught up at the tip" and "stalled
at a hot leading gap" both surface as a short/empty page, and both demand the
same client action — come back later. The client owns its own poll cadence.

### 3.3 The cursor (`next_since`)

The response carries `next_since` = the last contiguous id returned. The client
echoes it back on the next call. That single value is the entire cursor; it
encodes "I have safely seen every version up to here." It is functionally an
**LSN / resume token** (Postgres LSN, MongoDB change-stream resume token). All
follower state lives in the caller — the server is stateless across calls, and
`next_since` advances monotonically (it jumps *past* burned holes once crossed,
so a client never re-scans a dead region).

## 4. Scope: history and the feed are one traversal

Both scoped history and the global feed are forward `id`-ordered walks over
`versions`. Scope is a `WHERE` clause:

- **`document_id` / document-set set** → a document's (or globbed set's)
  history. Each chain is contiguous-by-construction (§1.3), so **the
  gap/safety-window logic is inert** — a scoped walk never encounters a
  burnable hole within a single document's chain.
- **unscoped** → the global change feed, where gaps are possible and the
  window engages.

Same method, one branch of behavior (§3.1–3.2) simply does not fire when
scoped. This is why today's `docs.history` (a `prev_id` recursive CTE anchored
at the tip, walking *backward*, `src/storage-sqlite/adapter.ts`
`version_history`) is *not* reused as-is: it walks the wrong direction on the
wrong axis. We replace it with a forward `id`-ordered walk that both callers
share; the backward/newest-first presentation becomes a display choice layered
above storage.

## 5. Namespace and method surface

The current kernel surface (`src/kernel/kernel.ts`):

```
repos.list  repos.get  repos.create  repos.rename  repos.delete
repos.set_path_config  repos.set_link_config
docs.get  docs.get_version  docs.history  docs.diff
docs.create  docs.put  docs.delete
links.backfill  links.stale  links.repair
query
```

Everything under `docs.*` is keyed by document **identity** (`repo, path`). The
unified walk is keyed by **position in the version log** and spans many
documents, so it does not belong under `docs`. It is promoted to a **top-level
`history` namespace**, a sibling of `query` (also a cross-document top-level
read). Today's `docs.history(repo, path)` becomes the single-path special case,
folded into `history.list` and deprecated.

### 5.1 `history.list` — scoped, gap-free walk

```
history.list(ctx, {
  repo,
  path?,          // glob; omitted = whole repo. Single literal path = today's docs.history.
  ever?: boolean, // default false. See §6.
  since?, until?, // version-id cursors (§5.3)
  order?: 'asc' | 'desc',   // forward (default) or reverse chronological
  limit?,
}): Promise<Version[]>
```

Multi-document ordering is **interleaved by `id`** (the coherent meaning of
"forward in time across a pathspace"); grouping-by-document is a CLI display
choice, not a storage concern.

### 5.2 `history.since` — global, gap-aware change feed

```
history.since(ctx, {
  after_version,  // opaque version_id; "" / "v0" = from the beginning
  repo?,          // optional filter; omitted = all repos
  limit?,
}): Promise<{ refs: VersionRef[]; next_since: string }>
```

Returns lightweight **references**, not full envelopes — the feed trades in
pointers into the log; consumers fetch bodies via `docs.get_version(repo, id)`
on demand.

```
type VersionRef = {
  version_id: string;
  prev_version_id: string | null;
  repo: string;
  path: string;
  created_at: string;
};
```

`prev_version_id` is included deliberately: it lets a consumer reconstruct
per-document chains from the flat global stream, which is the discovery
mechanism for sync (see §7).

### 5.3 `since` / `until` are version-id cursors, not timestamps

Anything resumable uses **version-id cursors** — timestamps carry
commit-visibility and clock skew (the same reasons they are unfit as the feed
cursor, §2). A timestamp bound (e.g. a CLI `--until 2026-01-01`) may exist as an
explicitly best-effort convenience, but it is never a resumption cursor and is
never mixed under the same argument as the id cursor. (Today's `HistoryOptions`
uses a `before` ISO timestamp; the id-cursor form supersedes it for resumable
use.)

## 6. `--ever`: history of a pathspace when documents move

`path` is a **per-version** field (`src/kernel/wire.ts`: "may differ from
previous if moved"), so "the history of a pathspace" is ambiguous once any
document has moved or been deleted (deletion is a move into `:deleted/…/`, so a
deleted document's *current* path is a tombstone, not its old path).

- **default (`ever: false`) — current-path anchored.** Resolve the glob against
  the **live** set (rides `versions_live_by_repo` + the
  `versions_repo_path_current_uidx` index), get document ids, return each
  document's whole chain. Answers "the history of what lives here now."
  Silently excludes documents that have moved away *or* been deleted (their
  current path no longer matches). Cheap.

- **`ever: true` — ever-matched, whole chains.** Include any document that had
  *any* version whose path matched the glob, and return each such document's
  **entire** chain (not just the matching versions — fragmenting a chain
  mid-stream would be incoherent). Unifies "moved away" and "deleted" under one
  honest idea: *the current path no longer matches, but history says it once
  did.* More expensive — scans historical version paths (needs `path_norm`
  indexed to stay sane).

The expensive semantic is the opt-in; the default rides existing live-set
indexes. (`ever` was chosen over `ghosts` — which overclaims toward deletion —
because the set includes very-much-alive documents that merely relocated.)

## 7. Deferred to sync-plan.md (out of scope here)

- **Discovery / cold-start.** `history.since("")` walks everything and
  self-heals for active documents (any document that gets touched again is
  revisited and its chain caught up via `prev_version_id`). The only residual
  is a document that receives a single version inside a skew window and is then
  never touched again — covered by the safety window (§3.1), since the cursor is
  not allowed to reach that id until `N` has passed. Whether a periodic full
  reconcile scan is also wanted is a sync-plan decision.
- **Provenance.** Bidirectional peers need to distinguish "a version I authored
  locally" from "a version I ingested from the peer" to avoid ping-pong. That
  is a marker on the write (the `author` field is a candidate carrier), not a
  cursor concern.
- **Push notifications.** The feed (pull) is the single correctness path.
  Webhooks / SSE, if added, are a dumb "high-water advanced" nudge; the real
  transfer still pulls.

## 8. Implementation order

The intelligence is one new **storage** primitive; the kernel wrappers are
thin. Build and test the storage method first, against SQLite (where gaps are
rare) and Postgres (where burned gaps exercise the window).

1. **`Storage.versions_since`** — the brain. Signature roughly:

   ```
   versions_since(
     after_id: number,
     limit: number,
     repo_id: number | null,
     window_seconds: number,
   ): Promise<VersionRow[]>   // already truncated at the first unsafe gap
   ```

   Fetch `id > after_id order by id`; walk for the first internal gap; apply the
   successor-age test (§3.1) to decide crossable-vs-hot; return the safe prefix.
   Both adapters implement it; the SQLite/Postgres divergence (§2) lives
   entirely here. The kernel above stays dialect-agnostic.

2. **`history.since`** kernel wrapper — decode `after_version`, resolve
   `repo?`, call `versions_since`, map rows → `VersionRef[]`, encode
   `next_since`. Reuses the existing `hydrateVersion` / `toVersionWire` row
   mapping.

3. **`mrplex tail`** — the reference consumer and proving ground:

   ```
   mrplex tail [--since <version_id>] [--follow <N>] [--repo <slug>] [--limit <k>]
   ```

   Emits one `VersionRef` per line as **NDJSON**; the cursor is implicit in the
   last emitted line (crash-resume = `tail --since <last-line-id>`). No flags →
   `since("")` to the tip, then exit. `--follow N` → on a short/empty page,
   sleep `N` seconds and re-request `since(next_since)`; otherwise identical
   loop. Follow mode is the only mode that routinely sits at the live tip, so it
   is where the leading-gap heal path (§3.2) actually gets exercised.

4. **Unify `history.list`** — forward `versions_since`-style walk scoped by
   document-set, with `order`, `since`/`until`, and `--ever`. Fold in and
   deprecate `docs.history`; keep any newest-first rendering in the CLI/kernel
   presentation layer, not storage. Grep for dependents of the current reverse
   ordering before flipping storage to forward-only.
