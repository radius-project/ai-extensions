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
        void retryDeploymentDelivery(callback, milliseconds, {
          delay: (delay) => execution.observation.delay(delay),
          isCurrent,
          errorMessage: execution.executor.errorMessage,
          reportError: (message) => ports.reportError(new Error(message))
        });
      }
    };
    const input = {
      repo: execution.invocation.target.repo,
      branch: execution.invocation.target.branch,
      error: execution.state.deployError || "",
      deployRunUrl: execution.state.deployRunUrl || "",
      instanceId: ""
    };
    deliverDeploymentRepair(execution.state, input, {
      ...delivery,
      send: ports.repair
    });
    deliverDeploymentNotice(
      execution.state,
      {
        ...input,
        ...(execution.state.deployErrorKind === "dispatch-refused" ?
          { dispatchRefused: true }
        : {})
      },
      { ...delivery, send: ports.notice }
    );
    if (isCurrent()) delivery.publish();
  };
}
