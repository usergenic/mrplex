# M3 Implementation Plan — HTTP Surfaces (MCP + REST)

Target: milestone **M3** from [design.md §10](design.md): *MCP server at `/mcp` (Streamable HTTP; optional STDIO transport, startup-gated); REST surface (`GET` / `PUT` / `DELETE` / `MOVE`, `If-Match` / `If-None-Match`, content negotiation, `/versions` / `/history` routes). CLI gains `--server` flag to target a remote instance over MCP.*

M3 puts the kernel on the network. M0–M2 built a complete local kernel — reads, writes, auth, query — reachable only in-process via the CLI. M3 adds the two HTTP surfaces from §6: a **protocol-true MCP server** at `/mcp` (the primary interface for LLM agents) and a **resource-oriented REST surface** (the primary interface for humans, `curl`, and HTTP-ecosystem tooling). Both are thin translation layers over the existing kernel — per §6.1, the kernel remains the only place the write model, concurrency rules, and error catalog live. One contract note: `kernel.docs.diff` (§6.1) was never shipped in M0–M2 and is deliberately **not** built here either — it defers to M4 (see Scope), keeping M3 purely surface work with zero kernel changes.

## 1. Scope

**In:**

- **MCP surface at `/mcp`** (§6.2): protocol-true Model Context Protocol over **Streamable HTTP** — lifecycle (`initialize`, capability negotiation), `tools/list` / `tools/call`, one tool per kernel op with a JSON Schema input definition. Tool results carry `structuredContent` (the §6.4 wire types) plus a text rendering. Kernel errors return **in-band** as tool errors (`isError: true` with `{ code, data }` in the content) so an agent can read `stale_prev` and retry with the attached current version; JSON-RPC protocol errors are reserved for transport/envelope problems.
- **STDIO transport** — off by default, enabled via `--mcp-stdio`. Binds the whole session to one launch-time token (`--token` / `MRPLEX_TOKEN`) per §6.2; every call runs as that token's actor.
- **REST surface** (§6.3): the full route table — repos, users, docs (with sibling roots `/versions`, `/history`), `/query` (GET + POST), `/me/tokens`. `version_id` as ETag; `If-Match` → `prev_version_id`; `PUT` + `If-None-Match: *` → create; `MOVE` with `Destination` header (same-repo only); `DELETE` idempotent per §4.1. Content negotiation on document reads (`application/json` envelope vs `text/markdown` raw round-trip) and writes (JSON body vs raw markdown split server-side). Kernel-error → HTTP-status mapping per §6.3's table.
- **Auth middleware** (§8.1): `Authorization: Bearer <token>` → `sha256(secret)` → indexed lookup → resolved `Actor`. Reuses M1's `resolveActor` (`src/kernel/auth/tokens.ts`) — the same function the CLI uses today. `unauthorized` → 401, `forbidden` → 403, opportunistic `last_used_at` touch. Applies identically to REST and `/mcp` (Streamable HTTP auth is the same Bearer header, per §6.2).
- **`mrplex serve`** (§7.3): the one non-client CLI command. `--database URL --port N [--mcp-stdio]`. Starts both surfaces in one process. (No embedding worker yet — that arrives with M4; §7.1's "surfaces + worker" shape is complete then.)
- **CLI remote mode**: global `--server <url>` flag. When set, CLI commands drive `tools/call` against the remote `/mcp` instead of the in-process kernel (§7.3 — "a thin client over the MCP surface"). Transport failures exit with code 10 (the family reserved in `exit-codes.ts` since M1).
- Design's `[OPEN]` **query-response cacheability** (§6.3) resolved: GET `/query` responses carry an `ETag` (hash of the sorted `version_id` list) and support `If-None-Match` → 304. Cheap; invalidates exactly when the result set changes.

**Out (deliberately):**

- **`docs.diff`** — deferred to **M4** (design §10 amended alongside this plan). It's not load-bearing: a pure derived read whose endpoints are both fetchable via `docs.get_version`, with no schema/index/worker footprint, and the merge tooling that would consume it is already post-v1 (§11). Deferring keeps M3 single-purpose. Deferred *with* it: the `/diff/{path}` route (§6.3), the `docs_diff` tool (§6.2), and CLI `docs diff` (§7.3). The `version_not_in_document` error code stays unused until M4. Note this is a defer-within-v1, not a drop — diff remains part of the v1 surface contract.
- **WebDAV** — post-v1; fully specified in §11.1, not built here.
- **MCP resources** (`mrplex://{repo}/{path}`) — `[OPEN]` in §6.2; tools are sufficient for v1, resources are additive later.
- **Embedding worker in `serve`** — M4. `serve` starts HTTP surfaces only.
- **TLS** — deployment-owned per §8.5 (`[ASSUMPTION]`: platform edge terminates HTTPS). The server speaks plain HTTP.
- **`rank` over HTTP** — the QuerySpec field passes through and returns M2's `filter_invalid` ("rank arrives in M4") unchanged.
- **Rate limiting / request quotas** — nothing in the design requires it for v1.
- **Multi-instance coordination** — §7.1 notes multiple surface instances are already safe (concurrency is storage-enforced); nothing extra to build.

## 2. Repo layout — what M3 adds

```
src/
  server/
    serve.ts                        # composition root: storage + kernel + both surfaces → node http server
    auth.ts                         # Bearer middleware: header → sha256 → resolveActor → Actor (or 401)
    http-error.ts                   # KernelError → { status, body } per §6.3's mapping table
  mcp/
    server.ts                       # MCP lifecycle + transport wiring (Streamable HTTP at /mcp, optional STDIO)
    tools.ts                        # tool registry: one entry per kernel op — name, JSON Schema, handler
    render.ts                       # structuredContent + human-text rendering of wire types
    tools.test.ts
  rest/
    routes.ts                       # route table → kernel calls
    conditional.ts                  # If-Match / If-None-Match / ETag logic
    negotiate.ts                    # Accept / Content-Type handling; markdown split/join glue
    routes.test.ts
  client/
    kernel-client.ts                # KernelClient interface — the CLI's transport seam
    local.ts                        # in-process implementation (wraps createKernel; today's behavior)
    remote-mcp.ts                   # MCP client over Streamable HTTP (tools/call + error unwrap)
  cli/
    main.ts                         # + serve command, + --server flag
test/
  http-rest.test.ts                 # REST integration over a real listening server
  http-mcp.test.ts                  # MCP lifecycle + tools over Streamable HTTP
  cli-remote.test.ts                # CLI --server round-trip against a spawned serve
```

**Tooling additions (runtime deps):**

- **`@modelcontextprotocol/sdk`** — the official TypeScript MCP SDK, and the *only* new runtime dependency. Provides the Streamable HTTP and STDIO transports, lifecycle, and tool registration. "Protocol-true MCP" (§6.2, decision log §9) means implementing the spec's lifecycle and transport details exactly — hand-rolling that is pure liability when the reference SDK exists and is well-maintained.
- **No HTTP framework.** The REST surface is ~20 routes with two custom needs — multi-segment `{path}` params and header-driven dispatch (`If-Match`, `Accept`, `Destination`) — which framework routers don't particularly help with. A small hand-rolled router (~100 lines over `node:http`) keeps zero extra deps and full control of the §6.3 semantics; the MCP SDK's Streamable HTTP transport binds to the same `node:http` server. If M-later wants Supabase Edge Functions (§7.1, Deno), the router is fetch-API-shaped enough to port — but that's not an M3 concern. (Recorded as decision 1 in §5 below.)

## 3. Workstreams

### WS1 — Server skeleton + auth middleware

`src/server/serve.ts` — the composition root: open storage, `migrate()`, `createKernel`, mount the two surfaces on one `node:http` server. `src/server/auth.ts` — the Bearer middleware:

1. Extract `Authorization: Bearer <secret>`; missing/malformed → 401 `unauthorized`.
2. `resolveActor(secret, storage)` — the existing M1 function (hash, lookup, revoked/expired checks, `last_used_at` touch). Unknown → 401.
3. Attach the `Actor` to the request context; kernel ops authorize per-call exactly as they do for the CLI (nothing new in the kernel).

`src/server/http-error.ts` — one function `httpError(err: KernelError)` encoding §6.3's mapping table: 401/403 auth, 412 for `stale_prev`/`create_conflict` (with current `version_id` in the `ETag` response header), 409 conflicts, 404 not-founds (including `token_not_found`, absent from the design table — see §5 decision 4), 422 `version_not_in_document` (mapped now, emitted from M4), 400 validation. Body is always `{ code, data }` — the kernel error verbatim, status is just the closest HTTP match.

Acceptance: a request with no/bad token gets 401 with `{ code: "unauthorized" }`; every `KernelErrorCode` has a status; `stale_prev` responses carry the current version in both body data and `ETag`.

### WS2 — MCP surface

`src/mcp/tools.ts` — the tool registry, mirroring the kernel one-to-one per §6.2's tool list (`repos_list` … `query` — 20 tools; `docs_diff` is the one §6.2 entry deferred to M4). Each entry: underscore name, JSON Schema `inputSchema` (hand-written per tool — they're small, and the schemas ARE the agent-facing docs; descriptions crib from design.md), and a handler that calls the kernel with the request's resolved actor.

`src/mcp/server.ts` — SDK wiring:

- **Streamable HTTP at `/mcp`**, mounted on WS1's server. **Stateless mode**: no server-side session, every request authenticates via Bearer and resolves its own actor (see §5 decision 3). The kernel is synchronous and cheap; statelessness keeps multi-instance deployment (§7.1) trivial.
- **STDIO transport**, constructed only when `--mcp-stdio` is passed. Resolves the launch token once at startup; fails fast (exit 3) if it doesn't resolve. Every call runs as that actor.
- **Results**: `structuredContent` carries the §6.4 wire shape; `content` carries a compact text rendering (`src/mcp/render.ts` — reuse the CLI's pretty-print shapes where they fit).
- **Errors**: kernel errors → `isError: true`, content = JSON `{ code, data }` (also mirrored in `structuredContent`). Unknown tool / malformed envelope → JSON-RPC error, per §6.2's split.

As at the kernel, `docs_create` / `docs_put` accept exactly one of `frontmatter` | `frontmatter_raw` (§3.2) — the JSON Schemas express both properties, the kernel's existing `frontmatter-input.ts` validation enforces exactly-one.

Acceptance: an off-the-shelf MCP client (the SDK's own client) completes `initialize`, lists 20 tools with valid schemas, round-trips `docs_create` → `docs_get` → `docs_put`, and receives `stale_prev` as an in-band tool error with the current version id in `data`.

### WS3 — REST surface

`src/rest/routes.ts` — the §6.3 route table over a small router that supports multi-segment tail params (`/repos/:repo/docs/*path`). The non-obvious parts:

- **Conditional writes** (`src/rest/conditional.ts`): `PUT /repos/{repo}/docs/{path}` dispatches on headers — `If-None-Match: *` → `kernel.docs.create`; `If-Match: <version_id>` → `kernel.docs.put`; **neither → 428 Precondition Required** (see §5 decision 5; the design's write model has no unconditional write, and silently choosing one would reintroduce lost updates). `DELETE` requires `If-Match` the same way. 412 responses carry the current `version_id` as `ETag` per WS1.
- **Content negotiation** (`src/rest/negotiate.ts`): document GET honors `Accept` — `application/json` (default) returns the Version envelope; `text/markdown` returns the raw byte-exact document (via `frontmatter.join`) with `ETag: <version_id>`, honoring `If-None-Match` → 304. PUT accepts `Content-Type: application/json` (`{ frontmatter | frontmatter_raw, body }`, exactly-one rule enforced by the kernel) or `text/markdown` (server splits the leading `---` block via `frontmatter.split` and submits `{ frontmatter_raw, body }` — strict validation stays kernel-side, §3.2).
- **MOVE**: parses `Destination` (absolute URL or absolute path, per RFC 4918 §10.3), requires same repo (400 otherwise, per §6.3), requires `If-Match`, delegates to `kernel.docs.put` with unchanged content — which needs the current version's body/frontmatter, so the handler is get + put; scope-wise the kernel already enforces write-on-both-endpoints (§8.2).
- **Sibling roots**: `GET /repos/{repo}/versions/{version_id}` and `/history/{path}?limit=&before=` — straight delegations. (`/diff/{path}` joins them in M4.)
- **Query**: `GET /query` (query-string params, booleans as `true`/`false`, `repo` comma-separated per the M2 CLI convention) and `POST /query` (JSON QuerySpec) hit the same handler. GET responses carry the result-set `ETag` (§1 in-scope pin) and honor `If-None-Match`.
- **Tokens**: `GET/POST /me/tokens`, `DELETE /me/tokens/{id}` → `kernel.tokens.*`.
- **Paths on the wire** are percent-decoded per segment; the decoded path hits the kernel's existing validation (`path_invalid` does the rest).

Acceptance: integration tests drive every route against a listening server with a seeded db — the full conditional-request matrix (create-if-absent conflict → 412, stale put → 412 + ETag, fresh put → 200, missing precondition → 428), both content types in both directions (markdown round-trips byte-exact), MOVE (incl. cross-repo rejection), idempotent DELETE, 304s on doc and query reads, error-mapping spot checks.

### WS4 — `mrplex serve`

New CLI command (bypasses the client seam — it *is* the server):

```
mrplex serve [--database URL] [--port N] [--host H] [--mcp-stdio]
```

- `--database` defaults from CLI config / `MRPLEX_DATABASE` (same resolution as other commands); `--port` default 8321 (see §5 decision 6); `--host` default 127.0.0.1 (localhost-first per §7.1's embedded shape; operators bind 0.0.0.0 explicitly).
- Runs migrations, prints the listening address and mounted surfaces to stderr, serves until SIGINT/SIGTERM (graceful close).
- `--mcp-stdio` additionally binds the STDIO transport to the launch token; in this mode all logging goes to stderr (stdout belongs to the protocol).

Acceptance: `mrplex serve --database ./m3.db --port 8321` starts; `curl` hits REST; the SDK client hits `/mcp`; Ctrl-C exits cleanly; `--mcp-stdio` without a resolvable token exits 3 before binding.

### WS5 — CLI remote mode (`--server`)

The CLI currently opens storage and calls the kernel directly. WS5 introduces the transport seam:

- `src/client/kernel-client.ts` — a `KernelClient` interface mirroring the `Kernel` type minus `Actor` (the transport supplies identity: in-process resolves a token to an actor as today; remote sends the token as a Bearer header).
- `src/client/local.ts` — wraps today's storage + `createKernel` + `resolveCliActor` path. Pure refactor; no behavior change.
- `src/client/remote-mcp.ts` — MCP client (SDK) over Streamable HTTP to `<server>/mcp`. Each command → `tools/call`; `structuredContent` is the return value; `isError` results re-throw as `KernelError(code, data)` so the CLI's existing error formatting and exit-code families work unchanged. Connection/transport failures → exit 10.
- `--server <url>` global flag, default from CLI config (`mrplex config set-server URL` added alongside). Precedence: `--server` flag → config; `--database` and `--server` together is an error (pick a side).

Every existing command works over both transports. `bootstrap` stays local-only (it mints the first token; there's no credential to speak remotely yet).

Acceptance: `test/cli-remote.test.ts` spawns `serve`, runs the M1/M2 CLI flows (`repos create`, `docs create/put/delete`, `query`, `tokens create`) with `--server`, and asserts byte-identical output vs local mode; killing the server mid-command exits 10.

## 4. Sequencing

```
WS1 (server skeleton + auth) ──► WS2 (MCP surface) ──► WS5 (CLI --server)
            │                            │
            ▼                            │
        WS3 (REST surface)               │
            │                            ▼
            └──────────────────► WS4 (mrplex serve)
```

Suggested attack order: **WS1 first** (everything mounts on it). Then WS2 and WS3 in either order — they're independent after WS1, so they parallelize cleanly. WS4 once both surfaces mount; WS5 last, since remote mode needs a running server to test against.

## 5. Design decisions to pin during M3

Record in the decision log (design.md §9):

1. **No HTTP framework; hand-rolled router over `node:http`.** The route table is small and its hard parts (multi-segment paths, header dispatch) aren't framework strengths. Zero new deps beyond the MCP SDK. Alternative rejected for now: Hono (would ease a future Supabase/Deno port per §7.1, but that milestone can adopt it when it's real).
2. **MCP via the official `@modelcontextprotocol/sdk`.** "Protocol-true" (§9) is best served by the reference implementation; transports, lifecycle, and spec revisions come for free.
3. **Streamable HTTP runs stateless.** No MCP session store; every request carries Bearer auth and resolves its own actor. Matches §7.1's "multiple instances are safe for the surfaces" and §6.2's per-request auth. STDIO is the stateful exception by design (one launch-time actor).
4. **`token_not_found` → 404.** The error exists in code (M1) but not in §6.3's mapping table; it joins the not-found family. Design table gets the row.
5. **Unconditional writes are rejected: PUT/DELETE without `If-Match`/`If-None-Match` → 428 Precondition Required.** The alternative (treating bare PUT as create-or-clobber) would smuggle last-writer-wins into the strict surface; §11.1 explicitly reserves that policy for the WebDAV gateway.
6. **Default port 8321.** Arbitrary but pinned; unclaimed in the IANA registry. `--port` overrides.
7. **`docs.diff` defers from M3 to M4** (kernel op §6.1, `/diff` route §6.3, `docs_diff` tool §6.2, CLI `docs diff` §7.3). Rationale: pure derived read with no schema footprint, no v1 feature depends on it, and adding it later is strictly additive. Defer-within-v1, not a drop — §10's milestone lines amended to match.
8. **Query-response ETag ships** (resolves the §6.3 `[OPEN]`): hash of the sorted `version_id` list; `If-None-Match` → 304 on GET `/query` and `Accept: text/markdown` doc reads.
9. **`--database` and `--server` are mutually exclusive on the CLI.** One names an embedded db, the other a remote server; accepting both would silently ignore one.

## 6. Definition of done

```bash
# Fresh db, bootstrap + seed as in M1/M2, then serve.
rm -f ./m3.db
export MRPLEX_TOKEN=$(npm run --silent cli -- --database ./m3.db bootstrap)
npm run --silent seed -- --database ./m3.db
npm run --silent cli -- --database ./m3.db serve --port 8321 &

AUTH="Authorization: Bearer $MRPLEX_TOKEN"
BASE=http://127.0.0.1:8321

# REST: create via PUT + If-None-Match, read both content types
curl -sf -X PUT "$BASE/repos/notes/docs/m3/hello.md" -H "$AUTH" \
     -H 'If-None-Match: *' -H 'Content-Type: text/markdown' \
     --data-binary $'---\nstatus: draft\n---\nhello m3\n'
curl -sf "$BASE/repos/notes/docs/m3/hello.md" -H "$AUTH" -H 'Accept: text/markdown'
ETAG=$(curl -sfI "$BASE/repos/notes/docs/m3/hello.md" -H "$AUTH" | tr -d '\r' | awk -F': ' '/^etag/I {print $2}')

# Conditional update; then a stale retry must 412 with the current version in ETag
curl -sf -X PUT "$BASE/repos/notes/docs/m3/hello.md" -H "$AUTH" -H "If-Match: $ETAG" \
     -H 'Content-Type: application/json' -d '{"frontmatter":{"status":"published"},"body":"hello again"}'
curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/repos/notes/docs/m3/hello.md" \
     -H "$AUTH" -H "If-Match: $ETAG" -H 'Content-Type: application/json' -d '{"body":"stale"}'   # → 412

# History, MOVE, DELETE (idempotent), query with ETag/304
curl -sf "$BASE/repos/notes/history/m3/hello.md" -H "$AUTH"
curl -sf "$BASE/query?repo=notes&filter=status%20%3D%3D%20%22published%22" -H "$AUTH"

# MCP over Streamable HTTP: initialize, tools/list, tools/call round-trip
# (scripted with the SDK client in test/http-mcp.test.ts; smoke-checkable with curl POSTs to /mcp)

# CLI remote mode — same commands, byte-identical output to local mode
npm run --silent cli -- --server $BASE docs get notes m3/hello.md
npm run --silent cli -- --server $BASE query --repo notes --filter 'status == "published"'
```

- All routes behave per §6.3, all tools per §6.2 (minus `docs_diff`, deferred); MCP interop proven with the SDK's own client (a stand-in for "any MCP client").
- **Kernel untouched** — grep-provably no HTTP-shaped code below the surface modules (§6.1's boundary), and no kernel diffs at all this milestone.
- Full test suite green on Ubuntu + macOS × Node 20 + 22.
- Runtime deps added: `@modelcontextprotocol/sdk` — nothing else.

## 7. Risks & watchouts

- **MCP SDK protocol revisions.** The Streamable HTTP transport spec has moved before. Pin the SDK minor version; the tool registry and render layer don't touch transport details, so bumps are contained to `src/mcp/server.ts`.
- **Multi-segment `{path}` routing + percent-encoding.** `/repos/notes/docs/a%2Fb.md` vs `/repos/notes/docs/a/b.md` must not collapse: decode per segment *after* splitting, never decode-then-split. An encoded `/` inside a segment then fails kernel path validation naturally. Test explicitly.
- **`text/markdown` byte-exactness.** §3.2 promises round-trips; `frontmatter.join` is the single serializer — REST reads and (later) the WebDAV gateway's `getcontentlength` depend on it. One property test: split→join is identity on every fixture.
- **Header-based dispatch is easy to get subtly wrong.** `If-Match: *` (RFC-legal, means "exists") vs `If-Match: <etag>`; weak-validator prefixes (`W/"..."`) — reject weak, accept quoted and bare forms of the version id. Small parser, table-tested.
- **Stateless MCP vs SDK expectations.** The SDK's Streamable HTTP server supports session management by default; verify the stateless configuration doesn't degrade `initialize` semantics for picky clients. The SDK client in tests catches this; note any deviation in the plan's decision 3.
- **STDIO stdout hygiene.** Anything printed to stdout in `--mcp-stdio` mode corrupts the protocol stream. Route all human output to stderr in serve mode from day one; add a test that the stdio session survives a kernel warning.
- **CLI seam regression risk.** WS5's refactor moves every command onto `KernelClient`. The local path must be a pure mechanical wrap — run the full M0–M2 CLI test suites against the refactored local mode before touching remote.
- **`bootstrap` and `serve` bypass the seam intentionally.** Don't let the abstraction absorb them; both are storage-direct by nature and should say so in code.
- **Error fidelity across MCP.** The CLI's exit-code families depend on `code` surviving the round trip. The remote client must reconstruct `KernelError(code, data)` from tool-error content — a lossy string here breaks scripting contracts established in M1.
