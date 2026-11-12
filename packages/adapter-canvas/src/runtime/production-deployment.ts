import { randomUUID } from "node:crypto";
import {
  createProductionDeploymentRuntime as createSharedDeploymentRuntime,
  type ProductionDeploymentPorts
} from "@radius-project/adapter-shared";
import {
  cliExec,
  ghCommandCredentialSource,
  redactGhCredentials
} from "../gh.js";
import { resolveGhCommandPresentation } from "../gh-command-resolution.js";
import { createDeploymentDelivery } from "../server/services/deployment-delivery.js";

export function createProductionDeploymentRuntime(options: {
  awsEnabled: boolean;
  delivery?: ProductionDeploymentPorts["delivery"];
}) {
  const delivery = createDeploymentDelivery(options.delivery);
  const runtime = createSharedDeploymentRuntime({
    awsEnabled: options.awsEnabled,
    execute: cliExec,
    ghCommandPresentation: resolveGhCommandPresentation(),
    readProcessEnv: () => process.env,
    ghCredentialSource: ghCommandCredentialSource,
    redactDiagnostic: redactGhCredentials,
    reportDiagnostic: (message) => console.error(message),
    now: () => Date.now(),
    id: randomUUID,
    sleep: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    delivery: delivery.ports
  });
  return {
    ...runtime,
    setDeployRepairHandoff: delivery.setDeployRepairHandoff,
    setDeployFailureNotice: delivery.setDeployFailureNotice
  };
}
