import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "test/integration/windows-process/**/*.test.ts"
    ],
    fileParallelism: false,
    environment: "node"
  }
});
