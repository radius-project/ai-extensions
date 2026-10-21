import {
  createProductionCanvasServerRuntime,
  type ProductionCanvasServerRuntimeOptions
} from "../../../src/server.js";
import { createProductionGitHubAccountContext } from "../../../src/runtime/production-github-account-context.js";
import { createProductionDeploymentExecutionOwner } from "../../../src/runtime/production-deployment-execution-owner.js";

export function createTestCanvasServerRuntime(
  options: Omit<
    ProductionCanvasServerRuntimeOptions,
    "accountContext" | "deploymentOwner" | "deploymentAccount"
  > &
    Partial<
      Pick<
        ProductionCanvasServerRuntimeOptions,
        "accountContext" | "deploymentOwner" | "deploymentAccount"
      >
    >
) {
  return createProductionCanvasServerRuntime({
    ...options,
    accountContext:
      options.accountContext ?? createProductionGitHubAccountContext(),
    deploymentOwner:
      options.deploymentOwner ?? createProductionDeploymentExecutionOwner(),
    deploymentAccount:
      options.deploymentAccount ??
      (async () => {
        throw new Error("Deployment account selection was not scripted.");
      }),
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
