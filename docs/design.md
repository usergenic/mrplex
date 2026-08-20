# mrplex — Design Document

**mrplex** — *Markdown Repos, plexed.* A hub for versioned markdown.

Status: **Working draft.** `[OPEN]` = unresolved. `[ASSUMPTION]` = default to challenge.

## 1. Goal

`mrplex` is a queryable, versioned store for Markdown documents with YAML frontmatter. Clients talk to it over two HTTP surfaces sharing one core:

- **MCP** — a Model Context Protocol server: Streamable HTTP transport at `/mcp`, plus an optional STDIO transport enabled at server startup (§6.2). Primary interface for LLM agents.
- **REST** — resource-oriented routes (`GET /repos/{repo}/docs/{path}`, `PUT`, `DELETE`, `MOVE`). Primary interface for humans, `curl`, and anything HTTP-ecosystem-shaped (caches, CDNs, `If-Match`).

Also included: a first-party `mrplex` **CLI** (§7.3) — a thin client over the MCP surface with ergonomic command flags in place of JSON envelopes.

Every update is an insert; nothing is overwritten; any past state is addressable.

External-source bridging (git repos, GitHub) is deliberately post-v1, as are WebDAV mounting and point-in-time (`as_of`) reads — see §11.

## 2. Non-goals (v1)

- Not a Markdown renderer.
- Not a wiki UI.
- Not a general document store — only Markdown-with-YAML-frontmatter.
- Not a git mirror — no adapters, no sync. mrplex stands alone.
- Not a mountable network filesystem — no WebDAV in v1; the gateway design is specified for later in §11.1.

## 3. Data model

### 3.1 Concepts

- **Repo** — a container. Namespaces document paths and scopes queries. Also carries an optional path-config override (§3.5).
- **Document** — an identity for a Markdown file. Persists across renames and delete/restore cycles.
- **Version** — an immutable snapshot of a document: path, frontmatter (raw + parsed, §3.2), body, author, timestamp, and links to the previous and next versions (`next_id` null = current). Every write inserts one.
- **Deletion** — not a distinct row type. A delete is a `docs.put` that moves the document to a **system-namespace** path under `<system-sigil>deleted/` (§3.5). Restore is a `docs.put` that moves it back out. Same document identity throughout; history is continuous.

### 3.2 Schema

```sql
users (
  id          integer primary key,
  slug        text unique not null,     -- API-facing; renameable
  created_at  timestamp not null
)

repos (
  id          integer primary key,
  slug        text unique not null,     -- API-facing; renameable
  path_config json    null,             -- per-repo path/sigil overrides; null = inherit server (§3.5)
  created_at  timestamp not null
)

documents (
  id      integer primary key,
  repo_id integer not null references repos(id)
)

versions (
  id          integer primary key,
  document_id integer not null references documents(id),
  repo_id     integer not null references repos(id),     -- denormalized; enables the live-path index
  prev_id     integer     null references versions(id),  -- null iff first version
  next_id     integer     null references versions(id),  -- null iff current
  path            text not null,                         -- path AT this version (may be under a system sigil, §3.5)
  frontmatter_raw text not null,                         -- verbatim YAML source (may be empty); round-trips byte-exact
  frontmatter     json not null,                         -- parsed form; a derived query index of frontmatter_raw
  body            text not null,
  author_id   integer not null references users(id),
  created_at  timestamp not null
)

-- exactly one current version per document
create unique index on versions (document_id) where next_id is null;

-- at most one live document per path in a repo
-- (deleted docs are still "live" — they just live under a :deleted/... path; §3.5)
create unique index on versions (repo_id, path) where next_id is null;

chunks (
  version_id integer not null references versions(id),
  ix         integer not null,
  text       text not null,
  text_hash  text not null,                                 -- sha-256 of text; with model, the embedding-reuse key (§5.3)
  model      text not null,                                 -- embedding model that produced the vector (§5.3)
  embedding  vector,                                        -- pgvector / sqlite-vec
  primary key (version_id, ix)
)

api_tokens (
  id           integer primary key,
  user_id      integer not null references users(id),
  secret_hash  text    not null,                            -- sha-256 of the token secret (§8.1); indexed for lookup
  label        text,                                        -- human-readable, e.g. "obsidian plugin"
  scopes       json    not null,                            -- see §8
  expires_at   timestamp,                                   -- null = no expiry
  revoked_at   timestamp,                                   -- null = active
  created_at   timestamp not null,
  last_used_at timestamp
)

embedding_backlog (
  version_id    integer primary key references versions(id),  -- pending/failed embedding work (§5.3)
  attempts      integer not null,
  last_error    text,
  next_retry_at timestamp
)

-- FTS index on versions.body
```

`prev_id` and `next_id` are inverse links on the fast-forward version chain: writing a new version `Y` with `prev_id = X` also sets `X.next_id = Y` in the same transaction. The two partial indexes are the schema-level guarantees behind §4 — no application code can bypass them.

**Frontmatter is stored twice by design.** `frontmatter_raw` is the byte-verbatim YAML source — comments, key order, and formatting preserved — and is what `Accept: text/markdown` reads return, so an editor gets back exactly what it wrote. `frontmatter` is the JSON parsed from it at write time: a query index (§5), never re-serialized back to users. Writes supply **exactly one** representation — raw (server parses it; `frontmatter_invalid` on error) or structured (server serializes canonical YAML into `frontmatter_raw`) — and the other is derived.

### 3.3 Identifier discipline

Integer primary keys are internal — **they never cross the wire**. FKs use them so renames don't rewrite rows. The API exposes:

- **Slugs** — for users and repos. Globally unique. Renameable via `.rename` methods.
- **Opaque `version_id` strings** — clients echo them back to reference a version; they don't parse or construct them. Server chooses the representation.

Multitenancy would partition slug uniqueness later without changing the model.

### 3.4 History, deletion, restore

No derived "tree" table — the partial index on `(document_id) where next_id is null` makes current-version lookup a single index hit, and history is walked over the `prev_id`/`next_id` chain. Point-in-time reads ("state at time T") are deferred to post-v1 — see §11.

Renames stay on the same `document_id` with a new `path` (§4.1). **Deletion** and **restore** are the same primitive: a `docs.put` that moves the document to or from a system-namespace path.

- **Delete** — the kernel moves the document into the system namespace, inserting the superseded version's id before the file extension: `path/to/document.md` at version `v45129` becomes `<system-sigil>deleted/path/to/document-v45129.md`. `<system-sigil>` is the first entry of the effective `system_sigils` config (§3.5). The extension is everything from the final segment's last `.`; a leading dot doesn't count, so extensionless files and dotfiles get a plain trailing suffix (`README` → `README-v45129`, `.gitignore` → `.gitignore-v45129`). Keeping the extension terminal means type detection, syntax highlighting, and globs like `**/*.md` keep working on trashed docs. Deterministic, unique (version ids are unique and the suffix is always appended), and browsable via `include_system: true` queries.
- **Restore** — a `docs.put` back to a user-territory path with `prev_version_id` pointing at the trashed version. Same document identity; history is one continuous chain.
- **Create-at-freed-path is not restore.** Once a document is in `:deleted/…`, its old user-territory path is free. A fresh `docs.create` at that path makes a **new document** with a new `document_id`. To continue the old identity, the caller uses `docs.put` with the trashed version's `version_id` as `prev` — the kernel already knows this is the same document from the version chain.

This eliminates the tombstone concept entirely: every version has real content at a real path; "deletedness" is just "currently lives under a system sigil."

**Repos and users delete the same way.** `repos.delete` is a kernel rename of the slug into the system namespace — `<system-sigil>deleted-{slug}-{suffix}`, where `{suffix}` is a short server-chosen uniquifier — the document-deletion primitive applied one level up. The old slug is freed, the documents inside are untouched, and `repos.list` hides system-namespaced repos by default (`include_system: true` opts in). Restore is `repos.rename` back to a user-territory slug. While deleted, a repo rejects document writes and answers `repo_not_found` to non-admin callers. `users.delete` is the same rename and additionally revokes all of the user's tokens; historical attribution via `author_id` is untouched — the user row never goes away. Deleting an already-deleted repo, user, or document is a **no-op**: all deletes are idempotent.

### 3.5 Paths: structure, validation, and sigils

Paths are `/`-separated segments. Two categories of rule govern them: **structural** (universal filesystem semantics, not configurable) and **stylistic** (configurable per server and per repo).

#### 3.5.1 Structural constants

Fixed in code, referenced by name throughout the system. These are grammar, not policy:

```ts
PATH_SEPARATOR   = "/"    // segment separator
CURRENT_SEGMENT  = "."    // reserved; cannot appear as a whole segment
PARENT_SEGMENT   = ".."   // reserved; cannot appear as a whole segment
EMPTY_SEGMENT    = ""     // no leading/trailing '/', no '//'
```

A segment equal to `CURRENT_SEGMENT`, `PARENT_SEGMENT`, or `EMPTY_SEGMENT` is invalid on any write. These meanings are too canonical to override — an operator who wants `.` to mean something else than "current" would break every mental model callers bring with them.

Also structural: paths and slugs have **case-insensitive, Unicode-normalized identity** but **case- and form-preserving storage**. Storage keeps the author's exact bytes (`versions.path`, `repos.slug`, `users.slug` are verbatim, so the §3.2 byte-exact round-trip holds); identity — uniqueness and by-key lookup — runs off a derived normalized key (`normalizeKey` = NFC + locale-invariant lowercase, `src/kernel/casefold.ts`) held in a shadow column (`path_norm`/`slug_norm`) with its own unique partial index. So `Alice.md` and `alice.md` cannot both be live in a repo, `docs.get NOTES/ALICE.md` resolves the document authored at `notes/Alice.md` (returning the stored case), and NFC/NFD spellings of the same text address the same document. Normalization is computed **in the kernel**, never via SQL `lower()`/`COLLATE`/`citext` — SQLite's `lower()` is ASCII-only while Postgres's is locale-aware, so a functional index would silently diverge and break §7.2 parity; folding in one JS function keeps the adapters identical. The chosen fold strength (NFC + `toLowerCase`) covers accented Latin/Greek/Cyrillic but not ß→ss, ligatures, or Greek final-sigma; strengthening to full Unicode case-folding later is additive (recompute the key via backfill). The normalized key is an internal index artifact (§3.3-style) — never surfaced on the wire, and CEL `$path` reads the stored path, not the key.

#### 3.5.2 Configurable policy

Three fields, layered across three tiers:

```yaml
path:
  disallowed_chars: ["\\", "<", ">", ":", "|", "?", "\""]   # forbidden anywhere in a user-written segment
  system_sigils:    [":"]                                     # leading prefixes marking kernel-owned segments
  hidden_sigils:    ["."]                                     # leading prefixes marking user-hidden segments
```

Defaults follow Obsidian's cross-platform-safe rule (minus `/`). `disallowed_chars` is a list of single characters (each is forbidden anywhere in a segment). The sigil lists are lists of non-empty **strings** — leading prefixes, typically one character (`:`, `.`) but legally longer (`__sys_`, `~$`).

**Tier layering:**

1. **Hardcoded defaults** in code — one constant, source of truth for tests and docs.
2. **Server config** — operator-set at startup; overrides hardcoded defaults wholesale (per field).
3. **Per-repo override** — stored on `repos.path_config` (§3.2). Non-null replaces the *field it sets*, not deep-merged. A repo that sets `hidden_sigils: [".", "_"]` sees exactly that; `disallowed_chars` and `system_sigils` still inherit from the server.

**Startup invariants** (server refuses to start otherwise):

- Every `disallowed_chars` entry is a single character; every sigil is a non-empty string.
- `PATH_SEPARATOR` appears in no entry of any list.
- **No sigil is a prefix of any other sigil, across the union of both lists.** With multi-character sigils, plain set-disjointness isn't enough — system `":"` alongside hidden `":h"` would classify segment `:hfoo` both ways. Forbidding prefix relations makes segment classification unambiguous (and subsumes the old `system ∩ hidden = ∅` rule, since equality is a prefix relation).
- No hidden sigil contains a character from `disallowed_chars` (users must be able to write the prefixes they use to hide their own folders). System sigils may — users never write those.
- Both sigil lists are non-empty (otherwise the kernel has no canonical sigil to emit under).

Path config is **setup-time configuration**, not a runtime toggle. Changing sigils over a live corpus can orphan system paths and re-expose hidden ones (§3.5.4); beyond the advisory warnings on `set_path_config` (§3.5.3), the system deliberately adds no further guard rails.

#### 3.5.3 Segment validation

Applied at `docs.create` and `docs.put`, per segment:

1. Segment is not `EMPTY_SEGMENT`, `CURRENT_SEGMENT`, or `PARENT_SEGMENT`.
2. Segment does not start with any effective system sigil (would collide with kernel-emitted paths).
3. No character in the segment is in the effective `disallowed_chars`.

Failure at any step → `path_invalid`.

`[OPEN]` Resource caps: maximum segment/path length and maximum document size — likely server config with generous defaults. Note the deletion suffix (§3.4) lengthens paths, so the user-facing path maximum sits slightly below the hard cap.

Validation is **write-time only**. Existing versions keep whatever path they had; history and diff work regardless of current config. Tightening config *does not* rewrite or hide existing rows — it only affects future writes. This is the same rule the system uses for slug validation on rename.

**Warning on tightening:** `repos.set_path_config` returns an advisory list of currently-live paths in the repo that would fail new validation. These paths remain readable but can no longer be `put` at their current path — the only way to fix them is to move them to a valid path.

#### 3.5.4 Sigil semantics: set for input, first for output

The sigil lists are **sets for validation** — any listed sigil marks a segment as system-owned or hidden. The kernel is **canonical on emission** — when it constructs a system path it always uses `system_sigils[0]`:

```ts
canonicalSystemSigil(cfg) = cfg.system_sigils[0]
canonicalHiddenSigil(cfg) = cfg.hidden_sigils[0]

// deletion target (version id inserted before the extension, §3.4):
systemPath(cfg, "deleted", withVersionSuffix(originalPath, versionId))
  // = ":deleted/notes/foo-v45129.md"  when system_sigils[0] === ":"
```

**Why multiple accepted sigils.** Steady-state deployments use exactly one system sigil and one hidden sigil. The list form exists for two use cases:

- **Migration.** An operator moving from `:` to `#` sets `system_sigils: ["#", ":"]`. New system paths land under `#deleted/…`; existing `:deleted/…` paths remain valid, remain excluded from default queries, and remain unwritable by users. Once cleared, `:` can be dropped from config.
- **Legacy compatibility.** A repo importing content from a system that already used `_hidden/` for hidden files can set `hidden_sigils: [".", "_"]` and both conventions coexist.

**Semantic equivalence across accepted sigils.** For any kernel operation that looks up system state by *logical name* (e.g., a future `<system>/config/<key>`), paths under any accepted sigil are treated as the same logical location. If duplicates exist across sigils (bug, manual DB surgery, cross-tool disagreement), the kernel resolves by **newest-wins with a warning** — the most recently written version is the effective value, and a `mrplex system doctor` report surfaces the duplicates for operator cleanup.

Deletion paths key on the original path plus the superseded version id (§3.4), not a logical name, so duplicate-across-sigils is not a real concern for `:deleted/`.

#### 3.5.5 Query default exclusion

Filter, text, and rank all exclude any document whose current `path` has **any segment** starting with a sigil in `hidden_sigils ∪ system_sigils`. Two opt-in flags on the query spec restore visibility:

- `include_hidden: true` — surfaces paths with hidden-sigil segments.
- `include_system: true` — surfaces paths with system-sigil segments.

Compiled to SQL as one `NOT (path LIKE 'X%' OR path LIKE '%/X%')` clause per configured sigil. Cross-repo queries evaluate each repo's effective config independently.

#### 3.5.6 Slug validation

Repo and user slugs are validated against **server-level** path config (per-repo config does not apply — the slug is validated before any repo has a chance to override, and users are global). Rules:

- No character in `PATH_SEPARATOR`, `disallowed_chars`.
- Does not start with any sigil in `system_sigils` or `hidden_sigils`.
- Slug is not `CURRENT_SEGMENT`, `PARENT_SEGMENT`, or `EMPTY_SEGMENT`.
- Additional slug-hygiene rules (max length, no leading/trailing whitespace) apply on top.

Validation is write-time-only: existing slugs are grandfathered under old rules until renamed, at which point the new slug must pass current-config validation. Failure → `slug_invalid`.

## 4. Writes: optimistic concurrency

**Every write must supply the `prev` version it observed. If that `prev` is not the current version, the write is rejected. The server never merges.**

That's the whole model. Merge policy is a client concern — an Obsidian plugin, a CLI, an agent, and a bulk importer all want different strategies, and any of them can implement their own on top of this primitive.

### 4.1 Rules

1. `docs.put` and `docs.delete` both take `prev_version_id`. It must equal the current version. Otherwise: `stale_prev` error carrying the current version.
2. `docs.create` takes no `prev`. If a live document already exists at the path: `create_conflict` error carrying the current version (the caller can retry as `put`).
3. `docs.put`'s `path` argument is the **destination path**. If it equals `prev`'s path, the write is an in-place update. If it differs, the write is a move — the same document advances to the new path in one operation, carrying whatever body/frontmatter changes were sent along.
4. `docs.delete` is kernel-side sugar for `docs.put` to the §3.4 deletion path (`<system-sigil>deleted/…` with `-{prev_version_id}` inserted before the extension) with body and frontmatter unchanged. Users cannot directly write at any system-sigil path (§3.5); the kernel bypasses that check for its own deletion move. Restore is a plain `docs.put` back to a user-territory path. Deleting an already-deleted document (`prev` already under a system-sigil path) is a **no-op**: nothing is written and the current version is returned unchanged — deletion is idempotent, a natural match for HTTP `DELETE`.
5. Writes are single-writer per repo — races resolve deterministically.

### 4.2 One verb, several intents

Folding move and delete into `docs.put` collapses what would otherwise be three verbs into one, because `prev_version_id` already identifies the document's current location — the caller has necessarily observed the old path. The `path` argument is the destination.

- Same-path put = update.
- Different user-territory path = move (optionally combined with content change).
- Kernel-emitted system-namespace path = deletion, invoked via the `docs.delete` sugar.
- User-territory path with `prev` under a system-namespace path = restore.

`docs.delete` remains a distinct verb at the API layer for ergonomics and permission auditing; internally it is a `docs.put`.

The trade-off: a caller who wants to *move only* still sends a `docs.put` with unchanged body/frontmatter. That's a minor ergonomic wart the CLI can hide, and if it becomes common enough to matter we can add a rename-only verb later without breaking the current shape.

### 4.3 Error catalog

Auth/access-control errors are omitted here — see §8.

**Concurrency** — state moved under you.

- `stale_prev` — provided `prev_version_id` is no longer the current version of its document.
  Emitted by: `docs.put`, `docs.delete`.
  Data: `{ current_version_id, current_path, submitted_prev_version_id }` — `current_path` lets clients see whether the document has since been moved (including moved into `:deleted/…` by another actor). If the caller's read scope does not cover `current_path`, it is redacted (`null`) — the error still proves staleness without revealing where the document went.

**Slot conflicts** — the target slot is already occupied.

- `create_conflict` — `docs.create` at a path that already holds a live document.
  Data: `{ repo, path, current_version_id }`.
- `path_taken` — `docs.put` destination path already holds a *different* live document (i.e., not the one identified by `prev_version_id`).
  Emitted by: `docs.put`.
  Data: `{ repo, path, current_version_id }`.
- `slug_taken` — repo or user slug already in use.
  Emitted by: `repos.create`, `repos.rename`, `users.create`, `users.rename`.
  Data: `{ slug }`.

**Reference errors** — identifiers resolve but don't fit the call.

- `version_not_in_document` — a `version_id` (in `diff`) doesn't belong to the document at `(repo, path)`.
  Emitted by: `docs.diff`.

**Not found.**

- `repo_not_found` — no repo with that slug.
- `user_not_found` — no user with that slug.
- `doc_not_found` — no live document at `(repo, path)`.
  Emitted by: `docs.get`, `docs.diff`.
- `version_not_found` — `version_id` (or `prev_version_id`) doesn't exist.

Note: `docs.put` never emits `doc_not_found` — the document is identified by `prev_version_id`, and a missing prev fails earlier as `version_not_found`.

**Validation** — input malformed.

- `slug_invalid` — fails server-level slug validation (§3.5.6): illegal characters, sigil-leading, empty, `.`/`..`, too long, etc.
- `path_invalid` — segment fails validation (§3.5.3): illegal character, sigil-leading (user attempting to write at a system path), reserved segment (`.`, `..`), empty component, or malformed structure.
- `frontmatter_invalid` — raw frontmatter fails YAML parsing or parses to something other than a map; or a write supplies both `frontmatter` and `frontmatter_raw` (§3.2 requires exactly one).
- `filter_invalid` — CEL parse or type error.

### 4.4 Authorship

Derived from the authenticated caller's token → user mapping. Never trusted from the request body.

## 5. Query

Three composable modes: **filter** (CEL over frontmatter fields and `$`-intrinsics), **text** (FTS over body), **rank** (semantic over embeddings). When more than one is present they intersect; ordering follows §5.1.

### 5.1 Query spec

```json
{
  "repo":            "notes",
  "filter":          "status == 'draft' && 'pricing' in list(tags)",
  "text":            "pricing OR fees",
  "rank":            "tiered SaaS pricing",
  "limit":           20,
  "include_hidden":  false,
  "include_system":  false
}
```

`repo` follows the scalar-or-list convention (§5.2): a slug, a glob, or a list thereof, matched against the caller's bound repos; omitted = every repo the caller's scopes cover (§8.2). Cross-repo queries evaluate each repo's effective path config independently (§3.5.5).

CEL scope: frontmatter fields are top-level (`status`, `tags`). **Intrinsic document properties are `$`-prefixed** — `$path`, `$updated_at`, `$body` — mirroring the sigil idea from §3.5: a marker character separates kernel-owned names from user territory, so intrinsics can never collide with user-defined frontmatter keys (a document with a frontmatter field literally named `path` stays queryable as bare `path`). `$updated_at` names the current version's timestamp — filters only ever see current versions, so this reads as "the doc's last update time" rather than the more literal but less useful "when this version row was written." Two differences from path sigils: the `$` marker is a **fixed grammar constant** in the §3.5.1 sense (grammar, not policy — a configurable marker would make the same filter string parse differently per repo), and it's `$` rather than `:` because `:` collides with CEL's ternary operator (`a ? b :path` is ambiguous) while `$` is unused by standard CEL — implemented via a small string-aware preprocessor that mangles `$foo` before the parser sees it (§7.1). A side benefit: the intrinsic namespace is forever open — new intrinsics (`$author`, `$repo`, …) can be added later without breaking any existing filter.

FTS is a first-class feature — markdown is the whole product, searching its prose is table stakes. The backend is **adapter-owned**: SQLite adapters use FTS5, Postgres adapters use `tsvector`. Result sets are portable across adapters; ranking scores are not (§7.2 parity table).

**Search indexes cover current versions only.** Indexing a new version evicts the document's previous entry from the FTS index, and `rank` returns hits from current versions only (historical chunk rows persist for dedup, §5.3, but aren't searched). This is consistent with `as_of` being deferred — historical search belongs to the time-machine feature (§11).

**Result ordering:** rank score when `rank` is present, else FTS score when `text` is present, else `$updated_at` descending. `[OPEN]` Cursor pagination (follow `docs.history`'s `before` pattern); v1 is `limit`-only.

**Default exclusion of hidden and system paths.** By default (both flags `false`), the compiled query drops any document whose current `path` contains any segment starting with a hidden or system sigil (§3.5). This applies uniformly to `filter`, `text`, and `rank`. Set `include_hidden: true` to surface `.<seg>/…` paths; set `include_system: true` to surface `:<seg>/…` paths — this is how a client browses `:deleted/` to find something to restore.

Compiled to SQL: for each accepted sigil `X` in the effective config, one clause `NOT (path LIKE 'X%' OR path LIKE '%/X%')`, ANDed into the query — string-matching only, no generated columns in v1. Cross-repo queries evaluate each repo's effective config independently.

**Perf shape of sigil exclusion.** The concern: as trash accumulates, every default query pays a filter cost against `:deleted/` rows. In practice this is smaller than it looks:

- **Bounded by the live-set index.** All queries run on top of the partial index `versions(repo_id, path) where next_id is null`. Its size is the count of *currently-live* documents (including trashed-current ones), not total version history. Trash growth is linear in delete count, not in edit count or total content size.
- **`LIKE 'X%'` is index-friendly with a rewrite.** At query-compile time, `path LIKE ':%'` becomes a range predicate `path >= ':' AND path < ';'` — a B-tree range scan on both PG and SQLite, no collation or pragma dependencies. The rewrite generalizes to multi-character sigils (§3.5.2): prefix `P` → `path >= P AND path < next(P)`, where `next` increments `P`'s last byte. The compiler is expected to do this rewrite for the leading-sigil check; the `%/:%` middle-of-path variant still needs `LIKE`, but that form is rare in practice (users don't write paths with `:` mid-segment because `:` is in `disallowed_chars`).
- **No boolean row-time columns.** We considered `hidden` / `system` boolean columns computed at insert. Rejected: those flags are a decision about *how the caller wants to view rows* (which depends on the querying repo's current config), not a property of the row itself. A repo that swaps `hidden_sigils` from `["."]` to `[".", "_"]` should immediately treat existing `_foo/…` paths as hidden without a data rewrite. Query-time decision, not row-time.

`[OPEN]` **Materialized prefix index** for very large corpora — e.g., `CREATE INDEX ON versions ((substr(path, 1, 1))) WHERE next_id IS NULL` (PG) or a generated column with an index (SQLite). Adds one prefix column that's cheap to maintain (per-row-write, constant work) and answers sigil membership directly. Deferred until benchmarks demand it, because it introduces a migration on config change (the set of "prefix chars that matter" is derived from config).

`[OPEN]` Raw SQL escape hatch. Leaning no.

### 5.2 Polymorphic frontmatter fields

Markdown tooling has long blessed frontmatter fields that are *either* a scalar or a list of scalars — Hugo, Jekyll, and Obsidian all accept `tags: pricing` and `tags: [pricing, saas]` interchangeably. Users writing queries shouldn't have to know which form a given document happens to use.

Rather than overload CEL operators (which either requires grammar extensions or introduces semantic surprises), mrplex adds a single coercion function:

```cel
list(x) -> list<dyn>
```

- `list([...])` returns the list unchanged.
- `list(scalar)` returns `[scalar]`.
- `list(null)` returns `[]`.
- `list(missing_field)` returns `[]` — missing and null coerce identically so `size()` and iteration are always safe.

Callers wrap polymorphic fields in `list()` and use CEL's standard operators:

```cel
"pricing" in list(tags)                     -- membership, scalar or list
size(list(tags)) > 2                        -- count, uniform across shapes
list(tags).all(t, t.startsWith("p"))        -- iterate
list(authors).exists(a, a == "alice")       -- explicit any
```

This costs five extra characters over an operator overload and buys: zero grammar changes, zero new operator tokens, zero preprocessor, no compile-time guards against string-substring collision, and full composition with every CEL builtin.

**Substring intent is unaffected.** CEL's built-in `contains(haystack, needle)` continues to mean substring match on strings. Callers who want substring write `contains(body, "pricing")`; callers who want membership write `"pricing" in list(tags)`. Different verbs for different intents.

**SQL translation.** `list(field)` doesn't materialize on the SQL side — it's a compile-time hint that the following expression should compile against both shapes. `"pricing" in list(tags)` becomes:

*Postgres (jsonb):*

```sql
frontmatter->'tags' = '"pricing"'::jsonb           -- scalar branch
OR frontmatter->'tags' @> '["pricing"]'::jsonb     -- list branch
```

Both operators are served by a single GIN index on `frontmatter`. Missing key → both branches false → predicate false. Number or object at that key → both branches false. No runtime type-checking needed.

*SQLite (json1):*

```sql
json_extract(frontmatter, '$.tags') = 'pricing'                                -- scalar
OR EXISTS (SELECT 1 FROM json_each(frontmatter, '$.tags') WHERE value = 'pricing')  -- list
```

Expression indexes on the scalar branch; the list branch scans in v1.

`[OPEN]` Compile-time query normalization — flatten repeated `in` checks against the same `list(...)` expression into a single `@>` with a multi-element array (e.g. `"a" in list(tags) && "b" in list(tags)` → `tags @> '["a","b"]'::jsonb`) to keep filters cheap as they grow.

### 5.3 Embedding hook

mrplex does **not** call an LLM or embedding provider directly. The server has no bundled model, no API key management, no vendor SDKs. Instead it defines a hook contract and lets the operator wire in whatever model they want — OpenAI, a local `llama.cpp` process, `text-embedding-3-small`, a self-hosted sentence-transformer, or a stub returning zero vectors for dev.

This keeps the server small, sidesteps a moving target (embedding models rev quarterly), and puts the choice — cost, provider, dimension, licensing — with the operator.

**Hook contract.** The hook is a callable that takes a batch of chunk texts and returns a batch of vectors:

```types
embed(chunks: string[]) → { vectors: float[][], model: string, dim: int }
```

- `vectors[i]` corresponds to `chunks[i]`, same order, same length.
- `model` and `dim` are echoed on every call so the server can detect model changes and refuse mixed-dim writes to the `chunks` table.
- The hook is stateless from mrplex's perspective — batching, rate limiting, and retries live inside the hook implementation.

**Invocation shapes** (configured at server start, `[OPEN]` which subset ships in v1):

1. **HTTP endpoint** — `--embed-url http://localhost:8080/embed`. Server POSTs `{ chunks: [...] }` and expects the response above. Simplest to deploy; runs the model in a sidecar.
2. **Subprocess (STDIO)** — `--embed-cmd "path/to/embedder"`. Server writes JSON-lines requests to stdin, reads responses from stdout. No network hop; useful for local single-binary setups.
3. **In-process plugin** — a JS/TS module the operator drops into a known path and mrplex `require`s at startup. Zero overhead, but couples the plugin's dependencies to the server's process.

All three implement the same contract; the kernel doesn't know which is in play.

**Invocation timing.**

- **On write.** After `docs.create` / `docs.put` commits the version, the server enqueues it for embedding; a background worker chunks the body (chunking strategy is fixed and server-side; the hook only sees chunk text, not policy), calls the hook, and writes the returned vectors into `chunks`. This runs *outside* the write transaction (see failure behavior below).
- **On backfill.** A `mrplex embed backfill --repo <slug>` CLI command re-chunks and re-embeds current versions missing chunks — useful when configuring an embedding hook for the first time, or when swapping models.

**Failure behavior.** Embedding failure must not fail the write. A markdown store that rejects writes because an external model is down is a bad store. Instead:

- Version write commits regardless.
- If the hook is unreachable / errors / times out, the queue entry is retained in the `embedding_backlog` table (schema: `version_id`, `attempts`, `last_error`, `next_retry_at`) and retried with exponential backoff.
- Vector search silently skips documents without chunks — they don't appear in `rank` results but *do* appear in `filter` and `text` results (their body is still indexed for FTS).
- Operators can inspect backlog via `mrplex embed status` (`[OPEN]` exact shape).

**Write amplification and dedup.** The API imposes no write-frequency policy — save cadence and debouncing belong client-side, where the editing context lives. Server-side, three mechanisms keep rapid writers from translating one-to-one into embedding load:

- **Chunk dedup by content hash.** Chunks carry a `text_hash` (§3.2). Before calling the hook, the worker reuses the vector of any existing chunk with the same `(model, text_hash)` — in the common case, the previous version of the same document, where an edit touches one or two chunks and the rest are byte-identical. Only genuinely new chunk text reaches the hook.
- **Current-only embedding.** The worker embeds a version only if it is still current at dequeue time; a version superseded while queued is skipped (the superseding write enqueued its own entry), and in-flight hook calls for superseded versions are aborted where the transport allows. A burst of saves collapses to one embedding pass over the final state.
- **Rate limiting** is split per the contract: the worker paces dispatch; provider-specific limits, batching, and retries live inside the hook.

**Model changes.** If the hook starts returning a different `model` or `dim`, the server writes a warning and stores the new-model vectors alongside the old ones (the `chunks.model` column, §3.2 — the same column that keys dedup above). Vector search filters by current model. Backfill re-embeds under the new model on demand.

**Resolved — no default no-op hook.** A zero-vector hook wouldn't just hide misconfiguration: cosine distance against zero vectors is degenerate, so every rank query would return arbitrarily-ordered results shaped exactly like a working semantic search — silent garbage rather than a visible gap. Instead: the server starts cleanly with embedding *off* (worker idle), `rank` queries fail loudly with `rank_unavailable`, and dev/test workflows use a stub embedder script that returns deterministic real vectors (see [archive/m4-plan.md](archive/m4-plan.md), decisions 2 and 4).

## 6. Interfaces

Two HTTP surfaces (`/mcp` for MCP, resource routes for REST), both thin translation layers over one shared **kernel**. Each surface lives in its own module; adding a third surface later (gRPC, GraphQL) is another translation layer, not a rewrite.

### 6.1 Kernel

The kernel is the only place the write model, concurrency rules, and error catalog exist. Surfaces validate their envelope, resolve slugs to internal ids, delegate, and translate the result.

```types
kernel.repos.list(include_system?)                        → Repo[]
kernel.repos.get(slug)                                    → Repo
kernel.repos.create(slug)                                 → Repo
kernel.repos.rename(slug, new_slug)                       → Repo
kernel.repos.delete(slug, actor)                          → Repo   -- renames slug into the system namespace (§3.4); admin
kernel.repos.set_path_config(slug, config | null, actor)  → { repo: Repo, warnings: PathWarning[] }   -- see §3.5; null clears the override

kernel.users.list()                                       → User[]
kernel.users.create(slug)                                 → User
kernel.users.rename(slug, new_slug)                       → User
kernel.users.delete(slug, actor)                          → User   -- system-namespace rename + revokes the user's tokens (§3.4); admin

kernel.docs.get(repo, path)                               → Version   -- current version at path
kernel.docs.get_version(repo, version_id)                 → Version   -- any version, by id
kernel.docs.history(repo, path, limit?, before?)          → Version[]
kernel.docs.diff(repo, path, from, to)                    → UnifiedDiff

kernel.docs.create(repo, path, frontmatter?, body?, actor)               → Version
kernel.docs.put(repo, path, prev_version_id, frontmatter?, body?, actor) → Version   -- path may differ from prev (= move); prev under a system sigil + destination in user territory (= restore)
kernel.docs.delete(repo, path, prev_version_id, actor)                   → Version   -- sugar for docs.put to the §3.4 deletion path, e.g. :deleted/path/to/doc-v45129.md

kernel.tokens.list(actor)                                 → Token[]
kernel.tokens.create(label, scopes, expires_at?, actor)   → { token, meta }
kernel.tokens.revoke(token_id, actor)                     → Token

kernel.query(spec, actor)                                 → Version[]
```

Write calls accept frontmatter as either the structured form (`frontmatter`) or verbatim YAML source (`frontmatter_raw`) — exactly one per call (§3.2).

`actor` is a resolved `{ user_id, scopes }`, populated by the surface after it authenticates the caller — never taken from a request body. The kernel calls `authorize(actor, action, target)` before every operation (§8).

### 6.2 MCP surface (`/mcp`)

A protocol-true **Model Context Protocol** server — not a bespoke JSON-RPC API with MCP-ish naming. It implements the MCP lifecycle (`initialize`, capability negotiation) and exposes kernel operations as **tools** via `tools/list` / `tools/call`, each with a JSON Schema input definition, so any MCP client interoperates without custom glue.

**Transports:**

- **Streamable HTTP** at `/mcp` — the standard remote transport. Auth is the same `Authorization: Bearer` header as the REST surface (§8).
- **STDIO** — off by default; enabled at startup via server config or `--mcp-stdio`. There is no per-request auth channel on stdio, so the transport binds the whole session to one token supplied at launch (`--token` / `MRPLEX_TOKEN`); every call runs as that token's actor.

**Tools** mirror the kernel one-to-one. Names use underscores (many MCP clients restrict tool names to `[a-zA-Z0-9_-]`):

```rpc
repos_list(include_system?)                              → Repo[]
repos_get(repo)                                          → Repo
repos_create(repo)                                       → Repo
repos_rename(repo, new_repo)                             → Repo
repos_delete(repo)                                       → Repo   // renames slug into the system namespace (§3.4)
repos_set_path_config(repo, config | null)               → { repo: Repo, warnings: PathWarning[] }

users_list()                                             → User[]
users_create(user)                                       → User
users_rename(user, new_user)                             → User
users_delete(user)                                       → User   // system-namespace rename + token revocation (§3.4)

docs_get(repo, path)                                     → Version
docs_get_version(repo, version_id)                       → Version
docs_history(repo, path, limit?, before?)                → Version[]
docs_diff(repo, path, from, to)                          → UnifiedDiff

docs_create(repo, path, frontmatter?, body?)               → Version
docs_put(repo, path, prev_version_id, frontmatter?, body?) → Version   // path may differ from prev (= move); prev under system sigil + dest in user territory (= restore)
docs_delete(repo, path, prev_version_id)                   → Version   // sugar; kernel moves to the §3.4 deletion path, e.g. :deleted/path/to/doc-v45129.md

tokens_list()                                            → Token[]
tokens_create(label, scopes, expires_at?)                → { token, meta }
tokens_revoke(token_id)                                  → Token

query(spec)                                              → Version[]
```

As at the kernel, `docs_create` / `docs_put` accept frontmatter as either `frontmatter` (structured) or `frontmatter_raw` (verbatim YAML) — exactly one (§3.2).

**Results and errors.** Tool results carry `structuredContent` (the wire types of §6.4) plus a text rendering. Kernel errors (§4.3, §8.4) are returned **in-band** as tool errors — `isError: true` with `{ code, data }` in the content — so an agent can read `stale_prev` and retry with the attached current version. JSON-RPC protocol errors are reserved for transport/envelope problems (malformed request, unknown tool).

`[OPEN]` Whether to also expose documents as MCP **resources** (`mrplex://{repo}/{path}`) for read-side ergonomics. Tools are sufficient for v1; resources are additive.

### 6.3 REST surface

Same operations, exposed as resources. `version_id` is the ETag; `If-Match` is the optimistic-concurrency check. HTTP caching semantics (304, ETag, `If-None-Match`) work naturally over immutable content.

```rest
GET     /repos?include_system=                          → Repo[]
POST    /repos                     { slug }             → Repo
GET     /repos/{repo}                                   → Repo
MOVE    /repos/{repo}              Destination: /repos/{new_repo}   → Repo
DELETE  /repos/{repo}                                   → Repo (kernel renames slug into the system namespace; §3.4)
PUT     /repos/{repo}/config       { path_config | null }         → { repo: Repo, warnings: PathWarning[] }  -- see §3.5; null clears

GET     /users                                          → User[]
POST    /users                     { slug }             → User
MOVE    /users/{user}              Destination: /users/{new_user}   → User
DELETE  /users/{user}                                   → User (system-namespace rename + token revocation; §3.4)

GET     /repos/{repo}/docs/{path}                       → Version (current)
                                   Accept: application/json  → Version envelope
                                   Accept: text/markdown     → raw body (frontmatter as `---` block)
GET     /repos/{repo}/versions/{version_id}             → Version (any version, by id)
GET     /repos/{repo}/history/{path}?limit=&before=     → Version[]
GET     /repos/{repo}/diff/{path}?from=&to=             → UnifiedDiff

PUT     /repos/{repo}/docs/{path}                       → Version
                                   Content-Type: application/json → { frontmatter | frontmatter_raw, body } (exactly one frontmatter form; §3.2)
                                   Content-Type: text/markdown    → raw file; server splits the leading `---` block into frontmatter_raw + body
                                   If-None-Match: *      → create (fails if exists → 412)
                                   If-Match: <version_id> → update at this path, OR move here (fails on mismatch → 412 stale_prev)
                                   -- restore is just PUT to a user-territory path with If-Match on a :deleted/... version
DELETE  /repos/{repo}/docs/{path}  If-Match: <version_id> → Version (kernel moves to the §3.4 deletion path; no-op if already deleted, §4.1)
MOVE    /repos/{repo}/docs/{path}  Destination: /repos/{repo}/docs/{new_path}
                                   If-Match: <version_id>
                                   → sugar for PUT at Destination with body/frontmatter unchanged
                                   -- Destination must be within the same repo; cross-repo moves are rejected

GET     /query?repo=&filter=&text=&rank=&limit=&include_hidden=&include_system=      → Version[]
POST    /query                     { QuerySpec }             → Version[]

GET     /me/tokens                                           → Token[]
POST    /me/tokens                 { label, scopes, expires_at? } → { token, meta }
DELETE  /me/tokens/{id}                                      → Token
```

`/versions`, `/history`, and `/diff` are sibling roots rather than suffixes under `/docs/{path}` because document paths are multi-segment: `/docs/notes/history` must always mean the document at `notes/history`, never the history of `notes`. Sibling roots keep the route grammar unambiguous.

`GET /query` and `POST /query` accept the same parameters — GET as query-string, POST as JSON body. GET is preferred for cacheability and shareability; POST is the fallback for queries whose URL-encoded form would exceed reasonable URL length (~8KB). Every `QuerySpec` field maps to a query parameter of the same name.

`[OPEN]` **Query response cacheability.** GET `/query` responses should carry `ETag` (a hash of the sorted `version_id` list in the result) and `Cache-Control`, so CDNs and browser caches can revalidate with `If-None-Match` → 304. Cheap to compute; invalidates exactly when the result set would change.

`If-Match` collapses the explicit `prev_version_id` parameter of `docs.put` / `docs.delete` into the standard HTTP conditional-request mechanism — same semantics, native to the protocol. `PUT` with `If-None-Match: *` is the RFC-standard "create only if absent" pattern, so we don't need a separate `docs.create` route. `MOVE` is sugar over a `PUT` at the destination path with the source's `If-Match` — it borrows WebDAV's verb vocabulary purely as rename sugar; v1 implements no other WebDAV semantics (§11).

**Error mapping** (kernel error → HTTP). All error responses carry the kernel error `code` and `data` in the JSON body; the HTTP status just picks the closest match.

- `unauthorized` → **401 Unauthorized**.
- `forbidden` → **403 Forbidden**.
- `stale_prev`, `create_conflict` → **412 Precondition Failed**, with the current `version_id` in the `ETag` response header.
- `precondition_required` → **428 Precondition Required**. Surface-emitted (never by the kernel). Returned when a mutating request omits the `If-Match` / `If-None-Match` header that the strict surface requires — `If-Match: *` is deliberately not accepted for `docs.put` / `docs.delete`; last-writer-wins is reserved for the WebDAV gateway (§11.1).
- `payload_too_large` → **413 Content Too Large**. Surface-emitted (never by the kernel). Returned when a request body exceeds the server's configured cap.
- `path_taken`, `slug_taken` → **409 Conflict**.
- `repo_not_found`, `user_not_found`, `doc_not_found`, `version_not_found`, `token_not_found` → **404 Not Found**.
- `version_not_in_document` → **422 Unprocessable Entity**.
- `slug_invalid`, `path_invalid`, `frontmatter_invalid`, `filter_invalid` → **400 Bad Request**.

### 6.4 Wire types

Shared across both surfaces.

```types
User    = { user: string }
Repo    = {
  repo:        string,                           -- slug
  path_config: PathConfig | null                 -- per-repo overrides; null = inherit server (§3.5)
}
PathConfig = {
  disallowed_chars?: string[],                   -- omit to inherit
  system_sigils?:    string[],
  hidden_sigils?:    string[]
}
PathWarning = {
  version_id: string,                            -- opaque
  path:       string,                            -- the currently-invalid path
  reason:     string                             -- human-readable, e.g. "segment starts with '_' now in disallowed_chars"
}
Version = {
  version_id, prev_version_id, next_version_id,  -- opaque; next_version_id = null means current
  repo, path,                                    -- slug + string
  frontmatter, frontmatter_raw, body,            -- parsed JSON + verbatim YAML source (§3.2)
  author,                                        -- User
  created_at
  -- No tombstone field. A "deleted" version is one whose path lives under a system sigil (§3.5).
}
ScopeInput = {                                   -- accepted by tokens.create; repo patterns resolved to ids at creation (§8.2)
  repo:   string | string[],                     -- slug, glob, "*", or list thereof
  read?:  string | string[],                     -- path glob or list thereof
  write?: string | string[]
}
Scope   = {                                      -- stored / returned form
  repos:  "*" | string[],                        -- "*" = all repos (dynamic); else the bound repos' current slugs (ids internally)
  read?:  string[],
  write?: string[]
}
Token   = {
  id: string,                                    -- opaque
  label: string,
  admin: boolean,                                -- server-level power (see §8.2)
  scopes: Scope[],
  expires_at, created_at, last_used_at
  -- plaintext secret only present on the response to tokens.create
}
```

All timestamps on the wire (`created_at`, `expires_at`, `last_used_at`, `before`) are ISO 8601 UTC strings.

## 7. Deployment & clients

### 7.1 Deployment shapes

A deployment shape is an answer to three questions: **where the database lives**, **what runs the HTTP surfaces**, and **what runs the embedding worker** (§5.3). The kernel/surface/worker split keeps those answers independent — long-lived hosts run all three in one process; ephemeral hosts split the worker out.

- **Local, embedded** — single binary, SQLite file, no daemon. The CLI talks to the kernel in-process; `mrplex serve` starts the HTTP surfaces on localhost when an editor or agent needs them. Ideal for personal notebooks and CLI-only workflows.
- **Local, containerized** — binary + `docker compose up` for Postgres + pgvector. First-class path, not "production only" — a user who wants to run the server flavor on their laptop should have no more friction than the SQLite path.
- **Typical cloud** — the same container on any long-lived container host (a VPS, Fly.io, Cloud Run, Railway, …) pointed at managed Postgres + pgvector; TLS terminates at the platform edge (§8.5). Everything runs in the one process, worker included. Multiple instances are safe for the surfaces — concurrency is enforced at the storage layer (§3.2, §4), not in process memory — but run a single embedding worker, or make backlog dequeue atomic (`SELECT … FOR UPDATE SKIP LOCKED`), before scaling out.
- **Supabase** — Postgres + pgvector is the platform's native database, so the Postgres adapter (M5) maps on directly. The surfaces deploy as Edge Functions (Deno; the TS kernel runs as-is). The one structural difference: edge functions are request-scoped, so there is no home for a resident embedding worker — the backlog is drained by scheduled invocations instead (`pg_cron` + `pg_net`, or Supabase scheduled functions). The SQLite flavor is not applicable (no persistent local filesystem), and platform limits (memory, per-request CPU, bundle size) should be checked at implementation time — the kernel's thin-CRUD profile fits comfortably.
- **zo.computer (personal server)** — a persistent single-user server with a real filesystem and long-lived processes: exactly the environment the embedded flavor was designed for. `mrplex serve --database sqlite:~/mrplex/mrplex.db` as a Zo service, database on the persistent disk, HTTP surfaces exposed at the service's public URL so remote MCP agents and the CLI can reach it from anywhere. The embedding hook (§5.3) points wherever is convenient — a sidecar process on the same box or a hosted embedding API. This is the reference "personal notebook with agents" deployment.

The binary takes `--database sqlite:./mrplex.db` or `--database postgres://…` (also via `MRPLEX_DATABASE` env). No other config surgery to switch shapes.

**Implementation language: TypeScript (Node).** mrplex is a thin wrapper around a storage engine plus a CEL-to-SQL compiler and a couple of HTTP surfaces — none of it CPU-bound. TypeScript is chosen for portability (Node runs everywhere the SQLite/PG drivers do), ergonomic distribution (single `npm` install for the CLI, containerized for the server), and a mature ecosystem for the pieces we need (`better-sqlite3` / `pg`, JSON-RPC / HTTP libs).

**CEL engine: `@bufbuild/cel` (TypeScript-native).** M2 ships with `@bufbuild/cel` — a spec-conformant CEL parser and evaluator from the Buf team (authors of protobuf-ES). It emits the canonical CEL protobuf `ParsedExpr` AST — the same shape `cel-go` would emit — so the AST→SQL compiler is portable across parser choices. The TS side owns AST→SQL translation per dialect and everything that touches the database; the parser is a pure library call.

The `$`-intrinsic marker (§5.1) is admitted via a small string-aware preprocessor that mangles `$foo` → `__mrplex_i_foo` before the parser sees it, and the AST walker un-mangles it on the way out. No grammar patch, no fork.

The original design (recorded in §9) pinned `cel-go` compiled to WASM — chosen for spec-exact semantics and to avoid reimplementing CEL corner cases. `@bufbuild/cel` meets the same "spec-exact" bar (it's the reference for `protovalidate-es`, which needs correctness across the whole CEL surface) while saving the Go toolchain in CI, the vendored `cel-go` fork, and the WASM build pipeline. Because the AST format is stable (protobuf `ParsedExpr`), swapping the parser later is a one-file change if M5's Postgres adapter finds semantic divergence — the compiler doesn't move.

### 7.2 Storage adapters

The kernel talks to storage through one interface. Two adapters ship in v1 — **SQLite** (with `sqlite-vec` for embeddings) and **Postgres** (with `pgvector`). Additional adapters are a supported extension point.

#### 7.2.1 Functional parity guarantees

Adapters are contracted to be **semantically identical** on the wire. Every legal call returns the same result set on every adapter; the only permitted divergence is ranking (where scoring is inherently backend-shaped) and performance (index quality varies).

| Aspect | Guarantee | Notes |
|---|---|---|
| Data model & schema | **Identical.** | Tables, columns, FKs, partial indexes (§3.2) map 1:1. Dialect differences (`json` vs `jsonb`, `timestamp` vs `timestamptz`) hidden by the adapter. |
| Write model & concurrency | **Identical.** | Optimistic concurrency, `prev_version_id`, error catalog (§4). |
| CEL filter results (§5.1) | **Identical result set.** | Every filter evaluates to the same rows on both engines. |
| Polymorphic frontmatter (§5.2) | **Identical result set.** | Scalar-or-list membership works uniformly; the compile-time translation targets each dialect. |
| Frontmatter index quality | **May differ.** | PG uses one GIN on `frontmatter` for arbitrary containment; SQLite indexes specific expression paths and scans for the list branch. Same rows, different plans. |
| FTS result set | **Identical bag of documents.** | Any doc that matches on one engine matches on the other. |
| FTS ranking / scoring | **May differ.** | SQLite BM25 vs. PG `ts_rank`; stemming and language config are backend-shaped. Ordering within the result set is not portable. |
| FTS query syntax | **Adapter-owned.** | SQLite FTS5 MATCH vs. PG `websearch_to_tsquery`. Portable subset that clients can rely on across engines: bare terms and quoted phrases. Boolean operators and per-column filters are engine-specific. |
| Vector search recall | **Identical at small scale.** | Both engines return the same top-k for small corpora. |
| Vector search at scale | **May differ.** | pgvector offers HNSW / IVFFlat with tuning knobs; sqlite-vec is brute-force in v1. Recall converges; latency does not. |
| Auth, scopes, error catalog | **Identical.** | Backend-independent. |
| Concurrent throughput | **May differ.** | SQLite is single-writer per file; PG is multi-writer. §4 already floors both at "single-writer per repo," which SQLite satisfies. |

The mechanism that keeps these guarantees honest is a shared **kernel test suite** that runs against every registered adapter in CI. An adapter that fails a semantic-parity test is not a supported adapter.

#### 7.2.2 Adapter contract

An adapter implements one interface, exposed to the kernel. The methods below are the minimum required surface; anything an adapter can't implement natively must be emulated in the adapter itself (not pushed up into the kernel).

```types
StorageAdapter = {
  // Every method is async — SQLite adapter resolves on the next
  // microtask, Postgres adapter awaits real I/O. Kernel is async
  // uniformly (m5-plan WS1).

  // Lifecycle
  open(config)                                              → Promise<Storage>
  close()                                                   → Promise<void>
  migrate()                                                 → Promise<void>  // idempotent; brings schema to current version

  // Transactions
  tx(fn: () => Promise<T>)                                  → Promise<T>
  // serializable-or-equivalent; nested tx = savepoint. Contract: never
  // await foreign I/O inside `fn` — the tx body may replay on retry
  // (PG REPEATABLE READ), so only storage calls are safe.

  // Slug-space (users, repos)
  users_list() / users_create(slug) / users_rename(id, slug) / users_by_slug(slug) / users_by_id(id)
  repos_list() / repos_create(slug) / repos_rename(id, slug) /
  repos_set_path_config(id, cfg) / repos_by_slug(slug) / repos_by_id(id)

  // Document identity
  documents_create(repo_id)                                 → Promise<{ id, repo_id }>

  // Version chain (the hot path — must be atomic per §4)
  version_insert({
    document_id, repo_id, prev_id, path, frontmatter_raw, frontmatter, body,
    author_id, created_at
  })                                                        → Promise<VersionRow>
  // Contract: inside one tx, insert the new version AND set prev.next_id = new.id.
  // Must enforce the two partial indexes from §3.2 at the storage layer, not application code.

  version_by_id(id)                                         → Promise<VersionRow | null>
  version_current(repo_id, path)                            → Promise<VersionRow | null>
  version_history(document_id, opts?)                       → Promise<VersionRow[]>
  versions_live_by_repo(repo_id)                            → Promise<VersionRow[]>

  // Query — kernel emits no SQL; it hands over a structured SearchPlan
  // and the adapter compiles it to dialect-specific SQL (m5-plan WS2).
  versions_search(plan: {
    repo_ids, limit, text?, filter_ast?, sigils, scope, candidate_ids?
  })                                                        → Promise<VersionRow[]>
  // filter_ast is parsed CEL (invalid input fails eagerly with
  // filter_invalid). sigils is a per-repo-group NOT-LIKE list. scope is
  // one of { allow_all | deny_all | groups }.

  // Full-text (current versions only — filtered at query time via
  // versions.next_id IS NULL, not by dropping old rows)
  fts_index(version_id, body)                               → Promise<void>
  // No fts_search — versions_search takes plan.text and dispatches
  // engine-native FTS internally (FTS5 MATCH / websearch_to_tsquery).

  // Vector — embeddings cross the interface as Float32Array
  chunks_upsert(version_id, model, chunks: { ix, text, text_hash, model, embedding }[]) → Promise<void>
  chunks_by_hash(model, text_hashes[])                      → Promise<{ text_hash, embedding: Float32Array }[]>
  chunks_by_version(version_id)                             → Promise<ChunkRow[]>
  vector_search(repo_ids, model, embedding, k)              → Promise<{ version_id, chunk_ix, score }[]>
  // Current-versions only. Brute-force in v1 (both adapters); indexed
  // ANN for pgvector is a fast-follow.

  // Backlog
  backlog_enqueue(version_id) / backlog_dequeue(now, limit) /
  backlog_retain(input) / backlog_delete(version_id) /
  backlog_status(now)

  // Tokens
  tokens_list(user_id) / tokens_by_hash(hash) / tokens_by_id(id) /
  tokens_create({ user_id, secret_hash, label, admin: boolean, scopes, expires_at }) /
  tokens_revoke(id, revoked_at) / tokens_revoke_by_user(user_id, revoked_at) /
  tokens_touch_last_used(id, when)
  // admin is a native boolean; adapters translate to their engine's
  // representation (SQLite 0/1, PG native).
}
```

**Contract obligations** an adapter must satisfy to be considered compliant:

1. **Atomic version insertion.** `version_insert` inserts the new version and updates `prev.next_id` in one transaction. Partial failure is not observable.
2. **Schema-level invariants.** The two partial unique indexes in §3.2 (`versions(document_id) where next_id is null` and `versions(repo_id, path) where next_id is null`) are enforced by the storage engine, not by application code. If the engine has no partial-index primitive, the adapter simulates one (e.g., a trigger-maintained materialized state), but the invariant holds.
3. **Isolation.** `tx()` provides serializable behavior *for the operations in the kernel* — writes to the same document serialize; readers never observe partial version chains. SQLite's `BEGIN IMMEDIATE` and PG's `REPEATABLE READ` (with retry on serialization failure) both qualify.
4. **CEL filter semantics.** The adapter translates the CEL AST such that a given filter over a given corpus returns the same rows on every adapter. Missing keys, null, scalar-or-list coercion (§5.2), and type-mismatch handling all follow the semantics defined in §5.
5. **Scope-glob enforcement in `query`.** The adapter receives `path_globs` and returns only rows matching them — silently dropped, not errored (§8.2). Enforcing this in the adapter (not the kernel) lets the engine push the filter into indexes.
6. **Result-set portability.** For FTS and vector search, the *set* of returned documents is identical across adapters for the same corpus and query; only ranking scores may differ.
7. **Migrations.** `migrate()` is idempotent and forward-only. Adapters own their migration files; the kernel invokes `migrate()` on startup unless `--no-migrate` is set.

**What an adapter is *not* required to provide:**

- A specific index strategy — only that queries return correct results in bounded time.
- Native JSON operators — the adapter may synthesize containment via row-generating joins (as SQLite does for the list branch of §5.2).
- Native vector or FTS — an adapter targeting a store without them can back these with an auxiliary engine (e.g., a companion process) as long as the semantic-parity tests pass.

**Adding a third adapter** (e.g., DuckDB, MySQL, CockroachDB, an object-store-backed engine) means: implement the interface, register it in the `--database` scheme registry, pass the shared kernel test suite. No changes to the kernel or surfaces.

### 7.3 `mrplex` CLI

The CLI is a thin client over the MCP surface (§6.2) — no capabilities of its own, no direct database access when talking to a remote server. It drives `tools/call` against `/mcp` (or the in-process kernel, if running against a local SQLite file) and pretty-prints results.

Commands mirror MCP tool names in a `noun verb` shape:

```rpc
mrplex serve [--database URL] [--port N]                          # the one non-client command: runs the server
                                                                  # (HTTP surfaces + embedding worker; §7.1)

mrplex repos list [--include-system]
mrplex repos get <slug>
mrplex repos create <slug>
mrplex repos rename <slug> <new-slug>
mrplex repos delete <slug>                                        # system-namespace rename (§3.4); restore via `repos rename`
mrplex repos set-path-config <slug> [--from-file FILE | -] | --clear
                                                                  # FILE is JSON with any subset of { disallowed_chars, system_sigils, hidden_sigils }
                                                                  # --clear removes the override, reverts to server config

mrplex users list
mrplex users create <slug>
mrplex users rename <slug> <new-slug>
mrplex users delete <slug>                                        # system-namespace rename + revokes their tokens (§3.4)

                                                                  # `docs *` reads the target repo from -r/--repo, MRPLEX_REPO,
                                                                  # or `config set-repo`; no positional <repo> argument.
mrplex docs get <path>
mrplex docs get-version <version-id>
mrplex docs history <path> [--limit N] [--before <ts>]
mrplex docs diff <path> --from <v> --to <v>

mrplex docs create <path> [--from-file FILE | -]                  # body from file or stdin
mrplex docs put <path> --prev <version-id> [--from-file FILE | -]
                                                                  # <path> may differ from prev's path → move (optionally + content change)
                                                                  # to restore a deleted doc, use put with --prev = trashed version id
mrplex docs delete --prev <version-id>                            # target is fully addressed by --prev
mrplex docs mv <to-path> --prev <version-id>                      # sugar: put to <to-path> with unchanged content

mrplex query [--repo <slug-or-glob>] [--filter EXPR] [--text Q] [--rank Q] [--limit N]
                                                                  # --repo omitted = every repo in the token's scope (§5.1)

mrplex embed backfill --repo <slug>                               # re-chunk + re-embed current versions missing chunks (§5.3)
mrplex embed status                                               # inspect the embedding backlog

mrplex tokens list
mrplex tokens create --label LABEL --scope <slug>:read=<glob>,write=<glob> [--admin] [--expires TS]
mrplex tokens revoke <token-id>
```

**Global flags:**

- `--server <url>` (default from config) — the mrplex endpoint. When absent and a local SQLite file exists, run against it directly.
- `--token <token>` (default from config or `MRPLEX_TOKEN` env) — bearer token.
- `-r, --repo <slug>` (default from `MRPLEX_REPO` env or config `repo`) — target repo for `docs *` commands. `query` and `embed backfill` keep their own `--repo` because their semantics differ (multi-repo glob and required, respectively).
- `--json` — emit raw JSON instead of pretty output. Enables piping into `jq`.

**Input conventions:**

- `--from-file FILE` reads a Markdown document (frontmatter + body) from a file; `--from-file -` reads from stdin.
- The CLI splits the file into the raw frontmatter block and the body and submits `{ frontmatter_raw, body }` verbatim — parsing happens server-side (§3.2), so what you wrote is exactly what's stored.

**Output conventions:**

- Reads default to pretty-printed Markdown (frontmatter as YAML block, body underneath) on stdout — same shape a user would edit.
- Writes print the new `version_id` on stdout (for scripting: `NEW=$(mrplex docs put ... --prev "$PREV")`) with human context on stderr.
- Errors print the kernel error `code` and `data` to stderr, exit non-zero. The exit code encodes the error family: 1 for validation, 2 for concurrency/conflict, 3 for auth, 4 for not-found, 10 for network/transport.

**Config file:** `~/.config/mrplex/config.toml` holds server URL and default token. `mrplex config set-server URL` / `mrplex config set-token TOK` manage it; `mrplex login` is sugar that prompts for a token and stores it.

Everything the CLI does is achievable with `curl` against the MCP or REST surfaces; the CLI just makes it pleasant.

## 8. Auth & security

### 8.1 Model

Opaque bearer tokens with per-token capability scopes. Each token belongs to one user; a user may hold many tokens (one per client — CLI, Obsidian plugin, agent — each revocable individually). Tokens are stored hashed with plain **SHA-256**; only the hash is persisted, the plaintext is shown once at issuance.

Why SHA-256 and not a slow salted KDF (argon2/bcrypt): the secret is a high-entropy random value the server generates, not a human-chosen password, so brute-force hardening adds nothing — and salted hashes are non-deterministic, which would make lookup-by-hash impossible (no stable value to index; every auth would have to scan and verify all tokens). `sha256(secret)` is deterministic: auth is a single indexed equality against `api_tokens.secret_hash`.

Every request presents `Authorization: Bearer <token>`. The auth middleware:

1. Computes `sha256(secret)` and looks up the token by that hash. If missing / revoked / expired → **`unauthorized`**.
2. Loads `{ user_id, scopes }` and attaches them as the resolved `actor` (§6.1).
3. Delegates to the kernel operation, which runs an `authorize(actor, action, target)` check. On insufficient scope → **`forbidden`**.

### 8.2 Scope grammar

Two independent axes: **server-level power** (a single boolean) and **data access** (per-repo, per-action path globs). Actions do not nest; each is granted explicitly.

```types
StringOrList = string | string[]

ScopeInput = {                // accepted by tokens.create
  repo:   StringOrList,       // repo slug, glob, or "*"; resolved to repo ids at creation (below)
  read?:  StringOrList,       // path literal, glob, or list thereof
  write?: StringOrList
}

Token = {
  admin:  boolean,            // server-level: repos.create/rename, users.*, others' tokens
  scopes: Scope[]             // stored form: bound repo ids + path globs (§6.4)
}
```

Every field is polymorphic scalar-or-list, matching the §5.2 convention. At the auth boundary each field is normalized to a list (scalar → `[scalar]`, missing → `[]`) before matching.

**Repo binding is by id, resolved at token creation.** `tokens.create` evaluates each `repo` pattern against the repos that exist at that moment and stores the matched **internal repo ids**, not the slugs. The literal `"*"` is the one exception — it is stored as a dynamic all-repos wildcard and covers repos created later. Consequences:

- **Renames don't break tokens.** A token granted on `notes` keeps working when the repo is renamed to `notes-archive` — and a new repo that later claims the freed slug `notes` does *not* inherit the old token's access.
- **Non-`*` patterns are snapshots.** A `team-*` grant covers the team repos that existed at issuance; a repo created afterwards requires re-issuing the token (or using `"*"`).
- `tokens.list` renders bound repos by their **current slugs**.

**Actions:**

- **`read`** — `docs.get`, `docs.get_version`, `docs.history`, `docs.diff`, `query`, `repos.get`, and the corresponding REST GET routes. Path must match a `read` glob for the target repo.
- **`write`** — `docs.create`, `docs.put`, `docs.delete`. Path must match a `write` glob. **Does not imply `read`** — a token that wants both lists both.
- **`admin: true`** — `repos.create` / `repos.rename` / `repos.delete` / `repos.set_path_config`, all `users.*` (including `users.delete`), and management of tokens other than the caller's own. Not scoped to a repo (there is no repo yet for `repos.create`, and `users.*` isn't repo-shaped). Repo config and deletion are admin-gated rather than write-scoped because they affect every writer of the repo, not just the caller's paths. `[OPEN]` A per-repo `manage` action for delegating repo administration (config, delete) without full server admin, if the need emerges.

**Glob semantics:** gitignore-style, faithful to `gitignore(5)`.

- `**` matches any run of characters, including `/`. In the forms `**/foo` and `a/**/z` the `**/` segment stands for **zero or more** intermediate directories — so `**/foo.md` matches both `foo.md` and `a/b/foo.md`, and `a/**/z` matches `a/z`, `a/x/z`, `a/x/y/z`.
- `*` matches within a single path segment (never crosses `/`); `?` matches one non-`/` character.
- **Anchoring.** A pattern that contains no `/` is a **basename** and matches at any depth: `horses.md` matches `horses.md`, `notes/horses.md`, and `a/b/horses.md`. A pattern with `/` anywhere except the trailing position (and any pattern with a **leading** `/`) is anchored to the repo root: `/horses.md` matches only root-level, `drafts/foo.md` matches only that exact path. Trailing `/**` includes everything strictly under the directory (does not include the directory itself, and mrplex paths are always files anyway).
- `!pattern` negates. Order matters: last matching entry in a list wins.
- Literals with no metacharacters are just anchored strings — including `.`, which is a literal dot, not "any char."

- Repo patterns are evaluated once, at token creation (above), against repo slugs. Since slugs contain no `/`, `*` is the canonical wildcard at the repo level; reserve `**` for paths.
- Path globs match against **the path at the version being accessed** — so `read: "drafts/**"` still reads historical states of a doc that has since been renamed out of `drafts/`.
- A `docs.put` whose `path` differs from `prev`'s path (a move) requires **both** paths to match `write` — moving into or out of scope is a write on both endpoints.
- **System-namespace carve-out.** No user scope can grant `write` at a system-sigil path (§3.5), so the "both endpoints" rule would forbid every deletion (destination is `:deleted/…`) and every restore (source is `:deleted/…`). Instead: for any move where **one** endpoint is under a system sigil, scope is checked only on the **user-territory** endpoint. Users get scope-checked on what they can see and reason about; the system-namespace endpoint is kernel-controlled.
- `query` appends the token's `read` globs as an implicit path filter. Results outside scope are silently dropped, not 403'd — queries return what the caller is allowed to see, not what exists.
- `repos.list` returns only repos bound by at least one of the token's scopes (all repos, for a `"*"` scope).

**Examples:**

```json
// Read-only search agent, one repo
{ "admin": false, "scopes": [{ "repo": "notes", "read": "**" }] }

// Ingest agent: write-only to inbox, no read
{ "admin": false, "scopes": [{ "repo": "notes", "write": "inbox/**" }] }

// Broad reader, narrow writer with a negated subtree
{ "admin": false, "scopes": [{
    "repo":  "notes",
    "read":  "**",
    "write": ["drafts/**", "!drafts/pinned/**"]
}]}

// Read across a repo family, write to inbox in any of them
// (resolved at issuance: covers the team-* repos existing at that moment)
{ "admin": false, "scopes": [{ "repo": "team-*", "read": "**", "write": "inbox/**" }] }
```

The `repo` values above are creation-time inputs (`ScopeInput`); each resolves to concrete repo ids on issuance, except the dynamic `"*"`.

Multiple scope entries stack — union semantics. A token can be broadly `read` on one repo family and narrowly `write` on a single repo by listing two entries.

**Self-token management** is a property of the token model, not a scope grant: any authenticated user can `list` and `revoke` their own tokens and `create` new ones whose `admin` bit and `scopes` are a subset of the parent token's. "Subset" is deliberately conservative and **decidable**: the child's bound repo ids must be a subset of the parent's, and every child path glob must appear **verbatim** in the parent's corresponding list. Semantic glob subsumption (is `drafts/a*` ⊆ `drafts/**`? — undecidable in general once negation enters) is not attempted; `[OPEN]` relax to structural subsumption later if verbatim proves too strict. Managing *other* users' tokens requires `admin: true`.

Bootstrap root token: `{ admin: true, scopes: [{ repo: "*", read: "**", write: "**" }] }`.

### 8.3 Token management

```rpc
mrplex.tokens.list()                                        → Token[]         -- current user's tokens
mrplex.tokens.create(label, scopes, expires_at?, for_user?) → { token, meta } -- token shown once, in plaintext
mrplex.tokens.revoke(token_id)                              → Token
```

Corresponding REST routes:

```rest
GET    /me/tokens                                           → Token[]
POST   /me/tokens          { label, scopes, expires_at? }   → { token, meta }
DELETE /me/tokens/{id}                                      → Token
```

Server-side, `api_tokens` (§3.2) holds `secret_hash` (never the plaintext), `label`, `scopes`, `expires_at`, `revoked_at`, `last_used_at`.

**Self-management is identity-based, not scope-gated.** Every authenticated user can `tokens.list`, `tokens.revoke`, and `tokens.create` against their own token set regardless of what their scopes cover; the kernel keys these ops off `actor.user_id`, and `tokens.create` mints under `actor.user_id` by default. Sub-tokens minted by a non-admin must be a subset of the caller's own scopes and cannot set the admin bit (§8.2 subset rule) — the safety property that lets self-mint be unconditional. This axis is deliberately outside the scope grammar: scopes govern *what data you can touch*, identity governs *what identity you can speak for*.

**Cross-user token minting** (bootstrapping a new user's first bearer) is admin-only. The optional `for_user` argument on `tokens.create` names a target user slug; if it differs from `actor.user_id`, the caller must carry the admin bit. This is the only supported path from "user exists" to "user has a working token" — hand the plaintext to the user out-of-band (encrypted email, secret manager, in-person) and they self-serve from there.

Bootstrap: server creation seeds a `system` user and issues one root token (`{ admin: true, scopes: [{ repo: "*", read: "**", write: "**" }] }`, per §8.2) printed to the operator once at first launch. Everything else can be created from there.

### 8.4 Auth error codes

- **`unauthorized`** — no token, malformed token, or token unknown/revoked/expired. HTTP **401**.
- **`forbidden`** — valid token, insufficient scope for the requested action. HTTP **403**.

Both errors expose only the code; they do not leak whether a resource exists (i.e., a `forbidden` on a nonexistent repo returns the same error as on a real one the caller lacks scope for).

### 8.5 Other security notes

- Authorship is server-derived from `actor.user_id` (§4.4). Clients can't impersonate.
- Frontmatter and body are stored verbatim — treat as untrusted when surfaced to agents.
- Bearer tokens require TLS in production. `[ASSUMPTION]` HTTPS enforced by the deployment; optional mTLS layers on top for high-trust environments.
- `last_used_at` on `api_tokens` updates opportunistically — best-effort, not transactional, to keep the hot path fast.

## 9. Resolved decisions

Log of shape-defining decisions and their rationale. Newer decisions supersede older ones; the current shape is what's in the body of this doc.

- **Deletion is a move to a system-namespace path, not a tombstone (§3.4, §3.5).** The kernel moves the doc to `<system-sigil>deleted/…` with the superseded version id inserted before the file extension: `path/to/document.md` → `:deleted/path/to/document-v45129.md`. Restore is a plain `docs.put` back to user territory. No `tombstone` column, no `resurrect` flag, no `already_tombstoned` / `resurrect_not_opted_in` errors.
- **Configurable path policy in three tiers (§3.5).** Hardcoded defaults → server config → per-repo override (replace-not-merge). `disallowed_chars`, `system_sigils`, `hidden_sigils` — lists for input, first entry canonical on emission. Server-level policy also gates slug validation for repos and users.
- **Structural path elements (`/`, `.`, `..`, empty segment) are non-configurable code constants (§3.5.1).**
- **Query defaults exclude hidden and system paths (§5.1).** `include_hidden` and `include_system` flags opt back in. Applies to `filter`, `text`, and `rank`.
- **Server never merges.** Merge policy is a client concern. Kernel enforces `prev_version_id` == current; conflicts return `stale_prev` with the current version attached (§4).
- **Multi-token auth with capability scopes (§8).** Per-user tokens, SHA-256-hashed secrets, `admin: true` boolean for server-level power, per-repo `read` / `write` path globs (scalar-or-list, gitignore semantics). System-namespace endpoints on kernel-driven moves (delete/restore) are exempt from the "both endpoints match write" rule — scope is checked only on the user-territory endpoint.
- **`author_id` non-nullable.** Every version has an actor. A reserved `system` user can be introduced later if automated writes need attribution, but the schema doesn't allow author-less versions.
- **Rename folded into `docs.put`.** `prev_version_id` already identifies the source location; the `path` argument is the destination. Same path = update, different path = move (§4.2). A rename-only verb can be added later if the ergonomics warrant it.
- **Concurrent create on a freed path: `create_conflict`.** The second caller sees the first caller's live document at the path and must retry as `put` (or a distinct create at a different path). No special-case for deletion races.
- **FTS is required, backend is adapter-owned (§5.1, §7.2).** SQLite → FTS5, Postgres → tsvector. Result set portable, ranking is not.
- **Embedding via user-defined hook (§5.3).** Server does not embed. Operator wires in an HTTP endpoint, subprocess, or in-process plugin implementing the batch `embed(chunks)` contract.
- **Implementation language: TypeScript (Node).** Portability and ecosystem fit for a thin storage wrapper + CEL-to-SQL compiler (§7.1).
- **Git/GitHub bridging deferred to post-v1 (§11).** mrplex stands alone in v1; adapters and sync policy come later.
- **Token secrets hashed with plain SHA-256 (§8.1).** The secret is high-entropy and server-generated; a slow salted KDF adds nothing and would break indexed lookup-by-hash. Supersedes the earlier argon2/bcrypt choice.
- **Scopes bind repo ids, resolved at token creation (§8.2).** Renaming a repo no longer breaks its tokens, and a freed slug can't leak old grants to a new repo. Non-`*` patterns are creation-time snapshots; `"*"` stays dynamic.
- **MCP surface is protocol-true MCP (§6.2).** Streamable HTTP at `/mcp`; kernel ops exposed as tools with JSON Schema; kernel errors returned in-band as tool errors. STDIO transport is opt-in at startup and bound to a single launch-time token. Supersedes the earlier bespoke `POST /rpc` JSON-RPC shape.
- **History, diff, and version reads use sibling REST roots (§6.3).** `/versions/{version_id}`, `/history/{path}`, `/diff/{path}` — suffix routes under a multi-segment `{path}` would be ambiguous with real document paths.
- **Point-in-time (`as_of`) reads deferred to post-v1 (§11).** Correct answers are expensive (path→document resolution at T, historical FTS/rank semantics); better shaped as an explicit time-machine/export feature than a casual query parameter.
- **WebDAV deferred to post-v1, gateway fully specified (§11.1).** Naive mount clients can't carry `prev_version_id`; the answer is a gateway that is a stateful *client* of the kernel — lock-table / read-map / fetch-and-retry tiers resolve `prev`, and no relaxed semantic touches the kernel.
- **Embedding load is damped server-side; write cadence is not (§5.3).** Debounce/sync policy is a client concern. The server dedups chunks by content hash, embeds only still-current versions, and rate-limits in the worker.
- **Frontmatter stored twice: raw source + parsed JSON (§3.2).** `frontmatter_raw` is byte-verbatim source of truth and round-trips exactly; `frontmatter` is a derived query index. Writes supply exactly one form; the other is derived.
- **Intrinsic CEL properties are `$`-prefixed (§5.1).** `$path`, `$updated_at`, `$body` — a fixed grammar constant, immune to frontmatter key collisions; `$` chosen over `:` to avoid the ternary operator, and fixed rather than configurable so a filter string parses identically everywhere.
- **All deletes are idempotent (§3.4, §4.1).** Deleting an already-deleted document, repo, or user is a no-op.
- **Repo and user deletion are system-namespace slug renames (§3.4).** The document-deletion primitive applied to slugs; admin-gated; frees the slug; user deletion also revokes tokens; `author_id` attribution is never disturbed.
- **Paths and slugs have case-insensitive, Unicode-normalized *identity* but case-preserving *storage* (§3.5.1).** Global default (not a per-repo toggle). Identity runs off a kernel-computed normalized key (NFC + locale-invariant lowercase) in a `path_norm`/`slug_norm` shadow column with a unique partial index; storage keeps the author's bytes, so the §3.2 round-trip is untouched. Normalization is kernel-side (never SQL `lower()`/`COLLATE`/`citext`) to preserve §7.2 adapter parity — SQLite `lower()` is ASCII-only while Postgres's is locale-aware. Fold strength: NFC + `toLowerCase` (covers accented Latin/Greek/Cyrillic; ß/ligatures/final-sigma deferred to a later full-fold upgrade, additive via backfill). The key is internal — never on the wire; CEL `$path` reads the stored path.
- **`stale_prev` redacts `current_path` when it's outside the caller's read scope (§4.3).**
- **Path config is setup-time configuration (§3.5.2).** Advisory warnings on `set_path_config` are the only guard rail; sigil changes over a live corpus are deliberately not further protected.
- **Search indexes cover current versions only (§5.1).** FTS eviction on write; `rank` over current chunks. Historical search rides with the deferred time machine (§11).
- **Graph features: Phase 1 shipped as a derived index (§11.2, M6).** Links extract into a rebuildable table binding to `document_id`, so backlinks and traversal survive renames. Pinned during implementation: (a) extraction runs **in the write transaction**, not the async worker — it's pure CPU, so in-tx buys read-your-writes graph consistency (the §11.2 "worker" wording is superseded for extraction; the worker still owns backfill / config-change re-extraction); (b) a **real CommonMark parser** (`micromark`) does extraction, not regex; (c) **`_static`-only** in Phase 1 with bare/`_dyn` names reserved and erroring, so Phase 2 union semantics stay clean; (d) graph subqueries apply the caller's read scope to **both** edge endpoints (visible graph = readable graph); (e) resolution is **case-insensitive**, riding the case-folding `path_norm` key. `!`-prefixed embeds are ordinary edges, not a distinct type. Note: bare `<foo.md>` is *not* a CommonMark autolink (those require a scheme and are always external → dropped); the pointy-bracket form only matters as an inline link destination `[t](<f.md>)`, which the parser handles.
- **CEL engine is `@bufbuild/cel` (TypeScript-native) (§7.1).** M2 ships the AST→SQL compiler on top of `@bufbuild/cel`, which emits the canonical protobuf `ParsedExpr` AST (same shape `cel-go` emits) — so the compiler is portable across parsers. The `$` intrinsic marker is admitted via a string-aware preprocessor rather than a grammar change. Supersedes both "`cel-js` or a hand-rolled parser" AND the previous "`cel-go` compiled to WASM" pin; the latter was chosen for spec-exact semantics, which `@bufbuild/cel` also meets (Buf uses it as the CEL runtime for `protovalidate-es`). If M5's Postgres adapter surfaces semantic divergence later, swapping the parser is one file — the compiler doesn't change.
- **Storage and kernel are async, uniformly (M5, §7.2).** Every `Storage` method returns `Promise<T>`; `tx()` takes `() => Promise<T>`. SQLite resolves on the next microtask (better-sqlite3 is sync internally); Postgres awaits real I/O. Contract: tx bodies never await foreign I/O — the PG adapter retries on 40001/40P01 and the SQLite adapter holds the connection lock. Supersedes M0–M4's sync Storage.
- **`versions_search` receives a `SearchPlan`, not SQL (M5, §7.2).** Kernel parses CEL eagerly (surfaces `filter_invalid` before the adapter), builds sigil-exclusion groups, flattens read scopes into globs, and hands over a plain object. Adapters compile the plan to their dialect. Kernel imports nothing from `storage-*`; adapters own their SQL.
- **FTS query syntax is adapter-owned; parity is a portable subset (M5, §5.1, §7.2).** SQLite → FTS5 MATCH; Postgres → `websearch_to_tsquery` (never throws on user input). Cross-adapter clients get bare terms and quoted phrases. Boolean operators / column-scoped queries are engine-specific.
- **Vector column is dimensionless; brute-force in v1 (M5, §7.2).** Both adapters run brute-force top-k (SQLite `vec_distance_cosine`, PG `<=>`). Indexed ANN (pgvector HNSW / IVFFlat) is a fast-follow.
- **Embeddings cross the interface as `Float32Array` (M5, §7.2).** The engine-specific byte layout stays private to each adapter (SQLite LE float32 BLOB; PG pgvector literal). Fresh callers may pass `readonly number[]`; reuse callers pass the `Float32Array` they got back.
- **Postgres schema (M5, §3.2).** `bigserial` ids, `text` timestamps (byte-exact parity with SQLite), `jsonb` + a single GIN over `frontmatter` (§5.2 — `= '"v"'::jsonb OR @> '["v"]'::jsonb`), native `boolean admin`, two partial unique indexes verbatim, `tsvector` generated column + GIN maintained automatically. Vector column via `create extension if not exists vector`.
- **PG isolation: REPEATABLE READ + retry×3 (M5, §7.2).** `tx()` runs at `REPEATABLE READ`, retries with jitter on SQLSTATE `40001` / `40P01` (design's stated qualifying recipe). Nested tx via savepoints. Same-connection routing via `AsyncLocalStorage<PoolClient>`.
- **`pg` driver (M5).** Chosen over `postgres.js`: plain parameterized-query API matches the compiled SQL, pure JS, ubiquitous. int8 is parsed to JS `number` with a `Number.isSafeInteger` guard so id drift is loud.
- **PG migrations: `schema_migrations` + `pg_advisory_xact_lock` (M5).** Forward-only, idempotent, lock-safe under parallel invocation.
- **SKIP LOCKED deferred (M5).** The v1 single-worker embedding backlog stands; concurrent workers with row leasing is a post-v1 topic.

Remaining `[OPEN]` markers throughout the doc are narrower questions (query cacheability, expression-index tuning, pagination cursors, resource caps, etc.) that don't gate the v1 shape.

## 10. Milestones

- **M0 — Kernel + skeleton.** Schema, SQLite storage, kernel reads (`repos.list`, `users.list`, `docs.get`, `docs.history`), `mrplex` CLI reading directly from the kernel (§7.3). Slug/id split enforced.
- **M1 — Writes + auth.** Full kernel write surface (`docs.create` / `docs.put` / `docs.delete`, plus `repos.create` / `users.create` and the `.rename` / `.delete` methods) with `prev_version_id` enforcement. `docs.put` handles both in-place update and move. Bearer-token auth (§8): `api_tokens` table, capability scopes, `authorize()` on every kernel op, `tokens.*` RPCs, bootstrap root token. CLI gains write commands and `tokens.*`.
- **M2 — Query.** CEL filter (`@bufbuild/cel`, §7.1) + FTS; `kernel.query` end-to-end; CLI `query` command.
- **M3 — HTTP surfaces.** MCP server at `/mcp` (Streamable HTTP; optional STDIO transport, startup-gated); REST surface (`GET` / `PUT` / `DELETE` / `MOVE`, `If-Match` / `If-None-Match`, content negotiation, `/versions` / `/history` routes). CLI gains `--server` flag to target a remote instance over MCP. `docs.diff` deferred to M4.
- **M4 — Semantic.** Chunking + embeddings + vector search. Also picks up `docs.diff`, deferred from M3: the kernel op (§6.1), `/diff` route (§6.3), `docs_diff` tool (§6.2), CLI `docs diff` (§7.3).
- **M5 — Postgres backend.** Ships the second v1 storage adapter and (as a one-time break) three seam refactors the parity contract required: async `Storage` and kernel (SQLite `tx()` keeps `begin immediate`; PG uses `REPEATABLE READ` + retry on 40001/40P01); structured `SearchPlan` handed to `versions_search` (kernel emits no SQL; adapters compile the plan into their dialect); `Float32Array` embeddings in the shared type (SQLite's byte-order BLOB is private to `storage-sqlite/vec.ts`). `pg` driver, `pgvector` for vectors (brute-force in M5; indexed ANN is a fast-follow), `websearch_to_tsquery` for the portable FTS subset (bare terms + quoted phrases), `jsonb` + a single GIN for the frontmatter compile path.
- **M6 — Links (graph index), Phase 1.** The derived `links` index (§11.2) — outbound static edges extracted in the write transaction (pure CPU, no worker), bound to target `document_id` (identity, not path), with dangling rows re-bound as documents appear. CEL graph predicates `$in_static` / `$has_static` / `$backlinks_static()` / `$links_static()` (incl. optional field restriction) compile to scope-respecting `EXISTS`/`COUNT` joins on both adapters; bare names + `_dyn` variants reserved for Phase 2. `links.stale` + `mrplex links repair` rewrite stale link text as ordinary optimistic writes. Per-repo `link_config` cascade (`docs/links-plan.md`). Shipped alongside case-insensitive identity (the case-folding branch), which wikilink resolution rides for free. Deferred to Phase 2: embedded queries, the `--in` operator, `_dyn`, bare-name unions, and multi-hop `$reachable_from`.

## 11. Future work (post-v1)

- **Git bridging.** Attach a **source** (adapter + policy) to a repo: pull (`git → mrplex`), push (`mrplex → git` via `staged` / `autocommit` / `autopr`), or bidirectional. Loop avoidance via commit trailer. mrplex's fast-forward-only write model carries over — a git ingest that advances the head just marks in-flight mrplex writes stale, same mechanism.
- **Merge helpers.** A read-only `docs.merge_preview` and a client-side merge library that implements common patterns (refetch-and-retry, three-way block merge, callout fallback). A cached parsed block tree on `versions` would support this cheaply.
- **Grouped writes.** A `changesets` entity for atomic multi-document writes, if a use case emerges.
- **Case and Unicode path policy.** ~~v1 is byte-exact~~ **Shipped** (§3.5.1, `docs/case-folding-plan.md`): case-insensitive, NFC-normalized *identity* with case-preserving *storage*, via a `path_norm`/`slug_norm` shadow column + unique partial index and a kernel-side `normalizeKey`. Landed as the **global default** rather than the per-repo option originally sketched here. Remaining follow-ups: (a) strengthen the fold from NFC+`toLowerCase` to full Unicode default case-folding (ß→ss, ligatures, final-sigma) — additive, recompute keys via backfill; (b) `[OPEN]` whether scope-glob authorization (`slugMatchesPattern`/`pathMatchesGlobs`) should also fold (today identity folds but authz stays byte-sensitive, to avoid silently widening a caller's granted read scope).
- **WebDAV / filesystem mounting.** Deferred from v1, but fully specified — see §11.1. Kept spec-complete so the gateway module can be built without revisiting the architecture.
- **Point-in-time reads (`as_of`) / time machine.** Answering "what was live at path P at time T" requires per-document latest-version-≤-T resolution over full history (a path may have hosted different documents over time), plus a defined story for historical FTS and vector search — too expensive and too subtle to hang off a casual query parameter. Better shaped as an explicit rewind/export feature (materialize a repo's state at T into a new repo, or stream it out) with its own index support, e.g. `versions(repo_id, path, created_at)`.
- **Frontmatter & body update queries.** Bulk transformations driven by a query: "set `status: archived` on everything matching F," or structural body edits ("replace the section under the `## Status` heading"). The write model already accommodates this as N independent optimistic writes — each application is an ordinary versioned `docs.put` with a `prev` check, so a concurrent edit fails that one document instead of corrupting anything, and every change is attributed and reversible. The open questions are surface (does the server run the loop as a batch op with per-doc results, or does the CLI?) and atomicity (all-or-nothing needs the `changesets` entity above). Frontmatter-side updates need only a patch language over the parsed JSON (and a defined merge into `frontmatter_raw` that preserves untouched lines); body-side updates additionally need the block tree below to address targets structurally rather than by byte offset.
- **Structured body queries (block tree).** A cached parse of each version's body into a block tree — headings, sections, paragraphs, list/task items, code fences — stored as a derived artifact like chunks. Already motivated twice elsewhere: merge helpers (above) want it for three-way block merge, and link anchors (§11.2) want heading identity. With it, filters can address structure: "docs with an unchecked task item," "docs with an `## Decisions` section," via `$`-namespace intrinsics (e.g. `$headings`, `$tasks` — same collision-free convention as §5.1). One cached artifact feeds three features (merge, structure queries, body patches); build it when the first of the three lands.
- **Links, backlinks, and graph queries.** **Phase 1 shipped (M6, §11.2, `docs/links-plan.md`)** — the derived link index bound to document identity, and the `_static` single-hop CEL intrinsics. Remaining (Phase 2): embedded queries + the `--in` operator, the `_dyn` variants and bare-name unions (with a per-query dynamic-scope cap), and multi-hop `$reachable_from` (recursive-CTE traversal over the static index).
- **EDTF interval queries in CEL.** Frontmatter routinely carries date-range values in [Extended Date/Time Format](https://www.loc.gov/standards/datetime/) — `active_duty: 2025-05-01/2025-07-13`, `active_duty: 2025-05-01/..` for open-ended intervals, year- or month-granularity endpoints, etc. Making these queryable follows the §5.2 `list()` playbook: a set of CEL functions the compiler recognizes as hints — `edtf_contains(active_duty, "2026-06-01")`, `edtf_overlaps(active_duty, "2025-06/2025-08")`, `edtf_start(active_duty) < "2025-06-01"` — compiled to a UDF call registered on the connection (same mechanism as the existing `regexp` UDF for scope filtering, §5.1). The UDF pulls in a JS EDTF parser (Level 0–2, including `..`), so semantics are identical across SQLite and Postgres adapters. Missing or malformed values follow the same "predicate is false" rule as `list()` misses. Per-row parse cost is the honest limit — fine when other filters narrow the set, less fine when EDTF is the primary predicate at scale. Two follow-on options if that becomes real: (a) per-repo config listing EDTF fields to normalize into `(start, end)` at write time (same shape as the `link_config: { fields: [...] }` idea in §11.2), or (b) a general derived-artifact table (`versions_edtf(version_id, field, start, end)`) maintained by the same worker that does chunks. Both are additive — nothing in v1's schema blocks either.
- **Documents as list membership: the `--in` operator** `[OPEN]`. Any document already denotes a set — the documents it references — so no "list" doctype is needed. Introduce a `--in <path>` operator on `query` (also on the MCP `docs_query` tool and the REST list surface): membership = the outbound *static* edges from the current version of `<path>` (via the §11.2 links index) unioned with the results of any *embedded queries* the document contains. Both sources compose with the usual `--filter`, `--path`, `--text`, `--rank` — `--in` narrows the candidate set; the others predicate over it. Dissolves the earlier "saved views" open questions: storage is the document itself (versioned, diffable, restorable, authored — the whole §3 machinery for free); addressing is the document's own path (no new URI scheme, no views table); scope follows the rules already in force — author scope governs who can see the list document; caller scope filters the resolved membership the same way §11.2 traversal does. **Dynamic queries resolve at query time** — no result materialization, per the §11.2 "static edges only" note; a per-doc cap on embedded queries prevents pathological list docs from becoming fork bombs. Membership ordering: static-first in `ord` order, then dynamic, deduped by `document_id`; ordering is unspecified once `--filter` composes. Dangling static edges contribute nothing (consistent with "membership = what a reader could click through to"). Recursion is one hop only — a member that is itself a list doc is *not* expanded; multi-hop reachability lives in `$reachable_from` (§11.2). The CEL twin of `--in X` is `$in(X)` (§11.2 CEL surface) — same union semantics, same scope rules — so membership also composes *inside* filters as set algebra: `--filter '$in("moc/employees.md") && !$in("moc/contractors.md")'`.

  Roadmap coupling: the static half depends on the §11.2 link index shipping first; the dynamic half (embedded queries) is independent and could ship first as an honest slice — `--in X` returns query-derived membership only until static links land.

  Open: (1) embedded-query surface — fenced code blocks with an `mrplex-query` info string (Dataview-style, visible where a reader sees the list) vs. a frontmatter field (`queries: [...]`, structured and easier to validate at write time) vs. both; (2) whether query specs are cached in a small `document_queries(src_document_id, ord, spec)` sidecar maintained by the same worker (still no *result* materialization — just cached parse, doc-keyed and rebuilt on write of the source like `links`) or re-parsed from the source on every `--in` call; (3) the cap value on embedded queries per doc and the response when it's exceeded (reject the query with an explicit error, or truncate with a warning?); (4) whether frontmatter-declared link fields (`link_config.fields`) count toward static membership for `--in` by default, or only body-syntax edges do.
- **Aggregations and grouping** `[OPEN]`. Extend `query` with `--count`, `--group-by <field>`, `--facet <field>`; polymorphic `list()` semantics (§5.2) carry over so a document with `tags: [a, b]` counts once per bucket. Both adapters support this natively (SQL `COUNT`/`GROUP BY`, plus `jsonb_array_elements` on Postgres / `json_each` on SQLite for list explosion). Open: response shape (grow the existing envelope with a `groups`/`counts` sibling to `items`, or split off a distinct `docs.count`/`docs.aggregate` op?); text and rank interaction (does count reflect FTS relevance, and do groups return per-group top-k?); ETag semantics for aggregated responses vs. the row-level ETags §6.3 currently emits.
- **`docs.blame`.** Per-line last-touched-in version, computed by folding the existing unified-diff chain from oldest to newest. Kernel op, `/repos/{repo}/blame/{path}` REST route (JSON envelope), `docs_blame` MCP tool, `mrplex docs blame` CLI. Cost is O(chain length) per call — fine for interactive reads on typical documents; pathological chains are the same class that already stresses `docs.history`. No new storage; the diffs are the source.
- **Stable pagination cursors.** Snapshot the query's read-point (`max(version_id)` bound at query time) into the cursor alongside the ordering key. Second-page reads apply the same `version_id ≤ snapshot` predicate, so writes concurrent with a paging session never shuffle rows across page boundaries and the caller sees the coherent state they started paging from. The `versions(next_id is null)` current-version filter becomes a range check bounded by the snapshot; the versioned schema already contains everything needed.
- **Per-repo frontmatter schema** `[OPEN]`. Declared shape stored per repo (types, required fields, enums, string patterns), validated at write time. Turns the "YAML soup" reality into typed records without giving up prose, and is load-bearing for three downstream features: MCP tools shaped like the domain (`notes.create_task(title, due, tags)` derived from the schema, not just generic `docs.put`), LSP completion (below), and aggregations (above) that can trust field types. Open: schema language (JSON Schema for reach, or a small mrplex-native dialect that maps directly to CEL types?); enforcement mode (strict / warn / advisory, per repo *and* per field?); evolution when a required field is added to a repo with existing docs (reject writes, allow with defaults, or trigger a bulk-update pass via the future bulk-update op?); scope (schema lives in repo config, or as a system-namespace doc so it versions like anything else?).
- **Computed frontmatter as `$`-intrinsics.** `$word_count`, `$reading_time`, `$outgoing_links` (once §11.2 lands), `$last_body_edit` (most recent version whose body hash actually differed — distinguishes real edits from frontmatter-only touches). All derivable from data mrplex already stores; queryable via the same CEL surface as `$path`/`$updated_at`. Read-only — writes rejected with `computed_field`. Kills the "stash derived value in frontmatter and forget to update it" antipattern that otherwise grows in every corpus.
- **Change feed — webhooks and SSE.** Every write (create/update/move/delete) emits `{ repo, path, document_id, version_id, prev_version_id, actor, kind }`. Two subscribers: outbound webhooks (per-repo config, HMAC-signed, at-least-once with a small retry queue) and a `GET /repos/{repo}/events` SSE stream filtered by the caller's read scope (§8.2) — same scope filter as `query`, so no subscriber ever sees an event it couldn't have read. MCP notifications already exist; this is the plain-HTTP twin so a static-site builder, Meilisearch indexer, or an agent doesn't have to poll. Ordering guarantee is per-document, not global (matches the write model). Resume via `?from_version_id=…`.
- **`mrplex verify`.** Integrity scrub over the version chain: walk each document oldest-to-newest, recompute body/frontmatter hashes, confirm `frontmatter_raw` ↔ `frontmatter` round-trips byte-exact (§3.2), check `prev_id`/`next_id` symmetry, verify FTS/chunk/link derived tables against their source versions, report orphans. No writes. CLI + kernel op + optional CI mode that exits non-zero on any inconsistency. Cheap insurance for an append-only store where the chain *is* the guarantee.
- **Retention: rollup of autosave storms.** Per-repo policy that collapses contiguous same-author versions within N seconds into a single displayed step in `docs.history` — underlying versions retained, a `rollup_of` link identifies the group. Complements the embedding damper (§5.3): history stays readable when a WebDAV/Obsidian client sprays 40 saves per minute during an edit session. This is a view-time policy over an untouched underlying chain, not a delete — `docs.get --version` still resolves every intermediate step and `docs.diff` still spans them.
- **`mrplex-lsp`.** LSP over stdio for Markdown+YAML: frontmatter completion and diagnostics from the per-repo schema (above), go-to-definition and hover on links once §11.2 lands, code-actions surfacing `mrplex links repair`. Editors get the mrplex surface (VS Code, Neovim, Helix, Zed) through their existing LSP clients, without a per-editor plugin. Runs against `--database` or `--server` the same way the CLI does.
- **`mrplex export`.** Materialize a repo's live current versions as a filesystem tree — `path/` structure, `frontmatter_raw` + body written verbatim. Flags for `:deleted/` inclusion, historical version fanout (`--as-of` once PIT reads land), and index files. Hands the corpus to Hugo/Zola/11ty/rsync in one command; the byte-exact round-trip is what makes it trustworthy where a naive dump wouldn't be.
- **Attachments — content-addressed sidecars** `[OPEN]`. Bounded relaxation of the "text-only" non-goal (§2): binary blobs stored in a separate `attachments(sha256, bytes, media_type, size)` table, referenced from frontmatter via a `!attachment sha256:…` tag or from body via a canonical `attachment:` URL scheme. Uploaded via `POST /repos/{repo}/attachments` (returns the sha), garbage-collected once no live version references them. Solves "where do the images live" without a second system while preserving the invariant that documents themselves are Markdown-only. Open: scope (per-repo bucket, or a global content-addressed pool shared across repos?); auth (attachment access follows the doc scope of any referring version, or independent read-globs?); size limits and streaming (small blobs inline in the DB, large ones deferred until it matters?); GC policy (immediate refcount, or a periodic sweep?).
- **`mrplex import`.** Bulk-seed a repo from a filesystem tree. Default mode creates one version per file. `--replay-git` walks a git history and creates one mrplex version per commit that touched the file, preserving the commit author and timestamp — the schema already carries author + created_at, so this is straight population, not a new concept. Best onramp for existing Obsidian/Zettelkasten vaults; sits below git bridging (above) as its one-shot precursor.
- **Read-only follower servers.** `mrplex serve --read-only` refuses all writes at the surface (returns `read_only` on mutating kernel ops, rejects the corresponding MCP tools, 405s the REST verbs). Points at a Postgres follower via its own DATABASE URL; the DB layer handles replication. Horizontal read scale for the "one shared notes DB, N agent readers" pattern — writes stay on the primary, queries fan out. SQLite variant is trivially available via a read-only file open, useful for local backups.

### 11.1 WebDAV gateway — implementation spec

Deferred from v1 because naive mount clients (Finder, Windows Explorer) issue unconditional `PUT`s with no `If-Match` — there is nowhere in their protocol usage to carry `prev_version_id`. But the design contains its own answer: §4 says merge policy is a client concern, and the gateway is exactly that — **a stateful client of the kernel**. This section is the spec to build the module from.

#### What the gateway is

A third HTTP surface, peer to REST (§6.3) and MCP (§6.2): a route module at `/dav/{repo}/{path}` in the same server process, sharing the kernel instance, auth machinery, and config. It touches **only the public kernel contract** — which also means it can optionally run out-of-process as a standalone proxy speaking REST to a remote mrplex (the "stateful client" framing taken literally). In-process is the default: one binary, no extra hop.

The client half ships with every OS — that is the point of choosing WebDAV over a custom sync protocol. Mounting spawns the OS's own WebDAV client (macOS `webdavfs`, Windows WebClient service, Linux davfs2/gvfs), which translates filesystem syscalls into HTTP verbs: `readdir` → `PROPFIND Depth: 1`, open-for-read → `GET`, save → `LOCK`/`PUT`/`UNLOCK`. mrplex ships no client-side software.

**Boundary invariant:** gateway state never appears in the kernel schema, and the kernel never grows a DAV-shaped code path. Every relaxed semantic below is a gateway policy expressed through ordinary kernel calls.

#### Verb mapping

| DAV request | Gateway behavior | Kernel call |
|---|---|---|
| `OPTIONS` | Advertise `DAV: 1, 2` (Class 2 = locking; Finder/Windows refuse read-write mounts without it). | — |
| `PROPFIND` (Depth 0/1) | Prefix listing over live paths; directories are implicit. `getetag` = `version_id`, `getlastmodified` = `created_at`, `getcontentlength` = byte length of `frontmatter_raw` + `---` delimiters + `body` (correct only because §3.2 round-trips byte-exact — DAV clients cross-check size and ETag and desync otherwise). Phantom collections appear as empty dirs. `Depth: infinity` → 403. | `query` (path prefix) |
| `GET` | Serialize the doc byte-exact; ETag = `version_id`. Record `(credential, path) → version_id` in the read-map. | `docs.get` |
| `PUT` | Resolve `prev` per the three tiers below; lenient frontmatter pre-parse. No live doc at the path → create. | `docs.put` / `docs.create` |
| `DELETE` | Straight delegation; already idempotent (§4.1). | `docs.delete` |
| `MOVE` | Same-repo only; `prev` per tiers; content unchanged. | `docs.put` (dest path) |
| `COPY` | New document identity at the destination. | `docs.create` |
| `MKCOL` | Add a phantom collection. | — |
| `LOCK` / `UNLOCK` | Gateway lock table (below); lock refresh supported. | `docs.get` at lock time |
| `PROPPATCH` | Accept and discard (207 success); dead properties are not persisted. | — |

#### Resolving `prev` — three tiers, by how much the client tells you

1. **Locked writes (best path).** `LOCK` records the current `version_id` and issues a lock token; every `PUT` under that token uses the recorded version (or the last write inside the lock) as `prev`. A racing API writer surfaces as `stale_prev` → 412 — a true conflict signal. Finder/Windows require Class 2 to mount read-write, so the clients most in need of hand-holding are forced onto the best-behaved path.
2. **Session read-tracking.** DAV clients `GET` before `PUT` (open → edit → save); the read-map supplies the version last served *to that credential* as `prev` — the `If-Match` discipline reconstructed server-side.
3. **Cold unconditional `PUT`.** Fetch current, use it as `prev`, retry on `stale_prev` (bounded loop). This is last-writer-wins — as an explicit, documented merge policy running *through* the concurrency primitive, not around it. Every clobber is still a full version in the chain; the append-only history is what makes last-writer-wins tolerable on a filesystem surface.

#### Gateway-owned state

- **Lock table** — `{ repo, path, version_id, lock_token, owner, timeout, expires_at }`. In-memory with TTL is acceptable: DAV locks expire by spec, and losing the table on restart merely degrades clients to tiers 2–3.
- **Session read-map** — keyed by auth token; value `path → version_id`; TTL-bounded. Honest framing: DAV is stateless HTTP, so this is a heuristic cache, not ground truth — locks are the reliable mechanism; this tier improves the common unlocked case.
- **Phantom collections** — persisted set of `(repo, prefix)` created by `MKCOL` and not yet containing a live document; listed as empty dirs by `PROPFIND`; evaporate once a real doc exists beneath them. Persisted (unlike locks) so empty folders survive a restart.

#### Policies

- **Auth.** DAV clients speak Basic, not Bearer: the password field carries the mrplex token; the gateway resolves it to an actor exactly as the other surfaces do (§8). The username is ignored.
- **Sigil visibility.** The DAV view sets `include_hidden: true` unconditionally — a filesystem shows dotfiles to programs (`.obsidian/` must be visible). System namespace stays hidden, or is exposed read-only as a `:deleted/` folder — OS-style trash for free.
- **Junk writes.** Configurable ignore-list (`.DS_Store`, `._*`, `Thumbs.db`): accept and discard with a success status so clients don't retry. Autosave storms become ordinary versions; the embedding damper (§5.3) absorbs the cost.
- **Lenient frontmatter.** A filesystem must accept any bytes, and a malformed leading `---` block is exactly what a half-typed edit looks like mid-save. The gateway pre-parses: if the block is unparseable, it submits the whole file as body with empty frontmatter, re-splitting on the next valid save. No kernel change — the leniency is a gateway submission policy; API/REST clients keep strict validation.

#### Reference save flow

⌘S on the mounted volume → `LOCK` (gateway records current `version_id`, issues token) → `PUT` with token + raw file bytes (Basic → actor; pre-parse the `---` block; `kernel.docs.put(repo, path, prev_version_id, frontmatter_raw, body, actor)`) → gateway advances the lock record, answers 204 with the new ETag → `UNLOCK`. The kernel saw a completely ordinary optimistic write.

### 11.2 Links, backlinks, and graph queries — design sketch

> **Status: Phase 1 shipped (M6).** This section is the original design sketch; the `_static` intrinsics, the `links` index, `link_config`, `links.stale` / `mrplex links repair`, and identity-bound resolution are implemented (`docs/links-plan.md`). Where implementation refined the sketch, an inline **[shipped]** note marks it. Phase 2 (embedded queries, `--in`, `_dyn`, bare-name unions, multi-hop) remains future work.

A markdown corpus is a graph, and mrplex should know it. The architecture follows chunks and FTS exactly: **links are a derived index over documents' current versions** — extracted **[shipped: in the write transaction, not the async worker — extraction is pure CPU, so in-tx gives read-your-writes graph consistency; the worker still owns backfill]**, rebuildable from scratch, never source of truth. **Doc-keyed, not version-keyed:** one row per outbound edge from the live corpus, not per historical write. Every interesting query (backlinks, `--in` membership, orphans, traversal) asks about the current graph; the version-keyed alternative would inflate storage linearly with edit history for no query the design cares about. Historical link questions ("what did this doc link to in v42?") are answered by reparsing that version — consistent with the rest of the design's "current is fast, history is a scan" posture (see the PIT reads bullet above). That is also why deferring is safe: nothing in the v1 schema blocks this; a backfill pass builds the index for an existing corpus the same way `embed backfill` does.

#### Extraction

On write, the worker parses the new **current version** of the source document for outbound edges. Extraction is deterministic and server-side, like chunking (§5.3) — no hook — and driven by the effective **link config**, layered `hardcoded defaults → server config → per-repo override` on the §3.5 pattern. Each configured syntax contributes edges to the same table; disabling a syntax removes it from extraction entirely.

Recognized syntaxes and defaults:

- **CommonMark inline** `[text](path)` — default on. Includes the pointy-bracket destination form `[text](<path with spaces.md>)`.
- **CommonMark reference** `[text][id]` + `[id]: path` — default on.
- **Autolinks** `syntaxes.autolink` — default on. **[shipped: a bare `<foo.md>` is NOT a CommonMark autolink — autolinks require a scheme (`<https://…>`) and are always external, hence dropped. So this knob is effectively inert for the repo-local graph; kept for completeness. Pointy-bracket *link destinations* are covered by the inline rule above.]**
- **Wikilinks** `[[page]]` and `[[page|display]]` — default on. Extension elision on: `[[foo]]` resolves to `foo.md` first, then `foo/index.md`.
- **[shipped] The `!` embed/transclusion prefix** (`![alt](path)`, `![[page]]`) is **not a distinct syntax** — it's a rendering hint, captured as an ordinary edge from its base syntax (there is no `syntaxes.image` knob). Asset targets self-select out of the graph: they resolve to no document identity, so they're inert to every identity-based predicate. (Supersedes the original "Image links" bullet.)
- **Frontmatter references** — values of per-repo declared fields (`link_config.fields`), each a document path, scalar-or-list per the §5.2 convention. Default: empty list (opt-in per repo). Field names use CEL's field-access syntax (see **Field paths** below), so `link_config.fields` and `--filter` share one grammar.

Path resolution rules: relative targets normalize against the source doc's own path unless written repo-absolute (leading `/`); anchors (`#heading`) are preserved on the raw target; case follows the repo's path policy (§3.5.1). All of these are also link-config knobs on the same three-level cascade.

**Field paths.** The `field` column below and `link_config.fields` both use CEL's field-access syntax — filter authors already write it, so link config and filters share one path grammar:

- Dot notation for identifier-safe segments: `parent`, `project.lead`, `metadata.author.name`.
- Bracket-quoted strings for segments that aren't valid identifiers: `owners["team-lead"]`, `data["2024-Q3"]`.
- No explicit array indices in the path. The polymorphic `list()` convention (§5.2) treats scalar-and-list forms of a field uniformly, and extraction follows suit: `stakeholders.name` matches both `stakeholders: {name: alice}` and `stakeholders: [{name: alice}, {name: bob}]`; the two hits come out at different `ord` values under the same `field`.
- `$body` is the reserved sentinel for body-derived edges. Since `$` is not a valid identifier-start in CEL, `$body` is unambiguously a sentinel, not a field name — no collision possible with any frontmatter path.
- **Terminal-fields rule.** A declared `link_config.fields` entry extracts only when its resolved value is a string or list of strings. A non-terminal name on a list-of-objects extracts nothing — declare the terminal path (`stakeholders.name`) to reach in. Foot-gun prevented by construction: `link_config.fields: ["stakeholders"]` cannot silently harvest prose values from `stakeholders[*].bio`.

```sql
links (
  src_document_id    integer not null references documents(id),
  ord                integer not null,                 -- position within the current version
  field              text not null,                    -- '$body' for body-derived edges; CEL-style frontmatter path otherwise (e.g. 'parent', 'project.lead')
  target_raw         text not null,                    -- exactly what was written, normalized to repo-absolute; anchor preserved
  target_document_id integer references documents(id), -- resolved at extraction; null = dangling
  primary key (src_document_id, ord)
)
```

**Maintenance is local to the source.** On every `docs.put`/`docs.create` that advances doc D's current version, the worker deletes `where src_document_id = D` and re-extracts from the new body and frontmatter — one bounded transaction, no accumulation across history. `docs.delete` moves D into the system namespace; the worker clears D's outbound rows, and inbound rows (target = D) stay put — visibility filtering excludes them from live-namespace queries the same way `query` already excludes deleted docs (§8.2 / §4.1). `docs.move` produces **no edge churn at all** — target resolution is identity-bound (below), so inbound edges keep pointing at D. A change to the effective link config triggers a repo-wide re-extraction pass, driven by the same worker on the same path as `embed backfill`.

**Static edges only.** This index holds outbound *static* links — CommonMark, wikilink, and declared frontmatter references. **Dynamic membership** — a list document containing embedded queries whose results contribute to `--in X` (see the saved-views bullet in §11) — is *resolved at query time* against the current state of the repo, not materialized here. A materialized dynamic-membership index is a genuinely deep separate concern (repo-global invalidation, predicate-inversion, staleness budget); it would earn its own sketch if and when it becomes worth building.

Links are repo-local in this sketch; cross-repo references are `[OPEN]`.

#### Identity resolution is the load-bearing decision

At extraction, the normalized target path is resolved against the live path set; on success the link binds to the target's **`document_id`** — the identity, not the path. Consequences:

- **Backlinks and traversal survive renames with zero rewriting.** A move doesn't change `document_id`, so every inbound edge stays resolved. Only the link *text* goes stale.
- **Dangling links are first-class rows** — `target_document_id` null, `target_raw` kept. When a document later appears at the named path (create, move, or restore), a re-resolution pass binds them — matching what a reader clicking the link would experience.

#### Link rewriting is cosmetic, not structural — and opt-in

Because the graph is identity-bound, moving a page breaks nothing structurally; rewriting repairs stale *text*. The kernel never rewrites other documents implicitly — one move producing N surprise writes to other docs would violate both least-surprise and the single-write model. Instead:

- A staleness query (`links.stale`) lists live docs whose written link text no longer matches the resolved target's current path.
- `mrplex links repair` walks that list and rewrites each doc as an ordinary optimistic `docs.put` under the caller's token — `prev` checks apply, conflicts are reported and skipped, and every repair is a normal authored version in the chain.
- `[OPEN]` an opt-in per-repo `auto_repair` policy driving the same loop from the server-side worker after each move. Either way the mechanism is identical; the question is only who pulls the trigger.

#### CEL surface: `$in`, `$has`, `$backlinks()`, `$links()`

Graph predicates join the intrinsic `$` namespace (§5.1) as functions, compiled to SQL joins against the link index (static) or to embedded-query evaluation at query time (dynamic). The vocabulary deliberately avoids directional prepositions ("links to," "linked from") — those force the reader to work out which end of the arrow the current document sits on. **Possession language** is direction-unambiguous by construction:

| Concept | Boolean test | Collection |
|---|---|---|
| others → me | `$in(glob)` — "I'm in X's set" | `$backlinks()` |
| me → others | `$has(glob)` — "X is in my set" | `$links()` |

Four names, each the most natural word for its concept:

- **`$in(path-or-glob)`** — membership. The CEL twin of the `--in` operator (§11 list-membership bullet): `--in employees.md` on the CLI is exactly `$in("employees.md")` in a filter. A glob argument means "in any matching doc's set."
- **`$has(path-or-glob)`** — reference. Reads as the question people actually ask: "docs that have a link to horses.md" → `$has("horses.md")`.
- **`$backlinks()`** — the community's own word (Obsidian, Roam, LogSeq): the collection of docs referencing me, for `.exists()` / `.all()` / `.size()`.
- **`$links()`** — the collection of docs I reference.

No separate count functions: CEL's `size()` covers it — `$backlinks().size()` compiles to a scalar `COUNT` subquery.

**MOC set algebra** is the payoff — membership expressions compose like set operations:

```cel
$in("moc/employees.md") && !$in("moc/contractors.md")   -- set difference
$in("moc/employees.md") && $in("moc/on-call.md")        -- intersection
$in("moc/**")                                            -- union over a family of MOCs
!$in("**")                                               -- orphan: in nobody's set
$has("projects/**") && status == "active"                -- active docs referencing any project
$backlinks().exists(d, d.status == "draft")              -- something unfinished cites me
$links().size() == 0                                     -- leaf node
```

**Three-way static / dynamic / union partition.** Each of the four exists in three named forms:

- `_static` suffix — evaluates against the `links` index only. Cheap `EXISTS` join.
- `_dyn` suffix — evaluates *only* embedded queries at query time. Never touches the `links` index.
- No suffix — union of the two. Semantically `_static(x) || _dyn(x)`; cost is the sum.

So: `$in_static` / `$in_dyn` / `$in`, and likewise `$has_*`, `$backlinks_*()`, `$links_*()`. Bare `$in` agrees with `--in` without a special-case rule — both mean the union, by the same convention everything else follows. Debugging is mechanical: "why isn't this doc in `$in(X)`?" → check `$in_static(X)` and `$in_dyn(X)` independently to isolate a missing written link vs. a query miss.

**Field restriction is an optional second argument**, not a separate function family: `$has("projects/**", "parent")` — "names a project as its parent"; `$in("moc/**", "related")` — "listed in some MOC's `related` field." Field arguments use the CEL field-access syntax defined under **Field paths** above, including `"$body"` to restrict to body-derived edges. A field argument restricts evaluation to static edges — dynamic edges are fieldless by nature — so `$has(X, f)` ≡ `$has_static(X, f)`, and the `_dyn` forms reject a field argument at compile time.

**Multi-hop traversal** — feasibility settled, syntax `[OPEN]`:

```cel
$reachable_from("moc/index.md", 3)               -- inbound reachability within 3 hops of the index
```

Graph-distance vocabulary is correct *here*, where the question is genuinely about the graph. Multi-hop compiles to a recursive CTE — supported by both Postgres and SQLite, so the §7.2 parity guarantees hold; depth is capped and cycles terminate via the CTE's visited set. Traversal is offered against the *static* index only; there is no bounded-cost story for multi-hop over embedded queries, and there won't be until materialized dynamic membership arrives.

**Cost model — asymmetric between directions:**

- me → others `_dyn` (`$has_dyn`, `$links_dyn()`) — cheap, **row-bounded** by the current doc's embedded-query cap.
- others → me `_dyn` (`$in_dyn`, `$backlinks_dyn()`) — **corpus-bounded**: `$in_dyn("**")` fans out over every list doc in the repo. Same underlying problem that made materialized dynamic membership its own deferred concern.

**Scope interaction.** Every predicate — static, dyn, or union — respects the caller's read scope the same way `query` does (§8.2). Sources and targets outside the read globs are silently dropped, so the visible graph equals the readable graph. Embedded-query evaluation for `_dyn` variants also runs under the caller's scope, not the list document's author's scope — an author cannot leak paths a caller couldn't otherwise read.

**Phasing:**

- **Phase 1** — ships with the `links` index. Only the `_static` variants (including field-argument forms). Filter authors write `$in_static(X)` explicitly; queries stay stable when Phase 2 lands.
- **Phase 2** — ships with embedded queries and the `--in` operator. The `_dyn` variants and the bare-name unions ship together, so bare names' semantics are stable from birth. Inbound-direction `_dyn` (and therefore bare `$in` and bare `$backlinks()`) requires a runtime cap on the number of list docs the evaluator will fan out to — the error surfaces as `dynamic_scope_exceeded` with the list of docs it would have visited, and callers who know what they're doing can widen it explicitly (`--dyn-scope`).
