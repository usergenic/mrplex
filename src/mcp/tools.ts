/**
 * MCP tool registry — design §6.2.
 *
 * Tools mirror the kernel one-to-one. Each entry names the tool, describes it,
 * carries a JSON Schema for the input, and delegates to a kernel call with the
 * session's CallContext. No-auth (noauth plan): the user and token tools are
 * gone; write tools gain an optional `author` and the query tool an optional
 * `scope` — both overridden by the X-Mrplex-* request headers when present.
 *
 * Results shape:
 *   • On success: { structured, text } — structured is the wire type,
 *     text is a compact human rendering (render.ts).
 *   • On kernel error: throws; the SDK wiring in server.ts converts to an
 *     in-band tool error ({ code, data }) per §6.2.
 */

import type { CallContext } from "../kernel/context.js";
import type { Kernel } from "../kernel/kernel.js";
import type { PathConfigOverride } from "../kernel/path-config.js";
import type { QuerySpec } from "../kernel/query/query.js";
import type { Version } from "../kernel/wire.js";
import type { LinkConfigOverride } from "../links/link-config.js";
import { appendSystemProperty, extractSystemProperties } from "../markdown/frontmatter.js";
import { renderJson, renderRepoList, renderVersion, renderVersionList } from "./render.js";

/**
 * A tool's structured payload is always a JSON object — MCP's
 * `structuredContent` field is a record per the spec (and the SDK enforces
 * it). List-shaped results are wrapped in `{ items: [...] }`; single-object
 * results pass through.
 */
export type ToolResult = {
  structured: Record<string, unknown>;
  text: string;
};

/** Wrap an array result as `{ items }` so it fits `structuredContent`. */
function wrapList<T>(items: T[]): Record<string, unknown> {
  return { items };
}

/**
 * The session context carries the header-injected author/scope (see
 * mcp/server.ts). Handlers merge in tool-arg author/scope only where the
 * header left a gap — headers beat tool args (noauth plan decision 8).
 */
export type ToolHandler = (
  kernel: Kernel,
  ctx: CallContext,
  args: Record<string, unknown>,
) => ToolResult | Promise<ToolResult>;

export type ToolEntry = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: ToolHandler;
};

// A very small subset of JSON Schema — enough for what our tools accept.
type JsonSchema = {
  type: "object";
  properties: Record<string, JsonSchemaProp>;
  required?: string[];
  additionalProperties?: false;
};
type JsonSchemaProp =
  | { type: "string"; description?: string; enum?: string[] }
  | { type: "number"; description?: string }
  | { type: "integer"; description?: string; minimum?: number }
  | { type: "boolean"; description?: string }
  | { type: "null"; description?: string }
  | { type: "array"; description?: string; items: JsonSchemaProp }
  | {
      type: "object";
      description?: string;
      properties?: Record<string, JsonSchemaProp>;
      additionalProperties?: boolean | JsonSchemaProp;
    }
  | { oneOf: JsonSchemaProp[]; description?: string }
  | { anyOf: JsonSchemaProp[]; description?: string }
  | { description?: string };

// -----------------------------------------------------------------------------
// Argument helpers — narrow untyped JSON args into the kernel's typed shapes.
// The MCP transport already validates the JSON Schema; these accessors just
// pull typed values out of the validated bag.
// -----------------------------------------------------------------------------

function argStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") {
    throw new Error(`tool arg "${key}" must be a string`);
  }
  return v;
}

function argStrOpt(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`tool arg "${key}" must be a string`);
  return v;
}

function argBoolOpt(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new Error(`tool arg "${key}" must be a boolean`);
  return v;
}

function argIntOpt(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isSafeInteger(v)) {
    throw new Error(`tool arg "${key}" must be an integer`);
  }
  return v;
}

/**
 * Merge a write's `author` tool-arg into the session context. Headers win:
 * if the session already carries an author (header-injected), the tool arg is
 * ignored (noauth plan decision 8).
 */
function writeCtx(ctx: CallContext, args: Record<string, unknown>): CallContext {
  if (ctx.author !== undefined) return ctx;
  const author = argStrOpt(args, "author");
  return author === undefined ? ctx : { ...ctx, author };
}

/**
 * Merge a query's `scope` tool-arg into the session context. Headers win:
 * a header-injected scope shadows the tool arg entirely.
 */
function queryCtx(ctx: CallContext, args: Record<string, unknown>): CallContext {
  if (ctx.scope !== undefined) return ctx;
  const scope = args.scope;
  if (scope === undefined || scope === null) return ctx;
  if (!Array.isArray(scope)) throw new Error('tool arg "scope" must be an array of claims');
  return { ...ctx, scope: scope as CallContext["scope"] };
}

/**
 * Add `$version: <version_id>` to `frontmatter_raw` unless the caller asked
 * for raw output. Non-destructive — plain text append, no YAML round-trip.
 */
function withInjectedVersion(v: Version, raw: boolean): Version {
  if (raw) return v;
  return {
    ...v,
    frontmatter_raw: appendSystemProperty(v.frontmatter_raw, "version", v.version_id),
  };
}

// -----------------------------------------------------------------------------
// Tool definitions
// -----------------------------------------------------------------------------

export const TOOL_REGISTRY: ToolEntry[] = [
  // ---- repos ----
  {
    name: "repos_list",
    description: "List repos the caller can address (§6.2).",
    inputSchema: {
      type: "object",
      properties: {
        include_system: {
          type: "boolean",
          description: "Include system-namespaced (deleted) repos.",
        },
      },
    },
    handler: async (kernel, ctx, args) => {
      const result = await kernel.repos.list(ctx, {
        include_system: argBoolOpt(args, "include_system") ?? false,
      });
      return { structured: wrapList(result), text: renderRepoList(result) };
    },
  },
  {
    name: "repos_get",
    description: "Show a repo by slug.",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string", description: "Repo slug." } },
      required: ["repo"],
    },
    handler: async (kernel, ctx, args) => {
      const result = await kernel.repos.get(ctx, argStr(args, "repo"));
      return { structured: result, text: renderJson(result) };
    },
  },
  {
    name: "repos_create",
    description: "Create a new repo (admin).",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string", description: "New repo slug." } },
      required: ["repo"],
    },
    handler: async (kernel, ctx, args) => {
      const result = await kernel.repos.create(ctx, argStr(args, "repo"));
      return { structured: result, text: `created ${result.repo}` };
    },
  },
  {
    name: "repos_rename",
    description: "Rename a repo (admin).",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        new_repo: { type: "string" },
      },
      required: ["repo", "new_repo"],
    },
    handler: async (kernel, ctx, args) => {
      const result = await kernel.repos.rename(ctx, argStr(args, "repo"), argStr(args, "new_repo"));
      return { structured: result, text: `renamed to ${result.repo}` };
    },
  },
  {
    name: "repos_delete",
    description: "Delete a repo — renames slug into the system namespace (§3.4; admin).",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" } },
      required: ["repo"],
    },
    handler: async (kernel, ctx, args) => {
      const result = await kernel.repos.delete(ctx, argStr(args, "repo"));
      return { structured: result, text: `deleted (now ${result.repo})` };
    },
  },
  {
    name: "repos_set_path_config",
    description:
      "Set (or clear) a repo's path config override (§3.5). Pass config = null to clear.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        config: {
          oneOf: [
            {
              type: "object",
              additionalProperties: true,
              description: "PathConfig override — see §3.5.",
            },
            { type: "null" },
          ],
        },
      },
      required: ["repo", "config"],
    },
    handler: async (kernel, ctx, args) => {
      const cfg = args.config as PathConfigOverride | null;
      const result = await kernel.repos.set_path_config(ctx, argStr(args, "repo"), cfg);
      return { structured: result, text: `warnings: ${result.warnings.length}` };
    },
  },
  {
    name: "repos_set_link_config",
    description:
      "Set (or clear) a repo's link-extraction config override (§11.2); re-extracts the repo under the new config. Pass config = null to clear.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        config: {
          oneOf: [
            {
              type: "object",
              additionalProperties: true,
              description: "LinkConfig override — syntaxes / fields / resolution (§11.2).",
            },
            { type: "null" },
          ],
        },
      },
      required: ["repo", "config"],
    },
    handler: async (kernel, ctx, args) => {
      const cfg = args.config as LinkConfigOverride | null;
      const result = await kernel.repos.set_link_config(ctx, argStr(args, "repo"), cfg);
      return {
        structured: result,
        text: `link_config updated; reindexed ${result.reindexed.documents} doc(s), ${result.reindexed.edges} edge(s)`,
      };
    },
  },

  // ---- docs ----
  {
    name: "docs_get",
    description:
      "Read the current version of a document at (repo, path). Returned `frontmatter_raw` has `$version: <version_id>` appended so a subsequent `docs_put` can reuse it as `prev_version_id` (unless `raw: true`).",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        path: { type: "string" },
        raw: {
          type: "boolean",
          description: "Suppress server-injected `$*` system properties in frontmatter_raw.",
        },
      },
      required: ["repo", "path"],
    },
    handler: async (kernel, ctx, args) => {
      const v = await kernel.docs.get(ctx, argStr(args, "repo"), argStr(args, "path"));
      const out = withInjectedVersion(v, args.raw === true);
      return { structured: out, text: renderVersion(out) };
    },
  },
  {
    name: "docs_get_version",
    description: "Read a specific version by id.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        version_id: { type: "string" },
        raw: {
          type: "boolean",
          description: "Suppress server-injected `$*` system properties in frontmatter_raw.",
        },
      },
      required: ["repo", "version_id"],
    },
    handler: async (kernel, ctx, args) => {
      const v = await kernel.docs.get_version(
        ctx,
        argStr(args, "repo"),
        argStr(args, "version_id"),
      );
      const out = withInjectedVersion(v, args.raw === true);
      return { structured: out, text: renderVersion(out) };
    },
  },
  {
    name: "docs_history",
    description: "List versions of a document newest-first.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        path: { type: "string" },
        limit: { type: "integer", minimum: 1 },
        before: { type: "string", description: "ISO-8601 UTC" },
      },
      required: ["repo", "path"],
    },
    handler: async (kernel, ctx, args) => {
      const rows = await kernel.docs.history(ctx, argStr(args, "repo"), argStr(args, "path"), {
        limit: argIntOpt(args, "limit"),
        before: argStrOpt(args, "before"),
      });
      return { structured: wrapList(rows), text: renderVersionList(rows) };
    },
  },
  {
    name: "docs_diff",
    description:
      "Unified diff between two versions of the document at (repo, path). Both versions must belong to that document — otherwise version_not_in_document.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        path: { type: "string" },
        from: { type: "string", description: "source version id" },
        to: { type: "string", description: "target version id" },
      },
      required: ["repo", "path", "from", "to"],
    },
    handler: async (kernel, ctx, args) => {
      const d = await kernel.docs.diff(
        ctx,
        argStr(args, "repo"),
        argStr(args, "path"),
        argStr(args, "from"),
        argStr(args, "to"),
      );
      return { structured: d as unknown as Record<string, unknown>, text: d.patch };
    },
  },
  {
    name: "docs_create",
    description:
      "Create a new document. Provide exactly one of `frontmatter` (JSON map) or `frontmatter_raw` (verbatim YAML). §3.2.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        path: { type: "string" },
        body: { type: "string" },
        frontmatter: { type: "object", additionalProperties: true },
        frontmatter_raw: { type: "string" },
        author: {
          type: "string",
          description: "Opaque author string. The X-Mrplex-Author header, if present, wins.",
        },
      },
      required: ["repo", "path", "body"],
    },
    handler: async (kernel, ctx, args) => {
      const v = await kernel.docs.create(
        writeCtx(ctx, args),
        argStr(args, "repo"),
        argStr(args, "path"),
        {
          frontmatter: args.frontmatter as never,
          frontmatter_raw: argStrOpt(args, "frontmatter_raw"),
          body: argStr(args, "body"),
        },
      );
      return { structured: v, text: renderVersion(v) };
    },
  },
  {
    name: "docs_put",
    description:
      "Update or move a document. `path` may differ from prev's path (= move). Exactly one of `frontmatter` | `frontmatter_raw` if changing frontmatter; both may be omitted to keep prev's frontmatter (§3.2). `prev_version_id` may be omitted if `frontmatter_raw` embeds `$version: <id>` (from a prior docs_get).",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        path: { type: "string", description: "Destination path (may differ from prev's path)." },
        prev_version_id: {
          type: "string",
          description:
            "Optional if `frontmatter_raw` contains `$version: <id>`; explicit value wins.",
        },
        body: { type: "string" },
        frontmatter: { type: "object", additionalProperties: true },
        frontmatter_raw: { type: "string" },
        author: {
          type: "string",
          description: "Opaque author string. The X-Mrplex-Author header, if present, wins.",
        },
      },
      required: ["repo", "path"],
    },
    handler: async (kernel, ctx, args) => {
      const input: {
        frontmatter?: unknown;
        frontmatter_raw?: string;
        body?: string;
      } = {};
      if (args.frontmatter !== undefined) input.frontmatter = args.frontmatter;
      if (typeof args.frontmatter_raw === "string") input.frontmatter_raw = args.frontmatter_raw;
      if (typeof args.body === "string") input.body = args.body;

      // Peel `$version` (and any other `$*`) out of raw frontmatter first — it
      // supplies the prev_version_id fallback and must never reach storage.
      let embeddedVersion: string | undefined;
      if (input.frontmatter_raw !== undefined) {
        const { raw: cleaned, props } = extractSystemProperties(input.frontmatter_raw);
        input.frontmatter_raw = cleaned;
        if (typeof props.version === "string" && props.version.length > 0) {
          embeddedVersion = props.version;
        }
      }
      const prev = argStrOpt(args, "prev_version_id") ?? embeddedVersion;
      if (prev === undefined) {
        throw new Error(
          "prev_version_id is required (either as an argument or as `$version` in frontmatter_raw)",
        );
      }

      const v = await kernel.docs.put(
        writeCtx(ctx, args),
        argStr(args, "repo"),
        prev,
        argStr(args, "path"),
        input as never,
      );
      return { structured: v, text: renderVersion(v) };
    },
  },
  {
    name: "docs_delete",
    description: "Delete a document — moves to `<system-sigil>deleted/...`; idempotent (§3.4).",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        prev_version_id: { type: "string" },
        author: {
          type: "string",
          description: "Opaque author string. The X-Mrplex-Author header, if present, wins.",
        },
      },
      required: ["repo", "prev_version_id"],
    },
    handler: async (kernel, ctx, args) => {
      const v = await kernel.docs.delete(
        writeCtx(ctx, args),
        argStr(args, "repo"),
        argStr(args, "prev_version_id"),
      );
      return { structured: v, text: renderVersion(v) };
    },
  },

  // ---- links (§11.2) ----
  {
    name: "links_backfill",
    description: "Rebuild the link index for a repo (backfill / config change). Admin.",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" } },
      required: ["repo"],
    },
    handler: async (kernel, ctx, args) => {
      const r = await kernel.links.backfill(ctx, argStr(args, "repo"));
      return {
        structured: r,
        text: `backfill ${argStr(args, "repo")}: documents=${r.documents} edges=${r.edges}`,
      };
    },
  },
  {
    name: "links_stale",
    description:
      "List live docs whose written link text is stale vs. the target's current path (§11.2).",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" } },
      required: ["repo"],
    },
    handler: async (kernel, ctx, args) => {
      const rows = await kernel.links.stale(ctx, argStr(args, "repo"));
      const text = rows.length
        ? rows.map((r) => `${r.source_path}: "${r.written}" → "${r.current}"`).join("\n")
        : "no stale links";
      return { structured: wrapList(rows), text };
    },
  },
  {
    name: "links_repair",
    description:
      "Rewrite stale link text as optimistic docs.put; dry_run plans only. Conflicts skipped.",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" }, dry_run: { type: "boolean" } },
      required: ["repo"],
    },
    handler: async (kernel, ctx, args) => {
      const r = await kernel.links.repair(ctx, argStr(args, "repo"), {
        dry_run: argBoolOpt(args, "dry_run") ?? false,
      });
      const text = `${r.dry_run ? "[dry-run] " : ""}repaired=${r.repaired.length} skipped=${r.skipped.length}`;
      return { structured: r, text };
    },
  },

  // ---- query ----
  {
    name: "query",
    description: "Query documents — CEL filter + FTS text; §5.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
        filter: { type: "string" },
        text: { type: "string" },
        rank: {
          type: "string",
          description:
            "Semantic rank via embeddings (§5.1). Requires an embed hook; else rank_unavailable.",
        },
        limit: { type: "integer", minimum: 0 },
        include_hidden: { type: "boolean" },
        include_system: { type: "boolean" },
        scope: {
          type: "array",
          description:
            "Read-visibility claims (ScopeClaim[]) narrowing what this query sees. The X-Mrplex-Scope header, if present, wins.",
          items: { type: "object", additionalProperties: true },
        },
      },
    },
    handler: async (kernel, ctx, args) => {
      const { scope: _scope, ...specArgs } = args;
      const spec = specArgs as QuerySpec;
      const rows = await kernel.query(queryCtx(ctx, args), spec);
      return { structured: wrapList(rows), text: renderVersionList(rows) };
    },
  },
];

/** Convenient lookup by name. */
export function toolByName(name: string): ToolEntry | undefined {
  return TOOL_REGISTRY.find((t) => t.name === name);
}
