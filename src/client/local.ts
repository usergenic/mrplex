/**
 * In-process KernelClient — opens storage, resolves the actor from a token,
 * builds a Kernel, and forwards every call. Pure passthrough — no behavior
 * change vs. what the CLI did before M3's transport seam.
 *
 * `close()` closes the underlying storage. Bootstrap and serve deliberately
 * do NOT go through this seam — they need storage-direct access (m3-plan
 * WS5 acceptance).
 */

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
  const kernel = createKernel(storage);
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
    query: (spec) => async(() => kernel.query(actor, spec)),
    close: async () => {
      if (closed) return;
      closed = true;
      storage.close();
    },
  };
}
