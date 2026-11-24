import { confirmedWorkflowConclusion } from "@radius-project/core";
import type {
  DeploymentAdmissionKey,
  StoredDeploymentAdmission
} from "./deployment-admission-store.js";

export function exactTerminalDeploymentRun(
  value: unknown,
  expected: {
    repo: string;
    repositoryId?: number;
    runId: number;
    workflow: string;
    title?: string;
  }
): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    "id" in value &&
    value.id === expected.runId &&
    "repository" in value &&
    value.repository &&
    typeof value.repository === "object" &&
    "full_name" in value.repository &&
    typeof value.repository.full_name === "string" &&
    value.repository.full_name.toLowerCase() === expected.repo.toLowerCase() &&
    (expected.repositoryId === undefined ||
      ("id" in value.repository &&
        value.repository.id === expected.repositoryId)) &&
    "run_attempt" in value &&
    value.run_attempt === 1 &&
    "event" in value &&
    value.event === "workflow_dispatch" &&
    "path" in value &&
    value.path === `.github/workflows/${expected.workflow}` &&
    (expected.title === undefined ||
      ("display_title" in value && value.display_title === expected.title)) &&
    "status" in value &&
    typeof value.status === "string" &&
    "conclusion" in value &&
    typeof value.conclusion === "string" &&
    confirmedWorkflowConclusion({
      status: value.status,
      conclusion: value.conclusion
    })
  );
}

export async function reconcileDeploymentAdmission(
  input: {
    key: DeploymentAdmissionKey;
    repo: string;
    account: string;
    workflow: string;
    pending: StoredDeploymentAdmission;
  },
  ports: {
    discover(
      correlation: string,
      since: number,
      workflow: string
    ): Promise<number | null>;
    readRun(runId: number): Promise<unknown>;
    release(key: DeploymentAdmissionKey, nonce: string): Promise<boolean>;
  }
): Promise<boolean> {
  const { key, repo, account, pending } = input;
  const { record } = pending;
  if (
    record.deploymentId &&
    account.toLowerCase() !== record.account.toLowerCase()
  )
    return false;
  const workflow = record.workflow ?? input.workflow;
  const runId = await ports.discover(
    record.correlation,
    record.startedAt,
    workflow
  );
  if (runId === null || !Number.isSafeInteger(runId) || runId < 1) return false;
  if (
    !exactTerminalDeploymentRun(await ports.readRun(runId), {
      repo,
      repositoryId: key.repositoryId,
      runId,
      workflow,
      title: deploymentAdmissionRunTitle(workflow, record)
    })
  )
    return false;
  return ports.release(key, pending.nonce);
}

export function deploymentAdmissionRunTitle(
  workflow: string,
  record: { environment: string; application: string; correlation: string }
): string {
  const verb = workflow === "run-rad-commands.yml" ? "Deploy" : "Delete";
  return `Radius - ${verb} ${record.environment} [radius:v1 app=${record.application}] ${record.correlation}`;
}
