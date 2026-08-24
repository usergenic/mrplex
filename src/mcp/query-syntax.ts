/**
 * Query-language reference — the single user-facing source of truth for the
 * `query` tool's filter language. Served whole by the `query_syntax` MCP
 * tool, summarized in the `query` tool's description (tools.ts), and pointed
 * at by `filter_invalid` error hints.
 *
 * The implementation truth lives in the compilers (storage-sqlite/
 * compile-filter.ts, storage-postgres/compile-postgres.ts) and the graph
 * recognizers (kernel/query/graph-ast.ts). query-syntax.test.ts compiles
 * every documented construct against the real parser+compiler so this doc
 * can't silently drift from the code: add an intrinsic or graph predicate
 * to the compilers and the test forces an update here.
 */

/** Kernel intrinsics, without the `$` sigil. Mirrors INTRINSIC_COLUMNS. */
export const DOCUMENTED_INTRINSICS = ["path", "updated_at", "body"] as const;

/** Graph membership predicates, without the `$` sigil. */
export const DOCUMENTED_GRAPH_MEMBERSHIP = ["in", "has", "in_static", "has_static"] as const;

/** Graph collections, without the `$` sigil (call with `()`). */
export const DOCUMENTED_GRAPH_COLLECTIONS = [
  "backlinks",
  "links",
  "backlinks_static",
  "links_static",
] as const;

export const QUERY_SYNTAX_DOC = `# mrplex query language

A query composes up to three modes; when more than one is present they
intersect (AND):

- \`filter\` — a CEL boolean expression over frontmatter fields and
  \`$\`-prefixed intrinsics
- \`text\` — full-text search over document bodies
- \`rank\` — semantic similarity over embeddings

Results are **current document versions only** (history is not searched).
Ordering: rank score when \`rank\` is present, else text relevance when
\`text\` is present, else \`$updated_at\` descending. Default \`limit\` is 50.

\`repo\` selects which repos to search: a slug (\`"notes"\`), a
gitignore-style glob (\`"team-*"\`), or a list of either. Omitted = every
repo the caller can see.

## Result shape — \`select\`

\`query\` returns **lean projected hits**, not full documents. \`select\` names
the fields you want; each hit is an object of just those fields. Names are
either bare frontmatter keys (\`title\`, \`status\`) or \`$\`-intrinsics
(\`$path\`, \`$repo\`, \`$version_id\`, \`$prev_version_id\`, \`$next_version_id\`,
\`$updated_at\`, \`$author\`, \`$body\`). Any field that isn't user frontmatter
carries the \`$\` sigil, so a frontmatter key literally named \`path\` never
collides with the system's \`$path\`.

\`select\` defaults to \`["$path"]\` — the cheapest useful projection. Document
bodies travel only when you ask for \`$body\`, so listing/filtering is cheap by
default. When querying more than one repo, add \`$repo\` to tell the paths apart.
To recover whole documents, use \`docs.get\`.

## CEL filter basics

Bare identifiers name frontmatter keys: \`status == "published"\`. Nested
maps use dots: \`meta.owner == "alice"\`. A missing key never matches (the
predicate is false, not an error).

Operators: \`==\` \`!=\` \`<\` \`<=\` \`>\` \`>=\` \`&&\` \`||\` \`!\`, with
parentheses. String values are single- or double-quoted.

String functions (free-standing or method form):

- \`contains(x, "sub")\` / \`x.contains("sub")\` — substring match
- \`x.startsWith("prefix")\`, \`x.endsWith("suffix")\`
- \`x.matches("^regex$")\` — regular-expression match
- \`size(x)\` — string length (also list length; see \`list()\`)

Not supported: list/struct literals, arithmetic, ternary, \`in\` without
\`list()\`.

## $-intrinsics (document properties)

Frontmatter keys are user territory; kernel-owned document properties are
\`$\`-prefixed, so they can never collide with a frontmatter field (a doc
with a frontmatter key literally named \`path\` stays queryable as bare
\`path\`):

- \`$path\` — the document's current path. \`$path.startsWith("guides/")\`,
  \`$path.matches("^guides/[^/]+\\\\.md$")\`, \`$path.endsWith(".md")\`
- \`$updated_at\` — when the document was last written, an ISO-8601 UTC
  string; compare lexicographically: \`$updated_at >= "2026-08-01"\`
- \`$body\` — the markdown body text: \`contains($body, "pricing")\`

Intrinsics have no subfields. There is no separate path-glob query
argument; express path matching in the filter via \`$path\`.

## list() — scalar-or-list frontmatter

Frontmatter fields like \`tags\` may hold a scalar or a list
(\`tags: pricing\` vs \`tags: [pricing, saas]\`). Wrap the field in
\`list()\` to treat both shapes uniformly; missing and null coerce to
\`[]\`:

- \`"pricing" in list(tags)\` — membership, either shape
- \`size(list(tags)) > 2\` — count (a scalar counts as 1, missing as 0)
- \`list(tags).all(t, t.startsWith("p"))\`
- \`list(authors).exists(a, a == "alice")\`

\`list()\` only makes sense inside \`in\`, \`size(...)\`, \`.all\`, or
\`.exists\`; a bare \`list(tags) == "x"\` is rejected.

## Link-graph predicates

The link graph indexes markdown links (inline, reference,
\`[[wikilinks]]\`, and configured frontmatter fields). All graph
predicates respect the caller's read scope — the visible graph equals the
readable graph. Globs are gitignore-style: a bare name matches at any
depth, \`*\` matches within a path segment, \`**\` crosses segments, a
leading \`/\` anchors to the repo root.

Boolean membership:

- \`$in(glob [, field])\` — true when some doc matching \`glob\` links TO
  this doc (this doc is a member of that doc's set). The optional
  \`field\` restricts to links written in that frontmatter field, or
  \`"$body"\` for body links. \`$in("moc/employees.md")\` finds everything
  the employees map-of-content references.
- \`$has(glob [, field])\` — true when this doc links to a target matching
  \`glob\`. Dangling targets (paths that aren't currently live docs) still
  count. \`$has("projects/**", "parent")\` — docs whose \`parent\` field
  references any project.

Collections — only usable with \`.size()\`, \`.exists()\`, \`.all()\`:

- \`$backlinks()\` — the docs linking to this doc
- \`$links()\` — the docs this doc links to
- \`$links().size() == 0\` — leaf docs
- \`.exists(d, pred)\` / \`.all(d, pred)\` — \`d.field\` reads the other
  doc's frontmatter; \`d.$path\` / \`d.$updated_at\` / \`d.$body\` read its
  intrinsics: \`$backlinks().exists(d, d.status == "draft")\`

Set algebra composes: \`$in("moc/**") && !$in("moc/contractors.md")\`;
orphans (linked from nowhere) are \`!$in("**")\`.

The \`_static\` variants (\`$in_static\`, \`$has_static\`,
\`$backlinks_static()\`, \`$links_static()\`) match only
statically-written links, now and forever. The bare forms are identical
today, but will transparently widen to include query-derived (dynamic)
membership in a future release. \`_dyn\` forms are reserved and rejected.

### \`$degrees\` — graph mode only

\`$degrees\` is a scalar available **only inside a \`graph\` call's
\`filter\`**, never in a \`query\` filter (using it there is a
\`filter_invalid\` error). It is the minimum number of hops from the
nearest root at which the current document was reached, under that call's
direction lens. In \`graph\`, \`filter\` is *visibility*, not selection: a
non-matching document is hidden and blocks paths through itself. This lets
a filter shape the traversal, e.g. \`$degrees <= 1 || type == "person"\` —
include everything within one hop, but keep following \`person\` documents
deeper. See the \`graph\` tool for the full read surface.

## text — full-text search

Portable syntax across storage backends: space-separated terms (implicit
AND) and \`"quoted phrases"\`. Anything fancier (OR, NEAR, prefix \`*\`)
is backend-specific — it may error or behave differently between SQLite
FTS5 and Postgres.

## rank — semantic search

\`rank: "tiered SaaS pricing"\` retrieves by embedding similarity and
composes with \`filter\`/\`text\` (they prune its candidates). Requires
the server to be configured with an embedding hook; otherwise the query
fails with \`rank_unavailable\`.

## Visibility flags

By default, documents whose path contains a hidden segment (e.g.
\`.drafts/…\`) or a system segment (e.g. \`:deleted/…\`) are excluded.
Set \`include_hidden: true\` or \`include_system: true\` to surface them —
browsing \`:deleted/\` is how you find documents to restore.

## Errors

A bad filter fails with code \`filter_invalid\` and a \`data.reason\`
saying what was wrong; fix the expression and retry.
`;
