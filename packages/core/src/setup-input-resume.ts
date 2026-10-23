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
  | { state: "persist-failed"; error: unknown };

export interface SetupInputResumePorts<Operation extends SetupResumeOperation> {
  isStopped?(): boolean;
  isCurrent(operation: Operation): boolean;
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
  requireInput(operation: Operation, input: unknown): void;
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
  if (!operation.request && operation.resumeRequest) {
    operation.request = structuredClone(operation.resumeRequest);
  }
  const snapshot = {
    inputRequired: structuredClone(operation.inputRequired),
    request:
      operation.request !== undefined ?
        structuredClone(operation.request)
      : undefined,
    resumeRequest:
      operation.resumeRequest ?
        structuredClone(operation.resumeRequest)
      : undefined
  };
  if (!isSetupRequest(operation.request))
    return { state: "request-unavailable" };
  const request = operation.request;
  if (code === "service-management-reference-required") {
    request.azure.serviceManagementReference =
      data.serviceManagementReference || "";
    if (operation.resumeRequest?.azure) {
      operation.resumeRequest.azure.serviceManagementReference =
        data.serviceManagementReference || "";
    }
  } else if (code === "app-selection-required") {
    request.azure.appId = data.appId || "";
    request.azure.createNew = data.createNew === true;
    if (operation.resumeRequest?.azure) {
      operation.resumeRequest.azure.appId = data.appId || "";
      operation.resumeRequest.azure.createNew = data.createNew === true;
    }
  } else return { state: "unsupported" };
  ports.resumeAfterInput(operation);
  try {
    await ports.persist();
  } catch (error) {
    if (!ports.isCurrent(operation)) return { state: "mismatch" };
    operation.request = snapshot.request;
    if (snapshot.resumeRequest === undefined) delete operation.resumeRequest;
    else operation.resumeRequest = snapshot.resumeRequest;
    ports.requireInput(operation, snapshot.inputRequired);
    return { state: "persist-failed", error };
  }
  if (ports.isStopped?.()) return { state: "stopped" };
  if (!ports.isCurrent(operation)) return { state: "mismatch" };
  ports.accepted();
  if (!ports.schedule(operation)) await ports.schedulingFailed(operation);
  return { state: "accepted" };
}
