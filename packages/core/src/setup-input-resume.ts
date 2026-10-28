export interface SetupResumeRequest {
  azure: {
    serviceManagementReference?: unknown;
    appId?: unknown;
    createNew?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface SetupResumeInput extends Record<string, unknown> {
  checkpoint?: string;
  repo?: string;
  environment?: string;
  provider?: string;
}

export interface SetupResumeOperation {
  state?: string;
  failure?: { code?: unknown; message?: unknown };
  inputRequired?: unknown;
  request?: SetupResumeRequest;
  resumeRequest?: SetupResumeRequest;
}

export type SetupInputResumeResult<
  Operation extends SetupResumeOperation = SetupResumeOperation
> =
  | {
      state:
        | "unknown"
        | "mismatch"
        | "request-unavailable"
        | "unsupported"
        | "stopped"
        | "accepted";
    }
  | { state: "expired"; operation: Operation; message: unknown }
  | { state: "persist-failed" | "recovery-persist-failed"; error: unknown };

export interface SetupInputResumePorts<Operation extends SetupResumeOperation> {
  isStopped?(): boolean;
  isCurrent(operation: Operation): boolean;
  captureRecovery(operation: Operation): {
    prepared(): void;
    restore(): boolean;
    failed(error: unknown): void;
  };
  readInput(): Promise<SetupResumeInput>;
  canResumeInput(
    operation: Operation,
    input: {
      code: string;
      checkpoint?: string;
      repo?: string;
      environment?: string;
      provider?: string;
    }
  ): boolean;
  resumeAfterInput(operation: Operation): void;
  persist(): Promise<void>;
  accepted(): void;
  schedule(operation: Operation): boolean;
  schedulingFailed(operation: Operation): Promise<void>;
}

function isSetupRequest(value: unknown): value is SetupResumeRequest {
  if (typeof value !== "object" || value === null || !("azure" in value)) {
    return false;
  }
  return typeof value.azure === "object" && value.azure !== null;
}

export async function resumeSetupInput<Operation extends SetupResumeOperation>(
  operation: Operation | null | undefined,
  code: string,
  ports: SetupInputResumePorts<Operation>
): Promise<SetupInputResumeResult<Operation>> {
  if (!operation) return { state: "unknown" };
  if (ports.isStopped?.()) return { state: "stopped" };
  if (
    operation.state === "failed_partial" &&
    operation.failure?.code === "operation-input-expired"
  )
    return { state: "expired", operation, message: operation.failure.message };
  const data = await ports.readInput();
  if (ports.isStopped?.()) return { state: "stopped" };
  if (!ports.isCurrent(operation)) return { state: "mismatch" };
  if (
    !ports.canResumeInput(operation, {
      code,
      checkpoint: data.checkpoint,
      repo: data.repo,
      environment: data.environment,
      provider: data.provider
    })
  )
    return { state: "mismatch" };
  const request = operation.request || operation.resumeRequest;
  if (!isSetupRequest(request)) return { state: "request-unavailable" };
  if (
    code !== "service-management-reference-required" &&
    code !== "app-selection-required"
  )
    return { state: "unsupported" };
  const recovery = ports.captureRecovery(operation);
  if (!operation.request) operation.request = structuredClone(request);
  if (code === "service-management-reference-required") {
    operation.request.azure.serviceManagementReference =
      data.serviceManagementReference || "";
    if (operation.resumeRequest?.azure) {
      operation.resumeRequest.azure.serviceManagementReference =
        data.serviceManagementReference || "";
    }
  } else {
    operation.request.azure.appId = data.appId || "";
    operation.request.azure.createNew = data.createNew === true;
    if (operation.resumeRequest?.azure) {
      operation.resumeRequest.azure.appId = data.appId || "";
      operation.resumeRequest.azure.createNew = data.createNew === true;
    }
  }
  ports.resumeAfterInput(operation);
  recovery.prepared();
  const correct = async (
    result: SetupInputResumeResult<Operation>
  ): Promise<SetupInputResumeResult<Operation>> => {
    if (!recovery.restore()) return { state: "mismatch" };
    try {
      await ports.persist();
      return result;
    } catch (error) {
      recovery.failed(error);
      return { state: "recovery-persist-failed", error };
    }
  };
  try {
    await ports.persist();
  } catch (error) {
    return correct(
      ports.isCurrent(operation) ?
        { state: "persist-failed", error }
      : { state: "mismatch" }
    );
  }
  if (ports.isStopped?.()) return { state: "stopped" };
  if (!ports.isCurrent(operation)) return correct({ state: "mismatch" });
  ports.accepted();
  if (!ports.schedule(operation)) await ports.schedulingFailed(operation);
  return { state: "accepted" };
}
