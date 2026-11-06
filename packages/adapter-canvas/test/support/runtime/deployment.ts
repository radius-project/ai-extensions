import {
  createDeploymentRuntime,
  type DeploymentRuntimePorts
} from "@radius-project/adapter-shared";
import { toSafeRepoRelPath } from "../../../src/workspace.js";

export function createFakeDeploymentRuntime(
  overrides: Partial<DeploymentRuntimePorts> = {}
) {
  let id = 0;
  return createDeploymentRuntime({
    now: Date.now,
    id: () => String(++id),
    reportError: (error) => {
      throw error;
    },
    awsEnabled: false,
    normalizeAppFile: toSafeRepoRelPath,
    resolveDefaultBranch: async () => {
      throw new Error("Deployment branch lookup was not scripted.");
    },
    resolveDeployment: async () => {
      throw new Error("Deployment lookup was not scripted.");
    },
    statusBlocksMutation: (status) =>
      status === "pending" || status === "deleting",
    createExecution: () => {
      throw new Error("Deployment execution was not scripted.");
    },
    delivery: {
      redactDiagnostic: (value) => value,
      reportDiagnostic: (message) => {
        throw new Error(message);
      }
    },
    ...overrides
  });
}
