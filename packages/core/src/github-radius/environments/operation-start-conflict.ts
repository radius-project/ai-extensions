export interface SetupStartConflict {
  reason?: "operation-in-progress" | "previous-cleanup-required";
  conflict: { operationId: string };
}

export interface SetupStartConflictResponse extends Record<string, unknown> {
  error: string;
  code: "operation-in-progress" | "previous-cleanup-required";
  operationId: string;
}

export function setupStartConflictResponse(
  repo: string,
  started: SetupStartConflict
): SetupStartConflictResponse {
  if (started.reason === "previous-cleanup-required") {
    return {
      error: `An earlier setup for ${repo} must finish deletion before a new setup can start.`,
      code: "previous-cleanup-required",
      operationId: started.conflict.operationId
    };
  }
  return {
    error: `Setup is already running for ${repo}.`,
    code: "operation-in-progress",
    operationId: started.conflict.operationId
  };
}
