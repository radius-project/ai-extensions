import type { DeploymentState } from "./types.js";
import { deploymentHandoffStatus } from "../repair/index.js";

export type DeploymentObservation = ReturnType<typeof observeDeployment>;

export function observeDeployment(state: DeploymentState = {}, since?: number) {
  const logs = state.deployLogs || [];
  const logBase = state.deployLogBase || 0;
  const status = state.deployStatus || "pending";
  return {
    resources: state.deployingResources || state.plannedResources || [],
    ...(since !== undefined && Number.isFinite(since) ?
      { logsNew: logs.slice(Math.max(0, since - logBase)) }
    : { logs }),
    logBase,
    logTotal: logBase + logs.length,
    status,
    error: state.deployError || null,
    errorKind: state.deployErrorKind || null,
    errorBranch: state.deployErrorBranch || null,
    errorPaths: state.deployErrorPaths || null,
    startedAt: state.deployStartedAt || null,
    finishedAt: state.deployFinishedAt || null,
    deployedGraph: state.deployedGraph || null,
    deployRunUrl: state.deployRunUrl || null,
    attempt: state.deployAttempt || null,
    active: status === "in_progress",
    repairing: state.deployRepairing || false,
    handoff: deploymentHandoffStatus(state)
  };
}
