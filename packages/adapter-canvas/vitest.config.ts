import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "test/ci/**/*.test.mjs",
      "test/ci/**/*.test.ts",
      "test/e2e/support/**/*.test.ts",
      "test/e2e-cloud/**/*.test.ts",
      "test/integration/runtime/**/*.test.ts",
      "test/integration/http/**/*.test.ts"
    ],
    environment: "node",
    testTimeout: 15_000
  }
});
