/**
 * guardKernel — the access-and-identity decorator (auth-shell plan §1, WS2).
 *
 * The shell's core is NOT a proxy: it is an object with the same shape as the
 * `Kernel` interface whose every method
 *   • stamps `ctx.author` from the entitlement (never trusts the caller's,
 *     unless `impersonate`),
 *   • forwards reads with `ctx.scope = entitlement.read` (the engine does the
 *     filtering — search ranking, pagination, graph traversal stay kernel-side),
 *   • enforces write policy against the TYPED call arguments using
 *     `entitlement.write` and the engine's own glob dialect,
 *   • gates maintenance ops (backfill / live repair) on `entitlement.maintain`,
 *   • gates structural admin ops on `entitlement.destructive`,
 *   • and forwards to the wrapped kernel.
 *
 * The kernel never learns any of this exists. The shell imports only the
 * kernel's public seam (`Kernel`, `CallContext`, `ScopeClaim`, the glob engine
 * via `normalizeClaims`); nothing here reaches into engine internals, so the
 * whole module could be extracted to its own package without touching engine
 * code — that extractability is the test of the boundary (plan §intro).
 *
 * Write enforcement replays the old design §8.2 rules (plan decision 5):
 * both-endpoints on moves, system-sigil endpoints skipped (the kernel's
 * validatePath owns that namespace), and write does NOT imply read — so writes
 * forward with no read-scope, or the engine's repo-visibility check would
 * block a write to a repo the caller can't read (plan decision, §1 writes).
 */

import { claimsGrantRead as claimsCoverPath, normalizeClaims } from "../kernel/auth/scope.js";
import type { CallContext } from "../kernel/context.js";
import { pathIsInSystemNamespace } from "../kernel/deletion.js";
import { forbidden } from "../kernel/errors.js";
import type { Kernel } from "../kernel/kernel.js";
import { HARDCODED_DEFAULTS } from "../kernel/path-config.js";
import type { Entitlement } from "./policy.js";

/**
 * One audited call. The guard supplies the operation-shaped fields; the sink's
 * owner (embedded serve / stdio launcher) adds `ts` and `principal` — the guard
 * is principal-agnostic, it only knows the compiled entitlement.
 */
export type AuditEvent = {
  /** Dotted op name, e.g. `docs.put`, `repos.delete`, `query`. */
  op: string;
  repo?: string;
  path?: string;
  outcome: "ok" | "forbidden";
  /** Kernel error code when the forwarded call threw (outcome stays "ok" — the
   * shell allowed it; the engine rejected it for its own reasons). */
  error?: string;
};

export type AuditSink = (event: AuditEvent) => void;

/**
 * Wrap a full-trust kernel in an entitlement. The returned object satisfies the
 * `Kernel` interface exactly, so any surface (embedded HTTP, stdio MCP) mounts
 * it unchanged.
 */
export function guardKernel(kernel: Kernel, entitlement: Entitlement, audit?: AuditSink): Kernel {
  const writeMatchers = normalizeClaims(entitlement.write);
  const sigils = HARDCODED_DEFAULTS.system_sigils;

  /** Identity stamped on writes — the caller's author only when impersonating. */
  function authorFor(ctx: CallContext): string {
    return entitlement.impersonate && ctx.author !== undefined ? ctx.author : entitlement.author;
  }

  /** Context for a read: the entitlement's read scope, nothing caller-supplied. */
  function readCtx(): CallContext {
    return { scope: entitlement.read };
  }

  /**
   * Context for a write/destructive op: the derived author and NO scope. Write
   * does not imply read (plan decision 5), so forwarding a read scope here would
   * make the engine's repo-visibility check reject a legitimate write.
   */
  function writeCtx(ctx: CallContext): CallContext {
    return { author: authorFor(ctx) };
  }

  function emit(event: AuditEvent): void {
    audit?.(event);
  }

  /** Enforce write policy on one endpoint. System-sigil paths are the kernel's
   * to police (validatePath), so the shell skips them. */
  function assertWritable(op: string, repo: string, path: string): void {
    if (pathIsInSystemNamespace(path, sigils)) return;
    if (!claimsCoverPath(writeMatchers, repo, path)) {
      emit({ op, repo, path, outcome: "forbidden" });
      throw forbidden();
    }
  }

  function assertDestructive(op: string, repo?: string): void {
    if (!entitlement.destructive) {
      emit({ op, repo, outcome: "forbidden" });
      throw forbidden();
    }
  }

  function assertMaintain(op: string, repo?: string): void {
    if (!entitlement.maintain) {
      emit({ op, repo, outcome: "forbidden" });
      throw forbidden();
    }
  }

  /** Forward a call, auditing the outcome (ok, or ok-with-engine-error). */
  async function forward<T>(
    op: string,
    meta: { repo?: string; path?: string },
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await run();
      emit({ op, ...meta, outcome: "ok" });
      return result;
    } catch (err) {
      emit({ op, ...meta, outcome: "ok", error: errorCode(err) });
      throw err;
    }
  }

  return {
    repos: {
      list: (_ctx, opts) => forward("repos.list", {}, () => kernel.repos.list(readCtx(), opts)),
      get: (_ctx, slug) =>
        forward("repos.get", { repo: slug }, () => kernel.repos.get(readCtx(), slug)),
      create: async (ctx, slug) => {
        assertDestructive("repos.create", slug);
        return forward("repos.create", { repo: slug }, () =>
          kernel.repos.create(writeCtx(ctx), slug),
        );
      },
      rename: async (ctx, slug, newSlug) => {
        assertDestructive("repos.rename", slug);
        return forward("repos.rename", { repo: slug }, () =>
          kernel.repos.rename(writeCtx(ctx), slug, newSlug),
        );
      },
      delete: async (ctx, slug) => {
        assertDestructive("repos.delete", slug);
        return forward("repos.delete", { repo: slug }, () =>
          kernel.repos.delete(writeCtx(ctx), slug),
        );
      },
      set_path_config: async (ctx, slug, config) => {
        assertDestructive("repos.set_path_config", slug);
        return forward("repos.set_path_config", { repo: slug }, () =>
          kernel.repos.set_path_config(writeCtx(ctx), slug, config),
        );
      },
      set_link_config: async (ctx, slug, config) => {
        assertDestructive("repos.set_link_config", slug);
        return forward("repos.set_link_config", { repo: slug }, () =>
          kernel.repos.set_link_config(writeCtx(ctx), slug, config),
        );
      },
    },

    docs: {
      get: (_ctx, repo, path) =>
        forward("docs.get", { repo, path }, () => kernel.docs.get(readCtx(), repo, path)),
      get_many: (_ctx, repo, paths) =>
        forward("docs.get_many", { repo }, () => kernel.docs.get_many(readCtx(), repo, paths)),
      get_version: (_ctx, repo, versionId) =>
        forward("docs.get_version", { repo }, () =>
          kernel.docs.get_version(readCtx(), repo, versionId),
        ),
      history: (_ctx, repo, path, opts) =>
        forward("docs.history", { repo, path }, () =>
          kernel.docs.history(readCtx(), repo, path, opts),
        ),
      diff: (_ctx, repo, path, from, to) =>
        forward("docs.diff", { repo, path }, () =>
          kernel.docs.diff(readCtx(), repo, path, from, to),
        ),

      create: async (ctx, repo, path, input) => {
        assertWritable("docs.create", repo, path);
        return forward("docs.create", { repo, path }, () =>
          kernel.docs.create(writeCtx(ctx), repo, path, input),
        );
      },

      put: async (ctx, repo, prevVersionId, path, input) => {
        // A put may move the doc. Enforce write on the destination and — when
        // the source differs — on the source too (both-endpoints, §8.2). The
        // source path is the path of the version being superseded; resolve it
        // with full visibility (the guard is trusted to look up what it must
        // police), so a write-without-read grant still works.
        const source = await kernel.docs.get_version({}, repo, prevVersionId);
        assertWritable("docs.put", repo, source.path);
        assertWritable("docs.put", repo, path);
        return forward("docs.put", { repo, path }, () =>
          kernel.docs.put(writeCtx(ctx), repo, prevVersionId, path, input),
        );
      },

      delete: async (ctx, repo, prevVersionId) => {
        const target = await kernel.docs.get_version({}, repo, prevVersionId);
        assertWritable("docs.delete", repo, target.path);
        return forward("docs.delete", { repo, path: target.path }, () =>
          kernel.docs.delete(writeCtx(ctx), repo, prevVersionId),
        );
      },
    },

    links: {
      backfill: async (ctx, repo) => {
        assertMaintain("links.backfill", repo);
        return forward("links.backfill", { repo }, () =>
          kernel.links.backfill(writeCtx(ctx), repo),
        );
      },
      // Read-only listing; scoped to read visibility like any other read.
      stale: (_ctx, repo) =>
        forward("links.stale", { repo }, () => kernel.links.stale(readCtx(), repo)),
      repair: async (ctx, repo, opts) => {
        const dryRun = opts?.dry_run ?? false;
        // A live repair mutates docs → maintain. A dry run only plans → a
        // read, bounded by read visibility (which docs the caller may see).
        if (!dryRun) assertMaintain("links.repair", repo);
        const forwardCtx: CallContext = dryRun
          ? { scope: entitlement.read }
          : { author: authorFor(ctx), scope: entitlement.read };
        return forward("links.repair", { repo }, () => kernel.links.repair(forwardCtx, repo, opts));
      },
    },

    query: (_ctx, spec) => forward("query", {}, () => kernel.query(readCtx(), spec)),

    // Read-only neighborhood expansion; scoped to read visibility. Traversal
    // stays kernel-side (the engine applies scope∧filter as visibility).
    graph: (_ctx, spec) =>
      forward("graph", { repo: spec.repo }, () => kernel.graph(readCtx(), spec)),

    history: {
      // Read-only change feed; the engine applies read scope to each ref's
      // endpoints (a ref is delivered only if the caller can see either end).
      since: (_ctx, input) =>
        forward("history.since", { repo: input.repo }, () =>
          kernel.history.since(readCtx(), input),
        ),
      index: (_ctx, input) =>
        forward("history.index", { repo: input.repo }, () =>
          kernel.history.index(readCtx(), input),
        ),
      list: (_ctx, input) =>
        forward("history.list", { repo: input.repo }, () => kernel.history.list(readCtx(), input)),
    },
  };
}

function errorCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return "error";
}
