import {
  createProductionCanvasServerRuntime,
  type ProductionCanvasServerRuntimeOptions
} from "../../../src/server.js";
import { createProductionGitHubAccountContext } from "../../../src/runtime/production-github-account-context.js";
import { createTestDeploymentRuntime } from "./deployment-runtime.js";

export function createTestCanvasServerRuntime(
  options: Omit<
    ProductionCanvasServerRuntimeOptions,
    "accountContext" | "awsEnabled" | "deploymentRuntime"
  > &
    Partial<
      Pick<
        ProductionCanvasServerRuntimeOptions,
        "accountContext" | "awsEnabled" | "deploymentRuntime"
      >
    >
) {
  return createProductionCanvasServerRuntime({
    ...options,
    // Tests see what users see unless they turn the AWS switch on.
    awsEnabled: options.awsEnabled ?? false,
    deploymentRuntime:
      options.deploymentRuntime ?? createTestDeploymentRuntime(),
    accountContext:
      options.accountContext ?? createProductionGitHubAccountContext(),
    get environmentOperationRunner() {
      return options.environmentOperationRunner;
    },
    serverDependencies: {
      preferredPort: async () => 0,
      prepareIdentity: () => {},
      ...options.serverDependencies
    }
  });
}
