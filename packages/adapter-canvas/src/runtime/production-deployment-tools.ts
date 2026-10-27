import type { DeploymentAccountResolver } from "./deployment-account.js";
import { createDirectDeploymentTools } from "./direct-deployment-tools.js";
import { createDeploymentNotifications } from "./deployment-notifications.js";
import { createProductionDeploymentController } from "./production-deployment-controller.js";
import {
  createProductionDeploymentMonitor,
  type ProductionDeploymentMonitorPorts
} from "./production-deployment-monitor.js";
import {
  deployFailureNoticeMessage,
  deployRepairHandoffMessage
} from "./hooks.js";
import type { SessionHolder } from "./session.js";

export interface ProductionDeploymentToolsPorts extends ProductionDeploymentMonitorPorts {
  account: DeploymentAccountResolver;
  session: SessionHolder;
  radiusAppBicepSkill(repoPath?: string, brief?: string): string;
  reportError(error: unknown): void;
  redactDiagnostic(value: string): string;
}

export function createProductionDeploymentTools(
  ports: ProductionDeploymentToolsPorts
) {
  const controller = createProductionDeploymentController({
    owner: ports.owner,
    account: ports.account,
    reportError: ports.reportError,
    monitorFor: (execution) =>
      createProductionDeploymentMonitor(execution, ports)
  });
  const notify = createDeploymentNotifications({
    owner: ports.owner,
    repair: ({ repo, branch, appFile, error, deployRunUrl, attemptId }) =>
      ports.session.get().send(
        deployRepairHandoffMessage(repo, branch, {
          error,
          deployRunUrl,
          appFile,
          skillBootstrap:
            appFile && appFile !== ".radius/app.bicep" ?
              ports.radiusAppBicepSkill(
                undefined,
                `Repair only the admitted existing file ${JSON.stringify(appFile)}. Do not regenerate a deployment profile.`
              )
            : undefined,
          attemptId
        })
      ),
    notice: ({ repo, branch, error, deployRunUrl, dispatchRefused }) =>
      ports.session.get().send(
        deployFailureNoticeMessage(repo, branch, {
          error,
          deployRunUrl,
          dispatchRefused
        })
      ),
    reportError: ports.reportError
  });
  return createDirectDeploymentTools({
    owner: ports.owner,
    controller,
    notifications: [notify],
    reportError: ports.reportError,
    redactDiagnostic: ports.redactDiagnostic
  });
}
