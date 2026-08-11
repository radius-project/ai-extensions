import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/integration/artifact/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000
  }
});
