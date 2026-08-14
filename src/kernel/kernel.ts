/**
 * Kernel — the only place the read model, error catalog, and slug↔id
 * translation live. Surfaces (CLI in M0; MCP/REST in M3) call these methods
 * and never touch the storage layer directly.
 *
 * M0 shipped reads. M1 adds writes with `prev_version_id` enforcement,
 * frontmatter canonicalization, and real `authorize()` on every op.
 */

import { randomBytes } from "node:crypto";
import type { RepoRow, Storage, TokenRow, VersionRow } from "../storage/types.js";
import type { Action, Actor, StoredScope, Target } from "./auth/actor.js";
import { authorize } from "./auth/authorize.js";
import {
  type ScopeInput,
  assertAdminSubset,
  assertChildScopeSubset,
  resolveScopeInputs,
  scopesGrant,
} from "./auth/scope.js";
import {
  generateSecret,
  hashSecret,
  parseStoredScopes,
  serializeStoredScopes,
  tokenIdString,
} from "./auth/tokens.js";
import { deletionPath, pathIsInSystemNamespace } from "./deletion.js";
import {
  KernelError,
  docNotFound,
  repoNotFound,
  tokenNotFound,
  userNotFound,
  versionNotFound,
} from "./errors.js";
import {
  type CanonicalFrontmatter,
  type FrontmatterInput,
  canonicalizeFrontmatter,
} from "./frontmatter-input.js";
import {
  HARDCODED_DEFAULTS,
  type PathConfig,
  type PathConfigOverride,
  effectivePathConfig,
  parseRepoOverride,
  pathWarning,
  validateRepoOverride,
} from "./path-config.js";
import { type QuerySpec, runQuery } from "./query/query.js";
import { validatePath, validateSlug } from "./validation.js";
import { decodeVersionId, encodeVersionId } from "./version-id.js";
import type { PathWarning, Repo, Scope, Token, User, Version } from "./wire.js";

export type HistoryOptions = { limit?: number; before?: string };

export type SetPathConfigResult = { repo: Repo; warnings: PathWarning[] };

export type TokenCreateResult = { token: string; meta: Token };

export type Kernel = {
  repos: {
    list(actor: Actor, opts?: { include_system?: boolean }): Repo[];
    get(actor: Actor, slug: string): Repo;
    create(actor: Actor, slug: string): Repo;
    rename(actor: Actor, slug: string, new_slug: string): Repo;
    delete(actor: Actor, slug: string): Repo;
    set_path_config(
      actor: Actor,
      slug: string,
      config: PathConfigOverride | null,
    ): SetPathConfigResult;
  };
  users: {
    list(actor: Actor): User[];
    create(actor: Actor, slug: string): User;
    rename(actor: Actor, slug: string, new_slug: string): User;
    delete(actor: Actor, slug: string): User;
  };
  docs: {
    get(actor: Actor, repo: string, path: string): Version;
    get_version(actor: Actor, repo: string, version_id: string): Version;
    history(actor: Actor, repo: string, path: string, opts?: HistoryOptions): Version[];
    create(
      actor: Actor,
      repo: string,
      path: string,
      input: FrontmatterInput & { body: string },
    ): Version;
    put(
      actor: Actor,
      repo: string,
      prev_version_id: string,
      path: string,
      input: Partial<FrontmatterInput> & { body?: string },
    ): Version;
    delete(actor: Actor, repo: string, prev_version_id: string): Version;
  };
  tokens: {
    list(actor: Actor): Token[];
    create(
      actor: Actor,
      label: string | null,
      scopes: ScopeInput[],
      opts?: { admin?: boolean; expires_at?: string | null },
    ): TokenCreateResult;
    revoke(actor: Actor, token_id: string): Token;
  };
  query(actor: Actor, spec: QuerySpec): Version[];
};

export type KernelConfig = {
  storage: Storage;
  /**
   * Server-level path config (§3.5.2 tier 2). Defaults to HARDCODED_DEFAULTS.
   * Caller is responsible for validating via validateConfig() before passing.
   */
  serverPathConfig?: PathConfig;
  /**
   * M4 write-time hook: called with the new version's storage id after
   * every committed create / put / delete. Used by the embedding worker
   * to enqueue for chunking (§5.3, m4-plan §5 decision 5 — enqueue is
   * unconditional whether or not a hook is configured).
   *
   * The kernel invokes this in the same synchronous scope after
   * version_insert commits; a throw here bubbles to the caller and the
   * whole write is treated as failed. In practice the worker's
   * backlog_enqueue is one cheap UPSERT and doesn't throw.
   */
  onVersionCommitted?: (version_id: number) => void;
};

export function createKernel(config: KernelConfig | Storage): Kernel {
  // Accept a bare Storage for M0 backwards-compat.
  const cfg: KernelConfig =
    "storage" in (config as KernelConfig)
      ? (config as KernelConfig)
      : { storage: config as Storage };
  const storage = cfg.storage;
  const serverPathConfig = cfg.serverPathConfig ?? HARDCODED_DEFAULTS;
  const onVersionCommitted = cfg.onVersionCommitted;

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

  function repoEffectiveConfig(repo: RepoRow): PathConfig {
    return effectivePathConfig(serverPathConfig, parseRepoOverride(repo.path_config));
  }

  function resolveRepo(actor: Actor, slug: string, action: Action): RepoRow {
    // Look the repo up FIRST, then authorize on the resolved id — scopes bind
    // ids (§8.2), so we need it to check.
    const row = storage.repos_by_slug(slug);
    if (!row) throw repoNotFound(slug);
    const target: Target = { kind: "repo", repo_id: row.id };
    authorize(actor, action, target);
    return row;
  }

  /**
   * Redact `current_path` in stale_prev when the caller's read scope doesn't
   * cover it — design §4.3. Admin sees everything; anyone else sees null.
   */
  function currentPathForStaleError(actor: Actor, repo_id: number, path: string): string | null {
    if (actor.admin) return path;
    return scopesGrant(actor.scopes, "read", repo_id, path) ? path : null;
  }

  /**
   * Canonicalize a write's frontmatter input. Same-path put with no
   * frontmatter fields set carries over from prev (design implicit — a
   * body-only edit shouldn't force the caller to re-send the frontmatter).
   */
  function canonicalizeOrCarry(
    input: Partial<FrontmatterInput>,
    prev: VersionRow | null,
  ): CanonicalFrontmatter {
    if (input.frontmatter === undefined && input.frontmatter_raw === undefined && prev) {
      return { frontmatter: prev.frontmatter, frontmatter_raw: prev.frontmatter_raw };
    }
    return canonicalizeFrontmatter(input as FrontmatterInput);
  }

  /**
   * Short hex uniquifier for system-namespace slug renames (§3.4). 3 random
   * bytes → exactly 6 hex chars → 24 bits of entropy — comfortably beyond
   * any realistic collision risk within a single repo/user's lifetime
   * deletion history.
   *
   * m1-plan §5 originally said "base32", but Node has no built-in base32
   * encoder and the value the design cares about is "short, stable,
   * alphanumeric, enough entropy." Hex satisfies all three with zero
   * dependencies and is what actually ships.
   */
  function slugUniquifier(): string {
    return randomBytes(3).toString("hex");
  }

  function isSlugSystemNamespaced(slug: string): boolean {
    return serverPathConfig.system_sigils.some((sigil) => slug.startsWith(sigil));
  }

  function slugCollisionError(slug: string): KernelError {
    return new KernelError("slug_taken", { slug });
  }

  /**
   * Translate StoredScope[] → wire Scope[]. Requires storage to look up
   * current slugs for the bound repo ids. A repo id whose row no longer
   * exists is silently dropped (rename-friendly per §8.2's "tokens.list
   * renders bound repos by their current slugs").
   */
  function scopesToWire(scopes: StoredScope[]): Scope[] {
    return scopes.map((s) => {
      if (s.repos === "*") {
        return { repos: "*", read: s.read, write: s.write };
      }
      const slugs: string[] = [];
      for (const id of s.repos) {
        const row = storage.repos_by_id(id);
        if (row) slugs.push(row.slug);
      }
      slugs.sort();
      return { repos: slugs, read: s.read, write: s.write };
    });
  }

  function tokenRowToWire(row: TokenRow): Token {
    return {
      id: tokenIdString(row),
      label: row.label,
      admin: row.admin === 1,
      scopes: scopesToWire(parseStoredScopes(row.scopes)),
      expires_at: row.expires_at,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
    };
  }

  function decodeTokenId(tokenId: string): number | null {
    const m = tokenId.match(/^t(\d+)$/);
    if (!m || !m[1]) return null;
    const n = Number.parseInt(m[1], 10);
    if (!Number.isSafeInteger(n) || n <= 0) return null;
    return n;
  }

  return {
    repos: {
      list(actor, opts) {
        authorize(actor, "read", { kind: "server" });
        const includeSystem = opts?.include_system ?? false;
        // Server-config sigils apply here — slugs live in the server namespace,
        // not per-repo — matching §3.5.6 (slugs validated against server config).
        return storage
          .repos_list()
          .filter((r) => includeSystem || !isSlugSystemNamespaced(r.slug))
          .map(toRepoWire);
      },
      get(actor, slug) {
        return toRepoWire(resolveRepo(actor, slug, "read"));
      },
      create(actor, slug) {
        authorize(actor, "admin", { kind: "server_admin" });
        validateSlug(slug, serverPathConfig);
        if (storage.repos_by_slug(slug)) throw slugCollisionError(slug);
        const row = storage.repos_create({ slug, created_at: new Date().toISOString() });
        return toRepoWire(row);
      },
      rename(actor, slug, new_slug) {
        authorize(actor, "admin", { kind: "server_admin" });
        const repo = storage.repos_by_slug(slug);
        if (!repo) throw repoNotFound(slug);
        if (new_slug === slug) return toRepoWire(repo);
        validateSlug(new_slug, serverPathConfig);
        if (storage.repos_by_slug(new_slug)) throw slugCollisionError(new_slug);
        return toRepoWire(storage.repos_rename(repo.id, new_slug));
      },
      delete(actor, slug) {
        authorize(actor, "admin", { kind: "server_admin" });
        const repo = storage.repos_by_slug(slug);
        if (!repo) throw repoNotFound(slug);
        // Idempotent (§3.4): already system-namespaced → no-op.
        if (isSlugSystemNamespaced(repo.slug)) return toRepoWire(repo);
        // Rename the slug into the system namespace with a uniquifier so
        // multiple deletions of same-basename repos don't collide.
        const sigil = serverPathConfig.system_sigils[0] as string;
        // Try a few times in the (astronomically unlikely) event of a
        // uniquifier collision.
        for (let attempt = 0; attempt < 5; attempt++) {
          const newSlug = `${sigil}deleted-${repo.slug}-${slugUniquifier()}`;
          if (storage.repos_by_slug(newSlug)) continue;
          return toRepoWire(storage.repos_rename(repo.id, newSlug));
        }
        throw new Error("repos.delete: uniquifier collision (retries exhausted)");
      },
      set_path_config(actor, slug, config) {
        authorize(actor, "admin", { kind: "server_admin" });
        const repo = storage.repos_by_slug(slug);
        if (!repo) throw repoNotFound(slug);
        if (config !== null) {
          validateRepoOverride(config, serverPathConfig);
        }
        const configJson = config === null ? null : JSON.stringify(config);
        const updated = storage.repos_set_path_config(repo.id, configJson);
        // Advisory warnings (§3.5.3): scan the repo's live paths against the
        // new effective config and collect any that no longer validate.
        // Rides the partial-index on (repo_id, path) where next_id is null,
        // so it's O(live-set) per repo.
        const newEffective = effectivePathConfig(serverPathConfig, config);
        const warnings: PathWarning[] = [];
        // Skip trashed docs — those live under system sigils and were emitted
        // by the kernel; user-visible warnings should be about user-territory
        // paths only.
        for (const version of storage.versions_live_by_repo(repo.id)) {
          if (pathIsInSystemNamespace(version.path, newEffective.system_sigils)) {
            continue;
          }
          try {
            validatePath(version.path, newEffective);
          } catch (err) {
            warnings.push(pathWarning(encodeVersionId(version.id), version.path, err));
          }
        }
        return { repo: toRepoWire(updated), warnings };
      },
    },

    users: {
      list(actor) {
        authorize(actor, "read", { kind: "server" });
        return storage.users_list().map((u) => ({ user: u.slug }));
      },
      create(actor, slug) {
        authorize(actor, "admin", { kind: "server_admin" });
        validateSlug(slug, serverPathConfig);
        if (storage.users_by_slug(slug)) throw new KernelError("slug_taken", { slug });
        const row = storage.users_create({ slug, created_at: new Date().toISOString() });
        return { user: row.slug };
      },
      rename(actor, slug, new_slug) {
        authorize(actor, "admin", { kind: "server_admin" });
        const user = storage.users_by_slug(slug);
        if (!user) throw userNotFound(slug);
        if (new_slug === slug) return { user: user.slug };
        validateSlug(new_slug, serverPathConfig);
        if (storage.users_by_slug(new_slug)) throw slugCollisionError(new_slug);
        const updated = storage.users_rename(user.id, new_slug);
        return { user: updated.slug };
      },
      delete(actor, slug) {
        authorize(actor, "admin", { kind: "server_admin" });
        const user = storage.users_by_slug(slug);
        if (!user) throw userNotFound(slug);
        if (isSlugSystemNamespaced(user.slug)) return { user: user.slug };
        const sigil = serverPathConfig.system_sigils[0] as string;
        for (let attempt = 0; attempt < 5; attempt++) {
          const newSlug = `${sigil}deleted-${user.slug}-${slugUniquifier()}`;
          if (storage.users_by_slug(newSlug)) continue;
          // Revoke all their tokens as part of the same conceptual op (§3.4).
          storage.tokens_revoke_by_user(user.id, new Date().toISOString());
          const updated = storage.users_rename(user.id, newSlug);
          return { user: updated.slug };
        }
        throw new Error("users.delete: uniquifier collision (retries exhausted)");
      },
    },

    docs: {
      get(actor, repoSlug, path) {
        const repo = resolveRepo(actor, repoSlug, "read");
        authorize(actor, "read", { kind: "path", repo_id: repo.id, path });
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
        authorize(actor, "read", { kind: "path", repo_id: repo.id, path: row.path });
        return toVersionWire(row, repoSlug);
      },

      history(actor, repoSlug, path, opts) {
        const repo = resolveRepo(actor, repoSlug, "read");
        authorize(actor, "read", { kind: "path", repo_id: repo.id, path });
        const current = storage.version_current(repo.id, path);
        if (!current) throw docNotFound(repoSlug, path);
        const rows = storage.version_history(current.document_id, opts);
        return rows.map((r) => toVersionWire(r, repoSlug));
      },

      create(actor, repoSlug, path, input) {
        const repo = resolveRepo(actor, repoSlug, "write");
        authorize(actor, "write", { kind: "path", repo_id: repo.id, path });
        validatePath(path, repoEffectiveConfig(repo));
        const canon = canonicalizeFrontmatter(input);

        const { version, insertedId } = storage.tx(() => {
          const existing = storage.version_current(repo.id, path);
          if (existing) {
            throw new KernelError("create_conflict", {
              repo: repoSlug,
              path,
              current_version_id: encodeVersionId(existing.id),
            });
          }
          const doc = storage.documents_create(repo.id);
          const inserted = storage.version_insert({
            document_id: doc.id,
            repo_id: repo.id,
            prev_id: null,
            path,
            frontmatter_raw: canon.frontmatter_raw,
            frontmatter: canon.frontmatter,
            body: input.body,
            author_id: actor.user_id,
            created_at: new Date().toISOString(),
          });
          return { version: toVersionWire(inserted, repoSlug), insertedId: inserted.id };
        });
        onVersionCommitted?.(insertedId);
        return version;
      },

      put(actor, repoSlug, prevVersionId, destPath, input) {
        const repo = resolveRepo(actor, repoSlug, "write");
        const prevId = decodeVersionId(prevVersionId);
        if (prevId === null) throw versionNotFound(prevVersionId);
        const prev = storage.version_by_id(prevId);
        if (!prev || prev.repo_id !== repo.id) throw versionNotFound(prevVersionId);

        // Authorize the move (or in-place update, which is a "move" with
        // source === destination — that still fires scopesGrant on the same
        // path twice, harmless). The move target lets the system-namespace
        // carve-out apply for restore (source is system, dest is user).
        const putCfg = repoEffectiveConfig(repo);
        authorize(actor, "write", {
          kind: "move",
          repo_id: repo.id,
          source: prev.path,
          destination: destPath,
          system_sigils: putCfg.system_sigils,
        });

        validatePath(destPath, putCfg);
        const canon = canonicalizeOrCarry(input, prev);
        const body = input.body ?? prev.body;

        const { version, insertedId } = storage.tx(() => {
          // Verify prev is STILL current (design §4.1 rule 1). Doing it inside
          // the tx before insert closes the race window.
          const current = storage.version_current(repo.id, prev.path);
          if (!current || current.id !== prev.id) {
            // Document may have moved elsewhere (or been deleted into
            // :deleted/…) since prev was observed; look up its current
            // by document_id to give the client an accurate pointer.
            const docCurrent =
              current ?? storage.version_history(prev.document_id, { limit: 1 })[0] ?? null;
            throw new KernelError("stale_prev", {
              current_version_id: docCurrent ? encodeVersionId(docCurrent.id) : null,
              current_path: docCurrent
                ? currentPathForStaleError(actor, repo.id, docCurrent.path)
                : null,
              submitted_prev_version_id: prevVersionId,
            });
          }

          // If destination differs from source, check for path collision with
          // a DIFFERENT document.
          if (destPath !== prev.path) {
            const occupant = storage.version_current(repo.id, destPath);
            if (occupant && occupant.document_id !== prev.document_id) {
              throw new KernelError("path_taken", {
                repo: repoSlug,
                path: destPath,
                current_version_id: encodeVersionId(occupant.id),
              });
            }
          }

          const inserted = storage.version_insert({
            document_id: prev.document_id,
            repo_id: repo.id,
            prev_id: prev.id,
            path: destPath,
            frontmatter_raw: canon.frontmatter_raw,
            frontmatter: canon.frontmatter,
            body,
            author_id: actor.user_id,
            created_at: new Date().toISOString(),
          });
          return { version: toVersionWire(inserted, repoSlug), insertedId: inserted.id };
        });
        onVersionCommitted?.(insertedId);
        return version;
      },

      delete(actor, repoSlug, prevVersionId) {
        const repo = resolveRepo(actor, repoSlug, "write");
        const prevId = decodeVersionId(prevVersionId);
        if (prevId === null) throw versionNotFound(prevVersionId);
        const prev = storage.version_by_id(prevId);
        if (!prev || prev.repo_id !== repo.id) throw versionNotFound(prevVersionId);

        const cfg = repoEffectiveConfig(repo);

        // Verify prev is STILL the current version of its document. Only
        // then can we short-circuit the "already deleted" idempotent case.
        // A prev that is system-namespaced but no longer current means the
        // document has since gone through delete → restore → delete cycles
        // and this call is stale — stale_prev, not a no-op.
        const currentAtPrevPath = storage.version_current(repo.id, prev.path);
        if (!currentAtPrevPath || currentAtPrevPath.id !== prev.id) {
          const docCurrent =
            currentAtPrevPath ?? storage.version_history(prev.document_id, { limit: 1 })[0] ?? null;
          throw new KernelError("stale_prev", {
            current_version_id: docCurrent ? encodeVersionId(docCurrent.id) : null,
            current_path: docCurrent
              ? currentPathForStaleError(actor, repo.id, docCurrent.path)
              : null,
            submitted_prev_version_id: prevVersionId,
          });
        }

        // prev IS current. Idempotency (design §4.1 rule 4): if the current
        // version's path is under a system sigil, the doc is already
        // deleted — no-op, return unchanged.
        if (pathIsInSystemNamespace(prev.path, cfg.system_sigils)) {
          return toVersionWire(prev, repoSlug);
        }

        // Compute the deletion path (§3.5.4 — set for input, first for output).
        const destPath = deletionPath(
          cfg.system_sigils[0] as string,
          prev.path,
          encodeVersionId(prev.id),
        );

        authorize(actor, "write", {
          kind: "move",
          repo_id: repo.id,
          source: prev.path,
          destination: destPath,
          system_sigils: cfg.system_sigils,
        });

        // NOTE the destPath's segment starts with a system sigil, which
        // validatePath would reject. We SKIP validatePath here — this is the
        // kernel emitting on its own behalf (design §4.1 rule 4).

        const { version, insertedId } = storage.tx(() => {
          // Re-check prev is still current inside the tx to close the race
          // window between the pre-check above and the insert.
          const current = storage.version_current(repo.id, prev.path);
          if (!current || current.id !== prev.id) {
            const docCurrent =
              current ?? storage.version_history(prev.document_id, { limit: 1 })[0] ?? null;
            throw new KernelError("stale_prev", {
              current_version_id: docCurrent ? encodeVersionId(docCurrent.id) : null,
              current_path: docCurrent
                ? currentPathForStaleError(actor, repo.id, docCurrent.path)
                : null,
              submitted_prev_version_id: prevVersionId,
            });
          }

          const inserted = storage.version_insert({
            document_id: prev.document_id,
            repo_id: repo.id,
            prev_id: prev.id,
            path: destPath,
            frontmatter_raw: prev.frontmatter_raw,
            frontmatter: prev.frontmatter,
            body: prev.body,
            author_id: actor.user_id,
            created_at: new Date().toISOString(),
          });
          return { version: toVersionWire(inserted, repoSlug), insertedId: inserted.id };
        });
        onVersionCommitted?.(insertedId);
        return version;
      },
    },

    tokens: {
      list(actor) {
        // A user always sees their own tokens (design §8.2 self-token
        // management). Admin listing across users is `[OPEN]`. Adapter
        // already filters revoked + expired.
        return storage.tokens_list(actor.user_id).map(tokenRowToWire);
      },
      create(actor, label, scopeInputs, opts) {
        const admin = opts?.admin ?? false;
        assertAdminSubset(actor.admin, admin);
        const resolvedScopes = resolveScopeInputs(scopeInputs, storage);
        // Child scopes must be a subset of parent's — unless parent is
        // admin, which can mint anything.
        if (!actor.admin) {
          assertChildScopeSubset(actor.scopes, resolvedScopes);
        }
        const secret = generateSecret();
        const row = storage.tokens_create({
          user_id: actor.user_id,
          secret_hash: hashSecret(secret),
          label,
          scopes: serializeStoredScopes(resolvedScopes),
          admin,
          expires_at: opts?.expires_at ?? null,
          created_at: new Date().toISOString(),
        });
        return { token: secret, meta: tokenRowToWire(row) };
      },
      revoke(actor, tokenId) {
        const id = decodeTokenId(tokenId);
        if (id === null) throw tokenNotFound(tokenId);
        const row = storage.tokens_by_id(id);
        if (!row) throw tokenNotFound(tokenId);
        // Self-revoke is always allowed. Cross-user revoke requires admin.
        if (row.user_id !== actor.user_id && !actor.admin) {
          throw new KernelError("forbidden", {});
        }
        const revoked = storage.tokens_revoke(id, new Date().toISOString());
        return tokenRowToWire(revoked ?? row);
      },
    },

    query(actor: Actor, spec: QuerySpec): Version[] {
      // Server-level read authorization — the QuerySpec.repo field + scope
      // enforcement inside runQuery() do the fine-grained filtering.
      authorize(actor, "read", { kind: "server" });
      return runQuery(actor, spec, {
        storage,
        serverPathConfig,
        toVersionWire,
      });
    },
  };
}
