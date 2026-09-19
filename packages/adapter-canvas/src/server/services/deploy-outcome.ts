import {
  createDeployOutcomeService as createSharedOutcome,
  type DeployOutcomeDependencies as SharedDependencies
} from "@radius-project/core/github-radius/deployments/deploy-outcome";
import { redactGhCredentials } from "../../gh.js";

export * from "@radius-project/core/github-radius/deployments/deploy-outcome";
export type DeployOutcomeDependencies = Omit<
  SharedDependencies,
  "redactDiagnostics"
>;
export function createDeployOutcomeService(
  dependencies: DeployOutcomeDependencies
) {
  return createSharedOutcome({
    ...dependencies,
    redactDiagnostics: redactGhCredentials
  });
}
