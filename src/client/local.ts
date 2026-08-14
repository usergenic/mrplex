/**
 * In-process KernelClient — opens storage, resolves the actor from a token,
 * builds a Kernel, and forwards every call. Pure passthrough — no behavior
 * change vs. what the CLI did before M3's transport seam.
 *
 * `close()` closes the underlying storage. Bootstrap and serve deliberately
 * do NOT go through this seam — they need storage-direct access (m3-plan
 * WS5 acceptance).
 */

import type { EmbedHook } from "../embed/hook.js";
import type { Actor } from "../kernel/auth/actor.js";
import { resolveActor } from "../kernel/auth/tokens.js";
import { KernelError } from "../kernel/errors.js";
import type { Kernel } from "../kernel/kernel.js";
import { createKernel } from "../kernel/kernel.js";
import { sqliteAdapter } from "../storage-sqlite/adapter.js";
import type { Storage } from "../storage/types.js";
import type { KernelClient } from "./kernel-client.js";

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
export function openLocalClient(config: LocalClientConfig): KernelClient {
  const storage: Storage = sqliteAdapter.open({ database: config.database });
  const actor = resolveActor(config.token, storage);
  if (!actor) {
    storage.close();
    throw new KernelError("unauthorized", {});
  }
  const hook = config.embed ?? null;
  const kernel = createKernel({
    storage,
    // Enqueue is unconditional (m4-plan §5 decision 5), matching serve.
    onVersionCommitted: (versionId) => storage.backlog_enqueue(versionId),
    queryEmbed: hook
      ? async (rank: string) => {
          const resp = await hook.embed([rank]);
          const vector = resp.vectors[0];
          if (!vector) throw new Error("embed hook returned no vector for query string");
          return { vector, model: resp.model, dim: resp.dim };
        }
      : undefined,
  });
  return buildClient(kernel, actor, storage);
}

function buildClient(kernel: Kernel, actor: Actor, storage: Storage): KernelClient {
  let closed = false;
  const async = <T>(fn: () => T): Promise<T> => Promise.resolve().then(fn);

  return {
    repos: {
      list: (opts) => async(() => kernel.repos.list(actor, opts)),
      get: (slug) => async(() => kernel.repos.get(actor, slug)),
      create: (slug) => async(() => kernel.repos.create(actor, slug)),
      rename: (slug, ns) => async(() => kernel.repos.rename(actor, slug, ns)),
      delete: (slug) => async(() => kernel.repos.delete(actor, slug)),
      set_path_config: (slug, cfg) => async(() => kernel.repos.set_path_config(actor, slug, cfg)),
    },
    users: {
      list: () => async(() => kernel.users.list(actor)),
      create: (slug) => async(() => kernel.users.create(actor, slug)),
      rename: (slug, ns) => async(() => kernel.users.rename(actor, slug, ns)),
      delete: (slug) => async(() => kernel.users.delete(actor, slug)),
    },
    docs: {
      get: (repo, path) => async(() => kernel.docs.get(actor, repo, path)),
      get_version: (repo, vid) => async(() => kernel.docs.get_version(actor, repo, vid)),
      history: (repo, path, opts) => async(() => kernel.docs.history(actor, repo, path, opts)),
      diff: (repo, path, from, to) =>
        async(() => kernel.docs.diff(actor, repo, path, from, to)),
      create: (repo, path, input) => async(() => kernel.docs.create(actor, repo, path, input)),
      put: (repo, prev, path, input) =>
        async(() => kernel.docs.put(actor, repo, prev, path, input)),
      delete: (repo, prev) => async(() => kernel.docs.delete(actor, repo, prev)),
    },
    tokens: {
      list: () => async(() => kernel.tokens.list(actor)),
      create: (label, scopes, opts) =>
        async(() => kernel.tokens.create(actor, label, scopes, opts)),
      revoke: (id) => async(() => kernel.tokens.revoke(actor, id)),
    },
    query: (spec) => kernel.query(actor, spec),
    close: async () => {
      if (closed) return;
      closed = true;
      storage.close();
    },
  };
}
