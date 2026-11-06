import type {
  DeploymentInvocation,
  DeploymentRuntime
} from "@radius-project/adapter-shared";
import type { DeploymentState } from "@radius-project/core";
import type { DeploymentAbandonmentService } from "./deployment-abandonment.js";
import { matchesDeployedApplicationState } from "./deployed-view-state.js";

/** Retire captured local evidence only after the existing remote guards succeed. */
export function createDeploymentAbandonmentViewService(dependencies: {
  service: DeploymentAbandonmentService;
  owner: Pick<DeploymentRuntime["owner"], "lookupTarget">;
  retire(invocation: DeploymentInvocation<DeploymentState>): boolean;
}): DeploymentAbandonmentService {
  return {
    async abandon(input) {
      const payload = input.payload;
      const target =
        (
          payload &&
          typeof payload === "object" &&
          !Array.isArray(payload) &&
          "repo" in payload &&
          typeof payload.repo === "string" &&
          "environment" in payload &&
          typeof payload.environment === "string" &&
          "application" in payload &&
          typeof payload.application === "string"
        ) ?
          {
            repo: payload.repo.trim(),
            environment: payload.environment.trim(),
            application: payload.application.trim()
          }
        : undefined;
      const selected =
        target?.repo && target.environment && target.application ?
          dependencies.owner.lookupTarget(target)
        : undefined;
      const invocation =
        (
          selected?.kind === "found" &&
          target &&
          matchesDeployedApplicationState(
            {
              deployEnvName: selected.invocation.target.environment,
              deployAppName: selected.invocation.state.deployAppName
            },
            target
          )
        ) ?
          selected.invocation
        : undefined;
      const application = invocation?.state.deployAppName;
      const result = await dependencies.service.abandon(input);
      if (
        result.status === 200 &&
        invocation &&
        invocation.state.deployAppName === application
      )
        dependencies.retire(invocation);
      return result;
    }
  };
}
