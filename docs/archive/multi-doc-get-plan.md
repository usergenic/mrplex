# Multi-doc get — batch hydrate after `query`

Status: **design**. A kernel read `docs.get_many` that fetches the current
version of many named paths in one call. The consumer is agentic MCP: `query`
returns lean projected hits (default `{ "$path": "…" }` only), then the agent
recovers full `Version`s for a handful of those paths. Today that is N
`docs_get` round-trips.

This is N targeted reads, not a search. `query` omits unmatched paths;
`docs_get` raises `doc_not_found`. Batch get keeps the targeted-read contract
**per path**, but does not let one miss poison the rest of the batch.

No schema changes. No new index.

## 1. Scope

**In:**

- **Kernel `docs.get_many(ctx, repo, paths, opts?)`** — current versions only,
  one repo, named paths. Same `$version` / `$content_hash` injection as
  `docs.get` (gated by `raw`). Partial success: found docs in `items`, per-path
  failures in a sibling `errors` array.
- **Storage `versions_current_by_paths`** — one batched current-version lookup
  on both adapters, keyed by `path_norm` like `version_current`
  (`src/storage-sqlite/adapter.ts`). Missing paths are simply absent; the kernel
  classifies them.
- **MCP tool `docs_get_many`** — mirrors the kernel one-to-one (`src/mcp/tools.ts`
  convention). Primary consumer. `isError: true` only when the call does not
  run; partial success is a success result.
- **CLI / client / REST** — thin surface wiring so the kernel op is reachable
  everywhere else the way every sibling is. MCP is why this exists; the other
  surfaces exist so the kernel does not grow an MCP-only fork.

**Out (deliberately):**

- **Overloading `docs_get` with `path: string | string[]`.** The success shape
  would flip between a `Version` and `{ items, errors }`. A separate method
  keeps both contracts honest.
- **`docs_get_version` batching.** Historical hydrate is a sync/feed concern
  (`history.since` already says fetch bodies via `docs_get_version` only when
  needed). Different caller, different key (`version_id`). Own change.
- **Cross-repo `{ repo, path }[]` input.** `query` already tells agents to
  include `$repo` when spanning repos; they group and call once per repo. A
  mixed-ref input is more flexible and more awkward for the common case.
- **Silent omit (query-style) and all-or-nothing (solo `docs_get`-style).**
  Both are the wrong agent contract; see §3.
- **Substituting `query` with `select: ["$body", …]`.** Hits are projections,
  not put-ready `Version`s (no `frontmatter_raw`, no injected `$version`). The
  existing line stands: list with `query`, recover documents with `docs_get` /
  `docs_get_many`.
- **Truncation.** Graph may cut a neighborhood and set `truncated`. A named
  fetch that silently drops paths the caller listed would look like success.
  Over the cap, the whole call fails.

## 2. The call

### 2.1 Input

```jsonc
{
  "repo": "notes",                         // required; one slug, like docs_get
  "paths": ["a.md", "b.md", "missing.md"], // required; non-empty
  "raw": false                             // optional; same meaning as docs_get
}
```

Pinned:

- **`repo`** — exactly one slug. Missing / out-of-claim repo is `repo_not_found`
  (request-level; `resolveRepo` already hides existence, `src/kernel/kernel.ts`).
- **`paths`** — array of strings. Duplicates are collapsed **first-seen**; they
  are not errors. Empty, missing, or non-array → request-level error, not an
  empty success (an empty get-many is a client bug).
- **`raw`** — applied uniformly to every returned `Version`. Surfaces that
  inject `$*` on `docs_get` inject here too.
- **Hard cap `GET_MANY_MAX_PATHS = 50`**, counted **after** dedupe. Matches
  `DEFAULT_QUERY_LIMIT` so a default `query` page hydrates in one call. Full
  `Version` bodies are large; this is a named-get budget, not graph's search
  budget (`DEFAULT_MAX_DOCUMENTS = 100`). Over cap → request-level
  `payload_too_large` with `{ limit, got, reason }` — already in the catalog,
  already HTTP 413. Do not clamp.

### 2.2 Output

```jsonc
{
  "items": [ /* Version, … */ ],
  "errors": [
    { "path": "missing.md", "code": "doc_not_found", "data": { "repo": "notes", "path": "missing.md" } }
  ]
}
```

```ts
export type DocGetManyResult = {
  items: Version[];
  errors: DocGetManyError[];
};

export type DocGetManyError = {
  path: string;
  code: KernelErrorCode;
  data: Record<string, unknown>;
};
```

Pinned:

- **`items` is only `Version`s.** Same wire type as `docs_get`
  (`src/kernel/wire.ts`). Do not mix versions and errors in one array, and do
  not hang error fields on `Version` — MCP `outputSchema` and every other
  surface treat it as a closed shape.
- **`errors` is always present**, even when empty. Required in `outputSchema`
  so clients do not have to remember an optional key. Each entry is `{ code,
  data }` as a solo `docs_get` would have thrown, plus `path` so the caller
  can join.
- **Order.** Walk the first-seen `paths` list once: successes append to
  `items`, failures to `errors`. Both arrays preserve request order of their
  members.
- **All-miss is still success** (`items: []`, `errors` populated). MCP
  `isError: true` means the tool did not run; it is not how per-path misses
  are reported (`src/mcp/server.ts` — error results carry no
  `structuredContent`).

House style for partial success is sibling lists, not mixed unions:
`links.repair` returns `{ repaired, skipped }`; `repos.set_path_config`
returns `{ repo, warnings }`.

### 2.3 Kernel walk

For a well-formed call:

1. `resolveRepo` — `repo_not_found` aborts the batch.
2. Validate `paths` (non-empty string array; after-dedupe length ≤ cap).
3. One `versions_current_by_paths` lookup. Storage matches on `path_norm`
   (`normalizeKey`, same as `version_current`).
4. For each first-seen path, classify — **do not throw**:
   - out of `ctx.scope` → `errors` entry `forbidden` (empty `data`, same as
     `assertReadable` / `docs.get`). Evaluated **before** existence, so
     out-of-claim paths never leak whether they exist.
   - in-claim, absent from the lookup → `errors` entry `doc_not_found`
     `{ repo, path }`.
   - in-claim, present → `items` as `toVersionWire`.

Unknown strings are not `path_invalid`. `docs.get` does not validate path
grammar on read; a string that names nothing is `doc_not_found`. Same here.

## 3. Error model

Two layers. Getting this wrong is the whole design.

### Request-level — fail the call (`KernelError`, MCP `isError`)

| Condition | Code |
|---|---|
| repo missing / out of claim | `repo_not_found` |
| `paths` empty, missing, or not `string[]` | `filter_invalid` `{ reason }` — existing "bad read spec" bucket (graph spec, REST body) |
| after-dedupe length > `GET_MANY_MAX_PATHS` | `payload_too_large` `{ limit, got, reason }` |

### Per-path — `errors[]`, call succeeds

| Condition | Code | `data` |
|---|---|---|
| in-claim, nothing at path | `doc_not_found` | `{ repo, path }` |
| out of `ctx.scope` | `forbidden` | `{}` |

Keep `forbidden` vs `doc_not_found` as they are on `docs.get`
(`src/kernel/context.ts`: silent filtering on `query`; `forbidden` on a
targeted read outside the claim). Collapsing them into "missing" would
change the targeted-read contract for those paths.

**Why not all-or-nothing.** Agents hydrate stale query hits, moved files, and
hallucinated paths in the same list. One miss aborting the batch throws away
bodies already in hand and trains the agent to retry one-by-one — the
opposite of why the method exists. `links.repair` already established
per-item skip (`src/kernel/kernel.ts`).

**Why not silent omit.** After `query`, a vanished path is information
(moved, deleted, never existed). Omitting it makes the agent treat the batch
as complete. `query` omits because it is a search; this is a named get.

## 4. Storage

```ts
/** Current-version rows for a batch of live paths in `repo_id`.
 *  Lookup is by `path_norm`. Paths with no live row are simply absent. */
versions_current_by_paths(
  repo_id: number,
  paths: readonly string[],
): Promise<VersionRow[]>;
```

Both adapters. `IN`-list on `path_norm`, chunked like the existing id-batch
helpers if the cap ever rises past parameter limits (50 is well under). Empty
`paths` is the kernel's problem (it never calls this with empty). No
migration — `path_norm` and `next_id IS NULL` already exist.

Parity via the shared kernel suite, same as `versions_current_by_documents`.

## 5. Surfaces

- **MCP `docs_get_many`** — `inputSchema` per §2.1, `outputSchema` per §2.2
  (`items` + `errors` both required; `items` reuse `VERSION_SCHEMA`). Handler
  injects `$*` unless `raw: true`, same as `docs_get`. Text half:
  `renderVersionList(items)` plus a trailing `errors:` block (path + code)
  when `errors.length > 0`. Agents that only read `text` must still see
  misses. Tool description: the recover-after-`query` line currently pointing
  only at `docs_get` (`src/mcp/tools.ts`, `query_syntax.ts`,
  `SERVER_INSTRUCTIONS`) grows `docs_get_many`.
- **Guard** — `forward("docs.get_many", { repo, paths }, …)` like `docs.get`.
  Per-path `forbidden` is classified inside the kernel; the guard does not
  fail the batch on one out-of-entitlement path.
- **`KernelClient`** — `docs.get_many(repo, paths, opts?: DocGetOptions):
  Promise<DocGetManyResult>`. Local forwards; remote-mcp calls the tool and
  does **not** unwrap — this is not a `wrapList` result.
- **CLI `mrplex docs get-many <path…>`** — repeated positional paths, same
  `--raw` as `docs get`. Human render is the MCP text half; `--json` emits
  the structured result (errors included). Non-zero exit only on
  request-level errors, not on a partial `errors` list (the data came back).
- **REST `POST /repos/{repo}/docs:get`** — JSON body `{ paths, raw? }`. GET
  with a query-string of paths is a URL-length trap; don't. Same
  `X-Mrplex-Scope` / system-props query as single GET. 200 with the
  structured body on partial success; request-level errors keep their
  existing status map (`src/server/http-error.ts`).

## 6. Design decisions pinned

1. **Separate method, not an overload of `docs_get`.** Success shapes stay
   single-valued vs. `{ items, errors }`.
2. **Partial success with a sibling `errors` array.** One miss does not
   invalidate the batch; a miss is never silent.
3. **`items` is `Version[]` only.** No mixed union, no error fields on
   `Version`.
4. **`errors` always present.** Empty array, not omitted.
5. **MCP `isError` is request-level only.** Partial success is a success
   result; the text channel names misses.
6. **`forbidden` vs `doc_not_found` preserved per path**, existence checked
   only after scope.
7. **Single repo, `paths: string[]`.** Cross-repo grouping is the caller's
   job.
8. **Dedupe first-seen; cap after dedupe; over-cap is loud.** No `truncated`.
9. **Cap is 50.** Same number as default `query` `limit`; raise later if
   practice wants it — the code is one constant.
10. **`query` + `select: ["$body"]` is not this.** Projections vs. put-ready
    `Version`s stay distinct.
11. **No `docs_get_version` batch in this change.**

## 7. Workstreams

### WS0 — This plan
`docs/multi-doc-get-plan.md`. Done.

### WS1 — Storage `versions_current_by_paths` (S)
Both adapters, `path_norm` `IN`-list, live rows only. Kernel-suite parity
with `version_current` (case fold, missing → absent, empty input → `[]`).

### WS2 — Kernel `docs.get_many` (S–M)
Walk in §2.3. Wire types in `wire.ts`. Tests are the spec: mixed hit/miss,
all-miss is success, duplicate collapsed, over-cap / empty `paths` /
`repo_not_found` throw, in-claim miss is `doc_not_found`, out-of-scope is
`forbidden` whether or not the path exists, `raw` suppresses injection the
same way as `docs.get`.

### WS3 — MCP + render + copy (S)
`docs_get_many` in `TOOL_REGISTRY`; text render with errors block; query /
`docs_get` / `query_syntax` / `SERVER_INSTRUCTIONS` point at it as the
batch recover path.

### WS4 — Guard, client, CLI, REST (S)
`KernelClient` + local + remote-mcp; shell `forward`; `mrplex docs get-many`;
`POST /repos/{repo}/docs:get`. HTTP MCP round-trip in `test/http-mcp.test.ts`.

## 8. Sequencing

WS1 → WS2 → {WS3, WS4 in parallel}. WS2 is the semantics; everything after
is wiring.

## 9. Open questions (none block WS1)

- **REST path.** `POST /repos/{repo}/docs:get` is a placeholder; pick
  whatever matches existing collection-action style in `src/rest/routes.ts`
  when WS4 lands. Do not add a GET variant in the same change.
- **Cap 50.** Easy to raise. Do not lower in response to payload size —
  agents would rather get `payload_too_large` than a surprise slice.
- **CLI exit code on partial `errors`.** Pinned non-zero only for
  request-level; revisit if humans using `get-many` as a script primitive
  want "any miss is failure" (that can be a flag later).

## 10. Definition of done

```
# Happy path: query then hydrate
mrplex query --repo notes --filter 'status == "draft"'   # $path hits
mrplex docs get-many a.md b.md c.md --repo notes
# → items are full Versions (injected $version / $content_hash);
#   a missing path is in errors[], not a failed command

# Scope: out-of-claim path is forbidden in errors, in-claim hole is
# doc_not_found; the other items still return

# Cap: 51 unique paths → payload_too_large, nothing returned
# Empty paths → filter_invalid
# Unknown repo → repo_not_found

# MCP: docs_get_many validates against its outputSchema; isError is false
# when errors[] is non-empty; text names the misses
# SQLite and Postgres agree
```
