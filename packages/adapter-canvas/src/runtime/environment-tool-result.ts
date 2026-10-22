import { redactCredentials } from "@radius-project/core";
import {
  canResumeInput,
  isTerminalState,
  projectOperationActions
} from "../operations.js";
import type { OperationRecord } from "../server/routes/operations-status.js";
import {
  environmentRecord,
  environmentString,
  type EnvironmentControlAction
} from "./environment-tool-schema.js";

export interface EnvironmentTarget {
  repo: string;
  environment: string;
  operationId?: string;
}

export interface SafeEnvironmentOperation {
  operationId: string;
  repo: string;
  environment: string;
  provider: "azure" | "aws";
  state: string;
  terminal: boolean;
  stage?: string;
  message?: string;
  actions: EnvironmentControlAction[];
}

export interface EnvironmentVerificationEvidence {
  state:
    "pending" | "in_progress" | "success" | "failed" | "unknown" | "expired";
  runId?: string;
  runUrl?: string;
  message?: string;
}

export interface EnvironmentRequiredInteraction extends EnvironmentTarget {
  interactionId: string;
  kind:
    | "github-account-selection"
    | "github-reauthorization"
    | "azure-login"
    | "azure-consent"
    | "setup-input"
    | "confirmation"
    | "pull-request-merge"
    | "target-required";
  supported: boolean;
  message: string;
  checkpoint?: string;
  code?: string;
}

export type EnvironmentToolResult =
  | {
      kind: "accepted" | "status";
      code: string;
      operation: SafeEnvironmentOperation;
      verification?: EnvironmentVerificationEvidence;
      interaction?: EnvironmentRequiredInteraction;
    }
  | {
      kind: "interaction_required";
      code: string;
      interaction: EnvironmentRequiredInteraction;
      operation?: SafeEnvironmentOperation;
    }
  | {
      kind: "refused" | "unavailable";
      code: string;
      message: string;
      operation?: SafeEnvironmentOperation;
    };

const actionNames = new Map<string, EnvironmentControlAction>([
  ["continue-setup", "continue"],
  ["retry-verification", "verify"],
  ["retry-setup", "retry-setup"],
  ["retry-cleanup", "retry-cleanup"],
  ["stop", "stop"],
  ["cancel-workflow", "cancel-workflow"],
  ["rollback", "rollback"]
]);

export function environmentActions(
  operation: OperationRecord
): EnvironmentControlAction[] {
  const actions: unknown[] = projectOperationActions(operation);
  const result: EnvironmentControlAction[] = [];
  for (const value of actions) {
    const action = environmentRecord(value);
    if (!action || action.pending === true) continue;
    const id = environmentString(action.id);
    const mapped = actionNames.get(id);
    if (mapped) result.push(mapped);
    if (id === "exit-setup") {
      result.push(
        environmentString(action.path).endsWith("?mode=abandon") ?
          "abandon"
        : "exit"
      );
    }
  }
  const prompt = environmentRecord(operation.inputRequired);
  if (
    prompt &&
    operation.provider === "azure" &&
    [
      "service-management-reference-required",
      "app-selection-required"
    ].includes(environmentString(prompt.code)) &&
    canResumeInput(operation, {
      code: environmentString(prompt.code),
      checkpoint: environmentString(prompt.checkpoint),
      repo: environmentString(operation.repo),
      environment: environmentString(operation.environment),
      provider: "azure"
    })
  )
    result.push("resume");
  return result;
}

export function environmentDiagnostic(
  value: string,
  redact: (text: string) => string
): string {
  return redactCredentials(redact(value)).slice(0, 4000);
}

export function projectEnvironmentOperation(
  operation: OperationRecord,
  redact: (text: string) => string
): SafeEnvironmentOperation {
  const { provider, state, repo, environment, operationId } = operation;
  if (
    (provider !== "azure" && provider !== "aws") ||
    typeof state !== "string" ||
    !state ||
    typeof repo !== "string" ||
    !repo ||
    typeof environment !== "string" ||
    !environment ||
    operation.kind === "delete"
  ) {
    throw new Error(
      "The saved record is not a valid environment setup operation."
    );
  }
  const failure = environmentRecord(operation.failure);
  const message = environmentString(failure?.message);
  return {
    operationId,
    repo,
    environment,
    provider,
    state,
    terminal: isTerminalState(state),
    ...(typeof operation.currentStage === "string" ?
      { stage: operation.currentStage }
    : {}),
    ...(message ? { message: environmentDiagnostic(message, redact) } : {}),
    actions: environmentActions(operation)
  };
}

export function projectEnvironmentVerification(
  body: Record<string, unknown>,
  redact: (text: string) => string
): EnvironmentVerificationEvidence {
  const state = body.state;
  if (
    state !== "pending" &&
    state !== "in_progress" &&
    state !== "success" &&
    state !== "failed" &&
    state !== "unknown" &&
    state !== "expired"
  ) {
    throw new Error("Verification returned an unsupported observation.");
  }
  const runId =
    typeof body.runId === "number" ?
      String(body.runId)
    : environmentString(body.runId);
  const runUrl = environmentString(body.runUrl);
  const message = environmentString(body.error);
  return {
    state,
    ...(/^\d+$/.test(runId) ? { runId } : {}),
    ...((
      /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+$/.test(runUrl)
    ) ?
      { runUrl }
    : {}),
    ...(message ? { message: environmentDiagnostic(message, redact) } : {})
  };
}
