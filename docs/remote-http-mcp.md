# Remote HTTP MCP (ChatGPT, zo.computer, and friends)

Local agents (Cursor, Claude Desktop, Claude Code) can spawn `mrplex mcp-stdio`.
ChatGPT and most public "custom connector" UIs cannot — they only speak to a
**remote HTTPS** MCP endpoint over Streamable HTTP. This guide covers that path:
run `mrplex serve` behind a public URL, authenticate with an API key, and plug
the `/mcp` surface into connectors that have no custom headers and no appetite
for a full OAuth dance.

The concrete host here is [zo.computer](https://www.zo.computer) — a personal
Linux box with long-lived **Services**, HTTPS, and a stable public URL. The same
pattern works on any host that can keep a process running and terminate TLS in
front of it (a VPS, Fly, a home lab with a tunnel).

## What you end up with

1. A policy-guarded `mrplex serve` listening on a local port.
2. A public HTTPS URL that reaches that process.
3. An API key minted for a day-to-day principal (not an OIDC login).
4. A connector URL of the form:

```text
https://<your-public-host>/k/<api-key>/mcp
```

That last form is the important bit. Most connector UIs let you paste a URL.
Many of them do **not** let you set `Authorization: Bearer …`, and wiring OAuth
for a personal second brain is more ceremony than the job needs. mrplex accepts
the same credential as a **URL path prefix** so the connector can stay on
"no authentication" while the key still rides inside the TLS envelope.

## Why not `serve --unsafe`?

`--unsafe` is full-trust: whoever can hit the port can do anything. Fine for a
laptop-bound stdio session. Wrong for anything on a public Zo URL. Use
`--policy` and mint keys.

## 1. Prepare the store on the host

On the Zo (or any Linux host), install Node 20.11+ and mrplex, then scaffold
auth and a database somewhere persistent:

```sh
npm install -g mrplex

mkdir -p ~/mrplex && cd ~/mrplex
mrplex policy create policy.yaml --principal agent
mrplex key mint agent --policy policy.yaml    # prints the plaintext once — save it
mrplex key mint admin --policy policy.yaml    # optional: repo create/delete

# create a repo (CLI talks to the DB file directly — stop serve first if it holds the file open)
export MRPLEX_DATABASE=sqlite:./mrplex.db
mrplex repos create notes
mrplex config set-repo notes
```

`key mint` prints the plaintext **once** and appends only the hash to the policy
file. Copy the agent key somewhere you can paste into a connector URL; treat it
like a password.

If you already have notes on the Zo filesystem, load them while nothing else
holds the SQLite file open (or sync later against the running server with
`--server` + `--token`):

```sh
mrplex sync ~/Notes --once --database sqlite:./mrplex.db
```

## 2. Register an HTTP service on Zo

Zo keeps long-running processes alive across restarts via **Services**
([docs](https://www.zo.computer/docs/services)). Create one with:

| Setting | Value |
| --- | --- |
| Label | `mrplex` (or similar) |
| Mode | `http` |
| Visibility | **public** (`*.zocomputer.io`) — private Zo URLs require Zo sign-in and will not work for ChatGPT |
| Local port | e.g. `8321` (Zo injects this as `$PORT`) |
| Working directory | `/home/workspace/mrplex` (or wherever you put the files) |
| Entrypoint | see below |

mrplex does not read `$PORT` on its own, so pass it explicitly. Bind loopback;
Zo's HTTP proxy reaches the local port for you:

```sh
mrplex serve \
  --policy ./policy.yaml \
  --database sqlite:./mrplex.db \
  --audit ./audit.jsonl \
  --host 127.0.0.1 \
  --port "$PORT"
```

Ask Zo to register that as a service, or do it from the Sites → Services tab.
When it comes up you get a public HTTPS base URL, something like:

```text
https://mrplex-<your-handle>.zocomputer.io
```

Prefer the **HTTP Proxy URL** for MCP. Smoke-test from anywhere:

```sh
# header form (CLI, curl, clients that can set Authorization)
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer <api-key>" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  "https://mrplex-<your-handle>.zocomputer.io/mcp"

# path form (what ChatGPT-style connectors will use)
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  "https://mrplex-<your-handle>.zocomputer.io/k/<api-key>/mcp"
```

A successful initialize is not a 401/404. Exact status codes depend on the MCP
SDK framing; what you care about is "auth accepted and `/mcp` routed."

## 3. The `/k/<token>/…` credential prefix

Normally the credential is `Authorization: Bearer <token>`. Embedded `serve`
also accepts:

```text
https://host/k/<token>/mcp
https://host/k/<token>/repos/...
```

`<token>` is the **same** API key (or JWT) the header would carry — issuance,
hashing, and revocation are unchanged. The shell peels `/k/<token>` off the
path before routing or logging, so mrplex's own logs and audit lines never see
the secret. When both a header and a path token are present, the header wins.

**Use the path form when the client can set a URL but not a header.** That is
the common case for ChatGPT custom connectors and similar public API UIs. Prefer
the header whenever the client allows it.

### Security trade-off

Under HTTPS the path is inside the TLS envelope, so network observers do not see
the key, and MCP is server-to-server (no browser referrer leakage). **But an
upstream reverse proxy or ingress may log the original request line**, including
the secret. Zo's access logs are the thing to watch here — if paths are logged,
rotate the key (`key mint` a new one, delete the old hash from the policy,
`kill -HUP` the serve process or restart the service) after any suspicion of
leakage. A leaked path-token is a leaked key.

Full detail: [archive/security.md](archive/security.md) § "Credential delivery:
header vs. URL path".

## 4. Plug into ChatGPT

ChatGPT only talks to **remote HTTPS** MCP servers (no local stdio). On a paid
plan with Developer Mode:

1. Settings → Apps & Connectors → Advanced → enable **Developer Mode**.
2. Create a connector.
3. Set the connector URL to:

   ```text
   https://mrplex-<your-handle>.zocomputer.io/k/<api-key>/mcp
   ```

4. Set authentication to **None** (the key is already in the path). If the UI
   offers a working **Token** field that becomes an `Authorization` header, use
   `https://…/mcp` plus that token instead — same key, cleaner delivery.
5. Create the connector, open a new chat, enable it, and ask something that
   forces a tool call ("list my mrplex repos" / "query notes for …").

After you change the server's tool set, re-scan or refresh tools in the ChatGPT
UI — metadata does not always pick up automatically.

Menu labels move; if Developer Mode is not under Apps & Connectors → Advanced,
check Security / login settings in the current OpenAI help center.

## 5. Other remote clients

Same HTTPS base, same choice of header vs `/k/…`:

| Client | Typical setup |
| --- | --- |
| ChatGPT custom connector | `/k/<key>/mcp`, auth None (or Token + `/mcp` if headers work) |
| Grok / other HTTP MCP connectors | same URL; avoid relying on mobile live-voice surfaces for MCP |
| CLI against the remote | `mrplex --server https://host --token <key> query …` |
| Local stdio bridge | `mrplex mcp-stdio --server https://host --token <key>` |

OIDC (`mrplex login`, `--oidc-issuer`) remains available when you want IdP-backed
principals. For a personal Zo + ChatGPT loop, a minted API key is enough and
avoids standing up a resource-server OAuth client.

## 6. Keeping the Markdown folder warm

`serve` holds the database. A separate **process**-mode Zo service (no public
URL) can run a long-lived sync against the same files and a remote server:

```sh
mrplex sync ~/Notes \
  --server "https://mrplex-<your-handle>.zocomputer.io" \
  --token "<api-key>"
```

Or sync in-process on a schedule with `--once` from cron. Process-mode services
do not count against Zo's hosted HTTP quota.

## Checklist

- [ ] `policy.yaml` + minted `agent` key (plaintext saved once)
- [ ] `mrplex serve --policy … --port "$PORT"` registered as a **public** Zo HTTP service
- [ ] Smoke-test `/mcp` with Bearer and `/k/<key>/mcp` without
- [ ] ChatGPT connector URL uses `/k/<key>/mcp` (or Token + `/mcp`)
- [ ] Never put `--unsafe` on the public URL
- [ ] Know how you will rotate the key if a proxy log leaks the path

## See also

- README § "Connect an agent" / "Access control"
- [archive/security.md](archive/security.md) — keys, OIDC, `/k/<token>`, deployment shapes
- [zo.computer Services](https://www.zo.computer/docs/services)
