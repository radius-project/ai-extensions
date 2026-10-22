import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/deploy-artifacts.test.ts",
      "../core/src/deploy-artifact-evidence.test.ts",
      "../core/src/workflow-read-policy.test.ts",
      "../core/src/setup-{admission,boundary,provider-configuration}.test.ts",
      "../core/src/setup-{coordinator,github-environment*}.test.ts",
      "src/server/services/environment-operation.test.ts",
      "src/server/services/{azure-setup,configure-environment,setup-outcome}.test.ts",
      "src/server/routes/{azure-auto-setup,setup-http-failure}.test.ts",
      "../core/src/setup-azure-{application,credentials,service-principal}.test.ts",
      "../core/src/setup-{environment*,github-preflight,workflow*,verification-*}.test.ts",
      "../adapter-shared/src/{ghcr-bootstrap,setup-workflow-content}.test.ts",
      "src/server/routes/setup-environment*.test.ts",
      "src/server/routes/create-environment-workflow-committer.test.ts",
      "src/server/services/setup-workflow-recovery.test.ts",
      "src/server/routes/azure-auto-setup-application.test.ts",
      "src/server/routes/create-environment-refusals.test.ts",
      "src/server/routes/azure-auto-setup-credentials.test.ts",
      "src/server/services/{setup-checkpoint,operation-stop-boundary}.test.ts",
      "../adapter-shared/src/workflow-artifacts*.test.ts",
      "../adapter-shared/src/workflow-read*.test.ts",
      "../adapter-shared/src/rad.test.ts",
      "../adapter-shared/src/workflow-run-response.test.ts",
      "../adapter-shared/src/workflow-observation.test.ts",
      "src/deploy.test.ts",
      "src/gh*.test.ts",
      "src/workspace.test.ts",
      "src/server/create-canvas-server.test.ts",
      "src/runtime/environment-execution-owner.test.ts",
      "src/runtime/environment-account-context.test.ts",
      "src/server/services/github-account-{coordinator,readiness}.test.ts",
      "src/server-environment-execution.test.ts",
      "test/integration/runtime/environment-execution.test.ts",
      "src/server/services/discovery.test.ts",
      "src/server/services/workflow-observation-scope.test.ts",
      "src/server/services/deploy-{monitor,outcome,request}.test.ts",
      "test/integration/runtime/runtime-contracts.test.ts",
      "src/server/services/github-environment-variable-rollback.test.ts",
      "src/browser/{heartbeat,lifecycle,repositories}.test.ts",
      "src/browser/environment/**/*.test.ts",
      "src/browser/pages/**/*.test.ts",
      "src/browser/graph/**/*.test.ts",
      "test/ci/module-entry.test.mjs",
      "test/ci/plugins-script.test.mjs",
      "test/ci/release-version-script.test.mjs",
      "test/e2e-cloud/support/{cloud-command-port,cloud-fixture}.test.ts",
      "test/e2e-cloud/support/copilot-app-*.test.ts",
      "test/e2e/support/**/*.test.ts",
      "test/integration/http/**/*.test.ts",
      "test/integration/runtime/bicep-security-rules.test.ts"
    ],
    environment: "node",
    testTimeout: 15_000,
    projects: [
      {
        extends: true,
        test: {
          name: "canvas-reliability"
        }
      },
      "../graph-react/vitest.config.ts",
      "../graph-react/vitest.component.config.ts"
    ]
  }
});
