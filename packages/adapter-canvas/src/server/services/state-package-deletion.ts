import type { GhPackageCredentials } from "../../gh.js";
import type { DeleteGhcrOptions, DeleteGhcrOutcome } from "../../ghcr.js";
import type { GhCommandPresentation } from "../../gh-command-display.js";

export interface StatePackageDeletionInput {
  repo: string;
  environment: string;
}

export interface StatePackageDeletionDependencies {
  stateRegistryForEnvironment(repo: string, environment: string): string;
  getCredentials(options: { fresh: true }): Promise<GhPackageCredentials>;
  deletePackage(options: DeleteGhcrOptions): Promise<DeleteGhcrOutcome>;
  ghCommandPresentation: GhCommandPresentation;
}

export function createStatePackageDeletion(
  dependencies: StatePackageDeletionDependencies
): (input: StatePackageDeletionInput) => Promise<DeleteGhcrOutcome["outcome"]> {
  return async ({ repo, environment }) => {
    const registry = dependencies.stateRegistryForEnvironment(
      repo,
      environment
    );
    const credentials = await dependencies.getCredentials({ fresh: true });
    const outcome = await dependencies.deletePackage({
      targetRepository: repo,
      registry,
      credentials,
      ghCommandPresentation: dependencies.ghCommandPresentation
    });
    return outcome.outcome;
  };
}
