import type { SelectedGhExecutor } from "../../gh.js";

export async function readApplicationDeletionHistory(
  executor: SelectedGhExecutor,
  target: {
    repo: string;
    environment: string;
    deploymentId: string;
    runId: number;
  },
  assertCurrent: () => void
): Promise<string> {
  const unavailable = () =>
    new Error(
      "GitHub deployment history could not be verified. No deletion was started."
    );
  const base = `/repos/${target.repo}/deployments`;
  const history = `${base}?environment=${encodeURIComponent(target.environment)}&per_page=10`;
  async function readFirst(
    path: string
  ): Promise<{ record: object; id: number }> {
    assertCurrent();
    const result = await executor
      .run(["api", path], { timeout: 10000, beforeExecute: assertCurrent })
      .catch(() => {
        throw unavailable();
      });
    if (result.code !== 0) throw unavailable();
    let value: unknown;
    try {
      value = JSON.parse(result.stdout);
    } catch {
      throw unavailable();
    }
    if (!Array.isArray(value) || value.length === 0) throw unavailable();
    const record: unknown = value[0];
    if (
      !record ||
      typeof record !== "object" ||
      !("id" in record) ||
      typeof record.id !== "number" ||
      !Number.isSafeInteger(record.id) ||
      record.id <= 0
    )
      throw unavailable();
    return { record, id: record.id };
  }
  async function checkHead() {
    // Read in GitHub's order, just as the provider guard does. A different
    // first record may own newer state regardless of its workflow or ID.
    const current = String((await readFirst(history)).id);
    if (current !== target.deploymentId)
      throw new Error(
        `GitHub deployment ${current} is the first record in this environment's history, not the selected deployment. Chat deletion is blocked; refreshing the Radius listing alone will not clear this record.`
      );
  }
  await checkHead();
  const { record: status, id: statusId } = await readFirst(
    `${base}/${target.deploymentId}/statuses?per_page=1`
  );
  const state = "state" in status ? status.state : undefined;
  const url =
    ("log_url" in status && status.log_url) ||
    ("target_url" in status && status.target_url);
  const prefix = `https://github.com/${target.repo}/actions/runs/${target.runId}`;
  if (
    typeof url !== "string" ||
    !url.toLowerCase().startsWith(prefix.toLowerCase()) ||
    !/^(?:\/job\/[1-9]\d*)?\/?$/.test(url.slice(prefix.length)) ||
    (state !== "success" && state !== "failure" && state !== "error")
  )
    throw unavailable();
  // Fence a new head arriving while the selected deployment's status was read.
  await checkHead();
  return `${statusId}:${state}`;
}
