import { defineConfig } from "vitest/config";

// Integration ("session") tests. These are deliberately NON-ISOLATED in
// spirit: each *.itest.ts case seeds a real fixture corpus and walks it like
// an interactive session, with ordered steps. A session owns its own throwaway
// db (support.ts), so files can't leak into one another — but within a file the
// steps depend on order, so we run serially and never in parallel. Kept out of
// the default `npm test` (unit) run; invoke via `npm run test:integration`.
export default defineConfig({
  test: {
    include: ["test/integration/**/*.itest.ts"],
    globals: false,
    reporters: ["default"],
    // Seeding walks the fixture tree and backfills the link index per session;
    // comfortably under a second, but give headroom on slow CI runners.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Non-isolated by design: one worker, no concurrent files or cases.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
