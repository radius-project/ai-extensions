import {
  createDeployMonitorService as createSharedMonitor,
  type DeployMonitorDependencies,
  type DeployMonitorRequest as SharedMonitorRequest
} from "@radius-project/adapter-shared";

export type DeployMonitorRequest = Omit<SharedMonitorRequest, "appFile"> & {
  appFile?: string;
};

export interface DeployMonitorService {
  run(request: DeployMonitorRequest): Promise<void>;
}

export function createDeployMonitorService(
  dependencies: DeployMonitorDependencies
): DeployMonitorService {
  const monitor = createSharedMonitor(dependencies);
  return {
    run: (request) =>
      monitor.run({
        ...request,
        appFile: request.appFile ?? ".radius/app.bicep"
      })
  };
}

export {
  type DeployMonitorInstanceEntry,
  type DeployRunDetail,
  type DeployMonitorStatusReader,
  type DeployResourceStatus,
  type DeployStatusChange,
  type DeployMonitorDependencies
} from "@radius-project/adapter-shared";
