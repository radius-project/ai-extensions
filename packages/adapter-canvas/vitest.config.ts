import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "test/ci/**/*.test.mjs",
      "test/integration/runtime/**/*.test.ts"
    ],
    environment: "node",
    testTimeout: 15_000
  }
});
