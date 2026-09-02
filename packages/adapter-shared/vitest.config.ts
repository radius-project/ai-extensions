import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "test/integration/windows-process/**/*.test.ts"
    ],
    // Windows suites spawn managed rad processes through compiled launchers that
    // are build output rather than committed files.
    globalSetup: ["test/support/ensure-windows-launchers.ts"],
    fileParallelism: process.platform === "win32" ? false : true,
    environment: "node"
  }
});
