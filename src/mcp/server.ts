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
import type { CallContext } from "../kernel/context.js";
import { KernelError } from "../kernel/errors.js";
import type { Kernel } from "../kernel/kernel.js";
import {
  type ContextForRequest,
  type KernelForRequest,
  contextFromHeaders,
} from "../server/headers.js";
import { httpErrorForThrowable } from "../server/http-error.js";
import type { Storage } from "../storage/types.js";
import { TOOL_REGISTRY, toolByName } from "./tools.js";

export type McpConfig = {
  kernel: Kernel;
  storage: Storage;
  /**
   * How each request becomes a CallContext. Defaults to reading the
   * `X-Mrplex-*` headers; an authenticating shell substitutes an
   * entitlement-derived context here.
   */
  contextForRequest?: ContextForRequest;
  /**
   * How each request obtains its Kernel. Defaults to the shared `kernel`; an
   * authenticating shell returns a per-principal guarded kernel (and may throw
   * to reject the request before the SDK parses the frame).
   */
  kernelForRequest?: KernelForRequest;
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
  const { kernel } = config;
  const contextForRequest = config.contextForRequest ?? contextFromHeaders;
  const kernelForRequest = config.kernelForRequest ?? (() => kernel);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Resolve the per-request kernel and CallContext before the SDK parses the
    // frame. Either step may throw: the shell's `kernelForRequest` rejects an
    // unauthenticated caller (HttpResponseError → its own status), and a
    // malformed X-Mrplex-Scope is a KernelError "filter_invalid" → 400. A bad
    // credential or claim is a loud error, never a silent full-access fallback.
    let reqKernel: Kernel;
    let ctx: CallContext;
    try {
      reqKernel = await kernelForRequest(req);
      ctx = await contextForRequest(req);
    } catch (err) {
      const { status, body } = httpErrorForThrowable(err);
      // A generic 500 body from a non-kernel throwable is opaque here; keep the
      // MCP-friendly filter_invalid shape for the malformed-input case.
      const payload = err instanceof KernelError ? { code: err.code, data: err.data } : body;
      res.statusCode = err instanceof KernelError ? 400 : status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(payload));
      return;
    }

    const server = buildMcpServer(reqKernel, () => ctx);
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
 * Server-level instructions surfaced to clients at `initialize`. Cross-tool
 * conventions live here; per-tool details belong in tool descriptions
 * (tools.ts) and the `query_syntax` reference. Clients vary in whether they
 * show these to the model — don't put anything here that isn't ALSO
 * discoverable through a tool description or an error message.
 */
const SERVER_INSTRUCTIONS = `mrplex is a queryable, versioned store for Markdown documents with YAML frontmatter, organized into repos.

Conventions:
- Reads (docs_get / docs_get_version) return frontmatter_raw with server-injected \`$version: <version_id>\` then \`$content_hash: <sha256>\` lines (unless raw: true). Pass that frontmatter_raw back to docs_put unchanged and prev_version_id may be omitted — the embedded $version supplies it. \`$\`-prefixed frontmatter keys are server-owned and are stripped from writes.
- Writes use optimistic concurrency: docs_put / docs_delete need the previous version id; a \`stale_prev\` error means someone else wrote first — re-read (docs_get) and retry against the new version.
- When writing frontmatter, provide exactly one of \`frontmatter\` (JSON object) or \`frontmatter_raw\` (verbatim YAML).
- \`query\` searches current documents and returns lean projected hits, not full documents. Default \`select\` is ["$path"] — each hit is only \`{ "$path": "…" }\` (no body, no frontmatter, no version id). Pass \`select\` to project more (\`$body\`, \`$repo\`, \`$version_id\`, \`$content_hash\`, \`$semantic_score\`, frontmatter keys, …). \`semantic\` activates embedding-based retrieval; add \`$semantic_score\` to \`select\` for cosine similarity (1 = identical). Call \`docs_get\` (one path) or \`docs_get_many\` (batch) to recover whole documents. The filter is CEL with \`$\`-prefixed intrinsics ($path, $updated_at, $body, $content_hash) and link-graph predicates ($in, $has, $backlinks(), $links()). Call the \`query_syntax\` tool for the full language reference before writing a non-trivial filter.
- Tool failures return an in-band error (isError: true) with a JSON object { code, data } in the text content: e.g. filter_invalid (bad query — data.reason explains, data.hint says what to consult), stale_prev (concurrency conflict), doc_not_found, semantic_unavailable (no embedding hook configured). Codes are stable; reasons are prose. Error results carry no structuredContent (tool outputSchema describes success shapes only).`;

/**
 * Build a low-level MCP Server with tools/list + tools/call handlers wired
 * up. The `getContext` closure supplies the session's CallContext at call time.
 */
function buildMcpServer(kernel: Kernel, getContext: () => CallContext): McpLowLevelServer {
  const server = new McpLowLevelServer(
    { name: "mrplex", version: "0.0.0" },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_REGISTRY.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.outputSchema !== undefined && { outputSchema: t.outputSchema }),
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
 * decision. `isError: true` with the JSON `{ code, data }` payload in the
 * text content — and deliberately NO structuredContent: tools declare
 * `outputSchema` for their success shapes, and spec-conformant clients
 * (the SDK included) validate any structuredContent present against it
 * even on error results. Error consumers parse the text channel
 * (client/remote-mcp.ts does exactly that).
 */
function toolError(payload: { code: string; data: Record<string, unknown> }) {
  const text = JSON.stringify(payload);
  return {
    isError: true,
    content: [{ type: "text" as const, text }],
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
