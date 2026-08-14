/**
 * MCP surface — design §6.2, m3-plan §5 decisions 2 & 3.
 *
 * Protocol-true MCP via `@modelcontextprotocol/sdk`. Streamable HTTP runs
 * **stateless**: no server-side session store; every request authenticates
 * via Bearer and resolves its own actor. That matches §7.1's multi-instance
 * story and §6.2's per-request auth.
 *
 * STDIO is the deliberate exception: no per-request auth channel, so the
 * whole session is bound to one launch-time token (§6.2, m3-plan WS4).
 *
 * We use the lower-level `Server` class (not `McpServer`) so tool schemas
 * can be plain JSON Schema — no Zod runtime dependency (tools.ts).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Server as McpLowLevelServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Actor } from "../kernel/auth/actor.js";
import { KernelError } from "../kernel/errors.js";
import type { Kernel } from "../kernel/kernel.js";
import { actorFromRequest, resolveBearerActor } from "../server/auth.js";
import type { Storage } from "../storage/types.js";
import { TOOL_REGISTRY, toolByName } from "./tools.js";

export type McpConfig = {
  kernel: Kernel;
  storage: Storage;
};

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
  const { kernel, storage } = config;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Resolve actor up front — kernel errors here become in-band MCP
    // errors on `tools/call` (below), but for anything else the transport
    // handles routing. We stash the actor per-request via a closure passed
    // into the low-level Server callbacks.
    let actor: Actor | null = null;
    try {
      actor = actorFromRequest(req, storage);
    } catch (err) {
      // No token — refuse before the SDK even parses the frame. Streamable
      // HTTP auth is HTTP-native (§6.2), so returning 401 here is correct.
      const status = err instanceof KernelError && err.code === "unauthorized" ? 401 : 500;
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          code: err instanceof KernelError ? err.code : "internal_error",
          data: err instanceof KernelError ? err.data : {},
        }),
      );
      return;
    }

    const server = buildMcpServer(kernel, () => actor as Actor);
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
 * up. The `getActor` closure supplies the resolved actor at call time.
 */
function buildMcpServer(kernel: Kernel, getActor: () => Actor): McpLowLevelServer {
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
      return toolError({
        code: "internal_error" as const,
        data: { reason: `unknown tool: ${name}` },
      });
    }
    try {
      const result = tool.handler(kernel, getActor(), args);
      return {
        content: [{ type: "text" as const, text: result.text }],
        structuredContent: result.structured,
      };
    } catch (err) {
      if (err instanceof KernelError) {
        return toolError({ code: err.code, data: err.data as Record<string, unknown> });
      }
      return toolError({
        code: "internal_error" as const,
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
// STDIO transport (m3-plan WS4 --mcp-stdio) — one actor for the whole session.
// -----------------------------------------------------------------------------

export type StdioMount = {
  server: McpLowLevelServer;
  transport: StdioServerTransport;
  close: () => Promise<void>;
};

export async function startMcpStdio(config: {
  kernel: Kernel;
  storage: Storage;
  token: string;
}): Promise<StdioMount> {
  const actor: Actor = resolveBearerActor(config.token, config.storage);
  const server = buildMcpServer(config.kernel, () => actor);
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
