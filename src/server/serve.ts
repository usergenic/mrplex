/**
 * The composition root — opens storage, runs migrations, builds the kernel,
 * mounts the REST + MCP surfaces on one node:http server, and hands back a
 * handle with a graceful `close()`.
 *
 * m3-plan WS4 sits on top of this: `mrplex serve` translates CLI flags into
 * a `startServer(config)` call and installs signal handlers.
 *
 * Kernel untouched. This file wires transport onto an existing kernel; if
 * you're looking for the write model, error catalog, or scope check, it's
 * still one level down.
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
import { openStorage } from "../storage/registry.js";
import type { Storage } from "../storage/types.js";

export type ServeConfig = {
  /** sqlite:./path.db or postgres://… */
  database: string;
  host?: string;
  /** 0 → bind an OS-chosen port (used by tests). */
  port?: number;
  serverPathConfig?: PathConfig;
  /**
   * Embedding hook config (m4-plan §5.3). Absent = worker idles, rank
   * queries return `semantic_unavailable`. See design §5.3 resolved [OPEN].
   */
  embed?: EmbedConfig;
  /** Log function for the "serving on http://…" banner. Defaults to console.error. */
  log?: (msg: string) => void;
};

export type ServeHandle = {
  server: Server;
  storage: Storage;
  kernel: Kernel;
  /** Real bound port (useful after `port: 0`). */
  port: number;
  host: string;
  /** Base URL callers can hit — e.g. `http://127.0.0.1:8321`. */
  baseUrl: string;
  /** The running embed hook + worker, if `embed` was configured. */
  embed: { hook: EmbedHook; worker: Worker } | null;
  /** Close listening socket + worker + storage. Idempotent. */
  close: () => Promise<void>;
};

/**
 * Start a fully-wired mrplex server. Returns once the socket is listening.
 * Never throws for a merely-empty database — bootstrap is a separate step.
 */
export async function startServer(config: ServeConfig): Promise<ServeHandle> {
  const embedCfg: EmbedConfig = config.embed ?? { kind: "none" };
  const hook = createHookFromConfig(embedCfg);
  // Open storage first so the enqueue callback can capture its handle.
  // Enqueue is unconditional whether or not a hook is configured
  // (m4-plan §5 decision 5) — a hookless deployment still records the
  // backlog so a later `embed backfill` doesn't have to walk history.
  const storage: Storage = await openStorage(config.database);
  const kernel = createKernel({
    storage,
    serverPathConfig: config.serverPathConfig ?? HARDCODED_DEFAULTS,
    onVersionCommitted: async (versionId) => {
      await storage.backlog_enqueue(versionId);
    },
    queryEmbed: hook
      ? async (semantic: string) => {
          const resp = await hook.embed([semantic]);
          const vector = resp.vectors[0];
          if (!vector) {
            throw new Error("embed hook returned no vector for query string");
          }
          return { vector, model: resp.model, dim: resp.dim };
        }
      : undefined,
  });
  const worker = hook ? createWorker({ storage, hook }) : null;

  const host = config.host ?? "127.0.0.1";
  const port = config.port ?? 8321;

  // Mount MCP + REST on the same node:http server. Order matters only so far
  // as MCP owns `/mcp*` and REST owns everything else; the dispatcher below
  // routes on the URL path prefix.
  const mcp = await mountMcpStreamableHttp({ kernel, storage });
  const rest = mountRestSurface({ kernel, storage });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    // Only /mcp (exact) and /mcp?<query> are routed to the MCP transport.
    // /mcp/<anything> falls through to REST so future REST routes under the
    // /mcp namespace (e.g. /mcp/manifest) aren't preempted by transport
    // framing errors. The SDK's Streamable HTTP transport only speaks at
    // /mcp itself; sub-paths are not part of its spec.
    if (url === "/mcp" || url.startsWith("/mcp?")) {
      mcp.handle(req, res).catch((err: unknown) => {
        writeInternalError(res, err);
      });
      return;
    }
    rest.handle(req, res).catch((err: unknown) => {
      writeInternalError(res, err);
    });
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
  log(`mrplex: serving on ${baseUrl}`);
  log(`mrplex:   REST   ${baseUrl}/repos, /query, ...`);
  log(`mrplex:   MCP    ${baseUrl}/mcp  (Streamable HTTP)`);
  log(`mrplex:   embed  ${describeEmbedConfig(embedCfg)}`);

  // Start the worker AFTER the "listening" log line — a fast-arriving
  // request that predates the worker still gets served; the write's
  // backlog row waits until the next drain iteration.
  worker?.start();

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    // Stop accepting new requests first, then drain the worker's
    // in-flight batch, then close storage.
    await mcp.close().catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (worker) {
      await worker.stop();
    }
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
    close,
  };
}

function formatHost(host: string): string {
  // IPv6 needs bracket-wrapping in URLs.
  return host.includes(":") ? `[${host}]` : host;
}

function writeInternalError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  // Log server-side so an operator can see what happened; don't leak the
  // detail to the client.
  process.stderr.write(`mrplex: internal error: ${message}\n`);
  res.statusCode = 500;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ code: "internal_error", data: {} }));
}
