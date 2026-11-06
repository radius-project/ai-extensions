import {
  createDeploymentRuntime,
  type DeploymentRuntimePorts
} from "@radius-project/adapter-shared";
import { redactCredentials } from "@radius-project/core";

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
    normalizeAppFile: (value) => value,
    statusBlocksMutation: (status) =>
      status === "deploying" || status === "deleting" || status === "running",
    createExecution: unexpected,
    delivery: {
      redactDiagnostic: redactCredentials,
      reportDiagnostic: unexpected
    },
    ...ports
  });
}
