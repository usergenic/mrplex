/**
 * Kernel — the only place the read model, error catalog, and slug↔id
 * translation live. Surfaces (CLI in M0; MCP/REST in M3) call these methods
 * and never touch the storage layer directly.
 *
 * All kernel methods are async (m5-plan WS1). SQLite adapter is
 * internally synchronous so calls resolve on the next microtask; the
 * async signature is honesty about the Postgres adapter and the
 * embedding hook.
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
import { type UnifiedDiff, runDiff } from "./diff.js";
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
    list(actor: Actor, opts?: { include_system?: boolean }): Promise<Repo[]>;
    get(actor: Actor, slug: string): Promise<Repo>;
    create(actor: Actor, slug: string): Promise<Repo>;
    rename(actor: Actor, slug: string, new_slug: string): Promise<Repo>;
    delete(actor: Actor, slug: string): Promise<Repo>;
    set_path_config(
      actor: Actor,
      slug: string,
      config: PathConfigOverride | null,
    ): Promise<SetPathConfigResult>;
  };
  users: {
    list(actor: Actor): Promise<User[]>;
    create(actor: Actor, slug: string): Promise<User>;
    rename(actor: Actor, slug: string, new_slug: string): Promise<User>;
    delete(actor: Actor, slug: string): Promise<User>;
  };
  docs: {
    get(actor: Actor, repo: string, path: string): Promise<Version>;
    get_version(actor: Actor, repo: string, version_id: string): Promise<Version>;
    history(actor: Actor, repo: string, path: string, opts?: HistoryOptions): Promise<Version[]>;
    diff(
      actor: Actor,
      repo: string,
      path: string,
      from_version_id: string,
      to_version_id: string,
    ): Promise<UnifiedDiff>;
    create(
      actor: Actor,
      repo: string,
      path: string,
      input: FrontmatterInput & { body: string },
    ): Promise<Version>;
    put(
      actor: Actor,
      repo: string,
      prev_version_id: string,
      path: string,
      input: Partial<FrontmatterInput> & { body?: string },
    ): Promise<Version>;
    delete(actor: Actor, repo: string, prev_version_id: string): Promise<Version>;
  };
  tokens: {
    list(actor: Actor): Promise<Token[]>;
    create(
      actor: Actor,
      label: string | null,
      scopes: ScopeInput[],
      opts?: { admin?: boolean; expires_at?: string | null; for_user?: string | null },
    ): Promise<TokenCreateResult>;
    revoke(actor: Actor, token_id: string): Promise<Token>;
  };
  query(actor: Actor, spec: QuerySpec): Promise<Version[]>;
};

export type KernelConfig = {
  storage: Storage;
  serverPathConfig?: PathConfig;
  /**
   * M4 write-time hook: called with the new version's storage id after
   * every committed create / put / delete. Awaited in-line so a throw
   * from the enqueue path fails the kernel call. In practice the
   * worker's backlog_enqueue is one cheap UPSERT and doesn't throw.
   */
  onVersionCommitted?: (version_id: number) => Promise<void> | void;
  queryEmbed?: (rank: string) => Promise<{ vector: number[]; model: string; dim: number }>;
};

export function createKernel(config: KernelConfig | Storage): Kernel {
  const cfg: KernelConfig =
    "storage" in (config as KernelConfig)
      ? (config as KernelConfig)
      : { storage: config as Storage };
  const storage = cfg.storage;
  const serverPathConfig = cfg.serverPathConfig ?? HARDCODED_DEFAULTS;
  const onVersionCommitted = cfg.onVersionCommitted;
  const queryEmbed = cfg.queryEmbed;

  const userCache = new Map<number, User>();
  async function userById(id: number): Promise<User> {
    const cached = userCache.get(id);
    if (cached) return cached;
    const row = await storage.users_by_id(id);
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

  async function toVersionWire(row: VersionRow, repoSlug: string): Promise<Version> {
    return {
      version_id: encodeVersionId(row.id),
      prev_version_id: row.prev_id === null ? null : encodeVersionId(row.prev_id),
      next_version_id: row.next_id === null ? null : encodeVersionId(row.next_id),
      repo: repoSlug,
      path: row.path,
      frontmatter: row.frontmatter,
      frontmatter_raw: row.frontmatter_raw,
      body: row.body,
      author: await userById(row.author_id),
      created_at: row.created_at,
    };
  }

  function toVersionWireSync(row: VersionRow, repoSlug: string, author: User): Version {
    return {
      version_id: encodeVersionId(row.id),
      prev_version_id: row.prev_id === null ? null : encodeVersionId(row.prev_id),
      next_version_id: row.next_id === null ? null : encodeVersionId(row.next_id),
      repo: repoSlug,
      path: row.path,
      frontmatter: row.frontmatter,
      frontmatter_raw: row.frontmatter_raw,
      body: row.body,
      author,
      created_at: row.created_at,
    };
  }

  function repoEffectiveConfig(repo: RepoRow): PathConfig {
    return effectivePathConfig(serverPathConfig, parseRepoOverride(repo.path_config));
  }

  async function resolveRepo(actor: Actor, slug: string, action: Action): Promise<RepoRow> {
    const row = await storage.repos_by_slug(slug);
    if (!row) throw repoNotFound(slug);
    const target: Target = { kind: "repo", repo_id: row.id };
    authorize(actor, action, target);
    return row;
  }

  function currentPathForStaleError(actor: Actor, repo_id: number, path: string): string | null {
    if (actor.admin) return path;
    return scopesGrant(actor.scopes, "read", repo_id, path) ? path : null;
  }

  function canonicalizeOrCarry(
    input: Partial<FrontmatterInput>,
    prev: VersionRow | null,
  ): CanonicalFrontmatter {
    if (input.frontmatter === undefined && input.frontmatter_raw === undefined && prev) {
      return { frontmatter: prev.frontmatter, frontmatter_raw: prev.frontmatter_raw };
    }
    return canonicalizeFrontmatter(input as FrontmatterInput);
  }

  function slugUniquifier(): string {
    return randomBytes(3).toString("hex");
  }

  function isSlugSystemNamespaced(slug: string): boolean {
    return serverPathConfig.system_sigils.some((sigil) => slug.startsWith(sigil));
  }

  function slugCollisionError(slug: string): KernelError {
    return new KernelError("slug_taken", { slug });
  }

  async function scopesToWire(scopes: StoredScope[]): Promise<Scope[]> {
    const out: Scope[] = [];
    for (const s of scopes) {
      if (s.repos === "*") {
        out.push({ repos: "*", read: s.read, write: s.write });
        continue;
      }
      const slugs: string[] = [];
      for (const id of s.repos) {
        const row = await storage.repos_by_id(id);
        if (row) slugs.push(row.slug);
      }
      slugs.sort();
      out.push({ repos: slugs, read: s.read, write: s.write });
    }
    return out;
  }

  async function tokenRowToWire(row: TokenRow): Promise<Token> {
    return {
      id: tokenIdString(row),
      label: row.label,
      admin: row.admin,
      scopes: await scopesToWire(parseStoredScopes(row.scopes)),
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
      async list(actor, opts) {
        authorize(actor, "read", { kind: "server" });
        const includeSystem = opts?.include_system ?? false;
        const rows = await storage.repos_list();
        return rows.filter((r) => includeSystem || !isSlugSystemNamespaced(r.slug)).map(toRepoWire);
      },
      async get(actor, slug) {
        return toRepoWire(await resolveRepo(actor, slug, "read"));
      },
      async create(actor, slug) {
        authorize(actor, "admin", { kind: "server_admin" });
        validateSlug(slug, serverPathConfig);
        if (await storage.repos_by_slug(slug)) throw slugCollisionError(slug);
        const row = await storage.repos_create({ slug, created_at: new Date().toISOString() });
        return toRepoWire(row);
      },
      async rename(actor, slug, new_slug) {
        authorize(actor, "admin", { kind: "server_admin" });
        const repo = await storage.repos_by_slug(slug);
        if (!repo) throw repoNotFound(slug);
        if (new_slug === slug) return toRepoWire(repo);
        validateSlug(new_slug, serverPathConfig);
        // A folded-equal collision that resolves to THIS repo is a recasing
        // (e.g. "notes" → "Notes"), not a conflict — allow it (§3.5.1).
        const occupant = await storage.repos_by_slug(new_slug);
        if (occupant && occupant.id !== repo.id) throw slugCollisionError(new_slug);
        return toRepoWire(await storage.repos_rename(repo.id, new_slug));
      },
      async delete(actor, slug) {
        authorize(actor, "admin", { kind: "server_admin" });
        const repo = await storage.repos_by_slug(slug);
        if (!repo) throw repoNotFound(slug);
        if (isSlugSystemNamespaced(repo.slug)) return toRepoWire(repo);
        const sigil = serverPathConfig.system_sigils[0] as string;
        for (let attempt = 0; attempt < 5; attempt++) {
          const newSlug = `${sigil}deleted-${repo.slug}-${slugUniquifier()}`;
          if (await storage.repos_by_slug(newSlug)) continue;
          return toRepoWire(await storage.repos_rename(repo.id, newSlug));
        }
        throw new Error("repos.delete: uniquifier collision (retries exhausted)");
      },
      async set_path_config(actor, slug, config) {
        authorize(actor, "admin", { kind: "server_admin" });
        const repo = await storage.repos_by_slug(slug);
        if (!repo) throw repoNotFound(slug);
        if (config !== null) {
          validateRepoOverride(config, serverPathConfig);
        }
        const configJson = config === null ? null : JSON.stringify(config);
        const updated = await storage.repos_set_path_config(repo.id, configJson);
        const newEffective = effectivePathConfig(serverPathConfig, config);
        const warnings: PathWarning[] = [];
        for (const version of await storage.versions_live_by_repo(repo.id)) {
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
      async list(actor) {
        authorize(actor, "read", { kind: "server" });
        return (await storage.users_list()).map((u) => ({ user: u.slug }));
      },
      async create(actor, slug) {
        authorize(actor, "admin", { kind: "server_admin" });
        validateSlug(slug, serverPathConfig);
        if (await storage.users_by_slug(slug)) throw new KernelError("slug_taken", { slug });
        const row = await storage.users_create({ slug, created_at: new Date().toISOString() });
        return { user: row.slug };
      },
      async rename(actor, slug, new_slug) {
        authorize(actor, "admin", { kind: "server_admin" });
        const user = await storage.users_by_slug(slug);
        if (!user) throw userNotFound(slug);
        if (new_slug === slug) return { user: user.slug };
        validateSlug(new_slug, serverPathConfig);
        // A folded-equal collision resolving to THIS user is a recasing (§3.5.1).
        const occupant = await storage.users_by_slug(new_slug);
        if (occupant && occupant.id !== user.id) throw slugCollisionError(new_slug);
        const updated = await storage.users_rename(user.id, new_slug);
        return { user: updated.slug };
      },
      async delete(actor, slug) {
        authorize(actor, "admin", { kind: "server_admin" });
        const user = await storage.users_by_slug(slug);
        if (!user) throw userNotFound(slug);
        if (isSlugSystemNamespaced(user.slug)) return { user: user.slug };
        const sigil = serverPathConfig.system_sigils[0] as string;
        for (let attempt = 0; attempt < 5; attempt++) {
          const newSlug = `${sigil}deleted-${user.slug}-${slugUniquifier()}`;
          if (await storage.users_by_slug(newSlug)) continue;
          await storage.tokens_revoke_by_user(user.id, new Date().toISOString());
          const updated = await storage.users_rename(user.id, newSlug);
          return { user: updated.slug };
        }
        throw new Error("users.delete: uniquifier collision (retries exhausted)");
      },
    },

    docs: {
      async get(actor, repoSlug, path) {
        const repo = await resolveRepo(actor, repoSlug, "read");
        authorize(actor, "read", { kind: "path", repo_id: repo.id, path });
        const row = await storage.version_current(repo.id, path);
        if (!row) throw docNotFound(repoSlug, path);
        return toVersionWire(row, repoSlug);
      },

      async get_version(actor, repoSlug, versionId) {
        const repo = await resolveRepo(actor, repoSlug, "read");
        const id = decodeVersionId(versionId);
        if (id === null) throw versionNotFound(versionId);
        const row = await storage.version_by_id(id);
        if (!row || row.repo_id !== repo.id) throw versionNotFound(versionId);
        authorize(actor, "read", { kind: "path", repo_id: repo.id, path: row.path });
        return toVersionWire(row, repoSlug);
      },

      async history(actor, repoSlug, path, opts) {
        const repo = await resolveRepo(actor, repoSlug, "read");
        authorize(actor, "read", { kind: "path", repo_id: repo.id, path });
        const current = await storage.version_current(repo.id, path);
        if (!current) throw docNotFound(repoSlug, path);
        const rows = await storage.version_history(current.document_id, opts);
        return Promise.all(rows.map((r) => toVersionWire(r, repoSlug)));
      },

      async diff(actor, repoSlug, path, fromVersionId, toVersionId) {
        return runDiff(
          actor,
          {
            repo: repoSlug,
            path,
            from_version_id: fromVersionId,
            to_version_id: toVersionId,
          },
          {
            storage,
            resolveReadRepo: (a, slug) => resolveRepo(a, slug, "read"),
            authorizeReadPath: (a, repo_id, p) =>
              authorize(a, "read", { kind: "path", repo_id, path: p }),
          },
        );
      },

      async create(actor, repoSlug, path, input) {
        const repo = await resolveRepo(actor, repoSlug, "write");
        authorize(actor, "write", { kind: "path", repo_id: repo.id, path });
        validatePath(path, repoEffectiveConfig(repo));
        const canon = canonicalizeFrontmatter(input);

        const { version, insertedId } = await storage.tx(async () => {
          const existing = await storage.version_current(repo.id, path);
          if (existing) {
            throw new KernelError("create_conflict", {
              repo: repoSlug,
              path,
              current_version_id: encodeVersionId(existing.id),
            });
          }
          const doc = await storage.documents_create(repo.id);
          const inserted = await storage.version_insert({
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
          const author = await userById(actor.user_id);
          return {
            version: toVersionWireSync(inserted, repoSlug, author),
            insertedId: inserted.id,
          };
        });
        await onVersionCommitted?.(insertedId);
        return version;
      },

      async put(actor, repoSlug, prevVersionId, destPath, input) {
        const repo = await resolveRepo(actor, repoSlug, "write");
        const prevId = decodeVersionId(prevVersionId);
        if (prevId === null) throw versionNotFound(prevVersionId);
        const prev = await storage.version_by_id(prevId);
        if (!prev || prev.repo_id !== repo.id) throw versionNotFound(prevVersionId);

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

        const { version, insertedId } = await storage.tx(async () => {
          const current = await storage.version_current(repo.id, prev.path);
          if (!current || current.id !== prev.id) {
            const docCurrent =
              current ?? (await storage.version_history(prev.document_id, { limit: 1 }))[0] ?? null;
            throw new KernelError("stale_prev", {
              current_version_id: docCurrent ? encodeVersionId(docCurrent.id) : null,
              current_path: docCurrent
                ? currentPathForStaleError(actor, repo.id, docCurrent.path)
                : null,
              submitted_prev_version_id: prevVersionId,
            });
          }

          if (destPath !== prev.path) {
            const occupant = await storage.version_current(repo.id, destPath);
            if (occupant && occupant.document_id !== prev.document_id) {
              throw new KernelError("path_taken", {
                repo: repoSlug,
                path: destPath,
                current_version_id: encodeVersionId(occupant.id),
              });
            }
          }

          const inserted = await storage.version_insert({
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
          const author = await userById(actor.user_id);
          return {
            version: toVersionWireSync(inserted, repoSlug, author),
            insertedId: inserted.id,
          };
        });
        await onVersionCommitted?.(insertedId);
        return version;
      },

      async delete(actor, repoSlug, prevVersionId) {
        const repo = await resolveRepo(actor, repoSlug, "write");
        const prevId = decodeVersionId(prevVersionId);
        if (prevId === null) throw versionNotFound(prevVersionId);
        const prev = await storage.version_by_id(prevId);
        if (!prev || prev.repo_id !== repo.id) throw versionNotFound(prevVersionId);

        const cfg = repoEffectiveConfig(repo);

        const currentAtPrevPath = await storage.version_current(repo.id, prev.path);
        if (!currentAtPrevPath || currentAtPrevPath.id !== prev.id) {
          const docCurrent =
            currentAtPrevPath ??
            (await storage.version_history(prev.document_id, { limit: 1 }))[0] ??
            null;
          throw new KernelError("stale_prev", {
            current_version_id: docCurrent ? encodeVersionId(docCurrent.id) : null,
            current_path: docCurrent
              ? currentPathForStaleError(actor, repo.id, docCurrent.path)
              : null,
            submitted_prev_version_id: prevVersionId,
          });
        }

        if (pathIsInSystemNamespace(prev.path, cfg.system_sigils)) {
          return toVersionWire(prev, repoSlug);
        }

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

        const { version, insertedId } = await storage.tx(async () => {
          const current = await storage.version_current(repo.id, prev.path);
          if (!current || current.id !== prev.id) {
            const docCurrent =
              current ?? (await storage.version_history(prev.document_id, { limit: 1 }))[0] ?? null;
            throw new KernelError("stale_prev", {
              current_version_id: docCurrent ? encodeVersionId(docCurrent.id) : null,
              current_path: docCurrent
                ? currentPathForStaleError(actor, repo.id, docCurrent.path)
                : null,
              submitted_prev_version_id: prevVersionId,
            });
          }

          const inserted = await storage.version_insert({
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
          const author = await userById(actor.user_id);
          return {
            version: toVersionWireSync(inserted, repoSlug, author),
            insertedId: inserted.id,
          };
        });
        await onVersionCommitted?.(insertedId);
        return version;
      },
    },

    tokens: {
      async list(actor) {
        const rows = await storage.tokens_list(actor.user_id);
        return Promise.all(rows.map((r) => tokenRowToWire(r)));
      },
      async create(actor, label, scopeInputs, opts) {
        const admin = opts?.admin ?? false;
        assertAdminSubset(actor.admin, admin);
        const resolvedScopes = await resolveScopeInputs(scopeInputs, storage);
        if (!actor.admin) {
          assertChildScopeSubset(actor.scopes, resolvedScopes);
        }
        // for_user: admin can mint on behalf of another user (design §8 —
        // bootstrapping a new user's first token). Anyone else silently
        // targets themselves; explicitly naming a different user is
        // forbidden.
        let targetUserId = actor.user_id;
        if (opts?.for_user) {
          const target = await storage.users_by_slug(opts.for_user);
          if (!target) throw userNotFound(opts.for_user);
          if (target.id !== actor.user_id && !actor.admin) {
            throw new KernelError("forbidden", {});
          }
          targetUserId = target.id;
        }
        const secret = generateSecret();
        const row = await storage.tokens_create({
          user_id: targetUserId,
          secret_hash: hashSecret(secret),
          label,
          scopes: serializeStoredScopes(resolvedScopes),
          admin,
          expires_at: opts?.expires_at ?? null,
          created_at: new Date().toISOString(),
        });
        return { token: secret, meta: await tokenRowToWire(row) };
      },
      async revoke(actor, tokenId) {
        const id = decodeTokenId(tokenId);
        if (id === null) throw tokenNotFound(tokenId);
        const row = await storage.tokens_by_id(id);
        if (!row) throw tokenNotFound(tokenId);
        if (row.user_id !== actor.user_id && !actor.admin) {
          throw new KernelError("forbidden", {});
        }
        const revoked = await storage.tokens_revoke(id, new Date().toISOString());
        return tokenRowToWire(revoked ?? row);
      },
    },

    async query(actor: Actor, spec: QuerySpec): Promise<Version[]> {
      authorize(actor, "read", { kind: "server" });
      return runQuery(actor, spec, {
        storage,
        serverPathConfig,
        toVersionWire,
        queryEmbed,
      });
    },
  };
}
