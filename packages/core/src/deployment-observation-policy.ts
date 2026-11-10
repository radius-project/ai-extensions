interface WorkflowRun {
  databaseId?: number;
  createdAt?: string;
  displayTitle?: string;
}

function parseWorkflowRun(value: unknown): WorkflowRun | null {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  return {
    databaseId:
      "databaseId" in value && typeof value.databaseId === "number" ?
        value.databaseId
      : undefined,
    createdAt:
      "createdAt" in value && typeof value.createdAt === "string" ?
        value.createdAt
      : undefined,
    displayTitle:
      "displayTitle" in value && typeof value.displayTitle === "string" ?
        value.displayTitle
      : undefined
  };
}

function numericRunId(
  value: number | string | null | undefined
): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function selectLatestWorkflowRunId(runs: unknown): number | null {
  if (!Array.isArray(runs)) return null;
  let max: number | null = null;
  for (const value of runs) {
    const run = parseWorkflowRun(value);
    if (run?.databaseId === undefined) continue;
    if (max === null || run.databaseId > max) max = run.databaseId;
  }
  return max;
}

/** Correlation identifies an execution; a baseline only excludes older runs. */
export function selectDeploymentWorkflowRunId(
  runs: unknown,
  sinceMs: number,
  correlationId?: string | null,
  afterRunId?: number | string | null
): number | string | null {
  if (!Array.isArray(runs)) return null;
  const baseline = numericRunId(afterRunId);
  if (correlationId) {
    const matches = new Set<number>();
    for (const value of runs) {
      const run = parseWorkflowRun(value);
      const id = run?.databaseId;
      if (
        id === undefined ||
        !Number.isSafeInteger(id) ||
        id <= 0 ||
        (baseline !== null && id <= baseline) ||
        run?.displayTitle?.trim().split(/\s+/).pop() !== correlationId
      )
        continue;
      matches.add(id);
    }
    return matches.size === 1 ? [...matches][0] : null;
  }
  if (baseline !== null) {
    let firstRunId: number | null = null;
    for (const value of runs) {
      const run = parseWorkflowRun(value);
      if (run?.databaseId === undefined) continue;
      if (
        run.databaseId > baseline &&
        (firstRunId === null || run.databaseId < firstRunId)
      )
        firstRunId = run.databaseId;
    }
    return firstRunId;
  }
  const cutoff = (sinceMs || 0) - 60000;
  for (const value of runs) {
    const run = parseWorkflowRun(value);
    if (!run) continue;
    const created = Date.parse(run.createdAt || "") || 0;
    if (created < cutoff || run.databaseId === undefined) continue;
    return run.databaseId;
  }
  return null;
}
