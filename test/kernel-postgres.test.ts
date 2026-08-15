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
  runKernelSuite({
    name: "postgres",
    // Each test gets a fresh schema; teardown drops it (with cascade)
    // so long-running runs don't leave orphan mrplex_test_* schemas
    // behind in the shared database.
    open: async () => {
      const h = await openTestPostgres();
      return { storage: h.storage, teardown: h.cleanup };
    },
  });
} else {
  describe.skip("kernel [postgres]", () => {
    // Skipped: MRPLEX_TEST_POSTGRES_URL not set.
  });
}
