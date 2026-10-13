import {
  createProductionCanvasServerRuntime,
  type ProductionCanvasServerRuntimeOptions
} from "../../../src/server.js";

export function createTestCanvasServerRuntime(
  options: ProductionCanvasServerRuntimeOptions
) {
  return createProductionCanvasServerRuntime({
    ...options,
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
