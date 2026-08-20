/**
 * Postgres SQLSTATE → kernel error mapping (m5-plan WS4).
 *
 * The adapter surfaces:
 *   - 23505 unique_violation on a versions partial-unique index →
 *     retryable at the tx layer. Under REPEATABLE READ two concurrent
 *     kernel calls can both pass the app-level pre-check
 *     (create_conflict / stale_prev / path_taken) and race to insert;
 *     one wins, the other hits 23505 on the partial index. Re-running
 *     the tx makes the losing caller's pre-check hit the fresh state
 *     and raise the right KernelError. See adapter.ts `tx()`.
 *   - 2201B invalid_regular_expression → filter_invalid (compile-time
 *     regex from CEL matches()).
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

/**
 * The two partial unique indexes we care about — from
 * migrations/0001_init.sql. Version_insert catches 23505 on either
 * and marks the error retryable; the retried tx's app-level check
 * produces the correct KernelError.
 */
export const VERSION_UNIQUE_CONSTRAINTS = new Set<string>([
  "versions_document_current_uidx",
  "versions_repo_path_current_uidx",
  // Case-insensitive path twin (§3.5.1, 0002_casefold.sql) — a concurrent
  // case-collision races here; the retried tx's folded pre-check raises
  // path_taken / create_conflict.
  "versions_repo_pathnorm_current_uidx",
]);

export function isVersionRaceViolation(err: unknown): boolean {
  if (!isUniqueViolation(err)) return false;
  return err.constraint !== undefined && VERSION_UNIQUE_CONSTRAINTS.has(err.constraint);
}

function isPgErr(err: unknown): err is PgError {
  return typeof err === "object" && err !== null && "code" in err;
}
