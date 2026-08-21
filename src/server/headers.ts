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
import type { Kernel } from "../kernel/kernel.js";

/**
 * How a surface turns a request into the `CallContext` it dispatches with.
 * The REST and MCP mounts accept one of these instead of hard-calling
 * [[contextFromHeaders]], so an authenticating shell can substitute an
 * entitlement-derived context (author + read scope from a credential, not
 * from client-supplied headers) without forking the surface code. The default
 * everywhere is `contextFromHeaders`. May be async — a shell front verifying a
 * JWT does I/O; the header default does not.
 */
export type ContextForRequest = (req: IncomingMessage) => CallContext | Promise<CallContext>;

/**
 * How a surface obtains the `Kernel` to dispatch a request against. The default
 * (a closure returning the one shared kernel) is what the raw engine uses; the
 * auth shell supplies a factory that authenticates the request and returns a
 * per-principal *guarded* kernel — so write/destructive policy lives in the
 * decorator, not in the surface. May throw (auth failure) or be async
 * (credential verification does I/O); the surface maps a throw to its error
 * response, so an `HttpResponseError(401, "unauthorized")` becomes a clean 401.
 */
export type KernelForRequest = (req: IncomingMessage) => Kernel | Promise<Kernel>;

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
