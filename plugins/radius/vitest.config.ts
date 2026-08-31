import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["skills/**/*.test.ts"],
    environment: "node",
    testTimeout: 5_000
  }
});
