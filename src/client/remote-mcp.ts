/**
 * Remote KernelClient over MCP Streamable HTTP.
 *
 * Each method makes a `tools/call` against `<server>/mcp` with a Bearer
 * header. Tool errors (`isError: true`) reconstruct as `KernelError(code,
 * data)` so the CLI's error formatting and exit-code families work
 * unchanged (m3-plan WS5 risk note).
 *
 * List-shaped kernel results arrive wrapped in `{ items }` (per tools.ts
 * wrapList — MCP's structuredContent must be an object). We unwrap here so
 * the KernelClient contract is identical across transports.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallContext } from "../kernel/context.js";
import type { UnifiedDiff } from "../kernel/diff.js";
import { KernelError, isKernelErrorCode } from "../kernel/errors.js";
import type { FrontmatterInput } from "../kernel/frontmatter-input.js";
import type {
  LinksBackfillResult,
  RepairResult,
  SetLinkConfigResult,
  StaleLinkWire,
} from "../kernel/kernel.js";
import type { PathConfigOverride } from "../kernel/path-config.js";
import type { QuerySpec } from "../kernel/query/query.js";
import type { GraphResult, GraphSpec, PathWarning, Repo, Version } from "../kernel/wire.js";
import type { LinkConfigOverride } from "../links/link-config.js";
import type { HistoryOptions, KernelClient, SetPathConfigResult } from "./kernel-client.js";

export type RemoteClientConfig = {
  /** Base URL — e.g. http://127.0.0.1:8321 (no trailing /mcp). */
  server: string;
  /**
   * Default context forwarded via `X-Mrplex-*` headers on every request.
   * The shell in front of a remote server is what a proxy would inject; here
   * the CLI plays that role for its own calls.
   */
  context?: CallContext;
  /**
   * Optional bearer to forward verbatim as `Authorization: Bearer <token>`.
   * mrplex itself ignores it, but a shell fronting a remote server may want
   * it (noauth plan §1). Absent = no Authorization header.
   */
  token?: string;
};

/**
 * Connect to a remote mrplex server. Throws with `.code = "network"` (exit
 * family 10) if the transport can't connect.
 */
export async function openRemoteClient(config: RemoteClientConfig): Promise<KernelClient> {
  const url = new URL(joinUrl(config.server, "/mcp"));
  const client = new Client({ name: "mrplex-cli", version: "0.0.0" });
  const headers: Record<string, string> = {};
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  if (config.context?.author) headers["X-Mrplex-Author"] = config.context.author;
  if (config.context?.scope) headers["X-Mrplex-Scope"] = JSON.stringify(config.context.scope);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers },
  });
  try {
    await client.connect(transport);
  } catch (err) {
    const wrapped = new Error(
      `network: cannot reach mrplex server at ${config.server}: ${(err as Error).message}`,
    );
    (wrapped as unknown as { code: string }).code = "network";
    throw wrapped;
  }
  return buildRemoteClient(client);
}

function buildRemoteClient(client: Client): KernelClient {
  let closed = false;

  async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    let result: Awaited<ReturnType<typeof client.callTool>>;
    try {
      result = await client.callTool({ name, arguments: args });
    } catch (err) {
      const wrapped = new Error(`network: tool call ${name} failed: ${(err as Error).message}`);
      (wrapped as unknown as { code: string }).code = "network";
      throw wrapped;
    }
    if (result.isError === true) {
      // Content is a text block with JSON `{ code, data }`. Reconstruct.
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content.find((c: { type: string; text?: string }) => c.type === "text") as
        | { text?: string }
        | undefined;
      if (text?.text) {
        try {
          const parsed = JSON.parse(text.text) as {
            code?: string;
            data?: Record<string, unknown>;
          };
          if (typeof parsed.code === "string") {
            const data = (parsed.data ?? {}) as Record<string, unknown>;
            // Validate the remote's `code` against the local catalog before
            // rehydrating — a rogue server (or a version drift) shouldn't be
            // able to inject unknown codes that break exhaustive switches.
            if (isKernelErrorCode(parsed.code)) {
              throw new KernelError(parsed.code, data);
            }
            throw new KernelError("filter_invalid", {
              reason: "remote returned unknown error code",
              remote_code: parsed.code,
              remote_data: data,
            });
          }
        } catch (err) {
          if (err instanceof KernelError) throw err;
          // fall through
        }
      }
      throw new KernelError("filter_invalid", {
        reason: `remote tool error (unparseable): ${text?.text ?? "<no content>"}`,
      });
    }
    return result.structuredContent as T;
  }

  async function callList<T>(name: string, args: Record<string, unknown>): Promise<T[]> {
    const wrapped = await call<{ items: T[] }>(name, args);
    return wrapped.items;
  }

  return {
    repos: {
      list: async (opts) =>
        callList<Repo>("repos_list", { include_system: opts?.include_system ?? false }),
      get: (slug) => call<Repo>("repos_get", { repo: slug }),
      create: (slug) => call<Repo>("repos_create", { repo: slug }),
      rename: (slug, ns) => call<Repo>("repos_rename", { repo: slug, new_repo: ns }),
      delete: (slug) => call<Repo>("repos_delete", { repo: slug }),
      set_path_config: (slug, cfg: PathConfigOverride | null) =>
        call<SetPathConfigResult>("repos_set_path_config", { repo: slug, config: cfg }),
      set_link_config: (slug, cfg: LinkConfigOverride | null) =>
        call<SetLinkConfigResult>("repos_set_link_config", { repo: slug, config: cfg }),
    },
    docs: {
      get: (repo, path, opts) =>
        call<Version>("docs_get", { repo, path, ...(opts?.raw && { raw: true }) }),
      get_version: (repo, vid, opts) =>
        call<Version>("docs_get_version", {
          repo,
          version_id: vid,
          ...(opts?.raw && { raw: true }),
        }),
      history: (repo, path, opts?: HistoryOptions) =>
        callList<Version>("docs_history", {
          repo,
          path,
          ...(opts?.limit !== undefined && { limit: opts.limit }),
          ...(opts?.before !== undefined && { before: opts.before }),
        }),
      diff: (repo, path, from, to) => call<UnifiedDiff>("docs_diff", { repo, path, from, to }),
      create: (repo, path, input: FrontmatterInput & { body: string }) =>
        call<Version>("docs_create", {
          repo,
          path,
          ...(input.frontmatter !== undefined && { frontmatter: input.frontmatter }),
          ...(input.frontmatter_raw !== undefined && { frontmatter_raw: input.frontmatter_raw }),
          body: input.body,
        }),
      put: (repo, prev, path, input) =>
        call<Version>("docs_put", {
          repo,
          path,
          prev_version_id: prev,
          ...(input.frontmatter !== undefined && { frontmatter: input.frontmatter }),
          ...(input.frontmatter_raw !== undefined && { frontmatter_raw: input.frontmatter_raw }),
          ...(input.body !== undefined && { body: input.body }),
        }),
      delete: (repo, prev) => call<Version>("docs_delete", { repo, prev_version_id: prev }),
    },
    links: {
      backfill: (repo) => call<LinksBackfillResult>("links_backfill", { repo }),
      stale: (repo) => callList<StaleLinkWire>("links_stale", { repo }),
      repair: (repo, opts) =>
        call<RepairResult>("links_repair", {
          repo,
          ...(opts?.dry_run !== undefined && { dry_run: opts.dry_run }),
        }),
    },
    query: async (spec: QuerySpec) => {
      const wrapped = await call<{ items: Version[] }>("query", spec as Record<string, unknown>);
      return wrapped.items;
    },
    graph: (spec: GraphSpec) =>
      call<GraphResult>("graph", spec as unknown as Record<string, unknown>),
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await client.close();
      } catch {
        /* best-effort */
      }
    },
  };
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/$/, "") + path;
}
