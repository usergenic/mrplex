/**
 * MCP tool registry — design §6.2.
 *
 * 21 tools mirroring the kernel one-to-one. Each entry names the tool,
 * describes it, carries a JSON Schema for the input, and delegates to a
 * kernel call with the resolved actor. M4 added `docs_diff` (the tool
 * m3 deferred).
 *
 * Results shape:
 *   • On success: { structured, text } — structured is the wire type,
 *     text is a compact human rendering (render.ts).
 *   • On kernel error: throws; the SDK wiring in server.ts converts to an
 *     in-band tool error ({ code, data }) per §6.2.
 */

import type { Actor } from "../kernel/auth/actor.js";
import type { ScopeInput } from "../kernel/auth/scope.js";
import type { Kernel } from "../kernel/kernel.js";
import type { PathConfigOverride } from "../kernel/path-config.js";
import type { QuerySpec } from "../kernel/query/query.js";
import type { Version } from "../kernel/wire.js";
import { appendSystemProperty, extractSystemProperties } from "../markdown/frontmatter.js";
import {
  renderJson,
  renderRepoList,
  renderTokenCreate,
  renderTokenList,
  renderUserList,
  renderVersion,
  renderVersionList,
} from "./render.js";

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

export type ToolHandler = (
  kernel: Kernel,
  actor: Actor,
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
    handler: async (kernel, actor, args) => {
      const result = await kernel.repos.list(actor, {
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
    handler: async (kernel, actor, args) => {
      const result = await kernel.repos.get(actor, argStr(args, "repo"));
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
    handler: async (kernel, actor, args) => {
      const result = await kernel.repos.create(actor, argStr(args, "repo"));
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
    handler: async (kernel, actor, args) => {
      const result = await kernel.repos.rename(
        actor,
        argStr(args, "repo"),
        argStr(args, "new_repo"),
      );
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
    handler: async (kernel, actor, args) => {
      const result = await kernel.repos.delete(actor, argStr(args, "repo"));
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
    handler: async (kernel, actor, args) => {
      const cfg = args.config as PathConfigOverride | null;
      const result = await kernel.repos.set_path_config(actor, argStr(args, "repo"), cfg);
      return { structured: result, text: `warnings: ${result.warnings.length}` };
    },
  },

  // ---- users ----
  {
    name: "users_list",
    description: "List users.",
    inputSchema: { type: "object", properties: {} },
    handler: async (kernel, actor) => {
      const result = await kernel.users.list(actor);
      return { structured: wrapList(result), text: renderUserList(result) };
    },
  },
  {
    name: "users_create",
    description: "Create a user (admin).",
    inputSchema: {
      type: "object",
      properties: { user: { type: "string" } },
      required: ["user"],
    },
    handler: async (kernel, actor, args) => {
      const result = await kernel.users.create(actor, argStr(args, "user"));
      return { structured: result, text: `created ${result.user}` };
    },
  },
  {
    name: "users_rename",
    description: "Rename a user (admin).",
    inputSchema: {
      type: "object",
      properties: { user: { type: "string" }, new_user: { type: "string" } },
      required: ["user", "new_user"],
    },
    handler: async (kernel, actor, args) => {
      const result = await kernel.users.rename(
        actor,
        argStr(args, "user"),
        argStr(args, "new_user"),
      );
      return { structured: result, text: `renamed to ${result.user}` };
    },
  },
  {
    name: "users_delete",
    description: "Delete a user — system-namespace rename + revoke tokens (§3.4; admin).",
    inputSchema: {
      type: "object",
      properties: { user: { type: "string" } },
      required: ["user"],
    },
    handler: async (kernel, actor, args) => {
      const result = await kernel.users.delete(actor, argStr(args, "user"));
      return { structured: result, text: `deleted (now ${result.user})` };
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
    handler: async (kernel, actor, args) => {
      const v = await kernel.docs.get(actor, argStr(args, "repo"), argStr(args, "path"));
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
    handler: async (kernel, actor, args) => {
      const v = await kernel.docs.get_version(
        actor,
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
    handler: async (kernel, actor, args) => {
      const rows = await kernel.docs.history(actor, argStr(args, "repo"), argStr(args, "path"), {
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
    handler: async (kernel, actor, args) => {
      const d = await kernel.docs.diff(
        actor,
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
      },
      required: ["repo", "path", "body"],
    },
    handler: async (kernel, actor, args) => {
      const v = await kernel.docs.create(actor, argStr(args, "repo"), argStr(args, "path"), {
        frontmatter: args.frontmatter as never,
        frontmatter_raw: argStrOpt(args, "frontmatter_raw"),
        body: argStr(args, "body"),
      });
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
      },
      required: ["repo", "path"],
    },
    handler: async (kernel, actor, args) => {
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
        actor,
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
      },
      required: ["repo", "prev_version_id"],
    },
    handler: async (kernel, actor, args) => {
      const v = await kernel.docs.delete(
        actor,
        argStr(args, "repo"),
        argStr(args, "prev_version_id"),
      );
      return { structured: v, text: renderVersion(v) };
    },
  },

  // ---- tokens ----
  {
    name: "tokens_list",
    description: "List your tokens.",
    inputSchema: { type: "object", properties: {} },
    handler: async (kernel, actor) => {
      const rows = await kernel.tokens.list(actor);
      return { structured: wrapList(rows), text: renderTokenList(rows) };
    },
  },
  {
    name: "tokens_create",
    description: "Mint a new token. Plaintext secret returned once — store it.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string" },
        scopes: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            description: "ScopeInput — see §6.4.",
          },
        },
        admin: { type: "boolean" },
        expires_at: { type: "string", description: "ISO-8601" },
        for_user: {
          type: "string",
          description: "Mint on behalf of this user slug (admin only).",
        },
      },
      required: ["label", "scopes"],
    },
    handler: async (kernel, actor, args) => {
      const scopes = (args.scopes ?? []) as ScopeInput[];
      const result = await kernel.tokens.create(actor, argStr(args, "label"), scopes, {
        admin: argBoolOpt(args, "admin") ?? false,
        expires_at: argStrOpt(args, "expires_at") ?? null,
        for_user: argStrOpt(args, "for_user") ?? null,
      });
      return { structured: result, text: renderTokenCreate(result) };
    },
  },
  {
    name: "tokens_revoke",
    description: "Revoke a token (self, or any if admin).",
    inputSchema: {
      type: "object",
      properties: { token_id: { type: "string" } },
      required: ["token_id"],
    },
    handler: async (kernel, actor, args) => {
      const t = await kernel.tokens.revoke(actor, argStr(args, "token_id"));
      return { structured: t, text: `revoked ${t.id}` };
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
      },
    },
    handler: async (kernel, actor, args) => {
      const spec = args as QuerySpec;
      const rows = await kernel.query(actor, spec);
      return { structured: wrapList(rows), text: renderVersionList(rows) };
    },
  },
];

/** Convenient lookup by name. */
export function toolByName(name: string): ToolEntry | undefined {
  return TOOL_REGISTRY.find((t) => t.name === name);
}
