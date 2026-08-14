import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    passWithNoTests: true,
    globals: false,
    reporters: ["default"],
    // CI runners are 3-4× slower than local dev. The CLI end-to-end tests
    // (test/cli*.test.ts, test/build-artifact.test.ts) spawn tsx multiple
    // times per case — each subprocess is ~500ms — so the default 5s
    // per-test timeout is too tight. 30s gives headroom without letting
    // a truly hung test hide.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/index.ts"],
    },
  },
});
