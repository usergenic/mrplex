# No-Auth Plan — Trust the Caller, Scope on Request, Identity as a String

Target: remove authentication, identity management, and token lifecycle from the engine entirely. mrplex becomes a **full-trust kernel**: any caller that can reach it can do anything. Authentication, credential storage, and token issuance move to a **shell around mrplex** (a fronting proxy, a wrapping service, or simply the OS process boundary for stdio/local use). What stays inside the engine is the one thing a shell *cannot* do from outside: **scoped visibility** — the ability to evaluate a query or read "as if" only certain repo/path globs were readable, applied explicitly per call. A proxy can gate routes; it cannot post-filter search results without breaking ranking and pagination, and it cannot scope link-graph traversal at all. So credentials move out, enforcement machinery stays in — exposed as a plain input instead of being derived from a token.

Authorship survives auth removal as a single opaque string: every version records an **`author`** supplied by the API call. The engine attaches no semantics to the value; the expected convention is git's `Full Name <email@address>`, but that is a caller-side norm, not an engine rule (design §4.4 inverts: identity is now *always* trusted from the request, because the whole caller is trusted). No `committer` field — git's author/committer split solves a distributed-patch-flow problem mrplex doesn't have.

There is **no data migration**. Existing databases are not carried forward. Both engines' migration chains collapse into a single fresh `0001_init.sql` that bakes in everything (init + casefold + FTS + links + this change), and the adapters gain a guard that refuses to open a legacy database with a clear message.

Branch `noauth` is cut from `main`.

## 1. Scope

**In:**

- **Delete authn and the token/user model.** No bearer tokens, no `Authorization` parsing, no secret hashing, no `users`/`api_tokens` tables, no `tokens.*`/`users.*` kernel APIs, no `/me/tokens` or `/users` REST routes, no `users_*`/`tokens_*` MCP tools, no `mrplex bootstrap`/`tokens`/`users` CLI commands, no `MRPLEX_TOKEN`/`--token` resolution for local use, no `unauthorized` error.
- **`Actor` → `CallContext`.** Every kernel op keeps a uniform first parameter, but it becomes a plain caller-supplied value instead of a resolved identity:

  ```types
  ScopeClaim = {
    repo:  string | string[],   // slug, glob, or "*" — evaluated at call time against current repos
    paths: string | string[]    // gitignore-style path globs, §8.2 semantics unchanged
  }
  // Deliberately direction-neutral: a claim says "these repos/paths", not "for reading".
  // The direction comes from where the claim is used — ctx.scope means read visibility.
  // (The auth-shell plan reuses the same type for its shell-enforced write matcher.)

  CallContext = {
    author?: string,            // writes; default "mrplex"
    scope?:  ScopeClaim[]       // reads; absent = everything visible
  }
  ```

  `createKernel(...)` ops accept `ctx: CallContext = {}`. An empty context is full access with the default identity — the zero-config path for system processes, which is the point of this change.
- **Explicit read scopes on reads.** `ctx.scope`, when present, narrows visibility exactly the way a token's read scopes do today: `query` compiles the claims into the `SearchPlan` scope groups (silent filtering, not 403s); `docs.get` / `get_version` / `history` / `diff` throw `forbidden` when the target path falls outside the claim; `repos.list` returns only claimed repos; the links read surface (`links.stale`, backlink-shaped queries) filters through the same groups. The glob engine (`kernel/auth/glob.ts`), the scope matcher (`scopesGrant`), and the `SearchPlan.scope` seam (`storage/search-plan.ts`) are kept as-is — only the *provenance* of the scopes changes (per-call input instead of token row).
- **Call-time repo resolution for claims.** Tokens bound repo *ids* at issuance (§8.2 "renames don't break tokens"). Per-call claims have no issuance moment: `repo` patterns are evaluated against the repos existing at call time, every call. The dynamic-`"*"` special case, snapshot semantics, and the id-vs-slug translation layer (`resolveScopeInputs` → stored ids → wire slugs) all disappear.
- **String authorship.** `versions.author_id` (FK → `users`) is replaced by one text column: `author text not null`. Write ops read it from `ctx.author`, defaulting to `"mrplex"`. Values are opaque — sanity-validated only (non-empty, no control characters, length-capped) — never parsed. Wire `Version.author` becomes a string; the injected `$author` system property becomes that string.
- **Kernel-originated rewrites preserve authorship.** `links.repair` writes a new version whose *content* the original author effectively wrote (only stale link text changes): `author` is carried forward from the previous version, and nothing else is recorded. Direct writes (`create`/`put`/`delete`) take the caller's identity (deletion is an authored act by the deleter).
- **Migration collapse.** SQLite `0001`–`0005` → one `0001_init.sql`; Postgres `0001`–`0003` → one `0001_init.sql`. Fresh content: no `users`, no `api_tokens`, a `versions.author` text column, plus everything the later migrations added (casefold shadow columns + indexes, FTS table/triggers, links tables) folded into the initial schema. The migration *runner* (numbered files, `PRAGMA user_version` / migrations table) is unchanged — future migrations start at `0002`.
- **Legacy-database guard.** An old SQLite file has `user_version = 5`; the collapsed chain would see `0001 ≤ 5`, skip it, and run against a mismatched schema. On open, the adapter probes for the legacy marker (an `api_tokens` table) and refuses with a clear error: pre-noauth databases are unsupported — re-ingest into a fresh database. Same probe on Postgres.
- **Shell pass-through in the remote client.** The CLI's remote transport keeps an optional `--token` / `MRPLEX_TOKEN` that is forwarded verbatim as `Authorization: Bearer` — mrplex itself ignores the header, but a shell in front of a remote server will want it. Local (in-process) mode ignores it entirely.

**Out (deliberately):**

- **Write scopes.** The engine enforces no per-path write policy; that is the shell's job (a shell wrapping mrplex is mrplex-aware and can parse write bodies if it wants path-level rules). The one write invariant that is *not* auth — no caller-supplied path may enter a system-sigil namespace — already lives in `validatePath` (`kernel/validation.ts:103`) independent of authorization and stands untouched. If shell-side write policy proves insufficient, the engine can accept a parallel write-claim input later (e.g. `ctx.write_scope: ScopeClaim[]`); the direction-neutral claim type makes that purely additive.
- **Scope attenuation / subset checking.** `assertChildScopeSubset`, `assertAdminSubset`, and the whole "child token must be a subset of parent" apparatus die with tokens. A caller who can supply a scope claim can supply a wider one; narrowing across trust levels is the shell's concern.
- **Any in-engine authn hook, "trusted header" identity verification, or pluggable auth interface.** The engine trusts every caller equally. No half-measures — an optional-auth mode is the worst of both worlds (surface area of auth, guarantees of none).
- **Network hardening beyond the existing loopback default.** `serve` already binds `127.0.0.1` unless `--host` says otherwise (`server/serve.ts:88`); that stays. TLS, rate limiting, and exposure decisions are the shell's.
- **Data migration tooling.** No exporter, no upgrader. Databases created before this branch are refused (see guard above); the fixture/test corpus re-ingests.

## 2. What the shell owns (the contract)

The deployment story this plan assumes, stated once so design.md can point at it:

- **Process-boundary deployments** (stdio MCP, in-process CLI, sidecar on localhost): the OS is the shell. Whoever can exec the binary or reach the loopback port is root on the store. This is the primary mode and needs zero configuration.
- **Networked deployments**: a fronting proxy or wrapper service terminates authn (OAuth for MCP clients — closer to MCP convention than the homegrown bearer scheme being deleted — or whatever the operator runs), maps each credential to a `ScopeClaim[]` + identity string, and injects them via the request headers in §4. mrplex must never be directly reachable from an untrusted network; the docs say so loudly.
- The shell owns: credential storage and rotation, revocation, token lifecycle and UI, per-principal write policy, gating of destructive repo ops (`repos.create`/`rename`/`delete`/config — addressable by route/tool name, no body parsing needed), audit of *who authenticated* (mrplex still records *who authored*, as a claim), TLS, rate limits.

## 3. Schema after (SQLite dialect; Postgres mirrors)

```sql
create table repos ( ... unchanged ... );
create table documents ( ... unchanged ... );

create table versions (
  id              integer primary key,
  document_id     integer not null references documents(id),
  repo_id         integer not null references repos(id),
  prev_id         integer      references versions(id),
  next_id         integer      references versions(id),
  path            text    not null,
  path_norm       text    not null,            -- casefold, folded in from 0004
  frontmatter_raw text    not null,
  frontmatter     text    not null check (json_valid(frontmatter)),
  body            text    not null,
  author          text    not null,            -- opaque caller-supplied string
  created_at      text    not null
);

-- users, api_tokens: gone.
-- chunks, embedding_backlog, links tables, FTS + casefold indexes: folded in unchanged.
```

## 4. Surface changes

**REST** (`rest/routes.ts`, `server/auth.ts` deleted):
- No `Authorization` handling. `/users*` and `/me/tokens*` routes removed.
- Identity on writes: `X-Mrplex-Author` request header.
- Scope on reads: `X-Mrplex-Scope` header carrying the JSON `ScopeClaim[]`; `POST /query` also accepts a `scope` field in the body (header wins when both present — the shell sits closer to the credential than the body author does).

**MCP** (`mcp/server.ts`, `mcp/tools.ts`):
- Streamable HTTP: no per-request bearer resolution. The same `X-Mrplex-*` headers are honored per request and become the session's `CallContext` — this is the shell-injection path, since a proxy can set headers but not rewrite tool arguments.
- Tool arguments: write tools gain optional `author`; the query tool gains optional `scope`. Headers override tool args.
- stdio: the launch-time token binding (§6.2) is deleted. `--mcp-stdio` needs no credential; optional launch flags `--author <s>` / `--scope <json>` pin session defaults for the whole stdio session.
- `users_*` / `tokens_*` tools removed.

**CLI** (`cli/main.ts`; `cli/auth.ts`, `cli/bootstrap.ts` deleted):
- Commands removed: `bootstrap`, `tokens *`, `users *`, `config set-token`.
- Identity resolution, git-style precedence: `--author` flag → `MRPLEX_AUTHOR` env → `author` in `~/.config/mrplex/config.json` → engine default `"mrplex"`. New `mrplex config set-author "Full Name <email@address>"`.
- `--scope <json>` on `query` (and the read commands, for parity/testing).
- `--token` survives only as remote-mode bearer pass-through (see §1); local mode ignores it.

**Client seam** (`client/kernel-client.ts`, `local.ts`, `remote-mcp.ts`):
- `KernelClient` drops `users`/`tokens` namespaces. `openLocalClient` no longer resolves a token — it takes an optional default `CallContext`. `openRemoteClient` maps the context to the `X-Mrplex-*` headers and forwards the pass-through bearer if configured.

**Errors** (`kernel/errors.ts`):
- Removed: `unauthorized`, `token_not_found`, `user_not_found`.
- Kept: `forbidden`, remapped meaning: "the scope claim supplied with this call excludes the target." Still HTTP 403; still leaks no existence information (out-of-claim and nonexistent look identical) — not because the caller is untrusted, but so shells can hand mrplex errors to *their* untrusted callers unfiltered.

## 5. Deletion / keep inventory

**Deleted outright:**

| File | Notes |
|---|---|
| `src/kernel/auth/tokens.ts` (+test) | secret gen/hash, `resolveActor`, stored-scope serialization |
| `src/kernel/auth/authorize.ts` (+test) | the action/target matrix; reads become claim-filtering at the op, writes become unconditional |
| `src/server/auth.ts` | bearer middleware |
| `src/cli/auth.ts`, `src/cli/bootstrap.ts` (+test) | |
| `kernel.ts` `users.*` + `tokens.*` sections, `userById` cache, `TokenCreateResult` | |
| `storage/types.ts` `users_*`, `tokens_*` methods + `UserRow`/`TokenRow` + both adapters' implementations | |
| Wire types `User`, `Token`, `Scope` (`kernel/wire.ts`) | |
| SQLite migrations `0002_admin_token_flag` (and `0001`–`0005` as separate files), PG `0001`–`0003` as separate files | collapsed per §1 |
| REST `/users*`, `/me/tokens*`; MCP `users_*`, `tokens_*` tools; CLI `bootstrap`/`tokens`/`users` commands | |

**Kept (this is the part "remove all the auth stuff" must not sweep away):**

- `src/kernel/auth/glob.ts` (+test) — gitignore glob engine; powers claims.
- `src/kernel/auth/scope.ts` — trimmed to claim normalization (`ScopeClaim` → matcher groups) + `scopesGrant`; loses id-resolution and subset assertions.
- `src/storage/search-plan.ts` `ScopeGroup` / scope compilation in both adapters — unchanged; the kernel's `buildScope` (`kernel/query/query.ts`) now reads `ctx.scope` instead of `actor.scopes`.
- `kernel/auth/actor.ts` → renamed/reshaped into `kernel/context.ts` (`CallContext`, `ScopeClaim`, the `"mrplex"` default). `SYSTEM_ACTOR` disappears; kernel-internal ops simply use an empty context (repair carries the prior version's author forward, delete-moves stamp the caller's).
- `validatePath`'s system-sigil rejection, the deletion/restore move machinery, `pathIsInSystemNamespace` — never were auth.

## 6. Workstreams (attack order)

**WS1 — Schema + storage.** Write the two collapsed `0001_init.sql` files; drop `users_*`/`tokens_*` from `storage/types.ts` and both adapters; `VersionRow`/`version_insert` swap `author_id: number` for `author: string`; add the legacy-database guard to both adapters' open path. Kernel suite won't compile yet — that's WS2; land WS1+WS2 together.

**WS2 — Kernel.** Introduce `CallContext`; sweep all ~105 `actor` references in `kernel.ts`: writes take identity from ctx (with defaults + sanity validation), reads filter through claims, `authorize()` call sites deleted, `resolveRepo` loses its action argument, `users.*`/`tokens.*` sections deleted, `toVersionWire` stops joining users. `runQuery`/`buildScope` reads `ctx.scope`. `links.repair` carries forward `prev.author`. Trim `scope.ts`; delete `authorize.ts`/`tokens.ts`; update `errors.ts`.

**WS3 — Surfaces.** REST: strip middleware + routes, add `X-Mrplex-*` header parsing. MCP: strip bearer/stdio-binding, add header/arg context plumbing, delete user/token tools. CLI: delete commands, add identity flags/env/config + `--scope`, keep remote bearer pass-through. Client seam updated. `serve.ts` log line loses `/users, /me/tokens`.

**WS4 — Tests.** Delete auth unit tests; rewrite everything that bootstraps a token to just open a client (this deletes real setup boilerplate from nearly every file in `test/`); keep and adapt scope-semantics tests — same glob cases, now driven through `ctx.scope`/`--scope`/`X-Mrplex-Scope`; new tests: identity defaults, repair author-preservation, header-over-arg precedence, legacy-db guard, fresh-migration bootstrap on both engines (kernel suite is the referee, §7.2 parity unchanged).

**WS5 — Docs.** design.md: rewrite §8 (trust model + `ScopeClaim` grammar — §8.2's glob semantics survive nearly verbatim — + the shell contract from §2 of this plan), rewrite §4.4 (authorship = one caller-supplied opaque string), update §3.2 schema, §6.1/6.2/6.3 surface signatures, §6.4 wire types, §7.1 deployment shapes (shell diagram), §7.3 CLI, decision log entry. README quick-start loses `bootstrap` (biggest UX win in the repo — the quick-start becomes `mrplex serve`).

## 7. Decisions pinned

1. **Full trust, no optional-auth mode.** In-engine auth is deleted, not made configurable.
2. **Uniform `CallContext` first parameter** rather than per-op option bags — minimal churn across ~105 call sites, one place for surfaces to aim at.
3. **Read claims apply to all read-shaped ops**, not only `query` — a scope that filters search but not `docs.get` would be a lie.
4. **Claims resolve at call time by slug/glob.** No issuance snapshot, no id binding. A claim names what it names right now.
5. **`forbidden` survives** as the out-of-claim error; `unauthorized` does not survive in any form.
6. **Identity is one string.** `author` only, default `"mrplex"` — no `committer`; git's author/committer split addresses patch flows (rebase, cherry-pick, applying mailed patches) that mrplex doesn't have. Opaque, sanity-checked only. `Full Name <email>` is convention, not contract.
7. **Repair preserves author, records nothing else** — the kernel rewriting link text on someone's behalf doesn't reassign their document, and repair calls get no special provenance treatment; that's the shell's concern.
8. **Header beats body/tool-arg** for context on networked surfaces — the shell injects headers; the payload author may be the shell's untrusted client.
9. **One fresh `0001_init.sql` per engine + legacy guard**; no upgrade path. Future migrations resume at `0002`.
10. **Write scoping stays out.** `ScopeClaim` is direction-neutral (`{ repo, paths }`) — a claim names territory, and its meaning comes from where it's passed (`ctx.scope` = read visibility). A future engine-side write check would be a separate `ctx.write_scope` input, purely additive.
11. **Destructive repo ops are ungated.** `repos.create`/`rename`/`delete`/`set_path_config`/`set_link_config` — today admin-gated — carry no in-engine gating at all: reachable = allowed, same as every other write. Restrictions on destructive calls are provided by the access-and-identity shell, which can gate these by route/method without parsing bodies (they're addressable at the URL/tool-name level, unlike path-scoped writes).
12. **No permission toggles in the engine, period.** A `--read-only` launch flag was considered and rejected — it's a foot-in-the-door for permission controls creeping back into the kernel. Anything permission-shaped (read-only sessions, per-principal restrictions, capability grants) belongs in the authentication-and-permissions shell, which gets its own proper design as a module separate from this kernel. The line the engine holds: `ScopeClaim` is a *query-evaluation input* (narrow what this call sees), and the stdio/CLI `--scope`/`--author` launch flags are merely how a parent process — which in stdio mode *is* the shell — injects that per-session context; neither is, or grows into, a permission system.

## 8. Open questions

None — resolved into §7.
