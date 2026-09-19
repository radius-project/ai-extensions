import {
  createDeployMonitorService as createSharedMonitor,
  type DeployMonitorDependencies as SharedDependencies
} from "@radius-project/core/github-radius/deployments/deploy-monitor";
import { redactGhCredentials } from "../../gh.js";

export * from "@radius-project/core/github-radius/deployments/deploy-monitor";
export type DeployMonitorDependencies = Omit<
  SharedDependencies,
  "redactDiagnostics"
>;
export function createDeployMonitorService(
  dependencies: DeployMonitorDependencies
) {
  return createSharedMonitor({
    ...dependencies,
    redactDiagnostics: redactGhCredentials
  });
}
