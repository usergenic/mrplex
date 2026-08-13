# mrplex — Design Document

**mrplex** — *Markdown Repos, plexed.* A hub for versioned markdown.

Status: **Working draft.** `[OPEN]` = unresolved. `[ASSUMPTION]` = default to challenge.

## 1. Goal

`mrplex` is a queryable, versioned store for Markdown documents with YAML frontmatter. Clients talk to it over two HTTP surfaces sharing one core:

- **MCP** — JSON-RPC 2.0 at `POST /rpc`, plus a STDIO transport. Primary interface for LLM agents.
- **REST + WebDAV** — resource-oriented routes (`GET /repos/{repo}/docs/{path}`, `PUT`, `DELETE`, `MOVE`, `PROPFIND`). Primary interface for humans, `curl`, editors that mount over WebDAV (including Obsidian without a plugin), and anything HTTP-ecosystem-shaped (caches, CDNs, `If-Match`).

Also included: a first-party `mrplex` **CLI** (§7.2) — a thin client over the MCP surface with ergonomic command flags in place of JSON envelopes.

Every update is an insert; nothing is overwritten; any past state is addressable.

External-source bridging (git repos, GitHub) is deliberately post-v1 — see §11.

## 2. Non-goals (v1)

- Not a Markdown renderer.
- Not a wiki UI.
- Not a general document store — only Markdown-with-YAML-frontmatter.
- Not a git mirror — no adapters, no sync. mrplex stands alone.

## 3. Data model

### 3.1 Concepts

- **Repo** — a container. Namespaces document paths and scopes queries. Nothing more.
- **Document** — an identity for a Markdown file. Persists across renames and delete/resurrect cycles.
- **Version** — an immutable snapshot of a document: path, frontmatter, body, author, timestamp, and links to the previous and next versions (`next_id` null = current). Every write inserts one.
- **Tombstone** — a version marking deletion. *Superseded, but by nothing.* Same schema as any other version; `tombstone = true`, empty content.

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
  path        text    not null,                          -- path AT this version
  frontmatter json    not null,                          -- parsed YAML
  body        text    not null,
  tombstone   boolean not null default false,
  author_id   integer not null references users(id),
  created_at  timestamp not null
)

-- exactly one current version per document
create unique index on versions (document_id) where next_id is null;

-- at most one live document per path in a repo (tombstoned docs release the path)
create unique index on versions (repo_id, path) where next_id is null and not tombstone;

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

### 3.4 Point-in-time & history

State at time T: for each document, the latest non-tombstone version with `created_at ≤ T`. No derived "tree" table — the partial index on `(document_id) where next_id is null` makes current-version lookup a single index hit.

Renames stay on the same `document_id` with a new `path`. Deletions insert a tombstone version. A write onto a tombstone (with the tombstone as its `prev`) resurrects — same document, continuous history.

`[OPEN]` To start a fresh identity at a previously-deleted path, call `docs.create` explicitly instead of writing onto the tombstone.

## 4. Writes: optimistic concurrency

**Every write must supply the `prev` version it observed. If that `prev` is not the current version, the write is rejected. The server never merges.**

That's the whole model. Merge policy is a client concern — an Obsidian plugin, a CLI, an agent, and a bulk importer all want different strategies, and any of them can implement their own on top of this primitive.

### 4.1 Rules

1. `docs.put`, `docs.delete`, `docs.rename` all take `prev_version_id`. It must equal the current version. Otherwise: `stale_prev` error carrying the current version.
2. `docs.create` takes no `prev`. If a live document already exists at the path: `create_conflict` error carrying the current version (the caller can retry as `put`).
3. Writes are single-writer per repo — races resolve deterministically.

### 4.2 Path vs. prev semantics

`docs.put` is in-place update; the `path` argument is a redundant sanity check on `prev_version_id`. If the path doesn't match the path of the version identified by `prev_version_id`, the write is a **`path_mismatch`** error — either a client bug, or the caller meant to move and used the wrong verb. Moving is `docs.rename`. This separation lets the server distinguish "the state moved" (`stale_prev`) from "the caller declared the wrong intent" (`path_mismatch`) without guessing.

### 4.3 Error catalog

Auth/access-control errors are omitted here — see §8.

**Concurrency** — state moved under you.

- `stale_prev` — provided `prev_version_id` is no longer the current version of its document.
  Emitted by: `docs.put`, `docs.delete`, `docs.rename`.
  Data: `{ current_version_id, current_is_tombstone, submitted_prev_version_id }`.

**Slot conflicts** — the target slot is already occupied.

- `create_conflict` — `docs.create` at a path that already holds a live document.
  Data: `{ repo, path, current_version_id }`.
- `path_taken` — `docs.rename` destination already holds a live document. Also emitted if resurrecting via `docs.put` onto a path a fresh `docs.create` has since claimed.
  Emitted by: `docs.rename`, `docs.put`.
  Data: `{ repo, path, current_version_id }`.
- `slug_taken` — repo or user slug already in use.
  Emitted by: `repos.create`, `repos.rename`, `users.create`, `users.rename`.
  Data: `{ slug }`.

**Reference errors** — identifiers resolve but don't fit the call.

- `path_mismatch` — `path` argument doesn't match the path of the version at `prev_version_id`. Use `docs.rename` to move.
  Emitted by: `docs.put`, `docs.delete`, `docs.rename`.
  Data: `{ submitted_path, prev_version_path }`.
- `version_not_in_document` — a `version_id` (in `diff`) doesn't belong to the document at `(repo, path)`.
  Emitted by: `docs.diff`.

**State assertions** — the target is in a state that makes the operation nonsensical.

- `already_tombstoned` — `docs.delete` or `docs.rename` when the current version is already a tombstone.
- `path_unchanged` — `docs.rename` where `from_path == to_path`.

**Not found.**

- `repo_not_found` — no repo with that slug.
- `user_not_found` — no user with that slug.
- `doc_not_found` — no live document at `(repo, path)`.
  Emitted by: `docs.get`, `docs.diff`, `docs.rename` (for `from_path`).
- `version_not_found` — `version_id` (or `prev_version_id`) doesn't exist.

Note: `docs.put` never emits `doc_not_found` — the document is identified by `prev_version_id`, and a missing prev fails earlier as `version_not_found`.

**Validation** — input malformed.

- `slug_invalid` — illegal characters, too long, reserved word.
- `path_invalid` — malformed document path (leading `/`, `..`, empty component, etc.).
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
  "repo":   "notes",
  "filter": "status == 'draft' && 'pricing' in list(tags)",
  "text":   "pricing OR fees",
  "rank":   "tiered SaaS pricing",
  "as_of":  "2026-06-01",
  "limit":  20
}
```

CEL scope: `frontmatter` fields are top-level (`status`, `tags`); `path` and `created_at` also in scope. No `doc.` prefix.

`[OPEN]` FTS backend: SQLite FTS5 vs. Postgres tsvector — dialect leak or shared abstraction.
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

## 6. Interfaces

Two HTTP surfaces (`/rpc` for JSON-RPC, resource routes for REST/WebDAV), both thin translation layers over one shared **kernel**. Each surface lives in its own module; adding a third surface later (gRPC, GraphQL) is another translation layer, not a rewrite.

### 6.1 Kernel

The kernel is the only place the write model, concurrency rules, and error catalog exist. Surfaces validate their envelope, resolve slugs to internal ids, delegate, and translate the result.

```types
kernel.repos.list()                                       → Repo[]
kernel.repos.create(slug)                                 → Repo
kernel.repos.rename(slug, new_slug)                       → Repo

kernel.users.list()                                       → User[]
kernel.users.create(slug)                                 → User
kernel.users.rename(slug, new_slug)                       → User

kernel.docs.get(repo, path, as_of?)                       → Version
kernel.docs.history(repo, path, limit?, before?)          → Version[]
kernel.docs.diff(repo, path, from, to)                    → UnifiedDiff

kernel.docs.create(repo, path, frontmatter?, body?, actor)              → Version
kernel.docs.put(repo, path, prev_version_id, frontmatter?, body?, actor) → Version
kernel.docs.delete(repo, path, prev_version_id, actor)                  → Version
kernel.docs.rename(repo, from_path, to_path, prev_version_id, actor)    → Version

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

mrplex.users.list()                                             → User[]
mrplex.users.create(user)                                       → User
mrplex.users.rename(user, new_user)                             → User

mrplex.docs.get(repo, path, as_of?)                             → Version
mrplex.docs.history(repo, path, limit?, before?)                → Version[]
mrplex.docs.diff(repo, path, from, to)                          → UnifiedDiff

mrplex.docs.create(repo, path, frontmatter?, body?)             → Version
mrplex.docs.put(repo, path, prev_version_id, frontmatter?, body?) → Version
mrplex.docs.delete(repo, path, prev_version_id)                 → Version
mrplex.docs.rename(repo, from_path, to_path, prev_version_id)   → Version

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
                                   If-Match: <version_id> → update (fails on mismatch → 412 stale_prev)
DELETE  /repos/{repo}/docs/{path}  If-Match: <version_id> → Version (tombstone)
MOVE    /repos/{repo}/docs/{path}  Destination: /repos/{repo}/docs/{new_path}
                                   If-Match: <version_id>

GET     /query?repo=&filter=&text=&rank=&as_of=&limit=      → Version[]
POST    /query                     { QuerySpec }             → Version[]

GET     /me/tokens                                           → Token[]
POST    /me/tokens                 { label, scopes, expires_at? } → { token, meta }
DELETE  /me/tokens/{id}                                      → Token
```

`GET /query` and `POST /query` accept the same parameters — GET as query-string, POST as JSON body. GET is preferred for cacheability and shareability; POST is the fallback for queries whose URL-encoded form would exceed reasonable URL length (~8KB). Every `QuerySpec` field maps to a query parameter of the same name.

`[OPEN]` **Query response cacheability.** GET `/query` responses should carry `ETag` (a hash of the sorted `version_id` list in the result) and `Cache-Control`, so CDNs and browser caches can revalidate with `If-None-Match` → 304. Cheap to compute; invalidates exactly when the result set would change.

`[OPEN]` **Repeatable query semantics.** With `as_of` absent, `GET /query` returns "now" — same URL, different results over time, poor caching behavior. Two options: (a) require `as_of` on GET, or (b) auto-pin `as_of` to the request time and echo the resolved value in a response header (`X-As-Of: <timestamp>`) so clients can re-request the same snapshot deterministically. Leaning (b) — better ergonomics, preserves caching, no extra work for the common case.


`If-Match` collapses the explicit `prev_version_id` parameter of `docs.put` / `docs.delete` / `docs.rename` into the standard HTTP conditional-request mechanism — same semantics, native to the protocol. `PUT` with `If-None-Match: *` is the RFC-standard "create only if absent" pattern, so we don't need a separate `docs.create` route.

**Error mapping** (kernel error → HTTP). All error responses carry the kernel error `code` and `data` in the JSON body; the HTTP status just picks the closest match.

- `unauthorized` → **401 Unauthorized**.
- `forbidden` → **403 Forbidden**.
- `stale_prev`, `create_conflict` → **412 Precondition Failed**, with the current `version_id` in the `ETag` response header.
- `path_taken`, `slug_taken`, `already_tombstoned`, `path_unchanged` → **409 Conflict**.
- `repo_not_found`, `user_not_found`, `doc_not_found`, `version_not_found` → **404 Not Found**.
- `path_mismatch`, `version_not_in_document` → **422 Unprocessable Entity**.
- `slug_invalid`, `path_invalid`, `frontmatter_invalid`, `filter_invalid`, `as_of_invalid` → **400 Bad Request**.

WebDAV `PROPFIND` (for filesystem-mount clients) returns a directory listing of live paths under the given path prefix. Advanced WebDAV features (`LOCK`, `PROPPATCH`) are deferred — see §11.

### 6.4 Wire types

Shared across both surfaces.

```types
User    = { user: string }
Repo    = { repo: string }
Version = {
  version_id, prev_version_id, next_version_id,  -- opaque; next_version_id = null means current
  repo, path,                                    -- slug + string
  frontmatter, body,
  tombstone, author,                             -- author: User
  created_at
}
Scope   = { repo: string, actions: ("read" | "write" | "admin")[] }
Token   = {
  id: string,                                    -- opaque
  label: string,
  scopes: Scope[],
  expires_at, created_at, last_used_at
  -- plaintext secret only present on the response to tokens.create
}
```

## 7. Deployment & clients

### 7.1 Deployment shapes

- **Local CLI** — single binary, SQLite file, no daemon.
- **Self-hosted server** — binary + Postgres + pgvector, HTTP(S) surfaces.

`[ASSUMPTION]` Same schema, dialect layer. `[OPEN]` Language: leaning Go.

### 7.2 `mrplex` CLI

The CLI is a thin client over the MCP surface (§6.2) — no capabilities of its own, no direct database access when talking to a remote server. It shells out to `POST /rpc` (or the in-process kernel, if running against a local SQLite file) and pretty-prints results.

Commands mirror MCP method names in a `noun verb` shape:

```rpc
mrplex repos list
mrplex repos create <slug>
mrplex repos rename <slug> <new-slug>

mrplex users list
mrplex users create <slug>
mrplex users rename <slug> <new-slug>

mrplex docs get <repo> <path> [--as-of <ts>]
mrplex docs history <repo> <path> [--limit N] [--before <ts>]
mrplex docs diff <repo> <path> --from <v> --to <v>

mrplex docs create <repo> <path> [--from-file FILE | -]           # body from file or stdin
mrplex docs put <repo> <path> --prev <version-id> [--from-file FILE | -]
mrplex docs delete <repo> <path> --prev <version-id>
mrplex docs rename <repo> <from-path> <to-path> --prev <version-id>

mrplex query --repo <slug> [--filter EXPR] [--text Q] [--rank Q] [--as-of TS] [--limit N]

mrplex tokens list
mrplex tokens create --label LABEL --scope repo=<slug>:read,write [--expires TS]
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

A token's `scopes` is a list of grants. Each grant names a repo (slug or `*`) and a set of actions.

```types
Scope = { repo: string, actions: ("read" | "write" | "admin")[] }
```

- **`read`** — `docs.get`, `docs.history`, `docs.diff`, `query`, `repos.describe`, `users.describe`, and the corresponding REST/WebDAV GET routes.
- **`write`** — everything `read` covers, plus `docs.create`, `docs.put`, `docs.delete`, `docs.rename`.
- **`admin`** — everything `write` covers, plus `repos.create`, `repos.rename`, and token management on the repo.

`repo: "*"` grants across every repo; combined with `admin` this is the "root" grant used to bootstrap the system.

A grant like `{ repo: "notes", actions: ["read", "write"] }` reads as "on the `notes` repo, allow read and write." Multiple grants stack — a token can be broadly `read` and narrowly `write` on a specific repo.

`users.*` and token-management routes require an `admin` grant on `*` (server-wide), except that users can always manage their own tokens.

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

## 9. Open questions

1. `author_id` non-null with a reserved `system` user, or nullable?
2. Rename: `docs.rename(from, to, prev)` primitive, or fold into `docs.put` when `path` changes?
3. Create against a tombstoned path: opt-in fresh identity via `docs.create`, resurrect otherwise (§3.4). Confirm shape.
4. Concurrent creates on a tombstone: second fails with `create_conflict`? Leaning yes.
5. FTS backend (§5.1).
6. Embedding model default + pluggability.
7. Implementation language.

**Resolved:** delete = tombstone version; server never merges; commits/git bridging deferred to §11; multi-token auth with capability scopes (§8).

## 10. Milestones

- **M0 — Kernel + skeleton.** Schema, SQLite storage, kernel reads (`repos.list`, `users.list`, `docs.get`, `docs.history`), `mrplex` CLI reading directly from the kernel (§7.2). Slug/id split enforced.
- **M1 — Writes + auth.** Full kernel write surface (`docs.create` / `docs.put` / `docs.delete` / `docs.rename`, plus `repos.create` / `users.create` and the `.rename` methods) with `prev_version_id` enforcement. Bearer-token auth (§8): `api_tokens` table, capability scopes, `authorize()` on every kernel op, `tokens.*` RPCs, bootstrap root token. CLI gains write commands and `tokens.*`.
- **M2 — Query.** CEL filter + FTS; `kernel.query` end-to-end; CLI `query` command.
- **M3 — HTTP surfaces.** JSON-RPC at `POST /rpc` (+ STDIO transport for MCP); REST + WebDAV subset (`GET` / `PUT` / `DELETE` / `MOVE` / `PROPFIND`, `If-Match` / `If-None-Match`, content negotiation). CLI gains `--server` flag to target a remote instance over MCP.
- **M4 — Semantic.** Chunking + embeddings + vector search.
- **M5 — Postgres backend.**

## 11. Future work (post-v1)

- **Git bridging.** Attach a **source** (adapter + policy) to a repo: pull (`git → mrplex`), push (`mrplex → git` via `staged` / `autocommit` / `autopr`), or bidirectional. Loop avoidance via commit trailer. mrplex's fast-forward-only write model carries over — a git ingest that advances the head just marks in-flight mrplex writes stale, same mechanism.
- **Merge helpers.** A read-only `docs.merge_preview` and a client-side merge library that implements common patterns (refetch-and-retry, three-way block merge, callout fallback). A cached parsed block tree on `versions` would support this cheaply.
- **Grouped writes.** A `changesets` entity for atomic multi-document writes, if a use case emerges.
- **WebDAV extensions.** `LOCK` / `UNLOCK` (for editors that hold long-form locks), `PROPPATCH` (custom properties as first-class writes), collection-level `COPY`. v1 ships only the read/write/move subset needed for filesystem mounting.
