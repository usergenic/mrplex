/**
 * Kernel error catalog. Every kernel-emitted error has a stable `code` and
 * a JSON-serializable `data` payload — design §4.3.
 *
 * M0 surfaces only the read-time subset; writes and auth land in M1.
 */

export type KernelErrorCode =
  | "repo_not_found"
  | "doc_not_found"
  | "version_not_found"
  | "version_not_in_document"
  | "slug_invalid"
  | "path_invalid"
  | "frontmatter_invalid"
  | "filter_invalid"
  | "link_config_invalid" // repos.set_link_config: override fails validation post-merge (§11.2)
  | "stale_prev"
  | "create_conflict"
  | "path_taken"
  | "slug_taken"
  | "forbidden"
  // Surface-emitted; the kernel itself never throws these but they share the
  // catalog because clients (and the CLI's exit-code families) discriminate
  // on `code`. M3 added both.
  | "precondition_required" // REST: PUT/DELETE without If-Match / If-None-Match (§m3-plan decision 5)
  | "payload_too_large" // REST: body exceeded MAX_BODY_BYTES
  // M4 (m4-plan §5 decision 4): semantic query arrived with no hook
  // configured, OR the hook failed at query time. Distinct from
  // filter_invalid (the query is well-formed) and from write-path
  // embedding failure (which never errors — backlog absorbs it).
  // Maps to HTTP 503.
  | "semantic_unavailable";

export class KernelError<D = Record<string, unknown>> extends Error {
  constructor(
    public readonly code: KernelErrorCode,
    public readonly data: D,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "KernelError";
  }
}

/**
 * Runtime set matching KernelErrorCode. Used by the remote MCP client to
 * validate an incoming `code` string before rehydrating a KernelError —
 * otherwise a rogue server could inject unknown codes and break clients
 * that switch exhaustively.
 */
export const KERNEL_ERROR_CODES: ReadonlySet<KernelErrorCode> = new Set<KernelErrorCode>([
  "repo_not_found",
  "doc_not_found",
  "version_not_found",
  "version_not_in_document",
  "slug_invalid",
  "path_invalid",
  "frontmatter_invalid",
  "filter_invalid",
  "link_config_invalid",
  "stale_prev",
  "create_conflict",
  "path_taken",
  "slug_taken",
  "forbidden",
  "precondition_required",
  "payload_too_large",
  "semantic_unavailable",
]);

/** Type guard — check whether an arbitrary string is a known catalog code. */
export function isKernelErrorCode(code: string): code is KernelErrorCode {
  return KERNEL_ERROR_CODES.has(code as KernelErrorCode);
}

export const repoNotFound = (slug: string) => new KernelError("repo_not_found", { slug });

export const docNotFound = (repo: string, path: string) =>
  new KernelError("doc_not_found", { repo, path });

export const versionNotFound = (versionId: string) =>
  new KernelError("version_not_found", { version_id: versionId });

export const versionNotInDocument = (versionId: string, repo: string, path: string) =>
  new KernelError("version_not_in_document", { version_id: versionId, repo, path });

// `forbidden` (§8.4): the scope claim supplied with this call excludes the
// target. Still HTTP 403; still omits resource details so out-of-claim and
// nonexistent look identical (shells can hand mrplex errors to their untrusted
// callers unfiltered). `unauthorized` is gone — the engine trusts every caller.
export const forbidden = () => new KernelError("forbidden", {});
