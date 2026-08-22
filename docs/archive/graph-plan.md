# Graph Plan — The `graph` Read Surface (Neighborhood Expansion over the Links Index)

Target: a read-only **graph exploration surface** over the existing `links` derived index (design §11.2, shipped by [links-plan.md](links-plan.md)). One new kernel read (`kernel.graph`), one new MCP tool (`graph`), one new REST route (`/repos/{repo}/graph`). No schema changes, no new index — the links table already holds `(source_id, ord, field, target_raw, target_norm, target_id)` per outbound edge, and a labeled multigraph projection of it is exactly what agent callers (observed live with MCP clients) are missing: the CEL predicates (`$in`/`$has`/`$links()`/`$backlinks()`) answer *which documents* but throw away the connections; `graph` answers *how documents connect*, returning documents **and** links, expandable outward from roots.

The API transacts in **documents** and **links** — the vocabulary used everywhere else in mrplex. No "nodes", no "edges", anywhere: not in parameter names, not in output keys, not in schema descriptions, not in code comments on the wire types.

Branch `graph` is cut from `main`.

## 1. Scope

**In:**

- **Kernel read `kernel.graph(ctx, spec)`** — BFS expansion from a root set over the repo-local links index, honoring scope and filter as *visibility* (traversal happens inside the visible subgraph), returning documents, distinct links, a `frontier`, and truncation metadata. Read-only; no writes, no index maintenance.
- **MCP tool `graph`** — a top-level read primitive alongside `query` (bare name, no family prefix: `links_*` is the index-maintenance trio, `docs_*` is per-document CRUD; `query` set the precedent that read primitives stand alone). Registered in `src/mcp/tools.ts` with full `inputSchema`/`outputSchema` per the self-describing-tools convention (commits `daba488`, `0fcb468`).
- **REST route `/repos/{repo}/graph`** — repo-scoped (links are repo-local by construction), GET + POST mirroring `/query`'s duality: GET with query params for simple calls, POST with a JSON body when `filter`/`select` get awkward to URL-encode. Wired in `src/rest/routes.ts` `dispatchRepos`.
- **`$degrees` filter intrinsic** — a scalar CEL intrinsic, defined **only inside a `graph` call's `filter`**: minimum hops from the nearest root at which this document was reached. Documented in `src/mcp/query-syntax.ts` (`QUERY_SYNTAX_DOC`) with the only-in-graph caveat.
- **Surface renderings** — three pure functions of the structured result: `summary` (adjacency listing), `yaml`, `mermaid`. Presentation is a *surface* concern, never a call parameter (see decision 12): the MCP tool's text half is always the summary (one fixed compact rendering per tool, like every sibling in the registry); the CLI selects via a `--render` flag (its native idiom); REST returns structured only.
- **CLI `mrplex graph`** — thin wiring over the kernel read in `src/cli/main.ts`, consistent with every other surface mirroring the kernel; `--render summary|yaml|mermaid|json`.
- **Storage surface** — batched adjacency reads and scope-visible degree counts on both adapters (SQLite + Postgres), held to parity by the shared kernel suite.

**Out (deliberately):**

- **`links_list`** — the raw, paged, per-occurrence edge listing (with `ord`, dangling rows, per-field filters). It is the designed escape hatch for occurrence-level detail (which section, how many times, eventually context snippets) and the home of dangling-link discovery, but it is a separate small tool; this branch ships the exploration composite only.
- **`graph_paths`** — k-shortest-paths between two documents. Agents ask "how is X related to Y" constantly, but it is a separate algorithm and a separate tool. The `graph` namespace deliberately leaves room.
- **Per-hop direction patterns** (`steps: ["out", "out", "in"]`, Cypher-style). The `direction` lens + frontier re-rooting covers composition (see decision 4); a path-expression param can supersede `direction`+`degrees` later without breakage if demand materializes.
- **Body-link context snippets** (`include_context`). Attacks the "why is this link here" problem for `$body` edges, but `dest_span` is not persisted in `LinkRow` — needs span persistence (a migration) or on-demand re-extraction. Own change, own plan.
- **Occurrence counts on links** (see decision 3) and **per-direction degree intrinsics** `$degrees_in`/`$degrees_out` (see decision 5 — not well-defined per document under mixed traversal).
- **Cross-repo graphs** — links are repo-scoped rows; a cross-repo graph would be a union of disconnected components. Revisit only if inter-repo links ever exist.
- **Inline-property / microformat relationship typing.** The `field` column *is* the relationship type today (`$body` = untyped). When dataview-style inline properties (`reports_to:: [[sam]]`) or a microformat land, that is purely an **extraction** change emitting richer `field` values into the same rows — this API is designed so it does not change at all.

## 2. The `graph` call

### 2.1 Input

```jsonc
{
  "repo": "handbook",                 // required; single repo slug, no globs
  "roots": "moc/employees.md",        // path/glob (gitignore-style), string or array of either
  "direction": "both",                // "out" | "in" | "both" (default "both")
  "degrees": 1,                       // max hops from nearest root (default 1; 0 = roots only)
  "fields": ["reports_to", "$body"],  // optional; restrict traversal AND output links to these fields
  "filter": "$degrees <= 1 || type == \"person\"",  // optional CEL; visibility, not selection
  "select": ["title", "type"],        // frontmatter keys projected into documents (default ["title"])
  "max_documents": 100,               // soft budget incl. roots; server hard cap applies
  "scope": [ /* ScopeClaim[] */ ]     // as on `query`; X-Mrplex-Scope header wins
}
```

Parameter semantics, pinned:

- **`repo`** — exactly one repo slug. No wildcards (unlike `query`'s repo param): links are repo-local (`repo_id` on every row), so this is forced by the data model, not a style choice.
- **`roots`** — `oneOf: [string, array]` like `query`'s repo param; each entry an exact doc path or gitignore-style glob (the convention `$in(glob)`/`$has(glob)` already established). Every visible, filter-matching current document matching any root pattern enters the traversal at `$degrees: 0`. A glob matching nothing → empty result, **not** an error. A root excluded by scope or filter is not a root.
- **`direction` + `degrees`** — a *lens*, never per-direction budgets. `"out"`: follow links source→target only (the contents tree — what this doc references, transitively). `"in"`: target→source only (the backlink neighborhood). `"both"`: undirected (the degrees-of-separation ball; co-citation — root → shared-target ← sibling — included at degrees 2… note co-citation needs `"both"`, and at `degrees 1` only direct neighbors appear). All three modes give every reached document a deterministic scalar `$degrees` = minimum hops under that lens.
- **`fields`** — when present, only links whose `field` is in the list exist, for **both** traversal and the output `links` array (one consistent lens). `"$body"` is a valid member (it is a value in the field-path namespace, exactly where §11.2 defined it).
- **`filter`** — same CEL dialect as `query` (bare identifiers = frontmatter keys, `$`-intrinsics, `list()` polymorphism, the graph predicates themselves — `$has`/`$in`/`$links()`/`$backlinks()` all legal), **plus `$degrees`**. Semantics: *visibility*. The effective graph is the subgraph of current documents matching (scope ∧ filter); traversal happens inside it. A non-matching document is not returned **and blocks paths through itself** — same rule as scope ("visible graph = readable graph", §11.2 "Scope interaction", `kernel.ts` links.stale). This is the only semantics under which `frontier` stays honest: output-only filtering would report frontier docs the caller cannot actually expand through.
- **`$degrees` evaluation** — at first reach. BFS visits every document at its minimal distance first, and since the filter can only *prune* (visibility is monotone — excluding a doc never shortens another doc's path), the value the filter sees is well-defined: the doc's true minimal degrees within the effective graph. Killer pattern this unlocks: `$degrees <= 1 || type == "person"` — expand everything one hop, but keep following person-docs.
- **`select`** — which frontmatter keys appear as bare keys on result documents. Bare keys only (a `$`-prefixed entry is `filter_invalid`-style input error); a missing key on a given doc is simply absent. Default `["title"]`.
- **`max_documents`** — one knob, documents only. Links are a *consequence* (induced set, §2.2), not a budgeted resource. Truncation is deterministic: BFS order, ties broken by path.

There is deliberately **no presentation parameter** (no `render`/`format`). Every input above changes the structured result; a parameter that wouldn't is in the wrong layer (decision 12).

### 2.2 Output (`structuredContent`)

```jsonc
{
  "documents": [
    { "$path": "moc/employees.md", "$degrees": 0, "$links": 14, "$backlinks": 3,
      "title": "Employees MOC" },
    { "$path": "people/sam.md", "$degrees": 1, "$links": 6, "$backlinks": 9,
      "title": "Sam", "type": "person" }
  ],
  "links": [
    { "source": "moc/employees.md", "target": "people/sam.md", "field": "$body" }
  ],
  "frontier": ["people/sam.md"],
  "complete_degrees": 1,
  "truncated": true
}
```

Output semantics, pinned:

- **A result document is the filter language's data model, reified.** Bare keys are frontmatter (whatever `select` projected); `$`-keys are system intrinsics. This mirrors CEL exactly (bare identifiers = frontmatter, `$` = system) and has wire precedent: `docs_get` injects `$version` into `frontmatter_raw` for the same collision-proofing reason. Consequence: no user frontmatter key can ever collide with a system field, and the filter loop closes — `filter: "$degrees <= 1"` and output `"$degrees": 1` are the same value from the same namespace. **Note this is not the `Version` wire shape** (which uses bare `path` etc.); it is a projection, and the `$` convention is what marks it as one.
- **`$degrees`** — call-relative: minimum hops from the nearest root under *this call's* direction/fields/filter/scope. Not a stable property of the document; agents must not persist it across calls (the outputSchema description says so).
- **`$links` / `$backlinks`** — the collection-intrinsic names, uninvoked. Convention, stated once in the schema: *a collection intrinsic referenced without invocation serializes as its size.* So filter-side `$links().size() == 0` and output-side `"$links": 0` are visibly the same fact. Values are counts of **distinct documents** (collection semantics — three body mentions of one target count once; two fields to the same doc count once), **scope-visible but independent of this call's `filter`, `fields`, and `degrees`** — they describe the document's true visible connectivity (the value `$links().size()` would evaluate to under the caller's scope), stable across calls, which is what makes them useful for ranking frontier docs (hub vs. leaf). This convention reserves the bare names forever; accepted knowingly (inlining the actual collections would only duplicate `links`).
- **`links`** — the **induced** distinct set: every `(source, target, field)` triple where both endpoints are in `documents` and `field` passes the `fields` param — not merely the links traversal walked. Induced means the picture is complete for the documents shown. No `ord`, no counts, no `$`-prefixes on keys (`source`/`target`/`field` share no namespace with user keys; prefixing them would be cargo-culting). Multiplicity and per-occurrence detail belong to the future `links_list`.
- **Dangling links never appear.** The index stores them (`target_id` null, `target_norm` retained for rebinding), but this API transacts in documents, and a dangling target is not a document — representing it would mean pseudo-documents with fake paths. Danglers stay discoverable via `links_stale` today and `links_list` later.
- **No `roots` echo.** `"$degrees": 0` marks the roots; with glob roots, the degrees-0 documents *are* the answer to "what did my glob match".
- **`frontier`** — paths of documents **present in `documents`** whose links were *not fully enumerated* in this result — whether cut by the `degrees` cap or by `max_documents`. Behavioral, not depth-based: a doc at max degrees whose visible neighbors all already appear is **not** frontier (expanding it is a wasted call). This is the continuation contract: no cursors; the agent re-roots at chosen frontier paths. Multi-call composition is well-defined because `links` is a set of distinct triples (union just works) and documents are keyed by `$path` ($degrees differs per call — it is call-relative anyway). Asymmetric shapes ("out 2 then in 1 from what I found") are two calls, by design.
- **`complete_degrees`** — the largest `d` such that every effective-graph document within `d` hops of a root is present. When `truncated` is false, `complete_degrees == degrees` (requested). When `max_documents` cuts BFS mid-ring, this turns a truncated result into a precise statement: "the 2-hop ball is exhaustive, the 3-ring is sampled" — an agent can answer "does anything within two hops mention X?" definitively from a truncated response.
- **`truncated`** — true iff `max_documents` (or the server links ceiling) elided anything.
- **Ordering** — documents by `($degrees, $path)`; links by `(source, target, field)`. Same inputs → same result, byte for byte (determinism ethos, as extraction).

### 2.3 Surface renderings

Renderings are pure functions of the structured result and live at the *surfaces*, matching each surface's native idiom — no tool in the registry parameterizes presentation, and `graph` doesn't start. MCP's text half is **always the summary** (the fixed-compact-rendering contract every other tool honors); the CLI selects with `--render`; REST returns structured only (a `?render=` query param is possible later if wanted — out of scope). An MCP agent that wants a diagram builds mermaid from the structured payload, which contains everything needed; if practice shows server-side mermaid is worth having on MCP, an optional param later is non-breaking (removing one never is).

- **`summary`** (MCP text half; CLI default) — the densest per-token form; adjacency listing grouped by field:
  ```
  moc/employees.md (0)
    →($body) people/sam.md, people/kai.md
    ←($body) index.md
  people/sam.md (1)
    →(team) teams/platform.md
  frontier: people/sam.md · complete through 1 degree · truncated
  ```
- **`yaml`** (CLI `--render yaml`) — a YAML dump of the structured payload; a legitimately better *reading* format than JSON for a human or LLM skimming a subgraph. Implementation may hand-roll the (flat, known-shape) emission — do not add a YAML dependency for this without weighing it.
- **`mermaid`** (CLI `--render mermaid`) — passthrough-renderable by most chat and markdown surfaces (the graph becomes *showable*, not just traversable):
  ```mermaid
  flowchart LR
    d0["moc/employees.md"]:::root
    d1["people/sam.md"]
    d0 -->|"$body"| d1
    classDef root stroke-width:3px
    %% truncated: complete through 1 degree
  ```
  Rules: generated ids (`d0`, `d1`, …) with the path as the quoted label — **never** the path as the mermaid id (slashes, dots, `:` all break mermaid syntax); `field` as the edge label; roots get a `classDef`; a trailing `%%` comment echoes truncation. Degrades past ~40–50 documents, which `max_documents` already bounds.

## 3. Repo layout — what this branch adds

```
src/kernel/graph.ts            BFS engine: expansion rounds, visibility, frontier, complete_degrees
src/kernel/graph.test.ts       semantics: lenses, $degrees, filter-as-visibility, frontier, truncation
src/kernel/kernel.ts           kernel.graph(ctx, spec) wiring; GraphSpec/GraphResult in wire.ts
src/kernel/query/…             $degrees intrinsic recognized only via graph's per-round binding (WS2)
src/storage/types.ts           adjacency + degree-count methods (below)
src/storage-sqlite/adapter.ts  implementations
src/storage-postgres/adapter.ts  implementations
src/mcp/tools.ts               `graph` tool entry (input/output schemas, handler)
src/mcp/render.ts              renderGraphSummary (MCP text half; CLI default render)
src/mcp/query-syntax.ts        $degrees documented (only-in-graph caveat)
src/rest/routes.ts             /repos/{repo}/graph GET+POST in dispatchRepos
src/cli/main.ts                `mrplex graph` command with --render
src/cli/format.ts              renderGraphYaml / renderGraphMermaid (CLI-only renders)
```

New `Storage` methods (both adapters; names indicative):

```ts
/** Outbound rows for a batch of sources: distinct (source_id, target_id, field), resolved only. */
links_adjacent_out(repo_id: number, source_ids: readonly number[]): Promise<AdjacentLink[]>;
/** Inbound rows for a batch of targets: distinct (source_id, target_id, field). */
links_adjacent_in(repo_id: number, target_ids: readonly number[]): Promise<AdjacentLink[]>;
/** Distinct-document out/in counts for a batch of docs (unscoped; kernel applies scope, see WS1). */
links_degree_counts(repo_id: number, doc_ids: readonly number[]): Promise<DegreeCountRow[]>;
```

`AdjacentLink = { source_id, target_id, field }` (distinct triples at the SQL level — `SELECT DISTINCT`; `ord` never leaves storage on this path). Dangling rows (`target_id IS NULL`) are excluded in SQL.

## 4. Traversal semantics (normative, for WS2)

1. **Effective graph.** Current versions only. A document is *visible* iff it passes the caller's scope (claims → `claimsGrantRead`, as `query`/`links.stale`) **and** the `filter` (evaluated with `$degrees` bound — see step 3). A link *exists* iff its `field` passes `fields`, it is resolved (`target_id` not null), and **both** endpoints are visible. Traversal never crosses an invisible document or a nonexistent link.
2. **Roots.** Resolve `roots` patterns against visible current paths → root id set at degrees 0 (filter evaluated with `$degrees = 0`). Empty → empty result (`documents: []`, `frontier: []`, `complete_degrees: 0`, `truncated: false`).
3. **BFS by rounds.** Round `r` expands the round-`(r-1)` frontier via `links_adjacent_out` / `_in` / both per the `direction` lens. Candidate docs not yet visited get `$degrees = r`. **Filter binding:** every candidate in round `r` shares `$degrees = r`, so compile the filter once per round with `$degrees` inlined as a constant literal, then evaluate candidates through the existing query-compilation machinery constrained to the candidate id set (reuse the `SearchPlan` path; both dialects). Scope applies in the same pass. Survivors are visited; non-survivors are invisible (their onward links do not exist).
4. **Budget.** Stop admitting documents at `max_documents`, cutting in BFS order with `$path` tiebreak within a round. If a round is cut partway: `complete_degrees = r - 1`, `truncated = true`; else on clean completion `complete_degrees = degrees`.
5. **Frontier.** After the final admitted round, peek one adjacency step from every admitted doc that was never fully expanded (docs at `$degrees == degrees`, plus docs whose expansion was skipped or cut by budget): if it has ≥1 effective-graph link to a document not in the result, it is frontier. (The peek is one batched adjacency call + one visibility check round; do not skip it — a frontier containing sated docs sends agents on wasted calls. It is acceptable to bound the visibility check to the link's existence + scope, treating filter-unknown neighbors as potentially-new.)
6. **Induced links.** One batched adjacency pass over the admitted id set, intersected against itself, `fields`-filtered, distinct, both directions collapsed to their true `source → target`. Server hard ceiling on the links array (config; generous) → drop deterministically by ordering and set `truncated = true`.
7. **Degree counts.** `links_degree_counts` over admitted ids gives raw distinct-doc counts; the kernel applies **scope only** (not filter/fields/degrees) to match the pinned `$links`/`$backlinks` semantics. Where scope is non-trivial this needs the counted *neighbors'* paths — batch-fetch and filter in the kernel, or push the scope glob into SQL the way the CEL link predicates already compile scope into their subqueries (implementer's choice; parity tests pin the observable behavior).
8. **Assembly.** Documents ordered `($degrees, $path)` with `select`-projected frontmatter; links ordered `(source, target, field)`; paths (not ids) everywhere on the wire.

## 5. Design decisions pinned (record in design.md §9 decision log on merge)

1. **Vocabulary: documents and links.** The API transacts in the system's own terms; there is no node/edge abstraction layer because none exists — `links` are aggregated index rows, `documents` are documents.
2. **`field` is the relationship type.** `$body` = untyped. Future explicit typing (frontmatter fields today; dataview inline properties / microformats later) only enriches extraction's `field` values; the graph API is invariant to it.
3. **Links are distinct `(source, target, field)` triples — no occurrence count.** A link is a pure statement of relationship; the payload is a proper set (obvious dedupe, meaningful diffs, no `×N` noise in renders). Multiplicity stays reachable via the future `links_list`; adding a count later is cheap, removing one is not.
4. **Direction is a lens (`out`/`in`/`both` + scalar `degrees`), not per-direction budgets.** Per-path in/out hop budgets are mechanically definable but map to nothing users mean (and per-document `(degrees_out, degrees_in)` is a Pareto set, not a value — "first reached via in or out" depends on queue order, violating determinism). Asymmetric expansion composes across calls via frontier re-rooting.
5. **`filter` is visibility; `$degrees` is the only degrees intrinsic, scalar, bound at first reach.** Non-matching docs block paths (composes with scope as one predicate). No `$degrees_in`/`$degrees_out` (see 4).
6. **Output documents reify the filter data model.** Bare keys = `select`-projected frontmatter; `$`-keys = intrinsics ($ collision-proofing precedent: `$version` injection). Uninvoked collection intrinsics serialize as sizes (`$links`, `$backlinks`), reserving those bare names permanently.
7. **`$links`/`$backlinks` count distinct scope-visible documents, independent of this call's filter/fields/degrees** — the value `$links().size()` would see; a stable steering signal.
8. **`links` output is the induced distinct set** over returned documents (fields-filtered), not the traversal tree.
9. **Dangling links are excluded** from graph results entirely (documents-only vocabulary); they remain the province of `links_stale`/`links_repair`/future `links_list`.
10. **`frontier` is behavioral** ("has unenumerated effective links"), the continuation mechanism is re-rooting, and there are no cursors.
11. **`complete_degrees` + `truncated`** make partial results precise; truncation is deterministic (BFS order, `$path` tiebreak).
12. **Presentation is a surface concern, never a call parameter.** No `render`/`format` in the spec — every input changes the structured result. MCP's text half is always the summary (the one-fixed-rendering-per-tool contract the whole registry honors); the CLI chooses via `--render` (its native flag idiom); REST returns structured only. Renderings are pure functions of `GraphResult`, so any surface (or agent) can produce yaml/mermaid from the structured payload.
13. **Naming: MCP tool `graph`; REST `/repos/{repo}/graph`; CLI `mrplex graph`.** Top-level like `query` (the sibling read: query = which, graph = how connected); repo-scoped route because links are repo-local.
14. **One shared filter reference.** `$degrees` documents in `query_syntax` with an only-in-`graph` note; the `graph` tool description points at `query_syntax` exactly as `query` does.

## 6. Workstreams (attack order)

### WS0 — This plan
`graph-plan.md` (this file). Done.

### WS1 — Storage adjacency + degree counts (S–M)
`links_adjacent_out` / `links_adjacent_in` / `links_degree_counts` on `Storage`, both adapters, `SELECT DISTINCT`, dangling excluded, batched `IN`-list inputs (mind Postgres parameter limits — chunk if needed). Parity via the shared kernel suite. No migrations.

### WS2 — Kernel BFS engine (M–L, semantics-critical)
`src/kernel/graph.ts` implementing §4 exactly: lenses, per-round `$degrees`-as-constant filter compilation reusing the query machinery, scope∧filter visibility, deterministic truncation, behavioral frontier (with the one-step peek), `complete_degrees`, induced links, scope-only degree counts. `GraphSpec`/`GraphResult` wire types. The test file is the spec: every pinned decision in §5 gets a test; determinism gets a repeated-run byte-equality test; the co-citation case (`both`, degrees 2… and its absence at degrees 1 and under `out`) gets one; filter-blocks-paths gets one; frontier-excludes-sated-docs gets one.

### WS3 — MCP tool + summary render + syntax doc (M)
`graph` entry in `TOOL_REGISTRY`: inputSchema per §2.1 (oneOf string/array roots, direction enum — no presentation params), outputSchema per §2.2 with the call-relative-`$degrees` and frontier-contract language *in the schema descriptions* (agents read those); `additionalProperties: true` on the document object for `select` projections. `renderGraphSummary` in `render.ts` as the tool's fixed text half. `$degrees` added to `QUERY_SYNTAX_DOC`; `graph` description points at `query_syntax`.

### WS4 — REST route (S–M)
`/repos/{repo}/graph` GET+POST in `dispatchRepos`, mirroring `/query`'s GET param and POST body conventions (arrays and CEL: POST-preferred; GET supports the simple cases). Same scope-header precedence as everywhere.

### WS5 — CLI (S–M)
`mrplex graph --repo … --roots … [--direction …] [--degrees …] [--fields …] [--filter …] [--select …] [--max-documents …] [--render summary|yaml|mermaid|json]` — kernel call + chosen render to stdout (summary default). `renderGraphYaml`/`renderGraphMermaid` in `src/cli/format.ts` per §2.3 (the mermaid id-sanitization rule is load-bearing: generated ids, path only ever as a quoted label).

### WS6 — Tests, parity, docs (M)
Integration coverage across both adapters; MCP tool round-trip (schema-validated structured output); REST GET/POST equivalence; design.md gains a §11.2 subsection (or §11.3) describing the graph read surface and the §5 decisions land in the §9 log; README tool table gains `graph`.

## 7. Sequencing

WS1 → WS2 → {WS3, WS4, WS5 in parallel} → WS6. WS2 is the risk concentrator; everything after it is wiring.

## 8. Open questions (resolve during WS2/WS3; none block WS1)

- **Defaults/caps:** `degrees` default 1 (settled); server cap on `degrees` (suggest 5), `max_documents` default (suggest 100) and hard cap (suggest 500), links hard ceiling (suggest 5000). Config knobs vs. constants — follow whatever `query`'s `limit` default does.
- **GET encoding for `roots`/`fields`/`select`:** repeated params vs. comma-joined — match `/query`'s existing precedent; if `/query` has none for arrays, pick repeated params and document it.
- **Frontier peek precision:** §4.5 permits treating filter-unknown neighbors as potentially-new (cheap) vs. full visibility evaluation (exact). Start cheap; tighten if agents report wasted expansions.
- **`title` when `select` defaults:** absent frontmatter `title` yields no key — confirm agents cope (they will; the schema says keys are conditional).

## 9. Definition of done

```
# The sibling read works end to end
mrplex graph --repo handbook --roots 'moc/**' --degrees 2 --direction out
# → documents with $path/$degrees/$links/$backlinks/title, induced links,
#   frontier, complete_degrees, truncated — deterministic across runs

# Filter is visibility, $degrees binds
… --filter '$degrees <= 1 || type == "person"'
# → non-person docs appear at degrees ≤ 1 only and block deeper paths

# Co-citation via the undirected lens
… --direction both --degrees 2   # root → shared-target ← sibling appears

# Frontier re-rooting composes
# call 1: out/1 from root; call 2: in/1 rooted at call 1's paths → union is coherent

# Renders
… --render mermaid   # passthrough-renderable; ids sanitized; roots classed
… --render yaml

# Scope: the visible graph is the readable graph — an out-of-scope endpoint
# hides the doc AND its links AND paths through it, and $links/$backlinks
# counts shrink accordingly

# MCP: `graph` validates against its own outputSchema; REST GET and POST
# return identical structured results; SQLite and Postgres agree byte-for-byte
```
