import {
  readSetupVerificationStatus,
  type SetupVerificationObservation
} from "@radius-project/core";
import { isWorkflowReadLimitError } from "@radius-project/adapter-shared";
import type { EnvironmentsDependencies } from "../routes/environments-types.js";
import type { WorkflowObservationScope } from "./workflow-observation-scope.js";
export interface VerificationStatusInput {
  repo: string;
  operationId: string;
  environment?: string;
  observation?: WorkflowObservationScope;
  compatibility?: () => {
    observation?: WorkflowObservationScope;
    runId?: string | number | null;
  };
}

export interface VerificationStatusResult {
  status: number;
  body: SetupVerificationObservation & Record<string, unknown>;
}

export function createVerificationStatusService(
  dependencies: VerificationStatusDependencies,
  createObservation: () => WorkflowObservationScope
) {
  return async (
    input: Omit<VerificationStatusInput, "compatibility">
  ): Promise<VerificationStatusResult> => {
    const observation = input.observation ?? createObservation();
    try {
      return await observeVerificationStatus(
        {
          repo: input.repo,
          operationId: input.operationId,
          environment: input.environment,
          observation
        },
        dependencies
      );
    } finally {
      if (!input.observation) observation.stop();
    }
  };
}

export type VerificationStatusDependencies = Pick<
  EnvironmentsDependencies,
  | "getOperation"
  | "getSelectedGitHubExecutor"
  | "isSelectedGitHubAuthorizationError"
  | "hasCompleteVerificationIdentity"
  | "getRunDetail"
  | "fetchRunLog"
  | "extractErrorLines"
  | "extractGitHubActionsStepLog"
  | "explainOidcEnterpriseClaim"
  | "explainNoSubscriptions"
  | "addLegacyStep"
  | "isTerminalState"
  | "finish"
  | "finishSucceeded"
  | "persistBestEffort"
  | "persistOperations"
  | "reportOperationDiagnostic"
  | "errorMessage"
  | "redactDiagnostic"
  | "stageVerify"
>;

function readRunId(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

export async function observeVerificationStatus(
  input: VerificationStatusInput,
  dependencies: VerificationStatusDependencies
): Promise<VerificationStatusResult> {
  if (!input.repo)
    return {
      status: 200,
      body: { state: "unknown", error: "No repository specified." }
    };
  if (!input.operationId && !input.compatibility)
    return {
      status: 200,
      body: {
        state: "expired",
        terminal: true,
        error: "No verification operation specified."
      }
    };
  let observation = input.observation;
  let legacyRunId: string | number | null | undefined;
  const outcome = await readSetupVerificationStatus(input, {
    ...dependencies,
    prepare: () => {
      const compatibility = input.compatibility?.();
      observation ??= compatibility?.observation;
      legacyRunId = compatibility?.runId;
    },
    resolveRunId: (operation) =>
      readRunId(operation?.verification?.runId) || legacyRunId || null,
    observe: (executor, timeout) => observation?.observe(executor, timeout),
    observationStopped: () => observation?.stopped === true,
    readLimitReason: (error) =>
      isWorkflowReadLimitError(error) ? error.reason : undefined
  });
  const { observationStopped, ...body } = outcome;
  return { status: observationStopped ? 503 : 200, body };
}
