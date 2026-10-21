import {
  claimDeploymentRepairHandoff,
  redactCredentials,
  settleDeploymentRepairHandoff,
  DEPLOY_HANDOFF_RETRY_DELAY_MS,
  type DeploymentRepairState
} from "@radius-project/core";
import { DEPLOY_DIAGNOSTIC_CHAR_CAP } from "../deploy-diagnostics.js";
import { errorMessage } from "./util.js";

export interface DeploymentRepairHandoffInput {
  repo: string;
  branch: string;
  error: string;
  deployRunUrl: string;
  attemptId: string;
  instanceId: string;
}

export interface DeploymentRepairDeliveryPorts {
  isCurrent(): boolean;
  send(input: DeploymentRepairHandoffInput): unknown;
  redactDiagnostic(value: string): string;
  publish(): void;
  retry(callback: () => void, milliseconds: number): void;
  reportError(error: unknown): void;
}

export function deliverDeploymentRepair(
  state: DeploymentRepairState,
  input: Omit<DeploymentRepairHandoffInput, "attemptId">,
  ports: DeploymentRepairDeliveryPorts
): boolean {
  if (!ports.isCurrent()) return false;
  const selected = {
    ...input,
    error: redactCredentials(ports.redactDiagnostic(input.error))
  };
  if (!ports.isCurrent()) return false;
  const claim = claimDeploymentRepairHandoff(state);
  if (!claim) return false;
  const handoff = { ...selected, attemptId: claim.attemptId };
  const report = (error: unknown) => {
    try {
      ports.reportError(
        new Error(
          redactCredentials(ports.redactDiagnostic(errorMessage(error))).slice(
            0,
            DEPLOY_DIAGNOSTIC_CHAR_CAP
          )
        )
      );
    } catch {
      console.error("[radius repair] Could not report a handoff failure.");
    }
  };
  const ownsAttempt = () =>
    ports.isCurrent() &&
    (state.deployAttempt?.id || "") === claim.attemptId &&
    (state.deployGeneration || 0) === claim.generation &&
    state.deployHandoffAttempts === claim.deliveryAttempt;
  const settle = (delivered: boolean, error?: unknown) => {
    try {
      if (!ownsAttempt()) return;
      const result = settleDeploymentRepairHandoff(state, claim, delivered);
      if (result === "stale") return;
      if (!delivered) report(error);
      if (!ownsAttempt()) return;
      try {
        ports.publish();
      } catch (publishError) {
        report(publishError);
      }
      if (result === "retryable" && ownsAttempt()) {
        ports.retry(() => {
          try {
            if (!ownsAttempt() || state.deployHandoffState !== "retryable")
              return;
            deliverDeploymentRepair(state, selected, ports);
          } catch (retryError) {
            report(retryError);
          }
        }, DEPLOY_HANDOFF_RETRY_DELAY_MS);
      }
    } catch (settlementError) {
      report(settlementError);
    }
  };
  try {
    Promise.resolve(ports.send(handoff)).then(
      () => settle(true),
      (error: unknown) => settle(false, error)
    );
    return true;
  } catch (error) {
    settle(false, error);
    return false;
  }
}
