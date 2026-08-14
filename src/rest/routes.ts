/**
 * REST route table — design §6.3.
 *
 * Small hand-rolled router over node:http (m3-plan §5 decision 1). The
 * route table isn't complex enough to justify a framework; the two hard
 * parts (multi-segment `{path}` params and header-driven dispatch) aren't
 * framework strengths.
 *
 * Every non-2xx response body is `{ code, data }` — verbatim from the
 * kernel error (§6.3). 500s fall back to `{ code: "internal_error" }`.
 */

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Actor } from "../kernel/auth/actor.js";
import type { ScopeInput } from "../kernel/auth/scope.js";
import { KernelError } from "../kernel/errors.js";
import type { Kernel } from "../kernel/kernel.js";
import type { PathConfigOverride } from "../kernel/path-config.js";
import type { QuerySpec } from "../kernel/query/query.js";
import type { Version } from "../kernel/wire.js";
import { actorFromRequest, extractBearerFromHeader } from "../server/auth.js";
import { httpErrorForThrowable } from "../server/http-error.js";
import type { Storage } from "../storage/types.js";
import { etagOf, parseIfMatch, parseIfNoneMatch } from "./conditional.js";
import {
  chooseDocReadAccept,
  chooseDocWriteContentType,
  parseMarkdown,
  renderMarkdown,
} from "./negotiate.js";

export type RestMount = {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
};

export type RestConfig = {
  kernel: Kernel;
  storage: Storage;
};

// -----------------------------------------------------------------------------
// URL parsing — split first, percent-decode per segment (never the reverse).
// -----------------------------------------------------------------------------

type ParsedUrl = {
  segments: string[];
  query: URLSearchParams;
};

function parseUrl(reqUrl: string): ParsedUrl {
  // A URL with no host is unparseable by `new URL(x)`, so prefix a dummy
  // origin. The origin never appears in `.pathname` / `.searchParams`.
  const u = new URL(reqUrl, "http://x");
  const path = u.pathname;
  // Strip leading slash, then split. Empty leading segment (from `/`) is
  // dropped; trailing `/` becomes a trailing empty segment we also drop.
  const raw = path.replace(/^\//, "").replace(/\/$/, "");
  const segments = raw === "" ? [] : raw.split("/").map((s) => decodeURIComponent(s));
  return { segments, query: u.searchParams };
}

// -----------------------------------------------------------------------------
// Body reading + JSON parse
// -----------------------------------------------------------------------------

const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8 MB safety cap — well above any single markdown doc.

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseJsonBody(raw: string): unknown {
  if (raw === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new KernelError("frontmatter_invalid", { reason: "request body is not valid JSON" });
  }
}

// -----------------------------------------------------------------------------
// Response helpers
// -----------------------------------------------------------------------------

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  }
  res.end(`${JSON.stringify(body)}\n`);
}

function writeMarkdown(
  res: ServerResponse,
  status: number,
  body: string,
  extraHeaders?: Record<string, string>,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  }
  res.end(body);
}

function writeEmpty(
  res: ServerResponse,
  status: number,
  extraHeaders?: Record<string, string>,
): void {
  res.statusCode = status;
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  }
  res.end();
}

function writeError(res: ServerResponse, err: unknown): void {
  const httpErr = httpErrorForThrowable(err);
  const headers: Record<string, string> = {};
  if (httpErr.etag !== undefined) headers.ETag = etagOf(httpErr.etag);
  writeJson(res, httpErr.status, httpErr.body, headers);
}

/** Missing precondition per m3-plan decision 5. */
function writePreconditionRequired(res: ServerResponse, reason: string): void {
  writeJson(res, 428, {
    code: "frontmatter_invalid",
    data: { reason },
  });
}

// -----------------------------------------------------------------------------
// Query-response ETag — hash of the sorted version_id list (§6.3 [OPEN]
// resolved by m3-plan decision 8).
// -----------------------------------------------------------------------------

function queryEtag(versions: readonly Version[]): string {
  const ids = versions
    .map((v) => v.version_id)
    .slice()
    .sort();
  const h = createHash("sha256").update(ids.join("\n")).digest("hex");
  // Short ETag — first 16 hex chars are plenty for collision resistance
  // within a single result set's lifespan (2^64 hashes).
  return h.slice(0, 16);
}

// -----------------------------------------------------------------------------
// Route table
// -----------------------------------------------------------------------------

export function mountRestSurface(config: RestConfig): RestMount {
  const { kernel, storage } = config;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await dispatch(req, res, kernel, storage);
    } catch (err) {
      writeError(res, err);
    }
  }

  return { handle };
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  kernel: Kernel,
  storage: Storage,
): Promise<void> {
  const { segments, query } = parseUrl(req.url ?? "/");
  const method = (req.method ?? "GET").toUpperCase();

  // Root — trivial liveness ping.
  if (segments.length === 0) {
    writeJson(res, 200, { name: "mrplex", surfaces: ["rest", "mcp"] });
    return;
  }

  // /me/tokens — actor-scoped self-management.
  if (segments[0] === "me" && segments[1] === "tokens") {
    return dispatchMeTokens(req, res, kernel, storage, segments, method);
  }

  // /users — repo-independent.
  if (segments[0] === "users") {
    return dispatchUsers(req, res, kernel, storage, segments, method);
  }

  // /query — GET or POST.
  if (segments[0] === "query" && segments.length === 1) {
    return dispatchQuery(req, res, kernel, storage, query, method);
  }

  // /repos and everything under it (config, docs, versions, history).
  if (segments[0] === "repos") {
    return dispatchRepos(req, res, kernel, storage, segments, query, method);
  }

  writeJson(res, 404, { code: "internal_error", data: { reason: "no route" } });
}

// -----------------------------------------------------------------------------
// /repos*
// -----------------------------------------------------------------------------

async function dispatchRepos(
  req: IncomingMessage,
  res: ServerResponse,
  kernel: Kernel,
  storage: Storage,
  segments: string[],
  query: URLSearchParams,
  method: string,
): Promise<void> {
  const actor = actorFromRequest(req, storage);

  // GET /repos, POST /repos
  if (segments.length === 1) {
    if (method === "GET") {
      const includeSystem = query.get("include_system") === "true";
      const result = kernel.repos.list(actor, { include_system: includeSystem });
      writeJson(res, 200, result);
      return;
    }
    if (method === "POST") {
      const body = parseJsonBody(await readBody(req)) as { slug?: unknown };
      if (typeof body.slug !== "string") {
        throw new KernelError("slug_invalid", { reason: "body.slug required (string)" });
      }
      const result = kernel.repos.create(actor, body.slug);
      writeJson(res, 201, result);
      return;
    }
    return methodNotAllowed(res, method, ["GET", "POST"]);
  }

  const repoSlug = segments[1];
  if (repoSlug === undefined) return notFound(res);

  // /repos/{repo}
  if (segments.length === 2) {
    if (method === "GET") {
      writeJson(res, 200, kernel.repos.get(actor, repoSlug));
      return;
    }
    if (method === "MOVE") {
      const dest = parseRepoDestination(req.headers.destination);
      if (dest === null) {
        throw new KernelError("slug_invalid", { reason: "Destination header required" });
      }
      writeJson(res, 200, kernel.repos.rename(actor, repoSlug, dest));
      return;
    }
    if (method === "DELETE") {
      writeJson(res, 200, kernel.repos.delete(actor, repoSlug));
      return;
    }
    return methodNotAllowed(res, method, ["GET", "MOVE", "DELETE"]);
  }

  // /repos/{repo}/config
  if (segments.length === 3 && segments[2] === "config") {
    if (method !== "PUT") return methodNotAllowed(res, method, ["PUT"]);
    const body = parseJsonBody(await readBody(req)) as {
      path_config?: PathConfigOverride | null;
    };
    // Accept both the wrapped `{path_config: X}` form (matches §6.3 route
    // definition) and a bare object (either the override map or `null`).
    const cfg: PathConfigOverride | null =
      body && Object.prototype.hasOwnProperty.call(body, "path_config")
        ? (body.path_config as PathConfigOverride | null)
        : (body as unknown as PathConfigOverride | null);
    writeJson(res, 200, kernel.repos.set_path_config(actor, repoSlug, cfg));
    return;
  }

  // /repos/{repo}/docs/{path...}
  if (segments[2] === "docs") {
    const pathSegs = segments.slice(3);
    if (pathSegs.length === 0) return notFound(res);
    const path = pathSegs.join("/");
    return dispatchDocs(req, res, kernel, actor, repoSlug, path, method);
  }

  // /repos/{repo}/versions/{version_id}
  if (segments[2] === "versions") {
    if (segments.length !== 4) return notFound(res);
    if (method !== "GET") return methodNotAllowed(res, method, ["GET"]);
    const versionId = segments[3] as string;
    const v = kernel.docs.get_version(actor, repoSlug, versionId);
    return writeDocResponse(req, res, v);
  }

  // /repos/{repo}/history/{path...}
  if (segments[2] === "history") {
    if (method !== "GET") return methodNotAllowed(res, method, ["GET"]);
    const pathSegs = segments.slice(3);
    if (pathSegs.length === 0) return notFound(res);
    const path = pathSegs.join("/");
    const limit = readOptionalIntQueryParam(query, "limit");
    const before = query.get("before") ?? undefined;
    const rows = kernel.docs.history(actor, repoSlug, path, { limit, before });
    writeJson(res, 200, rows);
    return;
  }

  notFound(res);
}

async function dispatchDocs(
  req: IncomingMessage,
  res: ServerResponse,
  kernel: Kernel,
  actor: Actor,
  repoSlug: string,
  path: string,
  method: string,
): Promise<void> {
  if (method === "GET") {
    const v = kernel.docs.get(actor, repoSlug, path);
    return writeDocResponse(req, res, v);
  }

  if (method === "PUT") {
    const ifMatch = parseIfMatch(req.headers["if-match"] as string | undefined);
    const ifNoneMatch = parseIfNoneMatch(req.headers["if-none-match"] as string | undefined);

    if (ifNoneMatch === null && ifMatch === null) {
      writePreconditionRequired(
        res,
        "PUT requires If-Match: <version_id> (update) OR If-None-Match: * (create)",
      );
      return;
    }
    if (ifNoneMatch !== null && ifMatch !== null) {
      writePreconditionRequired(res, "supply either If-Match or If-None-Match, not both");
      return;
    }

    const ct = chooseDocWriteContentType(req.headers["content-type"] as string | undefined);
    const raw = await readBody(req);
    let input: { frontmatter?: unknown; frontmatter_raw?: string; body: string };
    if (ct === "markdown") {
      const parsed = parseMarkdown(raw);
      input = { frontmatter_raw: parsed.frontmatter_raw, body: parsed.body };
    } else {
      const parsed = parseJsonBody(raw) as {
        frontmatter?: unknown;
        frontmatter_raw?: unknown;
        body?: unknown;
      };
      input = {
        frontmatter: parsed.frontmatter,
        frontmatter_raw:
          typeof parsed.frontmatter_raw === "string" ? parsed.frontmatter_raw : undefined,
        body: typeof parsed.body === "string" ? parsed.body : "",
      };
    }

    if (ifNoneMatch !== null) {
      if (ifNoneMatch.kind !== "any") {
        writePreconditionRequired(res, "If-None-Match must be '*' for create");
        return;
      }
      const v = kernel.docs.create(actor, repoSlug, path, {
        frontmatter: input.frontmatter as never,
        frontmatter_raw: input.frontmatter_raw,
        body: input.body,
      });
      writeJson(res, 201, v, { ETag: etagOf(v.version_id) });
      return;
    }

    // ifMatch !== null — update or move.
    if (ifMatch === null || ifMatch.kind === "any") {
      writePreconditionRequired(
        res,
        "If-Match: * is not supported for docs.put — supply the version_id",
      );
      return;
    }
    const v = kernel.docs.put(actor, repoSlug, ifMatch.version_id, path, {
      frontmatter: input.frontmatter as never,
      frontmatter_raw: input.frontmatter_raw,
      body: input.body,
    });
    writeJson(res, 200, v, { ETag: etagOf(v.version_id) });
    return;
  }

  if (method === "DELETE") {
    const ifMatch = parseIfMatch(req.headers["if-match"] as string | undefined);
    if (ifMatch === null || ifMatch.kind !== "version") {
      writePreconditionRequired(res, "DELETE requires If-Match: <version_id>");
      return;
    }
    const v = kernel.docs.delete(actor, repoSlug, ifMatch.version_id);
    writeJson(res, 200, v, { ETag: etagOf(v.version_id) });
    return;
  }

  if (method === "MOVE") {
    const ifMatch = parseIfMatch(req.headers["if-match"] as string | undefined);
    if (ifMatch === null || ifMatch.kind !== "version") {
      writePreconditionRequired(res, "MOVE requires If-Match: <version_id>");
      return;
    }
    const dest = parseDocDestination(req.headers.destination, repoSlug);
    if (dest === null) {
      throw new KernelError("path_invalid", {
        reason: "Destination header required (same-repo)",
      });
    }
    const v = kernel.docs.put(actor, repoSlug, ifMatch.version_id, dest, {});
    writeJson(res, 200, v, { ETag: etagOf(v.version_id) });
    return;
  }

  methodNotAllowed(res, method, ["GET", "PUT", "DELETE", "MOVE"]);
}

/**
 * Common Version response: JSON envelope or markdown per `Accept`. Honors
 * `If-None-Match` on the current version_id → 304 (§6.3 [OPEN] resolved
 * by m3-plan decision 8).
 */
function writeDocResponse(req: IncomingMessage, res: ServerResponse, v: Version): void {
  const accept = chooseDocReadAccept(req.headers.accept as string | undefined);
  const inm = parseIfNoneMatch(req.headers["if-none-match"] as string | undefined);
  if (inm !== null && inm.kind === "version" && inm.version_id === v.version_id) {
    writeEmpty(res, 304, { ETag: etagOf(v.version_id) });
    return;
  }
  if (accept === "markdown") {
    writeMarkdown(res, 200, renderMarkdown(v.frontmatter_raw, v.body), {
      ETag: etagOf(v.version_id),
    });
    return;
  }
  writeJson(res, 200, v, { ETag: etagOf(v.version_id) });
}

// -----------------------------------------------------------------------------
// /users*
// -----------------------------------------------------------------------------

async function dispatchUsers(
  req: IncomingMessage,
  res: ServerResponse,
  kernel: Kernel,
  storage: Storage,
  segments: string[],
  method: string,
): Promise<void> {
  const actor = actorFromRequest(req, storage);

  if (segments.length === 1) {
    if (method === "GET") {
      writeJson(res, 200, kernel.users.list(actor));
      return;
    }
    if (method === "POST") {
      const body = parseJsonBody(await readBody(req)) as { slug?: unknown };
      if (typeof body.slug !== "string") {
        throw new KernelError("slug_invalid", { reason: "body.slug required (string)" });
      }
      writeJson(res, 201, kernel.users.create(actor, body.slug));
      return;
    }
    return methodNotAllowed(res, method, ["GET", "POST"]);
  }

  if (segments.length === 2) {
    const userSlug = segments[1] as string;
    if (method === "MOVE") {
      const dest = parseUserDestination(req.headers.destination);
      if (dest === null) {
        throw new KernelError("slug_invalid", { reason: "Destination header required" });
      }
      writeJson(res, 200, kernel.users.rename(actor, userSlug, dest));
      return;
    }
    if (method === "DELETE") {
      writeJson(res, 200, kernel.users.delete(actor, userSlug));
      return;
    }
    return methodNotAllowed(res, method, ["MOVE", "DELETE"]);
  }

  notFound(res);
}

// -----------------------------------------------------------------------------
// /me/tokens*
// -----------------------------------------------------------------------------

async function dispatchMeTokens(
  req: IncomingMessage,
  res: ServerResponse,
  kernel: Kernel,
  storage: Storage,
  segments: string[],
  method: string,
): Promise<void> {
  const actor = actorFromRequest(req, storage);

  if (segments.length === 2) {
    if (method === "GET") {
      writeJson(res, 200, kernel.tokens.list(actor));
      return;
    }
    if (method === "POST") {
      const body = parseJsonBody(await readBody(req)) as {
        label?: unknown;
        scopes?: unknown;
        admin?: unknown;
        expires_at?: unknown;
      };
      if (typeof body.label !== "string" && body.label !== null) {
        throw new KernelError("filter_invalid", { reason: "body.label required (string | null)" });
      }
      const scopes = normalizeScopesInput(body.scopes);
      const admin = body.admin === true;
      const expires_at =
        body.expires_at === undefined || body.expires_at === null
          ? null
          : typeof body.expires_at === "string"
            ? body.expires_at
            : null;
      const result = kernel.tokens.create(actor, (body.label ?? null) as string | null, scopes, {
        admin,
        expires_at,
      });
      writeJson(res, 201, result);
      return;
    }
    return methodNotAllowed(res, method, ["GET", "POST"]);
  }

  if (segments.length === 3) {
    const tokenId = segments[2] as string;
    if (method !== "DELETE") return methodNotAllowed(res, method, ["DELETE"]);
    writeJson(res, 200, kernel.tokens.revoke(actor, tokenId));
    return;
  }

  notFound(res);
}

function normalizeScopesInput(raw: unknown): ScopeInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new KernelError("filter_invalid", { reason: "body.scopes must be an array" });
  }
  return raw as ScopeInput[];
}

// -----------------------------------------------------------------------------
// /query
// -----------------------------------------------------------------------------

async function dispatchQuery(
  req: IncomingMessage,
  res: ServerResponse,
  kernel: Kernel,
  storage: Storage,
  query: URLSearchParams,
  method: string,
): Promise<void> {
  const actor = actorFromRequest(req, storage);

  let spec: QuerySpec;
  if (method === "GET") {
    spec = specFromQueryString(query);
  } else if (method === "POST") {
    const body = parseJsonBody(await readBody(req)) as Record<string, unknown>;
    spec = coerceQuerySpec(body);
  } else {
    return methodNotAllowed(res, method, ["GET", "POST"]);
  }

  const results = kernel.query(actor, spec);
  const etag = queryEtag(results);
  const inm = parseIfNoneMatch(req.headers["if-none-match"] as string | undefined);
  // For query ETags we intentionally compare the raw value (no `v` prefix)
  // — writing the check inline so parseIfNoneMatch's version_id-shape check
  // doesn't reject the query hash.
  const rawInm = normalizeInmForQuery(req.headers["if-none-match"] as string | undefined);
  if (rawInm !== null && (rawInm === etag || inm?.kind === "any")) {
    writeEmpty(res, 304, { ETag: `"${etag}"` });
    return;
  }
  writeJson(res, 200, results, { ETag: `"${etag}"` });
}

function normalizeInmForQuery(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const t = headerValue.trim();
  if (t.startsWith("W/")) return null;
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) return t.slice(1, -1);
  return t;
}

function readOptionalIntQueryParam(query: URLSearchParams, key: string): number | undefined {
  const raw = query.get(key);
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new KernelError("filter_invalid", {
      reason: `query param ${key} must be a positive integer`,
    });
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n)) {
    throw new KernelError("filter_invalid", { reason: `query param ${key} out of range` });
  }
  return n;
}

function specFromQueryString(query: URLSearchParams): QuerySpec {
  const spec: QuerySpec = {};
  const repos = query.getAll("repo");
  if (repos.length > 0) {
    // A single `repo=notes,team-*` is a comma-separated list; a repeated
    // `repo=` param is also a list. Both flatten to string[].
    const flat: string[] = [];
    for (const r of repos) for (const item of r.split(",")) if (item.length > 0) flat.push(item);
    spec.repo = flat.length === 1 ? (flat[0] as string) : flat;
  }
  const filter = query.get("filter");
  if (filter !== null) spec.filter = filter;
  const text = query.get("text");
  if (text !== null) spec.text = text;
  const rank = query.get("rank");
  if (rank !== null) spec.rank = rank;
  const limit = readOptionalIntQueryParam(query, "limit");
  if (limit !== undefined) spec.limit = limit;
  if (query.get("include_hidden") === "true") spec.include_hidden = true;
  if (query.get("include_system") === "true") spec.include_system = true;
  return spec;
}

function coerceQuerySpec(body: Record<string, unknown>): QuerySpec {
  // Pass the body through verbatim — the kernel's runQuery does the shape
  // validation. This keeps `filter_invalid` on unknown fields as the single
  // source of truth (design §5.1).
  return body as QuerySpec;
}

// -----------------------------------------------------------------------------
// Destination header parsers (WebDAV RFC 4918 §10.3 shape)
// -----------------------------------------------------------------------------

function parseDestinationHeader(headerValue: string | string[] | undefined): string | null {
  if (headerValue === undefined) return null;
  const v = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (v === undefined) return null;
  // Absolute URL or absolute path — accept either.
  try {
    // If it parses as a URL, take the pathname.
    if (v.startsWith("http://") || v.startsWith("https://")) {
      const u = new URL(v);
      return u.pathname;
    }
  } catch {
    // fall through
  }
  if (v.startsWith("/")) return v;
  return null;
}

function parseDocDestination(
  headerValue: string | string[] | undefined,
  repoSlug: string,
): string | null {
  const path = parseDestinationHeader(headerValue);
  if (path === null) return null;
  // Expect the form /repos/{repoSlug}/docs/{...path}
  const decoded = path
    .replace(/^\//, "")
    .split("/")
    .map((s) => decodeURIComponent(s));
  if (decoded.length < 4) return null;
  if (decoded[0] !== "repos" || decoded[2] !== "docs") return null;
  if (decoded[1] !== repoSlug) {
    // Cross-repo MOVE is rejected per §6.3.
    throw new KernelError("path_invalid", {
      reason: "cross-repo MOVE not supported (Destination must stay within source repo)",
    });
  }
  return decoded.slice(3).join("/");
}

function parseRepoDestination(headerValue: string | string[] | undefined): string | null {
  const path = parseDestinationHeader(headerValue);
  if (path === null) return null;
  const decoded = path
    .replace(/^\//, "")
    .split("/")
    .map((s) => decodeURIComponent(s));
  if (decoded.length !== 2 || decoded[0] !== "repos") return null;
  return decoded[1] as string;
}

function parseUserDestination(headerValue: string | string[] | undefined): string | null {
  const path = parseDestinationHeader(headerValue);
  if (path === null) return null;
  const decoded = path
    .replace(/^\//, "")
    .split("/")
    .map((s) => decodeURIComponent(s));
  if (decoded.length !== 2 || decoded[0] !== "users") return null;
  return decoded[1] as string;
}

// -----------------------------------------------------------------------------
// Small dispatch helpers
// -----------------------------------------------------------------------------

function methodNotAllowed(res: ServerResponse, method: string, allowed: string[]): void {
  writeJson(
    res,
    405,
    { code: "internal_error", data: { reason: `method ${method} not allowed` } },
    { Allow: allowed.join(", ") },
  );
}

function notFound(res: ServerResponse): void {
  writeJson(res, 404, { code: "internal_error", data: { reason: "no route" } });
}

// Silence "unused import" — we keep the import for future integrations.
void extractBearerFromHeader;
