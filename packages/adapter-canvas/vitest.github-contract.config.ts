import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/github-contract/*.live.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 60_000,
    retry: 0
  }
});
