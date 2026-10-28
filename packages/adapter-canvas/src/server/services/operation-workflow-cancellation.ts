import { isDeepStrictEqual } from "node:util";
import {
  acceptCommand,
  getOperationControl,
  setCommandState,
  setVerificationWorkflowState,
  toClientView,
  verificationWorkflowState,
  type OperationCommandRecord
} from "../../operations.js";
import { errorMessage } from "../../runtime/util.js";
import type { OperationRecord } from "../routes/operations-status.js";
import type {
  OperationControlInput,
  OperationControlResult,
  OperationsControlDependencies
} from "./operation-control.js";
import {
  captureWorkflowCancellationTarget,
  matchesWorkflowCancellationTarget,
  WorkflowCancellationRefusal,
  type WorkflowCancellationAuthority,
  type WorkflowCancellationTarget
} from "./workflow-cancellation-target.js";

export async function cancelOperationWorkflow(
  input: OperationControlInput,
  operation: OperationRecord,
  target: WorkflowCancellationTarget,
  dependencies: OperationsControlDependencies
): Promise<OperationControlResult> {
  const operationId = target.operationId;
  const response = (
    status: number,
    code: string,
    extra: Record<string, unknown> = {}
  ) => ({
    status,
    body: { operationId, code, ...extra }
  });
  const recordCurrent = () => dependencies.get(operationId) === operation;
  const targetCurrent = () =>
    recordCurrent() && matchesWorkflowCancellationTarget(operation, target);
  const assertCurrent = () => {
    if (dependencies.isShuttingDown?.())
      throw new WorkflowCancellationRefusal("operation-shutting-down");
    if (
      !targetCurrent() ||
      operation.state !== "cancelled" ||
      input.isCurrent?.() === false
    )
      throw new WorkflowCancellationRefusal("operation-context-changed");
  };
  const refusal = (error: WorkflowCancellationRefusal) =>
    response(error.code === "operation-shutting-down" ? 503 : 409, error.code, {
      error: error.message
    });
  try {
    assertCurrent();
  } catch (error) {
    if (error instanceof WorkflowCancellationRefusal) return refusal(error);
    throw error;
  }
  const admission = dependencies.claimAdmission(operationId);
  if (!admission)
    return refusal(
      new WorkflowCancellationRefusal("operation-context-changed")
    );
  const previousVerification = structuredClone(operation.verification);
  let ownedVerification: unknown;
  const restoreVerification = () => {
    if (
      targetCurrent() &&
      admission.canRestore({ allowPreexistingTask: true }) &&
      isDeepStrictEqual(operation.verification, ownedVerification)
    )
      operation.verification = previousVerification;
  };
  const diagnostic = (code: string, message: string) =>
    dependencies.reportOperationDiagnostic({ operationId, code, message });
  try {
    if (
      verificationWorkflowState(operation) === "unknown" ||
      verificationWorkflowState(operation) === "cancelling" ||
      verificationWorkflowState(operation) === "inactive"
    ) {
      try {
        const state = await dependencies.inspectVerificationWorkflow(
          target,
          assertCurrent
        );
        assertCurrent();
        setVerificationWorkflowState(operation, state);
        ownedVerification = structuredClone(operation.verification);
        try {
          await dependencies.persistOperations();
          assertCurrent();
        } catch (error) {
          restoreVerification();
          if (error instanceof WorkflowCancellationRefusal)
            return refusal(error);
          return response(500, "workflow-status-persist-failed", {
            error:
              "Radius read the verification workflow status but could not save it. Try again.",
            detail: errorMessage(error)
          });
        }
        return response(200, "workflow-status-checked", {
          statusUrl: `/api/operations/${encodeURIComponent(operationId)}`,
          operation: toClientView(operation)
        });
      } catch (error) {
        if (error instanceof WorkflowCancellationRefusal) return refusal(error);
        return response(502, "workflow-status-read-failed", {
          error: "Radius could not read the verification workflow status.",
          detail: errorMessage(error)
        });
      }
    }
    const next = captureWorkflowCancellationTarget(operation);
    if (
      next.commandId !== target.commandId ||
      next.cancellationAttempt !== target.cancellationAttempt
    )
      return refusal(
        new WorkflowCancellationRefusal("operation-context-changed")
      );
    const accepted: { command: OperationCommandRecord } = acceptCommand(
      operation,
      {
        kind: "cancel_workflow",
        attempt: target.cancellationAttempt,
        target: target.runId
      }
    );
    const command = accepted.command;
    command.workflowCancellation = target;
    setCommandState(operation, target.commandId, "running");
    const ownedCommand = structuredClone(command);
    setVerificationWorkflowState(operation, "cancelling");
    ownedVerification = structuredClone(operation.verification);
    let issued = false;
    const authority: WorkflowCancellationAuthority = {
      assertCurrent: () => {
        assertCurrent();
        if (
          !getOperationControl(operation)?.commands.includes(command) ||
          !isDeepStrictEqual(command, ownedCommand)
        )
          throw new WorkflowCancellationRefusal("operation-context-changed");
      },
      issued: () => {
        authority.assertCurrent();
        issued = true;
      }
    };
    const unwind = async () => {
      if (
        recordCurrent() &&
        admission.canRestore({ allowPreexistingTask: true })
      ) {
        const commands = getOperationControl(operation)?.commands;
        const index = commands?.indexOf(command) ?? -1;
        if (
          commands &&
          index >= 0 &&
          isDeepStrictEqual(command, ownedCommand)
        ) {
          commands.splice(index, 1);
          restoreVerification();
        }
      }
      try {
        await dependencies.persistOperations();
      } catch (error) {
        admission.blockRecovery();
        const detail = `Radius could not save the unissued cancellation correction: ${errorMessage(error)}`;
        diagnostic("operation-control-recovery-persist-failed", detail);
        return response(500, "operation-control-recovery-persist-failed", {
          error: detail
        });
      }
      return null;
    };
    try {
      await dependencies.persistOperations();
      authority.assertCurrent();
    } catch (error) {
      const recovery = await unwind();
      if (recovery) return recovery;
      if (error instanceof WorkflowCancellationRefusal) return refusal(error);
      return response(500, "workflow-cancel-persist-failed", {
        error:
          "Radius could not save the workflow cancellation request, so it did not contact GitHub. Try again.",
        detail: errorMessage(error)
      });
    }
    let state: "inactive" | "cancelling" | "unknown";
    let failure: unknown;
    try {
      state = await dependencies.cancelVerificationWorkflow(target, authority);
      if (!issued) authority.assertCurrent();
    } catch (error) {
      if (!issued) {
        const recovery = await unwind();
        if (recovery) return recovery;
        if (error instanceof WorkflowCancellationRefusal) return refusal(error);
        return response(502, "workflow-cancel-failed", {
          error:
            "Radius could not inspect the workflow before cancellation. No cancellation was issued.",
          detail: errorMessage(error)
        });
      }
      state = "unknown";
      failure = error;
    }
    const result = { target, state, issued };
    if (
      !recordCurrent() ||
      !getOperationControl(operation)?.commands.includes(command) ||
      !isDeepStrictEqual(command, ownedCommand)
    ) {
      const detail = `Workflow cancellation result is detached from its saved operation: ${JSON.stringify(result)}${failure ? ` ${errorMessage(failure)}` : ""}`;
      diagnostic("workflow-cancellation-result-detached", detail);
      return response(502, "workflow-cancellation-result-detached", {
        error: detail,
        cancellation: result
      });
    }
    // Settlement belongs to the issued run even after shutdown or a new target.
    setCommandState(operation, target.commandId, "finished", state);
    const settledCommand = structuredClone(command);
    if (
      targetCurrent() &&
      isDeepStrictEqual(operation.verification, ownedVerification)
    )
      setVerificationWorkflowState(operation, state);
    try {
      await dependencies.persistOperations();
    } catch (error) {
      const detail = `Radius could not save the workflow cancellation result: ${errorMessage(error)}`;
      diagnostic("workflow-cancel-result-persist-failed", detail);
      return response(500, "workflow-cancel-result-persist-failed", {
        error: detail,
        cancellation: result,
        ...(failure ? { detail: errorMessage(failure) } : {})
      });
    }
    if (
      !recordCurrent() ||
      !getOperationControl(operation)?.commands.includes(command) ||
      !isDeepStrictEqual(command, settledCommand)
    ) {
      const detail = `Workflow cancellation result lost its operation during persistence: ${JSON.stringify(result)}`;
      diagnostic("workflow-cancellation-result-detached", detail);
      return response(502, "workflow-cancellation-result-detached", {
        error: detail,
        cancellation: result
      });
    }
    if (failure)
      return response(502, "workflow-cancel-failed", {
        error:
          "Radius could not confirm cancellation of the verification workflow.",
        detail: errorMessage(failure),
        cancellation: result,
        operation: toClientView(operation)
      });
    return response(
      state === "inactive" ? 200 : 202,
      state === "inactive" ? "workflow-cancelled" : (
        "workflow-cancellation-pending"
      ),
      {
        cancellation: result,
        statusUrl: `/api/operations/${encodeURIComponent(operationId)}`,
        operation: toClientView(operation)
      }
    );
  } finally {
    admission.release();
  }
}
