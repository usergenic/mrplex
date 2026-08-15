/**
 * Postgres adapter parity — runs the shared kernel suite against a
 * live pgvector-enabled database when MRPLEX_TEST_POSTGRES_URL is set.
 * Silently skips otherwise so `npm test` on macOS-without-Docker stays
 * the same shape.
 */

import { describe } from "vitest";
import { runKernelSuite } from "./kernel-suite.js";
import { PG_URL, openTestPostgres } from "./pg-harness.js";

if (PG_URL) {
  const factories: {
    storage: Awaited<ReturnType<typeof openTestPostgres>>["storage"] | null;
    cleanup: (() => Promise<void>) | null;
  }[] = [];

  runKernelSuite({
    name: "postgres",
    open: async () => {
      const h = await openTestPostgres();
      factories.push({ storage: h.storage, cleanup: h.cleanup });
      return h.storage;
    },
  });
} else {
  describe.skip("kernel [postgres]", () => {
    // Skipped: MRPLEX_TEST_POSTGRES_URL not set.
  });
}
