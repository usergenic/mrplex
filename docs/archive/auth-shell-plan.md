# Auth Shell Plan — Identity, Authentication & Permissions Around the Kernel

> **Document status: archived.** This plan is implemented and squash-merged to `main` (`8630757`, PR #13), following the noauth rework it builds on ([noauth-plan.md](noauth-plan.md), `2b02a7b`, PR #12). Like everything in archive/, it may be out of date — the code on `main` is the source of truth.

Target: the **access-and-identity shell** that [noauth-plan.md](noauth-plan.md) §2 promises and deliberately does not build. That rework is merged: the kernel is full-trust and exposes exactly three injection points — an `author` string, a `ScopeClaim[]` for read visibility, and a route/tool-name-shaped surface on which destructive ops can be gated. This plan defines the module that fills those points: it authenticates callers, maps each credential to an identity and a set of grants, enforces write and destructive-op policy, and forwards to the kernel — without the kernel ever learning that any of this exists.

The load-bearing architectural choice: the shell is a **decorator, not a proxy**. mrplex already has the perfect seam — the `Kernel` interface (mirrored by `KernelClient`). The shell's core is `guardKernel(kernel, entitlement): Kernel`: an object with the same shape as the kernel whose every method computes the `CallContext` (author from the principal, scope claims from policy), enforces write/destructive policy against the **typed** call arguments, and forwards. A generic reverse proxy cannot do path-level write policy without parsing bodies and re-deriving move semantics; the decorator sees `docs.put(ctx, repo, prev_version_id, path, input)` as structured data. Any surface — an authenticated HTTP listener, an MCP gateway, a stdio launcher — composes the guard; none of them re-implement policy.

Separation is a hard rule, not a directory convention: **the kernel never imports the shell; the shell imports only the kernel's public seam** (`Kernel`, `CallContext`, `ScopeClaim`, the glob engine). The shell could be extracted to its own package later without touching engine code — that extractability is the test of the boundary.

Prerequisite: none — the no-auth rework is on `main`. Branch `auth-shell` is cut from `main`.

## 1. Scope

**In:**

- **The compiled-entitlement contract** — the one stable internal seam everything else plugs into. Every authn front, whatever its mechanism, resolves a credential to this tuple and nothing else:

  ```types
  Entitlement = {
    author:      string,        // identity the shell will stamp on writes — derived from the credential, per §3
    read:        ScopeClaim[],  // read visibility — forwarded verbatim as ctx.scope
    write:       ScopeClaim[],  // enforced BY THE SHELL against write-op paths
    destructive: boolean,       // repos.create/rename/delete/set_path_config/set_link_config
    impersonate: boolean        // may supply a caller-chosen author instead of the derived one
  }
  ```

  `ScopeClaim` is the engine's claim type. As merged (`src/kernel/context.ts`) its shape is `{ repo, read? }`; **WS0 renames the glob field to the direction-neutral `paths`** pinned in this plan — a claim names territory; the field it sits in supplies the direction. `read` and `write` here are two lists of the same type, one forwarded to the engine, one enforced locally. Fronts change (keys today, OIDC tomorrow, capability tokens someday); this tuple does not. Policy evaluation is a pure function `compile(policy, principalId): Entitlement`, unit-testable with no I/O.
- **`guardKernel(kernel, entitlement): Kernel`** — the decorator. Per-method behavior:
  - *Reads* (`query`, `docs.get/get_version/history/diff`, `repos.list/get`, `links.stale`): forward with `ctx.scope = entitlement.read`. The engine does the filtering — that's the part that had to stay kernel-side (search ranking, pagination, graph traversal).
  - *Writes* (`docs.create/put/delete`): check the target path(s) against `entitlement.write` with the same gitignore-glob semantics (`kernel/auth/glob.ts`, imported — not reimplemented). A `put` that moves checks **both** endpoints, reusing the old §8.2 both-endpoints rule; system-sigil endpoints are skipped (the kernel's `validatePath` already owns that namespace). `delete` checks write on the doc's current path. Violation → the shell's own `forbidden` error, same wire shape as the kernel's.
  - *Destructive ops* (`repos.create/rename/delete/set_path_config/set_link_config`, `links.backfill`, `links.repair` with `dry_run: false`): allowed iff `entitlement.destructive`.
  - *Author stamping*: `ctx.author = entitlement.author`, always. A caller-supplied author is ignored unless `entitlement.impersonate` — the shell derives identity from credentials, it does not take the caller's word for it (the exact inversion of the kernel's stance, which is the point of having both layers).
- **Declarative policy file.** Principals, roles, grants — YAML (`policy.yaml`), diffable, auditable, commentable, loaded at startup and reloadable on SIGHUP. Parsed with the `yaml` package the engine already depends on for frontmatter (YAML 1.2 core schema — no 1.1 implicit-typing footguns), then schema-validated with precise errors:

  ```yaml
  roles:
    reader:
      grants:
        - { repo: "*", read: "**" }
    editor:
      grants:
        - repo: notes
          read: "**"
          write: ["drafts/**", "inbox/**"]
    operator:
      grants:
        - { repo: "*", read: "**", write: "**" }
      destructive: true

  principals:
    brendan:
      author: Brendan Baldwin <brendan@example.com>
      roles: [operator]
      keys:
        - sha256:9f2c...   # laptop CLI, minted 2026-08-21
      oidc: { email: brendan@example.com }
    ingest-bot:
      author: ingest-bot <bots@example.com>
      roles: [editor]
      keys:
        - sha256:41aa...   # k8s cron, rotate quarterly
  ```

  A **grant** — `{ repo, read?, write? }` — is the human-facing vocabulary: it pairs a repo pattern with path globs per direction, so an operator writes read and write policy side by side. `compile()` splits each grant into the entitlement's two `ScopeClaim` lists (`read` globs → `Entitlement.read`, `write` globs → `Entitlement.write`), each entry `{ repo, paths }`. Glob and repo-pattern semantics are the engine's exactly (slug/glob/`"*"`, gitignore paths, union across entries, call-time resolution). Roles are grant bundles plus the two booleans; a principal's entitlement is the union of its roles. No deny rules, no precedence — negated globs (`!pattern`) inside a list already cover carve-outs, same as the old token scopes.
- **Authn front 1: API keys.** High-entropy shell-generated secrets, stored as `sha256` hashes **in the policy file itself** (no key database — issuance is a line in a diffable file, revocation is deleting the line). `mrplex key mint <principal>` prints the plaintext once and appends the hash. Same deterministic-hash rationale the old design §8.1 had; the reasoning survives even though the code didn't. Presented as `Authorization: Bearer <key>` to the shell.
- **Authn front 2: OIDC.** Verify a JWT against the IdP's JWKS (issuer + audience pinned in shell config); match the token to a principal by the `oidc.email` / `oidc.sub` binding in the policy file. Where the policy file has no explicit `author`, derive it from claims as `name <email>` — the convention and the credential line up by construction. This is also the on-ramp to MCP's OAuth 2.1 story: the shell acts as the resource server and delegates the authorization-server role entirely to the IdP.
- **One binary, explicit mode.** There is no `mrplex-shell` executable — everything is a mode of `mrplex`. The rule for when `--policy` applies is a single principle: **policy is loaded by the process that enforces — the one starting a server. Clients never load policy; they present credentials and get whatever the server's policy grants.** Concretely:
  - *Server-starting commands* (`serve`, `mcp-stdio` over a local database, `proxy`) require **exactly one** of `--policy <file>` (guarded kernel) or `--unsafe` (raw kernel — named to say what it is: serving without a policy is the unsafe configuration, construct one before doing it seriously). Neither given → refuse to start; both → refuse. Full trust is never the result of a forgotten argument.
  - *Client commands* need no policy, ever: remote-mode CLI (`--server <url>`) just carries credentials and is governed by that server's policy; `mcp-stdio --server <url>` acts as a pure stdio→HTTP bridge (an MCP client speaks stdio to it, it speaks authenticated Streamable HTTP upstream) — credentials only, no local enforcement, nothing to enforce with.
  - *Direct local data commands* (`mrplex docs get`, `query`, … against a database file) are exempt on different grounds: possession of the file already is root — gating them would be theater.
  - *Policy tooling* (`key mint`, `policy check`) reads/edits the policy file by definition; `login` needs only OIDC client config, not policy.
- **Serve mode: embedded (primary).** `mrplex serve --policy policy.yaml` runs a single process: open the database, `createKernel`, and mount mrplex's own REST + MCP surface code on top of per-request guarded kernels — authenticate, `compile()` the entitlement (cached per principal, invalidated on policy reload), `guardKernel()`, dispatch. No engine listener exists at all, so there is no header-trust problem and no second process. This requires a small engine-side accommodation (WS0): the surface mounting functions accept a `contextForRequest(req)`-style factory instead of calling `contextFromHeaders` themselves. That factory is useful to the engine on its own terms (it's how headers become `CallContext` today), so it's an API generalization, not shell logic leaking in.
- **Serve mode: fronting proxy (supported).** `mrplex proxy --policy <file> --upstream <unix-socket|loopback-url>` (`--policy` always required — an unsafe proxy is meaningless) for deployments where the engine must run separately: authenticate, strip any inbound `X-Mrplex-*` headers from the client (mandatory — the engine trusts them unconditionally), inject the entitlement's headers, enforce write/destructive policy by parsing the known REST/MCP routes (the shell is mrplex-aware; this is not a generic proxy). The engine binds a unix socket or loopback only. Embedded is preferred; proxy exists for polyglot/containerized topologies.
- **Launcher mode: stdio — with real credentials, OAuth included.** `mrplex mcp-stdio` (promoted from today's `serve --mcp-stdio` flag to its own subcommand, under the same policy/unsafe gate) runs an in-process stdio MCP session over a guarded kernel, resolving its principal from one of three sources (stdio has no HTTP layer, and the MCP spec's own guidance for stdio is credentials-from-environment):
  1. `--principal <id>` — trust-by-spawn, no credential: the parent chose to spawn (local dev, or a gateway that already authenticated).
  2. `MRPLEX_SHELL_KEY` env / `--key` — an API key, verified against the policy file exactly as the HTTP front does.
  3. `MRPLEX_SHELL_TOKEN` env / `--token` — an **OAuth access token (JWT)**, verified by the same OIDC/JWKS verifier and claim→principal binding as the HTTP front. A stdio MCP client config passes it via its `env` block.

  All three converge on the same `credential → principal → compile() → guardKernel` pipeline — stdio is only special in how the credential arrives. Companion command `mrplex login`: the OAuth **device authorization flow** (visit URL, enter code), caching access + refresh tokens under the config dir (mode 600); `mcp-stdio` uses the cached token when no explicit credential is given, and refreshes mid-session — recompiling the entitlement on refresh, so long-lived agent sessions neither die at token expiry nor outlive a policy change indefinitely.
- **Audit log.** Append-only JSONL: `{ ts, principal, op, repo, path, outcome }` for every authenticated call, written by the guard (one choke point, so no surface can forget). This is where "who triggered that repair" lives, per noauth-plan decision 7 — the engine records who authored; the shell records who called.

**Out (deliberately):**

- **Any engine change beyond WS0's two small accommodations** (the `paths` rename and the `kernelForRequest` factory) **and the single-binary CLI wiring** (new subcommands + the policy|unsafe gate in `cli/main.ts`). The kernel's noauth posture is finished; this plan consumes its seams.
- **A user/token database.** Principals and key hashes live in the policy file; OIDC users live in the IdP. If the policy file ever gets big enough to hurt, that's the moment to revisit — not before.
- **ReBAC / relationship graphs** (SpiceDB, OpenFGA). Per-document sharing with inheritance is not the model; path globs are the mrplex vocabulary and the policy file speaks it natively. Adopting a Zanzibar service for this would be architecture cosplay.
- **Capability tokens (macaroons/Biscuits)** — genuinely attractive for offline attenuation and agent delegation (a holder mints a narrower token without a server round-trip), and the `Entitlement` seam is exactly where a Biscuit verifier would plug in later. Deferred as the marquee item of future work, not built now.
- **CEL policy predicates.** Same status: the policy file's static grants come first; a CEL escape hatch (`allow when: <expr over principal/action/repo/path>`) is additive later and reuses the engine's existing CEL parser if wanted.
- **Storing the policy file in a mrplex repo.** Cute (versioned policy with mrplex's own history), but it creates a bootstrap circle — the shell needs policy to serve the repo that holds the policy. File-on-disk is the source of truth; a sync job into a repo for visibility is a someday-nicety.
- **Admin UI, self-service key management, rate limiting, TLS termination.** Operator concerns layered on top; TLS in particular belongs to whatever ingress fronts the shell.

## 2. Repo layout

```
src/
  shell/
    policy.ts            # schema, parse/validate, compile(policy, principalId) → Entitlement
    policy.test.ts
    guard.ts             # guardKernel(kernel, entitlement, audit?) — the decorator
    guard.test.ts
    keys.ts              # key generation + sha256 verify; mint helper
    oidc.ts              # JWKS fetch/cache, JWT verify, claim → principal binding
    audit.ts             # JSONL appender
    serve.ts             # embedded mode: authn → compile → guard → mount surfaces
    proxy.ts             # fronting-proxy mode
    stdio.ts             # launcher mode: principal | key | oauth token → guarded stdio session
    login.ts             # OAuth device-flow login; token cache (mode 600) + refresh
  cli/
    main.ts              # ONE binary: gains `login`, `key mint`, `policy check`, `proxy`, `mcp-stdio`
                         # subcommands, and the policy|unsafe gate on every serving entry point
```

Dependency rule, enforced in review and by a lint boundary if available: `src/shell/**` imports from `src/kernel`, `src/server`, `src/mcp`, `src/rest` public exports; nothing outside `src/shell` and the bin entry imports from `src/shell`. New runtime deps: a JOSE library for OIDC (`jose`); nothing else — keys, globs, policy, audit are stdlib + existing engine code.

## 3. Identity derivation (pinned)

- `author` comes from the policy file's `principals.<id>.author`, or for OIDC principals without one, `${claims.name} <${claims.email}>`.
- The shell never forwards a caller-supplied author unless the principal's entitlement has `impersonate: true` — intended for import tools and agents acting on behalf of a human (where the convention `Agent <agent@…> for Full Name <email>` or similar is, per noauth-plan decision 6, the caller's business, not the engine's or even really the shell's).
- The engine default `"mrplex"` should never appear on a shell-mediated write; the guard always sets `ctx.author`. If it shows up in data, something bypassed the shell — which is only an anomaly on deployments that claim everything goes through it.

## 4. Workstreams (attack order)

**WS0 — Engine precursors** (the only engine changes in this plan, both small, landed first as their own PR):
- Rename `ScopeClaim`'s glob field `read` → `paths` — type, `validateScopeClaims`, the scope-flattening in `kernel/auth/scope.ts`, and the wire shape everywhere it appears (`X-Mrplex-Scope` header JSON, `POST /query` body `scope`, MCP query tool-arg, CLI `--scope`), plus tests. The wire shape shipped days ago and has no external consumers; this is the last cheap moment for the rename.
- Generalize surface mounting to take a per-request context factory (default: today's `contextFromHeaders`), so the embedded shell can substitute entitlement-derived contexts without forking the surface code.

**WS1 — Policy + entitlement.** `policy.ts`: JSON schema validation with precise errors, role-union semantics, `compile()` as a pure function, `mrplex policy check` (validate + print a principal's effective entitlement — the operator's "why can't X read Y" tool). Glob semantics come from `kernel/auth/glob.ts`; tests reuse the old scope-test cases as policy-test cases.

**WS2 — Guard.** `guardKernel` over the full `Kernel` interface: read forwarding with scope, write glob checks incl. move both-endpoints, destructive gating, author stamping, audit emission. Test against a real in-memory kernel — the referee is behavioral: a guarded kernel with entitlement E must be observationally equivalent to the old token-auth engine with scopes E (minus the deleted user/token APIs), which the pre-noauth test suite already encodes; port its cases.

**WS3 — Keys + embedded serve.** `keys.ts`, bearer parsing, per-principal entitlement cache with SIGHUP reload; the engine-side `kernelForRequest` factory generalization; `mrplex serve --policy` mounting REST + Streamable-HTTP MCP over guarded kernels; the policy|unsafe gate on the serving subcommands; `key mint`.

**WS4 — stdio launcher + proxy mode.** `mcp-stdio` with the `--principal` and `MRPLEX_SHELL_KEY` fronts (the OAuth front lands with WS5); proxy mode with inbound `X-Mrplex-*` stripping, header injection, route-aware write/destructive enforcement, unix-socket upstream support.

**WS5 — OIDC + login.** JWKS verification, claim binding, author derivation — shared by the HTTP front and `mcp-stdio`'s `MRPLEX_SHELL_TOKEN` front; `mrplex login` device-flow + token cache + mid-session refresh (entitlement recompiled on refresh); document the MCP OAuth 2.1 resource-server posture (metadata endpoint if the MCP client ecosystem needs it by then — decide at implementation time, flagged in §6).

**WS6 — Docs.** The old design.md is archived (and stale on auth by construction); this workstream writes the fresh security/deployment documentation: trust model (kernel side), shell contract (this module), and a deployment-shapes diagram (embedded / proxy / launcher) — either as a new living design doc or as focused docs, decided when written. README gains the one-binary story: `mrplex serve --policy policy.yaml` (authenticated) vs `mrplex serve --unsafe` (full-trust local).

## 5. Decisions pinned

1. **Decorator over proxy** as the primary mechanism — policy enforcement against typed calls, not parsed bodies. Proxy mode exists but is the secondary topology.
2. **`Entitlement` is the stable seam.** Authn fronts and future policy engines compile *to* it; the guard consumes *only* it. Neither side knows the other exists.
3. **Policy is a declarative YAML file** (`policy.yaml`, via the `yaml` dep the engine already carries) — no database, no service, and comments where an operator file needs them. Key hashes live in it too: issuance and revocation are diffs. This is explicitly a *today* decision, expected to be outgrown (self-service key management, many principals, delegation all strain a hand-edited file). The containment plan is structural: `compile(policy, principalId) → Entitlement` is the only thing that reads policy, so a future store — SQLite, an IdP's groups, capability tokens — replaces the loader behind `compile()` without the guard, the fronts, or the engine noticing.
4. **Grants are the human-facing type, claims are the machine type.** A grant `{ repo, read?, write? }` names both directions together; `compile()` splits it into two lists of the engine's direction-neutral `ScopeClaim` (`{ repo, paths }`). One glob dialect throughout, no deny rules beyond `!` negation.
5. **Write enforcement replays the old §8.2 rules in the shell**: both-endpoints on moves, system-sigil endpoints skipped, write does not imply read.
6. **Author is derived, never trusted** — except under an explicit `impersonate` grant.
7. **Embedded serve has no engine listener**; proxy mode requires unix-socket/loopback upstream and mandatory inbound `X-Mrplex-*` stripping. These are the only two sanctioned networked topologies.
8. **Audit lives in the guard**, one choke point, JSONL, append-only. The engine's `author` column is attribution; the shell's audit log is accountability. They are different facts and stored in different places on purpose.
9. **Keys are sha256-hashed high-entropy secrets** — the old design §8.1 argument (deterministic lookup, no KDF needed for non-human-chosen secrets) carries over intact.
10. **Biscuits/macaroons, CEL predicates, and ReBAC are consciously deferred**, in that order of likely return: capability tokens slot cleanly behind the `Entitlement` seam when agent delegation demands offline attenuation.
11. **One binary; policy belongs to the enforcer.** No `mrplex-shell` executable. A command that *starts a server* over a local database demands exactly one of `--policy <file>` or `--unsafe` and refuses to start otherwise — the raw kernel is a choice you spell out, never a default you fall into. A command acting as a *client* (remote mode, the stdio→remote bridge) never takes `--policy` — it presents credentials and lives under the server's policy. Local data commands stay ungated: possession of the database file is already root.

## 6. Open questions

- **MCP OAuth resource metadata**: does the first cut need the `.well-known` resource-server metadata endpoints, or do the target MCP clients work with plain bearer presentation? Decide in WS5 from the client landscape at the time.
- **Entitlement caching vs. policy freshness in long-lived MCP sessions**: a stdio or Streamable-HTTP session compiled at connect time holds its entitlement until reconnect. Acceptable for v1 (documented), or does the guard re-check a policy generation counter per call? Leaning per-call generation check — it's one integer compare — but measure first.
- **Multiple databases / tenants** under one shell (`principal → database` routing): plausibly trivial in embedded mode (a kernel per database), but out of scope until a real deployment wants it.
- **Dual-direction operations (deferred).** A future update-by-query op (mutate everything a query matches) needs *both* directions on one call: the read claims select, the write claims bound the mutation. The `Entitlement` already carries both sets, so the shell's half is ready; whether the engine would also need a write-claim input (`ctx.write_scope`) to push the write bound into the query plan is unresolved. No such op exists today — deferred until one does.
