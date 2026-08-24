/**
 * In-process KernelClient — opens storage, builds a Kernel, and forwards every
 * call with a default CallContext (author + scope). No token resolution: the
 * process boundary is the trust boundary (design §8, noauth plan §2). Kernel
 * calls are already async so the client is a thin passthrough.
 */

import type { EmbedHook } from "../embed/hook.js";
import type { CallContext } from "../kernel/context.js";
import type { Kernel } from "../kernel/kernel.js";
import { createKernel } from "../kernel/kernel.js";
import type { Version } from "../kernel/wire.js";
import { appendSystemProperty } from "../markdown/frontmatter.js";
import { openStorage } from "../storage/registry.js";
import type { Storage } from "../storage/types.js";
import type { DocGetOptions, KernelClient } from "./kernel-client.js";

export type LocalClientConfig = {
  /** sqlite:./path.db or postgres://…; the CLI resolves this. */
  database: string;
  /**
   * Default context for every call — author for writes, scope for reads.
   * Absent = full access with the default "mrplex" author.
   */
  context?: CallContext;
  /**
   * Optional embed hook for rank queries in embedded-CLI mode. Also
   * enables write-time backlog enqueue so writes done via the local
   * client contribute to backlog like serve's do.
   */
  embed?: EmbedHook | null;
};

/** Open a local kernel client. The process that can open the file is trusted. */
export async function openLocalClient(config: LocalClientConfig): Promise<KernelClient> {
  const storage: Storage = await openStorage(config.database);
  const hook = config.embed ?? null;
  const kernel = createKernel({
    storage,
    onVersionCommitted: async (versionId) => {
      await storage.backlog_enqueue(versionId);
    },
    queryEmbed: hook
      ? async (rank: string) => {
          const resp = await hook.embed([rank]);
          const vector = resp.vectors[0];
          if (!vector) throw new Error("embed hook returned no vector for query string");
          return { vector, model: resp.model, dim: resp.dim };
        }
      : undefined,
  });
  return buildClient(kernel, config.context ?? {}, storage, hook);
}

function buildClient(
  kernel: Kernel,
  ctx: CallContext,
  storage: Storage,
  hook: EmbedHook | null,
): KernelClient {
  let closed = false;

  return {
    repos: {
      list: (opts) => kernel.repos.list(ctx, opts),
      get: (slug) => kernel.repos.get(ctx, slug),
      create: (slug) => kernel.repos.create(ctx, slug),
      rename: (slug, ns) => kernel.repos.rename(ctx, slug, ns),
      delete: (slug) => kernel.repos.delete(ctx, slug),
      set_path_config: (slug, cfg) => kernel.repos.set_path_config(ctx, slug, cfg),
      set_link_config: (slug, cfg) => kernel.repos.set_link_config(ctx, slug, cfg),
    },
    docs: {
      get: async (repo, path, opts) =>
        maybeInjectVersion(await kernel.docs.get(ctx, repo, path), opts),
      get_version: async (repo, vid, opts) =>
        maybeInjectVersion(await kernel.docs.get_version(ctx, repo, vid), opts),
      history: (repo, path, opts) => kernel.docs.history(ctx, repo, path, opts),
      diff: (repo, path, from, to) => kernel.docs.diff(ctx, repo, path, from, to),
      create: (repo, path, input) => kernel.docs.create(ctx, repo, path, input),
      put: (repo, prev, path, input) => kernel.docs.put(ctx, repo, prev, path, input),
      delete: (repo, prev) => kernel.docs.delete(ctx, repo, prev),
    },
    links: {
      backfill: (repo) => kernel.links.backfill(ctx, repo),
      stale: (repo) => kernel.links.stale(ctx, repo),
      repair: (repo, opts) => kernel.links.repair(ctx, repo, opts),
    },
    query: (spec) => kernel.query(ctx, spec),
    graph: (spec) => kernel.graph(ctx, spec),
    close: async () => {
      if (closed) return;
      closed = true;
      if (hook) {
        try {
          await hook.close();
        } catch {
          /* best-effort */
        }
      }
      await storage.close();
    },
  };
}

function maybeInjectVersion(v: Version, opts: DocGetOptions | undefined): Version {
  if (opts?.raw) return v;
  // Fixed order: $version then $content_hash (sync/history plan §2.4).
  let frontmatter_raw = appendSystemProperty(v.frontmatter_raw, "version", v.version_id);
  frontmatter_raw = appendSystemProperty(frontmatter_raw, "content_hash", v.content_hash);
  return { ...v, frontmatter_raw };
}
