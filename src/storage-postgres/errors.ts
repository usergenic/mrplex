/**
 * Postgres SQLSTATE → kernel error mapping (m5-plan WS4).
 *
 * The adapter surfaces:
 *   - 23505 unique_violation → mapped by the caller to the same kernel
 *     conflict errors SQLite raises (create_conflict / stale_prev /
 *     path_taken). Caller supplies context; this module just detects.
 *   - 2201B invalid_regular_expression → filter_invalid.
 *   - 40001 / 40P01 serialization_failure / deadlock_detected → retried
 *     with backoff and, on exhaustion, rethrown.
 *
 * Anything else propagates unchanged.
 */

export type PgError = { code?: string; message?: string; constraint?: string };

export function isUniqueViolation(err: unknown): err is PgError {
  return isPgErr(err) && err.code === "23505";
}

export function isRegexInvalid(err: unknown): err is PgError {
  return isPgErr(err) && err.code === "2201B";
}

export function isSerializationRetryable(err: unknown): err is PgError {
  return isPgErr(err) && (err.code === "40001" || err.code === "40P01");
}

function isPgErr(err: unknown): err is PgError {
  return typeof err === "object" && err !== null && "code" in err;
}
