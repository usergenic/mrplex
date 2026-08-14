/**
 * Kernel error catalog. Every kernel-emitted error has a stable `code` and
 * a JSON-serializable `data` payload — design §4.3.
 *
 * M0 surfaces only the read-time subset; writes and auth land in M1.
 */

export type KernelErrorCode =
  | "repo_not_found"
  | "user_not_found"
  | "doc_not_found"
  | "version_not_found"
  | "token_not_found"
  | "version_not_in_document"
  | "slug_invalid"
  | "path_invalid"
  | "frontmatter_invalid"
  | "filter_invalid"
  | "stale_prev"
  | "create_conflict"
  | "path_taken"
  | "slug_taken"
  | "unauthorized"
  | "forbidden"
  // Surface-emitted; the kernel itself never throws these but they share the
  // catalog because clients (and the CLI's exit-code families) discriminate
  // on `code`. M3 added both.
  | "precondition_required" // REST: PUT/DELETE without If-Match / If-None-Match (§m3-plan decision 5)
  | "payload_too_large" // REST: body exceeded MAX_BODY_BYTES
  // M4 (m4-plan §5 decision 4): rank query arrived with no hook
  // configured, OR the hook failed at query time. Distinct from
  // filter_invalid (the query is well-formed) and from write-path
  // embedding failure (which never errors — backlog absorbs it).
  // Maps to HTTP 503.
  | "rank_unavailable";

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
  "user_not_found",
  "doc_not_found",
  "version_not_found",
  "token_not_found",
  "version_not_in_document",
  "slug_invalid",
  "path_invalid",
  "frontmatter_invalid",
  "filter_invalid",
  "stale_prev",
  "create_conflict",
  "path_taken",
  "slug_taken",
  "unauthorized",
  "forbidden",
  "precondition_required",
  "payload_too_large",
  "rank_unavailable",
]);

/** Type guard — check whether an arbitrary string is a known catalog code. */
export function isKernelErrorCode(code: string): code is KernelErrorCode {
  return KERNEL_ERROR_CODES.has(code as KernelErrorCode);
}

export const repoNotFound = (slug: string) => new KernelError("repo_not_found", { slug });

export const userNotFound = (slug: string) => new KernelError("user_not_found", { slug });

export const docNotFound = (repo: string, path: string) =>
  new KernelError("doc_not_found", { repo, path });

export const versionNotFound = (versionId: string) =>
  new KernelError("version_not_found", { version_id: versionId });

export const tokenNotFound = (tokenId: string) =>
  new KernelError("token_not_found", { token_id: tokenId });

export const versionNotInDocument = (versionId: string, repo: string, path: string) =>
  new KernelError("version_not_in_document", { version_id: versionId, repo, path });

// Auth (§8.4). `unauthorized` = no/bad/expired token; `forbidden` = valid
// token, insufficient scope. Both errors deliberately omit resource details
// per §8.4 (don't leak existence via forbidden-vs-not-found ambiguity).
export const unauthorized = () => new KernelError("unauthorized", {});
export const forbidden = () => new KernelError("forbidden", {});
