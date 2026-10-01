import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "test/ci/**/*.test.mjs",
      "test/ci/**/*.test.ts",
      "test/e2e/support/**/*.test.ts",
      "test/support/**/*.test.ts",
      "test/e2e-cloud/**/*.test.ts",
      "test/integration/runtime/**/*.test.ts",
      "test/integration/http/**/*.test.ts"
    ],
    environment: "node",
    // Tests script distinct graphs for identical models; a machine-local
    // compiled-graph cache would answer them from an earlier test.
    env: { RADIUS_GRAPH_CACHE_DIR: "off" },
    testTimeout: 15_000
  }
});
