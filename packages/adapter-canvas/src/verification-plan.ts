import { hasVerificationOperationMarker } from "./verification-run-identity.js";
import { githubCredentialSourceLabel } from "./github-credential-source.js";
import { parse as parseYaml } from "yaml";

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

export interface WorkflowFileReadResult {
  content: string | null;
  error: string | null;
  status: number | null;
}

export type AutomaticBranchVerificationPolicy =
  | { state: "enabled" }
  | {
      state: "disabled";
      reason:
        | "verify-present"
        | "verify-unreadable"
        | "dispatcher-legacy-chain"
        | "dispatcher-unreadable"
        | "legacy-deploy-present"
        | "legacy-deploy-unreadable";
    };

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

export function automaticBranchVerificationPolicy(input: {
  verify: WorkflowFileReadResult;
  dispatcher: WorkflowFileReadResult;
  legacyDeploy: WorkflowFileReadResult;
}): AutomaticBranchVerificationPolicy {
  const fileState = (
    result: WorkflowFileReadResult
  ): "present" | "absent" | "unreadable" => {
    if (typeof result.content === "string" && result.content.trim())
      return "present";
    return result.status === 404 ? "absent" : "unreadable";
  };
  const legacyDeployState = fileState(input.legacyDeploy);
  if (legacyDeployState === "present") {
    return { state: "disabled", reason: "legacy-deploy-present" };
  }
  if (legacyDeployState === "unreadable") {
    return { state: "disabled", reason: "legacy-deploy-unreadable" };
  }
  const verifyState = fileState(input.verify);
  if (verifyState === "unreadable") {
    return { state: "disabled", reason: "verify-unreadable" };
  }
  const dispatcherState = fileState(input.dispatcher);
  if (dispatcherState === "unreadable") {
    return { state: "disabled", reason: "dispatcher-unreadable" };
  }
  if (dispatcherState === "present") {
    try {
      const parsed: unknown = parseYaml(input.dispatcher.content || "");
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        !("on" in parsed) ||
        !parsed.on ||
        typeof parsed.on !== "object" ||
        Array.isArray(parsed.on)
      ) {
        return { state: "disabled", reason: "dispatcher-unreadable" };
      }
      if (Object.prototype.hasOwnProperty.call(parsed.on, "workflow_run")) {
        return { state: "disabled", reason: "dispatcher-legacy-chain" };
      }
    } catch {
      return { state: "disabled", reason: "dispatcher-unreadable" };
    }
  }
  if (verifyState === "present") {
    return { state: "disabled", reason: "verify-present" };
  }
  return { state: "enabled" };
}

export function automaticBranchVerificationPolicyMessage(
  policy: AutomaticBranchVerificationPolicy
): string {
  if (policy.state === "enabled" || policy.reason === "verify-present")
    return "";
  if (policy.reason === "verify-unreadable")
    return "Radius could not safely read the default branch's credential verification workflow.";
  if (policy.reason === "dispatcher-legacy-chain")
    return "The default branch's deploy dispatcher can still auto-run after credential verification.";
  if (policy.reason === "dispatcher-unreadable")
    return "Radius could not safely inspect the default branch's deploy dispatcher for automatic triggers.";
  if (policy.reason === "legacy-deploy-present")
    return "The default branch still contains the legacy deploy workflow, which can auto-run after credential verification.";
  return "Radius could not safely confirm that the default branch's legacy deploy workflow is absent.";
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
// cloud credentials, and the dispatch have all had their say. Verification has
// two independent blockers, the workflows not being on the default branch and
// the cloud credentials being incomplete, and either, both, or neither can
// hold. Collapsing them loses the case where merging is necessary but not
// sufficient, and tells that customer the merge alone will start verification.
export type PullRequestNextStep =
  | "verification-running"
  | "awaiting-merge"
  | "awaiting-credentials"
  | "awaiting-merge-and-credentials";

// The pull-request guidance and the verification outcome are the same answer
// told twice, so they are derived from one decision rather than predicted
// before `planCredentialVerification`, the credential check, and the dispatch
// have made it. Only `awaiting-merge` may promise that merging starts
// verification, because it is the only case where the merge is the last thing
// standing in the way.
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
  if (outcome === "awaiting-merge-and-credentials")
    return `Merge the pull request above to put the workflows on "${baseBranch}", and finish the cloud credentials above. Credential verification is waiting on both, so merging alone will not start it.`;
  return `Merge the pull request above to put the workflows on "${baseBranch}", then retry credential verification.`;
}

// The terminal message the customer reads in the panel headline and the
// operation chip, which must agree with the step above rather than making the
// promise the step just withdrew. Only reached when the merge is outstanding,
// so it turns on whether the credentials are outstanding too.
export function describeMergeRequiredTerminal({
  outcome,
  branch,
  baseBranch,
  hasPullRequest
}: {
  outcome: PullRequestNextStep;
  branch: string;
  baseBranch: string;
  hasPullRequest: boolean;
}): string {
  const alsoCredentials = outcome === "awaiting-merge-and-credentials";
  if (hasPullRequest)
    return alsoCredentials ?
        "Merge the pull request and finish the cloud credentials to complete setup. Credential verification is waiting on both, so merging alone will not start it."
      : "Merge the pull request, then retry credential verification to finish setup.";
  return alsoCredentials ?
      `Open and merge a pull request from "${branch}" into "${baseBranch}", and finish the cloud credentials, to complete setup. Credential verification is waiting on both, so merging alone will not start it.`
    : `Open and merge a pull request from "${branch}" into "${baseBranch}" to finish setup.`;
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
