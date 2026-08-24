# Sync & History Plan — self-describing files, one cursor, one log

Status: **design**. This document supersedes `sync-plan.md` and `history-plan.md`
(both moved to `docs/archive/`). It unifies them around a single idea and adopts a
scope change: sync is now **two-way** (filesystem ↔ repo), aimed first at keeping a
local Markdown/Obsidian vault synchronized with a mrplex repo.

## 0. The ergonomic north star

Everything below serves five properties:

1. **Materialized files are self-describing.** Every file written by mrplex embeds
   injected system frontmatter — `$version: v8421` and `$content_hash: 1a2b…` —
   naming the exact version it was materialized from and the canonical hash of its
   user-authored content. A file's sync state is readable from the file itself.
2. **One persistent client state: a single cursor.** `last_synced_version_id` — one
   opaque version id meaning "every change at or before this position in the log is
   reflected on disk." No per-file database, no manifest, no git shadow repo, no
   tombstone journal.
3. **The `versions` table is already the change log.** Every create / put / move /
   delete inserts an immutable row with a monotonic integer id. History and sync
   *expose* this log; they do not invent a parallel one.
4. **Deletes propagate only when witnessed.** A local deletion becomes a remote
   delete only if the running synchronizer observed it happen. Deletions that occur
   while sync is stopped are deliberately not inferred (§4.6) — the file is restored
   from the repo instead. This one concession eliminates the entire class of
   "sync mass-deleted my repo" failure modes.
5. **Optimistic concurrency, never silent overwrite.** Every write carries the
   ancestry the file itself declares; conflicts are parked, not clobbered (§4.8).

## 1. Layer map

| Layer | What | Depends on |
|---|---|---|
| **A. `$content_hash` intrinsic** (§2) | persisted hash column, shared hash function, read injection | — |
| **B. `history` namespace** (§3) | `history.since` (change feed), `history.index` (live-set pager), `history.list` (scoped history), `mrplex tail` | A (index/feed carry hashes) |
| **C. `mrplex sync`** (§4) | two-way daemon: watcher + feed consumer + startup reconciliation | A, B |

Branch `sync` continues from `main`.

## 2. The `$content_hash` intrinsic (foundation)

A derived, immutable, server-owned property: the SHA-256 (bare lowercase hex, no
algorithm prefix) of a version's canonical content — `join({ frontmatter_raw, body })`
where `frontmatter_raw` is the stored raw, already stripped of `$*` system lines by
`canonicalizeFrontmatter` (`src/kernel/frontmatter-input.ts`). Persisted at write
time, injected on read, filterable in queries.

### 2.1 What it hashes, and the three byte-exactness traps

The hash excludes all intrinsics (never stored, absent by construction) and the
document path (`join` serializes only frontmatter + body — a pure move does not
change the hash). The server and every client must produce byte-identical input,
which is why the hash function is **one shared module**, not parallel
implementations. Three traps it must honor:

1. **Empty-frontmatter collapse.** A doc stored with `frontmatter_raw === ""` reads
   back with an injected block; naively stripping intrinsics leaves `---\n---\n<body>`
   but the server hashed bare `<body>`. Route through the same `split` →
   drop-intrinsics → `join` path (`join` collapses the empty block,
   `src/markdown/frontmatter.ts:81`).
2. **Trailing-newline normalization.** `join` forces the frontmatter block to end in
   `\n` (`frontmatter.ts:82-84`); a local file lacking it must normalize identically.
3. **Line endings.** The delimiter grammar is LF-based (`frontmatter.ts:8-16`);
   normalize CRLF → LF before hashing.

### 2.2 The shared module

`src/markdown/content-hash.ts`, co-located with the split/join contract:

```ts
/** Canonical bytes hashed for $content_hash. */
export function canonicalContent(frontmatterRaw: string, body: string): string {
  return join({ frontmatter_raw: frontmatterRaw, body });
}

export function contentHash(frontmatterRaw: string, body: string): string {
  return createHash("sha256")
    .update(canonicalContent(frontmatterRaw, body), "utf8")
    .digest("hex"); // bare hex
}

/** Hash a whole file as the server would after storing it. Normalizes CRLF→LF,
 *  strips embedded $* lines via the same split/strip/join path. */
export function contentHashOfFile(text: string): string {
  const lf = text.replace(/\r\n/g, "\n");
  const { frontmatter_raw, body } = split(lf);
  const stripped = extractSystemProperties(frontmatter_raw).raw;
  return contentHash(stripped, body);
}
```

The server calls `contentHash(canon.frontmatter_raw, body)` at write time; the sync
client calls `contentHashOfFile(fileText)` on disk files (which may carry embedded
intrinsics from a prior materialization, CRLF, or a non-normalized block — all
handled). SHA-256 matches existing hashing (`embed/chunker.ts`, `shell/keys.ts`);
bare hex because a content hash is only ever compared to another produced by the
same code path.

### 2.3 Persistence

Migration `0002_content_hash.sql` (SQLite + Postgres twins; the runner is
forward-only and `0001_init.sql:8` reserves 0002):

```sql
alter table versions add column content_hash text;
create index versions_content_hash_idx on versions(content_hash);
```

Nullable so the migration is instant; `null` means "not yet backfilled" and reads
compute on the fly during the transition (§2.6). `VersionInsertInput`
(`src/storage/types.ts:46`) does **not** gain the field — the value is derived. The
SQLite/Postgres `version_insert` implementations compute it inside the same `tx` as
the insert, so no version row can exist without its hash. `VersionRow` gains
`content_hash: string`.

### 2.4 Read injection — files become self-describing

The three read surfaces that today append `$version` generalize to a multi-property
append (`withInjectedVersion` → `withInjectedSystemProps`):

- MCP `docs_get` / `docs_get_version` (`src/mcp/tools.ts:166`), gated by `raw: true`
- REST (`src/rest/routes.ts:656`)
- local client (`src/client/local.ts:106`)

Each appends, in fixed order, via `appendSystemProperty` (`frontmatter.ts:128`):

```
$version: v42
$content_hash: 1a2b3c…
```

This is the linchpin of the sync design: a file materialized from any read surface
carries its own ancestry (`$version`) and its own clean-state fingerprint
(`$content_hash`). Note `docs_put` **already accepts an embedded `$version` as
`prev_version_id`** (`src/mcp/tools.ts:707`) — the round-trip ergonomic exists; sync
leans on it rather than inventing state.

Naming decision: the embedded key stays **`$version`** (shipped, and consumed by
`docs_put`), not the `$version_id` spelling used in earlier drafts. The kernel
strips all `$*` lines on write, so pushing a file with stale embedded intrinsics is
already safe.

### 2.5 Filterable intrinsic

`$content_hash` joins the query intrinsics at the three definition sites that
`query-syntax.test.ts` keeps in sync: SQLite `INTRINSIC_COLUMNS`
(`src/storage-sqlite/compile-filter.ts:88`), Postgres
(`src/storage-postgres/compile-postgres.ts:227`), and `DOCUMENTED_INTRINSICS` +
a doc stanza (`src/mcp/query-syntax.ts:16`).

### 2.6 Backfill

`mrplex hash backfill [--repo <slug>]`, mirroring `links backfill`: walk rows with
`content_hash IS NULL`, compute via the shared function, update in batches. Until
backfilled, injection recomputes from `frontmatter_raw`+`body` and the filter
compiler falls back to a computed expression; post-backfill everything reads the
column.

## 3. The `history` namespace (substrate)

Keyed by **position in the version log**, spanning documents — so it sits beside
`query` as a top-level read namespace, not under `docs.*`.

### 3.1 The cursor is the monotonic `versions.id` — not a timestamp

`versions.id` (`integer primary key` / `bigserial`) is a natural log sequence
number; its wire form is the opaque `v{N}` (`src/kernel/version-id.ts`). Clients
treat it as opaque and persist exactly one. An earlier draft proposed canonical
ordering by `(timestamp, version_id)` with the server resolving cursors through
timestamps; that solves the same problem the id already solves, worse — timestamps
carry clock skew and commit-visibility of their own and buy nothing when a
monotonic integer exists. Timestamps appear in this design only inside the safety
window heuristic below, never as ordering or cursors. The client-facing property
the draft wanted survives intact: *persist one opaque version id; the server owns
all ordering.*

### 3.2 The one hazard, and the safety window

The id is an exact cursor iff writes are serialized. Always true on SQLite (single
writer). On Postgres, concurrent writers create **commit-visibility skew**: writer A
takes id 100, writer B takes 101 and commits first; a follower that advances past
101 silently skips 100 when it commits later. And burned ids are routine —
`nextval` is non-transactional, so every rolled-back retry permanently consumes an
id. Gaps are normal; each is either **pending** (in-flight, will appear) or
**burned** (never will), indistinguishable except by age.

The feed therefore returns **the longest safe contiguous run after the cursor**,
not "everything since." Gap rule, keyed on the *successor's* age: if id 100 is
missing and id 101 has been visible longer than window `N` (default ~30s, dwarfing
any real write-tx duration — the `Storage.tx` contract forbids foreign I/O inside a
transaction), then 100 is burned → cross it; if 101 is younger than `N`, 100 may be
a sibling still committing → truncate the page before 101. A page ends at the limit,
the live tip, or the first hot gap — whichever comes first. Healing is a
between-rounds, leading-edge decision; the server exposes no gap hints ("caught up"
and "stalled at a hot gap" both surface as a short/empty page; the client just polls
again). This gives the feed the property the sync design demands: **gap-free by
construction** — continuity never needs an error case because versions are never
pruned and the cursor never crosses an unsafe hole.

Per-document chains are serialized by the `prev_version_id` compare-and-swap and
the current-row unique index, so *scoped* walks (§3.5) never meet a burnable hole;
the window logic engages only on the global feed.

### 3.3 `history.since` — the global change feed

```
history.since(ctx, {
  after_version,   // opaque version_id; "" = from the beginning
  repo?,           // optional filter
  limit?,
}): Promise<{ refs: VersionRef[]; next_since: string }>
```

`next_since` = the last contiguous id returned; it is the entire follower state
(functionally an LSN / resume token), advances monotonically, and jumps past burned
holes once crossed. Refs are lightweight pointers — consumers fetch bodies via
`docs.get_version` only when needed:

```ts
type VersionRef = {
  version_id: string;
  prev_version_id: string | null;
  repo: string;
  path: string;
  prev_path: string | null;   // path of prev version (moves/deletes carry both ends)
  content_hash: string;        // lets consumers skip no-op materializations
  op: "create" | "update" | "move" | "delete";
  created_at: string;
};
```

`op` is derived server-side (no prev → `create`; same path → `update`; new path in
the system namespace → `delete`; other new path → `move`), so consumers never parse
sigils. `prev_path` and `content_hash` are cheap columns that make the feed directly
actionable for sync: a `move` names both endpoints; a hash match means "already have
these bytes, skip the fetch."

### 3.4 `history.index` — paging the live set as of a safe head

The startup/reconciliation enumeration: the current live documents (system
namespace excluded, as `query` defaults), as `{path, version_id, content_hash}`
tuples, keyset-paginated in current-version-id order and **bounded through a safe
head `R`**:

```
history.index(ctx, {
  repo,
  through_version?,  // omitted on first call; server captures and returns R
  after_version?,    // previous page's last version_id
  limit?,            // default 1000
}): Promise<{
  items: Array<{ path, version_id, content_hash }>;
  through_version: string;      // R — echo on subsequent pages
  next_after_version?: string;  // absent on the final page
}>
```

**`R` is computed with the same safety-window machinery as the feed** — it is the
id the feed would hand out as `next_since` at the tip, i.e. everything ≤ R is
visible and final. This makes the handoff invariant exact:

> base scan over `current_version_id ∈ (cursor, R]`  +  `history.since(R)`
> = complete coverage, no gaps, no ordering races.

The repo is never frozen during the scan. A document updated mid-pagination gets a
new current version with id > R, drops out of the remaining bounded pages, and is
delivered by `history.since(R)` afterward. The same argument covers creates,
deletes, and moves during the scan. Keyset, never offset: no races, no
restart-on-concurrent-write, no MVCC snapshot, no separate revision sequence.

(The earlier sync plan reached live-set enumeration through a general `select`
projection on `query`. That projection remains a good idea for `query` ergonomics —
lean results, `$`-prefixed system keys per the `GraphDocument` precedent — but sync
no longer depends on it, which also defuses the breaking-change urgency around
`query`'s default payload. It is defined in `docs/query-select-plan.md`.)

### 3.5 `history.list` — scoped history, and `--ever`

Same forward id-ordered walk, scoped by a `WHERE` clause; the gap window is inert
within document chains.

```
history.list(ctx, { repo, path?, ever?, since?, until?, order?, limit? })
```

`path` is a glob; a single literal path is today's `docs.history`, which folds in
and deprecates (its backward `prev_id` CTE walks the wrong direction on the wrong
axis; newest-first becomes a presentation choice). Multi-document output
interleaves by id. `ever: false` (default) anchors on the **live** set — "history
of what lives here now," riding existing indexes. `ever: true` includes any
document that *ever* had a matching path and returns whole chains — the honest
unification of "moved away" and "deleted" (a deleted doc's current path is a
tombstone under `:deleted/…`). Resumable bounds are version-id cursors, never
timestamps.

### 3.6 `mrplex tail` — the reference consumer

```
mrplex tail [--since <version_id>] [--follow <N>] [--repo <slug>] [--limit <k>]
```

One `VersionRef` per line as NDJSON; crash-resume = `tail --since <last-line-id>`.
`--follow N` sleeps and re-polls on short/empty pages — the only mode that sits at
the live tip, hence the proving ground for the leading-gap heal path.

## 4. `mrplex sync` — the two-way daemon

### 4.1 Invocation

```
mrplex sync <root> [--repo <slug>] [--server <url>]
  [--once] [--interval <dur>] [--debounce <dur>] [--settle <dur>]
  [--include <glob>]... [--exclude <glob>]... [--dry-run] [-v]
```

Top-level command (peer of `serve`, `query`), thin wiring over `src/sync/`, riding
`KernelClient` so local SQLite and remote MCP work identically. Flags resolve
flag → env → config (`src/cli/config.ts`, gaining a nested `sync` block set via
`mrplex config set-sync`). Defaults: include `**/*.md`, debounce `500ms`, poll
interval `5s`. `<root>` paths map to doc paths by relative POSIX path. The
**same include/exclude globs filter both directions** — the local walk, the index
items, and the feed refs all pass through one predicate, so the two sides can never
disagree about what is in scope.

Note there are no deletion flags at all — no `--delete`, no `--max-delete`.
Reconciliation never deletes remotely (§4.6), and witnessed live deletes are
fully trusted: either the tool is trusted to perform deletes or it isn't, and
the safety story is structural (witnessed-only + `docs.delete`'s recoverable
`:deleted/…` move), not a numeric cap.

### 4.2 State model

Three tiers, in order of durability:

1. **The files themselves** — embedded `$version` + `$content_hash` (§2.4). Per-file
   sync state lives *in the file*: ancestry and clean-fingerprint travel with the
   bytes, through vault copies, machine moves, and other sync tools. The `$`
   namespace in a local file also carries **client directives** — a second species
   of intrinsic alongside the server-injected facts: user-authored, honored by the
   sync client, never stored server-side. The first is `$sync: ignore`, which
   excludes a file from sync entirely (never pushed, never diffed, its unlink never
   witnessed as a delete). Two existing mechanisms make the directive safe by
   construction: the kernel strips every `$*` line on write, so it cannot leak into
   a stored version even if pushed by other means; and `contentHashOfFile` excludes
   `$*` lines, so adding or removing the marker never makes a file look dirty.
2. **One cursor file** — `<root>/.mrplex/sync.json`:
   `{ server, repo, last_synced_version_id }`. In-vault (dotfiles are normal in an
   Obsidian vault; `.obsidian/` precedent) so it travels with the vault, whose
   contents are exactly what the cursor makes claims about. Excluded from watching
   and syncing.
3. **An ephemeral in-memory map** — `path → { version_id, content_hash }`, the
   daemon's working knowledge of the last-known remote state per path, built from
   the startup index and maintained by feed application and push acknowledgments.
   Explicitly **not** persistent state — losing it (crash/restart) costs nothing
   the startup reconciliation doesn't rebuild, and it exists chiefly so a witnessed
   `unlink` still knows the `prev_version_id` of a file that no longer exists to be
   read (§4.6).

### 4.3 Remote → local: consume the feed

Poll `history.since(last_synced_version_id)` every `--interval`. For each ref, in
order (per-path dirty check first, always — see below):

- **create / update**: if a local file exists and `contentHashOfFile(local)` equals
  the ref's `content_hash`, no-op (bytes already present; happens after vault
  copies and our own pushes). Otherwise fetch the version (non-raw, so intrinsics
  come injected) and write it — *unless the local file is dirty* (computed hash ≠
  its embedded `$content_hash`) or marked `$sync: ignore`, either of which is a
  conflict (§4.8), never an overwrite.
- **move**: rename `prev_path` → `path` if the file at `prev_path` is clean;
  materialize at `path` regardless; a dirty file at `prev_path` conflicts (§4.8).
- **delete**: remove the local file at `prev_path` **if clean**. If dirty, keep it —
  the local edit outlives the remote delete and is pushed back as a create
  (resurrection) on its next local-change cycle. Data-preserving in both directions.

Advance `last_synced_version_id` to `next_since` **only after** the batch's
filesystem effects complete. A crash between apply and advance replays the batch;
every operation above is idempotent (same bytes → same file; removing an absent
file is a no-op; the dirty check prevents replay from clobbering edits made in the
crash window).

### 4.4 Local → remote: watch, hash-gate, push

`chokidar` watches `<root>` (a deliberate reversal of the earlier no-dependency
stance: two-way sync makes live event witnessing load-bearing, and native
`fs.watch` recursion is historically unreliable on Linux; the dependency is
confined to `src/sync/`). Events are debounced (`--debounce`) into a per-path work
queue; `--settle` optionally skips files younger than the window (partially-written
saves). For each settled path:

1. Read the file. **Directive gate**: `$sync: ignore` → skip entirely (and omit
   the path from the in-memory map, so it is invisible to diffing and deletion).
2. Compute `contentHashOfFile`. **Hash gate**: if computed == embedded
   `$content_hash`, the file is clean — no-op.
   This single check absorbs editor-noise events, our own materializations, and our
   own post-push intrinsic rewrites.
3. Dirty with an embedded `$version` → `docs.put` with `prev_version_id` = embedded
   (the ergonomic `docs_put` already supports). Dirty/absent embedded → `docs.create`
   (a `create_conflict` downgrades to a put against the returned current, then
   re-evaluates).
4. On ack, rewrite the file's embedded intrinsics to the new `$version` (+ hash),
   and update the in-memory map. This local write triggers the watcher; the hash
   gate no-ops it.
5. `stale_prev` → conflict (§4.8). Bounded retries guard livelock.

### 4.5 Echo suppression falls out of self-description

No provenance markers, no author-tag filtering, no "ignore my own writes" bookkeeping:

- Our push comes back on the feed → local file already embeds that `version_id`
  and matching hash → §4.3's first check no-ops it.
- Our materialization/intrinsic-rewrite triggers the watcher → §4.4's hash gate
  no-ops it.

(Provenance markers on writes remain relevant for future mrplex↔mrplex peering —
deferred, as before.)

### 4.6 Deletes: witnessed-only, stat-is-the-verdict, and the concession

**Local → remote.** An `unlink` event never directly triggers a delete — event
*types* are untrusted everywhere in this design (atomic-rename saves, lossy
platform watchers). It schedules the debounced pass; when the pass is about to act,
it **stats the path**: present → treat as change (the atomic-save case, coalesced
by the debounce into a plain update); `ENOENT` → a genuine, *witnessed* deletion →
`docs.delete` with `prev_version_id` from the in-memory map. A path absent from the
map (never tracked — e.g. a `$sync: ignore` file, §4.2) has nothing to delete;
its unlink is a no-op. Any stat error other
than `ENOENT` (e.g. `EACCES`) is not absence — skip and warn. On `stale_prev`
(remote changed after our last knowledge): **skip the delete**; the feed delivers
the newer remote version and re-materializes it — a remote edit always outlives a
local delete, which is the safe direction. There is no cap on witnessed deletes:
an `rm -rf` of the vault root while sync runs is a real, witnessed user action and
is honored — and remains recoverable server-side, since every delete is a move to
`:deleted/…`.

**Remote → local.** Feed `delete` ops, per §4.3: clean local file removed, dirty
one resurrected.

**The offline concession — stated plainly.** With no per-path baseline, no local
index, and no tombstones, a deletion performed while the synchronizer is stopped is
indistinguishable at startup from a remote document not yet materialized:

```
stop sync;  rm foo.md;  start sync
→ foo.md is restored from the repo
```

This is **intentional**. Deleting while sync runs behaves normally (the witnessed
event carries the missing information); deleting while it's stopped gets undone.
To delete offline, delete through mrplex (`mrplex docs delete`) or delete the file
again once sync is running. No additional persistent local state will be added for
offline deletion unless requirements actually change. What this concession buys:
startup reconciliation performs **no remote deletions at all**, so every historical
mass-delete catastrophe (wrong root, unmounted drive, glob mismatch, permission
error mid-walk, case-folding collisions) degrades to harmless re-materialization
noise instead of data loss. `docs.delete` is itself soft (a move to `:deleted/…`,
recoverable), making witnessed deletion a two-layer-soft operation.

### 4.7 Moves

Identity travels inside the file, so rename detection needs no hashing heuristics:

- **Local move** (`mv a.md b.md`): the file at the new path still embeds its
  `$version`. The pass sees an unfamiliar path whose embedded version the map (or
  server) knows at a different path → emit `docs.put` with the new `path` and
  `prev_version_id` = embedded — a true move preserving document identity and
  history. The stale `unlink(a)` resolves via §4.6's stat (absent) but its delete is
  superseded when the move is recognized in the same debounce burst; if the events
  land in separate bursts, the worst case is delete + move-arrives-late →
  `stale_prev` on the delete → skipped, converges.
- **Remote move**: feed `move` ref renames the local file (§4.3).

### 4.8 Conflicts: park the loser, adopt the lineage

A conflict is one situation reached from either direction: **local bytes are dirty
and the remote current is not the file's embedded `$version`.** Resolution is
deterministic, non-blocking, and loses nothing:

1. The local file **keeps its bytes and its path** (never yank content out from
   under an open editor).
2. The **displaced remote content is materialized beside it** as
   `<name>-<version_id>.md` — the same suffix-before-extension convention the
   kernel already uses for `:deleted/…` paths (`withVersionSuffix`,
   `src/kernel/deletion.ts`; version ids are unique and always appended, so the
   same non-collision argument holds). The sibling is written with
   **`$sync: ignore`** added to its injected frontmatter, which is the *only*
   thing keeping it out of sync — no naming convention is interpreted. The user
   merges or deletes it at leisure; deleting it is a local no-op (§4.6), and
   removing the marker line deliberately re-enters it into sync as an ordinary
   file (whose stale embedded `$version` then resolves through this same
   conflict rule).
3. The local file's embedded `$version` is **rewritten to the remote current**
   (content untouched; intrinsics are excluded from the hash, so its dirty state
   is preserved). Its next push is then an ordinary optimistic put on top of the
   remote current — local content wins the chain, with honest lineage, and the
   losing content is parked on disk rather than destroyed.

### 4.9 Startup reconciliation

Run on start (and as the entirety of `--once`): fetch `history.index` pages through
`R`, walk local files (those marked `$sync: ignore` are excluded from the walk,
same as everywhere), then resolve per path/identity:

| # | embedded `$version` vs remote current | computed vs embedded hash | verdict |
|---|---|---|---|
| 1 | match | match | clean — no-op |
| 2 | remote advanced | match (local unedited) | fast-forward: materialize remote current |
| 3 | match | differ (local edit) | push (`prev` = embedded) |
| 4 | remote advanced | differ | conflict → §4.8 |
| 5 | no embedded version; path unknown remotely | — | local creation → `docs.create` |
| 6 | embedded version known at a *different* remote path | — | move: local clean → apply remote path locally; remote path stale vs local move → push move (§4.7); both moved differently → conflict |
| 7 | remote doc; no local file | — | materialize (this is the concession restoring offline deletes) |

Edge: a local file whose embedded version exists but whose document was remotely
*deleted* — clean → remove locally; dirty → resurrect (push as create). Same rule
as the live path (§4.3).

Then `history.since(R)`, apply, advance the cursor, and enter the steady-state
loops (§4.3–4.4).

**Startup is fully deterministic on the cursor marker — no staleness heuristic.**

- **Marker absent** → the full index reconciliation above.
- **Marker present** → skip the index scan entirely: run the purely-local dirty
  walk (computed vs embedded hash — pushes offline edits and creates; no remote
  enumeration needed), then resume `history.since(cursor)`. The feed is gap-free
  from any cursor age (§3.2), so an old marker is merely more replay, never a
  correctness question.

Stated consequence: with a marker present, offline local deletions and moves
reconcile *lazily* — a deleted file is not restored (nor its doc remotely
deleted, per §4.6), and a moved file propagates its move on its next edit — until
a full pass runs. `mrplex sync --once` always performs the full reconciliation,
and deleting the marker forces one on the next daemon start; those are the two
levers, both exact.

### 4.10 Crash recovery summary

- Cursor advances only after apply → replay-on-restart, idempotent by §4.3.
- Push acks rewrite embedded intrinsics → a crash between push and rewrite leaves a
  file whose computed hash differs from embedded but whose *content* matches the
  new remote version — reconciliation case 2/1 territory; the §4.3 hash-match
  no-op or a conflict-park (worst case) resolves it without data loss.
- The in-memory map is rebuilt by the startup index; nothing depends on its survival.

## 5. What this unification dissolves

Kept deliberately visible, because the deletions are the point:

- **The old §3.5 deletion-detection machinery** (expert-review gate, unlink-vs-stat
  epistemology, set-diff provenance). Gone: reconciliation never deletes remotely,
  and live deletes trust one stat, not event semantics.
- **The local-state debate** (JSON index → git shadow repo). Resolved by the
  concession: the only per-file state worth having rides inside the files.
- **`(timestamp, version_id)` canonical ordering.** Replaced by the monotonic id +
  safety window, which delivers the identical client contract (one opaque cursor)
  grounded in the actual storage engine.
- **`--delete` / set-diff mass-delete hazards** (glob asymmetry, walk errors, case
  folding, unmounted roots). All demoted from data-loss risks to re-materialization
  noise.
- **Sync's dependency on `query` `select` projection.** `history.index` serves the
  enumeration; the projection (and its `QueryHit` `$`-prefixing) is an independent
  `query` ergonomics track with no breaking-change deadline —
  `docs/query-select-plan.md`.
- **One-way "filesystem is the source of truth."** Superseded: neither side is the
  source of truth; the version chain is, and both sides converge on it.

## 6. Milestones

1. **Content-hash core** — `content-hash.ts`, migration `0002`, `version_insert`
   computes in-tx, `VersionRow` field. Round-trip tests covering the three traps
   and `contentHashOfFile(injectedRead) === storedHash`. *The correctness gate.*
2. **Read injection + filterable intrinsic** — generalize the three injection
   sites; wire the three compiler/doc sites.
3. **`Storage.versions_since`** — the gap-aware forward walk (the brain of the
   feed). Test on SQLite (gaps rare) and Postgres (burned gaps exercise the window).
4. **`history.since` + `mrplex tail`** — kernel wrapper, enriched `VersionRef`
   (`op`, `prev_path`, `content_hash`), NDJSON consumer proving resume and the
   leading-gap heal.
5. **`history.index`** — safe-head capture, keyset pages, handoff invariant test
   (concurrent writes during pagination land in the feed, exactly once).
6. **Backfill** — `mrplex hash backfill` + compute-on-read fallback.
7. **`mrplex sync --once`** — startup reconciliation only (no watcher, no remote
   deletes by construction). Integration-test the §4.9 table against a local kernel.
8. **The daemon** — feed poll, chokidar watcher, hash gate, witnessed deletes with
   stat verdict, conflict parking, move handling, cursor file.
9. **`history.list` unification** — scoped walk, `--ever`, fold in and deprecate
   `docs.history`. Independent of sync; can land anytime after 3.

## 7. Closed decisions

No open decisions remain. For the record:

- **Injected key naming** — **`$version`**, final. No rename to `$version_id`;
  the projection vocabulary's `$version_id` (a `QueryHit` key) and the embedded
  file intrinsic `$version` are different surfaces and coexist.
- **`$sync` values** — only `ignore` is defined (§4.2, §4.8). No other values are
  reserved; the space stays open until a need appears.
- **Deletion caps** — none. No `--delete`, no `--max-delete`: witnessed deletes
  are fully trusted (§4.6); the safety is structural, not numeric.
- **Startup determinism** — no staleness heuristic. Cursor marker present →
  local dirty walk + feed resume; absent → full index reconciliation (§4.9).
- **`query` `select` projection** — defined in its own plan,
  `docs/query-select-plan.md`.
- **Conflict siblings** — `<name>-<version_id>.md`, excluded from sync solely by
  the `$sync: ignore` directive (§4.8).
Sync & History Plan — self-describing files, one cursor, one log

Status: design. This document supersedes sync-plan.md and history-plan.md
(both moved to docs/archive/). It unifies them around a single idea and adopts a
scope change: sync is now two-way (filesystem ↔ repo), aimed first at keeping a
local Markdown/Obsidian vault synchronized with a mrplex repo.

0. The ergonomic north star

Everything below serves five properties:

Materialized files are self-describing. Every file written by mrplex embeds
injected system frontmatter — $version: v8421 and $content_hash: 1a2b… —
naming the exact version it was materialized from and the canonical hash of its
user-authored content. A file's sync state is readable from the file itself.

One persistent client state: a single cursor. last_synced_version_id — one
opaque version id meaning "every change at or before this position in the log is
reflected on disk." No per-file database, no manifest, no git shadow repo, no
tombstone journal.

The versions table is already the change log. Every create / put / move /
delete inserts an immutable row with a monotonic integer id. History and sync
expose this log; they do not invent a parallel one.

Deletes propagate only when witnessed. A local deletion becomes a remote
delete only if the running synchronizer observed it happen. Deletions that occur
while sync is stopped are deliberately not inferred (§4.6) — the file is restored
from the repo instead. This one concession eliminates the entire class of
"sync mass-deleted my repo" failure modes.

Optimistic concurrency, never silent overwrite. Every write carries the
ancestry the file itself declares; conflicts are parked, not clobbered (§4.8).

1. Layer map

Layer

What

Depends on

A. $content_hash intrinsic (§2)

persisted hash column, shared hash function, read injection

—

B. history namespace (§3)

history.since (change feed), history.index (live-set pager), history.list (scoped history), mrplex tail

A (index/feed carry hashes)

C. mrplex sync (§4)

two-way daemon: watcher + feed consumer + startup reconciliation

A, B

Branch sync continues from main.

2. The $content_hash intrinsic (foundation)

A derived, immutable, server-owned property: the SHA-256 (bare lowercase hex, no
algorithm prefix) of a version's canonical content — join({ frontmatter_raw, body })
where frontmatter_raw is the stored raw, already stripped of $* system lines by
canonicalizeFrontmatter (src/kernel/frontmatter-input.ts). Persisted at write
time, injected on read, filterable in queries.

2.1 What it hashes, and the three byte-exactness traps

The hash excludes all intrinsics (never stored, absent by construction) and the
document path (join serializes only frontmatter + body — a pure move does not
change the hash). The server and every client must produce byte-identical input,
which is why the hash function is one shared module, not parallel
implementations. Three traps it must honor:

Empty-frontmatter collapse. A doc stored with frontmatter_raw === "" reads
back with an injected block; naively stripping intrinsics leaves ---\n---\n<body>
but the server hashed bare <body>. Route through the same split →
drop-intrinsics → join path (join collapses the empty block,
src/markdown/frontmatter.ts:81).

Trailing-newline normalization. join forces the frontmatter block to end in
\n (frontmatter.ts:82-84); a local file lacking it must normalize identically.

Line endings. The delimiter grammar is LF-based (frontmatter.ts:8-16);
normalize CRLF → LF before hashing.

2.2 The shared module

src/markdown/content-hash.ts, co-located with the split/join contract:

/** Canonical bytes hashed for $content_hash. */
export function canonicalContent(frontmatterRaw: string, body: string): string {
  return join({ frontmatter_raw: frontmatterRaw, body });
}

export function contentHash(frontmatterRaw: string, body: string): string {
  return createHash("sha256")
    .update(canonicalContent(frontmatterRaw, body), "utf8")
    .digest("hex"); // bare hex
}

/** Hash a whole file as the server would after storing it. Normalizes CRLF→LF,
 *  strips embedded $* lines via the same split/strip/join path. */
export function contentHashOfFile(text: string): string {
  const lf = text.replace(/\r\n/g, "\n");
  const { frontmatter_raw, body } = split(lf);
  const stripped = extractSystemProperties(frontmatter_raw).raw;
  return contentHash(stripped, body);
}

The server calls contentHash(canon.frontmatter_raw, body) at write time; the sync
client calls contentHashOfFile(fileText) on disk files (which may carry embedded
intrinsics from a prior materialization, CRLF, or a non-normalized block — all
handled). SHA-256 matches existing hashing (embed/chunker.ts, shell/keys.ts);
bare hex because a content hash is only ever compared to another produced by the
same code path.

2.3 Persistence

Migration 0002_content_hash.sql (SQLite + Postgres twins; the runner is
forward-only and 0001_init.sql:8 reserves 0002):

alter table versions add column content_hash text;
create index versions_content_hash_idx on versions(content_hash);

Nullable so the migration is instant; null means "not yet backfilled" and reads
compute on the fly during the transition (§2.6). VersionInsertInput
(src/storage/types.ts:46) does not gain the field — the value is derived. The
SQLite/Postgres version_insert implementations compute it inside the same tx as
the insert, so no version row can exist without its hash. VersionRow gains
content_hash: string.

2.4 Read injection — files become self-describing

The three read surfaces that today append $version generalize to a multi-property
append (withInjectedVersion → withInjectedSystemProps):

MCP docs_get / docs_get_version (src/mcp/tools.ts:166), gated by raw: true

REST (src/rest/routes.ts:656)

local client (src/client/local.ts:106)

Each appends, in fixed order, via appendSystemProperty (frontmatter.ts:128):

$version: v42
$content_hash: 1a2b3c…

This is the linchpin of the sync design: a file materialized from any read surface
carries its own ancestry ($version) and its own clean-state fingerprint
($content_hash). Note docs_put already accepts an embedded $version as
prev_version_id (src/mcp/tools.ts:707) — the round-trip ergonomic exists; sync
leans on it rather than inventing state.

Naming decision: the embedded key stays $version (shipped, and consumed by
docs_put), not the $version_id spelling used in earlier drafts. The kernel
strips all $* lines on write, so pushing a file with stale embedded intrinsics is
already safe.

2.5 Filterable intrinsic

$content_hash joins the query intrinsics at the three definition sites that
query-syntax.test.ts keeps in sync: SQLite INTRINSIC_COLUMNS
(src/storage-sqlite/compile-filter.ts:88), Postgres
(src/storage-postgres/compile-postgres.ts:227), and DOCUMENTED_INTRINSICS +
a doc stanza (src/mcp/query-syntax.ts:16).

2.6 Backfill

mrplex hash backfill [--repo <slug>], mirroring links backfill: walk rows with
content_hash IS NULL, compute via the shared function, update in batches. Until
backfilled, injection recomputes from frontmatter_raw+body and the filter
compiler falls back to a computed expression; post-backfill everything reads the
column.

3. The history namespace (substrate)

Keyed by position in the version log, spanning documents — so it sits beside
query as a top-level read namespace, not under docs.*.

3.1 The cursor is the monotonic versions.id — not a timestamp

versions.id (integer primary key / bigserial) is a natural log sequence
number; its wire form is the opaque v{N} (src/kernel/version-id.ts). Clients
treat it as opaque and persist exactly one. An earlier draft proposed canonical
ordering by (timestamp, version_id) with the server resolving cursors through
timestamps; that solves the same problem the id already solves, worse — timestamps
carry clock skew and commit-visibility of their own and buy nothing when a
monotonic integer exists. Timestamps appear in this design only inside the safety
window heuristic below, never as ordering or cursors. The client-facing property
the draft wanted survives intact: persist one opaque version id; the server owns
all ordering.

3.2 The one hazard, and the safety window

The id is an exact cursor iff writes are serialized. Always true on SQLite (single
writer). On Postgres, concurrent writers create commit-visibility skew: writer A
takes id 100, writer B takes 101 and commits first; a follower that advances past
101 silently skips 100 when it commits later. And burned ids are routine —
nextval is non-transactional, so every rolled-back retry permanently consumes an
id. Gaps are normal; each is either pending (in-flight, will appear) or
burned (never will), indistinguishable except by age.

The feed therefore returns the longest safe contiguous run after the cursor,
not "everything since." Gap rule, keyed on the successor's age: if id 100 is
missing and id 101 has been visible longer than window N (default ~30s, dwarfing
any real write-tx duration — the Storage.tx contract forbids foreign I/O inside a
transaction), then 100 is burned → cross it; if 101 is younger than N, 100 may be
a sibling still committing → truncate the page before 101. A page ends at the limit,
the live tip, or the first hot gap — whichever comes first. Healing is a
between-rounds, leading-edge decision; the server exposes no gap hints ("caught up"
and "stalled at a hot gap" both surface as a short/empty page; the client just polls
again). This gives the feed the property the sync design demands: gap-free by
construction — continuity never needs an error case because versions are never
pruned and the cursor never crosses an unsafe hole.

Per-document chains are serialized by the prev_version_id compare-and-swap and
the current-row unique index, so scoped walks (§3.5) never meet a burnable hole;
the window logic engages only on the global feed.

3.3 history.since — the global change feed

history.since(ctx, {
  after_version,   // opaque version_id; "" = from the beginning
  repo?,           // optional filter
  limit?,
}): Promise<{ refs: VersionRef[]; next_since: string }>

next_since = the last contiguous id returned; it is the entire follower state
(functionally an LSN / resume token), advances monotonically, and jumps past burned
holes once crossed. Refs are lightweight pointers — consumers fetch bodies via
docs.get_version only when needed:

type VersionRef = {
  version_id: string;
  prev_version_id: string | null;
  repo: string;
  path: string;
  prev_path: string | null;   // path of prev version (moves/deletes carry both ends)
  content_hash: string;        // lets consumers skip no-op materializations
  op: "create" | "update" | "move" | "delete";
  created_at: string;
};

op is derived server-side (no prev → create; same path → update; new path in
the system namespace → delete; other new path → move), so consumers never parse
sigils. prev_path and content_hash are cheap columns that make the feed directly
actionable for sync: a move names both endpoints; a hash match means "already have
these bytes, skip the fetch."

3.4 history.index — paging the live set as of a safe head

The startup/reconciliation enumeration: the current live documents (system
namespace excluded, as query defaults), as {path, version_id, content_hash}
tuples, keyset-paginated in current-version-id order and bounded through a safe
head R:

history.index(ctx, {
  repo,
  through_version?,  // omitted on first call; server captures and returns R
  after_version?,    // previous page's last version_id
  limit?,            // default 1000
}): Promise<{
  items: Array<{ path, version_id, content_hash }>;
  through_version: string;      // R — echo on subsequent pages
  next_after_version?: string;  // absent on the final page
}>

R is computed with the same safety-window machinery as the feed — it is the
id the feed would hand out as next_since at the tip, i.e. everything ≤ R is
visible and final. This makes the handoff invariant exact:

base scan over current_version_id ∈ (cursor, R]  +  history.since(R)
= complete coverage, no gaps, no ordering races.

The repo is never frozen during the scan. A document updated mid-pagination gets a
new current version with id > R, drops out of the remaining bounded pages, and is
delivered by history.since(R) afterward. The same argument covers creates,
deletes, and moves during the scan. Keyset, never offset: no races, no
restart-on-concurrent-write, no MVCC snapshot, no separate revision sequence.

(The earlier sync plan reached live-set enumeration through a general select
projection on query. That projection remains a good idea for query ergonomics —
lean results, $-prefixed system keys per the GraphDocument precedent — but sync
no longer depends on it, which also defuses the breaking-change urgency around
query's default payload. It is defined in docs/query-select-plan.md.)

3.5 history.list — scoped history, and --ever

Same forward id-ordered walk, scoped by a WHERE clause; the gap window is inert
within document chains.

history.list(ctx, { repo, path?, ever?, since?, until?, order?, limit? })

path is a glob; a single literal path is today's docs.history, which folds in
and deprecates (its backward prev_id CTE walks the wrong direction on the wrong
axis; newest-first becomes a presentation choice). Multi-document output
interleaves by id. ever: false (default) anchors on the live set — "history
of what lives here now," riding existing indexes. ever: true includes any
document that ever had a matching path and returns whole chains — the honest
unification of "moved away" and "deleted" (a deleted doc's current path is a
tombstone under :deleted/…). Resumable bounds are version-id cursors, never
timestamps.

3.6 mrplex tail — the reference consumer

mrplex tail [--since <version_id>] [--follow <N>] [--repo <slug>] [--limit <k>]

One VersionRef per line as NDJSON; crash-resume = tail --since <last-line-id>.
--follow N sleeps and re-polls on short/empty pages — the only mode that sits at
the live tip, hence the proving ground for the leading-gap heal path.

4. mrplex sync — the two-way daemon

4.1 Invocation

mrplex sync <root> [--repo <slug>] [--server <url>]
  [--once] [--interval <dur>] [--debounce <dur>] [--settle <dur>]
  [--include <glob>]... [--exclude <glob>]... [--dry-run] [-v]

Top-level command (peer of serve, query), thin wiring over src/sync/, riding
KernelClient so local SQLite and remote MCP work identically. Flags resolve
flag → env → config (src/cli/config.ts, gaining a nested sync block set via
mrplex config set-sync). Defaults: include **/*.md, debounce 500ms, poll
interval 5s. <root> paths map to doc paths by relative POSIX path. The
same include/exclude globs filter both directions — the local walk, the index
items, and the feed refs all pass through one predicate, so the two sides can never
disagree about what is in scope.

Note there are no deletion flags at all — no --delete, no --max-delete.
Reconciliation never deletes remotely (§4.6), and witnessed live deletes are
fully trusted: either the tool is trusted to perform deletes or it isn't, and
the safety story is structural (witnessed-only + docs.delete's recoverable
:deleted/… move), not a numeric cap.

4.2 State model

Three tiers, in order of durability:

The files themselves — embedded $version + $content_hash (§2.4). Per-file
sync state lives in the file: ancestry and clean-fingerprint travel with the
bytes, through vault copies, machine moves, and other sync tools. The $
namespace in a local file also carries client directives — a second species
of intrinsic alongside the server-injected facts: user-authored, honored by the
sync client, never stored server-side. The first is $sync: ignore, which
excludes a file from sync entirely (never pushed, never diffed, its unlink never
witnessed as a delete). Two existing mechanisms make the directive safe by
construction: the kernel strips every $* line on write, so it cannot leak into
a stored version even if pushed by other means; and contentHashOfFile excludes
$* lines, so adding or removing the marker never makes a file look dirty.

One cursor file — <root>/.mrplex/sync.json:
{ server, repo, last_synced_version_id }. In-vault (dotfiles are normal in an
Obsidian vault; .obsidian/ precedent) so it travels with the vault, whose
contents are exactly what the cursor makes claims about. Excluded from watching
and syncing.

An ephemeral in-memory map — path → { version_id, content_hash }, the
daemon's working knowledge of the last-known remote state per path, built from
the startup index and maintained by feed application and push acknowledgments.
Explicitly not persistent state — losing it (crash/restart) costs nothing
the startup reconciliation doesn't rebuild, and it exists chiefly so a witnessed
unlink still knows the prev_version_id of a file that no longer exists to be
read (§4.6).

4.3 Remote → local: consume the feed

Poll history.since(last_synced_version_id) every --interval. For each ref, in
order, always inspect any existing local file before replacing it:

create / update:

If no local file exists, fetch the version (non-raw, so sync intrinsics are
injected) and materialize it at the canonical repo path.

If a local file exists, compute contentHashOfFile(local).

If that computed hash equals the ref's content_hash, the local user-authored
bytes are already exactly the remote version. This is a clean equivalence even
if the local file is missing or has stale sync intrinsics. Inject/repair
$version and $content_hash in place to match the remote version; do not
rewrite the user-authored content. This metadata repair is not a no-op.

Only adopt remote provenance after the content-hash equality check. A path
match alone is never enough to stamp a local file with a remote $version.

If the local content differs and the file is marked $sync: ignore, leave it
alone.

If the local content differs and cannot be proven to be a clean descendant that
can be updated safely, treat the occupied canonical path as a conflict (§4.8):
keep the local file where it is and emit the remote version as an ignored
sibling. Never overwrite or move the local file merely to make room.

move:

If the source file at prev_path is present and clean for the expected remote
ancestry, rename it to path when the destination is free.

If the destination is already occupied by content that cannot be proven equal
to the moved remote version, do not move or overwrite that content. Preserve the
local destination and park the remote version beside it as a conflict (§4.8).

If the destination already contains bytes whose canonical hash equals the moved
remote version, repair its sync intrinsics in place and remove the now-stale
clean source if appropriate.

A dirty source or divergent occupied destination is a conflict, not an
overwrite.

delete: remove the local file at prev_path if clean. If dirty, keep it —
the local edit outlives the remote delete and may be intentionally resurrected by
a later local push. Data is preserved in both directions.

Advance last_synced_version_id to next_since only after the batch's
filesystem effects complete. A crash between apply and advance replays the batch;
all operations must therefore be idempotent. A replayed materialization whose
content hash already matches performs only intrinsic repair if needed; removing an
absent file is a no-op; conflict parking must use deterministic/collision-safe names
so replay does not spray duplicate siblings.

4.4 Local → remote: watch, hash-gate, push

chokidar watches <root> (a deliberate reversal of the earlier no-dependency
stance: two-way sync makes live event witnessing load-bearing, and native
fs.watch recursion is historically unreliable on Linux; the dependency is
confined to src/sync/). Events are debounced (--debounce) into a per-path work
queue; --settle optionally skips files younger than the window (partially-written
saves). For each settled path:

Read the file. Directive gate: $sync: ignore → skip entirely (and omit
the path from ordinary push/delete handling).

Compute contentHashOfFile.

If the file has an embedded $version:

computed hash == embedded $content_hash → clean; no content push is needed.

computed hash != embedded $content_hash → docs.put with
prev_version_id = embedded $version.

stale_prev → conflict (§4.8); do not rewrite the local file's ancestry to
pretend the conflict is resolved.

If the file does not have an embedded $version, absence of provenance is
not automatically a create. Resolve the current remote document at that path
first:

no remote document → docs.create;

remote document exists and local canonical hash == remote content_hash →
this is a clean local copy missing sync metadata; inject the remote $version
and $content_hash in place, with no server write;

remote document exists and hashes differ → occupied-path conflict (§4.8):
preserve the local file untouched and emit the remote current as an ignored
sibling. Do not adopt the remote $version onto divergent local bytes and
do not automatically overwrite the remote.

On a successful create/put ack, rewrite the local file's embedded intrinsics to
the acknowledged $version + $content_hash, and update the in-memory map.
This local write triggers the watcher; the hash gate no-ops it.

Bounded retries guard transport races/livelock, but semantic conflicts are parked
rather than retried into an overwrite.

This explicit path lookup for files lacking $version is important: it lets a
pre-existing Obsidian vault attach safely without confusing a clean copy that merely
lacks mrplex intrinsics with a brand-new document.

4.5 Echo suppression falls out of self-description

No provenance markers, no author-tag filtering, no "ignore my own writes" bookkeeping:

Our push comes back on the feed → local file already embeds that version_id
and matching hash → §4.3's first check no-ops it.

Our materialization/intrinsic-rewrite triggers the watcher → §4.4's hash gate
no-ops it.

(Provenance markers on writes remain relevant for future mrplex↔mrplex peering —
deferred, as before.)

4.6 Deletes: witnessed-only, stat-is-the-verdict, and the concession

Local → remote. An unlink event never directly triggers a delete — event
types are untrusted everywhere in this design (atomic-rename saves, lossy
platform watchers). It schedules the debounced pass; when the pass is about to act,
it stats the path: present → treat as change (the atomic-save case, coalesced
by the debounce into a plain update); ENOENT → a genuine, witnessed deletion →
docs.delete with prev_version_id from the in-memory map. A path absent from the
map (never tracked — e.g. a $sync: ignore file, §4.2) has nothing to delete;
its unlink is a no-op. Any stat error other
than ENOENT (e.g. EACCES) is not absence — skip and warn. On stale_prev
(remote changed after our last knowledge): skip the delete; the feed delivers
the newer remote version and re-materializes it — a remote edit always outlives a
local delete, which is the safe direction. There is no cap on witnessed deletes:
an rm -rf of the vault root while sync runs is a real, witnessed user action and
is honored — and remains recoverable server-side, since every delete is a move to
:deleted/….

Remote → local. Feed delete ops, per §4.3: clean local file removed, dirty
one resurrected.

The offline concession — stated plainly. With no per-path baseline, no local
index, and no tombstones, a deletion performed while the synchronizer is stopped is
indistinguishable at startup from a remote document not yet materialized:

stop sync;  rm foo.md;  start sync
→ foo.md is restored from the repo

This is intentional. Deleting while sync runs behaves normally (the witnessed
event carries the missing information); deleting while it's stopped gets undone.
To delete offline, delete through mrplex (mrplex docs delete) or delete the file
again once sync is running. No additional persistent local state will be added for
offline deletion unless requirements actually change. What this concession buys:
startup reconciliation performs no remote deletions at all, so every historical
mass-delete catastrophe (wrong root, unmounted drive, glob mismatch, permission
error mid-walk, case-folding collisions) degrades to harmless re-materialization
noise instead of data loss. docs.delete is itself soft (a move to :deleted/…,
recoverable), making witnessed deletion a two-layer-soft operation.

4.7 Moves

Identity travels inside the file, so rename detection needs no hashing heuristics:

Local move (mv a.md b.md): the file at the new path still embeds its
$version. The pass sees an unfamiliar path whose embedded version the map (or
server) knows at a different path → emit docs.put with the new path and
prev_version_id = embedded — a true move preserving document identity and
history. The stale unlink(a) resolves via §4.6's stat (absent) but its delete is
superseded when the move is recognized in the same debounce burst; if the events
land in separate bursts, the worst case is delete + move-arrives-late →
stale_prev on the delete → skipped, converges.

Remote move: feed move ref renames the local file (§4.3).

4.8 Conflicts: preserve local, park remote

A conflict means mrplex cannot prove that the bytes currently occupying the
canonical filesystem path may be replaced, moved, or stamped with newer remote
provenance without losing or misrepresenting local work.

The resolution rule is deliberately conservative and non-destructive:

The existing local file keeps its bytes, its path, and its existing
provenance. Sync does not move it out of the way and does not rewrite its
$version to the remote current. In particular, divergent local bytes must
never be given a remote $version they did not actually materialize from.

Fetch/materialize the remote current beside it as a conflict sibling using
the suffix-before-extension convention, e.g.
<name>-<version_id>.md (or another deterministic collision-safe equivalent).
The sibling contains the normal injected remote $version and $content_hash
plus $sync: ignore.

$sync: ignore is the semantic exclusion mechanism. The filename itself has no
sync meaning. The ignored remote sibling is therefore safe to inspect, diff,
edit, move, or delete without being pushed back automatically.

Report the canonical path as unresolved/conflicted. Do not claim that the
remote document has been successfully materialized at its canonical filesystem
location while the local occupant remains divergent.

The user resolves the conflict explicitly: merge the remote sibling into the
canonical local file, replace one with the other, rename content, or otherwise
decide the desired state. Once the canonical file is again attributable to a
known remote version (or is intentionally pushed via normal optimistic
concurrency), ordinary synchronization resumes.

Example:

before:
  my-file.md                        # pre-existing/divergent local content

remote:
  my-file.md @ v124

after conflict parking:
  my-file.md                        # untouched local content
  my-file-v124.md                   # remote v124 + $sync: ignore

There is one important non-conflict repair case that superficially looks similar:
if my-file.md lacks $version / $content_hash but its canonical local hash
equals remote v124's content_hash, it is already the same user-authored document.
Inject $version: v124 and the corresponding $content_hash into
my-file.md itself. Do not create a sibling; no content is in conflict.

This policy intentionally allows an unresolved conflict to temporarily violate the
usual repo path == filesystem path materialization invariant. That is preferable
to moving or overwriting arbitrary user content. The ignored sibling carries enough
remote provenance for the user to make an informed resolution without requiring a
persistent sidecar conflict database.

4.9 Startup reconciliation

Run on start (and as the entirety of --once when a full reconciliation is
requested): fetch history.index pages through R, walk local files (those marked
$sync: ignore are excluded from ordinary sync handling), then resolve per
path/identity.

#

Local state

Remote state

Verdict

1

embedded $version matches; computed hash matches embedded/remote hash

same current version

clean; repair missing/stale sync intrinsics if necessary

2

no embedded $version; computed canonical local hash matches remote content_hash at same path

remote doc exists

metadata adoption only: inject remote $version + $content_hash in place; user content untouched

3

embedded older version; computed hash matches embedded $content_hash

remote advanced

local unedited; fast-forward/materialize remote current

4

embedded current version; computed hash differs from embedded $content_hash

remote unchanged

local edit; push with prev = embedded

5

local changed from embedded version

remote also advanced

conflict → §4.8; preserve local canonical file, park remote sibling

6

no embedded version; local hash differs from remote hash at same path

remote doc exists

occupied-path conflict → §4.8; do not stamp local file with remote provenance

7

no embedded version; path absent remotely

none

local creation → docs.create

8

embedded version known at a different remote path

identity/path differs

reconcile as move (§4.7) when unambiguous; divergent destination/source → conflict

9

no local file

remote doc exists

materialize (this is the concession restoring offline deletes)

Edge: a local file whose embedded version exists but whose document was remotely
deleted — clean → remove locally; dirty → preserve it and require/perform explicit
resurrection through normal local→remote semantics. Never discard dirty bytes.

A path collision during reconciliation follows the same proof rule as steady state:
content-hash equality permits metadata repair; path equality alone permits
nothing. If remote foo.md exists and local foo.md has no sync intrinsics:

hashes equal → inject $version / $content_hash into local foo.md;

hashes differ → leave local foo.md untouched and emit remote current as
foo-<version_id>.md with $sync: ignore.

Then history.since(R), apply, advance the cursor, and enter the steady-state
loops (§4.3–4.4).

Startup is deterministic on the cursor marker, but missing provenance may require
targeted remote lookup.

Marker absent → full index reconciliation above.

Marker present → resume from the cursor, plus a local walk for offline edits
and creations. Files with embedded $version can be classified locally from
their hash. Files lacking $version must not be blindly created: resolve the
remote path first and apply the same hash-equality/adoption-or-conflict rule as
above.

The offline deletion concession remains unchanged: without a full index/set
comparison, an unwitnessed missing path is not interpreted as a remote delete.
mrplex sync --once may force a full reconciliation, and deleting the marker forces
one on the next daemon start.

4.10 Crash recovery summary

Cursor advances only after apply → replay-on-restart, idempotent by §4.3.

Push acks rewrite embedded intrinsics → a crash between push and rewrite leaves a
file whose embedded ancestry may lag even though its content matches the new
remote version. Remote/local hash equality repairs the intrinsics in place; it
does not create a conflict sibling or rewrite user-authored content.

The in-memory map is rebuilt by the startup index; nothing depends on its survival.

5. What this unification dissolves

Kept deliberately visible, because the deletions are the point:

The old §3.5 deletion-detection machinery (expert-review gate, unlink-vs-stat
epistemology, set-diff provenance). Gone: reconciliation never deletes remotely,
and live deletes trust one stat, not event semantics.

The local-state debate (JSON index → git shadow repo). Resolved by the
concession: the only per-file state worth having rides inside the files.

(timestamp, version_id) canonical ordering. Replaced by the monotonic id +
safety window, which delivers the identical client contract (one opaque cursor)
grounded in the actual storage engine.

--delete / set-diff mass-delete hazards (glob asymmetry, walk errors, case
folding, unmounted roots). All demoted from data-loss risks to re-materialization
noise.

Sync's dependency on query select projection. history.index serves the
enumeration; the projection (and its QueryHit $-prefixing) is an independent
query ergonomics track with no breaking-change deadline —
docs/query-select-plan.md.

One-way "filesystem is the source of truth." Superseded: neither side is the
source of truth; the version chain is, and both sides converge on it.

6. Milestones

Content-hash core — content-hash.ts, migration 0002, version_insert
computes in-tx, VersionRow field. Round-trip tests covering the three traps
and contentHashOfFile(injectedRead) === storedHash. The correctness gate.

Read injection + filterable intrinsic — generalize the three injection
sites; wire the three compiler/doc sites.

Storage.versions_since — the gap-aware forward walk (the brain of the
feed). Test on SQLite (gaps rare) and Postgres (burned gaps exercise the window).

history.since + mrplex tail — kernel wrapper, enriched VersionRef
(op, prev_path, content_hash), NDJSON consumer proving resume and the
leading-gap heal.

history.index — safe-head capture, keyset pages, handoff invariant test
(concurrent writes during pagination land in the feed, exactly once).

Backfill — mrplex hash backfill + compute-on-read fallback.

mrplex sync --once — startup reconciliation only (no watcher, no remote
deletes by construction). Integration-test the §4.9 table against a local kernel.

The daemon — feed poll, chokidar watcher, hash gate, witnessed deletes with
stat verdict, conflict parking, move handling, cursor file.

history.list unification — scoped walk, --ever, fold in and deprecate
docs.history. Independent of sync; can land anytime after 3.

7. Closed decisions

No open decisions remain. For the record:

Injected key naming — $version, final. No rename to $version_id;
the projection vocabulary's $version_id (a QueryHit key) and the embedded
file intrinsic $version are different surfaces and coexist.

$sync values — only ignore is defined (§4.2, §4.8). No other values are
reserved; the space stays open until a need appears.

Deletion caps — none. No --delete, no --max-delete: witnessed deletes
are fully trusted (§4.6); the safety is structural, not numeric.

Startup determinism — no staleness heuristic. Cursor marker present →
local dirty walk + feed resume; absent → full index reconciliation (§4.9).

query select projection — defined in its own plan,
docs/query-select-plan.md.

Conflict siblings — preserve the existing local canonical-path occupant;
materialize the remote current as <name>-<version_id>.md, carrying its normal
$version / $content_hash plus $sync: ignore. Never rewrite divergent local
bytes to adopt the remote $version merely to resolve ancestry (§4.8).