export const VERIFY_OPERATION_INPUT = "radius_operation";

export interface PullRequestState {
  branch: string;
  base?: string;
}

export interface CredentialVerificationPlan {
  shouldDispatch: boolean;
  trigger: "workflow_dispatch" | "push" | "none";
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

export function hasVerificationOperationMarker(workflow: unknown): boolean {
  return (
    typeof workflow === "string" &&
    workflow.includes(`${VERIFY_OPERATION_INPUT}:`) &&
    workflow.includes(`inputs.${VERIFY_OPERATION_INPUT}`)
  );
}

export async function planCredentialVerification({
  targetRepo,
  defaultBranch,
  prState,
  pullRequestUrl = "",
  verifyWorkflowPath = ".github/workflows/radius-verify-credentials.yml",
  dispatcherWorkflowPath = ".github/workflows/run-rad-commands.yml",
  automaticPushEnabled = false,
  branchVerificationAllowed = true,
  fetchFile
}: {
  targetRepo: string;
  defaultBranch: string;
  prState: PullRequestState | null;
  pullRequestUrl?: string;
  verifyWorkflowPath?: string;
  dispatcherWorkflowPath?: string;
  automaticPushEnabled?: boolean;
  branchVerificationAllowed?: boolean;
  fetchFile: FetchFile;
}): Promise<CredentialVerificationPlan> {
  if (!prState) {
    // The dispatch runs against the default branch here, so the workflow that
    // will validate the marker input is the copy on that branch. Assuming
    // support would send `-f radius_operation` to a workflow that may not
    // declare it, and GitHub answers that with a 422 the journal reads as a
    // conclusive refusal — failing setup with a message about the dispatch
    // rather than the template.
    const directWorkflow = await fetchFile(
      targetRepo,
      verifyWorkflowPath,
      defaultBranch
    );
    return {
      shouldDispatch: true,
      trigger: "workflow_dispatch",
      ref: defaultBranch,
      defaultBranch,
      pullRequestUrl: "",
      skipReason: "",
      supportsOperationMarker: hasVerificationOperationMarker(directWorkflow)
    };
  }

  if (automaticPushEnabled) {
    return {
      shouldDispatch: false,
      trigger: "push",
      ref: prState.branch,
      defaultBranch,
      pullRequestUrl: "",
      skipReason: "",
      supportsOperationMarker: true
    };
  }

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
  } else if (!branchVerificationAllowed) {
    skipReason =
      "default-branch workflow safety could not be established for setup-branch verification";
  }

  const shouldDispatch =
    branchVerificationAllowed && verifyExists && !dispatcherChains;
  return {
    shouldDispatch,
    trigger: shouldDispatch ? "workflow_dispatch" : "none",
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
