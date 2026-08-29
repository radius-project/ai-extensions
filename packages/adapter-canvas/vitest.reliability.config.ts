import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/deploy-artifacts.test.ts",
      "src/gh*.test.ts",
      "src/workspace.test.ts",
      "src/server/create-canvas-server.test.ts",
      "src/server/services/discovery.test.ts",
      "src/server/services/github-environment-variable-rollback.test.ts",
      "src/browser/{heartbeat,lifecycle,repositories}.test.ts",
      "src/browser/environment/**/*.test.ts",
      "src/browser/pages/**/*.test.ts",
      "src/browser/graph/**/*.test.ts",
      "test/e2e/support/**/*.test.ts",
      "test/integration/http/**/*.test.ts"
    ],
    environment: "node",
    testTimeout: 15_000
  }
});
