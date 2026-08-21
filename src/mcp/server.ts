/**
 * MCP surface — design §6.2, noauth plan §4.
 *
 * Protocol-true MCP via `@modelcontextprotocol/sdk`. Streamable HTTP runs
 * **stateless**: no server-side session store. There is no per-request auth —
 * mrplex trusts its caller (design §8). Each request's CallContext is read from
 * the `X-Mrplex-*` headers, which a fronting shell injects (a proxy can set
 * headers but not rewrite tool arguments — so headers are the injection path).
 *
 * STDIO binds one launch-time CallContext for the whole session (no per-request
 * header channel); `--author` / `--scope` launch flags pin it (noauth plan §4).
 *
 * We use the lower-level `Server` class (not `McpServer`) so tool schemas
 * can be plain JSON Schema — no Zod runtime dependency (tools.ts).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Server as McpLowLevelServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type CallContext, parseScopeClaims } from "../kernel/context.js";
import { KernelError } from "../kernel/errors.js";
import type { Kernel } from "../kernel/kernel.js";
import type { Storage } from "../storage/types.js";
import { TOOL_REGISTRY, toolByName } from "./tools.js";

export type McpConfig = {
  kernel: Kernel;
  storage: Storage;
};

/**
 * Build a CallContext from the `X-Mrplex-*` request headers. Malformed scope
 * JSON throws — a bad claim is a loud client error, not a silent full-access
 * fallback (see [[scope-claim-semantics]]).
 */
export function contextFromHeaders(req: IncomingMessage): CallContext {
  const ctx: CallContext = {};
  const author = headerValue(req.headers["x-mrplex-author"]);
  if (author !== undefined) ctx.author = author;
  const scope = headerValue(req.headers["x-mrplex-scope"]);
  if (scope !== undefined) ctx.scope = parseScopeClaims(scope);
  return ctx;
}

function headerValue(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  const s = Array.isArray(v) ? v[0] : v;
  return s !== undefined && s.length > 0 ? s : undefined;
}

export type McpMount = {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  close: () => Promise<void>;
};

/**
 * Mount an MCP surface as a Streamable-HTTP request handler.
 *
 * We create a fresh Server + StreamableHTTPServerTransport pair PER REQUEST.
 * That's the SDK's supported "stateless" mode: session-less, so state
 * cannot accumulate between calls, and multi-instance deployments (§7.1)
 * work without a shared session store.
 */
export async function mountMcpStreamableHttp(config: McpConfig): Promise<McpMount> {
  const { kernel } = config;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Read the per-request CallContext from headers. A malformed X-Mrplex-Scope
    // is a client error — refuse before the SDK parses the frame.
    let ctx: CallContext;
    try {
      ctx = contextFromHeaders(req);
    } catch (err) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          code: "filter_invalid",
          data: { reason: err instanceof Error ? err.message : String(err) },
        }),
      );
      return;
    }

    const server = buildMcpServer(kernel, () => ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless per m3-plan decision 3
      enableJsonResponse: true,
    });

    res.on("close", () => {
      // Best-effort — SDK also cleans up on its own.
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  async function close(): Promise<void> {
    // Per-request instances handle their own close; nothing global to tear down.
  }

  return { handle, close };
}

/**
 * Build a low-level MCP Server with tools/list + tools/call handlers wired
 * up. The `getContext` closure supplies the session's CallContext at call time.
 */
function buildMcpServer(kernel: Kernel, getContext: () => CallContext): McpLowLevelServer {
  const server = new McpLowLevelServer(
    { name: "mrplex", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_REGISTRY.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const tool = toolByName(name);
    if (!tool) {
      // Use filter_invalid (a real KernelErrorCode) rather than a fabricated
      // "internal_error" — clients that rehydrate KernelError from the
      // in-band payload should always see codes from the stable catalog.
      return toolError({
        code: "filter_invalid",
        data: { reason: `unknown tool: ${name}` },
      });
    }
    try {
      const result = await tool.handler(kernel, getContext(), args);
      return {
        content: [{ type: "text" as const, text: result.text }],
        structuredContent: result.structured,
      };
    } catch (err) {
      if (err instanceof KernelError) {
        return toolError({ code: err.code, data: err.data as Record<string, unknown> });
      }
      // Non-kernel throwable — surface as filter_invalid too, since a real
      // internal server error would 500 at the transport, not in-band.
      return toolError({
        code: "filter_invalid",
        data: { reason: (err as Error).message ?? String(err) },
      });
    }
  });

  return server;
}

/**
 * Package a KernelError as an in-band tool error per §6.2 / m3-plan
 * decision. `isError: true`, JSON body in the content, mirrored in
 * structuredContent so agents that read the structured form still see it.
 */
function toolError(payload: { code: string; data: Record<string, unknown> }) {
  const text = JSON.stringify(payload);
  return {
    isError: true,
    content: [{ type: "text" as const, text }],
    structuredContent: payload as Record<string, unknown>,
  };
}

// -----------------------------------------------------------------------------
// STDIO transport (--mcp-stdio) — one CallContext for the whole session. In
// stdio mode the parent process IS the shell (noauth plan §2), so the launch-
// time --author / --scope flags pin the session context.
// -----------------------------------------------------------------------------

export type StdioMount = {
  server: McpLowLevelServer;
  transport: StdioServerTransport;
  close: () => Promise<void>;
};

export async function startMcpStdio(config: {
  kernel: Kernel;
  context?: CallContext;
}): Promise<StdioMount> {
  const ctx = config.context ?? {};
  const server = buildMcpServer(config.kernel, () => ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return {
    server,
    transport,
    close: async () => {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
}
