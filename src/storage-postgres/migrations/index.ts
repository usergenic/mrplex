/**
 * Postgres migration loader — forward-only, idempotent (m5-plan WS4).
 *
 * Progress is tracked in a `schema_migrations` table. An advisory
 * transactional lock (pg_advisory_xact_lock) serializes concurrent
 * migrate() invocations from parallel processes so at most one worker
 * applies a given migration.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";

const MIGRATIONS_DIR = dirname(fileURLToPath(import.meta.url));

// Arbitrary application-defined lock id — collision-free within mrplex.
const MIGRATION_LOCK_ID = 0x6d7250_6c6578n; // "mrPlex" in hex bytes.

type Migration = { version: number; name: string; sql: string };

function loadMigrations(): Migration[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files.map((name) => {
    const match = name.match(/^(\d+)_.+\.sql$/);
    if (!match || !match[1]) {
      throw new Error(`migration file "${name}" must match <NNNN>_<name>.sql`);
    }
    const version = Number.parseInt(match[1], 10);
    const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
    return { version, name, sql };
  });
}

/**
 * Apply pending migrations to the database on the given client.
 *
 * **Precondition:** the caller must pass a client that is **not** inside
 * an active transaction — migrate() opens its own `begin` and holds a
 * `pg_advisory_xact_lock` for the duration. A client already in a tx
 * either raises `25001 active_sql_transaction` here (server default) or
 * silently rolls the migration into the outer tx (breaking the
 * advisory-lock scope). The adapter's `open()` satisfies this by
 * acquiring a fresh pool client and calling migrate() on it before
 * anything else runs.
 */
export async function migrate(client: PoolClient): Promise<void> {
  const migrations = loadMigrations();
  // The lock lives for the transaction; multi-instance safety.
  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(
      `create table if not exists schema_migrations (
         version integer primary key,
         name    text    not null,
         applied_at timestamptz not null default now()
       )`,
    );
    const applied = await client.query<{ version: number }>(
      "select version from schema_migrations",
    );
    const seen = new Set(applied.rows.map((r) => r.version));
    for (const m of migrations) {
      if (seen.has(m.version)) continue;
      await client.query(m.sql);
      await client.query("insert into schema_migrations(version, name) values ($1, $2)", [
        m.version,
        m.name,
      ]);
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
}
