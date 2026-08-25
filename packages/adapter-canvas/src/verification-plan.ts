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
    // The dispatch runs against the default branch here, so the workflow that
    // will validate the marker input is the copy on that branch. Assuming
    // support would send `-f radius_operation` to a workflow that may not
    // declare it, and GitHub answers that with a 422 the journal reads as a
    // conclusive refusal — failing setup with a message about the dispatch
    // rather than the template.
    const directBranch = (await resolveDefaultBranch(targetRepo)) || "main";
    const directWorkflow = await fetchFile(
      targetRepo,
      verifyWorkflowPath,
      directBranch
    );
    return {
      shouldDispatch: true,
      ref: "",
      defaultBranch: "",
      pullRequestUrl: "",
      skipReason: "",
      supportsOperationMarker: hasVerificationOperationMarker(directWorkflow)
    };
  }

  const defaultBranch =
    (await resolveDefaultBranch(targetRepo)) || prState.base || "main";
  // `verifyExists` and `dispatcherChains` are questions about the default
  // branch: whether the workflow has landed, and whether merging would chain a
  // deploy off it. Marker support is a question about the ref the dispatch
  // actually runs at, because GitHub validates `workflow_dispatch` inputs
  // there — and that ref is the branch this request just committed to.
  const [verifyWorkflow, dispatcherWorkflow, dispatchRefWorkflow] =
    await Promise.all([
      fetchFile(targetRepo, verifyWorkflowPath, defaultBranch),
      fetchFile(targetRepo, dispatcherWorkflowPath, defaultBranch),
      prState.branch && prState.branch !== defaultBranch ?
        fetchFile(targetRepo, verifyWorkflowPath, prState.branch)
      : Promise.resolve(null)
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
    supportsOperationMarker: hasVerificationOperationMarker(
      dispatchRefWorkflow ?? verifyWorkflow
    )
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
