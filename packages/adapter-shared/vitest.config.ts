import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "test/integration/windows-process/**/*.test.ts"
    ],
    fileParallelism: process.platform === "win32" ? false : true,
    environment: "node"
  }
});
