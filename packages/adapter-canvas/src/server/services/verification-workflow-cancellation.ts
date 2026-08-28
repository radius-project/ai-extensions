import type { SelectedGhExecutor } from "../../gh.js";
import type { VerificationWorkflowState } from "../../operations.js";

const ACTIVE_WORKFLOW_STATUSES = new Set([
  "queued",
  "in_progress",
  "requested",
  "waiting",
  "pending"
]);
const INACTIVE_WORKFLOW_STATUSES = new Set(["completed"]);

export interface VerificationWorkflowIdentity {
  repo: string;
  runId: string;
}

export interface VerificationWorkflowCancellationDependencies {
  run(
    executor: SelectedGhExecutor,
    args: string[]
  ): Promise<{ code: string | number; stdout: string; stderr: string }>;
}

function commandError(result: { stdout: string; stderr: string }): string {
  return (
    (result.stderr || result.stdout || "").trim() ||
    "GitHub CLI request failed."
  );
}

export function readVerificationWorkflowIdentity(operation: {
  repo?: unknown;
  verification?: unknown;
  [key: string]: unknown;
}): VerificationWorkflowIdentity | null {
  const repo = typeof operation.repo === "string" ? operation.repo.trim() : "";
  const verification =
    (
      operation.verification &&
      typeof operation.verification === "object" &&
      "runId" in operation.verification
    ) ?
      operation.verification
    : null;
  const runId =
    !verification || verification.runId == null ?
      ""
    : String(verification.runId).trim();
  return repo && runId ? { repo, runId } : null;
}

export function requireVerificationWorkflowIdentity(operation: {
  repo?: unknown;
  verification?: unknown;
  [key: string]: unknown;
}): VerificationWorkflowIdentity {
  const identity = readVerificationWorkflowIdentity(operation);
  if (!identity) {
    throw new Error(
      "The interrupted setup does not record an exact workflow run."
    );
  }
  return identity;
}

export async function readVerificationWorkflowState(
  executor: SelectedGhExecutor,
  identity: VerificationWorkflowIdentity,
  dependencies: Pick<VerificationWorkflowCancellationDependencies, "run">
): Promise<VerificationWorkflowState> {
  const result = await dependencies.run(executor, [
    "run",
    "view",
    identity.runId,
    "--json",
    "status",
    "--repo",
    identity.repo
  ]);
  if (result.code !== 0 && result.code !== "0") {
    throw new Error(commandError(result));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("GitHub returned an unreadable workflow status.");
  }
  const status =
    (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { status?: unknown }).status === "string"
    ) ?
      (parsed as { status: string }).status
    : "";
  if (!status) throw new Error("GitHub returned no workflow status.");
  if (ACTIVE_WORKFLOW_STATUSES.has(status)) return "active";
  if (INACTIVE_WORKFLOW_STATUSES.has(status)) return "inactive";
  throw new Error(`GitHub returned unsupported workflow status "${status}".`);
}

export async function cancelVerificationWorkflow(
  executor: SelectedGhExecutor,
  identity: VerificationWorkflowIdentity,
  dependencies: VerificationWorkflowCancellationDependencies
): Promise<"inactive" | "cancelling"> {
  if (
    (await readVerificationWorkflowState(executor, identity, dependencies)) ===
    "inactive"
  ) {
    return "inactive";
  }
  const cancelled = await dependencies.run(executor, [
    "api",
    "--method",
    "POST",
    `repos/${identity.repo}/actions/runs/${identity.runId}/cancel`
  ]);
  if (cancelled.code !== 0 && cancelled.code !== "0") {
    const state = await readVerificationWorkflowState(
      executor,
      identity,
      dependencies
    );
    if (state === "inactive") return "inactive";
    throw new Error(commandError(cancelled));
  }
  return "cancelling";
}
