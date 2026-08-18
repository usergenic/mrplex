# M1 Implementation Plan — Writes + Auth

Target: milestone **M1** from [design.md §10](design.md): *Full kernel write surface (`docs.create` / `docs.put` / `docs.delete`, plus `repos.create` / `users.create` and the `.rename` / `.delete` methods) with `prev_version_id` enforcement. `docs.put` handles both in-place update and move. Bearer-token auth (§8): `api_tokens` table, capability scopes, `authorize()` on every kernel op, `tokens.*` RPCs, bootstrap root token. CLI gains write commands and `tokens.*`.*

M1 turns the M0 walking skeleton into a **secure single-writer**: every kernel op runs under a real actor, every write goes through the optimistic-concurrency primitive from §4, and the delete-as-move-to-system-namespace scheme is what powers `docs.delete`, `repos.delete`, and `users.delete`. When M1 is done, the local CLI is still the only surface (M3 adds MCP + REST), but everything the surfaces will eventually expose is already implemented and enforced at the kernel.

## 1. Scope

**In:**

- Kernel write surface: `docs.create` / `docs.put` / `docs.delete` with `prev_version_id` enforcement, the "one verb several intents" folding of update/move/restore (§4.2), and the exact deletion path scheme from §3.4 (`<system-sigil>deleted/{path-without-ext}-v{version_id}.{ext}`).
- Repo & user writes: `repos.create` / `.rename` / `.delete` / `.set_path_config`, `users.create` / `.rename` / `.delete`. `.delete` is a system-namespace slug rename; `.delete` on users also revokes their tokens. All idempotent.
- Path config layering (§3.5): hardcoded defaults → server config → per-repo overrides; startup invariants enforced; `set_path_config` returns advisory `PathWarning[]` for currently-invalid paths.
- Slug + segment validation (§3.5.3, §3.5.6): the write-time gate. Sigil rules, disallowed chars, reserved segments, max length.
- Frontmatter duality on writes (§3.2): accept `frontmatter_raw` (YAML source) or `frontmatter` (structured JSON) — exactly one; derive the other; canonical YAML serialization when structured input arrives.
- Bearer-token auth: `api_tokens` table already exists from M0; add SHA-256 hashing, lookup middleware, `Actor` resolution, and a real `authorize()` replacing M0's allow-all stub. Every kernel op remains wrapped in `authorize()` — no call-site changes above what's already there.
- Scope grammar (§8.2): `ScopeInput` (slugs/globs) resolves to `Scope` (bound repo ids + `"*"` dynamic wildcard) at token creation. Gitignore-style path globs with `**`, `*`, `!`. Action nesting explicitly non-implied. System-namespace carve-out for delete/restore moves.
- Self-token management: users list/revoke their own tokens; create children whose `admin` bit and scopes are a **verbatim structural subset** of the parent's (design §8.2 — semantic glob subsumption deferred).
- Tokens kernel ops: `tokens.list` / `.create` / `.revoke`.
- Bootstrap command: `mrplex bootstrap` mints the root token on a fresh database and prints it once. Local CLI stores it via `mrplex config set-token`.
- CLI: write commands (`docs create` / `put` / `delete` / `mv`, `repos create` / etc., `users create` / etc., `tokens list` / `create` / `revoke`, `config set-token`, `bootstrap`, `login`), the auth exit code family (3), and the full error-family mapping (§7.3).

**Out (deliberately):**

- HTTP surfaces — REST and MCP land in M3. M1's CLI still talks in-process to the kernel against a local SQLite file. No `--server` flag yet.
- Query / CEL / FTS — M2.
- Embeddings — M4. The M1 kernel signature for `docs.put` etc. doesn't call the embedding worker; the queue table is still there from M0 but unused.
- Postgres adapter — M5.
- WebDAV, `as_of` reads, links/graph — all §11 post-v1.

## 2. Repo layout — what M1 adds

```
src/
  kernel/
    kernel.ts            # gains write surface + real authorize() wiring
    validation.ts        # NEW — slug + segment validation (§3.5.3, §3.5.6)
    path-config.ts       # NEW — layering (defaults → server → repo), startup checks
    deletion.ts          # NEW — deletion path builder (extension-aware, §3.4)
    auth/
      actor.ts           # existing — Actor grows real scopes
      authorize.ts       # NEW — the real check; replaces the M0 stub
      scope.ts           # NEW — ScopeInput → Scope resolution, glob matcher, subset check
      tokens.ts          # NEW — SHA-256 hash, secret generation, tokens ops
  storage/
    types.ts             # extend with tokens_* + repos_rename/delete/users_rename/delete
  storage-sqlite/
    adapter.ts           # implement the new interface methods
  cli/
    commands/            # split main.ts into per-noun modules once it grows past ~250 lines
    config.ts            # NEW — ~/.config/mrplex/config.toml load/save
    bootstrap.ts         # NEW — the bootstrap flow
    auth.ts              # NEW — resolve --token → Actor via kernel
scripts/
  seed.ts                # updated: now also creates a root token so CLI writes work post-seed
test/
  writes.test.ts         # NEW — end-to-end write flows (create, update, move, delete, restore)
  auth.test.ts           # NEW — token lifecycle, scope enforcement, subset checks
  path-config.test.ts    # NEW — layering + startup invariants
```

No changes to the schema; §3.2 was frozen in M0 including tables M1 needs (`api_tokens`, `embedding_backlog`).

**Tooling additions** (keep minimal):

- `nanoid` (or Node's built-in `crypto.randomBytes(32).toString("base64url")`) for token-secret generation.
- Nothing else — SHA-256 is `node:crypto`, YAML serialization is the existing `yaml` dep, glob matching we write ourselves (small, well-scoped).

## 3. Workstreams

### WS1 — Validation utilities

New `src/kernel/validation.ts`. Implements the two validation functions used everywhere writes happen:

- `validateSlug(slug, config): void` — §3.5.6 rules; throws `KernelError("slug_invalid", …)` with a specific reason.
- `validatePath(path, config): void` — §3.5.3, per segment. Structural checks (empty, `.`, `..`, no `//`) come first; then sigil-leading; then disallowed chars. Throws `KernelError("path_invalid", …)`.

The M0 grammar constants (`CURRENT_SEGMENT`, `PARENT_SEGMENT`, `EMPTY_SEGMENT`, `PATH_SEPARATOR`) already exist informally; formalize them in `validation.ts` as exported code constants.

Pure functions, exhaustively tested against the design's rules table. No storage.

### WS2 — Path config layering

New `src/kernel/path-config.ts`. Three tiers per §3.5.2:

- `HARDCODED_DEFAULTS` — the constants from §3.5.2.
- Server config — loaded at startup from a config file or env (`[OPEN]` shape; propose YAML at `~/.config/mrplex/server.yaml` or the flag `--config`).
- Per-repo override — read from `repos.path_config` JSON.

`effectiveConfig(repo): PathConfig` merges the tiers with **replace-not-merge** semantics per field (§3.5.2). Startup invariants (§3.5.2) run on server-config load and throw a `ConfigError` if violated — the server refuses to start. Same checks are run when `repos.set_path_config` accepts a per-repo override.

`repos.set_path_config` returns advisory `PathWarning[]` for live paths that fail the new config — the design already has the pattern; implement by scanning `versions where next_id IS NULL AND repo_id = ?` and re-validating each path. Cheap because it hits the live-path index.

### WS3 — Deletion path builder

New `src/kernel/deletion.ts`. Implements the deletion path scheme from §3.4:

```
"path/to/document.md" + v45129
  → ":deleted/path/to/document-v45129.md"
```

Rule for the extension: everything from the final segment's last `.`, but a leading dot doesn't count — so `README` → `README-v45129`, `.gitignore` → `.gitignore-v45129`, `notes/foo.tar.gz` → `notes/foo.tar-v45129.gz`.

Pure function, table-driven test cases across all the edge cases from the design (extensionless files, dotfiles, multiple dots, no path segments).

### WS4 — Auth foundation: tokens, hashing, actors

New `src/kernel/auth/tokens.ts` + storage methods.

- **Secret generation**: `randomBytes(32).toString("base64url")` for the raw token; a short public prefix (`mrplex_`) is user-friendly but the entire string is the secret — treated opaque.
- **Hashing**: `sha256(secret)` → hex. Deterministic (design §8.1). Stored as `secret_hash`.
- **Storage additions** (adapter contract):
  - `tokens_create({ user_id, secret_hash, label, admin, scopes_json, expires_at }): TokenRow`
  - `tokens_by_hash(hash): TokenRow | null` — the hot auth path; already indexed by `api_tokens.secret_hash unique`.
  - `tokens_list(user_id): TokenRow[]`
  - `tokens_revoke(id): TokenRow` — sets `revoked_at`.
  - `tokens_touch_last_used(id): void` — best-effort, non-transactional per §8.5.
  - `tokens_revoke_by_user(user_id): void` — used by `users.delete`.
- **Auth middleware** (kernel-level, not surface): `resolveActor(token: string): Actor | null`. Called by every surface after it extracts the bearer token; in M1 the CLI is the only surface, but the CLI still routes through this so M3 drops in unchanged. Missing/revoked/expired → `unauthorized`.

Actor shape becomes real: `{ user_id, scopes: Scope[], admin: boolean }`.

### WS5 — Scope grammar + glob matching + subset check

New `src/kernel/auth/scope.ts`.

- **`ScopeInput` → `Scope` resolution** at token creation: each `repo` pattern (slug, glob, list, or literal `"*"`) evaluates against the current `repos` snapshot; matched slugs' internal ids are stored. `"*"` stays as the dynamic wildcard (§8.2). Non-`"*"` patterns are creation-time snapshots.
- **Gitignore-style glob matcher** for path globs: `**` any subtree, `*` within-segment, `!pattern` negation. Small enough to hand-roll; unit-testable. Repo globs are simpler (no `/`, so just `*` wildcard). Do NOT depend on `micromatch` or `minimatch` — the semantics we want are narrow and the deps are heavy.
- **`authorize(actor, action, target)`** — the real check, replacing M0's allow-all stub:
  - `admin: true` short-circuits every action.
  - `read` / `write` walks `actor.scopes`, matching `target.repo` against bound repo ids (or `"*"`) and `target.path` against the action's globs.
  - **System-namespace carve-out** (§8.2): for moves where one endpoint has a system-sigil segment, scope is checked only on the user-territory endpoint. The kernel signals this to `authorize()` via a `{ move, source, destination }` target shape.
- **Subset check** for self-token creation (§8.2): decidable, conservative. Child's bound repo ids ⊆ parent's; every child path glob string appears **verbatim** in the parent's corresponding list. Semantic glob subsumption is `[OPEN]` and NOT attempted in M1.

`query`'s scope filtering (§8.2 — `read` globs as an implicit path filter, silently dropping out-of-scope rows) is deferred to M2's `kernel.query`. M1 exposes the same glob matcher `query` will reuse.

### WS6 — Kernel writes (docs)

The centerpiece. In `src/kernel/kernel.ts`:

- **`docs.create(actor, repo, path, {frontmatter | frontmatter_raw}, body)`**
  1. `authorize(actor, "write", { repo, path })`.
  2. `validatePath(path, effectiveConfig(repo))`.
  3. Canonicalize frontmatter: exactly one of `frontmatter` / `frontmatter_raw` (else `frontmatter_invalid`). If `raw`: parse to JSON (frontmatter_invalid on YAML error). If structured: serialize to canonical YAML into `frontmatter_raw`.
  4. Inside `storage.tx`: check no live doc at `(repo, path)` (else `create_conflict` with current version). `documents_create`; `version_insert` with `prev_id=null`.
  5. Return `Version` envelope.

- **`docs.put(actor, repo, prev_version_id, path, {frontmatter | frontmatter_raw}?, body?, actor)`**
  1. Resolve `prev` via `version_by_id`; must belong to `repo`. Not found → `version_not_found`.
  2. Determine intents (§4.2): same path = update, different user-territory path = move, prev under system sigil + destination in user territory = restore.
  3. Authorize both endpoints under `write` — with the system-namespace carve-out from WS5 for delete/restore moves.
  4. `validatePath(dest, effectiveConfig(repo))` — restore hits the user-territory path.
  5. Canonicalize frontmatter (as create). If both `frontmatter` fields omitted, carry over `prev`'s.
  6. Inside `storage.tx`: `prev` must still be current (§4.1 rule 1) — the M0 adapter's chain-advance handles this via the `document_id = ? and next_id is null` guard, which now surfaces as `stale_prev` with `{ current_version_id, current_path (redacted if outside scope), submitted_prev_version_id }` (§4.3).
  7. Destination-path conflict → `path_taken`.
  8. Return the new `Version`.

- **`docs.delete(actor, repo, prev_version_id, actor)`**
  1. Resolve `prev` — if already under a system sigil, **no-op** (§4.1 rule 4): return the current version unchanged.
  2. Otherwise: authorize `write` on `prev.path` (user-territory endpoint only per the carve-out).
  3. Compute the deletion path via WS3's `deletion.ts`.
  4. Kernel bypasses the "no writing at system-sigil paths" rule for its own move (documented in the code).
  5. Delegates to the same `version_insert` used by `docs.put`.

The `authorize()` on `docs.put` moves is where the design's "both endpoints match `write`" rule from §8.2 fires, minus the system-namespace carve-out. Test cases live in WS10.

### WS7 — Kernel writes (repos, users, tokens)

- `repos.create(actor, slug)` / `repos.rename(actor, slug, new_slug)` — `admin: true` gated. Validate the new slug via `validateSlug(slug, serverConfig)`. `slug_taken` on collision.
- `repos.delete(actor, slug)` — admin-gated; **idempotent**. Look up repo; if slug already system-namespaced, no-op. Else rename to `<system-sigil>deleted-{slug}-{uniquifier}` where the uniquifier is a short server-chosen suffix (proposal: hex of `randomBytes(3)` — 6 chars, 24 bits of entropy; the original "base32" proposal was dropped since Node ships no base32 encoder and hex satisfies the same properties with zero deps). Documents inside untouched.
- `repos.set_path_config(actor, slug, config | null)` — admin-gated. Validate the config against startup invariants; return `{ repo, warnings: PathWarning[] }`.
- `users.create / rename / delete` — admin-gated; `users.delete` also calls `tokens_revoke_by_user`. Idempotent.
- `tokens.list(actor)` — returns the caller's own tokens (never leaks other users'). Admin can call `tokens.list_all` `[OPEN]` if the need emerges.
- `tokens.create(actor, label, scopeInputs, expires_at?)` — resolves `ScopeInput` → `Scope` via WS5; enforces the child-subset rule against the caller's own token; hashes the freshly-generated secret; returns `{ token: plaintext, meta }` (plaintext appears only in this response).
- `tokens.revoke(actor, token_id)` — self-revoke works for any actor; revoking someone else's token requires `admin: true`.

### WS8 — Bootstrap

New `src/cli/bootstrap.ts`, exposed as `mrplex bootstrap --database URL`.

- Refuses to run if the database already has any users OR any tokens (safe by default; avoid accidental re-bootstrapping in prod).
- Runs the schema migration first (idempotent).
- Creates the `system` user (adapter-level).
- Mints an admin token with `{ admin: true, scopes: [{ repo: "*", read: "**", write: "**" }] }` — the design's canonical root token from §8.3.
- Prints the plaintext secret to stdout with a one-line explanation on stderr ("This is your root admin token. Store it now — it will not be shown again.")
- Exit code 0 on success; 1 if the database already contains users/tokens.

### WS9 — CLI writes + tokens + config

Extending `src/cli/main.ts` (splitting into `src/cli/commands/{docs,repos,users,tokens,config}.ts` if `main.ts` grows past ~250 lines).

New commands per §7.3:

```
mrplex bootstrap [--database URL]
mrplex config set-database URL
mrplex config set-token TOK             # writes to ~/.config/mrplex/config.toml (mode 600)
mrplex login                            # prompts; sugar for set-token

mrplex repos create <slug>
mrplex repos rename <slug> <new-slug>
mrplex repos delete <slug>
mrplex repos set-path-config <slug> [--from-file FILE | -] | --clear

mrplex users create <slug>
mrplex users rename <slug> <new-slug>
mrplex users delete <slug>

mrplex docs create <repo> <path> [--from-file FILE | -]
mrplex docs put <repo> <path> --prev <version-id> [--from-file FILE | -]
mrplex docs delete <repo> <path> --prev <version-id>
mrplex docs mv <repo> <from-path> <to-path> --prev <version-id>    # sugar: put to to-path, body unchanged

mrplex tokens list
mrplex tokens create --label LABEL --scope <slug>:read=<glob>,write=<glob>[,...] [--admin] [--expires TS]
mrplex tokens revoke <token-id>
```

- All writes go through the kernel; the CLI resolves `--token` (or `MRPLEX_TOKEN`, or config file) → `Actor` before dispatch.
- Exit codes: 3 for `unauthorized` / `forbidden`; 2 for `stale_prev` / `create_conflict` / `path_taken` / `slug_taken`; 1 for validation; 4 for not-found (unchanged from M0).
- Writes print the new `version_id` on stdout for scripting per §7.3; human context on stderr. `--json` returns the full `Version` envelope.
- `docs put` accepts `--from-file` reading a full Markdown file (frontmatter + body); CLI splits and submits `{ frontmatter_raw, body }` — keeping the M0 rule that clients never parse frontmatter client-side.
- `tokens create --scope` syntax: parsed into `ScopeInput[]`. `--scope notes:read=**,write=inbox/**` → `[{repo: "notes", read: ["**"], write: ["inbox/**"]}]`. Multiple `--scope` flags stack.

### WS10 — Tests + polish + PR

- **`test/path-config.test.ts`** — table-driven: startup invariants (prefix-shadowing rejection, disallowed_chars ∩ hidden_sigils, missing sigil lists), effective-config layering, warnings from `set_path_config`.
- **`test/writes.test.ts`** — end-to-end write flows via a real actor: `create` → `put` (update) → `put` (move) → `delete` → `put` (restore). Concurrency: parallel `docs.put` on same doc, one succeeds and the other gets `stale_prev` with the current version attached. Cross-document `prev` (already covered in M0 invariants but re-asserted at the kernel level).
- **`test/auth.test.ts`** — token lifecycle, SHA-256 determinism, revoke doesn't invalidate historical `authorize()` calls (they've already run), scope enforcement across all actions, system-namespace carve-out on delete/restore, subset check on child token creation, `users.delete` revokes tokens.
- **`test/cli.test.ts`** — extended: bootstrap flow (mint token → set-token → CLI writes work), the full commands catalog end-to-end, error exit codes.
- **README quickstart** updated to include the bootstrap + write transcript.
- Full CI matrix stays green.
- Open PR against `main`.

## 4. Sequencing

```
                 WS1 (validation)
                       │
                       ▼
WS2 (path-config) ──► WS6 (docs writes)  ◄─── WS3 (deletion path)
                       │
                       ├──► WS7 (repos/users/tokens writes)
WS4 (auth foundation) ─┤
                       └──► WS5 (scope grammar)
                                  │
                                  ▼
                             WS8 (bootstrap)
                                  │
                                  ▼
                             WS9 (CLI wires everything)
                                  │
                                  ▼
                             WS10 (tests + polish + PR)
```

Suggested attack order: WS1 → WS3 → WS4 (auth foundation, no scopes yet — plumbing) → WS2 → WS5 → WS6 → WS7 → WS8 → WS9 → WS10.

The auth foundation goes early (WS4 before WS2) because the `authorize()` stub calls in M0 need to be swapped to something real, but the swap can happen in a **body-only, target-ignoring** way at first, then WS5 fills in real scope logic. This keeps the M0 kernel green throughout.

## 5. Design decisions to pin during M1

Deferred by design.md to implementation; decide once and record in the decision log (§9):

1. **Token secret format on the wire.** Proposal: `mrplex_<base64url(32 bytes)>` — the `mrplex_` prefix is UX-only; the whole string is the secret, and the server computes `sha256(entire_string)`. Clarifies "this looks like a mrplex token" in logs without leaking anything.
2. **Root-token bootstrap trigger.** Proposal: explicit `mrplex bootstrap` command (§3 above). Alternative rejected: implicit bootstrap on first `serve` startup — too magical, produces surprises when a snapshot from a peer db is restored.
3. **Deletion-slug uniquifier for `repos.delete` / `users.delete`.** Ships as 6-char hex of `randomBytes(3)` — 24 bits of entropy, essentially collision-free within a repo/user's lifetime deletion history, zero deps. (The original proposal said base32; Node has no built-in base32 encoder and hex meets the same "short, stable, alphanumeric" bar.)
4. **Server config file location and shape.** Proposal: `~/.config/mrplex/server.yaml` by default (CLI equivalent already at `config.toml`; use YAML for server config since the operator-facing content is the path-config sigil layering — YAML is what they'd write). Overridable via `--config PATH`.
5. **Where `mrplex login` prompts.** Proposal: reads from stdin with echo disabled (using Node's `readline` + `process.stdin.setRawMode(true)`); doesn't accept the token as a flag argument for shell-history reasons.
6. **`tokens create` output format.** Plaintext secret on stdout (single line, no trailing newline in `--json` mode, trailing newline in pretty mode) + `{ id, label, scopes, ... }` on stderr as pretty text. Rationale: enables `TOK=$(mrplex tokens create ...)` cleanly, per §7.3's scripting-friendly output convention.
7. **Slug hygiene numbers** (deferred from M0-plan): ≤ 64 chars, no leading/trailing whitespace, no control chars.

## 6. Definition of done

```bash
# Fresh database, bootstrap, store the root token.
rm -f ./m1.db
npm run cli -- --database ./m1.db bootstrap > /tmp/root.tok
export MRPLEX_TOKEN=$(cat /tmp/root.tok)

# Admin ops.
npm run cli -- --database ./m1.db users create alice
npm run cli -- --database ./m1.db repos create notes

# Write flow: create → update → move → delete → restore.
npm run cli -- --database ./m1.db docs create notes hello.md --from-file - <<'EOF'
---
title: Hello
---

Hi.
EOF
# Prints v1; store it.
V=$(npm run cli --silent -- --database ./m1.db --json docs get notes hello.md | jq -r .version_id)
V=$(npm run cli --silent -- --database ./m1.db docs put notes hello.md --prev "$V" --from-file - <<'EOF'
---
title: Hello
---

Hi, again.
EOF
)
V=$(npm run cli --silent -- --database ./m1.db docs mv notes hello.md greetings/hi.md --prev "$V")
V=$(npm run cli --silent -- --database ./m1.db docs delete notes greetings/hi.md --prev "$V")
npm run cli --silent -- --database ./m1.db --include-system docs get notes ":deleted/greetings/hi-${V}.md"
# Restore back into user territory.
V=$(npm run cli --silent -- --database ./m1.db docs put notes greetings/hi.md --prev "$V")

# Concurrency: stale_prev on out-of-date put returns exit 2 with current attached.
```

- All commands succeed with the expected exit codes; the concurrency example exits 2 with a JSON body containing `{ code: "stale_prev", data: { current_version_id, current_path, submitted_prev_version_id } }`.
- Full test suite green in CI on Ubuntu + macOS × Node 20 + 22.
- Every kernel op is grep-provably wrapped in a real `authorize()` call (not the M0 stub); `git grep 'authorize.*allow-all'` returns nothing.
- Every write path is grep-provably wrapped in `validatePath` or `validateSlug` at kernel entry.

## 7. Risks & watchouts

- **Auth wire-up churn.** Every kernel op signature already carries `actor`; the swap is behind a single `authorize()` implementation. Kept small by putting the M0 stub and the M1 implementation in the same file so the diff is one function body.
- **Frontmatter round-trip fidelity on structured writes.** Serializing structured → YAML canonically is deterministic but doesn't preserve comments/key-order from any prior version — that's fine for structured writes (the caller chose to give up the raw form). Round-trip on `raw` writes stays byte-exact.
- **Concurrency semantics under CLI stress.** The `docs put` write flow may see `stale_prev` under real user concurrency; document the retry pattern in the CLI's error output (the current-version-id from the error is the next `--prev`). The kernel does not retry; that's a merge policy per §4.
- **Bootstrap replay hazard.** Refusal-when-non-empty guards against re-bootstrapping a live database (which would mint an unauthorized root token). Test explicitly.
- **Scope subset undecidability.** Verbatim structural subset is conservative and might reject perfectly-fine child tokens; the design's `[OPEN]` marker acknowledges this. Users can always work around by re-issuing from the parent scope.
- **Path-config startup invariants**: exhaustive tests over the invariants matrix — this is where operators shoot themselves later, so failing fast at startup is the whole point.
