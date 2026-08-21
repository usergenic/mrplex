/**
 * CLI exit-code families — design §7.3.
 *
 *   1  validation
 *   2  concurrency / conflict     (M1)
 *   3  auth                        (M1)
 *   4  not-found
 *   10 network / transport         (M3)
 *
 * Everything else exits 1.
 */

import type { KernelErrorCode } from "../kernel/errors.js";

export function exitCodeForKernelError(code: KernelErrorCode): number {
  switch (code) {
    case "repo_not_found":
    case "doc_not_found":
    case "version_not_found":
      return 4;
    case "stale_prev":
    case "create_conflict":
    case "path_taken":
    case "slug_taken":
      return 2;
    case "forbidden":
      return 3;
    case "slug_invalid":
    case "path_invalid":
    case "frontmatter_invalid":
    case "filter_invalid":
    case "link_config_invalid":
    case "version_not_in_document":
    case "precondition_required":
    case "payload_too_large":
    case "rank_unavailable":
      return 1;
    default:
      return 1;
  }
}
