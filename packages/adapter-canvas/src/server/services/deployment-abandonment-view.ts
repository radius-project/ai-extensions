import type {
  DeploymentInvocation,
  DeploymentRuntime
} from "@radius-project/adapter-shared";
import type { DeploymentState } from "@radius-project/core";
import type { DeploymentAbandonmentService } from "./deployment-abandonment.js";

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
          typeof payload.environment === "string"
        ) ?
          { repo: payload.repo.trim(), environment: payload.environment.trim() }
        : undefined;
      const selected =
        target?.repo && target.environment ?
          dependencies.owner.lookupTarget(target)
        : undefined;
      const result = await dependencies.service.abandon(input);
      if (result.status === 200 && selected?.kind === "found")
        dependencies.retire(selected.invocation);
      return result;
    }
  };
}
