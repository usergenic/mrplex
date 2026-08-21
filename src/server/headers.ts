/**
 * Shared HTTP-surface header parsing (noauth plan §4). Both the REST router
 * and the MCP Streamable-HTTP surface read the caller's per-request
 * `CallContext` from the same `X-Mrplex-*` headers — this is the single place
 * that mapping lives, so a future header addition happens once.
 *
 * There is no auth: the header is the shell-injection path. `X-Mrplex-Author`
 * stamps writes; `X-Mrplex-Scope` (JSON `ScopeClaim[]`) narrows reads. A
 * malformed scope throws `KernelError("filter_invalid")` (via parseScopeClaims),
 * which both surfaces map to a 400 — a bad claim is a loud client error, not a
 * silent full-access fallback.
 */

import type { IncomingMessage } from "node:http";
import { type CallContext, parseScopeClaims } from "../kernel/context.js";

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
