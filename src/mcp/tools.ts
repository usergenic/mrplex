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

import { type CallContext, validateScopeClaims } from "../kernel/context.js";
import { KernelError } from "../kernel/errors.js";
import type { Kernel } from "../kernel/kernel.js";
import type { PathConfigOverride } from "../kernel/path-config.js";
import type { QuerySpec } from "../kernel/query/query.js";
import type { GraphSpec, Version } from "../kernel/wire.js";
import type { LinkConfigOverride } from "../links/link-config.js";
import { appendSystemProperty, extractSystemProperties } from "../markdown/frontmatter.js";
import { QUERY_SYNTAX_DOC } from "./query-syntax.js";
import {
  renderDocGetManyText,
  renderGraphSummary,
  renderJson,
  renderQueryHitList,
  renderRepoList,
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

/** Shared exact-path input note for docs tools (canonical-path-normalization). */
const EXACT_PATH_DOC =
  "Canonical repository-relative path (e.g. `projects/example.md`). Exact-path operations also accept one leading `/` as a repository-root reference alias; responses always return the slashless canonical path.";

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
  /**
   * Success-result shape of `structuredContent` (MCP `outputSchema`).
   * In-band tool errors carry no structuredContent (server.ts toolError),
   * so this describes success results only — per spec, error results are
   * exempt from output-schema conformance.
   */
  outputSchema?: JsonSchema;
  handler: ToolHandler;
};

// A very small subset of JSON Schema — enough for what our tools accept.
type JsonSchema = {
  type: "object";
  description?: string;
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
      required?: string[];
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

function argStrArray(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "string")) {
    throw new Error(`tool arg "${key}" must be a non-empty array of strings`);
  }
  return v as string[];
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
  // Same structural check as the header/body paths — a repo-less claim is a
  // loud filter_invalid, not a silent deny_all empty result.
  return { ...ctx, scope: validateScopeClaims(scope) };
}

/**
 * Append the injected system properties — `$version` then `$content_hash`, in
 * fixed order (sync/history plan §2.4) — to `frontmatter_raw` unless the caller
 * asked for raw output. Non-destructive — plain text append, no YAML round-trip.
 * This is the linchpin of sync: a materialized file carries its own ancestry
 * (`$version`) and clean-state fingerprint (`$content_hash`).
 */
function withInjectedSystemProps(v: Version, raw: boolean): Version {
  if (raw) return v;
  let frontmatter_raw = appendSystemProperty(v.frontmatter_raw, "version", v.version_id);
  frontmatter_raw = appendSystemProperty(frontmatter_raw, "content_hash", v.content_hash);
  return { ...v, frontmatter_raw };
}

// -----------------------------------------------------------------------------
// Output schemas — success-result shapes of `structuredContent` (wire types,
// §6.4), declared via MCP's `outputSchema` so clients know what each tool
// returns without calling it. SDK clients validate any structuredContent
// against these — including on isError results — which is why toolError
// (server.ts) keeps the error payload in the text channel only.
// -----------------------------------------------------------------------------

/** `{ items: [...] }` — the wrapList shape for list-returning tools. */
function listResultSchema(item: JsonSchemaProp, description: string): JsonSchema {
  return {
    type: "object",
    properties: { items: { type: "array", items: item, description } },
    required: ["items"],
  };
}

const REPO_SCHEMA: JsonSchema = {
  type: "object",
  description: "A repo (wire shape).",
  properties: {
    repo: { type: "string", description: "Repo slug." },
    path_config: {
      anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }],
      description: "Per-repo path-config override; null = server defaults.",
    },
  },
  required: ["repo", "path_config"],
};

const VERSION_SCHEMA: JsonSchema = {
  type: "object",
  description: "A document version (wire shape).",
  properties: {
    version_id: {
      type: "string",
      description: "Opaque version id — usable as prev_version_id on the next write.",
    },
    prev_version_id: { anyOf: [{ type: "string" }, { type: "null" }] },
    next_version_id: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: "null when this is the document's current version.",
    },
    repo: { type: "string", description: "Repo slug." },
    path: { type: "string" },
    frontmatter: {
      type: "object",
      additionalProperties: true,
      description: "Frontmatter parsed to JSON (the query view of frontmatter_raw).",
    },
    frontmatter_raw: {
      type: "string",
      description:
        "Verbatim YAML frontmatter. Reads append `$version: <id>` then `$content_hash: <sha256>` " +
        "unless raw: true.",
    },
    body: { type: "string", description: "Markdown body." },
    author: { type: "string", description: "Opaque author string." },
    created_at: { type: "string", description: "ISO-8601 UTC." },
    content_hash: {
      type: "string",
      description:
        "SHA-256 (bare hex) of canonical content (frontmatter stripped of $*, plus body).",
    },
  },
  required: [
    "version_id",
    "prev_version_id",
    "next_version_id",
    "repo",
    "path",
    "frontmatter",
    "frontmatter_raw",
    "body",
    "author",
    "created_at",
    "content_hash",
  ],
};

const DOC_GET_MANY_ERROR_SCHEMA: JsonSchemaProp = {
  type: "object",
  description: "Per-path failure from a batch get — the call still succeeds.",
  properties: {
    path: { type: "string" },
    code: { type: "string" },
    data: { type: "object", additionalProperties: true },
  },
  required: ["path", "code", "data"],
};

const DOC_GET_MANY_RESULT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: VERSION_SCHEMA,
      description: "Found current versions, in request order.",
    },
    errors: {
      type: "array",
      items: DOC_GET_MANY_ERROR_SCHEMA,
      description: "Per-path failures (doc_not_found, forbidden), in request order.",
    },
  },
  required: ["items", "errors"],
};

const DIFF_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    repo: { type: "string" },
    path: { type: "string" },
    from_version_id: { type: "string" },
    to_version_id: { type: "string" },
    patch: { type: "string", description: "Unified diff text." },
  },
  required: ["repo", "path", "from_version_id", "to_version_id", "patch"],
};

const LINKS_BACKFILL_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    documents: { type: "integer", description: "Live documents (re)extracted." },
    edges: { type: "integer", description: "Link edges indexed." },
  },
  required: ["documents", "edges"],
};

const STALE_LINK_SCHEMA: JsonSchema = {
  type: "object",
  description: "A live doc whose written link text no longer matches the target's current path.",
  properties: {
    repo: { type: "string" },
    source_path: { type: "string", description: "Doc containing the stale link." },
    ord: { type: "integer", description: "Link's ordinal within the source doc." },
    written: { type: "string", description: "Link target as written." },
    current: { type: "string", description: "Target's current path." },
  },
  required: ["repo", "source_path", "ord", "written", "current"],
};

const LINKS_REPAIR_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    dry_run: { type: "boolean" },
    repaired: {
      type: "array",
      items: {
        type: "object",
        properties: { path: { type: "string" }, edges: { type: "integer" } },
        required: ["path", "edges"],
      },
    },
    skipped: {
      type: "array",
      items: {
        type: "object",
        properties: { path: { type: "string" }, reason: { type: "string" } },
        required: ["path", "reason"],
      },
    },
  },
  required: ["dry_run", "repaired", "skipped"],
};

const SET_PATH_CONFIG_RESULT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    repo: REPO_SCHEMA,
    warnings: {
      type: "array",
      description: "Existing paths that violate the new config (flagged, not rejected).",
      items: {
        type: "object",
        properties: {
          version_id: { type: "string" },
          path: { type: "string" },
          reason: { type: "string" },
        },
        required: ["version_id", "path", "reason"],
      },
    },
  },
  required: ["repo", "warnings"],
};

const SET_LINK_CONFIG_RESULT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    repo: REPO_SCHEMA,
    reindexed: LINKS_BACKFILL_SCHEMA,
  },
  required: ["repo", "reindexed"],
};

const QUERY_HIT_SCHEMA: JsonSchemaProp = {
  type: "object",
  description:
    "A projected query hit — not a full document. `$`-keys are system intrinsics selected " +
    "via `select` ($path, $repo, $version_id, $prev_version_id, $next_version_id, $updated_at, " +
    "$author, $body, $content_hash, $semantic_score); any other keys are `select`-projected frontmatter. A key " +
    'appears only when selected (and, for frontmatter, present). Default `select` is ["$path"], ' +
    'so a hit is `{ "$path": "…" }` only unless you ask for more.',
  // Which keys appear depends entirely on `select`, so none are required and
  // both intrinsics and bare frontmatter keys ride additionalProperties.
  additionalProperties: true,
};

const VERSION_REF_SCHEMA: JsonSchemaProp = {
  type: "object",
  description:
    "A change-feed pointer (sync/history plan §3.3). Consumers fetch bodies via docs_get_version " +
    "only when needed; content_hash lets them skip no-op materializations.",
  properties: {
    version_id: { type: "string", description: "Opaque id of this version." },
    prev_version_id: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: "Prior version id, or null for a create.",
    },
    repo: { type: "string", description: "Repo slug." },
    path: { type: "string", description: "This version's path." },
    prev_path: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: "Path of the prior version (both ends of a move/delete), or null.",
    },
    content_hash: { type: "string", description: "SHA-256 (bare hex) of canonical content." },
    op: {
      type: "string",
      enum: ["create", "update", "move", "delete"],
      description: "Server-derived operation.",
    },
    created_at: { type: "string", description: "ISO-8601 UTC timestamp." },
  },
  required: [
    "version_id",
    "prev_version_id",
    "repo",
    "path",
    "prev_path",
    "content_hash",
    "op",
    "created_at",
  ],
};

const GRAPH_DOCUMENT_SCHEMA: JsonSchemaProp = {
  type: "object",
  description:
    "A reached document. `$`-keys are system intrinsics; any other keys are `select`-projected " +
    "frontmatter (a missing key is simply absent).",
  properties: {
    $path: { type: "string", description: "The document's current path." },
    $degrees: {
      type: "integer",
      description:
        "Call-relative: minimum hops from the nearest root under THIS call's direction/fields/" +
        "filter/scope. Not a stable property — do not persist it across calls. Roots are 0.",
    },
    $links: {
      type: "integer",
      description:
        "Count of distinct scope-visible documents this document links to — its true visible " +
        "out-degree, independent of this call's filter/fields/degrees (stable across calls). " +
        "Useful for ranking frontier docs (hub vs. leaf).",
    },
    $backlinks: {
      type: "integer",
      description: "Count of distinct scope-visible documents linking TO this document.",
    },
  },
  required: ["$path", "$degrees", "$links", "$backlinks"],
  // `select`-projected frontmatter keys appear as bare keys alongside the $-intrinsics.
  additionalProperties: true,
};

const GRAPH_LINK_SCHEMA: JsonSchemaProp = {
  type: "object",
  description:
    "An induced link: a distinct (source, target, field) triple where both endpoints appear in " +
    "`documents`. `field` is the relationship type (`$body` = an untyped body link). No " +
    "occurrence count — a link is a pure statement of relationship.",
  properties: {
    source: { type: "string", description: "Linking document's path." },
    target: { type: "string", description: "Linked-to document's path." },
    field: { type: "string", description: "Relationship type; `$body` for body links." },
  },
  required: ["source", "target", "field"],
};

const GRAPH_RESULT_SCHEMA: JsonSchema = {
  type: "object",
  description: "A graph neighborhood: documents and the links between them (docs/graph-plan.md).",
  properties: {
    documents: {
      type: "array",
      items: GRAPH_DOCUMENT_SCHEMA,
      description: "Reached documents, ordered by ($degrees, $path).",
    },
    links: {
      type: "array",
      items: GRAPH_LINK_SCHEMA,
      description:
        "Induced distinct links over the returned documents, ordered (source,target,field).",
    },
    frontier: {
      type: "array",
      items: { type: "string" },
      description:
        "Paths of returned documents whose links were NOT fully enumerated (cut by the degrees " +
        "cap or by max_documents). The continuation contract: there are no cursors — re-root a " +
        "follow-up `graph` call at chosen frontier paths and union the results.",
    },
    complete_degrees: {
      type: "integer",
      description:
        "Largest d such that every effective-graph document within d hops of a root is present. " +
        "When truncated is false this equals the requested degrees; when max_documents cut a ring " +
        'it makes the partial result precise ("the 2-hop ball is exhaustive, the 3-ring is sampled").',
    },
    truncated: {
      type: "boolean",
      description: "True iff max_documents (or the server links ceiling) elided anything.",
    },
  },
  required: ["documents", "links", "frontier", "complete_degrees", "truncated"],
};

// -----------------------------------------------------------------------------
// Tool definitions
// -----------------------------------------------------------------------------

export const TOOL_REGISTRY: ToolEntry[] = [
  // ---- repos ----
  {
    name: "repos_list",
    description:
      "List repos the caller can address. Deleted (system-namespaced) repos are omitted unless `include_system` is true.",
    inputSchema: {
      type: "object",
      properties: {
        include_system: {
          type: "boolean",
          description: "Include system-namespaced (deleted) repos.",
        },
      },
    },
    outputSchema: listResultSchema(REPO_SCHEMA, "Repos the caller can address."),
    handler: async (kernel, ctx, args) => {
      const result = await kernel.repos.list(ctx, {
        include_system: argBoolOpt(args, "include_system") ?? false,
      });
      return { structured: wrapList(result), text: renderRepoList(result) };
    },
  },
  {
    name: "repos_get",
    description: "Fetch a repo by slug. Missing or out-of-scope slugs raise not-found.",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string", description: "Repo slug." } },
      required: ["repo"],
    },
    outputSchema: REPO_SCHEMA,
    handler: async (kernel, ctx, args) => {
      const result = await kernel.repos.get(ctx, argStr(args, "repo"));
      return { structured: result, text: renderJson(result) };
    },
  },
  {
    name: "repos_create",
    description: "Create a new repo. Fails with slug_taken if the slug is already in use.",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string", description: "New repo slug." } },
      required: ["repo"],
    },
    outputSchema: REPO_SCHEMA,
    handler: async (kernel, ctx, args) => {
      const result = await kernel.repos.create(ctx, argStr(args, "repo"));
      return { structured: result, text: `created ${result.repo}` };
    },
  },
  {
    name: "repos_rename",
    description:
      "Rename a repo slug (recasing the same repo is allowed). Fails with slug_taken on collision.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        new_repo: { type: "string" },
      },
      required: ["repo", "new_repo"],
    },
    outputSchema: REPO_SCHEMA,
    handler: async (kernel, ctx, args) => {
      const result = await kernel.repos.rename(ctx, argStr(args, "repo"), argStr(args, "new_repo"));
      return { structured: result, text: `renamed to ${result.repo}` };
    },
  },
  {
    name: "repos_delete",
    description:
      "Soft-delete a repo by renaming its slug into the system namespace (`:deleted-…`). Idempotent if already system-namespaced.",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" } },
      required: ["repo"],
    },
    outputSchema: REPO_SCHEMA,
    handler: async (kernel, ctx, args) => {
      const result = await kernel.repos.delete(ctx, argStr(args, "repo"));
      return { structured: result, text: `deleted (now ${result.repo})` };
    },
  },
  {
    name: "repos_set_path_config",
    description:
      "Set or clear a repo's path-config override (disallowed chars, system/hidden sigils). Pass `config: null` to clear. Existing live paths that violate the new config are returned as warnings, not rejected.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        config: {
          oneOf: [
            {
              type: "object",
              additionalProperties: true,
              description: "PathConfig override (disallowed_chars, system_sigils, hidden_sigils).",
            },
            { type: "null" },
          ],
        },
      },
      required: ["repo", "config"],
    },
    outputSchema: SET_PATH_CONFIG_RESULT_SCHEMA,
    handler: async (kernel, ctx, args) => {
      const cfg = args.config as PathConfigOverride | null;
      const result = await kernel.repos.set_path_config(ctx, argStr(args, "repo"), cfg);
      return { structured: result, text: `warnings: ${result.warnings.length}` };
    },
  },
  {
    name: "repos_set_link_config",
    description:
      "Set or clear a repo's link-extraction config (body / frontmatter syntax profiles and resolution) and re-extract the whole repo under the new config. Pass `config: null` to clear.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        config: {
          oneOf: [
            {
              type: "object",
              additionalProperties: true,
              description: "LinkConfig override — body / frontmatter syntax profiles / resolution.",
            },
            { type: "null" },
          ],
        },
      },
      required: ["repo", "config"],
    },
    outputSchema: SET_LINK_CONFIG_RESULT_SCHEMA,
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
      "Read the current version of a document at (repo, path) — the way to recover a full document after `query`. " +
      EXACT_PATH_DOC +
      " Returned `frontmatter_raw` has `$version: <version_id>` then `$content_hash: <sha256>` appended so a subsequent `docs_put` can reuse `$version` as `prev_version_id` (unless `raw: true`). A missing path raises doc_not_found (unlike `query`, which omits unmatched paths). For several paths at once, use `docs_get_many`.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        path: { type: "string", description: EXACT_PATH_DOC },
        raw: {
          type: "boolean",
          description: "Suppress server-injected `$*` system properties in frontmatter_raw.",
        },
      },
      required: ["repo", "path"],
    },
    outputSchema: VERSION_SCHEMA,
    handler: async (kernel, ctx, args) => {
      const v = await kernel.docs.get(ctx, argStr(args, "repo"), argStr(args, "path"));
      const out = withInjectedSystemProps(v, args.raw === true);
      return { structured: out, text: renderVersion(out) };
    },
  },
  {
    name: "docs_get_many",
    description:
      "Read the current versions of several documents at once — the batch recover path after `query`. " +
      "Returns `{ items, errors }`: found docs are full `Version`s (same injection as `docs_get` unless " +
      "`raw: true`); per-path misses land in `errors` without failing the call. Duplicate paths are " +
      "collapsed (first-seen). Max 50 unique paths.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        paths: {
          type: "array",
          items: { type: "string" },
          description: `Non-empty list of document paths to fetch. ${EXACT_PATH_DOC}`,
        },
        raw: {
          type: "boolean",
          description: "Suppress server-injected `$*` system properties in frontmatter_raw.",
        },
      },
      required: ["repo", "paths"],
    },
    outputSchema: DOC_GET_MANY_RESULT_SCHEMA,
    handler: async (kernel, ctx, args) => {
      const raw = args.raw === true;
      const result = await kernel.docs.get_many(ctx, argStr(args, "repo"), argStrArray(args, "paths"));
      const items = result.items.map((v) => withInjectedSystemProps(v, raw));
      const structured = { items, errors: result.errors };
      return { structured, text: renderDocGetManyText(items, result.errors) };
    },
  },
  {
    name: "docs_get_version",
    description:
      "Read a specific version by opaque `version_id` (current or historical). Same `$version` / `$content_hash` injection into `frontmatter_raw` as `docs_get` unless `raw: true`.",
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
    outputSchema: VERSION_SCHEMA,
    handler: async (kernel, ctx, args) => {
      const v = await kernel.docs.get_version(
        ctx,
        argStr(args, "repo"),
        argStr(args, "version_id"),
      );
      const out = withInjectedSystemProps(v, args.raw === true);
      return { structured: out, text: renderVersion(out) };
    },
  },
  {
    name: "history_list",
    description:
      "Scoped, document-spanning version history. Where `docs_history` lists one literal path, this takes a `path` GLOB (omitted = the whole repo) and interleaves matching documents' versions by version-log position. `ever: false` (default) anchors on the LIVE set — history of what lives at the glob now; `ever: true` also includes documents that once matched but moved away or were deleted. `since`/`until` are opaque version-id bounds; `order` is desc (newest-first) by default. A single literal `path` reproduces `docs_history`.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        path: { type: "string", description: "Gitignore-style glob; omit for the whole repo." },
        ever: {
          type: "boolean",
          description: "Include documents that ever matched (moved-away / deleted). Default false.",
        },
        since: { type: "string", description: "Exclusive lower version-id bound." },
        until: { type: "string", description: "Inclusive upper version-id bound." },
        order: {
          type: "string",
          enum: ["asc", "desc"],
          description: "Default desc (newest-first).",
        },
        limit: { type: "integer", minimum: 1 },
        scope: {
          type: "array",
          description: "Read-visibility claims (ScopeClaim[]); the X-Mrplex-Scope header wins.",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["repo"],
    },
    outputSchema: listResultSchema(
      VERSION_SCHEMA,
      "Matching versions, ordered by version-log position.",
    ),
    handler: async (kernel, ctx, args) => {
      const order = argStrOpt(args, "order");
      const rows = await kernel.history.list(queryCtx(ctx, args), {
        repo: argStr(args, "repo"),
        path: argStrOpt(args, "path"),
        ever: argBoolOpt(args, "ever"),
        since: argStrOpt(args, "since"),
        until: argStrOpt(args, "until"),
        order: order === "asc" || order === "desc" ? order : undefined,
        limit: argIntOpt(args, "limit"),
      });
      return { structured: wrapList(rows), text: renderVersionList(rows) };
    },
  },
  {
    name: "docs_history",
    description:
      "Deprecated: use `history_list` (a literal `path` reproduces this). List versions of one document newest-first.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        path: { type: "string", description: EXACT_PATH_DOC },
        limit: { type: "integer", minimum: 1 },
        before: { type: "string", description: "ISO-8601 UTC" },
      },
      required: ["repo", "path"],
    },
    outputSchema: listResultSchema(VERSION_SCHEMA, "Versions newest-first."),
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
      `Unified diff between two versions of the document at (repo, path). ${EXACT_PATH_DOC} Both versions must belong to that document — otherwise version_not_in_document.`,
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        path: { type: "string", description: EXACT_PATH_DOC },
        from: { type: "string", description: "source version id" },
        to: { type: "string", description: "target version id" },
      },
      required: ["repo", "path", "from", "to"],
    },
    outputSchema: DIFF_SCHEMA,
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
      `Create a new document at (repo, path). ${EXACT_PATH_DOC} Fails with create_conflict if the path is occupied. Provide exactly one of \`frontmatter\` (JSON map) or \`frontmatter_raw\` (verbatim YAML).`,
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        path: { type: "string", description: EXACT_PATH_DOC },
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
    outputSchema: VERSION_SCHEMA,
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
      "Update or move a document (optimistic concurrency). `path` may differ from prev's path (= move). Exactly one of `frontmatter` | `frontmatter_raw` if changing frontmatter; both may be omitted to keep prev's. `prev_version_id` may be omitted if `frontmatter_raw` embeds `$version: <id>` from a prior `docs_get`. Conflicts: stale_prev (someone else wrote first — re-read and retry), path_taken (move onto an occupied path).",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        path: {
          type: "string",
          description: `Destination path (may differ from prev's path). ${EXACT_PATH_DOC}`,
        },
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
    outputSchema: VERSION_SCHEMA,
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
    description:
      "Delete a document — moves it to `:deleted/…` (system namespace). Requires `prev_version_id` of the current version. Idempotent if already deleted. Conflicts with stale_prev if someone else wrote first.",
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
    outputSchema: VERSION_SCHEMA,
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
    description:
      "Rebuild the link index for a repo (after a link-config change, or to repair a missing index). Requires the maintain entitlement under a policy shell.",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" } },
      required: ["repo"],
    },
    outputSchema: LINKS_BACKFILL_SCHEMA,
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
      "List live docs whose written link text is stale vs. the target's current path (e.g. after a rename). Each row is (source_path, written, current).",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" } },
      required: ["repo"],
    },
    outputSchema: listResultSchema(STALE_LINK_SCHEMA, "Stale links in live docs."),
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
      "Rewrite stale link text in place via optimistic `docs_put`. `dry_run: true` plans only (no writes; read entitlement). Live repair requires the maintain entitlement. Per-document conflicts are skipped, not fatal.",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" }, dry_run: { type: "boolean" } },
      required: ["repo"],
    },
    outputSchema: LINKS_REPAIR_SCHEMA,
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
    description:
      "Search current documents (history is not searched). Returns lean projected hits, NOT full " +
      'documents: default `select` is ["$path"], so each hit is only `{ "$path": "…" }` — no ' +
      "body, no frontmatter, no version id. Pass `select` to project more (`$body`, `$repo`, " +
      "`$version_id`, `$content_hash`, `$updated_at`, `$author`, `$prev_version_id`, " +
      "`$next_version_id`, or bare frontmatter keys like `title`). Include `$repo` when querying " +
      "more than one repo. To recover whole documents, call `docs_get` (one path) or `docs_get_many` " +
      "(batch). Unmatched paths are " +
      "omitted, not errors. Default `limit` is 50. " +
      "Three composable modes that intersect (AND) when combined: `filter` (CEL over frontmatter " +
      "and $-intrinsics), `text` (full-text over bodies), `semantic` (embedding similarity — a " +
      'natural-language string, e.g. "tiered SaaS pricing"). Ordered by semantic score when ' +
      "`semantic` is present, else text relevance, else last-update time descending. When `semantic` " +
      "is active, add `$semantic_score` to `select` to project cosine similarity (1 = identical, " +
      "-1 = opposite); result order is the final rank. Requires an embed hook; else " +
      "`semantic_unavailable`. Filter examples: " +
      `status == "published" && "pricing" in list(tags)` +
      " (list() matches scalar-or-list frontmatter uniformly) — " +
      `$path.startsWith("guides/")` +
      " ($-intrinsics: $path, $updated_at, $body, $content_hash) — " +
      `$in("moc/**") && !$in("moc/contractors.md")` +
      " (link-graph membership) — " +
      "$links().size() == 0" +
      " (leaf docs) — " +
      `$backlinks().exists(d, d.status == "draft")` +
      ". Call the `query_syntax` tool for the full filter-language reference.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description:
            'Repo slug, gitignore-style glob (e.g. "team-*"), or a list of either. ' +
            "Omitted = every repo the caller can see.",
        },
        filter: {
          type: "string",
          description:
            "CEL boolean expression. Bare identifiers are frontmatter keys (a missing key never " +
            "matches); `$path` / `$updated_at` (ISO-8601 UTC) / `$body` / `$content_hash` are " +
            "document intrinsics; " +
            '`"x" in list(field)` handles scalar-or-list frontmatter; `$in(glob)` / `$has(glob)` ' +
            "/ `$backlinks()` / `$links()` query the link graph. String functions: contains, " +
            "startsWith, endsWith, matches, size. Full reference: the `query_syntax` tool.",
        },
        text: {
          type: "string",
          description:
            "Full-text search over document bodies. Portable syntax: space-separated terms " +
            '(implicit AND) and "quoted phrases"; other operators are storage-backend-specific.',
        },
        semantic: {
          type: "string",
          description:
            'Semantic search via embeddings — a natural-language query, e.g. "tiered SaaS pricing". ' +
            "Composes with filter and text (AND). Requires an embed hook on the server; else " +
            "semantic_unavailable. Add $semantic_score to select to project cosine similarity per " +
            "hit (1 = identical, -1 = opposite). See query_syntax for the full semantic mode " +
            "reference.",
        },
        limit: { type: "integer", minimum: 0, description: "Max results (default 50)." },
        include_hidden: {
          type: "boolean",
          description: "Include docs under hidden path segments (e.g. `.drafts/…`).",
        },
        include_system: {
          type: "boolean",
          description:
            "Include docs under system path segments (e.g. `:deleted/…`) — how you browse " +
            "trash to find documents to restore.",
        },
        select: {
          type: "array",
          items: { type: "string" },
          description:
            'Fields to project onto each hit. Default ["$path"] — that is ALL you get unless you ' +
            "pass this. Bare keys name frontmatter (a missing key is simply absent); `$`-intrinsics " +
            "name system fields: $path, $repo, $version_id, $prev_version_id, $next_version_id, " +
            "$updated_at, $author, $body, $content_hash, $semantic_score (semantic queries only). " +
            "Document bodies travel only when `$body` is " +
            "selected. This is how you list cheaply; call `docs_get` or `docs_get_many` for full document(s).",
        },
        scope: {
          type: "array",
          description:
            "Read-visibility claims (ScopeClaim[]) narrowing what this query sees. The X-Mrplex-Scope header, if present, wins.",
          items: { type: "object", additionalProperties: true },
        },
      },
    },
    outputSchema: listResultSchema(QUERY_HIT_SCHEMA, "Matching current documents, projected."),
    handler: async (kernel, ctx, args) => {
      const { scope: _scope, ...specArgs } = args;
      const spec = specArgs as QuerySpec;
      try {
        const rows = await kernel.query(queryCtx(ctx, args), spec);
        return { structured: wrapList(rows), text: renderQueryHitList(rows) };
      } catch (err) {
        // Teach through the error: a bad filter is the moment the caller
        // most wants the language reference.
        if (err instanceof KernelError && err.code === "filter_invalid") {
          throw new KernelError("filter_invalid", {
            ...(err.data as Record<string, unknown>),
            hint: "call the `query_syntax` tool for the full filter-language reference",
          });
        }
        throw err;
      }
    },
  },
  // ---- graph ----
  {
    name: "graph",
    description:
      "Explore how documents connect. BFS neighborhood expansion over the link graph: from a set " +
      "of `roots`, expand under a `direction` lens up to `degrees` hops, returning the reached " +
      "`documents` AND the `links` between them. Where `query` answers *which* documents match, " +
      "`graph` answers *how* they connect. Unlike `query`, every document always includes `$path`, " +
      "`$degrees`, `$links`, `$backlinks`; `select` only adds bare frontmatter keys (default " +
      '["title"]). `filter` is CEL evaluated as VISIBILITY (not selection): a non-matching ' +
      "document is hidden AND blocks paths through itself — plus the graph-only `$degrees` " +
      'intrinsic (min hops from the nearest root). Killer pattern: `$degrees <= 1 || type == "person"` ' +
      "— expand everything one hop, but keep following person docs. Results are deterministic. " +
      "Continue past the `frontier` by re-rooting a follow-up call at chosen frontier paths (no " +
      "cursors). See the `query_syntax` tool for the filter language.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repo slug (exactly one; links are repo-local)." },
        roots: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description:
            "Root document(s): an exact path or gitignore-style glob, or a list of either. Every " +
            "visible, filter-matching current document matching any pattern enters at $degrees 0. " +
            "A glob matching nothing yields an empty result (not an error).",
        },
        direction: {
          type: "string",
          enum: ["out", "in", "both"],
          description:
            'Traversal lens (default "both"). "out": follow links source→target (what this doc ' +
            'references, transitively). "in": target→source (the backlink neighborhood). "both": ' +
            "undirected (degrees-of-separation; co-citation appears at degrees 2+).",
        },
        degrees: {
          type: "integer",
          minimum: 0,
          description: "Max hops from the nearest root (default 1; 0 = roots only). Server-capped.",
        },
        fields: {
          type: "array",
          items: { type: "string" },
          description:
            'Restrict BOTH traversal and output links to these relationship fields. `"$body"` is a ' +
            "valid member (untyped body links); other members are frontmatter field names.",
        },
        filter: {
          type: "string",
          description:
            "CEL boolean expression, same dialect as `query` (frontmatter keys, $-intrinsics, " +
            "$in/$has/$links()/$backlinks()) PLUS `$degrees` (min hops from the nearest root — " +
            "legal only here). Semantics: VISIBILITY — a non-matching document is not returned and " +
            "blocks paths through itself.",
        },
        select: {
          type: "array",
          items: { type: "string" },
          description:
            'Frontmatter keys to project onto result documents as bare keys (default ["title"]). ' +
            "A missing key on a given doc is simply absent. Bare keys only (no $-intrinsics).",
        },
        max_documents: {
          type: "integer",
          minimum: 1,
          description:
            "Soft budget on documents (incl. roots; default 100, server hard-capped). Links are a " +
            "consequence, not budgeted. Truncation is deterministic (BFS order, $path tiebreak).",
        },
        scope: {
          type: "array",
          description:
            "Read-visibility claims (ScopeClaim[]) narrowing what this call sees. The X-Mrplex-Scope " +
            "header, if present, wins. An out-of-scope endpoint hides the doc, its links, and paths " +
            "through it.",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["repo", "roots"],
    },
    outputSchema: GRAPH_RESULT_SCHEMA,
    handler: async (kernel, ctx, args) => {
      const { scope: _scope, ...specArgs } = args;
      const spec = specArgs as unknown as GraphSpec;
      try {
        const result = await kernel.graph(queryCtx(ctx, args), spec);
        return {
          structured: result as unknown as Record<string, unknown>,
          text: renderGraphSummary(result),
        };
      } catch (err) {
        if (err instanceof KernelError && err.code === "filter_invalid") {
          throw new KernelError("filter_invalid", {
            ...(err.data as Record<string, unknown>),
            hint: "call the `query_syntax` tool for the full filter-language reference ($degrees is graph-only)",
          });
        }
        throw err;
      }
    },
  },
  {
    name: "history_since",
    description:
      "The global change feed. Given an opaque cursor `after_version`, returns the longest " +
      "GAP-FREE contiguous run of change refs after it, plus `next_since` to resume. Each ref is a " +
      "lightweight pointer — `version_id`, `prev_version_id`, `repo`, `path`, `prev_path` (both ends " +
      "of a move/delete), `content_hash` (skip a fetch when you already have these bytes), a " +
      "server-derived `op` (create/update/move/delete), and `created_at`. Fetch bodies via " +
      "`docs_get_version` only when needed. Persist exactly `next_since`; feed it back to poll. A " +
      "short/empty page means caught-up or waiting on an in-flight write — just poll again. Pass " +
      '`after_version: ""` to start from the beginning of the log.',
    inputSchema: {
      type: "object",
      properties: {
        after_version: {
          type: "string",
          description: 'Opaque resume cursor. "" (empty) starts from the beginning of the log.',
        },
        repo: { type: "string", description: "Optional repo slug filter." },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Max refs per page (server default applies when omitted).",
        },
        scope: {
          type: "array",
          description: "Read-visibility claims (ScopeClaim[]); the X-Mrplex-Scope header wins.",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["after_version"],
    },
    outputSchema: {
      type: "object",
      properties: {
        refs: { type: "array", items: VERSION_REF_SCHEMA, description: "Settled change refs." },
        next_since: { type: "string", description: "Opaque cursor to resume the feed." },
      },
      required: ["refs", "next_since"],
    },
    handler: async (kernel, ctx, args) => {
      const input = {
        after_version: argStr(args, "after_version"),
        repo: argStrOpt(args, "repo"),
        limit: argIntOpt(args, "limit"),
      };
      const page = await kernel.history.since(queryCtx(ctx, args), input);
      return {
        structured: page as unknown as Record<string, unknown>,
        text: page.refs.map((r) => JSON.stringify(r)).join("\n"),
      };
    },
  },
  {
    name: "history_index",
    description:
      "Page the live document set of one repo as of a safe head R — the startup/reconciliation " +
      "enumeration a sync client runs before tailing. Returns lightweight {path, version_id, " +
      "content_hash} tuples in current-version-id order, keyset-paginated and bounded through R. " +
      "On the first call omit `through_version`; the server captures R and echoes it — pass it back " +
      "(plus `after_version` = the previous page's last version_id) on subsequent pages. System " +
      "(`:deleted/`) and hidden (`.`-prefixed) paths are excluded, as `query` defaults. The handoff " +
      "is exact: a base scan over (cursor, R] plus `history_since`(R) is gap-free, so a doc updated " +
      "mid-pagination simply arrives later on the feed.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repo slug (the scan is per-repo)." },
        through_version: {
          type: "string",
          description: "The safe head R; omit on the first call (server captures + returns it).",
        },
        after_version: {
          type: "string",
          description: "Previous page's last version_id; omit on the first call.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Max items per page (server default applies when omitted).",
        },
        scope: {
          type: "array",
          description: "Read-visibility claims (ScopeClaim[]); the X-Mrplex-Scope header wins.",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["repo"],
    },
    outputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "Live-set entries in current-version-id order.",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              version_id: { type: "string" },
              content_hash: { type: "string" },
            },
            required: ["path", "version_id", "content_hash"],
          },
        },
        through_version: { type: "string", description: "The safe head R (echo on later pages)." },
        next_after_version: {
          type: "string",
          description: "Cursor for the next page; absent on the final page.",
        },
      },
      required: ["items", "through_version"],
    },
    handler: async (kernel, ctx, args) => {
      const page = await kernel.history.index(queryCtx(ctx, args), {
        repo: argStr(args, "repo"),
        through_version: argStrOpt(args, "through_version"),
        after_version: argStrOpt(args, "after_version"),
        limit: argIntOpt(args, "limit"),
      });
      return {
        structured: page as unknown as Record<string, unknown>,
        text: page.items.map((i) => JSON.stringify(i)).join("\n"),
      };
    },
  },
  {
    name: "query_syntax",
    description:
      "Reference documentation for the `query` / `graph` filter language and `query`'s result " +
      "shape: CEL syntax, $-intrinsics ($path, $updated_at, $body, $content_hash), `select` " +
      '(default ["$path"] only — not full documents), list() scalar-or-list polymorphism, ' +
      "link-graph predicates ($in, $has, $backlinks(), $links()), graph-only `$degrees`, " +
      "text-search syntax, semantic mode (`semantic` query param, `$semantic_score` in `select`). " +
      "Call this before writing a non-trivial filter, or after a filter_invalid error.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        reference: {
          type: "string",
          description: "Markdown reference for the query filter language.",
        },
      },
      required: ["reference"],
    },
    handler: () => ({
      structured: { reference: QUERY_SYNTAX_DOC },
      text: QUERY_SYNTAX_DOC,
    }),
  },
];

/** Convenient lookup by name. */
export function toolByName(name: string): ToolEntry | undefined {
  return TOOL_REGISTRY.find((t) => t.name === name);
}
