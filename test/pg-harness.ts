/**
 * Postgres test harness (m5-plan WS7).
 *
 * Reads `MRPLEX_TEST_POSTGRES_URL` (a `postgres://…` connection URL for
 * a database the test suite may create/drop schemas in). Callers should
 * gate `openTestPostgres` on the exported `PG_URL` — the function
 * throws when the env var is unset, so calling it unconditionally is a
 * loud error rather than a silent skip.
 *
 * Each caller gets a fresh throwaway schema `mrplex_test_<random>` and
 * a Storage backed by it. `search_path` is set on the pool so the
 * `vector` extension type resolves; the schema is dropped-cascade by
 * the returned `cleanup()`.
 */

import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { postgresAdapter } from "../src/storage-postgres/adapter.js";
import type { Storage } from "../src/storage/types.js";

export const PG_URL = process.env.MRPLEX_TEST_POSTGRES_URL ?? "";

/**
 * Open a Storage against a fresh schema. Returns the Storage plus a
 * cleanup function that drops the schema and closes the underlying
 * pool. If the env is set but the DB is unreachable, throws — the CI
 * job is meant to fail loudly rather than silently skip.
 */
export async function openTestPostgres(): Promise<{
  storage: Storage;
  schema: string;
  cleanup: () => Promise<void>;
}> {
  if (!PG_URL) throw new Error("MRPLEX_TEST_POSTGRES_URL not set");
  const schema = `mrplex_test_${randomBytes(6).toString("hex")}`;
  // Create the schema on a bare client first. Also ensure the vector
  // extension exists in `public` — a schema-per-test harness can't own
  // the extension, so we bootstrap it once at the shared level and rely
  // on search_path to resolve the type.
  const bootstrap = new Client({ connectionString: PG_URL });
  await bootstrap.connect();
  try {
    await bootstrap.query("create extension if not exists vector with schema public");
    await bootstrap.query(`create schema "${schema}"`);
  } finally {
    await bootstrap.end();
  }

  // Now build a Storage wrapper that scopes to that schema. The
  // PostgresStorage adapter accepts a plain url; we need to route its
  // pool's search_path. Simplest approach: append `?options=-c%20search_path=<schema>,public`
  // to the url so every new client gets the right search_path.
  const routedUrl = withSearchPath(PG_URL, schema);
  const storage = await postgresAdapter.open({ database: routedUrl });

  const cleanup = async () => {
    await storage.close();
    const teardown = new Client({ connectionString: PG_URL });
    await teardown.connect();
    try {
      await teardown.query(`drop schema "${schema}" cascade`);
    } finally {
      await teardown.end();
    }
  };
  return { storage, schema, cleanup };
}

function withSearchPath(url: string, schema: string): string {
  const optionsValue = `-c search_path=${schema},public`;
  const encoded = encodeURIComponent(optionsValue);
  return url.includes("?") ? `${url}&options=${encoded}` : `${url}?options=${encoded}`;
}
