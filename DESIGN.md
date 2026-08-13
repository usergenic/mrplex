# mrplex — Design Document

**mrplex** — *Markdown Repos, plexed.* A hub for versioned markdown.

Status: **Working draft.** `[OPEN]` = unresolved. `[ASSUMPTION]` = default to challenge.

## 1. Goal

`mrplex` is a queryable, versioned store for Markdown documents with YAML frontmatter. Clients talk to it over two HTTP surfaces sharing one core:

- **MCP** — JSON-RPC 2.0 at `POST /rpc`, plus a STDIO transport. Primary interface for LLM agents.
- **REST + WebDAV** — resource-oriented routes (`GET /repos/{repo}/docs/{path}`, `PUT`, `DELETE`, `MOVE`, `PROPFIND`). Primary interface for humans, `curl`, editors that mount over WebDAV (including Obsidian without a plugin), and anything HTTP-ecosystem-shaped (caches, CDNs, `If-Match`).

Also included: a first-party `mrplex` **CLI** (§7.3) — a thin client over the MCP surface with ergonomic command flags in place of JSON envelopes.

Every update is an insert; nothing is overwritten; any past state is addressable.

External-source bridging (git repos, GitHub) is deliberately post-v1 — see §11.

## 2. Non-goals (v1)

- Not a Markdown renderer.
- Not a wiki UI.
- Not a general document store — only Markdown-with-YAML-frontmatter.
- Not a git mirror — no adapters, no sync. mrplex stands alone.

## 3. Data model

### 3.1 Concepts

- **Repo** — a container. Namespaces document paths and scopes queries. Also carries an optional path-config override (§3.5).
- **Document** — an identity for a Markdown file. Persists across renames and delete/restore cycles.
- **Version** — an immutable snapshot of a document: path, frontmatter, body, author, timestamp, and links to the previous and next versions (`next_id` null = current). Every write inserts one.
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
  path        text    not null,                          -- path AT this version (may be under a system sigil, §3.5)
  frontmatter json    not null,                          -- parsed YAML
  body        text    not null,
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
  embedding  vector,                                        -- pgvector / sqlite-vec
  primary key (version_id, ix)
)

api_tokens (
  id           integer primary key,
  user_id      integer not null references users(id),
  secret_hash  text    not null,                            -- argon2 or bcrypt of the token secret
  label        text,                                        -- human-readable, e.g. "obsidian plugin"
  scopes       json    not null,                            -- see §8
  expires_at   timestamp,                                   -- null = no expiry
  revoked_at   timestamp,                                   -- null = active
  created_at   timestamp not null,
  last_used_at timestamp
)

-- FTS index on versions.body
```

`prev_id` and `next_id` are inverse links on the fast-forward version chain: writing a new version `Y` with `prev_id = X` also sets `X.next_id = Y` in the same transaction. The two partial indexes are the schema-level guarantees behind §4 — no application code can bypass them.

### 3.3 Identifier discipline

Integer primary keys are internal — **they never cross the wire**. FKs use them so renames don't rewrite rows. The API exposes:

- **Slugs** — for users and repos. Globally unique. Renameable via `.rename` methods.
- **Opaque `version_id` strings** — clients echo them back to reference a version; they don't parse or construct them. Server chooses the representation.

Multitenancy would partition slug uniqueness later without changing the model.

### 3.4 Point-in-time, history, deletion, restore

State at time T: for each document, the latest version with `created_at ≤ T`. No derived "tree" table — the partial index on `(document_id) where next_id is null` makes current-version lookup a single index hit.

Renames stay on the same `document_id` with a new `path` (§4.1). **Deletion** and **restore** are the same primitive: a `docs.put` that moves the document to or from a system-namespace path.

- **Delete** — the kernel moves the document to `<system-sigil>deleted/{original_path}@{version_id}`, where `<system-sigil>` is the first entry of the effective `system_sigils` config (§3.5) and `{version_id}` is the version being superseded. Deterministic, unique, and browsable via `include_system: true` queries.
- **Restore** — a `docs.put` back to a user-territory path with `prev_version_id` pointing at the trashed version. Same document identity; history is one continuous chain.
- **Create-at-freed-path is not restore.** Once a document is in `:deleted/…`, its old user-territory path is free. A fresh `docs.create` at that path makes a **new document** with a new `document_id`. To continue the old identity, the caller uses `docs.put` with the trashed version's `version_id` as `prev` — the kernel already knows this is the same document from the version chain.

This eliminates the tombstone concept entirely: every version has real content at a real path; "deletedness" is just "currently lives under a system sigil."

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

#### 3.5.2 Configurable policy

Three fields, layered across three tiers:

```yaml
path:
  disallowed_chars: ["\\", "<", ">", ":", "|", "?", "\""]   # forbidden anywhere in a user-written segment
  system_sigils:    [":"]                                     # leading chars marking kernel-owned segments
  hidden_sigils:    ["."]                                     # leading chars marking user-hidden segments
```

Defaults follow Obsidian's cross-platform-safe rule (minus `/`). All three fields are lists of single characters.

**Tier layering:**

1. **Hardcoded defaults** in code — one constant, source of truth for tests and docs.
2. **Server config** — operator-set at startup; overrides hardcoded defaults wholesale (per field).
3. **Per-repo override** — stored on `repos.path_config` (§3.2). Non-null replaces the *field it sets*, not deep-merged. A repo that sets `hidden_sigils: [".", "_"]` sees exactly that; `disallowed_chars` and `system_sigils` still inherit from the server.

**Startup invariants** (server refuses to start otherwise):

- Each list contains only single characters.
- `PATH_SEPARATOR` appears in no list.
- `system_sigils ∩ hidden_sigils = ∅`.
- `hidden_sigils ∩ disallowed_chars = ∅` (users must be able to write chars they use to hide their own folders).
- Both sigil lists are non-empty (otherwise the kernel has no canonical sigil to emit under).

#### 3.5.3 Segment validation

Applied at `docs.create` and `docs.put`, per segment:

1. Segment is not `EMPTY_SEGMENT`, `CURRENT_SEGMENT`, or `PARENT_SEGMENT`.
2. Segment's first char is not in the effective `system_sigils` (would collide with kernel-emitted paths).
3. No character in the segment is in the effective `disallowed_chars`.

Failure at any step → `path_invalid`.

Validation is **write-time only**. Existing versions keep whatever path they had; history, diff, and point-in-time reads work regardless of current config. Tightening config *does not* rewrite or hide existing rows — it only affects future writes. This is the same rule the system uses for slug validation on rename.

**Warning on tightening:** `repos.set_path_config` returns an advisory list of currently-live paths in the repo that would fail new validation. These paths remain readable but can no longer be `put` at their current path — the only way to fix them is to move them to a valid path.

#### 3.5.4 Sigil semantics: set for input, first for output

The sigil lists are **sets for validation** — any listed sigil marks a segment as system-owned or hidden. The kernel is **canonical on emission** — when it constructs a system path it always uses `system_sigils[0]`:

```ts
canonicalSystemSigil(cfg) = cfg.system_sigils[0]
canonicalHiddenSigil(cfg) = cfg.hidden_sigils[0]

// deletion target:
systemPath(cfg, "deleted", `${originalPath}@${versionId}`)
  // = ":deleted/notes/foo.md@v_abc123"  when system_sigils[0] === ":"
```

**Why multiple accepted sigils.** Steady-state deployments use exactly one system sigil and one hidden sigil. The list form exists for two use cases:

- **Migration.** An operator moving from `:` to `#` sets `system_sigils: ["#", ":"]`. New system paths land under `#deleted/…`; existing `:deleted/…` paths remain valid, remain excluded from default queries, and remain unwritable by users. Once cleared, `:` can be dropped from config.
- **Legacy compatibility.** A repo importing content from a system that already used `_hidden/` for hidden files can set `hidden_sigils: [".", "_"]` and both conventions coexist.

**Semantic equivalence across accepted sigils.** For any kernel operation that looks up system state by *logical name* (e.g., a future `<system>/config/<key>`), paths under any accepted sigil are treated as the same logical location. If duplicates exist across sigils (bug, manual DB surgery, cross-tool disagreement), the kernel resolves by **newest-wins with a warning** — the most recently written version is the effective value, and a `mrplex system doctor` report surfaces the duplicates for operator cleanup.

Deletion paths use `{original_path}@{version_id}` as the key, not a logical name, so duplicate-across-sigils is not a real concern for `:deleted/`.

#### 3.5.5 Query default exclusion

Filter, text, rank, and `PROPFIND` all exclude any document whose current `path` has **any segment** whose first char is in `hidden_sigils ∪ system_sigils`. Two opt-in flags on the query spec restore visibility:

- `include_hidden: true` — surfaces paths with hidden-sigil segments.
- `include_system: true` — surfaces paths with system-sigil segments.

Compiled to SQL as one `NOT (path LIKE 'X%' OR path LIKE '%/X%')` clause per configured sigil. Cross-repo queries evaluate each repo's effective config independently.

#### 3.5.6 Slug validation

Repo and user slugs are validated against **server-level** path config (per-repo config does not apply — the slug is validated before any repo has a chance to override, and users are global). Rules:

- No character in `PATH_SEPARATOR`, `disallowed_chars`.
- First character is not in `system_sigils` or `hidden_sigils`.
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
4. `docs.delete` is kernel-side sugar for `docs.put` to `<system-sigil>deleted/{prev_path}@{prev_version_id}` with body and frontmatter unchanged. Users cannot directly write at any system-sigil path (§3.5); the kernel bypasses that check for its own deletion move. Restore is a plain `docs.put` back to a user-territory path.
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
  Data: `{ current_version_id, current_path, submitted_prev_version_id }` — `current_path` lets clients see whether the document has since been moved (including moved into `:deleted/…` by another actor).

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
- `frontmatter_invalid` — YAML parse error, or type violation against repo schema hints (§5.2).
- `filter_invalid` — CEL parse or type error.
- `as_of_invalid` — malformed or unparseable timestamp.

### 4.4 Authorship

Derived from the authenticated caller's token → user mapping. Never trusted from the request body.

## 5. Query

Three composable modes: **filter** (CEL over frontmatter/path/created_at), **text** (FTS over body), **rank** (semantic over embeddings).

### 5.1 Query spec

```json
{
  "repo":            "notes",
  "filter":          "status == 'draft' && 'pricing' in list(tags)",
  "text":            "pricing OR fees",
  "rank":            "tiered SaaS pricing",
  "as_of":           "2026-06-01",
  "limit":           20,
  "include_hidden":  false,
  "include_system":  false
}
```

CEL scope: `frontmatter` fields are top-level (`status`, `tags`); `path` and `created_at` also in scope. No `doc.` prefix.

FTS is a first-class feature — markdown is the whole product, searching its prose is table stakes. The backend is **adapter-owned**: SQLite adapters use FTS5, Postgres adapters use `tsvector`. Result sets are portable across adapters; ranking scores are not (§7.2 parity table).

**Default exclusion of hidden and system paths.** By default (both flags `false`), the compiled query drops any document whose current `path` contains any segment starting with a hidden or system sigil (§3.5). This applies uniformly to `filter`, `text`, `rank`, and WebDAV `PROPFIND`. Set `include_hidden: true` to surface `.<seg>/…` paths; set `include_system: true` to surface `:<seg>/…` paths — this is how a client browses `:deleted/` to find something to restore.

Compiled to SQL: for each accepted sigil `X` in the effective config, one clause `NOT (path LIKE 'X%' OR path LIKE '%/X%')`, ANDed into the query — string-matching only, no generated columns in v1. Cross-repo queries evaluate each repo's effective config independently.

**Perf shape of sigil exclusion.** The concern: as trash accumulates, every default query pays a filter cost against `:deleted/` rows. In practice this is smaller than it looks:

- **Bounded by the live-set index.** All queries run on top of the partial index `versions(repo_id, path) where next_id is null`. Its size is the count of *currently-live* documents (including trashed-current ones), not total version history. Trash growth is linear in delete count, not in edit count or total content size.
- **`LIKE 'X%'` is index-friendly with a rewrite.** At query-compile time, `path LIKE ':%'` becomes a range predicate `path >= ':' AND path < ';'` — a B-tree range scan on both PG and SQLite, no collation or pragma dependencies. The compiler is expected to do this rewrite for the leading-sigil check; the `%/:%` middle-of-path variant still needs `LIKE`, but that form is rare in practice (users don't write paths with `:` mid-segment because `:` is in `disallowed_chars`).
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

- **On write.** After `docs.create` / `docs.put` commits the version, the server chunks the body (chunking strategy is fixed and server-side; the hook only sees chunk text, not policy), calls the hook, and writes the returned vectors into `chunks`. This runs *outside* the write transaction (see failure behavior below).
- **On backfill.** A `mrplex embed backfill --repo <slug>` CLI command re-chunks and re-embeds current versions missing chunks — useful when configuring an embedding hook for the first time, or when swapping models.

**Failure behavior.** Embedding failure must not fail the write. A markdown store that rejects writes because an external model is down is a bad store. Instead:

- Version write commits regardless.
- If the hook is unreachable / errors / times out, the version is enqueued in an `embedding_backlog` table (schema: `version_id`, `attempts`, `last_error`, `next_retry_at`). A background worker retries with exponential backoff.
- Vector search silently skips documents without chunks — they don't appear in `rank` results but *do* appear in `filter` and `text` results (their body is still indexed for FTS).
- Operators can inspect backlog via `mrplex embed status` (`[OPEN]` exact shape).

**Model changes.** If the hook starts returning a different `model` or `dim`, the server writes a warning and stores the new-model vectors alongside the old ones (`chunks.model` column, `[OPEN]` — needs to be added to §3.2 if we go this route). Vector search filters by current model. Backfill re-embeds under the new model on demand.

`[OPEN]` Whether to ship a default "no-op" hook (returns zero vectors, `dim = 1`) so the server starts cleanly without any embedding configuration, at the cost of hiding misconfiguration. Leaning yes for dev, warn loudly.

## 6. Interfaces

Two HTTP surfaces (`/rpc` for JSON-RPC, resource routes for REST/WebDAV), both thin translation layers over one shared **kernel**. Each surface lives in its own module; adding a third surface later (gRPC, GraphQL) is another translation layer, not a rewrite.

### 6.1 Kernel

The kernel is the only place the write model, concurrency rules, and error catalog exist. Surfaces validate their envelope, resolve slugs to internal ids, delegate, and translate the result.

```types
kernel.repos.list()                                       → Repo[]
kernel.repos.create(slug)                                 → Repo
kernel.repos.rename(slug, new_slug)                       → Repo
kernel.repos.set_path_config(slug, config | null, actor)  → { repo: Repo, warnings: PathWarning[] }   -- see §3.5; null clears the override

kernel.users.list()                                       → User[]
kernel.users.create(slug)                                 → User
kernel.users.rename(slug, new_slug)                       → User

kernel.docs.get(repo, path, as_of?)                       → Version
kernel.docs.history(repo, path, limit?, before?)          → Version[]
kernel.docs.diff(repo, path, from, to)                    → UnifiedDiff

kernel.docs.create(repo, path, frontmatter?, body?, actor)               → Version
kernel.docs.put(repo, path, prev_version_id, frontmatter?, body?, actor) → Version   -- path may differ from prev (= move); prev under a system sigil + destination in user territory (= restore)
kernel.docs.delete(repo, path, prev_version_id, actor)                   → Version   -- sugar for docs.put to :deleted/{prev_path}@{prev_version_id}

kernel.tokens.list(actor)                                 → Token[]
kernel.tokens.create(label, scopes, expires_at?, actor)   → { token, meta }
kernel.tokens.revoke(token_id, actor)                     → Token

kernel.query(spec, actor)                                 → Version[]
```

`actor` is a resolved `{ user_id, scopes }`, populated by the surface after it authenticates the caller — never taken from a request body. The kernel calls `authorize(actor, action, target)` before every operation (§8).

### 6.2 MCP surface (`POST /rpc`)

`[ASSUMPTION]` JSON-RPC 2.0 over HTTP; STDIO transport also supported (same method set, different envelope). Method names mirror the kernel one-to-one.

```rpc
mrplex.repos.list()                                             → Repo[]
mrplex.repos.create(repo)                                       → Repo
mrplex.repos.rename(repo, new_repo)                             → Repo
mrplex.repos.set_path_config(repo, config | null)               → { repo: Repo, warnings: PathWarning[] }

mrplex.users.list()                                             → User[]
mrplex.users.create(user)                                       → User
mrplex.users.rename(user, new_user)                             → User

mrplex.docs.get(repo, path, as_of?)                             → Version
mrplex.docs.history(repo, path, limit?, before?)                → Version[]
mrplex.docs.diff(repo, path, from, to)                          → UnifiedDiff

mrplex.docs.create(repo, path, frontmatter?, body?)               → Version
mrplex.docs.put(repo, path, prev_version_id, frontmatter?, body?) → Version   // path may differ from prev (= move); prev under system sigil + dest in user territory (= restore)
mrplex.docs.delete(repo, path, prev_version_id)                   → Version   // sugar; kernel moves to :deleted/{prev_path}@{prev_version_id}

mrplex.tokens.list()                                            → Token[]
mrplex.tokens.create(label, scopes, expires_at?)                → { token, meta }
mrplex.tokens.revoke(token_id)                                  → Token

mrplex.query(spec)                                              → Version[]
```

### 6.3 REST + WebDAV surface

Same operations, exposed as resources. `version_id` is the ETag; `If-Match` is the optimistic-concurrency check. HTTP caching semantics (304, ETag, `If-None-Match`) work naturally over immutable content.

```rest
GET     /repos                                          → Repo[]
POST    /repos                     { slug }             → Repo
GET     /repos/{repo}                                   → Repo
MOVE    /repos/{repo}              Destination: /repos/{new_repo}   → Repo
PUT     /repos/{repo}/config       { path_config | null }         → { repo: Repo, warnings: PathWarning[] }  -- see §3.5; null clears

GET     /users                                          → User[]
POST    /users                     { slug }             → User
MOVE    /users/{user}              Destination: /users/{new_user}   → User

GET     /repos/{repo}/docs/{path}                       → Version
                                   Accept: application/json  → Version envelope
                                   Accept: text/markdown     → raw body (frontmatter as `---` block)
                                   ?as_of=<timestamp>        → point-in-time read
GET     /repos/{repo}/docs/{path}/history               → Version[]
GET     /repos/{repo}/docs/{path}/diff?from=&to=        → UnifiedDiff

PUT     /repos/{repo}/docs/{path}                       → Version
                                   If-None-Match: *      → create (fails if exists → 412)
                                   If-Match: <version_id> → update at this path, OR move here (fails on mismatch → 412 stale_prev)
                                   -- restore is just PUT to a user-territory path with If-Match on a :deleted/... version
DELETE  /repos/{repo}/docs/{path}  If-Match: <version_id> → Version (kernel moves to :deleted/{path}@{version_id})
MOVE    /repos/{repo}/docs/{path}  Destination: /repos/{repo}/docs/{new_path}
                                   If-Match: <version_id>
                                   → sugar for PUT at Destination with body/frontmatter unchanged

GET     /query?repo=&filter=&text=&rank=&as_of=&limit=&include_hidden=&include_system=      → Version[]
POST    /query                     { QuerySpec }             → Version[]

GET     /me/tokens                                           → Token[]
POST    /me/tokens                 { label, scopes, expires_at? } → { token, meta }
DELETE  /me/tokens/{id}                                      → Token
```

`GET /query` and `POST /query` accept the same parameters — GET as query-string, POST as JSON body. GET is preferred for cacheability and shareability; POST is the fallback for queries whose URL-encoded form would exceed reasonable URL length (~8KB). Every `QuerySpec` field maps to a query parameter of the same name.

`[OPEN]` **Query response cacheability.** GET `/query` responses should carry `ETag` (a hash of the sorted `version_id` list in the result) and `Cache-Control`, so CDNs and browser caches can revalidate with `If-None-Match` → 304. Cheap to compute; invalidates exactly when the result set would change.

`[OPEN]` **Repeatable query semantics.** With `as_of` absent, `GET /query` returns "now" — same URL, different results over time, poor caching behavior. Two options: (a) require `as_of` on GET, or (b) auto-pin `as_of` to the request time and echo the resolved value in a response header (`X-As-Of: <timestamp>`) so clients can re-request the same snapshot deterministically. Leaning (b) — better ergonomics, preserves caching, no extra work for the common case.


`If-Match` collapses the explicit `prev_version_id` parameter of `docs.put` / `docs.delete` into the standard HTTP conditional-request mechanism — same semantics, native to the protocol. `PUT` with `If-None-Match: *` is the RFC-standard "create only if absent" pattern, so we don't need a separate `docs.create` route. `MOVE` is sugar over a `PUT` at the destination path with the source's `If-Match`.

**Error mapping** (kernel error → HTTP). All error responses carry the kernel error `code` and `data` in the JSON body; the HTTP status just picks the closest match.

- `unauthorized` → **401 Unauthorized**.
- `forbidden` → **403 Forbidden**.
- `stale_prev`, `create_conflict` → **412 Precondition Failed**, with the current `version_id` in the `ETag` response header.
- `path_taken`, `slug_taken` → **409 Conflict**.
- `repo_not_found`, `user_not_found`, `doc_not_found`, `version_not_found` → **404 Not Found**.
- `version_not_in_document` → **422 Unprocessable Entity**.
- `slug_invalid`, `path_invalid`, `frontmatter_invalid`, `filter_invalid`, `as_of_invalid` → **400 Bad Request**.

WebDAV `PROPFIND` (for filesystem-mount clients) returns a directory listing of live paths under the given path prefix. Advanced WebDAV features (`LOCK`, `PROPPATCH`) are deferred — see §11.

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
  frontmatter, body,
  author,                                        -- User
  created_at
  -- No tombstone field. A "deleted" version is one whose path lives under a system sigil (§3.5).
}
Scope   = {
  repo:   string | string[],                     -- slug, glob, or list thereof
  read?:  string | string[],                     -- path glob or list thereof
  write?: string | string[]
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

## 7. Deployment & clients

### 7.1 Deployment shapes

- **Local, embedded** — single binary, SQLite file, no daemon. Ideal for personal notebooks and CLI-only workflows.
- **Local, containerized** — binary + `docker compose up` for Postgres + pgvector. First-class path, not "production only" — a user who wants to run the server flavor on their laptop should have no more friction than the SQLite path.
- **Self-hosted server** — same binary + managed Postgres + pgvector, HTTP(S) surfaces.

The binary takes `--database sqlite:./mrplex.db` or `--database postgres://…` (also via `MRPLEX_DATABASE` env). No other config surgery to switch.

**Implementation language: TypeScript (Node).** mrplex is a thin wrapper around a storage engine plus a CEL-to-SQL compiler and a couple of HTTP surfaces — none of it CPU-bound. TypeScript is chosen for portability (Node runs everywhere the SQLite/PG drivers do), ergonomic distribution (single `npm` install for the CLI, containerized for the server), and a mature ecosystem for the pieces we need (`better-sqlite3` / `pg`, `cel-js` or a hand-rolled parser, and JSON-RPC / HTTP libs).

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
| Vector search recall | **Identical at small scale.** | Both engines return the same top-k for small corpora. |
| Vector search at scale | **May differ.** | pgvector offers HNSW / IVFFlat with tuning knobs; sqlite-vec is brute-force in v1. Recall converges; latency does not. |
| Auth, scopes, error catalog | **Identical.** | Backend-independent. |
| Concurrent throughput | **May differ.** | SQLite is single-writer per file; PG is multi-writer. §4 already floors both at "single-writer per repo," which SQLite satisfies. |

The mechanism that keeps these guarantees honest is a shared **kernel test suite** that runs against every registered adapter in CI. An adapter that fails a semantic-parity test is not a supported adapter.

#### 7.2.2 Adapter contract

An adapter implements one interface, exposed to the kernel. The methods below are the minimum required surface; anything an adapter can't implement natively must be emulated in the adapter itself (not pushed up into the kernel).

```types
StorageAdapter = {
  // Lifecycle
  open(config)                                              → Storage
  close()                                                   → void
  migrate()                                                 → void      // idempotent; brings schema to current version

  // Transactions
  tx(fn: (Tx) => T)                                         → T         // serializable-or-equivalent; nested tx = savepoint or flatten

  // Slug-space (users, repos)
  users_list() / users_create(slug) / users_rename(id, slug) / users_by_slug(slug)
  repos_list() / repos_create(slug) / repos_rename(id, slug) / repos_by_slug(slug)

  // Document identity
  document_create(repo_id)                                  → document_id

  // Version chain (the hot path — must be atomic per §4)
  version_insert({
    document_id, repo_id, prev_id, path, frontmatter, body,
    author_id, created_at
  })                                                        → version_id
  // Contract: inside one tx, insert the new version AND set prev.next_id = new.id.
  // Must enforce the two partial indexes from §3.2 at the storage layer, not application code.

  version_by_id(id)                                         → Version | null
  version_current(repo_id, path)                            → Version | null   // via the partial-index on (repo_id, path) where next_id is null
  version_history(document_id, limit, before?)              → Version[]
  version_at(document_id, as_of)                            → Version | null

  // Query — the one place adapters may differ in perf but not in semantics
  query({
    repo_ids, filter_ast, text?, rank?, as_of?, path_globs, limit
  })                                                        → Version[]
  // filter_ast is CEL, compiled by the kernel; the adapter translates to its dialect.
  // path_globs come from the caller's read scope (§8.2) — enforced here, not above.

  // Full-text
  fts_index(version_id, body)                               → void
  fts_search(repo_ids, query)                               → { version_id, score }[]

  // Vector
  chunks_upsert(version_id, chunks: { ix, text, embedding }[]) → void
  vector_search(repo_ids, embedding, k)                     → { version_id, chunk_ix, score }[]

  // Tokens
  tokens_list(user_id) / tokens_by_hash(hash) /
  tokens_create({ user_id, secret_hash, label, admin, scopes, expires_at }) /
  tokens_revoke(id) / tokens_touch_last_used(id)
}
```

**Contract obligations** an adapter must satisfy to be considered compliant:

1. **Atomic version insertion.** `version_insert` inserts the new version and updates `prev.next_id` in one transaction. Partial failure is not observable.
2. **Schema-level invariants.** The two partial unique indexes in §3.2 (`versions(document_id) where next_id is null` and `versions(repo_id, path) where next_id is null`) are enforced by the storage engine, not by application code. If the engine has no partial-index primitive, the adapter simulates one (e.g., a trigger-maintained materialized state), but the invariant holds.
3. **Isolation.** `tx()` provides serializable behavior *for the operations in the kernel* — writes to the same document serialize; readers never observe partial version chains. SQLite's `BEGIN IMMEDIATE` and PG's `REPEATABLE READ` (with retry on serialization failure) both qualify.
4. **CEL filter semantics.** The adapter translates the CEL AST such that a given filter over a given corpus returns the same rows on every adapter. Missing keys, null, scalar-or-list coercion (§5.2), and type-mismatch handling all follow the semantics defined in §5.
5. **Scope-glob enforcement in `query`.** The adapter receives `path_globs` and returns only rows matching them — silently dropped, not errored (§8.2). Enforcing this in the adapter (not the kernel) lets the engine push the filter into indexes.
6. **Result-set portability.** For FTS and vector search, the *set* of returned documents is identical across adapters for the same corpus and query; only ranking scores may differ.
7. **Point-in-time reads.** `version_at(document_id, as_of)` returns the latest version with `created_at ≤ as_of`, or null. Same semantics on every adapter. Callers who want to distinguish "deleted at T" from "live at T" inspect the returned version's `path` (system-sigil-prefixed = deleted; §3.5).
8. **Migrations.** `migrate()` is idempotent and forward-only. Adapters own their migration files; the kernel invokes `migrate()` on startup unless `--no-migrate` is set.

**What an adapter is *not* required to provide:**

- A specific index strategy — only that queries return correct results in bounded time.
- Native JSON operators — the adapter may synthesize containment via row-generating joins (as SQLite does for the list branch of §5.2).
- Native vector or FTS — an adapter targeting a store without them can back these with an auxiliary engine (e.g., a companion process) as long as the semantic-parity tests pass.

**Adding a third adapter** (e.g., DuckDB, MySQL, CockroachDB, an object-store-backed engine) means: implement the interface, register it in the `--database` scheme registry, pass the shared kernel test suite. No changes to the kernel or surfaces.

### 7.3 `mrplex` CLI

The CLI is a thin client over the MCP surface (§6.2) — no capabilities of its own, no direct database access when talking to a remote server. It shells out to `POST /rpc` (or the in-process kernel, if running against a local SQLite file) and pretty-prints results.

Commands mirror MCP method names in a `noun verb` shape:

```rpc
mrplex repos list
mrplex repos create <slug>
mrplex repos rename <slug> <new-slug>
mrplex repos set-path-config <slug> [--from-file FILE | -] | --clear
                                                                  # FILE is JSON with any subset of { disallowed_chars, system_sigils, hidden_sigils }
                                                                  # --clear removes the override, reverts to server config

mrplex users list
mrplex users create <slug>
mrplex users rename <slug> <new-slug>

mrplex docs get <repo> <path> [--as-of <ts>]
mrplex docs history <repo> <path> [--limit N] [--before <ts>]
mrplex docs diff <repo> <path> --from <v> --to <v>

mrplex docs create <repo> <path> [--from-file FILE | -]           # body from file or stdin
mrplex docs put <repo> <path> --prev <version-id> [--from-file FILE | -]
                                                                  # <path> may differ from prev's path → move (optionally + content change)
                                                                  # to restore a deleted doc, use put with --prev = trashed version id
mrplex docs delete <repo> <path> --prev <version-id>
mrplex docs mv <repo> <from-path> <to-path> --prev <version-id>   # sugar: put to <to-path> with unchanged content

mrplex query --repo <slug> [--filter EXPR] [--text Q] [--rank Q] [--as-of TS] [--limit N]

mrplex tokens list
mrplex tokens create --label LABEL --scope <slug>:read=<glob>,write=<glob> [--admin] [--expires TS]
mrplex tokens revoke <token-id>
```

**Global flags:**

- `--server <url>` (default from config) — the mrplex endpoint. When absent and a local SQLite file exists, run against it directly.
- `--token <token>` (default from config or `MRPLEX_TOKEN` env) — bearer token.
- `--json` — emit raw JSON instead of pretty output. Enables piping into `jq`.

**Input conventions:**

- `--from-file FILE` reads a Markdown document (frontmatter + body) from a file; `--from-file -` reads from stdin.
- The CLI parses the file into `{ frontmatter, body }` before submission; the RPC layer never sees the raw file.

**Output conventions:**

- Reads default to pretty-printed Markdown (frontmatter as YAML block, body underneath) on stdout — same shape a user would edit.
- Writes print the new `version_id` on stdout (for scripting: `NEW=$(mrplex docs put ... --prev "$PREV")`) with human context on stderr.
- Errors print the kernel error `code` and `data` to stderr, exit non-zero. The exit code encodes the error family: 1 for validation, 2 for concurrency/conflict, 3 for auth, 4 for not-found, 10 for network/transport.

**Config file:** `~/.config/mrplex/config.toml` holds server URL and default token. `mrplex config set-server URL` / `mrplex config set-token TOK` manage it; `mrplex login` is sugar that prompts for a token and stores it.

Everything the CLI does is achievable with `curl` against the MCP or REST surfaces; the CLI just makes it pleasant.

## 8. Auth & security

### 8.1 Model

Opaque bearer tokens with per-token capability scopes. Each token belongs to one user; a user may hold many tokens (one per client — CLI, Obsidian plugin, agent — each revocable individually). Tokens are stored hashed (argon2 or bcrypt); only the hash is persisted, the plaintext is shown once at issuance.

Every request presents `Authorization: Bearer <token>`. The auth middleware:

1. Looks up the token by hash. If missing / revoked / expired → **`unauthorized`**.
2. Loads `{ user_id, scopes }` and attaches them as the resolved `actor` (§6.1).
3. Delegates to the kernel operation, which runs an `authorize(actor, action, target)` check. On insufficient scope → **`forbidden`**.

### 8.2 Scope grammar

Two independent axes: **server-level power** (a single boolean) and **data access** (per-repo, per-action path globs). Actions do not nest; each is granted explicitly.

```types
StringOrList = string | string[]

Scope = {
  repo:   StringOrList,       // repo slug, glob, or list thereof
  read?:  StringOrList,       // path literal, glob, or list thereof
  write?: StringOrList
}

Token = {
  admin:  boolean,            // server-level: repos.create/rename, users.*, others' tokens
  scopes: Scope[]
}
```

Every field is polymorphic scalar-or-list, matching the §5.2 convention. At the auth boundary each field is normalized to a list (scalar → `[scalar]`, missing → `[]`) before matching.

**Actions:**

- **`read`** — `docs.get`, `docs.history`, `docs.diff`, `query`, `repos.describe`, and the corresponding REST/WebDAV GET routes. Path must match a `read` glob for the target repo.
- **`write`** — `docs.create`, `docs.put`, `docs.delete`. Path must match a `write` glob. **Does not imply `read`** — a token that wants both lists both.
- **`admin: true`** — `repos.create` / `repos.rename`, all `users.*`, and management of tokens other than the caller's own. Not scoped to a repo (there is no repo yet for `repos.create`, and `users.*` isn't repo-shaped).

**Glob semantics:** gitignore-style. `**` matches any subtree, `*` matches within a path segment, `!pattern` negates. Literals are just globs with no metacharacters.

- Repo globs match against the repo slug. Since slugs contain no `/`, `*` is the canonical wildcard at the repo level; reserve `**` for paths.
- Path globs match against **the path at the version being accessed** — so `read: "drafts/**"` still reads historical states of a doc that has since been renamed out of `drafts/`.
- A `docs.put` whose `path` differs from `prev`'s path (a move) requires **both** paths to match `write` — moving into or out of scope is a write on both endpoints.
- **System-namespace carve-out.** No user scope can grant `write` at a system-sigil path (§3.5), so the "both endpoints" rule would forbid every deletion (destination is `:deleted/…`) and every restore (source is `:deleted/…`). Instead: for any move where **one** endpoint is under a system sigil, scope is checked only on the **user-territory** endpoint. Users get scope-checked on what they can see and reason about; the system-namespace endpoint is kernel-controlled.
- `query` appends the token's `read` globs as an implicit path filter. Results outside scope are silently dropped, not 403'd — queries return what the caller is allowed to see, not what exists.
- `repos.list` returns only repos whose slug matches at least one `repo` pattern across the token's scopes.

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
{ "admin": false, "scopes": [{ "repo": "team-*", "read": "**", "write": "inbox/**" }] }
```

Multiple scope entries stack — union semantics. A token can be broadly `read` on one repo family and narrowly `write` on a single repo by listing two entries.

**Self-token management** is a property of the token model, not a scope grant: any authenticated user can `list` and `revoke` their own tokens and `create` new ones whose `admin` bit and `scopes` are a subset of the parent token's. Managing *other* users' tokens requires `admin: true`.

Bootstrap root token: `{ admin: true, scopes: [{ repo: "*", read: "**", write: "**" }] }`.

### 8.3 Token management

```rpc
mrplex.tokens.list()                                        → Token[]         -- current user's tokens
mrplex.tokens.create(label, scopes, expires_at?)            → { token, meta } -- token shown once, in plaintext
mrplex.tokens.revoke(token_id)                              → Token
```

Corresponding REST routes:

```rest
GET    /me/tokens                                           → Token[]
POST   /me/tokens          { label, scopes, expires_at? }   → { token, meta }
DELETE /me/tokens/{id}                                      → Token
```

Server-side, `api_tokens` (§3.2) holds `secret_hash` (never the plaintext), `label`, `scopes`, `expires_at`, `revoked_at`, `last_used_at`.

Bootstrap: server creation seeds a `system` user and issues one root token (`{ repo: "*", actions: ["admin"] }`) printed to the operator once at first launch. Everything else can be created from there.

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

- **Deletion is a move to a system-namespace path, not a tombstone (§3.4, §3.5).** The kernel moves the doc to `<system-sigil>deleted/{original_path}@{version_id}`. Restore is a plain `docs.put` back to user territory. No `tombstone` column, no `resurrect` flag, no `already_tombstoned` / `resurrect_not_opted_in` errors.
- **Configurable path policy in three tiers (§3.5).** Hardcoded defaults → server config → per-repo override (replace-not-merge). `disallowed_chars`, `system_sigils`, `hidden_sigils` — lists for input, first entry canonical on emission. Server-level policy also gates slug validation for repos and users.
- **Structural path elements (`/`, `.`, `..`, empty segment) are non-configurable code constants (§3.5.1).**
- **Query defaults exclude hidden and system paths (§5.1).** `include_hidden` and `include_system` flags opt back in. Applies to `filter`, `text`, `rank`, and `PROPFIND`.
- **Server never merges.** Merge policy is a client concern. Kernel enforces `prev_version_id` == current; conflicts return `stale_prev` with the current version attached (§4).
- **Multi-token auth with capability scopes (§8).** Per-user tokens, argon2/bcrypt hashed, `admin: true` boolean for server-level power, per-repo `read` / `write` path globs (scalar-or-list, gitignore semantics). System-namespace endpoints on kernel-driven moves (delete/restore) are exempt from the "both endpoints match write" rule — scope is checked only on the user-territory endpoint.
- **`author_id` non-nullable.** Every version has an actor. A reserved `system` user can be introduced later if automated writes need attribution, but the schema doesn't allow author-less versions.
- **Rename folded into `docs.put`.** `prev_version_id` already identifies the source location; the `path` argument is the destination. Same path = update, different path = move (§4.2). A rename-only verb can be added later if the ergonomics warrant it.
- **Concurrent create on a freed path: `create_conflict`.** The second caller sees the first caller's live document at the path and must retry as `put` (or a distinct create at a different path). No special-case for deletion races.
- **FTS is required, backend is adapter-owned (§5.1, §7.2).** SQLite → FTS5, Postgres → tsvector. Result set portable, ranking is not.
- **Embedding via user-defined hook (§5.3).** Server does not embed. Operator wires in an HTTP endpoint, subprocess, or in-process plugin implementing the batch `embed(chunks)` contract.
- **Implementation language: TypeScript (Node).** Portability and ecosystem fit for a thin storage wrapper + CEL-to-SQL compiler (§7.1).
- **Git/GitHub bridging deferred to post-v1 (§11).** mrplex stands alone in v1; adapters and sync policy come later.

Remaining `[OPEN]` markers throughout the doc are narrower questions (query cacheability, `as_of` on GET, expression-index tuning, model-versioned chunks, etc.) that don't gate the v1 shape.

## 10. Milestones

- **M0 — Kernel + skeleton.** Schema, SQLite storage, kernel reads (`repos.list`, `users.list`, `docs.get`, `docs.history`), `mrplex` CLI reading directly from the kernel (§7.3). Slug/id split enforced.
- **M1 — Writes + auth.** Full kernel write surface (`docs.create` / `docs.put` / `docs.delete`, plus `repos.create` / `users.create` and the `.rename` methods) with `prev_version_id` enforcement. `docs.put` handles both in-place update and move. Bearer-token auth (§8): `api_tokens` table, capability scopes, `authorize()` on every kernel op, `tokens.*` RPCs, bootstrap root token. CLI gains write commands and `tokens.*`.
- **M2 — Query.** CEL filter + FTS; `kernel.query` end-to-end; CLI `query` command.
- **M3 — HTTP surfaces.** JSON-RPC at `POST /rpc` (+ STDIO transport for MCP); REST + WebDAV subset (`GET` / `PUT` / `DELETE` / `MOVE` / `PROPFIND`, `If-Match` / `If-None-Match`, content negotiation). CLI gains `--server` flag to target a remote instance over MCP.
- **M4 — Semantic.** Chunking + embeddings + vector search.
- **M5 — Postgres backend.**

## 11. Future work (post-v1)

- **Git bridging.** Attach a **source** (adapter + policy) to a repo: pull (`git → mrplex`), push (`mrplex → git` via `staged` / `autocommit` / `autopr`), or bidirectional. Loop avoidance via commit trailer. mrplex's fast-forward-only write model carries over — a git ingest that advances the head just marks in-flight mrplex writes stale, same mechanism.
- **Merge helpers.** A read-only `docs.merge_preview` and a client-side merge library that implements common patterns (refetch-and-retry, three-way block merge, callout fallback). A cached parsed block tree on `versions` would support this cheaply.
- **Grouped writes.** A `changesets` entity for atomic multi-document writes, if a use case emerges.
- **WebDAV extensions.** `LOCK` / `UNLOCK` (for editors that hold long-form locks), `PROPPATCH` (custom properties as first-class writes), collection-level `COPY`. v1 ships only the read/write/move subset needed for filesystem mounting.
