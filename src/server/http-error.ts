/**
 * KernelError → HTTP mapping — design §6.3 + m3-plan §5 decision 4.
 *
 * The wire body for a mapped kernel error is `{ code, data }` — verbatim
 * from the KernelError; the HTTP status just picks the closest match.
 * 412 responses additionally carry the current `version_id` in the `ETag`
 * response header (§6.3) so a caller can retry against it without reading
 * the JSON.
 *
 * Unknown/internal throwables collapse to a 500 with a small generic body
 * (`{ code: "internal_error", data: {} }`); the raw message is not
 * surfaced. This is the ONE code that isn't a KernelErrorCode — the design
 * catalog doesn't cover the "server bug" case.
 */

import { KernelError, type KernelErrorCode } from "../kernel/errors.js";

/**
 * An error that already knows its HTTP shape. The engine never throws this —
 * it exists so a fronting layer (the auth shell) can reject a request with a
 * status the surface catalog doesn't cover (e.g. 401 `unauthorized`) without
 * the surface having to import the shell. `httpErrorForThrowable` honors it.
 */
export class HttpResponseError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly data: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "HttpResponseError";
  }
}

export type HttpErrorBody =
  | { code: KernelErrorCode; data: Record<string, unknown> }
  | { code: "internal_error"; data: Record<string, unknown> };

export type HttpError = {
  status: number;
  body: HttpErrorBody;
  /** Optional `ETag` value (e.g. current version_id on stale_prev/create_conflict). */
  etag?: string;
};

/** Return the HTTP status for a given KernelErrorCode. */
export function httpStatusFor(code: KernelErrorCode): number {
  switch (code) {
    case "forbidden":
      return 403;
    case "stale_prev":
    case "create_conflict":
      return 412;
    case "precondition_required":
      return 428;
    case "payload_too_large":
      return 413;
    case "path_taken":
    case "slug_taken":
      return 409;
    case "repo_not_found":
    case "doc_not_found":
    case "version_not_found":
      return 404;
    case "version_not_in_document":
      return 422;
    case "slug_invalid":
    case "path_invalid":
    case "frontmatter_invalid":
    case "filter_invalid":
    case "link_config_invalid":
      return 400;
    case "rank_unavailable":
      return 503;
    default: {
      const _exhaustive: never = code;
      void _exhaustive;
      return 500;
    }
  }
}

/**
 * Turn a KernelError into the response envelope the REST surface writes.
 * If the error carries a `current_version_id` (stale_prev / create_conflict),
 * we surface it as the `ETag` header per §6.3.
 */
export function httpErrorForKernelError(err: KernelError): HttpError {
  const data = err.data as Record<string, unknown>;
  const status = httpStatusFor(err.code);
  const out: HttpError = {
    status,
    body: { code: err.code, data },
  };
  if (status === 412) {
    const cv = data.current_version_id;
    if (typeof cv === "string") out.etag = cv;
  }
  return out;
}

/**
 * Narrow any thrown value to an HttpError. A non-KernelError becomes a 500
 * with a generic body — the raw message is not surfaced to callers.
 */
export function httpErrorForThrowable(err: unknown): HttpError {
  if (err instanceof KernelError) return httpErrorForKernelError(err);
  if (err instanceof HttpResponseError) {
    return { status: err.status, body: { code: err.code, data: err.data } as HttpErrorBody };
  }
  return {
    status: 500,
    body: { code: "internal_error", data: {} },
  };
}
