import {
  DEPLOY_REPAIR_ATTEMPT_CAP,
  resolveDeploymentRepairLoop
} from "@radius-project/core";
import { canvasGraphResources } from "../canvas-graph-resources.js";
import { resolveEnvironmentDeployment } from "../server/services/deployment-resolver.js";
import { createDeploymentReservationBindings } from "../server/services/deployment-reservations.js";
import {
  createDeploymentController,
  type DeploymentControllerDependencies
} from "./deployment-controller.js";
import type { DeploymentAccountResolver } from "./deployment-account.js";
import type { DeploymentExecutionOwner } from "./deployment-execution-owner.js";
import {
  beginDeployAttempt,
  deploymentStatusBlocksMutation,
  resolveDeploymentEnvironment
} from "./deployment-attempt.js";
import { errorMessage } from "./util.js";

export function createProductionDeploymentController(ports: {
  owner: DeploymentExecutionOwner;
  account: DeploymentAccountResolver;
  monitorFor: DeploymentControllerDependencies["monitorFor"];
  reportError(error: unknown): void;
}) {
  const reservations = createDeploymentReservationBindings(ports.owner);
  return createDeploymentController({
    owner: ports.owner,
    account: async (input) => {
      const selected = await ports.account(input);
      if (selected.state !== "selected")
        throw new Error(
          "message" in selected ?
            selected.message
          : `GitHub account selection is ${selected.state}. Select and authorize an account before deploying.`
        );
      return selected.executor;
    },
    reportError: ports.reportError,
    monitorFor: ports.monitorFor,
    resolveDeployRepairLoop: resolveDeploymentRepairLoop,
    resolveDeploymentEnvironment,
    activeDeploymentMutation: reservations.active,
    // Direct callers carry owner snapshots, not legacy unowned panel work.
    // The owner reservation, rather than snapshot age, determines admission.
    localDeploymentBlocksMutation: () => false,
    reserveDeploymentMutation: reservations.reserve,
    releaseDeploymentMutation: reservations.release,
    deploymentStatusBlocksMutation,
    resolveEnvDeployment: (repo, environment, appName, executor) =>
      resolveEnvironmentDeployment(repo, environment, appName, {
        ghOrThrow: async (args) =>
          (
            await executor.runOrThrow(
              args,
              "Could not read environment deployment history.",
              { timeout: 30000 }
            )
          ).stdout,
        deployWorkflowFile: "run-rad-commands.yml",
        deleteWorkflowFile: "delete-application.yml",
        maxParallelRecords: 10
      }),
    runCommand: async (_command, args, executor) =>
      (
        await executor.runOrThrow(
          args,
          "Could not resolve the deployment branch.",
          { timeout: 30000 }
        )
      ).stdout,
    canvasGraphResources,
    beginDeployAttempt,
    unconfirmedRunKind: "run-unconfirmed",
    repairAttemptCap: DEPLOY_REPAIR_ATTEMPT_CAP,
    errorMessage
  });
}
