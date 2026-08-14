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
import { type Kernel, createKernel } from "../kernel/kernel.js";
import { HARDCODED_DEFAULTS, type PathConfig } from "../kernel/path-config.js";
import { mountMcpStreamableHttp } from "../mcp/server.js";
import { mountRestSurface } from "../rest/routes.js";
import { sqliteAdapter } from "../storage-sqlite/adapter.js";
import type { Storage } from "../storage/types.js";

export type ServeConfig = {
  /** sqlite:./path.db or postgres://… */
  database: string;
  host?: string;
  /** 0 → bind an OS-chosen port (used by tests). */
  port?: number;
  serverPathConfig?: PathConfig;
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
  /** Close listening socket + storage. Idempotent. */
  close: () => Promise<void>;
};

function normalizeDatabase(url: string): string {
  if (url.startsWith("sqlite:") || url.startsWith("postgres:")) return url;
  return `sqlite:${url}`;
}

/**
 * Open storage, migrate, create the kernel. Split out so tests can inject a
 * pre-built kernel if they want to bypass the sqlite adapter.
 */
export function openAndMigrate(
  database: string,
  serverPathConfig?: PathConfig,
): {
  storage: Storage;
  kernel: Kernel;
} {
  const storage = sqliteAdapter.open({ database: normalizeDatabase(database) });
  storage.migrate();
  const kernel = createKernel({
    storage,
    serverPathConfig: serverPathConfig ?? HARDCODED_DEFAULTS,
  });
  return { storage, kernel };
}

/**
 * Start a fully-wired mrplex server. Returns once the socket is listening.
 * Never throws for a merely-empty database — bootstrap is a separate step.
 */
export async function startServer(config: ServeConfig): Promise<ServeHandle> {
  const { storage, kernel } = openAndMigrate(config.database, config.serverPathConfig);
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
  log(`mrplex:   REST   ${baseUrl}/repos, /users, /query, /me/tokens, ...`);
  log(`mrplex:   MCP    ${baseUrl}/mcp  (Streamable HTTP)`);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await mcp.close().catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    storage.close();
  };

  return { server, storage, kernel, port: boundPort, host, baseUrl, close };
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
