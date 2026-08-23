import { hasVerificationOperationMarker } from "./verification-run-identity.js";

export interface PullRequestState {
  branch: string;
  base?: string;
}

export interface CredentialVerificationPlan {
  shouldDispatch: boolean;
  ref: string;
  defaultBranch: string;
  dispatcherChains?: boolean;
  pullRequestUrl: string;
  skipReason: string;
  supportsOperationMarker: boolean;
}

type FetchFile = (
  repo: string,
  path: string,
  branch: string
) => Promise<string | null | undefined>;

export function hasWorkflowRunTrigger(workflow: unknown): boolean {
  if (typeof workflow !== "string") return false;
  const lines = workflow.split(/\r?\n/);
  const jobs = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  const end = jobs < 0 ? lines.length : jobs;
  return lines.slice(0, end).some((line) => /^\s+workflow_run:\s*$/.test(line));
}

export async function planCredentialVerification({
  targetRepo,
  prState,
  pullRequestUrl = "",
  verifyWorkflowPath = ".github/workflows/radius-verify-credentials.yml",
  dispatcherWorkflowPath = ".github/workflows/run-rad-commands.yml",
  fetchFile,
  resolveDefaultBranch
}: {
  targetRepo: string;
  prState: PullRequestState | null;
  pullRequestUrl?: string;
  verifyWorkflowPath?: string;
  dispatcherWorkflowPath?: string;
  fetchFile: FetchFile;
  resolveDefaultBranch: (repo: string) => Promise<string | null | undefined>;
}): Promise<CredentialVerificationPlan> {
  if (!prState) {
    return {
      shouldDispatch: true,
      ref: "",
      defaultBranch: "",
      pullRequestUrl: "",
      skipReason: "",
      supportsOperationMarker: true
    };
  }

  const defaultBranch =
    (await resolveDefaultBranch(targetRepo)) || prState.base || "main";
  const [verifyWorkflow, dispatcherWorkflow] = await Promise.all([
    fetchFile(targetRepo, verifyWorkflowPath, defaultBranch),
    fetchFile(targetRepo, dispatcherWorkflowPath, defaultBranch)
  ]);
  const verifyExists = verifyWorkflow !== null && verifyWorkflow !== undefined;
  const dispatcherChains = hasWorkflowRunTrigger(dispatcherWorkflow);

  let skipReason = "";
  if (!verifyExists) {
    skipReason = "the verify workflow is not on the default branch yet";
  } else if (dispatcherChains) {
    skipReason = `the deploy workflow on "${defaultBranch}" still auto-runs after verification; merge the pull request to remove that deployment trigger before retrying verification`;
  }

  const shouldDispatch = verifyExists && !dispatcherChains;
  return {
    shouldDispatch,
    ref: prState.branch,
    defaultBranch,
    dispatcherChains,
    pullRequestUrl: shouldDispatch ? "" : pullRequestUrl,
    skipReason,
    supportsOperationMarker: hasVerificationOperationMarker(verifyWorkflow)
  };
}

export function buildVerifyWorkflowDispatchArgs({
  workflowFile,
  targetRepo,
  envName,
  ref = "",
  operationMarker = ""
}: {
  workflowFile: string;
  targetRepo: string;
  envName: string;
  ref?: string;
  operationMarker?: string;
}): string[] {
  return [
    "workflow",
    "run",
    workflowFile,
    "-f",
    "environment=" + envName,
    ...(operationMarker ? ["-f", "radius_operation=" + operationMarker] : []),
    "--repo",
    targetRepo,
    ...(ref ? ["--ref", ref] : [])
  ];
}
