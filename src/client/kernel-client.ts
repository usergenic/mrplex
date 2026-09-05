/**
 * KernelClient — the CLI's transport seam.
 *
 * Mirrors the shape of the `Kernel` type (design §6.1) minus the `CallContext`
 * argument: the client is constructed with a default context (author + scope)
 * and forwards it on every call. In-process (`local.ts`) builds a Kernel and
 * calls it directly; remote (`remote-mcp.ts`) sends each call as a `tools/call`
 * over Streamable HTTP, injecting context via the `X-Mrplex-*` headers.
 *
 * All methods are async so the local and remote implementations share one
 * shape — the CLI awaits them regardless of which transport is in play.
 */

import type { UnifiedDiff } from "../kernel/diff.js";
import type { FrontmatterInput } from "../kernel/frontmatter-input.js";
import type {
  LinksBackfillResult,
  RepairResult,
  SetLinkConfigResult,
  StaleLinkWire,
} from "../kernel/kernel.js";
import type { PathConfigOverride } from "../kernel/path-config.js";
import type { QuerySpec } from "../kernel/query/query.js";
import type {
  DocGetManyResult,
  GraphResult,
  GraphSpec,
  HistoryIndexPage,
  HistorySincePage,
  PathWarning,
  QueryHit,
  Repo,
  VerifyReport,
  VerifySpec,
  Version,
} from "../kernel/wire.js";
import type { LinkConfigOverride } from "../links/link-config.js";

export type HistoryOptions = { limit?: number; before?: string };
export type SetPathConfigResult = { repo: Repo; warnings: PathWarning[] };

/**
 * Options for document reads. `raw` suppresses server-injected system
 * properties (`$version`, and — later — `$author`, `$updated_at`, …) so
 * callers see the exact stored `frontmatter_raw`. Defaults to false —
 * injection is on by default because the round-trip is useful more often
 * than not.
 */
export type DocGetOptions = { raw?: boolean };

export type KernelClient = {
  repos: {
    list(opts?: { include_system?: boolean }): Promise<Repo[]>;
    get(slug: string): Promise<Repo>;
    create(slug: string): Promise<Repo>;
    rename(slug: string, new_slug: string): Promise<Repo>;
    delete(slug: string): Promise<Repo>;
    set_path_config(slug: string, config: PathConfigOverride | null): Promise<SetPathConfigResult>;
    set_link_config(slug: string, config: LinkConfigOverride | null): Promise<SetLinkConfigResult>;
  };
  docs: {
    get(repo: string, path: string, opts?: DocGetOptions): Promise<Version>;
    get_many(repo: string, paths: string[], opts?: DocGetOptions): Promise<DocGetManyResult>;
    get_version(repo: string, version_id: string, opts?: DocGetOptions): Promise<Version>;
    history(repo: string, path: string, opts?: HistoryOptions): Promise<Version[]>;
    diff(
      repo: string,
      path: string,
      from_version_id: string,
      to_version_id: string,
    ): Promise<UnifiedDiff>;
    create(
      repo: string,
      path: string,
      input: FrontmatterInput & { body: string },
    ): Promise<Version>;
    put(
      repo: string,
      prev_version_id: string,
      path: string,
      input: Partial<FrontmatterInput> & { body?: string },
    ): Promise<Version>;
    delete(repo: string, prev_version_id: string): Promise<Version>;
  };
  links: {
    backfill(repo: string): Promise<LinksBackfillResult>;
    stale(repo: string): Promise<StaleLinkWire[]>;
    repair(repo: string, opts?: { dry_run?: boolean }): Promise<RepairResult>;
  };
  query(spec: QuerySpec): Promise<QueryHit[]>;
  graph(spec: GraphSpec): Promise<GraphResult>;
  verify(spec: VerifySpec): Promise<VerifyReport>;
  history: {
    since(input: {
      after_version: string;
      repo?: string;
      limit?: number;
    }): Promise<HistorySincePage>;
    index(input: {
      repo: string;
      through_version?: string;
      after_version?: string;
      limit?: number;
    }): Promise<HistoryIndexPage>;
    list(input: {
      repo: string;
      path?: string;
      ever?: boolean;
      since?: string;
      until?: string;
      order?: "asc" | "desc";
      limit?: number;
    }): Promise<Version[]>;
  };

  /** Release any transport-owned resources. Idempotent. */
  close(): Promise<void>;
};
