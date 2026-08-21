/**
 * Kernel — the only place the read model, error catalog, and slug↔id
 * translation live. Surfaces (CLI, MCP, REST) call these methods and never
 * touch the storage layer directly.
 *
 * No-auth model (design §8, noauth plan): the kernel trusts every caller.
 * Every op takes a uniform `ctx: CallContext` first parameter — a plain
 * caller-supplied value, not a resolved identity. Writes stamp `ctx.author`
 * (default "mrplex"); reads narrow visibility through `ctx.scope` when present.
 *
 * All kernel methods are async (m5-plan WS1). SQLite adapter is
 * internally synchronous so calls resolve on the next microtask; the
 * async signature is honesty about the Postgres adapter and the
 * embedding hook.
 */

import { randomBytes } from "node:crypto";
import { backfillRepoLinks } from "../links/backfill.js";
import {
  HARDCODED_DEFAULTS as LINK_DEFAULTS,
  type LinkConfig,
  type LinkConfigOverride,
  effectiveLinkConfig,
  parseRepoOverride as parseLinkOverride,
  validateRepoOverride as validateLinkOverride,
} from "../links/link-config.js";
import { bindDanglingToPath, reindexOutboundLinks } from "../links/maintain.js";
import { planRepairs } from "../links/repair.js";
import { findStaleLinks } from "../links/stale.js";
import type { RepoRow, Storage, VersionRow } from "../storage/types.js";
import {
  type ClaimMatcher,
  claimsGrantRead,
  claimsGrantRepo,
  normalizeClaims,
} from "./auth/scope.js";
import { type CallContext, resolveAuthor } from "./context.js";
import { deletionPath, pathIsInSystemNamespace } from "./deletion.js";
import { type UnifiedDiff, runDiff } from "./diff.js";
import { KernelError, docNotFound, forbidden, repoNotFound, versionNotFound } from "./errors.js";
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
import type { PathWarning, Repo, Version } from "./wire.js";

export type HistoryOptions = { limit?: number; before?: string };

export type SetPathConfigResult = { repo: Repo; warnings: PathWarning[] };

export type LinksBackfillResult = { documents: number; edges: number };

/**
 * Result of `repos.set_link_config`: the updated repo plus the re-extraction
 * report. A config change makes the link index stale, so the op re-extracts
 * the whole repo under the new config in the same call (§11.2 "Config change
 * ⇒ re-extraction") — the returned `reindexed` counts document it.
 */
export type SetLinkConfigResult = { repo: Repo; reindexed: LinksBackfillResult };

/** A stale link on the wire — paths, never internal document ids. */
export type StaleLinkWire = {
  repo: string;
  source_path: string;
  ord: number;
  written: string;
  current: string;
};

export type RepairResult = {
  dry_run: boolean;
  repaired: { path: string; edges: number }[];
  skipped: { path: string; reason: string }[];
};

export type Kernel = {
  repos: {
    list(ctx: CallContext, opts?: { include_system?: boolean }): Promise<Repo[]>;
    get(ctx: CallContext, slug: string): Promise<Repo>;
    create(ctx: CallContext, slug: string): Promise<Repo>;
    rename(ctx: CallContext, slug: string, new_slug: string): Promise<Repo>;
    delete(ctx: CallContext, slug: string): Promise<Repo>;
    set_path_config(
      ctx: CallContext,
      slug: string,
      config: PathConfigOverride | null,
    ): Promise<SetPathConfigResult>;
    set_link_config(
      ctx: CallContext,
      slug: string,
      config: LinkConfigOverride | null,
    ): Promise<SetLinkConfigResult>;
  };
  docs: {
    get(ctx: CallContext, repo: string, path: string): Promise<Version>;
    get_version(ctx: CallContext, repo: string, version_id: string): Promise<Version>;
    history(
      ctx: CallContext,
      repo: string,
      path: string,
      opts?: HistoryOptions,
    ): Promise<Version[]>;
    diff(
      ctx: CallContext,
      repo: string,
      path: string,
      from_version_id: string,
      to_version_id: string,
    ): Promise<UnifiedDiff>;
    create(
      ctx: CallContext,
      repo: string,
      path: string,
      input: FrontmatterInput & { body: string },
    ): Promise<Version>;
    put(
      ctx: CallContext,
      repo: string,
      prev_version_id: string,
      path: string,
      input: Partial<FrontmatterInput> & { body?: string },
    ): Promise<Version>;
    delete(ctx: CallContext, repo: string, prev_version_id: string): Promise<Version>;
  };
  links: {
    /** Rebuild the link index for a repo (backfill / config-change). */
    backfill(ctx: CallContext, repo: string): Promise<LinksBackfillResult>;
    /** List live docs whose written link text is stale vs. the target's path. */
    stale(ctx: CallContext, repo: string): Promise<StaleLinkWire[]>;
    /** Rewrite stale link text as optimistic docs.put; dry_run plans only. */
    repair(ctx: CallContext, repo: string, opts?: { dry_run?: boolean }): Promise<RepairResult>;
  };
  query(ctx: CallContext, spec: QuerySpec): Promise<Version[]>;
};

export type KernelConfig = {
  storage: Storage;
  serverPathConfig?: PathConfig;
  /** Server-level link-extraction config (§11.2). Defaults to hardcoded. */
  serverLinkConfig?: LinkConfig;
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
  const serverLinkConfig = cfg.serverLinkConfig ?? LINK_DEFAULTS;
  const onVersionCommitted = cfg.onVersionCommitted;
  const queryEmbed = cfg.queryEmbed;

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
      author: row.author,
      created_at: row.created_at,
    };
  }

  function repoEffectiveConfig(repo: RepoRow): PathConfig {
    return effectivePathConfig(serverPathConfig, parseRepoOverride(repo.path_config));
  }

  function repoEffectiveLinkConfig(repo: RepoRow): LinkConfig {
    return effectiveLinkConfig(serverLinkConfig, parseLinkOverride(repo.link_config));
  }

  /**
   * Normalized read claims for this call, or null when the context supplies no
   * scope (full visibility). Null short-circuits every visibility check.
   */
  function claimsFor(ctx: CallContext): ClaimMatcher[] | null {
    return ctx.scope === undefined ? null : normalizeClaims(ctx.scope);
  }

  async function resolveRepo(ctx: CallContext, slug: string): Promise<RepoRow> {
    const row = await storage.repos_by_slug(slug);
    if (!row) throw repoNotFound(slug);
    // A read claim that doesn't bind this repo at all hides it entirely — same
    // shape as not-found so out-of-claim leaks no existence information (§8.4).
    const claims = claimsFor(ctx);
    if (claims && !claimsGrantRepo(claims, row.slug)) throw repoNotFound(slug);
    return row;
  }

  /**
   * Throw `forbidden` when a targeted read (docs.get / get_version / history /
   * diff) names a path outside the call's claims. Absent scope = full access.
   */
  function assertReadable(claims: ClaimMatcher[] | null, repoSlug: string, path: string): void {
    if (claims === null) return;
    if (!claimsGrantRead(claims, repoSlug, path)) throw forbidden();
  }

  function currentPathForStaleError(
    claims: ClaimMatcher[] | null,
    repoSlug: string,
    path: string,
  ): string | null {
    if (claims === null) return path;
    return claimsGrantRead(claims, repoSlug, path) ? path : null;
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

  const kernel: Kernel = {
    repos: {
      async list(ctx, opts) {
        const includeSystem = opts?.include_system ?? false;
        const claims = claimsFor(ctx);
        const rows = await storage.repos_list();
        return rows
          .filter((r) => includeSystem || !isSlugSystemNamespaced(r.slug))
          .filter((r) => claims === null || claimsGrantRepo(claims, r.slug))
          .map(toRepoWire);
      },
      async get(ctx, slug) {
        const repo = await storage.repos_by_slug(slug);
        if (!repo) throw repoNotFound(slug);
        const claims = claimsFor(ctx);
        if (claims && !claimsGrantRepo(claims, repo.slug)) throw repoNotFound(slug);
        return toRepoWire(repo);
      },
      // The five destructive repo ops below intentionally ignore `ctx` (hence
      // `_ctx`): per noauth-plan decision 11, destructive repo ops are ungated —
      // reachable = allowed; the shell gates them by route/tool-name. This is
      // deliberately asymmetric with `list`/`get` above, which DO filter by
      // read claim: a scoped caller can `delete` a repo it can't `list`. That
      // asymmetry is the design, not an oversight — don't "fix" it by threading
      // claims through here.
      async create(_ctx, slug) {
        validateSlug(slug, serverPathConfig);
        if (await storage.repos_by_slug(slug)) throw slugCollisionError(slug);
        const row = await storage.repos_create({ slug, created_at: new Date().toISOString() });
        return toRepoWire(row);
      },
      async rename(_ctx, slug, new_slug) {
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
      async delete(_ctx, slug) {
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
      async set_path_config(_ctx, slug, config) {
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
      async set_link_config(_ctx, slug, config) {
        const repo = await storage.repos_by_slug(slug);
        if (!repo) throw repoNotFound(slug);
        if (config !== null) {
          // Validates the merge; throws link_config_invalid on a bad override.
          validateLinkOverride(config, serverLinkConfig);
        }
        const configJson = config === null ? null : JSON.stringify(config);
        const updated = await storage.repos_set_link_config(repo.id, configJson);
        // A config change makes the link index stale for this repo — re-extract
        // the whole corpus under the new effective config now, so the index is
        // immediately consistent (§11.2 "Config change ⇒ re-extraction").
        const reindexed = await backfillRepoLinks(
          storage,
          repo.id,
          effectiveLinkConfig(serverLinkConfig, config),
        );
        return { repo: toRepoWire(updated), reindexed };
      },
    },

    docs: {
      async get(ctx, repoSlug, path) {
        const repo = await resolveRepo(ctx, repoSlug);
        assertReadable(claimsFor(ctx), repo.slug, path);
        const row = await storage.version_current(repo.id, path);
        if (!row) throw docNotFound(repoSlug, path);
        return toVersionWire(row, repoSlug);
      },

      async get_version(ctx, repoSlug, versionId) {
        const repo = await resolveRepo(ctx, repoSlug);
        const id = decodeVersionId(versionId);
        if (id === null) throw versionNotFound(versionId);
        const row = await storage.version_by_id(id);
        if (!row || row.repo_id !== repo.id) throw versionNotFound(versionId);
        assertReadable(claimsFor(ctx), repo.slug, row.path);
        return toVersionWire(row, repoSlug);
      },

      async history(ctx, repoSlug, path, opts) {
        const repo = await resolveRepo(ctx, repoSlug);
        assertReadable(claimsFor(ctx), repo.slug, path);
        const current = await storage.version_current(repo.id, path);
        if (!current) throw docNotFound(repoSlug, path);
        const rows = await storage.version_history(current.document_id, opts);
        return rows.map((r) => toVersionWire(r, repoSlug));
      },

      async diff(ctx, repoSlug, path, fromVersionId, toVersionId) {
        const claims = claimsFor(ctx);
        return runDiff(
          {
            repo: repoSlug,
            path,
            from_version_id: fromVersionId,
            to_version_id: toVersionId,
          },
          {
            storage,
            resolveReadRepo: (slug) => resolveRepo(ctx, slug),
            authorizeReadPath: (repoSlug, p) => assertReadable(claims, repoSlug, p),
          },
        );
      },

      async create(ctx, repoSlug, path, input) {
        const repo = await resolveRepo(ctx, repoSlug);
        validatePath(path, repoEffectiveConfig(repo));
        const author = resolveAuthor(ctx);
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
            author,
            created_at: new Date().toISOString(),
          });
          // Links (§11.2): index this doc's outbound edges, and bind any
          // danglers that were waiting for a document at this path.
          const linkConfig = repoEffectiveLinkConfig(repo);
          await reindexOutboundLinks(
            storage,
            linkConfig,
            repo.id,
            doc.id,
            path,
            input.body,
            canon.frontmatter,
          );
          await bindDanglingToPath(storage, repo.id, path, doc.id);
          return {
            version: toVersionWire(inserted, repoSlug),
            insertedId: inserted.id,
          };
        });
        await onVersionCommitted?.(insertedId);
        return version;
      },

      async put(ctx, repoSlug, prevVersionId, destPath, input) {
        const repo = await resolveRepo(ctx, repoSlug);
        const prevId = decodeVersionId(prevVersionId);
        if (prevId === null) throw versionNotFound(prevVersionId);
        const prev = await storage.version_by_id(prevId);
        if (!prev || prev.repo_id !== repo.id) throw versionNotFound(prevVersionId);

        const putCfg = repoEffectiveConfig(repo);
        validatePath(destPath, putCfg);
        const author = resolveAuthor(ctx);
        const canon = canonicalizeOrCarry(input, prev);
        const body = input.body ?? prev.body;
        const claims = claimsFor(ctx);

        const { version, insertedId } = await storage.tx(async () => {
          const current = await storage.version_current(repo.id, prev.path);
          if (!current || current.id !== prev.id) {
            const docCurrent =
              current ?? (await storage.version_history(prev.document_id, { limit: 1 }))[0] ?? null;
            throw new KernelError("stale_prev", {
              current_version_id: docCurrent ? encodeVersionId(docCurrent.id) : null,
              current_path: docCurrent
                ? currentPathForStaleError(claims, repo.slug, docCurrent.path)
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
            author,
            created_at: new Date().toISOString(),
          });
          // Links (§11.2): re-extract this doc's outbound edges from the new
          // version (body/frontmatter or the source path may have changed).
          // Inbound edges are identity-bound, so a move needs no inbound
          // churn; but a move INTO a path that has danglers binds them.
          const linkConfig = repoEffectiveLinkConfig(repo);
          await reindexOutboundLinks(
            storage,
            linkConfig,
            repo.id,
            prev.document_id,
            destPath,
            body,
            canon.frontmatter,
          );
          if (destPath !== prev.path) {
            await bindDanglingToPath(storage, repo.id, destPath, prev.document_id);
          }
          return {
            version: toVersionWire(inserted, repoSlug),
            insertedId: inserted.id,
          };
        });
        await onVersionCommitted?.(insertedId);
        return version;
      },

      async delete(ctx, repoSlug, prevVersionId) {
        const repo = await resolveRepo(ctx, repoSlug);
        const prevId = decodeVersionId(prevVersionId);
        if (prevId === null) throw versionNotFound(prevVersionId);
        const prev = await storage.version_by_id(prevId);
        if (!prev || prev.repo_id !== repo.id) throw versionNotFound(prevVersionId);

        const cfg = repoEffectiveConfig(repo);
        // Deletion is an authored act by the deleter (noauth plan §1).
        const author = resolveAuthor(ctx);
        const claims = claimsFor(ctx);

        const currentAtPrevPath = await storage.version_current(repo.id, prev.path);
        if (!currentAtPrevPath || currentAtPrevPath.id !== prev.id) {
          const docCurrent =
            currentAtPrevPath ??
            (await storage.version_history(prev.document_id, { limit: 1 }))[0] ??
            null;
          throw new KernelError("stale_prev", {
            current_version_id: docCurrent ? encodeVersionId(docCurrent.id) : null,
            current_path: docCurrent
              ? currentPathForStaleError(claims, repo.slug, docCurrent.path)
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

        const { version, insertedId } = await storage.tx(async () => {
          const current = await storage.version_current(repo.id, prev.path);
          if (!current || current.id !== prev.id) {
            const docCurrent =
              current ?? (await storage.version_history(prev.document_id, { limit: 1 }))[0] ?? null;
            throw new KernelError("stale_prev", {
              current_version_id: docCurrent ? encodeVersionId(docCurrent.id) : null,
              current_path: docCurrent
                ? currentPathForStaleError(claims, repo.slug, docCurrent.path)
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
            author,
            created_at: new Date().toISOString(),
          });
          // Links (§11.2): clear the deleted doc's OUTBOUND edges — a doc in
          // the system namespace links to nothing readable. INBOUND edges
          // (target = this doc) stay bound; visibility filtering excludes
          // them from live-namespace queries, and they rebind naturally if
          // the doc is restored.
          await storage.links_clear(prev.document_id);
          return {
            version: toVersionWire(inserted, repoSlug),
            insertedId: inserted.id,
          };
        });
        await onVersionCommitted?.(insertedId);
        return version;
      },
    },

    links: {
      async backfill(ctx, repoSlug) {
        const repo = await resolveRepo(ctx, repoSlug);
        return backfillRepoLinks(storage, repo.id, repoEffectiveLinkConfig(repo));
      },

      async stale(ctx, repoSlug) {
        const repo = await resolveRepo(ctx, repoSlug);
        const rows = await findStaleLinks(storage, repo.id, repoEffectiveLinkConfig(repo));
        // Scope (§11.2 "Scope interaction" — visible graph = readable graph):
        // surface a stale link only when the caller can read BOTH endpoints.
        // The SOURCE path is what we return + would rewrite; the `current`
        // (TARGET) path we'd expose is private if the caller can't read it —
        // dropping the row prevents leaking the moved target's new location.
        const claims = claimsFor(ctx);
        const canRead = (p: string) => claims === null || claimsGrantRead(claims, repo.slug, p);
        return rows
          .filter((r) => canRead(r.source_path) && canRead(r.current))
          .map((r) => ({
            repo: repoSlug,
            source_path: r.source_path,
            ord: r.ord,
            written: r.written,
            current: r.current,
          }));
      },

      async repair(ctx, repoSlug, opts) {
        const dryRun = opts?.dry_run ?? false;
        const repo = await resolveRepo(ctx, repoSlug);
        const plans = await planRepairs(storage, repo.id, repoEffectiveLinkConfig(repo));
        const repaired: { path: string; edges: number }[] = [];
        const skipped: { path: string; reason: string }[] = [];
        const claims = claimsFor(ctx);

        for (const plan of plans) {
          // Only repair docs the caller may read (no write scopes in the
          // engine — read claims gate what's touchable, noauth plan §1 "Out").
          if (claims && !claimsGrantRead(claims, repo.slug, plan.version.path)) {
            skipped.push({ path: plan.version.path, reason: "forbidden" });
            continue;
          }
          if (dryRun) {
            repaired.push({ path: plan.version.path, edges: plan.edges });
            continue;
          }
          try {
            // Repair preserves authorship: the original author effectively
            // wrote this content (only stale link text changed), so carry
            // forward prev.author rather than stamping the repair caller
            // (noauth plan decision 7).
            await kernel.docs.put(
              { ...ctx, author: plan.version.author },
              repoSlug,
              encodeVersionId(plan.version.id),
              plan.version.path,
              { body: plan.newBody },
            );
            repaired.push({ path: plan.version.path, edges: plan.edges });
          } catch (err) {
            if (err instanceof KernelError && err.code === "stale_prev") {
              skipped.push({ path: plan.version.path, reason: "conflict" });
            } else {
              throw err;
            }
          }
        }
        return { dry_run: dryRun, repaired, skipped };
      },
    },

    async query(ctx: CallContext, spec: QuerySpec): Promise<Version[]> {
      return runQuery(claimsFor(ctx), spec, {
        storage,
        serverPathConfig,
        toVersionWire,
        queryEmbed,
      });
    },
  };
  return kernel;
}
