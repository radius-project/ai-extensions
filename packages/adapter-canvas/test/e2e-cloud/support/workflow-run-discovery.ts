/** Narrows `gh run list --json databaseId` for exact pre-dispatch snapshots. */
export function readWorkflowRunIds(payload: unknown): ReadonlySet<string> {
  if (!Array.isArray(payload))
    throw new Error("The workflow run listing was not a JSON array.");
  const ids = new Set<string>();
  for (const [index, value] of payload.entries()) {
    const record = asRecord(value);
    const id = record?.databaseId;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)
      throw new Error(
        `The workflow run listing carried an invalid database id at index ${index}.`
      );
    ids.add(String(id));
  }
  return ids;
}

/** Returns the only post-dispatch run, refusing ambiguous concurrent dispatches. */
export function findNewWorkflowRunId(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>
): string | undefined {
  const added = [...after].filter((runId) => !before.has(runId));
  if (added.length > 1)
    throw new Error(
      `Workflow run discovery found ${added.length} new runs and cannot prove which one this journey owns.`
    );
  return added[0];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined;
}
