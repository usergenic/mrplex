# mrplex Security & Deployment

Two layers, one hard boundary between them.

- The **kernel** is full-trust: it authenticates nothing. Every op takes a
  `CallContext` — an opaque `author` string stamped on writes, and an optional
  `ScopeClaim[]` that narrows *read* visibility. Reachable = permitted. There is
  no identity, no token, no admin bit, and no per-path *write* policy in the
  engine. This is deliberate (see [archive/noauth-plan.md](noauth-plan.md)):
  an optional-auth mode is the worst of both worlds — the surface area of auth
  with the guarantees of none.
- The **shell** (`src/shell/`) is everything the kernel refuses to be:
  authentication, per-principal identity, per-path write policy, destructive-op
  gating, and an audit log. It is a **decorator, not a proxy** — `guardKernel`
  returns an object with the exact `Kernel` shape whose every method enforces
  policy against the typed call arguments and forwards to the real kernel.

The boundary is a one-way import rule: **the kernel never imports the shell; the
shell imports only the kernel's public seam** (`Kernel`, `CallContext`,
`ScopeClaim`, the glob engine). The shell could be lifted into its own package
without touching engine code.

## The trust model, precisely

- **Read visibility** is the one enforcement the engine keeps, because it can't
  be replicated from outside: search ranking, pagination, and graph traversal
  are kernel-side, so the kernel filters results against `ctx.scope`. A read
  outside the claim is a `forbidden`; an out-of-claim repo is `repo_not_found`
  (out-of-claim and nonexistent look identical, so no existence leaks).
- **Write and destructive policy** live in the shell. The engine performs a
  write for anyone who can call it; the shell decides who can call it and for
  which paths.
- **Identity** is an opaque author string to the engine. The shell derives it
  from the credential and stamps it — never trusting a client-supplied author
  (except under an explicit `impersonate` grant). The engine default `"mrplex"`
  should never appear on a shell-mediated write.

## The compiled `Entitlement` — the stable seam

Every authentication front resolves a credential to a principal id, then
`compile(policy, principalId)` produces one tuple:

```
Entitlement = {
  author:      string        // stamped on writes
  read:        ScopeClaim[]   // forwarded verbatim as ctx.scope
  write:       ScopeClaim[]   // enforced BY THE SHELL against write paths
  maintain:    boolean        // links.backfill, live links.repair (expensive non-delete)
  destructive: boolean        // repos.create/rename/delete/set_*_config (implies maintain)
  impersonate: boolean        // may supply a caller-chosen author
}
```

The guard consumes *only* this tuple; the fronts compile *to* it. Neither side
knows the other exists, so a future policy store (SQLite, an IdP's groups,
capability tokens) replaces the loader behind `compile()` without touching the
guard, the fronts, or the engine.

`ScopeClaim` is the engine's direction-neutral claim type — `{ repo, paths }`.
A claim names territory; the field it sits in supplies the direction. `read`
claims become `ctx.scope`; `write` claims are matched locally by the guard using
the engine's own gitignore-glob dialect (`kernel/auth/glob.ts`, imported — not
reimplemented).

## Policy file

Declarative YAML, diffable and commentable, loaded at startup and reloaded on
`SIGHUP`. A **grant** `{ repo, read?, write? }` is the human-facing vocabulary —
it pairs a repo pattern with path globs per direction; `compile()` splits it
into the two claim lists. Roles are grant bundles plus the op-level booleans; a
principal's entitlement is the union of its roles. `destructive` implies
`maintain` at compile time.

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
  maintainer:
    grants:
      - { repo: "*", read: "**", write: "**" }
    maintain: true
  operator:
    grants:
      - { repo: "*", read: "**", write: "**" }
    destructive: true

principals:
  brendan:
    author: Brendan Baldwin <brendan@example.com>
    roles: [operator]
    keys:
      - sha256:9f2c...          # laptop CLI, minted 2026-08-21
    oidc: { email: brendan@example.com }
  ingest-bot:
    author: ingest-bot <bots@example.com>
    roles: [editor]
    keys:
      - sha256:41aa...          # k8s cron, rotate quarterly
```

There is no deny rule and no precedence — negated globs (`!pattern`) inside a
list cover carve-outs. A principal needs either a static `author` or an `oidc`
binding from which one can be derived; a principal with neither is rejected at
load, where the operator can see it.

## Write enforcement rules (what the guard replays)

- A `put` that **moves** a doc checks write on **both** the source path and the
  destination path.
- **System-sigil paths** (`:deleted/…`) are skipped — the kernel's `validatePath`
  owns that namespace.
- **Write does not imply read**: writes forward with the derived author and *no*
  read scope, so a write-only grant works even where the caller can't see.
- Every authenticated call is audited by the guard's one choke point.

## Authentication fronts

1. **API keys.** High-entropy shell-generated secrets, stored as `sha256:<hex>`
   hashes **in the policy file** — no key database. `mrplex key mint <principal>`
   prints the plaintext once and appends the hash. Revocation is deleting the
   line. Presented as `Authorization: Bearer <key>`.
2. **OIDC (JWT).** Verify the token against the IdP's JWKS (issuer + audience
   pinned), then match a principal by its `oidc.sub` / `oidc.email` binding.
   Where the principal has no static author, derive `name <email>` from the
   claims. `mrplex login` runs the OAuth device flow and caches the token for
   `mcp-stdio --token`. The shell is the OAuth **resource server**; the IdP is
   the authorization server.

A bearer is tried as an API key first (no I/O), then as a JWT when an OIDC
verifier is configured.

### Credential delivery: header vs. URL path

The credential normally arrives in the `Authorization: Bearer <token>` header.
The embedded `serve` also accepts it as a **URL path prefix** —
`https://host/k/<token>/mcp`, `https://host/k/<token>/repos/...` — for clients
that can set a URL but not a header (some MCP connectors, ChatGPT among them).
The `<token>` is the *same* credential (an API key or a JWT); nothing about
issuance, hashing, or revocation changes. The shell strips the `/k/<token>`
prefix before routing, so the rest of the pipeline is identical to the header
path, and the header still wins when both are present.

**Security note — this trades header-secrecy for path-secrecy.** Under HTTPS the
full path is inside the TLS envelope, so no network observer sees the token, and
MCP is server-to-server (no browser/referrer leakage). mrplex rewrites `req.url`
to the clean form *before* anything routes or logs on it, so its own logs and
audit records never contain the token. **But an upstream reverse proxy or
ingress may log the original request line, including the secret** — so prefer
the header where the client allows it, and if you use the path form, ensure any
fronting proxy scrubs `/k/<token>` from its access logs (or don't log paths). A
leaked path-token is a leaked key: rotate it with `key mint` and drop the old
hash from the policy.

Operator walkthrough (zo.computer + ChatGPT connectors):
[../remote-http-mcp.md](../remote-http-mcp.md).

## Deployment shapes

### Embedded (primary) — `mrplex serve --policy policy.yaml`

One process. Open the database, `createKernel`, and mount mrplex's own REST +
MCP surfaces on top of **per-request guarded kernels**. There is no engine
listener at all, so there is **no trusted-header problem** and no second process.
Prefer this.

```
client --bearer--> [ serve --policy ]
                     authenticate → compile → guardKernel → REST/MCP dispatch
```

### Launcher — `mrplex mcp-stdio --policy policy.yaml`

A guarded stdio MCP session over a local database. The credential arrives via
`--principal <id>` (trust-by-spawn — the parent already authenticated),
`MRPLEX_SHELL_KEY` / `--key`, or `MRPLEX_SHELL_TOKEN` / `--token` (an OAuth JWT).
All converge on the same `credential → principal → compile → guardKernel`
pipeline.

### Fronting proxy — `mrplex proxy --policy policy.yaml --upstream <unix|loopback>`

For polyglot/containerized topologies that must run the engine separately. The
proxy is mrplex-aware (not a generic reverse proxy): it classifies each REST
route and enforces write/destructive policy route-side — the URL path is
authoritative for writes, so both-endpoints on `MOVE` works without a kernel
handle. Then it:

- **strips all inbound `X-Mrplex-*` headers** (mandatory — the engine trusts
  them unconditionally, so a client must never set its own identity),
- **injects** the entitlement's `X-Mrplex-Author` + `X-Mrplex-Scope`,
- forwards to the upstream (which must bind a unix socket or loopback only).

MCP over the proxy is **refused**: MCP tool args are opaque to path-level policy
(a `docs_put` carries a version id, not a source path), so authenticated MCP
must use embedded mode.

```
client --bearer--> [ proxy --policy ] --X-Mrplex-*--> [ engine on unix/loopback ]
                     authenticate → route-classify → strip+inject
```

## The header-injection contract

`X-Mrplex-Author` and `X-Mrplex-Scope` are the raw engine's shell-injection
path, and it trusts them **unconditionally**. Therefore:

- The raw engine (`serve --unsafe`) must never be exposed to a network where a
  client could set these headers. Bind loopback or a unix socket and front it.
- The proxy strips any client-supplied `X-Mrplex-*` before injecting its own.
- The embedded shell never uses headers for identity at all — it derives the
  context from the credential and hands the surface a guarded kernel, so there
  is nothing to forge.

## What's out (deliberately)

- No user/token database — principals and key hashes live in the policy file;
  OIDC users live in the IdP.
- No ReBAC / relationship graphs — path globs are the vocabulary.
- No capability tokens (macaroons/Biscuits) yet — the `Entitlement` seam is
  where a verifier would plug in later.
- No CEL policy predicates yet — static grants first; a CEL escape hatch is
  additive later.
- TLS, rate limiting, and admin UI belong to whatever ingress fronts the shell.
