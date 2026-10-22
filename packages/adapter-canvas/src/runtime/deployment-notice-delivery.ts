import {
  DEPLOY_HANDOFF_MAX_ATTEMPTS,
  DEPLOY_HANDOFF_RETRY_DELAY_MS,
  redactCredentials
} from "@radius-project/core";
import type { CanvasState } from "../shared.js";
import type { DeploymentRepairDeliveryPorts } from "./deployment-repair-delivery.js";
import { errorMessage } from "./util.js";

export interface DeploymentFailureNoticeInput {
  repo: string;
  branch: string;
  error: string;
  deployRunUrl: string;
  instanceId: string;
  dispatchRefused?: boolean;
}

export type DeploymentNoticeDeliveryPorts = Omit<
  DeploymentRepairDeliveryPorts,
  "send"
> & {
  send(input: DeploymentFailureNoticeInput): unknown;
};

export function deliverDeploymentNotice(
  state: CanvasState,
  input: DeploymentFailureNoticeInput,
  ports: DeploymentNoticeDeliveryPorts
): boolean {
  if (
    !ports.isCurrent() ||
    state.deployStatus !== "failed" ||
    (state.deployErrorKind !== "run-unconfirmed" &&
      state.deployErrorKind !== "dispatch-refused") ||
    state.deployNoticeState === "pending" ||
    state.deployNoticeState === "delivered" ||
    state.deployNoticeState === "failed" ||
    (state.deployNoticeAttempts || 0) >= DEPLOY_HANDOFF_MAX_ATTEMPTS
  )
    return false;
  const selected = {
    ...input,
    error: redactCredentials(ports.redactDiagnostic(input.error))
  };
  if (!ports.isCurrent()) return false;
  const attemptId = state.deployAttempt?.id || "";
  const generation = state.deployGeneration || 0;
  const ordinal = (state.deployNoticeAttempts || 0) + 1;
  state.deployNoticeState = "pending";
  state.deployNoticeAttempts = ordinal;
  const owns = () =>
    ports.isCurrent() &&
    (state.deployAttempt?.id || "") === attemptId &&
    (state.deployGeneration || 0) === generation &&
    state.deployNoticeAttempts === ordinal;
  const report = (error: unknown) => {
    try {
      ports.reportError(
        new Error(
          redactCredentials(ports.redactDiagnostic(errorMessage(error))).slice(
            0,
            4000
          )
        )
      );
    } catch {
      console.error("[radius notice] Could not report a delivery failure.");
    }
  };
  const settle = (delivered: boolean, error?: unknown) => {
    try {
      if (!owns() || state.deployNoticeState !== "pending") return;
      state.deployNoticeState =
        delivered ? "delivered"
        : ordinal >= DEPLOY_HANDOFF_MAX_ATTEMPTS ? "failed"
        : "retryable";
      if (!delivered) report(error);
      if (!owns()) return;
      try {
        ports.publish();
      } catch (publishError) {
        report(publishError);
      }
      if (state.deployNoticeState === "retryable" && owns())
        ports.retry(() => {
          try {
            if (owns() && state.deployNoticeState === "retryable")
              deliverDeploymentNotice(state, selected, ports);
          } catch (retryError) {
            report(retryError);
          }
        }, DEPLOY_HANDOFF_RETRY_DELAY_MS);
    } catch (settlementError) {
      report(settlementError);
    }
  };
  try {
    Promise.resolve(ports.send(selected)).then(
      () => settle(true),
      (error: unknown) => settle(false, error)
    );
    return true;
  } catch (error) {
    settle(false, error);
    return false;
  }
}
