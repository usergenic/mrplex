import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

const MIGRATIONS_DIR = dirname(fileURLToPath(import.meta.url));

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
 * Apply pending migrations. Idempotent and forward-only (design §7.2.2).
 * Progress is tracked via `PRAGMA user_version`.
 */
export function migrate(db: Database.Database): void {
  const migrations = loadMigrations();
  const currentRow = db.pragma("user_version", { simple: true }) as number;
  for (const m of migrations) {
    if (m.version <= currentRow) continue;
    db.exec("begin");
    try {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
      db.exec("commit");
    } catch (err) {
      db.exec("rollback");
      throw new Error(`migration ${m.name} failed: ${(err as Error).message}`);
    }
  }
}
