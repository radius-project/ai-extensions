import {
  createDeployMonitorService as createSharedMonitor,
  type DeployMonitorDependencies,
  type DeployMonitorRequest as SharedMonitorRequest
} from "@radius-project/adapter-shared";

export type DeployMonitorRequest = SharedMonitorRequest;

export interface DeployMonitorService {
  run(request: DeployMonitorRequest): Promise<void>;
}

export function createDeployMonitorService(
  dependencies: DeployMonitorDependencies
): DeployMonitorService {
  return createSharedMonitor(dependencies);
}

export {
  type DeployMonitorInstanceEntry,
  type DeployRunDetail,
  type DeployMonitorStatusReader,
  type DeployResourceStatus,
  type DeployStatusChange,
  type DeployMonitorDependencies
} from "@radius-project/adapter-shared";
