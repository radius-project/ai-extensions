import type { SelectedGhExecutor } from "../gh.js";
import type { GitHubAccountCoordinator } from "../server/services/github-account-coordinator.js";

export function createEnvironmentAccountContext(
  ownerKey: string,
  coordinator: GitHubAccountCoordinator
) {
  const executors = new Map<string, { executor: SelectedGhExecutor }>();
  return {
    ownerKey,
    coordinator,
    getExecutor: (operationId: string) => executors.get(operationId)?.executor,
    registerExecutor(
      operationId: string,
      executor: SelectedGhExecutor
    ): () => void {
      const registration = { executor };
      executors.set(operationId, registration);
      return () => {
        if (executors.get(operationId) === registration) {
          executors.delete(operationId);
        }
      };
    }
  };
}

export type EnvironmentAccountContext = ReturnType<
  typeof createEnvironmentAccountContext
>;
