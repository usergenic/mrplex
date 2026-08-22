# Case & Unicode Folding Implementation Plan — Case-Insensitive Path & Slug Identity

Target: the deferred **"Case and Unicode path policy"** item from [design.md §11](design.md): *"A per-repo option for case-insensitive path uniqueness and Unicode normalization (NFC)… it needs a normalized shadow column with its own unique partial index, so it's a deliberate schema decision, not a toggle."* This branch promotes that from future-work to shipped, and — per the decisions pinned in §5 — makes it the **global default** (no per-repo toggle) rather than an opt-in.

Today paths and slugs are **case-sensitive, byte-compared, unnormalized** (§3.5.1; decision-log line at design.md:1030). That means `Alice.md` and `alice.md` are distinct documents, `[[alice]]` can't reliably find `Alice.md`, and a macOS client emitting NFD (`café`) creates a document a Linux client's NFC (`café`) can't address. This branch makes identity **case-insensitive and Unicode-normalized**, while keeping storage **case- and form-preserving** (we store exactly what the author wrote, so the §3.2 byte-exact round-trip is untouched). It is a prerequisite for the `links` branch: wikilink resolution (`[[alice]]` → `Alice.md`) needs a coherent, non-arbitrary answer, which only exists once uniqueness is case-insensitive.

The load-bearing mechanism: a derived **normalized key** computed **in the kernel** (JS `String.prototype.normalize("NFC")` + case folding), stored in a shadow column with its own unique partial index, and used for every uniqueness check and by-path/by-slug lookup. Normalization lives in the kernel — not a SQL `lower()` — because SQLite's `lower()` is ASCII-only (no ICU by default) while Postgres's is locale-aware, so a functional index would silently diverge and break the §7.2 adapter-parity guarantee.

Branch `case-folding` is cut from `main`.

## 1. Scope

**In:**

- **Case-insensitive, Unicode-normalized identity for paths** (§3.5.1 amendment). Two documents whose paths fold to the same normalized key cannot both be live in a repo — `create` of `alice.md` when `Alice.md` is live raises `create_conflict`; a `put`/move onto a folding-equal occupied path raises `path_taken`. Enforced at the storage engine by a unique partial index on the normalized key (mirroring the existing `versions_repo_path_current_uidx`), not just in kernel logic.
- **Case-insensitive, Unicode-normalized identity for slugs** — `repos.slug` and `users.slug`. `repos.create "Notes"` then `repos.create "notes"` → `slug_taken`; likewise users. Enforced by a unique index on a normalized-slug column.
- **Case-insensitive lookups** — every by-path/by-slug resolution folds the query key: `version_current`, `repos_by_slug`, `users_by_slug`. `docs.get notes Alice.md` finds the document authored at `alice.md`; `repos.get NOTES` finds `notes`. Returned rows carry the **stored** (case-preserved) path/slug, never the folded key.
- **Case- and form-preserving storage.** `versions.path`, `repos.slug`, `users.slug` keep the author's exact bytes. The normalized key is a *derived* column alongside, never surfaced on the wire. `frontmatter_raw` + body are wholly untouched — the §3.2 round-trip and all ETag/`$version` semantics stand.
- **Kernel-side normalization** (§5 decision 3). A single `normalizeKey(s: string): string` in a new `src/kernel/casefold.ts` — `s.normalize("NFC")` then Unicode case fold — is the one authority. Both adapters receive the pre-computed key from the kernel on write and the folded query key on read; neither adapter calls `lower()`/`citext`/`collate`. This is what holds SQLite⇄Postgres parity.
- **Normalized key spans path segments as a whole string**, computed after path validation, on the already-assembled repo-root-relative path. Slugs are single segments. The normalizer is applied to the whole path string (not per-segment) — `/` is ASCII and fold-invariant, so segment boundaries survive.
- **Migration + backfill.** New nullable `path_norm` on `versions`, `slug_norm` on `repos`/`users`; a backfill pass computes keys for existing rows; then the unique partial indexes are created. **The migration surfaces pre-existing collisions loudly** (two live rows folding equal) rather than silently dropping one — see §5 decision 5 and §7.
- **Adapter parity.** Both SQLite and Postgres store + index + query the normalized key identically (kernel supplies it); the shared kernel suite (§7.2) is the referee.

**Out (deliberately):**

- **Per-repo policy / byte-exact opt-out** (§11's original framing). §5 decision 2 pins case-insensitive as the *global default* with no toggle — the schema always populates the normalized key, lookups never branch on a repo mode. A future byte-exact-mode option is additive (it would make the unique index conditional), but nothing here builds the toggle machinery.
- **Case-insensitive scope-glob matching** (auth surface). `slugMatchesPattern` / `pathMatchesGlobs` (`src/kernel/auth/glob.ts`) govern **read/write authorization**, not identity. Folding them could silently *widen* a caller's granted scope (`read: ["Secret/**"]` suddenly matching `secret/…`). Left byte-sensitive in this branch; called out as an open question in §5 decision 6 so it's a conscious defer, not an oversight.
- **Normalizing frontmatter values or CEL filter comparisons.** `$path == "Alice.md"` still compares against the stored path byte-wise (filters see reality). Only *identity* (uniqueness + by-key lookup) folds. Frontmatter-field link resolution (the `links` branch) resolves through the same `version_current` path lookup, so it inherits folding for free without touching the filter compiler.
- **Retroactive rewriting of existing paths/slugs** to a canonical case. Storage stays as-authored; we add keys, we don't rewrite history.
- **Collation-based DB solutions** (`COLLATE NOCASE`, `citext`, `lower()` indexes). Explicitly rejected — they diverge across engines on non-ASCII (§5 decision 3).

## 2. Repo layout — what this branch adds/changes

```
src/
  kernel/
    casefold.ts                     # normalizeKey(s) = NFC + case fold; the single authority
    casefold.test.ts                # ASCII, accented (NFC/NFD), ß/ligature/final-sigma per decision 4
  storage-sqlite/
    migrations/
      0004_casefold.sql             # path_norm / slug_norm columns, backfill, unique partial indexes
  storage-postgres/
    migrations/
      0002_casefold.sql             # PG dialect of the same
test/
  casefold.test.ts                  # kernel-suite additions run on both adapters (see WS5)
```

Changed files (surface mapped during planning):
- `src/kernel/validation.ts` — no rule changes, but path/slug validation stays byte-level; normalization happens *after* validation in the kernel write path.
- `src/kernel/kernel.ts` — `docs.create` / `docs.put` / `docs.delete`, `repos.create/rename/delete`, `users.create/rename`: compute `normalizeKey` and pass it to storage; conflict pre-checks fold the key.
- `src/storage/types.ts` — `VersionInsertInput` gains `path_norm`; `version_current(repo_id, path_norm)` keys on the normalized value; `repos_create`/`repos_rename`/`users_create`/`users_rename` take a `slug_norm`; `repos_by_slug`/`users_by_slug` key on `slug_norm`. Row types keep the stored `path`/`slug`.
- `src/storage-sqlite/adapter.ts`, `src/storage-postgres/adapter.ts` — persist + query the norm columns; map the norm-index unique violation (SQLite `SQLITE_CONSTRAINT`, PG `23505`) to the same `create_conflict`/`path_taken`/`slug_taken` kernel errors the current path/slug indexes already map.

**Tooling additions (runtime deps):** depends on §5 decision 4.
- **If "NFC + `toLowerCase()`"** (recommended pragmatic default): **zero new deps** — both are in the JS stdlib. Covers all accented Latin/Greek/Cyrillic and the 99% case; does NOT fold ß→ss, ﬁ→fi, or final-sigma ς→σ.
- **If "full Unicode default case fold"**: a small casefold-table dependency (e.g. a maintained `fold-case`/`unicode-case-fold` package, or generating the fold map from Unicode `CaseFolding.txt` at build time into a static table). Chosen only if the ß/ligature cases matter enough to justify the dep + its Unicode-version maintenance.

## 3. Workstreams (attack order)

### WS0 — Write docs/case-folding-plan.md
This document, following the m0–m5 skeleton. Committed as the first commit of the PR branch. **Acceptance:** scope reviewed before code.

### WS1 — `casefold.ts` + the normalization decision (S, but decision-gated)
- `normalizeKey(s: string): string`. Pin the algorithm per §5 decision 4. Contract: idempotent (`normalizeKey(normalizeKey(x)) === normalizeKey(x)`), total, pure, stable across Node versions for the chosen strength.
- `casefold.test.ts`: ASCII (`Alice`→`alice`); accented NFC vs NFD equality (`café` written both ways folds equal); Turkish-I caveat documented (we use invariant fold, not locale — `I`→`i`, dotless-ı left as-is); and, if full-fold chosen, `Straße`≡`STRASSE`, `ﬁle`≡`file`, final-sigma. If pragmatic fold chosen, tests **assert the known non-folds** so the boundary is explicit and intentional.
- **Acceptance:** unit tests green; the chosen strength is documented in-file with examples of what does and doesn't fold.

### WS2 — Schema: norm columns, backfill, unique indexes (M, migration-critical)
- `0004_casefold.sql` (SQLite) / `0002_casefold.sql` (PG):
  1. Add nullable `versions.path_norm text`, `repos.slug_norm text`, `users.slug_norm text`.
  2. **Backfill is kernel-driven, not SQL-driven** (the normalizer is JS — a SQL `UPDATE … lower()` would compute the wrong key and defeat the whole design). So the migration adds the columns only; a follow `migrate()`-time or `mrplex` bootstrap step computes keys. *Decision to pin in WS2:* either (a) migration adds columns, and a kernel backfill routine (run at open, idempotent, like the links backfill shape) populates + then a second migration adds the unique index once populated; or (b) a one-shot `mrplex migrate-casefold` command. Lean (a) with a guard that refuses to create the unique index if any collision exists.
  3. Unique partial indexes mirroring the existing ones:
     - `versions_document_current_uidx` stays; add `versions_repo_pathnorm_current_uidx on versions(repo_id, path_norm) where next_id is null`.
     - `repos_slugnorm_uidx on repos(slug_norm)`, `users_slugnorm_uidx on users(slug_norm)`.
- Register both migration dirs already handled by `copy-assets.mjs` glob; extend `migrations.test.ts` table/index assertions.
- **Acceptance:** migrations idempotent on both adapters; indexes present; a deliberately-seeded case-collision fixture makes index creation fail loudly (proving the guard).

### WS3 — Kernel write path: compute + enforce the key (M–L, delicate)
- On `docs.create`/`docs.put`/`docs.delete`: after `validatePath`, compute `path_norm = normalizeKey(path)`; pass into `version_insert`. Conflict pre-checks (`version_current`) fold the query key. The storage unique index is the real referee; kernel pre-checks are the friendly error.
- On `repos.create/rename/delete` + `users.create/rename`: compute `slug_norm`; the collision pre-checks (`repos_by_slug`, `users_by_slug`) fold; deletion-rename uniquifier loop folds too.
- Storage adapters: persist norm columns on insert/rename; `version_current`/`repos_by_slug`/`users_by_slug` query by norm key; map norm-index unique violations to `create_conflict`/`path_taken`/`slug_taken` (extend the existing 23505/SQLITE_CONSTRAINT mapping that today keys off the path/slug indexes).
- **Acceptance:** kernel suite green on both adapters; new cases (below) green; returned rows always carry the stored (case-preserved) path/slug.

### WS4 — By-key lookups return case-preserved rows (S)
- Verify every read surface (`docs.get`, `repos.get`, `users`—CLI/REST/MCP) folds the *lookup* key but surfaces the *stored* value. `docs.get notes Alice.md` → returns the doc at stored path `alice.md`, `$path` reads `alice.md`, ETag unchanged.
- **Acceptance:** CLI/REST/MCP round-trips: fetch by a differently-cased path/slug returns the canonical stored row; no wire field ever exposes `*_norm`.

### WS5 — Tests + parity (M)
- `test/casefold.test.ts` folded into the kernel suite (both adapters):
  - create `Alice.md`, create `alice.md` → `create_conflict`.
  - move onto a folding-equal live path → `path_taken`.
  - `repos.create Notes` then `notes` → `slug_taken`; same for users.
  - NFC/NFD: create `café.md` (NFC), get `café.md` (NFD) → same doc.
  - lookup returns stored case (`docs.get NOTES ALICE.md` → path `alice.md`).
  - delete then recreate with different case reuses the freed key.
  - scope-glob remains byte-sensitive (guard for decision 6): `read:["Secret/**"]` does NOT grant `secret/x.md`.
- **Acceptance:** `npm test` green (SQLite); `MRPLEX_TEST_POSTGRES_URL=… npm test` green on both; parity holds on non-ASCII fixtures.

### WS6 — Docs amendments (S)
- design.md: amend §3.5.1 (paths/slugs are now case-insensitive + NFC-normalized for *identity*, case/form-preserving in *storage*); update decision-log line at :1030 and the §11 "Case and Unicode path policy" bullet (mark shipped, global default not per-repo); add §9 decision-log entries (kernel-side normalization for parity; global default; chosen fold strength; scope-glob left byte-sensitive). Note the §3.2 round-trip is unaffected.
- README: one-line "paths and slugs are case-insensitive (Unicode NFC + case fold); storage preserves the case you write."
- **Acceptance:** no doc still claims byte-exact case-sensitive identity; the fold strength and its boundaries are documented.

## 4. Sequencing

```
WS0 plan ─► WS1 casefold.ts ─► WS2 schema+backfill ─► WS3 kernel write path ─► WS4 lookups ─► WS5 tests/parity ─► WS6 docs
```

WS1 is decision-gated (the fold-strength fork) but tiny. WS2 is the migration keystone (collision guard is the risky part). WS3 is the delicate integration. Scaffold WS5's collision + NFC fixtures early inside WS2/WS3 so the enforcement is developed test-first.

## 5. Design decisions to pin (record in the decision log, design.md §9)

1. **Case-insensitive identity, case-preserving storage.** Store the author's exact bytes; fold only for uniqueness and by-key lookup. Rationale: preserves the §3.2 byte-exact round-trip and authorial intent (macOS/APFS + Obsidian model), while giving coherent identity. *Rejected:* canonicalizing stored paths to lowercase (loses author intent, churns existing corpora).
2. **Global default, no per-repo toggle.** §11 framed it as a per-repo option; we ship it as the one behavior. Rationale: user's explicit call ("mrplex should be case-insensitive"); simpler schema (norm key always present, lookups never branch). A byte-exact-mode opt-out remains additive if ever needed.
3. **Kernel-side normalization, never SQL `lower()`/collation.** The one `normalizeKey` in JS feeds both adapters. Rationale: SQLite `lower()` is ASCII-only without ICU; PG `lower()` is locale-aware — a functional index would diverge and break §7.2 parity. This is *why* §11 called it "a deliberate schema decision, not a toggle." *Rejected:* `COLLATE NOCASE` (SQLite, ASCII-only), `citext` (PG-only, no SQLite twin).
4. **Fold strength `[OPEN]` — pin in WS1.** Options: **(a) NFC + `toLowerCase()`** — zero deps, covers accented Latin/Greek/Cyrillic, misses ß→ss / ligatures / final-sigma; **(b) full Unicode default case fold** — a casefold table (dep or build-time-generated), handles ß et al. *Recommendation: (a)* for v1 — it's the 99% case, dependency-free, and (b) is a clean additive upgrade later (the key is recomputed by a backfill). Whichever is chosen, `casefold.test.ts` asserts the exact boundary. **Always uses the locale-invariant fold** (not `toLocaleLowerCase`) so the Turkish-I problem can't make identity locale-dependent.
5. **Migration surfaces pre-existing collisions loudly.** A corpus created under byte-exact rules may already hold `Alice.md` + `alice.md` live in one repo (or `Notes`+`notes` repos). The unique-index creation must **fail with an actionable report** listing the colliding rows, not silently drop or merge. Rationale: silently picking a winner destroys data in an append-only store. Operators resolve collisions (rename one) then re-run. *Pin the invariant:* migration is safe to re-run and never loses a row.
6. **Scope-glob matching stays byte-sensitive `[OPEN]`.** `slugMatchesPattern`/`pathMatchesGlobs` govern authorization, not identity; folding them could widen granted scope. Deferred with a guard test. *Open:* whether a later pass makes scope globs fold too (consistency) or keeps them exact (least-privilege). Flagged so the asymmetry — identity folds, authz doesn't — is a conscious choice.
7. **Normalized key is derived and never on the wire.** `path_norm`/`slug_norm` are internal like integer ids (§3.3). No REST/MCP/CLI field exposes them; the CEL `$path` intrinsic reads the stored `versions.path`, not the key. *Pin:* the normalized key is an index artifact, not addressable state.

## 6. Definition of done

```bash
mrplex bootstrap --database sqlite:./dev.db
mrplex repos create notes

# Case-insensitive path identity
mrplex docs create notes Alice.md --body 'hi'
mrplex docs create notes alice.md --body 'no'   # → create_conflict (folds equal)
mrplex docs get notes ALICE.md                  # → the doc at stored path "Alice.md"
mrplex docs get notes ALICE.md --json | grep '"path"'   # → "Alice.md" (stored case, not folded)

# Unicode NFC/NFD identity
mrplex docs create notes 'café.md' --body 'x'   # authored NFC
mrplex docs get notes $'café.md'          # NFD query → same document

# Case-insensitive slugs
mrplex repos create Notes                        # → slug_taken ("notes" exists)
mrplex --as alice ...                            # user slug folding likewise

# Parity
npm test                                         # SQLite: all green
MRPLEX_TEST_POSTGRES_URL=postgres://… npm test   # both adapters, one suite

# Migration safety on a colliding corpus
#   (seed Alice.md + alice.md live, then migrate) → fails loudly, lists the pair, loses nothing
```

Invariants: shared kernel suite green on both adapters; identity folds (uniqueness + lookup) while storage preserves author bytes; `frontmatter_raw`/body/ETag/`$version` byte-exact round-trip unchanged; no wire field exposes `*_norm`; normalization is kernel-side only (no `lower()`/collation in any adapter); the migration is re-runnable and never drops a row; scope-glob authz remains byte-sensitive (guarded).

## 7. Key risks

- **Pre-existing case collisions in a live corpus.** The scariest case — two live rows folding equal before the unique index exists. *Mitigation:* decision 5 — index creation guarded by a collision scan that fails with a row-list; migration re-runnable; documented operator remedy (rename one). A dry-run reporter (`mrplex casefold check`) is a nice-to-have.
- **Adapter parity on non-ASCII.** The whole reason for kernel-side normalization. *Mitigation:* parity fixtures with accented + (if full-fold) ß/ligature inputs run on both adapters; zero `lower()`/`collate`/`citext` anywhere — grep-guarded in review.
- **NFC/NFD round-trip subtlety.** We normalize the *key* to NFC but store the author's original bytes (which may be NFD). A lookup must normalize its query key the same way. *Mitigation:* `normalizeKey` is the single authority for both write and read; a test writes NFD and reads NFC (and vice-versa).
- **Turkish-I / locale folds.** `toLocaleLowerCase("tr")` maps `I`→`ı`, making identity locale-dependent. *Mitigation:* decision 4 mandates locale-invariant fold; a test pins `I`→`i` regardless of host locale.
- **Idempotency of backfill.** Re-running the key computation must be a no-op. *Mitigation:* `normalizeKey` idempotent by contract + test; backfill writes only where `*_norm IS NULL` or differs.
- **Interaction with the deletion namespace.** Deletion renames a path into `:deleted-…` (system sigil). The norm key of a deleted path must not collide with a live path's key (it won't — different strings — but the partial index `where next_id is null` already scopes uniqueness to live rows, so deleted rows are exempt). *Mitigation:* a test deletes `Alice.md` then creates `alice.md` → succeeds (freed key).
