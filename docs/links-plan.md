# Links Implementation Plan — Link Extraction, Indexing, and Graph CEL (`$in` / `$has` / `$links` / `$backlinks`)

Target: the **Phase 1** slice of [design.md §11.2](design.md) ("Links, backlinks, and graph queries"): *ships the `links` derived index and the `_static` CEL variants (including field-argument forms). Filter authors write `$in_static(X)` explicitly; queries stay stable when Phase 2 lands.* Also lands the identity-bound resolution model (§11.2 "Identity resolution is the load-bearing decision"), dangling re-resolution, `links.stale`, and `mrplex links repair` (§11.2 "Link rewriting is cosmetic").

A markdown corpus is a graph (§11.2). This branch teaches mrplex that graph the same way M4 taught it chunks: a **derived index over documents' current versions**, rebuildable from scratch, never source of truth, doc-keyed not version-keyed. Where chunks needed an external embedding hook (async, fallible, deduped — §5.3), **link extraction is pure CPU**: deterministic, server-side, no hook. That single difference reshapes the maintenance story — extraction runs *inside the write transaction* alongside the version insert (the `fts_docs` trigger precedent, `src/storage-sqlite/migrations/0003_fts_docs.sql:23`), not out-of-band on a backlog worker (the embedding precedent, `src/embed/worker.ts`). The query surface is the payoff: four possession-language intrinsics join the `$` namespace (§5.1) as CEL functions, compiled to scope-respecting `EXISTS`/`COUNT` joins against the `links` table by both adapters (`compile-sqlite.ts` / `compile-postgres.ts`).

Branch `links` is cut from `main` (post-M5).

## 1. Scope

**In:**

- **`links` derived index** (§11.2). One row per outbound *static* edge from the live corpus, doc-keyed. Exact schema from §11.2:
  ```sql
  links (
    source_id   integer not null references documents(id),
    ord         integer not null,   -- position within the current version
    field       text not null,      -- '$body' for body edges; CEL field path otherwise
    target_raw  text not null,      -- as written, normalized repo-absolute; anchor preserved
    target_id   integer references documents(id),  -- resolved at extraction; null = dangling
    primary key (source_id, ord)
  )
  ```
  Doc-keyed (not version-keyed) is load-bearing: every query the design cares about asks about the *current* graph; historical link questions reparse the old version (§11.2, consistent with "current is fast, history is a scan").
- **Deterministic extraction** (§11.2 "Extraction"), a pure function of `(body, frontmatter, link_config, source_path)`. Recognized syntaxes, each a link-config knob (defaults per §11.2): CommonMark inline `[t](p)` (on), CommonMark reference `[t][id]`+`[id]: p` (on), autolinks `<p>` (on), wikilinks `[[page]]` / `[[page|display]]` with extension elision `foo`→`foo.md`→`foo/index.md` (on), frontmatter reference fields (`link_config.fields`, empty by default — opt-in per repo). A leading `!` (embed/transclusion — `![alt](p)`, `![[page]]`) is a rendering hint, not a distinct type: the destination is captured as an ordinary edge from its base syntax, no separate knob (see §1.1). Path resolution: relative targets normalize against the source doc's path unless repo-absolute (leading `/`); anchors preserved on `target_raw`; case follows repo path policy (§3.5.1).
- **Link config cascade** (§11.2, on the §3.5.2 pattern): `hardcoded defaults → server config → per-repo override`, replace-not-merge per field, exactly mirroring `src/kernel/path-config.ts`. Disabling a syntax removes it from extraction. A config change triggers repo-wide re-extraction on the backfill path.
- **Identity-bound resolution** (§11.2 "load-bearing decision"). At extraction the normalized target resolves against the live path set; on success the edge binds to the target's **`document_id`**, not its path. Consequences that ship: backlinks/traversal survive renames with zero rewriting; dangling edges (`target_id` null) are first-class rows; when a document later appears at a named path (create / move-in / restore), a re-resolution pass binds the waiting danglers.
- **In-transaction maintenance** (§11.2 "Maintenance is local to the source"). Every write that advances doc D's current version re-extracts D's outbound edges (`delete where source_id = D` + re-insert) *inside the same `storage.tx`* as the version insert — read-your-writes graph consistency, no queue. `docs.delete` clears D's outbound rows; inbound rows (target = D) stay put and are excluded from live-namespace queries by the same visibility filter `query` already applies (§8.2 / §4.1). `docs.move` produces **no edge churn** — inbound edges are identity-bound.
- **Field paths** (§11.2 "Field paths"): the `field` column and `link_config.fields` share CEL's field-access grammar — dot notation (`parent`, `project.lead`), bracket-quoted segments (`owners["team-lead"]`), no array indices (the §5.2 `list()` polymorphism handles scalar-or-list), `$body` sentinel for body edges. Terminal-fields rule: a declared field extracts only when its resolved value is a string or list of strings (a non-terminal path on list-of-objects extracts nothing — no silent prose harvesting).
- **CEL surface — `_static` variants only** (§11.2 "CEL surface", "Phasing" Phase 1). Four possession-language functions, each in its explicit `_static` form:
  | Concept | Boolean test | Collection |
  |---|---|---|
  | others → me | `$in_static(glob)` | `$backlinks_static()` |
  | me → others | `$has_static(glob)` | `$links_static()` |
  - `$in_static(path-or-glob [, field])` / `$has_static(path-or-glob [, field])` — glob-argument membership/reference, compiled to `EXISTS` joins.
  - `$backlinks_static()` / `$links_static()` — collections, usable with CEL `.size()` (→ scalar `COUNT` subquery), `.exists(d, pred)` and `.all(d, pred)` (→ `EXISTS`/`NOT EXISTS` over the joined target/source versions, predicate compiled against the *other* doc's frontmatter/intrinsics).
  - **Field restriction** is the optional second argument, not a separate function (`$has_static("projects/**", "parent")`), including `"$body"`; restricts to static edges by nature.
  - MOC set algebra composes as boolean combinations (§11.2): `$in_static("moc/employees.md") && !$in_static("moc/contractors.md")`, `!$in_static("**")` (orphan), `$links_static().size() == 0` (leaf).
- **Scope interaction** (§11.2 "Scope interaction"). Every predicate respects the caller's read scope the same way `query` does (§8.2): sources and targets outside the read globs are silently dropped, so the visible graph equals the readable graph. The compiled subqueries carry the same scope filter the `SearchPlan` already applies to the outer query.
- **Staleness + repair** (§11.2 "Link rewriting is cosmetic"). `links.stale` kernel read lists live docs whose written link *text* no longer matches the resolved target's current path. `mrplex links repair` walks that list and rewrites each as an ordinary optimistic `docs.put` under the caller's token — `prev` checks apply, conflicts reported and skipped, every repair is a normal authored version.
- **Backfill + re-extraction** (§11.2). `mrplex links backfill --repo <slug>` builds the index for an existing corpus and re-extracts after a link-config change — the `src/embed/backfill.ts` shape, but synchronous (no hook, no worker): walk live versions, extract, replace rows, then a final dangling re-resolution sweep.
- **Adapter surface + parity.** New `Storage` methods (below) on both SQLite and Postgres adapters; `links` table in both migration trees; the CEL compiler extensions in both `compile-sqlite.ts` and `compile-postgres.ts`, held to parity by the shared kernel suite (§7.2).

**Out (deliberately):**

- **Embedded queries, the `--in` operator, and all `_dyn` / bare-name variants** (§11.2 Phase 2; §11 `--in` bullet). Dynamic membership resolves at query time against embedded queries in list docs — a genuinely deep separate concern (repo-global invalidation, predicate inversion, corpus-bounded fan-out, `--dyn-scope` cap, `dynamic_scope_exceeded`). Phase 1 ships only `_static`; the bare names `$in` / `$has` / `$backlinks()` / `$links()` are **reserved, not implemented** — they land in Phase 2 alongside `_dyn` so bare-name union semantics are stable from birth (§11.2 "Phasing"). Writing `$in` in Phase 1 is a `filter_invalid` with a "use `$in_static` until Phase 2" message.
- **Multi-hop traversal `$reachable_from(...)`** (§11.2 "Multi-hop traversal", syntax `[OPEN]`). Recursive-CTE feasibility is settled but the syntax is open and it's static-only anyway; defer to keep Phase 1 single-hop.
- **`auto_repair` policy** (§11.2 `[OPEN]`) — server-side repair loop after each move. Phase 1 ships the manual `mrplex links repair` trigger; the worker-driven variant is additive (identical mechanism, different trigger).
- **Cross-repo references** (§11.2 `[OPEN]`, "Links are repo-local in this sketch"). Extraction and resolution are repo-local.
- **Link anchors as structure** (§11.2 preserves `#heading` on `target_raw` but does not resolve it). Heading identity depends on the block tree (§11 "Structured body queries") — not this branch.
- **LSP hover / go-to-definition on links** (§11 `mrplex-lsp`) — downstream consumer, out of scope.

### 1.1 Supported link syntaxes (detail for WS2)

Every syntax below is a **link-config knob** on the §3.5.2 three-level cascade (`hardcoded defaults → server config → per-repo override`). Toggling one off removes it from extraction entirely — its edges simply don't appear in the `links` table. All are **on by default except frontmatter fields**, which are opt-in per repo.

| Syntax | `link_config` key | Default | Example | `field` | Extracted `target_raw` |
|---|---|---|---|---|---|
| CommonMark inline | `syntaxes.inline` | on | `[Alice](people/alice.md)` | `$body` | `/people/alice.md` |
| CommonMark reference | `syntaxes.reference` | on | `[Alice][a]` … `[a]: people/alice.md` | `$body` | `/people/alice.md` |
| Autolink | `syntaxes.autolink` | on | `<notes/horses.md>` | `$body` | `/notes/horses.md` |
| Wikilink | `syntaxes.wikilink` | on | `[[alice]]`, `[[alice\|Alice Ng]]` | `$body` | `/alice.md` (after elision) |
| Frontmatter fields | `fields: [...]` | **off** (empty) | `parent: moc/employees.md` | `parent` | `/moc/employees.md` |

Notes per syntax:

- **CommonMark inline `[text](path)`** — the baseline. Only the destination is an edge; the link text is cosmetic (and is what `links.stale` / `mrplex links repair` later rewrites). A title (`[t](p "title")`) is ignored.
- **CommonMark reference `[text][id]` + `[id]: path`** — the label definition supplies the target; collapsed (`[alice][]`) and shortcut (`[alice]`) forms resolve against defined labels. A reference with no matching definition is *not* an edge (it isn't a link in rendered output either). This is a case the regex approach gets wrong and the real parser gets right (§5 decision 2).
- **Autolink `<path>`** — the angle-bracket form. Only bare relative/absolute doc paths are edges; a full URI with a scheme (`<https://…>`) is external and dropped (external links never enter the index — links are repo-local, §11.2).
- **Wikilink `[[page]]` / `[[page|display]]`** — the display half after `|` is cosmetic text; the target is the page half. **Extension elision** (config `resolution.wikilink_elision`, on) resolves `[[foo]]` against `foo.md` first, then `foo/index.md`; the first live match binds, otherwise the edge is dangling with `target_raw` normalized to the `.md` candidate. `[[foo#section]]` keeps the anchor on `target_raw`.
- **Frontmatter reference fields** — values of the paths listed in `link_config.fields`, each treated as a document path under the §5.2 scalar-or-list `list()` convention. Off by default (empty list); a repo opts in by declaring the fields whose values are links. The `field` column records the declaring path, so these edges are addressable by `$has_static(X, "parent")`.

**The `!` prefix is an embed/transclusion hint, not a link type.** In the CommonMark spec `![alt](path)` is "image" only because the `!` tells a *renderer* to inline the target instead of producing a clickable reference; Obsidian generalizes exactly this — `![[page]]`, `![[page#section]]` transclude, `[[page]]` links. mrplex treats the `!` the same way it treats link text or a wikilink's display half: **cosmetic, rendering-only**. A `!`-prefixed reference is extracted as an ordinary edge from whichever base syntax it modifies (inline / reference / wikilink) — same `field`, same `target_raw`, no separate `syntaxes.image` knob, no extra column recording embed-ness. Consequences:

- There is no "image syntax" to toggle. Whether a target renders inline or as a link is a display concern the index doesn't model; the parser recognizes `!` only well enough to still capture the destination as an edge.
- **Asset references self-select out of the graph without special handling.** `![diagram](img/arch.png)` produces an edge whose target (`/img/arch.png`) is not a document, so it resolves to no identity — the graph predicates `$in_static` / `$has_static` / `$backlinks_static` / `$links_static` match on `target_id`, so an unresolved asset edge is *inert* to every identity-based query. The old worry that motivated an image toggle ("the graph gets dominated by asset references") is moot: those edges never appear in graph query results. If a repo stores assets as content-addressed attachments (§11 attachments bullet) they aren't paths at all and produce no edge in the first place.

### 1.2 `link_config` shape and the cascade

`LinkConfig` layers exactly like `PathConfig` (`src/kernel/path-config.ts`) — non-null replaces the field it sets, no deep merge. The effective config for a repo is `merge(merge(defaults, server), repo_override)`. Full shape with hardcoded defaults:

```jsonc
{
  "syntaxes": {
    "inline":    true,
    "reference": true,
    "autolink":  true,
    "wikilink":  true
  },
  "fields": [],                      // frontmatter reference fields — opt-in per repo
  "resolution": {
    "wikilink_elision": true,        // [[foo]] → foo.md → foo/index.md
    "preserve_anchors": true,        // keep '#heading' on target_raw
    "index_basename": "index"        // the basename tried for [[foo]] → foo/index.md
    // path-absolute-vs-relative and case policy follow the repo's §3.5.1 path policy,
    // not a separate knob — one path-normalization authority.
  }
}
```

**Cascade examples** (replace-not-merge per field):

- Server turns wikilinks off globally (a strict-CommonMark deployment); a vault-style repo re-enables them:
  ```jsonc
  // server config
  { "syntaxes": { "inline": true, "reference": true, "autolink": true, "wikilink": false } }
  // repo "vault" override → wikilinks back on for this repo only
  { "syntaxes": { "inline": true, "reference": true, "autolink": true, "wikilink": true } }
  ```
  Note the override must restate the whole `syntaxes` object it sets — replace-not-merge means a partial `{ "wikilink": true }` would blank the other syntaxes. (WS1 decides whether `syntaxes` merges per-key or whole-object; the safer default is **whole-object replace**, matching `path-config`'s field-level semantics. Pinned as an open sub-decision in §5.)
- A `notes` repo opts into two frontmatter link fields:
  ```jsonc
  { "fields": ["parent", "related"] }
  ```
  Then `parent: moc/employees.md` and `related: [alice.md, bob.md]` produce three edges — `field="parent"` (ord 0), `field="related"` (ord 1, ord 2) — queryable as `$in_static("moc/**", "parent")` etc.

**Terminal-fields rule** (§11.2). A declared field extracts only when its resolved value is a string or a list of strings:

```yaml
# link_config.fields: ["stakeholders.name"]   ← reaches the terminal string
stakeholders:
  - {name: alice.md, role: lead}      # edge: field="stakeholders.name", target=/alice.md
  - {name: bob.md,   role: eng}       # edge: field="stakeholders.name", target=/bob.md

# link_config.fields: ["stakeholders"]        ← non-terminal (list of objects) → extracts NOTHING
# (prevents silently harvesting stakeholders[*].role or a bio field as links)
```

**Config change ⇒ re-extraction.** Editing the effective link config (server- or repo-level) makes the index stale for that scope; the change triggers a repo-wide re-extraction on the backfill path (WS3), never synchronously in the config-write request — same shape as `embed backfill`.

## 2. Repo layout — what this branch adds

```filesystem-layout
src/
  links/
    link-config.ts                  # cascade layering (defaults → server → per-repo), §3.5.2 twin of path-config.ts
    link-config.test.ts
    extract.ts                      # deterministic (body, frontmatter, config, srcPath) → Edge[]; CommonMark + wikilink + fm fields
    extract.test.ts                 # code-fence exclusion, ref-link resolution, wikilink elision, fm terminal-fields rule
    resolve.ts                      # target_raw normalization (repo-absolute, anchors) + live-path → document_id resolution
    resolve.test.ts
    backfill.ts                     # sync build/rebuild of the index over a repo's live versions (+ dangling sweep)
    stale.ts                        # links.stale: live docs whose written link text != resolved target's current path
    repair.ts                       # walk stale list → optimistic docs.put per doc; report conflicts/skips
  kernel/
    query/
      graph-ast.ts                  # recognizes the mangled $*_static call/collection shapes in the CEL AST
  storage-sqlite/
    migrations/
      0004_links.sql                # links table + indexes (source_id PK prefix; target_id; target_raw)
  storage-postgres/
    migrations/
      0002_links.sql                # PG dialect of the same
test/
  links-extract.test.ts             # extraction unit matrix (all syntaxes, config toggles)
  links-graph.test.ts               # $*_static compile + query: membership, set algebra, .size/.exists/.all, field args, scope
  links-maintenance.test.ts         # in-tx replace on put/move/delete; dangling bind on create/move-in/restore
  links-repair.test.ts              # links.stale + mrplex links repair across kernel + CLI
```

Extraction lives in `src/links/`, not `src/embed/`, and runs from the kernel write path — parsing stays out of the storage layer (storage sees resolved `Edge[]`, not markdown). Compiler extensions live in the existing `src/storage-sqlite/compile-sqlite.ts` and `src/storage-postgres/compile-postgres.ts` (the AST-recognition helpers factored into `src/kernel/query/graph-ast.ts` so both compilers dispatch identically).

**Tooling additions (runtime deps):**

- **A real CommonMark parser** — `micromark` (or `markdown-it`). Non-negotiable for correctness: "a link inside a fenced code block is not a link," reference-link `[id]: url` resolution, and correctly capturing the destination of an `!`-embed the same as its plain-link form are genuinely hard to get right with regex, and getting them wrong silently pollutes the graph. This mirrors the project's choice to take `@bufbuild/cel` rather than hand-roll a CEL parser (`src/kernel/query/cel-parse.ts:6`). Wikilinks and frontmatter-field extraction are layered on top (micromark via a small extension or a post-pass; frontmatter reuses `src/markdown/frontmatter.ts` + the `list()` polymorphism convention). Decision to pin in §5.

## 3. Workstreams (attack order)

### WS0 — Write docs/links-plan.md
This document. Follows the m0–m5 skeleton (Target quote → §1 Scope In/Out → §2 Repo layout + runtime deps → §3 Workstreams with Acceptance lines → §4 Sequencing → §5 decisions to pin → §6 Definition of done transcript → §7 Risks). Committed as the first commit of the PR branch (M3/M4/M5 precedent). **Acceptance:** merged review of scope before code.

### WS1 — `links` schema + link-config cascade (S–M)
- `0004_links.sql` (SQLite) and `0002_links.sql` (Postgres): the §11.2 table verbatim in each dialect (SQLite `integer`/`references`; PG `bigint`/`bigserial`-free since ids come from `documents`). Indexes: PK `(source_id, ord)`; secondary on `target_id` (backlinks direction); secondary on `(repo-scoped) target_raw` for dangling re-resolution lookups. Register both dirs in `scripts/copy-assets.mjs` and `test/build-artifact.test.ts` (the M5 migration-registration precedent).
- `link-config.ts`: `LinkConfig` per the §1.2 shape (`syntaxes`, `fields`, `resolution`); `HARDCODED_DEFAULTS`, `mergeConfig` (replace-not-merge), `effectiveLinkConfig(server, repoOverride)`, `parseRepoOverride`, `validateConfig` — a direct structural twin of `src/kernel/path-config.ts`. Per-repo override storage: extend `repos` config (a `link_config` JSON column or fold into existing per-repo config plumbing — decide in §5). `validateConfig` enforces: `fields` entries are valid CEL field paths; `resolution.index_basename` non-empty; the `syntaxes`/`fields`/`resolution` shape (and, if per-key merge wins in §5 decision 7, the deep-merge is confined here).
- **Acceptance:** migrations idempotent on both adapters (existing migration tests green); config cascade unit-tested identically to path-config; `links` table exists and is empty; no behavioral diff to existing queries.

### WS2 — Deterministic extraction (M–L, correctness-critical)
- `extract.ts`: `extractEdges(input: { body, frontmatter, config, srcPath }): Edge[]` where `Edge = { ord, field, target_raw }` (unresolved — resolution is WS3). Pure, total, deterministic (same input → same edges, always — the property extraction/backfill correctness rests on). Walk the CommonMark token stream (skips code spans/fences by construction); collect inline/reference/autolink targets (a leading `!` embed prefix is captured as an edge from its base syntax, not a separate type — §1.1); layer wikilink recognition with extension elision; extract frontmatter-field references honoring the terminal-fields rule and `list()` scalar-or-list polymorphism (§5.2). `ord` is document-order position; `field` is `$body` for body edges, the CEL field path for frontmatter edges.
- `resolve.ts` (target normalization half): `normalizeTarget(target_raw, srcPath, config)` — repo-absolute (leading `/`) vs. relative-to-source; preserve `#anchor`; apply repo case policy. Wikilink elision candidates resolved here.
- **Acceptance:** `links-extract.test.ts` matrix green — every syntax on/off via config; link-in-code-fence excluded; reference-link resolution; `!`-embed prefix captured as an edge from its base syntax (inline / reference / wikilink); wikilink `[[foo]]`→`foo.md`→`foo/index.md`; frontmatter scalar and list forms emit distinct `ord`s under the same `field`; non-terminal field path extracts nothing.

### WS3 — Storage surface + kernel wiring + backfill (M–L, delicate)
- New `Storage` methods (both adapters), doc-keyed:
  - `links_replace(source_id, edges: ResolvedEdge[])` — delete-then-insert D's outbound rows; called inside the write tx.
  - `links_resolve_dangling(repo_id, path, document_id)` — bind waiting danglers when a doc appears at `path`; cheap indexed UPDATE.
  - `links_clear(source_id)` — on delete.
  - Query-support reads used by the compiler are pure SQL joins, not methods (they live in the compiled `versions_search` fragment) — but backfill/stale need `links_by_src(document_id)` and a live-path resolver.
- Resolution half of `resolve.ts`: given normalized targets, look up `version_current(repo_id, path)` → `document_id` (or null = dangling).
- Kernel wiring: in `src/kernel/kernel.ts` `docs.create` / `docs.put` / `docs.delete` tx closures (`kernel.ts:437`, `:503`, `:580`), after `version_insert`, extract + resolve + `links_replace` **inside the same `storage.tx`**. On create / move-into-a-referenced-path / restore, also call `links_resolve_dangling`. `docs.delete` calls `links_clear`. This replaces "extract on the backlog worker" (§5 decision) — link extraction has no external I/O, so in-tx is safe and gives read-your-writes (unlike the FTS *trigger*, extraction is in TS, so it rides the kernel tx, not a SQL trigger).
- `backfill.ts`: synchronous — walk `versions_live_by_repo`, extract+resolve+replace each, then one dangling sweep. Shared by `mrplex links backfill` and link-config-change re-extraction.
- **Acceptance:** `links-maintenance.test.ts` green — put/move/delete replace outbound correctly; move produces zero inbound churn (same `document_id`); create/move-in/restore binds danglers; deleted docs' inbound edges survive but are excluded from live queries; backfill rebuilds a corpus + binds danglers; kernel suite green on both adapters.

### WS4 — CEL compiler: `$*_static` predicates and collections (L, highest risk)
- `graph-ast.ts`: structural recognizers over the mangled AST (`__mrplex_i_in_static` etc. — the `cel-parse.ts:30` preprocessor already turns `$in_static("x")` into a function call and `$backlinks_static()` into a zero-arg call). Detect: (a) glob-predicate calls `$in_static`/`$has_static` with 1–2 string args; (b) collection calls `$backlinks_static()`/`$links_static()` as comprehension `iterRange` or `size()` argument.
- Extend `compileCall` in **both** `compile-sqlite.ts` (`:187`) and `compile-postgres.ts`:
  - `$in_static(glob [,field])` → `EXISTS (SELECT 1 FROM links l JOIN versions src ON l.source_id = src.document_id WHERE src.next_id IS NULL AND <src path matches glob> AND l.target_id = versions.document_id [AND l.field = ?] AND <scope predicate on src>)`. `$has_static` is the mirror (swap src/target). Glob → regex via the existing `globToRegexSource` path (scope filter already uses `regexp()` on SQLite / `~` on Postgres).
  - `$backlinks_static()` / `$links_static()` as a **collection**: extend `compileSize` (`:376`) so `size($backlinks_static())` → `(SELECT COUNT(*) FROM links l ... WHERE ...)`; extend `compileComprehension` (`:435`) so `.exists(d, pred)` / `.all(d, pred)` iterate the joined *other-document* versions, compiling `pred` against that document's frontmatter/intrinsics (the iter-var substitution machinery at `:583` generalizes from `json_each` rows to a joined `versions` alias).
  - **Field restriction** = the optional 2nd arg → `AND l.field = ?` (or `l.field = '$body'` for the sentinel). `_dyn` rejection: a field arg is only legal on `_static` (bare/`_dyn` don't exist yet anyway → `filter_invalid`).
  - **Scope**: the subquery's `src`/`target` versions carry the same scope predicate the outer `SearchPlan.scope` compiles to (§8.2) — factor the scope-fragment builder so the graph subquery reuses it. This is what makes "visible graph = readable graph" true.
- Bare `$in` / `$has` / `$backlinks` / `$links` (no suffix) → `filter_invalid` with "reserved for Phase 2, use `$in_static` etc." (keeps Phase 2 bare-name semantics unpolluted).
- **Acceptance:** `links-graph.test.ts` green on **both** adapters (parity is the referee): membership, set difference/intersection/union, `!$in_static("**")` orphan, `.size() == 0` leaf, `.exists`/`.all` over target fields, field-argument forms, `$body` restriction, scope-drop (a caller who can't read the source/target sees no edge). `compile-postgres` cases mirror `compile-sqlite` case-for-case (M5 precedent, `$n` numbering discipline).

### WS5 — `links.stale` + `mrplex links repair` (M)
- `stale.ts`: `links.stale(repo)` kernel read — join `links` to the target's current version; emit rows where `target_id IS NOT NULL` and the resolved target's current `path` (+ elision rules) doesn't match `target_raw`'s written form. Repo-scoped, scope-filtered.
- `repair.ts` + kernel op: walk the stale list; for each source doc, rewrite the stale link text to the target's current path and issue an optimistic `docs.put` under the caller's token; report `{ repaired, skipped, conflicts }`. Conflicts (`stale_prev`) are reported and skipped, never forced.
- CLI: `mrplex links stale --repo <slug>` (list) and `mrplex links repair --repo <slug> [--dry-run]`. Both local and `--server` modes.
- **Acceptance:** `links-repair.test.ts` green — a move makes link text stale; `links.stale` finds it; `repair` rewrites it as a normal authored version; a concurrent edit surfaces as a reported conflict, not a clobber; `--dry-run` writes nothing.

### WS6 — CLI / surface wiring (S)
- `mrplex links backfill --repo <slug>` (WS3), `links stale`, `links repair` (WS5). `mrplex query --filter '$in_static(...)'` already works through the existing filter path — no new query flag in Phase 1 (the `--in` operator is Phase 2). REST/MCP need no new endpoints (the filter rides `QuerySpec.filter`); confirm the graph intrinsics pass through the existing `query` route / `docs_query` tool unchanged.
- **Acceptance:** CLI commands work local + remote; existing query surfaces accept graph filters with no wiring changes; `cli.test.ts` / `cli-query.test.ts` extended.

### WS7 — Tests + parity (M)
- Extraction unit matrix (WS2), maintenance integration (WS3), graph-query parity (WS4), repair (WS5).
- Parity additions to `test/kernel-suite.ts`: graph-query cases run on both adapters; a dangling-then-bind case; a scope-drop case; a move-no-churn case.
- **Acceptance:** `npm test` (SQLite) green; `MRPLEX_TEST_POSTGRES_URL=… npm test` green on both adapters; no adapter-specific graph behavior outside the compilers.

### WS8 — Docs amendments (S)
- `design.md`: promote §11.2 from "design sketch" / §11 future-work bullet to a shipped section (or add a §-marker noting Phase 1 shipped on branch `links`); add a §10 milestone line; §9 decision-log entries (in-tx synchronous extraction vs. worker; CommonMark parser dependency; identity-bound resolution; `_static`-only Phase 1 with reserved bare names; link-config cascade; scope-respecting graph subqueries). Update the §11 "Computed frontmatter" bullet's `$outgoing_links` "(once §11.2 lands)" caveat if it now can land.
- `README.md`: `link_config` per-repo override, `mrplex links backfill|stale|repair`, the `$*_static` filter vocabulary with the MOC set-algebra examples.
- **Acceptance:** no doc still calls §11.2 purely "deferred"/"sketch" for the Phase-1 surface; README documents the shipped commands and filter syntax.

## 4. Sequencing

```
WS0 plan ─► WS1 schema+config ─► WS2 extraction ─► WS3 storage+kernel+backfill ─► WS4 compiler ─► WS7 tests/parity ─► WS8 docs
                                                          WS5 stale+repair ──┘ (after WS3 resolution)
                                                          WS6 CLI wiring ────┘ (after WS3/WS5 ops exist)
```

WS1–WS2 are self-contained and land as independent green commits before any kernel wiring. WS3 is the integration keystone (extraction meets the write path); WS4 is the highest-risk (dual-adapter compiler + scope). Scaffold the WS7 parity harness early inside WS4 so the graph compiler is developed suite-first (the M5 discipline). WS5/WS6 depend only on WS3's resolution + storage methods.

## 5. Design decisions to pin (record in the decision log, design.md §9)

1. **Synchronous in-transaction extraction, not the backlog worker.** §11.2 says "extracted by the same post-write worker," but that wording predates the observation that link extraction — unlike embedding (§5.3) — has **no external I/O**: it's pure CPU over `body` + `frontmatter`. So the reasons embedding is async (never fail a write, dedup, exponential backoff, model changes) don't apply. Running extraction inside the version-insert `tx` (the kernel closures at `kernel.ts:437/:503/:580`) buys read-your-writes graph consistency — a `query` immediately after a `docs.put` sees the new edges, and tests/CLI don't race a worker. The FTS *trigger* (`0003_fts_docs.sql`) is the "in-tx derived index" precedent; links ride the kernel tx instead of a SQL trigger only because extraction is TS, not SQL. **Rejected alternative:** enqueue + drain on the existing worker (matches §11.2's literal "worker" wording, reuses backlog infra) — rejected because eventually-consistent backlinks create a read-your-writes gap with no compensating benefit here. *Update §11.2's "worker" language to "in the write path" for extraction; the worker still owns config-change re-extraction and backfill.*
2. **A real CommonMark parser is a dependency, not a regex.** Add `micromark` (recommended: small, spec-conformant, token-stream API that skips code spans/fences by construction) or `markdown-it`. Correctness of "links in code fences aren't links," reference-link resolution, and treating an `!`-embed as an ordinary edge (not a special type) justifies the dep — the same reasoning that took `@bufbuild/cel` over a hand-rolled parser. Wikilinks + frontmatter fields layer on top. **Pin the exact package in WS2.**
3. **`_static`-only Phase 1; bare names reserved and erroring.** Ship `$in_static`/`$has_static`/`$backlinks_static()`/`$links_static()` (incl. field args). Bare `$in`/`$has`/`$backlinks()`/`$links()` return `filter_invalid` ("reserved for Phase 2") rather than aliasing to static — so Phase 2's union semantics are stable from birth (§11.2 "Phasing" is explicit that bare-name meaning must not shift). *This is the design's stated intent; pinned here against the temptation to make bare names "just work" now.*
4. **Per-repo `link_config` storage shape.** Either a new `link_config` JSON column on `repos` or fold into existing per-repo config. Decide in WS1 by reading how `path_config` is stored/plumbed (`repos.path_config`, `parseRepoOverride`) and matching it. Lean: mirror `path_config` exactly (own JSON column + `set_link_config` op) for symmetry.
5. **Scope-respecting graph subqueries.** The compiled `$*_static` subqueries must apply the caller's read-scope predicate to both source and target versions (§11.2 "Scope interaction"). Factor the `SearchPlan.scope` → SQL fragment builder so the graph subquery reuses it verbatim on both adapters. *Pin: no graph predicate may reveal an edge whose source or target the caller couldn't read directly.*
6. **Dangling re-resolution runs in the write tx too.** `links_resolve_dangling(repo_id, path, document_id)` on create / move-in / restore is a cheap indexed UPDATE, so it rides the same tx — no separate pass except in backfill. *Pin the invariant: after any write, the index is fully consistent with the live corpus (no eventual-consistency window).*
7. **`syntaxes` merges whole-object, not per-key (open sub-decision, lean whole-object).** The cascade is replace-not-merge per top-level field (`path-config` semantics). The question is whether `syntaxes` is one field (an override must restate every syntax it wants on) or whether its keys merge individually. **Lean: whole-object replace**, for symmetry with `path-config` and one merge rule everywhere — but it's a real foot-gun (`{ "syntaxes": { "wikilink": true } }` silently disables the other three). *Decide in WS1; if per-key wins, document it as the one place the cascade deep-merges and gate it in `validateConfig`.*

## 6. Definition of done

```bash
# Extraction + index build
mrplex bootstrap --database sqlite:./dev.db
mrplex repos create notes
mrplex docs put notes moc/employees.md --body '- [[alice]]
- [[bob]]'
mrplex docs put notes alice.md --frontmatter 'parent: moc/employees.md' --body 'see [horses](../horses.md)'
mrplex links backfill --repo notes            # or automatic on write

# Graph queries — static set algebra (§11.2)
mrplex query --repo notes --filter '$in_static("moc/employees.md")'          # alice, bob
mrplex query --repo notes --filter '$in_static("moc/**") && !$in_static("moc/contractors.md")'
mrplex query --repo notes --filter '$has_static("horses.md")'                # alice (dangling target ok)
mrplex query --repo notes --filter '$has_static("moc/employees.md", "parent")'  # field-restricted
mrplex query --repo notes --filter '$links_static().size() == 0'             # leaf nodes
mrplex query --repo notes --filter '!$in_static("**")'                       # orphans
mrplex query --repo notes --filter '$backlinks_static().exists(d, d.status == "draft")'

# Reserved bare names error clearly (Phase 2)
mrplex query --repo notes --filter '$in("x")'   # → filter_invalid: reserved for Phase 2, use $in_static

# Identity survives rename; text goes stale; repair fixes text
mrplex docs move notes alice.md people/alice.md
mrplex query --repo notes --filter '$in_static("moc/employees.md")'          # still includes alice (identity-bound)
mrplex links stale --repo notes                                              # employees.md's [[alice]] text is stale
mrplex links repair --repo notes                                             # rewrites as normal authored versions

# Parity
npm test                                          # SQLite: all green
MRPLEX_TEST_POSTGRES_URL=postgres://… npm test    # both adapters, one suite
```

Invariants: shared kernel suite green on both adapters; graph filters compile on both dialects with byte-parity test coverage; the index is fully consistent with the live corpus after every write (no eventual-consistency window); moves produce zero inbound edge churn; deleted docs' inbound edges persist but never surface in live-namespace queries; a caller never sees a graph edge whose endpoints they couldn't read directly; bare intrinsic names remain unimplemented (reserved) so Phase 2 union semantics stay clean; only new runtime dep is the CommonMark parser.

## 7. Key risks

- **CommonMark edge cases pollute the graph.** Links in code fences, reference-link forward references, nested/escaped brackets, autolink vs. inline ambiguity. *Mitigation:* real parser (decision 2) + an extraction unit matrix that is the correctness referee; treat extraction as a pure function with exhaustive fixtures.
- **Compiler parity drift between SQLite and Postgres** (the M5 lesson). Graph subqueries add `COUNT`/`EXISTS`/comprehension shapes on top of the existing filter compiler. *Mitigation:* mirror every `compile-sqlite` graph case in `compile-postgres`; the shared suite runs both; watch `$n` numbering (PG) and param duplication (SQLite) exactly as m5-plan §7 warned.
- **Scope leak through graph predicates.** A subquery that forgets the scope filter reveals edges to/from unreadable docs — a real confidentiality bug, not just a wrong result. *Mitigation:* decision 5 (shared scope-fragment builder) + an explicit scope-drop parity test that fails loudly if an edge crosses a read boundary.
- **Comprehension generalization.** `.exists`/`.all` currently iterate `json_each` rows (`compile-sqlite.ts:435`); graph collections iterate joined `versions`. The iter-var substitution (`:583`) must compile the predicate against the *other* document's columns without silently falling through to the current row's frontmatter. *Mitigation:* extend the existing "member access on iter-var" guard (`:614`) to the graph case; reject unsupported shapes rather than mis-compile.
- **Dangling re-resolution correctness on move/restore.** A doc moving *into* a path that had danglers must bind them; a doc moving *out* must not leave false binds (identity-bound edges are fine, but `target_raw`-keyed danglers are path-keyed). *Mitigation:* `links-maintenance.test.ts` covers create/move-in/move-out/delete/restore explicitly; the invariant "index consistent after every write" is the assertion.
- **In-tx extraction cost on large documents.** Parsing a huge body inside the write tx lengthens the transaction. *Mitigation:* extraction is linear and bounded; if it becomes a problem the worker path (rejected in decision 1) is the escape hatch — but measure before moving, and note SQLite's single-writer model already serializes writes.
- **Link-config change = repo-wide re-extraction.** A config edit re-parses every live doc. *Mitigation:* run it on the backfill path (WS3), not synchronously in the config-write request; same shape as `embed backfill`.
