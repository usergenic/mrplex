/**
 * KernelClient — the CLI's transport seam.
 *
 * Mirrors the shape of the `Kernel` type (design §6.1) minus the `Actor`
 * argument: transport supplies identity. In-process (`local.ts`) resolves
 * a token to an actor at construction and forwards each call; remote
 * (`remote-mcp.ts`) sends each call as a `tools/call` over Streamable HTTP.
 *
 * All methods are async so the local and remote implementations share one
 * shape — the CLI awaits them regardless of which transport is in play.
 */

import type { ScopeInput } from "../kernel/auth/scope.js";
import type { FrontmatterInput } from "../kernel/frontmatter-input.js";
import type { PathConfigOverride } from "../kernel/path-config.js";
import type { QuerySpec } from "../kernel/query/query.js";
import type { PathWarning, Repo, Token, User, Version } from "../kernel/wire.js";

export type HistoryOptions = { limit?: number; before?: string };
export type SetPathConfigResult = { repo: Repo; warnings: PathWarning[] };
export type TokenCreateResult = { token: string; meta: Token };

export type KernelClient = {
  repos: {
    list(opts?: { include_system?: boolean }): Promise<Repo[]>;
    get(slug: string): Promise<Repo>;
    create(slug: string): Promise<Repo>;
    rename(slug: string, new_slug: string): Promise<Repo>;
    delete(slug: string): Promise<Repo>;
    set_path_config(slug: string, config: PathConfigOverride | null): Promise<SetPathConfigResult>;
  };
  users: {
    list(): Promise<User[]>;
    create(slug: string): Promise<User>;
    rename(slug: string, new_slug: string): Promise<User>;
    delete(slug: string): Promise<User>;
  };
  docs: {
    get(repo: string, path: string): Promise<Version>;
    get_version(repo: string, version_id: string): Promise<Version>;
    history(repo: string, path: string, opts?: HistoryOptions): Promise<Version[]>;
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
  tokens: {
    list(): Promise<Token[]>;
    create(
      label: string | null,
      scopes: ScopeInput[],
      opts?: { admin?: boolean; expires_at?: string | null },
    ): Promise<TokenCreateResult>;
    revoke(token_id: string): Promise<Token>;
  };
  query(spec: QuerySpec): Promise<Version[]>;

  /** Release any transport-owned resources. Idempotent. */
  close(): Promise<void>;
};
