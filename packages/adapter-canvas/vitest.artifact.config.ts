import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/integration/artifact/**/*.test.ts"],
    environment: "node",
    // Tests script distinct graphs for identical models; a machine-local
    // compiled-graph cache would answer them from an earlier test.
    env: { RADIUS_GRAPH_CACHE_DIR: "off" },
    testTimeout: 30_000
  }
});
