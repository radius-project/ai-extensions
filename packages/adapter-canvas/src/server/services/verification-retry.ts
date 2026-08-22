export interface VerificationRetryCommandResult {
  code: string | number;
  stdout: string;
  stderr: string;
}

export interface VerificationRetryIdentity {
  dispatchedAt: number;
  workflow: string;
  ref: string;
  environment: string;
  runId: string | null;
  runUrl: string | null;
}

export interface VerificationRetryOperation {
  operationId: string;
  repo: string;
  environment: string;
  currentStage?: string;
  endedAt?: unknown;
  state?: string;
  verification?: Partial<VerificationRetryIdentity>;
}

export interface VerificationRetryPorts {
  workflowFile: string;
  now(): number;
  dispatch(input: {
    workflowFile: string;
    targetRepo: string;
    envName: string;
    ref: string;
  }): Promise<VerificationRetryCommandResult>;
  addStep(operation: VerificationRetryOperation, message: string): void;
  setCommandState(
    operation: VerificationRetryOperation,
    commandId: string,
    state: "running" | "finished",
    outcome?: string | null
  ): void;
  finishFailed(
    operation: VerificationRetryOperation,
    failure: Record<string, unknown>
  ): void;
  save(operation: VerificationRetryOperation): Promise<boolean>;
  stopBoundary(input: {
    operation: VerificationRetryOperation;
    boundary: string;
    beforePersist(): void;
  }): Promise<boolean>;
  monitor(operationId: string): Promise<void>;
  currentState(operationId: string): string | null;
}

export async function runVerificationRetry(
  operation: VerificationRetryOperation,
  commandId: string,
  ports: VerificationRetryPorts
): Promise<void> {
  if (operation.endedAt) return;

  const stopBoundary = (boundary: string) =>
    ports.stopBoundary({
      operation,
      boundary,
      beforePersist: () =>
        ports.setCommandState(operation, commandId, "finished", "cancelled")
    });

  if (!(await stopBoundary("before-verification-retry-dispatch"))) return;

  const saved = operation.verification || {};
  const dispatchedAt = ports.now();
  const dispatch = await ports.dispatch({
    workflowFile: String(saved.workflow || ports.workflowFile),
    targetRepo: operation.repo,
    envName: String(saved.environment || operation.environment),
    ref: String(saved.ref || "")
  });
  if (dispatch.code !== 0 && dispatch.code !== "0") {
    ports.addStep(
      operation,
      "❌ Could not dispatch the verify workflow again."
    );
    if (!(await stopBoundary("after-verification-retry-dispatch"))) return;
    const detail =
      (dispatch.stderr || dispatch.stdout || "").trim() ||
      "The GitHub CLI request failed.";
    ports.setCommandState(operation, commandId, "finished", "dispatch-failed");
    ports.finishFailed(operation, {
      code: "verify-dispatch-failed",
      message:
        "Radius could not dispatch the credential verification workflow again.",
      classification: "user-fixable",
      evidence: detail
    });
    await ports.save(operation);
    return;
  }

  operation.verification = {
    dispatchedAt,
    workflow: String(saved.workflow || ports.workflowFile),
    ref: String(saved.ref || ""),
    environment: String(saved.environment || operation.environment),
    runId: null,
    runUrl: null
  };
  ports.addStep(operation, "✅ Verify workflow dispatched again.");
  ports.setCommandState(operation, commandId, "running");
  if (!(await ports.save(operation))) {
    ports.setCommandState(
      operation,
      commandId,
      "finished",
      "persistence-failed"
    );
    ports.finishFailed(operation, {
      code: "verify-dispatch-persist-failed",
      message:
        "Radius dispatched credential verification but could not save the new run identity.",
      classification: "unknown",
      evidence: null
    });
    await ports.save(operation);
    return;
  }
  if (!(await stopBoundary("after-verification-retry-dispatch"))) return;

  await ports.monitor(operation.operationId);
  ports.setCommandState(
    operation,
    commandId,
    "finished",
    ports.currentState(operation.operationId)
  );
  await ports.save(operation);
}
