import {
  DEPLOY_HANDOFF_MAX_ATTEMPTS,
  DEPLOY_HANDOFF_RETRY_DELAY_MS,
  deploymentHandoffEligible,
  deploymentNoticeEligible,
  type DeploymentState
} from "@radius-project/core";
import { assertDeployDependencies } from "./deployment-service-dependencies.js";

export interface DeploymentDeliveryIdentity {
  attemptId: string;
  generation: number;
}

export interface DeploymentFailureNotice {
  repo: string;
  branch: string;
  error: string;
  deployRunUrl: string;
  instanceId: string;
}

export interface DeploymentRepairHandoff extends DeploymentFailureNotice {
  attemptId: string;
}

export interface DeploymentRepairDependencies {
  sendRepair?(input: DeploymentRepairHandoff): unknown;
  sendNotice?(input: DeploymentFailureNotice): unknown;
  redactDiagnostic(value: string): string;
  reportDiagnostic(message: string): void;
  /** The runtime owner owns and cancels this timer and accounts for its task. */
  scheduleRetry(
    identity: DeploymentDeliveryIdentity,
    callback: () => Promise<void>,
    milliseconds: number
  ): void;
}

export interface DeploymentRepairRequest extends DeploymentDeliveryIdentity {
  state: DeploymentState;
  repo: string;
  branch: string;
  instanceId?: string;
  isCurrent(): boolean;
}

export type DeploymentDeliveryResult =
  | { status: "stale" | "ineligible" }
  | {
      kind: "repair" | "notice";
      status: "unavailable" | "delivered" | "retryable" | "failed";
    };

export interface DeploymentRepairCoordinator {
  coordinate(
    request: DeploymentRepairRequest
  ): Promise<DeploymentDeliveryResult>;
}

/** Explicit terminal-event delivery; observing an attempt never calls this. */
export function createDeploymentRepairCoordinator(
  dependencies: DeploymentRepairDependencies
): DeploymentRepairCoordinator {
  assertDeployDependencies("createDeploymentRepairCoordinator", dependencies, [
    "redactDiagnostic",
    "reportDiagnostic",
    "scheduleRetry"
  ]);
  const coordinate = async (
    request: DeploymentRepairRequest
  ): Promise<DeploymentDeliveryResult> => {
    const { state, attemptId, generation } = request;
    const ownsInvocation = () =>
      request.isCurrent() &&
      state.deployAttempt?.id === attemptId &&
      state.deployGeneration === generation;
    if (!ownsInvocation()) return { status: "stale" };
    const kind =
      deploymentNoticeEligible(state) ? "notice"
      : deploymentHandoffEligible(state) ? "repair"
      : null;
    if (!kind) return { status: "ineligible" };
    const { sendRepair, sendNotice } = dependencies;
    const delivery =
      kind === "repair" ?
        sendRepair && { kind: "repair" as const, send: sendRepair }
      : sendNotice && { kind: "notice" as const, send: sendNotice };
    if (!delivery) return { kind, status: "unavailable" };
    const stateField =
      kind === "repair" ? "deployHandoffState" : "deployNoticeState";
    const attemptsField =
      kind === "repair" ? "deployHandoffAttempts" : "deployNoticeAttempts";
    if ((state[attemptsField] || 0) >= DEPLOY_HANDOFF_MAX_ATTEMPTS) {
      state[stateField] = "failed";
      return { kind, status: "failed" };
    }
    state[stateField] = "pending";
    const attempt = (state[attemptsField] || 0) + 1;
    state[attemptsField] = attempt;
    try {
      const notice: DeploymentFailureNotice = {
        repo: request.repo,
        branch: request.branch,
        error: dependencies.redactDiagnostic(state.deployError || ""),
        deployRunUrl: dependencies.redactDiagnostic(state.deployRunUrl || ""),
        instanceId: request.instanceId || ""
      };
      if (delivery.kind === "repair") {
        await delivery.send({ ...notice, attemptId });
      } else {
        await delivery.send(notice);
      }
      if (!ownsInvocation()) return { status: "stale" };
      state[stateField] = "delivered";
      if (kind === "repair") state.deployRepairing = true;
      return { kind, status: "delivered" };
    } catch (error) {
      if (!ownsInvocation()) return { status: "stale" };
      if (kind === "repair") state.deployRepairing = false;
      const status =
        attempt >= DEPLOY_HANDOFF_MAX_ATTEMPTS ? "failed" : "retryable";
      state[stateField] = status;
      dependencies.reportDiagnostic(
        dependencies.redactDiagnostic(
          `Deployment ${kind} delivery failed: ${error instanceof Error ? error.message : String(error)}`
        )
      );
      if (status === "retryable") {
        dependencies.scheduleRetry(
          { attemptId, generation },
          async () => {
            await coordinate(request);
          },
          DEPLOY_HANDOFF_RETRY_DELAY_MS
        );
      }
      return { kind, status };
    }
  };
  return { coordinate };
}
