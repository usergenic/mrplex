# Sync Plan — Local → Repo Sync, with a Persisted `$content_hash` Intrinsic

Target: a one-way sync that mirrors a local source into a mrplex repo, reacting to changes
with configurable debounce and an optional poll interval. The command is `mrplex sync`;
the only local source it targets right now is the **filesystem** (a directory tree of
markdown files), but the name is deliberately source-agnostic so other local sources can
be added later without a rename. The motivating command:

```
mrplex sync <path/to/root> --repo notes --server <url> --interval 5s
```

The sync rides the existing `KernelClient` abstraction (`src/client/kernel-client.ts`),
so it works unchanged against a local SQLite kernel (`src/client/local.ts`) or a remote
MCP server (`src/client/remote-mcp.ts`) — the `--server` flag alone selects transport,
exactly as every other CLI command.

The efficiency of the whole thing rests on one small schema addition: a **`$content_hash`
intrinsic**, persisted as a column on `versions`, queryable in the filter language, and
injected on read alongside `$version`. That turns "which local files are dirty?" into a
single whole-repo query rather than one fetch per document — and it reconstructs the
sync's change-detection state from the server, so no local manifest file is required.

Branch `sync` is cut from `main`.

## 1. Scope

**In:**

- **`$content_hash` intrinsic** — a derived, immutable, server-owned document property:
  the SHA-256 of the canonical serialized form of a version (`join({ frontmatter_raw, body })`,
  where `frontmatter_raw` is already stripped of `$*` system properties). Persisted on
  write, injected on read (mirroring `$version`), and exposed as a query intrinsic
  `$content_hash` for whole-repo diffing.
- **Query projection (`select`)** — a `select` argument on `query` (and its `--select`/`-s`
  CLI flag and REST param) naming which fields come back, so a whole-repo diff can request
  just `$path` + `$content_hash` instead of shipping every body. This is what makes sync
  scale cheaply; it also resolves the earlier open question about `query` returning full
  bodies.
- **Intrinsic-prefixed result keys** — a cross-cutting naming fix: every non-frontmatter
  field in a projected query result object carries the `$` sigil (`$repo`, `$version_id`,
  `$path`, `$content_hash`, …), so system fields can never collide with a user's
  frontmatter key of the same name. This mirrors what `GraphDocument` already does
  (`$path`/`$degrees` alongside bare `select`ed keys, `src/kernel/wire.ts:70`) and is
  applied here as a matter of principle wherever we share a namespace with user content.
- **Schema migration `0002`** — add `content_hash text` to `versions`, computed once at
  `version_insert` time (versions are immutable, so it never needs recomputing), plus a
  backfill for existing rows following the `links.backfill` / `embed.backfill` pattern.
- **Shared serialize+hash function** — the *single* source of truth used by both the
  server (to compute the stored hash) and the sync client (to compute a local file's
  expected hash). The two must be byte-identical or every dirty-check is a false positive;
  sharing the code is the only way to guarantee they can't drift.
- **CLI `mrplex sync <root>`** — reconcile a local tree into a repo. A single idempotent
  pass (`--once`) is the core primitive; the watch loop, interval poll, and debounce are
  layered on top of it.
- **Debounce + interval config** — per-invocation flags (`--debounce`, `--interval`,
  `--settle`) with persisted defaults in `~/.config/mrplex/config.json`
  (`src/cli/config.ts`).
- **Safety defaults** — `--dry-run`, opt-in `--delete`, `--include`/`--exclude` globs
  (default `**/*.md`, since the store only holds markdown).

**Out (deliberately):**

- **Two-way sync (repo → filesystem).** Pulling remote changes down needs a real conflict
  model and a remote cursor. Sync is a one-way *push*; the filesystem is the source of
  truth. Revisit as its own plan once one-way proves useful.
- **Content-addressed dedup / blob storage.** The hash is a change-detector, not a storage
  key. Documents remain path-addressed version chains.
- **FUSE / virtual-filesystem mount.** Heavy, platform-bound, and orthogonal to "keep these
  files uploaded."
- **Rename detection by content.** A local move that preserves bytes still surfaces as
  delete-old + create-new unless the file's path maps to an existing doc; true
  hash-based rename inference across paths is out.

## 2. The `$content_hash` intrinsic

### 2.1 What it hashes

The hash input is the canonical file form the server already knows how to produce:

```
serialized   = join({ frontmatter_raw, body })
content_hash = sha256Hex(serialized)   // bare lowercase hex, no algorithm prefix
```

The value is **bare hex** — no `sha256:` prefix. Simpler to read, compare, and store; if
the algorithm ever changes, every row is mechanically recomputed in a single backfill pass
(§2.8), so the prefix would buy nothing but noise.

where `join` is `src/markdown/frontmatter.ts:80` and `frontmatter_raw` is the **stored**
raw — i.e. already stripped of every `$*` system line by `canonicalizeFrontmatter`
(`src/kernel/frontmatter-input.ts`). Concretely, the hash excludes:

- **All intrinsics** (`$version`, `$content_hash` itself, any future `$*`). They are
  injected on read, never stored, so they are absent from the hashed bytes by construction.
- **The document path.** `join` serializes only frontmatter + body, so a pure move (a
  `put` to a new path with unchanged bytes) yields the *same* hash — a move is not an edit.

Three byte-exactness traps the shared function must honor (these are exactly why the client
must not roll its own strip+hash):

1. **Empty-frontmatter collapse.** A doc stored with `frontmatter_raw === ""` reads back as
   `---\n$version: v12\n---\n<body>`. Naive intrinsic-stripping leaves `---\n---\n<body>`,
   but the server hashed just `<body>`. `join` already collapses `frontmatter_raw === ""`
   to bare body (`frontmatter.ts:81`); the client must route through the same `split` →
   drop-intrinsics → `join` path so the emptied block disappears, matching
   `parse("") === {}` semantics (`frontmatter.ts:19-20`).
2. **Trailing-newline normalization.** `join` forces the frontmatter block to end in `\n`
   (`frontmatter.ts:82-84`). A local file whose frontmatter lacks the trailing newline must
   normalize identically before hashing.
3. **Line endings.** The delimiter grammar is LF-based (`frontmatter.ts:8-16`). CRLF on
   disk must be normalized to LF before hashing or every hash breaks on Windows. The client
   normalizes `\r\n` → `\n` on read; the server never sees CRLF because writes go through
   the same normalization.

### 2.2 The shared function

New module `src/markdown/content-hash.ts` (co-located with the frontmatter split/join
contract it depends on):

```ts
import { createHash } from "node:crypto";
import { join, split } from "./frontmatter.js";
import { extractSystemProperties } from "./frontmatter.js";

/** Canonical bytes hashed for $content_hash: frontmatter (stripped of $*) + body. */
export function canonicalContent(frontmatterRaw: string, body: string): string {
  return join({ frontmatter_raw: frontmatterRaw, body });
}

export function contentHash(frontmatterRaw: string, body: string): string {
  const bytes = canonicalContent(frontmatterRaw, body);
  return createHash("sha256").update(bytes, "utf8").digest("hex"); // bare hex
}

/**
 * Hash a whole markdown file exactly as the server would after storing it:
 * split, drop every $* intrinsic line, re-join, hash. Normalizes CRLF→LF.
 */
export function contentHashOfFile(text: string): string {
  const lf = text.replace(/\r\n/g, "\n");
  const { frontmatter_raw, body } = split(lf);
  const stripped = extractSystemProperties(frontmatter_raw).raw;
  return contentHash(stripped, body);
}
```

- **Server side** calls `contentHash(canon.frontmatter_raw, body)` at write time (§2.3) —
  it already holds the stored, stripped `frontmatter_raw`.
- **Client side** calls `contentHashOfFile(fileText)` — the file on disk may contain a
  stale injected `$version`/`$content_hash` (it was written by a prior read), CRLF, or a
  non-normalized frontmatter block; all three are handled.

SHA-256 matches the codebase's existing hashing (`embed/chunker.ts`, `shell/keys.ts`). We
emit bare hex rather than the `sha256:<hex>` form `shell/keys.ts` uses for API keys: keys
must self-describe their algorithm because they're matched opaquely, whereas a content hash
is only ever compared to another content hash produced by the same code path (§2.1).

### 2.3 Persistence

Migration `src/storage-sqlite/migrations/0002_content_hash.sql` and its Postgres twin
`src/storage-postgres/migrations/0002_content_hash.sql`. The migration runner is
forward-only via `PRAGMA user_version` / a migrations table
(`src/storage-sqlite/migrations/index.ts`), and `0001_init.sql:8` explicitly reserves
"Future migrations resume at 0002."

```sql
-- 0002_content_hash.sql (SQLite)
alter table versions add column content_hash text;
create index versions_content_hash_idx on versions(content_hash);
```

- **New column, nullable**, so the migration is instant on existing rows. `null` means
  "not yet backfilled"; the intrinsic treats a null as "compute on the fly" during the
  transition (see §2.8) so reads never break mid-backfill.
- **`VersionInsertInput`** (`src/storage/types.ts:46`) does *not* gain a `content_hash`
  field — the value is derived, not caller-supplied. Instead the SQLite/Postgres
  `version_insert` implementations compute it from the row they're about to write, keeping
  it inside the same `tx` as the insert (the same place the design notes link extraction
  runs — "pure CPU, no external I/O", `types.ts:227`). This guarantees no version row can
  ever exist without its hash.
- **`VersionRow`** (`src/storage/types.ts`) gains `content_hash: string`.

### 2.4 Read injection

`toVersionWire` (`src/kernel/kernel.ts:185`) is *not* the injection point — it produces the
storage-faithful wire type (no `$version` there either). Injection happens at the three
read surfaces that already append `$version`, generalizing each from a single-property to a
multi-property append:

- MCP: `withInjectedVersion` → `withInjectedSystemProps` (`src/mcp/tools.ts:166`), called
  by `docs_get` / `docs_get_version`, still gated by `raw: true`.
- REST: the conditional append in `src/rest/routes.ts:656`.
- Local client: `maybeInjectVersion` → `maybeInjectSystemProps` (`src/client/local.ts:106`).

Each appends both lines via `appendSystemProperty` (`src/markdown/frontmatter.ts:128`):

```
$version: v42
$content_hash: 1a2b3c…
```

Order is fixed (`$version` then `$content_hash`) so round-trip diffs of the injected form
are stable. `raw: true` suppresses both, as today.

### 2.5 Query support

`$content_hash` becomes a filterable intrinsic. Three definition sites must stay in sync —
`query-syntax.test.ts` enforces this by compiling every documented intrinsic against the
real parser:

- **SQLite compiler** `INTRINSIC_COLUMNS` (`src/storage-sqlite/compile-filter.ts:88`):
  `content_hash: "versions.content_hash"`.
- **Postgres compiler** `INTRINSIC_COLUMNS` (`src/storage-postgres/compile-postgres.ts:227`):
  identical entry.
- **`DOCUMENTED_INTRINSICS`** (`src/mcp/query-syntax.ts:16`): add `"content_hash"`, and a
  short stanza in `QUERY_SYNTAX_DOC` under "$-intrinsics":

  > - `$content_hash` — the SHA-256 (lowercase hex) of the document's canonical content
  >   (frontmatter minus intrinsics, plus body). Path-independent: a move does not change
  >   it. Compare for equality to detect changed content:
  >   `$content_hash == "1a2b3c…"`.

### 2.6 Projection: the `select` argument

Today `query` always returns full `Version` rows (`runQuery` → `Version[]`,
`src/kernel/query/query.ts:65`; the MCP tool wraps them with `wrapList` + `renderVersionList`,
`tools.ts:906-912`). For a whole-repo diff, shipping every body each pass is the dominant
cost. `select` fixes that: name the fields you want, get back lean objects — and `$body`
becomes just another opt-in member, so you pull document content only when you ask for it.

- **Kernel** — `QuerySpec` (`src/kernel/query/query.ts:22`, and its `KNOWN_SPEC_FIELDS`
  set) gains `select?: string[]`, **defaulting to `["$path"]`**. `$path` is the identity you
  almost always want and the cheapest thing to return; everything else — `$content_hash`,
  `$version_id`, `$body`, frontmatter keys — is opt-in by naming it. `runQuery` returns a
  **projected `QueryHit`** per hit (§2.7), not a full `Version`.
- **The `$path`-only default is a lean-by-default choice, not a footgun-free one.** Two edges
  we accept for now: (a) an *unscoped* or multi-repo query returns `$path`-only hits with no
  `$repo`, so paths from different repos are indistinguishable — the caller must add `$repo`
  to `select` when querying more than one repo. We leave this sharp edge in rather than
  special-casing the default. (b) This changes `query`'s default payload from full `Version`
  rows to `$path`-only objects — a **breaking change** for existing consumers (see the
  compat note at the end of §2.7).
- **`select` entries** may name bare frontmatter keys (`title`, `status`) or intrinsics
  (`$path`, `$version_id`, `$content_hash`, `$repo`, `$updated_at`, `$body`, …). This is the
  same vocabulary `graph`'s `select` + `$`-intrinsics already use (`GraphSpec.select`,
  `wire.ts:58`), so the two read surfaces stay consistent.
- **Intrinsic names come from a single registry.** The `$`-intrinsic set is already the
  filter compilers' `INTRINSIC_COLUMNS` (`compile-filter.ts:88`) plus the version-identity
  fields (`$version_id`, `$prev_version_id`, `$next_version_id`, `$repo`, `$author`). `select`
  validates against that registry and rejects unknown `$names` with `filter_invalid`-style
  errors, reusing the "expected …" message the compiler already derives from the registry
  (`compile-filter.ts:106`).
- **MCP** — add a `select` property to the `query` tool's `inputSchema` (`tools.ts:857`) and
  a projected-object branch to its `outputSchema` (currently
  `listResultSchema(VERSION_SCHEMA, …)`, `tools.ts:906`).
- **CLI** — `mrplex query` gains `-s, --select <field>` (repeatable, same accumulator
  pattern as `--repo`, `main.ts:1189-1193`), passed through as `select` on the
  `client.query` spec (`main.ts:1216`). `renderQueryTable` renders projected columns.
- **REST** — `/query` accepts `select` (repeated query param on GET, array in the POST body;
  `dispatchQuery`, `routes.ts:279`).

This is what lets sync pull the entire repo's change-detection state in one lean call:

```
query(repo: "notes", filter: "$path.endsWith(\".md\")", select: ["$path", "$version_id", "$content_hash"])
  → [ { "$path": "guides/intro.md", "$version_id": "v42", "$content_hash": "1a2b…" }, … ]
```

### 2.7 Projected result shape: `$`-prefixed system fields

The projected object reifies the filter language's data model, exactly as `GraphDocument`
already does (`src/kernel/wire.ts:70`: `$path`/`$degrees`/`$links`/`$backlinks` as `$`-keys,
bare `select`ed frontmatter keys alongside). Applied here as a general principle: **any
field that isn't user-authored frontmatter carries the `$` sigil**, so a document whose
frontmatter literally contains a key named `repo` or `path` still round-trips without
colliding with the system's `$repo`/`$path`.

```ts
/** A projected query hit (only present when `select` is supplied). */
export type QueryHit = {
  [intrinsic: `$${string}`]: unknown; // $path, $version_id, $repo, $content_hash, …
  [frontmatterKey: string]: unknown;   // bare select-ed frontmatter keys
};
```

Intrinsic ⇔ column/field map for `select` (superset of the filter `INTRINSIC_COLUMNS`,
since projection can return identity fields that aren't filterable):

| `select` name        | source                                  |
|----------------------|-----------------------------------------|
| `$path`              | `versions.path`                         |
| `$repo`              | repo slug                               |
| `$version_id`        | `encodeVersionId(versions.id)`          |
| `$prev_version_id`   | `encodeVersionId(versions.prev_id)`     |
| `$next_version_id`   | `encodeVersionId(versions.next_id)`     |
| `$content_hash`      | `versions.content_hash`                 |
| `$updated_at`        | `versions.created_at`                   |
| `$author`            | `versions.author`                       |
| `$body`              | `versions.body`                         |
| *(bare key)*         | `versions.frontmatter -> key`           |

**Scope of the prefixing principle.** `query` now always returns `QueryHit` objects (the
default `select` is `["$path"]`, §2.6) — full `Version` rows are no longer a `query` return
shape at all. The *full* `Version` wire type (`wire.ts:17`) lives on unchanged as the return
of `docs.get` / `docs.get_version` / `docs.history`, keeping its current flat, unprefixed
field names (`version_id`, `repo`, `path`, …); renaming those is a breaking change across
every existing surface, out of scope for this branch. The `$`-prefix principle applies to
the **new** projected shape, which is where system and user names actually share one
namespace. `GraphDocument` set the precedent; `QueryHit` follows it.

**Compatibility.** Changing `query`'s default return from full `Version[]` to `$path`-only
`QueryHit[]` is a **breaking change** for existing `query` consumers (MCP tool, REST, CLI
`--json`). Acceptable here because it's the correct default for a lean read primitive and
any caller can recover the old payload with an explicit
`select: ["$path", "$repo", "$version_id", "$prev_version_id", "$next_version_id",
"$author", "$updated_at", "$content_hash", ...frontmatter]` — though if we find callers that
truly want the whole document, `docs.get` is the right tool. Flagged as the one behavior
break in this branch; call it out in the changelog.

### 2.8 Backfill

`mrplex hash backfill [--repo <slug>]`, mirroring `links backfill` / `embed backfill`
(one-shot, not a worker). Walks current + historical versions with `content_hash IS NULL`,
computes via the shared `contentHash`, and updates in batches. Until a row is backfilled,
the read-injection path (§2.4) and the query compiler treat a null column as compute-on-read
(the kernel recomputes from `frontmatter_raw`+`body` for the injected value; the filter
falls back to a computed expression). Post-backfill, everything reads the column directly.
Rationale for tolerating null during transition: the migration is instant but the backfill
of a large repo is not, and reads must not break in between.

## 3. The `sync` command

### 3.1 Invocation

```
mrplex sync <root> [--repo <slug>] [--server <url>]
  [--once] [--interval <dur>] [--debounce <dur>] [--settle <dur>]
  [--include <glob>]... [--exclude <glob>]... [--delete] [--max-delete <n>] [--dry-run] [-v]
```

Registered as a top-level command in `src/cli/main.ts` (peer of `serve`, `query`, `graph`),
thin wiring over a new `src/sync/` module. `--repo`/`--server`/`--token`/`--author`
resolve through the same precedence as every command (flag → env → config → error),
`src/cli/main.ts:262`. `<root>` being a filesystem path is the only local source today; a
future source would be a sibling positional/subcommand, not a new top-level command.

`<root>` maps to doc paths by relative path: `<root>/guides/intro.md` → doc path
`guides/intro.md`. Paths are normalized to `/` separators (POSIX) regardless of host OS.

### 3.2 The reconcile pass (the core primitive)

Everything reduces to one idempotent function `reconcileOnce(client, root, opts)`:

1. **Enumerate remote state** — one projected query,
   `query(repo, filter, select: ["$path", "$version_id", "$content_hash"])` (§2.6), returning
   a lean `QueryHit` per current doc — no bodies. `$repo` isn't needed in the select because
   sync always targets exactly one repo, so the multi-repo footgun (§2.6) doesn't apply
   here. Build `remote: Map<path, {version_id, content_hash}>` keyed off `$path`.
2. **Enumerate local state** — walk `<root>` honoring include/exclude globs; for each file
   compute `contentHashOfFile(text)` (§2.2). Build `local: Map<path, {hash, raw, body}>`.
   Read is cheap; the hash is the comparison key.
3. **Diff**:
   - `path` in local, not in remote → **create** (`docs.create`).
   - `path` in both, `local.hash !== remote.content_hash` → **put** with
     `prev_version_id = remote.version_id` (`docs.put`).
   - `path` in both, hashes equal → **skip** (the fast path — no write, no body upload).
   - `path` in remote, not in local → **candidate deletion** — see §3.5 for how a candidate
     becomes an actual `docs.delete`. Never deleted unless `--delete` is set; otherwise
     left in place and reported.
4. **Apply** with bounded concurrency, collecting per-path outcomes.

Because change detection is `local.hash !== remote.content_hash`, the pass needs **no local
state file** — the server's `$content_hash` *is* the manifest, reconstructed each pass.

### 3.3 Conflict handling

Writes are optimistic (`docs.put` requires the observed `prev_version_id`; a stale one
throws `stale_prev` with the current version, `kernel.ts:476`). Because the filesystem is
the declared source of truth, the default on `stale_prev` is **last-writer-wins from the
filesystem**: re-read the current remote version, retry the `put` with the fresh
`prev_version_id`, and emit a warning. A `--no-clobber` flag flips this to "skip and warn"
for callers who want the server to win. Bounded retry (default 3) guards against a
livelocking concurrent writer.

`create` racing an existing remote doc throws `create_conflict` (`kernel.ts:417`); treat it
as a `put` against the returned `current_version_id` and re-diff.

### 3.4 The watch loop, debounce, and interval

`--once` runs a single `reconcileOnce` and exits (this is what cron/`watchexec` wrappers
would call). Without `--once`:

- **Watch**: a recursive `fs.watch` (Node's native watcher; no new dependency) over
  `<root>` feeds a change queue. Watch events are notoriously bursty and duplicate-prone,
  which is exactly what the debounce absorbs.
- **`--debounce <dur>`** (default `500ms`): coalesce a burst of events into one reconcile.
  The timer resets on each new event; the pass fires only after the tree has been quiet for
  the debounce window. This is the "settle after the editor finishes saving" knob.
- **`--settle <dur>`** (default `0`): an optional minimum age a file must reach (mtime
  older than `now - settle`) before it's uploaded, to skip partially-written files from
  tools that write incrementally. Distinct from debounce: debounce delays the *pass*,
  settle filters individual *files* within a pass.
- **`--interval <dur>`** (default unset): a safety-net poll that runs `reconcileOnce` every
  interval regardless of watch events, catching changes the watcher missed (network mounts,
  editors that swap inodes, platform quirks). With `--interval` and no reliable watcher
  available, sync degrades to pure polling.

A reconcile pass is single-flighted: if events arrive while a pass runs, they schedule
exactly one follow-up pass (not one per event).

Durations parse a small `<n>(ms|s|m)` grammar shared with any future duration flags.

### 3.5 Deletion detection

> **STATUS: needs expert review.** The claims in this subsection about filesystem event
> semantics (atomic-rename saves, `fs.watch` event fidelity across platforms, whether a
> `rename()` ever leaves a path absent) are the author's current understanding and have
> **not** been verified against authoritative sources or a filesystem expert. Treat the
> *structure* of the approach as the proposal; treat the *factual assertions* as
> to-be-confirmed. Where a claim is load-bearing it's marked ⚠.

Deleting a remote doc because a local file is "gone" is the one irreversible-feeling
operation sync performs (softened by `docs.delete` moving to `:deleted/…`, but still). The
danger is that "the file is absent" can be *inferred* in several ways, and the weak
inferences produce false positives that would delete live documents. This section pins down
what signal we trust.

**Two independent sources of a deletion signal:**

1. **Reconcile set-difference** (§3.2 step 3): a path present in `remote` but absent in the
   `local` walk. Stateless, survives restarts, and — critically — is the **only** signal
   that catches a file removed while sync wasn't running. This is the source of truth for
   deletion and runs every pass regardless of watch events.
2. **`unlink` watch events**: the OS telling us a path was removed. A *latency optimization*
   only — it lets a deletion propagate in milliseconds instead of waiting for the next
   reconcile/interval. It is **never** acted on directly (see below).

**Why `unlink` events must not be trusted directly (⚠ claims to verify):**

- ⚠ Many editors save via *atomic rename*: write `foo.md.tmp`, then `rename(tmp, foo.md)`.
  The belief is that `rename()` is a single operation that atomically replaces the target,
  so `foo.md` is *never* absent at any instant — yet the watcher may still report this as
  `unlink(foo.md)` + `create(foo.md)` because the underlying inode changed. If true, a
  naive "`unlink` → `docs.delete`" deletes and recreates the doc on every save.
- ⚠ A move `mv a.md b.md` is `unlink(a)` + `create(b)`; the `unlink(a)` seen alone is
  indistinguishable from a real deletion of `a`.
- ⚠ Node's `fs.watch` is claimed to be lossy and platform-divergent: it reports both create
  and delete as a generic `"rename"` event, `filename` may be null, macOS FSEvents is
  directory-granular and may coalesce/reorder, Windows can drop events on buffer overrun.
  If true, the event *type* itself can't be trusted to mean "deleted."

**The proposed rule: `unlink` is a hint; a `stat` is the verdict.**

This is the part most in need of a second opinion, stated as plainly as possible:

- A **watch event** is a *record of something that happened in the past*, delivered by the
  (per the ⚠ claims) lossy watcher. A **`stat(path)`** (`fs.existsSync` / `fs.statSync`) is
  a *present-tense question to the filesystem itself*: "is this path here right now?"
- The argument is that for deciding "was this deleted," the stat is strictly more reliable
  than reasoning about event timing, because it reads actual current filesystem state
  rather than inferring it from a stream of events that (⚠) can't even reliably distinguish
  delete from rename. A spurious `unlink` from an atomic-save can't fool a stat, because the
  rename (⚠) left the path present, so the stat sees it there.
- Therefore: an `unlink` event does **not** trigger a delete. It triggers a *debounced
  reconcile*. At the moment sync is about to act on a candidate deletion, it **re-stats the
  path**; the `docs.delete` fires only if the path is genuinely absent at that moment.

**Where a minimum act-delay / window still matters.** A stat is only as good as its timing.
The one case a bare stat can misread (⚠) is a *non-atomic* rewrite (truncate-and-rewrite in
place, or a delete-then-write done as two separate operations) — there the file really is
transiently absent, so a stat firing mid-rewrite would wrongly see a deletion. The debounce
window addresses this by deciding *when* to look: hold the candidate until the burst of
activity has settled, **then** stat, so any in-progress rewrite has completed. This makes
the exact window length a **latency knob, not a correctness knob** — too short a window just
falls through to the same-pass stat, and any residual mistake is corrected by the next
reconcile.

So the division of labor is:

- **Window/debounce** → answers *when do we check* (after things quiet down).
- **Stat** → answers *is it actually gone* (the delete verdict).
- **Reconcile set-diff** → the backstop that catches deletions from when sync was off, and
  the ultimate corrective for any wrong guess.

**Safety cap regardless of the above: `--max-delete <n>` (and/or a percentage).** Refuse any
single pass that would delete more than the cap, and require re-running with a raised cap or
explicit confirmation. This is the real guard against the catastrophic case — sync pointed
at the wrong directory, or an unmounted drive making *every* file look deleted at once — and
it holds no matter how the per-file detection above shakes out. Leaning on this as the
non-negotiable rail.

**Deferred enhancement — content-hash move detection.** Because a rename surfaces as
`unlink(a)` + `create(b)` on *different* paths, same-path logic won't pair them. But if the
just-removed `a`'s `$content_hash` reappears at `b` within the window, sync could emit a
single `docs.put` (a move that preserves the doc's identity and history) instead of
delete-`a` + create-`b`. This is exactly the "rename detection by content" listed as out of
scope in §1; the window is the mechanism that would later make it feasible. Not in this
branch.

### 3.6 Config defaults

`CliConfig` (`src/cli/config.ts:18`) gains an optional nested block so defaults persist
without repeating flags:

```jsonc
{
  "server": "https://…",
  "repo": "notes",
  "sync": {
    "interval": "5s",
    "debounce": "500ms",
    "settle": "0",
    "max_delete": 50,
    "exclude": ["**/.git/**", "**/node_modules/**"]
  }
}
```

Set via `mrplex config set-sync <key> <value>` (peer of `set-server`/`set-repo`,
`src/cli/main.ts:790`). Precedence per setting: flag → `MRPLEX_SYNC_*` env → config →
built-in default. Flags always win, so `--debounce 0` overrides a persisted value.

## 4. Ordering / milestones

1. **Intrinsic core** — `content-hash.ts`, migration `0002`, `version_insert` computes and
   stores, `VersionRow` gains the field. Round-trip test in `frontmatter.test.ts` /
   `content-hash.test.ts` covering the three byte-exactness traps (§2.1) and asserting
   `contentHashOfFile(injectedRead) === storedHash` end-to-end. **This is the correctness
   gate — validate it before anything downstream depends on it.**
2. **Read injection + filterable intrinsic** — generalize the three injection sites (§2.4),
   wire the three compiler/doc sites (§2.5), let `query-syntax.test.ts` force the doc update.
3. **Query `select` projection** — `QuerySpec.select` (default `["$path"]`), the `QueryHit`
   `$`-prefixed shape (§2.6–2.7), across kernel + MCP + CLI (`-s/--select`) + REST. Tests:
   projected keys carry `$`, a frontmatter key named `path`/`repo` coexists with
   `$path`/`$repo`, unknown `$name` in select errors, `$body` returned only when selected,
   default omits everything but `$path`.
4. **Backfill** — `mrplex hash backfill`; compute-on-read fallback for null columns.
5. **Sync one-shot** — `src/sync/` reconcile using the projected query, `mrplex sync
   --once`, `--dry-run`, include/exclude. Deletion here is **reconcile set-diff only**
   (§3.5 source of truth), gated by `--delete` and capped by `--max-delete`. Integration
   test against a local kernel: create/put/skip/delete diff, `stale_prev` retry, max-delete
   refusal.
6. **Watch loop** — `fs.watch`, debounce, settle, interval, single-flight; config defaults
   and `set-sync`. The `unlink`-driven delete fast-path (stat-confirm, §3.5) lands here and
   is **gated on the expert review** flagged in §3.5 / §5 — until then the watch loop
   triggers reconciles but deletion still comes only from the set-diff.

## 5. Open decisions

- **Should the flat `Version` wire type eventually adopt `$`-prefixed system fields too?**
  This branch prefixes only the new projected `QueryHit` (§2.7), where system and user names
  genuinely collide. Renaming `Version`'s fields (`version_id` → `$version_id`, etc.) would
  align the whole surface with the principle but is a breaking change across `docs.get`,
  `docs.history`, REST, and every client. Deferred; revisit as its own migration if the
  half-and-half state proves confusing.
- **Watcher dependency.** Native `fs.watch` recursive is supported on macOS/Windows but not
  historically on Linux (per-file only). If Linux recursive watching proves unreliable,
  either add `chokidar` (a dependency the repo has so far avoided) or lean on `--interval`
  as the Linux story. Leaning interval-first to stay dependency-free.
- **Delete semantics.** `docs.delete` moves to `:deleted/…` (recoverable), so `--delete` is
  not destructive server-side. Still opt-in, matching rsync's `--delete` ergonomics.
- **⚠ Deletion detection needs expert review (§3.5).** The `unlink`-is-a-hint /
  stat-is-the-verdict model rests on unverified claims about atomic-rename saves and
  `fs.watch` fidelity across platforms. Confirm with a filesystem expert before
  implementing the watch-driven delete path. The reconcile set-diff + `--max-delete` cap
  are safe independent of how that review lands, so they can proceed first; the `unlink`
  fast-path is the part gated on review.
