/**
 * Fronting proxy — auth-shell plan §1 "Serve mode: fronting proxy", WS4.
 *
 * For deployments where the engine must run separately (polyglot/containerized
 * topologies), `mrplex proxy --policy <file> --upstream <unix|url>` sits in
 * front of a raw engine bound to a unix socket or loopback. Per request it:
 *   1. authenticates the caller (bearer API key, like the HTTP front),
 *   2. classifies the REST route and enforces write/destructive policy against
 *      the entitlement — route-aware, because the URL path is authoritative for
 *      writes (see proxy-policy.ts),
 *   3. STRIPS any inbound `X-Mrplex-*` headers (mandatory — the engine trusts
 *      them unconditionally, so a client must never set its own identity),
 *   4. INJECTS the entitlement's `X-Mrplex-Author` + `X-Mrplex-Scope`,
 *   5. forwards to the upstream and streams the response back.
 *
 * Embedded serve is preferred (no second process, no header-trust surface);
 * this exists for topologies that need engine/shell separation. MCP-over-proxy
 * is read-only here: MCP tool args are opaque to path-level policy (docs_put
 * carries a version id, not a source path), so writes over `/mcp` are refused
 * with a pointer to embedded mode. REST writes are fully policed.
 */

import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
  request,
} from "node:http";
import type { AddressInfo } from "node:net";
import { claimsGrantRead, normalizeClaims } from "../kernel/auth/scope.js";
import { bearerToken, principalForKey } from "./keys.js";
import { type Entitlement, type Policy, compile, loadPolicyFile } from "./policy.js";
import { classifyRestRequest } from "./proxy-policy.js";

export type ProxyConfig = {
  policyPath: string;
  /** `unix:/path/to.sock` or `http://127.0.0.1:PORT` — the raw engine upstream. */
  upstream: string;
  host?: string;
  port?: number;
  log?: (msg: string) => void;
};

export type ProxyHandle = {
  server: Server;
  port: number;
  host: string;
  baseUrl: string;
  reloadPolicy: () => void;
  close: () => Promise<void>;
};

type Upstream = { kind: "unix"; socketPath: string } | { kind: "tcp"; host: string; port: number };

function parseUpstream(spec: string): Upstream {
  if (spec.startsWith("unix:")) {
    return { kind: "unix", socketPath: spec.slice("unix:".length) };
  }
  const url = new URL(spec);
  if (url.protocol !== "http:") {
    throw new Error(`proxy upstream must be unix:<path> or http://<loopback> — got ${spec}`);
  }
  return { kind: "tcp", host: url.hostname, port: Number(url.port || 80) };
}

/** All inbound X-Mrplex-* headers are stripped before forwarding. */
function stripMrplexHeaders(
  headers: NodeJS.Dict<string | string[]>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    if (k.toLowerCase().startsWith("x-mrplex-")) continue;
    out[k] = v;
  }
  return out;
}

export async function startProxyServer(config: ProxyConfig): Promise<ProxyHandle> {
  let policy = loadPolicyFile(config.policyPath);
  const upstream = parseUpstream(config.upstream);
  const log = config.log ?? ((m: string) => process.stderr.write(`${m}\n`));

  let entitlementCache = new Map<string, Entitlement>();
  function entitlementFor(principalId: string): Entitlement {
    const cached = entitlementCache.get(principalId);
    if (cached) return cached;
    const e = compile(policy, principalId);
    entitlementCache.set(principalId, e);
    return e;
  }

  function authenticate(req: IncomingMessage): Entitlement | null {
    const key = bearerToken(firstHeader(req.headers.authorization));
    if (key === null) return null;
    const principalId = principalForKey(policy, key);
    if (principalId === null) return null;
    return entitlementFor(principalId);
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) =>
      writeError(res, 500, "internal_error", String(err)),
    );
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const entitlement = authenticate(req);
    if (entitlement === null) {
      return writeError(res, 401, "unauthorized", "missing or invalid credential");
    }

    const url = req.url ?? "/";
    const pathname = new URL(url, "http://x").pathname;

    // MCP-over-proxy is read-only (tool args are opaque to path policy). We
    // can't tell a read tool from a write tool without parsing the JSON-RPC
    // body, so /mcp is refused entirely in proxy mode — embedded serve is the
    // supported path for authenticated MCP.
    if (pathname === "/mcp" || pathname.startsWith("/mcp?") || pathname.startsWith("/mcp/")) {
      return writeError(
        res,
        403,
        "forbidden",
        "MCP over the fronting proxy is not supported; use `mrplex serve --policy` (embedded) for authenticated MCP",
      );
    }

    // Enforce REST route policy before forwarding.
    const requirement = classifyRestRequest(
      req.method ?? "GET",
      pathname,
      firstHeader(req.headers.destination),
    );
    const denial = policyDenial(requirement, entitlement);
    if (denial !== null) return writeError(res, denial.status, denial.code, denial.reason);

    // Strip inbound identity headers, inject the entitlement's. The engine
    // trusts these unconditionally, which is exactly why the client's own
    // X-Mrplex-* were stripped above.
    const headers = stripMrplexHeaders(req.headers);
    headers["x-mrplex-author"] = entitlement.author;
    headers["x-mrplex-scope"] = JSON.stringify(entitlement.read);

    forward(req, res, headers);
  }

  function forward(
    req: IncomingMessage,
    res: ServerResponse,
    headers: Record<string, string | string[]>,
  ): void {
    const common = { method: req.method, path: req.url, headers };
    const upstreamReq =
      upstream.kind === "unix"
        ? request({ socketPath: upstream.socketPath, ...common }, (upRes) =>
            pipeResponse(upRes, res),
          )
        : request({ host: upstream.host, port: upstream.port, ...common }, (upRes) =>
            pipeResponse(upRes, res),
          );
    upstreamReq.on("error", (err) => writeError(res, 502, "bad_gateway", err.message));
    req.pipe(upstreamReq);
  }

  const host = config.host ?? "127.0.0.1";
  const port = config.port ?? 8321;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const boundPort = (server.address() as AddressInfo).port;
  const baseUrl = `http://${host.includes(":") ? `[${host}]` : host}:${boundPort}`;

  log(`mrplex: proxy (authenticated) on ${baseUrl}`);
  log(`mrplex:   policy   ${config.policyPath}`);
  log(`mrplex:   upstream ${config.upstream}`);

  function reloadPolicy(): void {
    try {
      policy = loadPolicyFile(config.policyPath);
      entitlementCache = new Map();
      log(`mrplex: policy reloaded from ${config.policyPath}`);
    } catch (err) {
      log(`mrplex: policy reload FAILED, keeping previous: ${(err as Error).message}`);
    }
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { server, port: boundPort, host, baseUrl, reloadPolicy, close };
}

/** Null = allowed. Otherwise the HTTP denial to write. */
function policyDenial(
  requirement: ReturnType<typeof classifyRestRequest>,
  entitlement: Entitlement,
): { status: number; code: string; reason: string } | null {
  switch (requirement.kind) {
    case "read":
      return null; // read scope is enforced downstream via injected X-Mrplex-Scope
    case "destructive":
      return entitlement.destructive
        ? null
        : { status: 403, code: "forbidden", reason: "destructive op not permitted" };
    case "write":
      return writeAllowed(entitlement, requirement.repo, requirement.paths)
        ? null
        : { status: 403, code: "forbidden", reason: "write outside permitted scope" };
    case "unknown":
      // A route we don't model must not be forwarded blind — it could be an
      // unpoliced write. Refuse; add the route to the classifier if it's real.
      return { status: 403, code: "forbidden", reason: "route not recognized by the proxy" };
  }
}

/**
 * True iff the entitlement's write scope covers EVERY path (both-endpoints on a
 * move). Reuses the guard's exact matcher semantics. Sigil paths are the
 * engine's to police (validatePath), so they pass at the policy layer.
 */
function writeAllowed(entitlement: Entitlement, repo: string, paths: string[]): boolean {
  const matchers = normalizeClaims(entitlement.write);
  return paths.every((p) => isSystemPath(p) || claimsGrantRead(matchers, repo, p));
}

function isSystemPath(path: string): boolean {
  return path.split("/").some((seg) => seg.startsWith(":"));
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

function pipeResponse(upRes: IncomingMessage, res: ServerResponse): void {
  res.statusCode = upRes.statusCode ?? 502;
  for (const [k, v] of Object.entries(upRes.headers)) {
    if (v !== undefined) res.setHeader(k, v);
  }
  upRes.pipe(res);
}

function writeError(res: ServerResponse, status: number, code: string, reason: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ code, data: { reason } }));
}
