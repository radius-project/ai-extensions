import {
  createProductionCanvasServerRuntime,
  type ProductionCanvasServerRuntimeOptions
} from "../../../src/server.js";
import { createProductionGitHubAccountContext } from "../../../src/runtime/production-github-account-context.js";

export function createTestCanvasServerRuntime(
  options: Omit<ProductionCanvasServerRuntimeOptions, "accountContext"> &
    Partial<Pick<ProductionCanvasServerRuntimeOptions, "accountContext">>
) {
  return createProductionCanvasServerRuntime({
    ...options,
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
