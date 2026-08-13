/**
 * Kernel — the only place the read model, error catalog, and slug↔id
 * translation live. Surfaces (CLI in M0; MCP/REST in M3) call these methods
 * and never touch the storage layer directly.
 *
 * M0 subset: repos.list/get, users.list, docs.get, docs.get_version,
 * docs.history. Writes and auth land in M1.
 */

import type { Storage, VersionRow } from "../storage/types.js";
import { type Action, type Actor, type Target, authorize } from "./actor.js";
import {
  KernelError,
  docNotFound,
  repoNotFound,
  versionNotFound,
} from "./errors.js";
import { decodeVersionId, encodeVersionId } from "./version-id.js";
import type { Repo, User, Version } from "./wire.js";

export type HistoryOptions = { limit?: number; before?: string };

export type Kernel = {
  repos: {
    list(actor: Actor, opts?: { include_system?: boolean }): Repo[];
    get(actor: Actor, slug: string): Repo;
  };
  users: {
    list(actor: Actor): User[];
  };
  docs: {
    get(actor: Actor, repo: string, path: string): Version;
    get_version(actor: Actor, repo: string, version_id: string): Version;
    history(actor: Actor, repo: string, path: string, opts?: HistoryOptions): Version[];
  };
};

/** M0-visible system sigils for filtering system-namespaced repo slugs. */
const SYSTEM_SIGIL_PREFIX = ":";

export function createKernel(storage: Storage): Kernel {
  // Author lookup — cheap and hot, so cache within a kernel instance.
  const userCache = new Map<number, User>();
  function userById(id: number): User {
    const cached = userCache.get(id);
    if (cached) return cached;
    const row = storage.users_by_id(id);
    if (!row) throw new KernelError("user_not_found", { user_id: id });
    const user = { user: row.slug };
    userCache.set(id, user);
    return user;
  }

  function toRepoWire(row: { slug: string; path_config: string | null }): Repo {
    return {
      repo: row.slug,
      path_config: row.path_config ? JSON.parse(row.path_config) : null,
    };
  }

  function toVersionWire(row: VersionRow, repoSlug: string): Version {
    return {
      version_id: encodeVersionId(row.id),
      prev_version_id: row.prev_id === null ? null : encodeVersionId(row.prev_id),
      next_version_id: row.next_id === null ? null : encodeVersionId(row.next_id),
      repo: repoSlug,
      path: row.path,
      frontmatter: row.frontmatter,
      frontmatter_raw: row.frontmatter_raw,
      body: row.body,
      author: userById(row.author_id),
      created_at: row.created_at,
    };
  }

  function resolveRepo(actor: Actor, slug: string, action: Action): {
    id: number;
    slug: string;
    path_config: string | null;
    created_at: string;
  } {
    const target: Target = { kind: "repo", slug };
    authorize(actor, action, target);
    const row = storage.repos_by_slug(slug);
    if (!row) throw repoNotFound(slug);
    return row;
  }

  return {
    repos: {
      list(actor, opts) {
        authorize(actor, "read", { kind: "server" });
        const includeSystem = opts?.include_system ?? false;
        return storage
          .repos_list()
          .filter((r) => includeSystem || !r.slug.startsWith(SYSTEM_SIGIL_PREFIX))
          .map(toRepoWire);
      },
      get(actor, slug) {
        return toRepoWire(resolveRepo(actor, slug, "read"));
      },
    },

    users: {
      list(actor) {
        authorize(actor, "read", { kind: "server" });
        return storage.users_list().map((u) => ({ user: u.slug }));
      },
    },

    docs: {
      get(actor, repoSlug, path) {
        const repo = resolveRepo(actor, repoSlug, "read");
        authorize(actor, "read", { kind: "path", repo: repoSlug, path });
        const row = storage.version_current(repo.id, path);
        if (!row) throw docNotFound(repoSlug, path);
        return toVersionWire(row, repoSlug);
      },

      get_version(actor, repoSlug, versionId) {
        const repo = resolveRepo(actor, repoSlug, "read");
        const id = decodeVersionId(versionId);
        if (id === null) throw versionNotFound(versionId);
        const row = storage.version_by_id(id);
        if (!row || row.repo_id !== repo.id) throw versionNotFound(versionId);
        authorize(actor, "read", { kind: "path", repo: repoSlug, path: row.path });
        return toVersionWire(row, repoSlug);
      },

      history(actor, repoSlug, path, opts) {
        const repo = resolveRepo(actor, repoSlug, "read");
        authorize(actor, "read", { kind: "path", repo: repoSlug, path });
        const current = storage.version_current(repo.id, path);
        if (!current) throw docNotFound(repoSlug, path);
        const rows = storage.version_history(current.document_id, opts);
        return rows.map((r) => toVersionWire(r, repoSlug));
      },
    },
  };
}
