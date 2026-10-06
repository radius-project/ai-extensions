import { defineConfig } from "vitest/config";

// These checks run the repository's own toolchain (a nested Vitest discovery
// and the ESLint boundary configuration) instead of product code. Each needs
// about a second alone but becomes CPU-starved when it shares the machine with
// a full worker pool whose tests also spawn processes. Group order 1 runs them
// after every default-group project finishes, so the pool cannot starve them.
export const TOOLCHAIN_CHECKS = [
  "test/ci/graph-test-discovery.test.mjs",
  "test/ci/workflow-boundaries.test.ts"
];

export default defineConfig({
  test: {
    name: "adapter-canvas-toolchain",
    include: TOOLCHAIN_CHECKS,
    environment: "node",
    testTimeout: 15_000,
    sequence: { groupOrder: 1 }
  }
});
