export const VERIFY_OPERATION_INPUT = "radius_operation";
export type VerificationRunEvent = "workflow_dispatch" | "push";

export function verificationRunTitle(
  environment: string,
  operationMarker: string
): string {
  return `Radius verify ${environment} [${operationMarker}]`;
}

export function hasVerificationOperationMarker(workflow: unknown): boolean {
  return (
    typeof workflow === "string" &&
    workflow.includes(`${VERIFY_OPERATION_INPUT}:`) &&
    workflow.includes(`inputs.${VERIFY_OPERATION_INPUT}`)
  );
}

export function findExactVerificationRun(
  value: unknown,
  identity: {
    baselineRunId: number | null;
    dispatchedAt: number;
    ref: string;
    environment: string;
    operationMarker: string;
    event: VerificationRunEvent;
  }
):
  | { state: "applied"; runId: string }
  | { state: "not_found" }
  | { state: "ambiguous" } {
  if (!Array.isArray(value)) return { state: "not_found" };
  const expectedTitle = verificationRunTitle(
    identity.environment,
    identity.operationMarker
  );
  const matches = value.filter((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const run = candidate as Record<string, unknown>;
    const databaseId = Number(run.databaseId);
    return (
      Number.isFinite(databaseId) &&
      (identity.baselineRunId === null ||
        databaseId > identity.baselineRunId) &&
      typeof run.createdAt === "string" &&
      Date.parse(run.createdAt) >= identity.dispatchedAt - 60000 &&
      run.displayTitle === expectedTitle &&
      run.event === identity.event &&
      run.headBranch === identity.ref
    );
  });
  if (matches.length === 0) return { state: "not_found" };
  if (matches.length > 1) return { state: "ambiguous" };
  return {
    state: "applied",
    runId: String((matches[0] as Record<string, unknown>).databaseId)
  };
}

export function hasPostDispatchVerificationRuns(
  value: unknown,
  baselineRunId: number | null,
  dispatchedAt: number,
  options: {
    ref?: string;
    clockSkewMs?: number;
  } = {}
): boolean {
  const clockSkewMs = options.clockSkewMs ?? 60000;
  return (
    Array.isArray(value) &&
    value.some((candidate) => {
      if (!candidate || typeof candidate !== "object") return false;
      const run = candidate as Record<string, unknown>;
      const databaseId = Number(run.databaseId);
      return (
        Number.isFinite(databaseId) &&
        (baselineRunId === null || databaseId > baselineRunId) &&
        typeof run.createdAt === "string" &&
        Date.parse(run.createdAt) >= dispatchedAt - clockSkewMs &&
        (options.ref === undefined || run.headBranch === options.ref)
      );
    })
  );
}
