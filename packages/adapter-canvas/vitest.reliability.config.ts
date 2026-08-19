import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/deploy-artifacts.test.ts",
      "src/gh.test.ts",
      "src/gh.posix.test.ts",
      "src/gh.windows.test.ts",
      "src/workspace.test.ts",
      "src/browser/deploying/page.test.ts",
      "src/browser/environment/environments.test.ts",
      "test/e2e/support/canvas-harness.test.ts",
      "test/integration/runtime/runtime-contracts.test.ts",
      "test/integration/http/azure-discovery.test.ts",
      "test/integration/http/deployments.test.ts",
      "test/integration/http/server-scaffolding.test.ts"
    ],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 15_000
  }
});
