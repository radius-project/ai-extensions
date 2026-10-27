import type {
  DeploymentExecution,
  DeploymentExecutionOwner
} from "./deployment-execution-owner.js";
import {
  deliverDeploymentRepair,
  type DeploymentRepairHandoffInput
} from "./deployment-repair-delivery.js";
import {
  deliverDeploymentNotice,
  type DeploymentFailureNoticeInput
} from "./deployment-notice-delivery.js";
import { retryDeploymentDelivery } from "./deployment-delivery-retry.js";

export function createDeploymentNotifications(ports: {
  owner: DeploymentExecutionOwner;
  repair(input: DeploymentRepairHandoffInput): unknown;
  notice(input: DeploymentFailureNoticeInput): unknown;
  reportError(error: unknown): void;
}) {
  return (execution: DeploymentExecution) => {
    const isCurrent = () =>
      ports.owner.execution(execution.invocation) === execution &&
      !execution.observation.stopped;
    const delivery = {
      isCurrent,
      redactDiagnostic: execution.executor.redact,
      publish: () => ports.owner.publish(execution.invocation),
      reportError: ports.reportError,
      retry: (callback: () => void, milliseconds: number) => {
        void ports.owner.trackWork(
          retryDeploymentDelivery(callback, milliseconds, {
            delay: (delay) => execution.observation.delay(delay),
            isCurrent,
            errorMessage: execution.executor.errorMessage,
            reportError: (message) => ports.reportError(new Error(message))
          })
        );
      }
    };
    const input = {
      repo: execution.invocation.target.repo,
      branch: execution.invocation.target.branch,
      appFile: execution.invocation.target.appFile,
      error: execution.state.deployError || "",
      deployRunUrl: execution.state.deployRunUrl || "",
      instanceId: ""
    };
    deliverDeploymentRepair(execution.state, input, {
      ...delivery,
      send: (handoff) =>
        ports.owner.trackWork(Promise.resolve(ports.repair(handoff)))
    });
    deliverDeploymentNotice(
      execution.state,
      {
        ...input,
        ...(execution.state.deployErrorKind === "dispatch-refused" ?
          { dispatchRefused: true }
        : {})
      },
      {
        ...delivery,
        send: (notice) =>
          ports.owner.trackWork(Promise.resolve(ports.notice(notice)))
      }
    );
    if (isCurrent()) delivery.publish();
  };
}
