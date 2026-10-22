/** Extracts an owned Actions run id without accepting another repository. */
export function requireWorkflowRunId(
  runUrl: string,
  repository: string
): string {
  const expectedPrefix = `https://github.com/${repository}/actions/runs/`;
  if (!runUrl.startsWith(expectedPrefix))
    throw new Error(
      `The lifecycle operation did not report a workflow run in ${repository}.`
    );
  const runId = runUrl.slice(expectedPrefix.length);
  if (!/^[1-9][0-9]*$/.test(runId))
    throw new Error(
      `The lifecycle operation reported an invalid workflow run URL: ${runUrl}`
    );
  return runId;
}

/** Older gh versions emit no dispatch URL and need snapshot discovery. */
export function readWorkflowDispatchRunId(
  output: string,
  repository: string
): string | undefined {
  const runUrl = output.trim();
  return runUrl ? requireWorkflowRunId(runUrl, repository) : undefined;
}

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
