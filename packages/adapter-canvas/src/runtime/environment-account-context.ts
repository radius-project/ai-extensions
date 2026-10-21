import type { SelectedGhExecutor } from "../gh.js";
import type { GitHubAccountCoordinator } from "../server/services/github-account-coordinator.js";

export function createEnvironmentAccountContext(
  ownerKey: string,
  coordinator: GitHubAccountCoordinator
) {
  const executors = new Map<string, SelectedGhExecutor>();
  return {
    ownerKey,
    coordinator,
    getExecutor: (operationId: string) => executors.get(operationId),
    registerExecutor(operationId: string, executor: SelectedGhExecutor): void {
      executors.set(operationId, executor);
    },
    unregisterExecutor(operationId: string): void {
      // Preserve operation-ID cleanup; identity-fenced release is a separate fix.
      executors.delete(operationId);
    }
  };
}

export type EnvironmentAccountContext = ReturnType<
  typeof createEnvironmentAccountContext
>;
