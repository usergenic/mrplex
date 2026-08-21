/**
 * Embedded serve — the shell's primary mode (auth-shell plan §1 "Serve mode:
 * embedded", WS3).
 *
 * One process: open the database, `createKernel`, and mount mrplex's own REST +
 * MCP surfaces on top of PER-REQUEST guarded kernels. There is no engine
 * listener at all — so there is no trusted-header problem and no second
 * process. Each request:
 *   1. carries a credential (today: an API key as `Authorization: Bearer`);
 *   2. the shell resolves it to a principal, `compile()`s the entitlement
 *      (cached per principal, invalidated on policy reload),
 *   3. `guardKernel()`s the shared kernel with that entitlement + an audit sink,
 *   4. and the surface dispatches against the guarded kernel.
 *
 * The surfaces accept a `kernelForRequest` factory (WS0's generalization), so
 * this file is pure composition: no surface code is forked, and all write /
 * destructive / author policy lives in the guard.
 *
 * Policy is reloadable on SIGHUP: the loader swaps the in-memory policy and
 * clears the entitlement cache, so a running server picks up a key revocation
 * or grant change without a restart. The credential→principal→entitlement
 * pipeline is otherwise identical to the stdio and (future) proxy fronts —
 * they differ only in how the credential arrives.
 */

import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type EmbedConfig, createHookFromConfig, describeEmbedConfig } from "../embed/config.js";
import type { EmbedHook } from "../embed/hook.js";
import { type Worker, createWorker } from "../embed/worker.js";
import { type Kernel, createKernel } from "../kernel/kernel.js";
import { HARDCODED_DEFAULTS, type PathConfig } from "../kernel/path-config.js";
import { mountMcpStreamableHttp } from "../mcp/server.js";
import { mountRestSurface } from "../rest/routes.js";
import { HttpResponseError } from "../server/http-error.js";
import { openStorage } from "../storage/registry.js";
import type { Storage } from "../storage/types.js";
import { type AuditSink, guardKernel } from "./guard.js";
import { bearerToken, principalForKey } from "./keys.js";
import { type Entitlement, type Policy, compile, loadPolicyFile } from "./policy.js";

export type ShellServeConfig = {
  database: string;
  /** Path to the YAML policy file. Loaded at startup, reloaded on SIGHUP. */
  policyPath: string;
  host?: string;
  port?: number;
  serverPathConfig?: PathConfig;
  embed?: EmbedConfig;
  /** Audit-log path. When set, every authenticated call appends a JSONL line. */
  auditPath?: string;
  /** Factory for the audit sink — injectable for tests; defaults to file JSONL. */
  auditSinkFor?: (principal: string) => AuditSink;
  log?: (msg: string) => void;
};

export type ShellServeHandle = {
  server: Server;
  storage: Storage;
  kernel: Kernel;
  port: number;
  host: string;
  baseUrl: string;
  embed: { hook: EmbedHook; worker: Worker } | null;
  /** Re-read the policy file and clear the entitlement cache. Called on SIGHUP. */
  reloadPolicy: () => void;
  close: () => Promise<void>;
};

/**
 * Authenticate a request to a principal id, or null when no/invalid credential
 * is presented. Today the only front is an API key as a bearer token; OIDC
 * (WS5) plugs in here by trying the JWT path when the bearer isn't a known key.
 */
function principalForRequest(policy: Policy, req: IncomingMessage): string | null {
  const key = bearerToken(headerValue(req.headers.authorization));
  if (key === null) return null;
  return principalForKey(policy, key);
}

function headerValue(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

export async function startShellServer(config: ShellServeConfig): Promise<ShellServeHandle> {
  let policy = loadPolicyFile(config.policyPath);

  const embedCfg: EmbedConfig = config.embed ?? { kind: "none" };
  const hook = createHookFromConfig(embedCfg);
  const storage: Storage = await openStorage(config.database);
  const kernel = createKernel({
    storage,
    serverPathConfig: config.serverPathConfig ?? HARDCODED_DEFAULTS,
    onVersionCommitted: async (versionId) => {
      await storage.backlog_enqueue(versionId);
    },
    queryEmbed: hook
      ? async (rank: string) => {
          const resp = await hook.embed([rank]);
          const vector = resp.vectors[0];
          if (!vector) throw new Error("embed hook returned no vector for query string");
          return { vector, model: resp.model, dim: resp.dim };
        }
      : undefined,
  });
  const worker = hook ? createWorker({ storage, hook }) : null;

  // Per-principal entitlement cache — compile() is pure but not free, and a
  // busy principal hits it every request. Cleared wholesale on policy reload.
  let entitlementCache = new Map<string, Entitlement>();
  function entitlementFor(principalId: string): Entitlement {
    const cached = entitlementCache.get(principalId);
    if (cached) return cached;
    const e = compile(policy, principalId);
    entitlementCache.set(principalId, e);
    return e;
  }

  const auditSinkFor = config.auditSinkFor;

  /** The shell's per-request kernel: authenticate → compile → guard. */
  function kernelForRequest(req: IncomingMessage): Kernel {
    const principalId = principalForRequest(policy, req);
    if (principalId === null) {
      throw new HttpResponseError(401, "unauthorized", {
        reason: "missing or invalid credential",
      });
    }
    const entitlement = entitlementFor(principalId);
    const audit = auditSinkFor?.(principalId);
    return guardKernel(kernel, entitlement, audit);
  }

  const host = config.host ?? "127.0.0.1";
  const port = config.port ?? 8321;

  const mcp = await mountMcpStreamableHttp({ kernel, storage, kernelForRequest });
  const rest = mountRestSurface({ kernel, storage, kernelForRequest });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (url === "/mcp" || url.startsWith("/mcp?")) {
      mcp.handle(req, res).catch((err: unknown) => writeInternalError(res, err));
      return;
    }
    rest.handle(req, res).catch((err: unknown) => writeInternalError(res, err));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const boundPort = (server.address() as AddressInfo).port;
  const baseUrl = `http://${formatHost(host)}:${boundPort}`;

  const log = config.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  log(`mrplex: serving (authenticated) on ${baseUrl}`);
  log(`mrplex:   policy ${config.policyPath}`);
  log(`mrplex:   REST   ${baseUrl}/repos, /query, ...`);
  log(`mrplex:   MCP    ${baseUrl}/mcp  (Streamable HTTP)`);
  log(`mrplex:   embed  ${describeEmbedConfig(embedCfg)}`);
  if (config.auditPath) log(`mrplex:   audit  ${config.auditPath}`);

  worker?.start();

  function reloadPolicy(): void {
    try {
      policy = loadPolicyFile(config.policyPath);
      entitlementCache = new Map();
      log(`mrplex: policy reloaded from ${config.policyPath}`);
    } catch (err) {
      // A bad edit shouldn't take down a running server — keep the old policy
      // and shout. The operator fixes the file and sends SIGHUP again.
      log(`mrplex: policy reload FAILED, keeping previous: ${(err as Error).message}`);
    }
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await mcp.close().catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (worker) await worker.stop();
    await storage.close();
  };

  return {
    server,
    storage,
    kernel,
    port: boundPort,
    host,
    baseUrl,
    embed: hook && worker ? { hook, worker } : null,
    reloadPolicy,
    close,
  };
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function writeInternalError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`mrplex: internal error: ${message}\n`);
  res.statusCode = 500;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ code: "internal_error", data: {} }));
}
