# Query `select` Projection Plan — lean hits, `$`-prefixed system fields

Status: **implemented**. Extracted from the archived sync plan
(`docs/archive/sync-plan.md` §2.6–2.7), where it was conceived as sync's
enumeration primitive. Sync now rides `history.index`
(`docs/sync-and-history-plan.md` §3.4), so this plan stands on its own merits: a
lean projected result shape for `query`, and the resolution of the long-standing
open question about `query` returning full bodies.

## 1. Motivation

Today `query` always returns full `Version` rows (`runQuery` → `Version[]`,
`src/kernel/query/query.ts:65`; the MCP tool wraps them with `wrapList` +
`renderVersionList`, `src/mcp/tools.ts:906-912`). Any caller that wants to *list*
or *filter* documents pays for every body shipped. `select` fixes that: name the
fields you want, get back lean objects — and `$body` becomes just another opt-in
member, so document content travels only when asked for.

```
query(repo: "notes", filter: "status == \"draft\"", select: ["$path", "title", "$updated_at"])
  → [ { "$path": "guides/intro.md", "title": "Intro", "$updated_at": "…" }, … ]
```

## 2. Kernel

- `QuerySpec` (`src/kernel/query/query.ts:22`, and its `KNOWN_SPEC_FIELDS` set)
  gains `select?: string[]`, **defaulting to `["$path"]`** — the identity you
  almost always want and the cheapest thing to return. Everything else
  (`$content_hash`, `$version_id`, `$body`, frontmatter keys) is opt-in by naming
  it.
- `runQuery` returns a **projected `QueryHit`** per hit (§4), not a full `Version`.

## 3. Vocabulary and the intrinsic registry

`select` entries name bare frontmatter keys (`title`, `status`) or `$`-intrinsics
(`$path`, `$version_id`, `$content_hash`, `$repo`, `$updated_at`, `$body`, …) —
the same vocabulary `graph`'s `select` + `$`-intrinsics already use
(`GraphSpec.select`, `src/kernel/wire.ts:58`), so the two read surfaces stay
consistent.

Intrinsic names come from **a single registry**: the filter compilers'
`INTRINSIC_COLUMNS` (`src/storage-sqlite/compile-filter.ts:88`,
`src/storage-postgres/compile-postgres.ts:227`) plus the version-identity fields
that are projectable but not filterable (`$version_id`, `$prev_version_id`,
`$next_version_id`, `$repo`, `$author`, `$body`). `select` validates against the
registry and rejects unknown `$names` with `filter_invalid`-style errors, reusing
the "expected …" message the compiler already derives from the registry
(`compile-filter.ts:106`).

| `select` name        | source                                  |
|----------------------|-----------------------------------------|
| `$path`              | `versions.path`                         |
| `$repo`              | repo slug                               |
| `$version_id`        | `encodeVersionId(versions.id)`          |
| `$prev_version_id`   | `encodeVersionId(versions.prev_id)`     |
| `$next_version_id`   | `encodeVersionId(versions.next_id)`     |
| `$content_hash`      | `versions.content_hash` *               |
| `$updated_at`        | `versions.created_at`                   |
| `$author`            | `versions.author`                       |
| `$body`              | `versions.body`                         |
| *(bare key)*         | `versions.frontmatter -> key`           |

\* `$content_hash` joins the registry when the sync-and-history plan's milestone 1
lands (the column + shared hash function). The two plans are otherwise
independent; this one can ship before or after.

## 4. The `QueryHit` shape: `$`-prefixed system fields

The projected object reifies the filter language's data model, exactly as
`GraphDocument` already does (`src/kernel/wire.ts:70`: `$path`/`$degrees`/
`$links`/`$backlinks` as `$`-keys, bare `select`ed frontmatter keys alongside).
The general principle: **any field that isn't user-authored frontmatter carries
the `$` sigil**, so a document whose frontmatter literally contains a key named
`repo` or `path` still round-trips without colliding with the system's
`$repo`/`$path`.

```ts
/** A projected query hit. */
export type QueryHit = {
  [intrinsic: `$${string}`]: unknown;  // $path, $version_id, $repo, …
  [frontmatterKey: string]: unknown;   // bare select-ed frontmatter keys
};
```

**Scope of the prefixing principle.** `query` now always returns `QueryHit`
objects — full `Version` rows are no longer a `query` return shape at all. The
*full* `Version` wire type (`wire.ts:17`) lives on unchanged as the return of
`docs.get` / `docs.get_version` / `docs.history`, keeping its flat, unprefixed
field names; renaming those is a breaking change across every existing surface,
out of scope here. The `$`-prefix principle applies to the projected shape, which
is where system and user names actually share one namespace. `GraphDocument` set
the precedent; `QueryHit` follows it.

## 5. Defaults and sharp edges

The `$path`-only default is a lean-by-default choice, not a footgun-free one. One
edge accepted deliberately: an *unscoped* or multi-repo query returns `$path`-only
hits with no `$repo`, so paths from different repos are indistinguishable — the
caller must add `$repo` to `select` when querying more than one repo. We leave the
sharp edge in rather than special-casing the default.

## 6. Surfaces

- **MCP** — a `select` property on the `query` tool's `inputSchema`
  (`src/mcp/tools.ts:857`) and a projected-object branch in its `outputSchema`
  (currently `listResultSchema(VERSION_SCHEMA, …)`, `tools.ts:906`).
- **CLI** — `mrplex query` gains `-s, --select <field>` (repeatable, same
  accumulator pattern as `--repo`, `src/cli/main.ts:1189-1193`), passed through as
  `select` on the `client.query` spec (`main.ts:1216`). `renderQueryTable` renders
  projected columns.
- **REST** — `/query` accepts `select` (repeated query param on GET, array in the
  POST body; `dispatchQuery`, `src/rest/routes.ts:279`).

## 7. Compatibility

Changing `query`'s default return from full `Version[]` to `$path`-only
`QueryHit[]` is a **breaking change** for existing `query` consumers (MCP tool,
REST, CLI `--json`). Accepted because it is the correct default for a lean read
primitive: any caller can recover the old payload with an explicit
`select: ["$path", "$repo", "$version_id", "$prev_version_id",
"$next_version_id", "$author", "$updated_at", ...frontmatter]` — and a caller that
truly wants whole documents should be using `docs.get`. With the sync dependency
gone there is no deadline pressure; land it whenever convenient, and call out the
behavior change in the changelog.

## 8. Tests

- Projected keys carry `$`; a frontmatter key named `path`/`repo` coexists with
  `$path`/`$repo` in one hit.
- Unknown `$name` in `select` errors with the registry-derived message.
- `$body` is returned only when selected.
- Default `select` returns exactly `{ "$path": … }` per hit.
- CLI `-s` accumulates; REST GET repeated param and POST array agree.

## 9. Open decision (carried forward)

Should the flat `Version` wire type eventually adopt `$`-prefixed system fields
too? Renaming `version_id` → `$version_id` etc. would align the whole surface
with the principle but breaks `docs.get`, `docs.history`, REST, and every client.
Deferred; revisit as its own migration if the half-and-half state proves
confusing.
