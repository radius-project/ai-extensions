import { resumeSetupInput, type SetupResumeInput } from "@radius-project/core";
import { isDeepStrictEqual } from "node:util";
import type {
  OperationActionDependencies,
  OperationRecord
} from "../routes/operations-status.js";
import type { OperationControlResult } from "./operation-control.js";

export type OperationResumeDependencies = Pick<
  OperationActionDependencies,
  | "getOperation"
  | "claimAdmission"
  | "canResumeInput"
  | "resumeAfterInput"
  | "requireInput"
  | "persistOperations"
  | "toClientView"
  | "finish"
  | "scheduleEnvironmentOperation"
  | "errorMessage"
> & { isShuttingDown?(): boolean };

export interface OperationResumeInput {
  operationId: string;
  instanceId?: string;
  code: string;
  isCurrent?(): boolean;
  schedule?(operation: OperationRecord): boolean;
}

export type OperationResumeService = (
  input: OperationResumeInput,
  readInput: () => Promise<SetupResumeInput>,
  publish?: (result: OperationControlResult) => void
) => Promise<OperationControlResult>;

export async function finishSchedulingFailure(
  operation: OperationRecord,
  instanceId: string | undefined,
  finishOperation: (failure: Record<string, unknown>) => void,
  persistOperations: () => Promise<void>,
  errorMessage: (error: unknown) => string
): Promise<void> {
  finishOperation({
    code: "operation-scheduling-failed",
    stage: operation.currentStage,
    stepSeq: null,
    message:
      "Radius accepted the environment operation but could not start any setup work for it.",
    classification: "unknown",
    evidence:
      instanceId === undefined ?
        "No runtime setup task runner was available."
      : `No server-owned task runner was available for instance ${instanceId}.`
  });
  try {
    await persistOperations();
  } catch (error) {
    console.error(
      "[radius operation-scheduling] Could not persist the scheduling failure: " +
        errorMessage(error)
    );
  }
}

export function createOperationResumeService(
  dependencies: OperationResumeDependencies
): OperationResumeService {
  for (const name of [
    "getOperation",
    "claimAdmission",
    "canResumeInput",
    "resumeAfterInput",
    "requireInput",
    "persistOperations",
    "toClientView",
    "finish",
    "scheduleEnvironmentOperation",
    "errorMessage"
  ] as const) {
    if (typeof dependencies[name] !== "function") {
      throw new Error(`Missing operation resume dependency: ${name}`);
    }
  }
  return async (input, readInput, publish) => {
    const { operationId, instanceId, code } = input;
    const operation = dependencies.getOperation(operationId);
    const repo = operation?.repo;
    const environment = operation?.environment;
    const isRecordCurrent = (current: OperationRecord) =>
      dependencies.getOperation(operationId) === current &&
      current.operationId === operationId &&
      current.repo === repo &&
      current.environment === environment;
    const admission =
      operation ? dependencies.claimAdmission(operationId) : null;
    if (
      operation &&
      (!admission || (admission.hadTask && operation.inputRequired))
    ) {
      admission?.release();
      const result = {
        status: 409,
        body: {
          code: admission ? "operation-task-busy" : "operation-resume-mismatch",
          error:
            admission ?
              "The previous operation task is still settling. Wait for it to finish, then retry."
            : "Another admission owns this operation, or its durable undo failed. Inspect the saved operation before recovery.",
          operationId
        }
      };
      publish?.(result);
      return result;
    }
    try {
      let ownsResume = () => true;
      const accepted = {
        status: 202,
        body: {
          operationId,
          statusUrl: `/api/operations/${encodeURIComponent(operationId)}`
        }
      };
      const outcome = await resumeSetupInput(operation, code, {
        isStopped: dependencies.isShuttingDown,
        isCurrent: (current) =>
          isRecordCurrent(current) &&
          (input.isCurrent?.() ?? true) &&
          Boolean(admission?.canRestore()) &&
          ownsResume(),
        captureRecovery: (current) => {
          const fields = [
            "state",
            "inputRequired",
            "request",
            "resumeRequest",
            "recoveryState",
            "lastActivityAt",
            "azureAppCreateContinuation"
          ] as const;
          const before = structuredClone(current);
          let owned: OperationRecord;
          return {
            prepared: () => {
              owned = structuredClone(current);
              ownsResume = () => isDeepStrictEqual(current, owned);
            },
            restore: () => {
              if (
                !isRecordCurrent(current) ||
                !admission?.canRestore() ||
                !isDeepStrictEqual(current, owned)
              )
                return false;
              for (const key of fields) {
                if (Object.hasOwn(before, key))
                  Object.assign(current, { [key]: before[key] });
                else delete current[key];
              }
              return true;
            },
            failed: (error) => {
              admission?.blockRecovery();
              console.error(
                `[radius operation-resume-recovery-persist-failed] ${operationId}: ${dependencies.errorMessage(error)}`
              );
            }
          };
        },
        readInput,
        canResumeInput: dependencies.canResumeInput,
        resumeAfterInput: dependencies.resumeAfterInput,
        persist: dependencies.persistOperations,
        accepted: () => publish?.(accepted),
        schedule: (current) =>
          input.schedule ?
            input.schedule(current)
          : dependencies.scheduleEnvironmentOperation(instanceId, current),
        schedulingFailed: (current) =>
          finishSchedulingFailure(
            current,
            instanceId,
            (failure) => dependencies.finish(current, "failed", { failure }),
            dependencies.persistOperations,
            dependencies.errorMessage
          )
      });
      if (outcome.state === "accepted") return accepted;
      let result: OperationControlResult;
      switch (outcome.state) {
        case "stopped":
          result = {
            status: 503,
            body: {
              error:
                "The session is shutting down. No further setup work was scheduled; review the saved operation before continuing in a new session.",
              code: "operation-shutting-down",
              operationId
            }
          };
          break;
        case "unknown":
          result = {
            status: 404,
            body: { error: "Unknown operation.", code: "unknown-operation" }
          };
          break;
        case "expired":
          result = {
            status: 410,
            body: {
              error: outcome.message,
              code: "operation-input-expired",
              operation: dependencies.toClientView(outcome.operation)
            }
          };
          break;
        case "mismatch":
          result = {
            status: 409,
            body: {
              error: "The operation is not waiting for this input.",
              code: "operation-resume-mismatch",
              operationId
            }
          };
          break;
        case "request-unavailable":
          result = {
            status: 409,
            body: {
              error:
                "The operation cannot be resumed because its saved request is unavailable.",
              code: "operation-resume-request-unavailable",
              operationId
            }
          };
          break;
        case "unsupported":
          result = {
            status: 400,
            body: {
              error: "Unsupported resume prompt.",
              code: "unsupported-resume"
            }
          };
          break;
        case "persist-failed":
          result = {
            status: 500,
            body: {
              error:
                "Radius could not persist the resumed operation. Your answer was not accepted; retry the prompt.",
              code: "operation-resume-persist-failed",
              operationId,
              detail: dependencies.errorMessage(outcome.error)
            }
          };
          break;
        case "recovery-persist-failed":
          result = {
            status: 500,
            body: {
              error:
                "Radius could not durably restore the input prompt. Inspect the saved operation before recovery.",
              code: "operation-resume-recovery-persist-failed",
              operationId,
              detail: dependencies.errorMessage(outcome.error)
            }
          };
      }
      publish?.(result);
      return result;
    } finally {
      admission?.release();
    }
  };
}
