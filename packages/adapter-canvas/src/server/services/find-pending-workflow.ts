import { selectDeploymentWorkflowRunId } from "@radius-project/core";

export async function findPendingWorkflow(
  read: (args: string[]) => Promise<unknown>,
  repo: string,
  workflow: string,
  correlation: string,
  since: number
): Promise<number | null> {
  const created = new Date(since).toISOString();
  const pages = await read([
    "api",
    `/repos/${repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&created=${encodeURIComponent(`>=${created}`)}&per_page=100`,
    "--paginate",
    "--slurp"
  ]);
  if (!Array.isArray(pages) || pages.length === 0)
    throw new Error("Could not verify the pending workflow history.");
  const runs: { databaseId: unknown; displayTitle: unknown }[] = [];
  for (const page of pages as unknown[]) {
    if (
      typeof page !== "object" ||
      !page ||
      !("workflow_runs" in page) ||
      !Array.isArray(page.workflow_runs)
    )
      throw new Error("Could not verify the pending workflow history.");
    for (const run of page.workflow_runs as unknown[]) {
      if (
        typeof run !== "object" ||
        !run ||
        !("id" in run) ||
        !("display_title" in run)
      )
        throw new Error("Could not verify the pending workflow history.");
      runs.push({ databaseId: run.id, displayTitle: run.display_title });
    }
  }
  if (runs.length >= 1000)
    throw new Error("Pending workflow history exceeds GitHub's search limit.");
  const candidate = selectDeploymentWorkflowRunId(runs, since, correlation);
  return typeof candidate === "number" ? candidate : null;
}
