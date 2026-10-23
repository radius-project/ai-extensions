import type { GitHubAccountCoordinator } from "../server/services/github-account-coordinator.js";
import {
  createGitHubAccountReadinessService,
  type GitHubAccountReadinessServiceOptions
} from "../server/services/github-account-readiness.js";
import {
  createDeploymentAccountResolver,
  type DeploymentAccountPorts
} from "./deployment-account.js";
import { createDeploymentAccountEligibility } from "./deployment-account-eligibility.js";
import { createSetupAccountEligibility } from "./setup-account-eligibility.js";

export function createGitHubAccountResolvers(
  ports: Pick<
    DeploymentAccountPorts,
    "readIdentity" | "choose" | "redactDiagnostic"
  > & {
    coordinator: GitHubAccountCoordinator;
    ownerKey: string;
    readinessOptions?: GitHubAccountReadinessServiceOptions;
  }
) {
  const shared = {
    readIdentity: ports.readIdentity,
    createExecutor: (login: string) =>
      ports.coordinator.createReadOnlyExecutor(login),
    redactDiagnostic: ports.redactDiagnostic
  };
  return {
    setup: createDeploymentAccountResolver({
      ...shared,
      get choose() {
        return ports.choose;
      },
      check: createSetupAccountEligibility(
        createGitHubAccountReadinessService(ports.coordinator, {
          ...ports.readinessOptions,
          ownerKey: ports.ownerKey
        })
      )
    }),
    deployment: createDeploymentAccountResolver({
      ...shared,
      get choose() {
        return ports.choose;
      },
      check: createDeploymentAccountEligibility(shared)
    })
  };
}
