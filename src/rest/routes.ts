/**
 * REST route table — design §6.3.
 *
 * Small hand-rolled router over node:http (m3-plan §5 decision 1). The
 * route table isn't complex enough to justify a framework; the two hard
 * parts (multi-segment `{path}` params and header-driven dispatch) aren't
 * framework strengths.
 *
 * Every non-2xx response body is `{ code, data }`. Kernel errors carry
 * their catalog code (§6.3); HTTP-only dispatch outcomes use surface-only
 * codes (`method_not_allowed`, `no_route`); uncaught throwables fall back
 * to `{ code: "internal_error" }` on 500.
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
import { actorFromRequest } from "../server/auth.js";
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
  // decodeURIComponent throws URIError on malformed input (e.g. "/repos/%E0%A4%A");
  // treat that as a client-side path_invalid rather than letting it bubble to 500.
  const segments = raw === "" ? [] : raw.split("/").map(decodeSegment);
  return { segments, query: u.searchParams };
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new KernelError("path_invalid", {
      reason: "malformed percent-encoding in URL segment",
    });
  }
}

// -----------------------------------------------------------------------------
// Body reading + JSON parse
// -----------------------------------------------------------------------------

const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8 MB safety cap — well above any single markdown doc.

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      if (capped) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        capped = true;
        // Destroy the socket so we don't keep receiving bytes we've decided
        // to reject — otherwise a hostile client could stream indefinitely.
        req.destroy();
        reject(
          new KernelError("payload_too_large", {
            reason: `body exceeded ${MAX_BODY_BYTES} bytes`,
            limit: MAX_BODY_BYTES,
          }),
        );
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!capped) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (!capped) reject(err);
    });
  });
}

function parseJsonBody(raw: string): unknown {
  if (raw === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    // filter_invalid is the general "malformed input" bucket at the wire
    // layer; distinct from frontmatter_invalid (§4.3), which is YAML-only.
    throw new KernelError("filter_invalid", { reason: "request body is not valid JSON" });
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

/** Missing precondition per m3-plan decision 5 / design §6.3. */
function writePreconditionRequired(res: ServerResponse, reason: string): void {
  writeJson(res, 428, {
    code: "precondition_required",
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

  notFound(res);
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
  const actor = await actorFromRequest(req, storage);

  // GET /repos, POST /repos
  if (segments.length === 1) {
    if (method === "GET") {
      const includeSystem = query.get("include_system") === "true";
      const result = await kernel.repos.list(actor, { include_system: includeSystem });
      writeJson(res, 200, result);
      return;
    }
    if (method === "POST") {
      const body = parseJsonBody(await readBody(req)) as { slug?: unknown };
      if (typeof body.slug !== "string") {
        throw new KernelError("slug_invalid", { reason: "body.slug required (string)" });
      }
      const result = await kernel.repos.create(actor, body.slug);
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
      writeJson(res, 200, await kernel.repos.get(actor, repoSlug));
      return;
    }
    if (method === "MOVE") {
      const dest = parseRepoDestination(req.headers.destination);
      if (dest === null) {
        throw new KernelError("slug_invalid", { reason: "Destination header required" });
      }
      writeJson(res, 200, await kernel.repos.rename(actor, repoSlug, dest));
      return;
    }
    if (method === "DELETE") {
      writeJson(res, 200, await kernel.repos.delete(actor, repoSlug));
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
    writeJson(res, 200, await kernel.repos.set_path_config(actor, repoSlug, cfg));
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
    const v = await kernel.docs.get_version(actor, repoSlug, versionId);
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
    const rows = await kernel.docs.history(actor, repoSlug, path, { limit, before });
    writeJson(res, 200, rows);
    return;
  }

  // /repos/{repo}/diff/{path...}?from=&to=  — M4 (§6.3)
  if (segments[2] === "diff") {
    if (method !== "GET") return methodNotAllowed(res, method, ["GET"]);
    const pathSegs = segments.slice(3);
    if (pathSegs.length === 0) return notFound(res);
    const path = pathSegs.join("/");
    const from = query.get("from");
    const to = query.get("to");
    if (from === null || to === null) {
      // Missing required query params — 400 with a clear body.
      writeJson(res, 400, {
        code: "filter_invalid",
        data: { reason: "diff requires `from` and `to` query parameters (version ids)" },
      });
      return;
    }
    const d = await kernel.docs.diff(actor, repoSlug, path, from, to);
    // Content negotiation: Accept: text/plain → raw patch, else JSON.
    const accept = (req.headers.accept as string | undefined) ?? "application/json";
    if (accept.includes("text/plain")) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(d.patch);
      return;
    }
    writeJson(res, 200, d);
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
    const v = await kernel.docs.get(actor, repoSlug, path);
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
    // input.body distinguishes three states:
    //   • string ("" allowed)   → caller explicitly set the body
    //   • undefined             → caller omitted body (put: carry over from prev; create: empty)
    // Non-string values (numbers, objects, null) are a client error — never silently coerced to ""
    // (previously that could wipe a document's body).
    let input: { frontmatter?: unknown; frontmatter_raw?: string; body: string | undefined };
    if (ct === "markdown") {
      const parsed = parseMarkdown(raw);
      input = { frontmatter_raw: parsed.frontmatter_raw, body: parsed.body };
    } else {
      const parsed = parseJsonBody(raw) as {
        frontmatter?: unknown;
        frontmatter_raw?: unknown;
        body?: unknown;
      };
      if (parsed.body !== undefined && typeof parsed.body !== "string") {
        throw new KernelError("filter_invalid", { reason: "body must be a string" });
      }
      input = {
        frontmatter: parsed.frontmatter,
        frontmatter_raw:
          typeof parsed.frontmatter_raw === "string" ? parsed.frontmatter_raw : undefined,
        body: parsed.body,
      };
    }

    if (ifNoneMatch !== null) {
      if (ifNoneMatch.kind !== "any") {
        writePreconditionRequired(res, "If-None-Match must be '*' for create");
        return;
      }
      // Create: an omitted body means "empty document" — no prev to carry from.
      const v = await kernel.docs.create(actor, repoSlug, path, {
        frontmatter: input.frontmatter as never,
        frontmatter_raw: input.frontmatter_raw,
        body: input.body ?? "",
      });
      writeJson(res, 201, v, { ETag: etagOf(v.version_id) });
      return;
    }

    // ifMatch !== null — update or move.
    if (ifMatch === null || ifMatch.kind === "any") {
      writePreconditionRequired(
        res,
        "the strict surface requires a specific version_id; If-Match: * is reserved for the WebDAV gateway (§11.1)",
      );
      return;
    }
    // PUT: omitted body → kernel carries over from prev.
    const putInput: { frontmatter?: never; frontmatter_raw?: string; body?: string } = {};
    if (input.frontmatter !== undefined) putInput.frontmatter = input.frontmatter as never;
    if (input.frontmatter_raw !== undefined) putInput.frontmatter_raw = input.frontmatter_raw;
    if (input.body !== undefined) putInput.body = input.body;
    const v = await kernel.docs.put(actor, repoSlug, ifMatch.version_id, path, putInput);
    writeJson(res, 200, v, { ETag: etagOf(v.version_id) });
    return;
  }

  if (method === "DELETE") {
    const ifMatch = parseIfMatch(req.headers["if-match"] as string | undefined);
    if (ifMatch === null || ifMatch.kind !== "version") {
      writePreconditionRequired(res, "DELETE requires If-Match: <version_id>");
      return;
    }
    // The URL path is authoritative for DELETE — verify the If-Match version
    // currently lives at (repo, path). If the doc has moved or been deleted
    // since If-Match was observed, stale_prev with the actual current pointer.
    // If nothing lives at path at all, kernel.docs.get raises doc_not_found (404).
    const current = await kernel.docs.get(actor, repoSlug, path);
    if (current.version_id !== ifMatch.version_id) {
      throw new KernelError("stale_prev", {
        current_version_id: current.version_id,
        current_path: current.path,
        submitted_prev_version_id: ifMatch.version_id,
      });
    }
    const v = await kernel.docs.delete(actor, repoSlug, ifMatch.version_id);
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
    const v = await kernel.docs.put(actor, repoSlug, ifMatch.version_id, dest, {});
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
  const actor = await actorFromRequest(req, storage);

  if (segments.length === 1) {
    if (method === "GET") {
      writeJson(res, 200, await kernel.users.list(actor));
      return;
    }
    if (method === "POST") {
      const body = parseJsonBody(await readBody(req)) as { slug?: unknown };
      if (typeof body.slug !== "string") {
        throw new KernelError("slug_invalid", { reason: "body.slug required (string)" });
      }
      writeJson(res, 201, await kernel.users.create(actor, body.slug));
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
      writeJson(res, 200, await kernel.users.rename(actor, userSlug, dest));
      return;
    }
    if (method === "DELETE") {
      writeJson(res, 200, await kernel.users.delete(actor, userSlug));
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
  const actor = await actorFromRequest(req, storage);

  if (segments.length === 2) {
    if (method === "GET") {
      writeJson(res, 200, await kernel.tokens.list(actor));
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
      const result = await kernel.tokens.create(
        actor,
        (body.label ?? null) as string | null,
        scopes,
        { admin, expires_at },
      );
      writeJson(res, 201, result);
      return;
    }
    return methodNotAllowed(res, method, ["GET", "POST"]);
  }

  if (segments.length === 3) {
    const tokenId = segments[2] as string;
    if (method !== "DELETE") return methodNotAllowed(res, method, ["DELETE"]);
    writeJson(res, 200, await kernel.tokens.revoke(actor, tokenId));
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
  const actor = await actorFromRequest(req, storage);

  let spec: QuerySpec;
  if (method === "GET") {
    spec = specFromQueryString(query);
  } else if (method === "POST") {
    const body = parseJsonBody(await readBody(req)) as Record<string, unknown>;
    spec = coerceQuerySpec(body);
  } else {
    return methodNotAllowed(res, method, ["GET", "POST"]);
  }

  const results = await kernel.query(actor, spec);
  const etag = queryEtag(results);
  const inm = parseQueryIfNoneMatch(req.headers["if-none-match"] as string | undefined);
  if (inm !== null && (inm.kind === "any" || inm.hash === etag)) {
    writeEmpty(res, 304, { ETag: `"${etag}"` });
    return;
  }
  writeJson(res, 200, results, { ETag: `"${etag}"` });
}

/**
 * Query-ETag If-None-Match parser. Accepts `*`, quoted-hex (`"deadbeef"`),
 * or a bare hex hash — but not weak validators (`W/"…"`). Distinct from
 * conditional.ts's parseIfNoneMatch which requires the version_id shape.
 */
type QueryIfNoneMatch = { kind: "any" } | { kind: "hash"; hash: string };
function parseQueryIfNoneMatch(headerValue: string | undefined): QueryIfNoneMatch | null {
  if (!headerValue) return null;
  const t = headerValue.trim();
  if (t === "") return null;
  if (t.startsWith("W/")) return null;
  if (t === "*") return { kind: "any" };
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return { kind: "hash", hash: t.slice(1, -1) };
  }
  return { kind: "hash", hash: t };
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
  const decoded = path.replace(/^\//, "").split("/").map(decodeSegment);
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
  const decoded = path.replace(/^\//, "").split("/").map(decodeSegment);
  if (decoded.length !== 2 || decoded[0] !== "repos") return null;
  return decoded[1] as string;
}

function parseUserDestination(headerValue: string | string[] | undefined): string | null {
  const path = parseDestinationHeader(headerValue);
  if (path === null) return null;
  const decoded = path.replace(/^\//, "").split("/").map(decodeSegment);
  if (decoded.length !== 2 || decoded[0] !== "users") return null;
  return decoded[1] as string;
}

// -----------------------------------------------------------------------------
// Small dispatch helpers
// -----------------------------------------------------------------------------

// method_not_allowed and no_route are surface-only codes (not KernelErrorCodes)
// — they identify legitimate HTTP dispatch outcomes, not kernel or server
// bugs. Distinct from `internal_error` (500 fallback for uncaught throwables)
// so log aggregators can discriminate.
function methodNotAllowed(res: ServerResponse, method: string, allowed: string[]): void {
  writeJson(
    res,
    405,
    { code: "method_not_allowed", data: { method, allowed } },
    { Allow: allowed.join(", ") },
  );
}

function notFound(res: ServerResponse): void {
  writeJson(res, 404, { code: "no_route", data: {} });
}
