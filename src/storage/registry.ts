/**
 * Storage scheme registry (m5-plan WS6).
 *
 * Single source of truth for "database url → open Storage". Callers pass
 * a raw url (possibly a bare path) and get back a live Storage. The
 * SQLite and Postgres adapters register their schemes here; adding a
 * third is a one-liner.
 */

import { postgresAdapter } from "../storage-postgres/adapter.js";
import { sqliteAdapter } from "../storage-sqlite/adapter.js";
import type { Storage, StorageAdapter } from "./types.js";

const ADAPTERS: readonly StorageAdapter[] = [sqliteAdapter, postgresAdapter];

/**
 * Normalize a `--database` value. A bare path is treated as SQLite for
 * ergonomics; a scheme (`sqlite:`, `postgres:`, `postgresql:`) passes
 * through unchanged.
 */
export function normalizeDatabaseUrl(url: string): string {
  if (
    url.startsWith("sqlite:") ||
    url.startsWith("postgres:") ||
    url.startsWith("postgresql:")
  ) {
    return url;
  }
  return `sqlite:${url}`;
}

/**
 * Open storage by url. Dispatches on the scheme and delegates to the
 * matching adapter. Throws on unknown scheme.
 */
export async function openStorage(url: string): Promise<Storage> {
  const normalized = normalizeDatabaseUrl(url);
  const scheme = normalized.split(":", 1)[0] ?? "";
  // postgresql: is an alias for postgres:
  const canonical = scheme === "postgresql" ? "postgres" : scheme;
  const adapter = ADAPTERS.find((a) => a.scheme === canonical);
  if (!adapter) {
    throw new Error(`unknown database scheme: ${scheme}`);
  }
  return adapter.open({ database: normalized });
}
