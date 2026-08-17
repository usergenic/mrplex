/**
 * In-process KernelClient — opens storage, resolves the actor from a token,
 * builds a Kernel, and forwards every call. Kernel calls are already
 * async so the client is a thin passthrough (m5-plan WS1 dropped the
 * Promise.resolve shim).
 */

import type { EmbedHook } from "../embed/hook.js";
import type { Actor } from "../kernel/auth/actor.js";
import { resolveActor } from "../kernel/auth/tokens.js";
import { KernelError } from "../kernel/errors.js";
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
  /** Bearer secret. */
  token: string;
  /**
   * Optional embed hook for rank queries in embedded-CLI mode. Also
   * enables write-time backlog enqueue so writes done via the local
   * client contribute to backlog like serve's do.
   */
  embed?: EmbedHook | null;
};

/**
 * Open a local kernel client. Throws `KernelError("unauthorized")` if the
 * token doesn't resolve — the CLI's `reportError` turns that into exit
 * code 3.
 */
export async function openLocalClient(config: LocalClientConfig): Promise<KernelClient> {
  const storage: Storage = await openStorage(config.database);
  const actor = await resolveActor(config.token, storage);
  if (!actor) {
    await storage.close();
    throw new KernelError("unauthorized", {});
  }
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
  return buildClient(kernel, actor, storage, hook);
}

function buildClient(
  kernel: Kernel,
  actor: Actor,
  storage: Storage,
  hook: EmbedHook | null,
): KernelClient {
  let closed = false;

  return {
    repos: {
      list: (opts) => kernel.repos.list(actor, opts),
      get: (slug) => kernel.repos.get(actor, slug),
      create: (slug) => kernel.repos.create(actor, slug),
      rename: (slug, ns) => kernel.repos.rename(actor, slug, ns),
      delete: (slug) => kernel.repos.delete(actor, slug),
      set_path_config: (slug, cfg) => kernel.repos.set_path_config(actor, slug, cfg),
    },
    users: {
      list: () => kernel.users.list(actor),
      create: (slug) => kernel.users.create(actor, slug),
      rename: (slug, ns) => kernel.users.rename(actor, slug, ns),
      delete: (slug) => kernel.users.delete(actor, slug),
    },
    docs: {
      get: async (repo, path, opts) =>
        maybeInjectVersion(await kernel.docs.get(actor, repo, path), opts),
      get_version: async (repo, vid, opts) =>
        maybeInjectVersion(await kernel.docs.get_version(actor, repo, vid), opts),
      history: (repo, path, opts) => kernel.docs.history(actor, repo, path, opts),
      diff: (repo, path, from, to) => kernel.docs.diff(actor, repo, path, from, to),
      create: (repo, path, input) => kernel.docs.create(actor, repo, path, input),
      put: (repo, prev, path, input) => kernel.docs.put(actor, repo, prev, path, input),
      delete: (repo, prev) => kernel.docs.delete(actor, repo, prev),
    },
    tokens: {
      list: () => kernel.tokens.list(actor),
      create: (label, scopes, opts) => kernel.tokens.create(actor, label, scopes, opts),
      revoke: (id) => kernel.tokens.revoke(actor, id),
    },
    query: (spec) => kernel.query(actor, spec),
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
  return {
    ...v,
    frontmatter_raw: appendSystemProperty(v.frontmatter_raw, "version", v.version_id),
  };
}
