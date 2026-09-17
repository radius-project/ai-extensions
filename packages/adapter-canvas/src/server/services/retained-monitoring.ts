import type { CanvasState } from "../../shared.js";

export function retainedMonitoring(
  state: CanvasState | undefined,
  target: { repo: string; environment: string; application: string },
  reason: string
) {
  if (
    reason !== "RESULT_UNAVAILABLE" ||
    state?.deployStatus !== "failed" ||
    state.deployErrorKind !== "run-unconfirmed" ||
    typeof state.deployRunId !== "number" ||
    !Number.isSafeInteger(state.deployRunId) ||
    state.deployRunId <= 0 ||
    !target.repo ||
    !target.environment ||
    !target.application ||
    state.deployingRepo?.toLowerCase() !== target.repo.toLowerCase() ||
    state.deployEnvName?.toLowerCase() !== target.environment.toLowerCase() ||
    state.deployAppName?.toLowerCase() !== target.application.toLowerCase()
  )
    return undefined;
  const resources = (state.deployingResources ?? [])
    .filter(
      (resource) =>
        typeof resource.id === "string" &&
        resource.id.length > 0 &&
        (resource.deployStatus === "failed" ||
          resource.deployStatus === "success")
    )
    .map((resource) => ({
      id: resource.id,
      name: resource.name,
      type: resource.type,
      codeReference: resource.codeReference,
      deployStatus: resource.deployStatus,
      deployMessage: resource.deployMessage
    }));
  if (!resources.length) return undefined;
  return { ...target, runId: state.deployRunId, resources };
}
