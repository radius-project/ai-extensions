import {
  createDeploymentRuntime,
  normalizeDeploymentAppFile,
  type DeploymentRuntimePorts
} from "@radius-project/adapter-shared";
import {
  deploymentStatusBlocksMutation,
  redactCredentials
} from "@radius-project/core";

function unexpected(): never {
  throw new Error("Unexpected deployment execution boundary");
}

export function createTestDeploymentRuntime(
  ports: Partial<DeploymentRuntimePorts> = {}
) {
  let sequence = 0;
  return createDeploymentRuntime({
    awsEnabled: false,
    now: () => 1,
    id: () => `deployment-${++sequence}`,
    reportError: unexpected,
    resolveDefaultBranch: unexpected,
    resolveDeployment: unexpected,
    normalizeAppFile: normalizeDeploymentAppFile,
    statusBlocksMutation: deploymentStatusBlocksMutation,
    createExecution: unexpected,
    delivery: {
      redactDiagnostic: redactCredentials,
      reportDiagnostic: unexpected
    },
    ...ports
  });
}
