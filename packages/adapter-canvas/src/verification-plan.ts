import { hasVerificationOperationMarker } from "./verification-run-identity.js";
import { githubCredentialSourceLabel } from "./github-credential-source.js";

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
  defaultBranch,
  prState,
  pullRequestUrl = "",
  verifyWorkflowPath = ".github/workflows/radius-verify-credentials.yml",
  dispatcherWorkflowPath = ".github/workflows/run-rad-commands.yml",
  fetchFile
}: {
  targetRepo: string;
  defaultBranch: string;
  prState: PullRequestState | null;
  pullRequestUrl?: string;
  verifyWorkflowPath?: string;
  dispatcherWorkflowPath?: string;
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
      ref: defaultBranch,
      defaultBranch,
      pullRequestUrl: "",
      skipReason: "",
      supportsOperationMarker: hasVerificationOperationMarker(directWorkflow)
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

export function describeVerificationDispatch({
  login,
  credentialSource,
  workflowFile,
  targetRepo,
  envName,
  ref
}: {
  login: string;
  credentialSource: "injected" | "keyring";
  workflowFile: string;
  targetRepo: string;
  envName: string;
  ref: string;
}): string {
  return (
    `Credential verification dispatch is configured for @${login} using ${githubCredentialSourceLabel(credentialSource)}: ` +
    `workflow "${workflowFile}", environment "${envName}", repository "${targetRepo}", ref "${ref}".`
  );
}

// What the customer's pull request is actually waiting on, once the plan, the
// cloud credentials, and the dispatch have all had their say. The three cases
// are distinct next actions, so a boolean would fold the credential blocker
// into the merge prompt and tell the customer to merge when merging is not
// what unblocks them.
export type PullRequestNextStep =
  "verification-running" | "awaiting-merge" | "awaiting-credentials";

// The pull-request guidance and the verification outcome are the same answer
// told twice, so they are derived from one decision rather than predicted
// before `planCredentialVerification`, the credential check, and the dispatch
// have made it. Only `awaiting-merge` may promise that merging starts
// verification, because it is the only case where that is true.
export function describePullRequestNextStep({
  outcome,
  baseBranch,
  ref
}: {
  outcome: PullRequestNextStep;
  baseBranch: string;
  ref: string;
}): string {
  if (outcome === "verification-running")
    return `Credential verification is running against branch "${ref}", so it is not waiting for the merge. Merging the pull request above puts the workflows on "${baseBranch}".`;
  if (outcome === "awaiting-credentials")
    return `Merging the pull request above puts the workflows on "${baseBranch}", but credential verification is waiting on the cloud credentials above, not on the merge.`;
  return `Merge the pull request above to finish setup; credential verification and deploys run once it lands on "${baseBranch}".`;
}

export interface VerifyWorkflowRunIdentity {
  runId: string;
  runUrl: string;
}

export function parseVerifyWorkflowRunUrl(
  stdout: string,
  {
    targetRepo,
    host = "github.com"
  }: {
    targetRepo: string;
    host?: string;
  }
): VerifyWorkflowRunIdentity {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) {
    throw new Error("GitHub CLI did not return exactly one workflow run URL.");
  }
  const [owner, repo, extra] = targetRepo.split("/");
  if (!owner || !repo || extra) {
    throw new Error("The target GitHub repository is invalid.");
  }
  let parsed: URL;
  try {
    parsed = new URL(lines[0]);
  } catch {
    throw new Error("GitHub CLI returned a malformed workflow run URL.");
  }
  const expectedPath = `/${owner}/${repo}/actions/runs/`;
  const runId =
    parsed.pathname.startsWith(expectedPath) ?
      parsed.pathname.slice(expectedPath.length)
    : "";
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== host.toLowerCase() ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !/^[1-9]\d*$/.test(runId)
  ) {
    throw new Error(
      "GitHub CLI returned a workflow run URL for an unexpected location."
    );
  }
  return { runId, runUrl: parsed.toString() };
}
