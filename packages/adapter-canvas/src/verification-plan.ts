import { setupAutomaticBranchVerificationPolicy } from "@radius-project/core";
import { githubCredentialSourceLabel } from "./github-credential-source.js";
import { parse as parseYaml } from "yaml";

export type {
  PullRequestState,
  CredentialVerificationPlan
} from "@radius-project/core";
export {
  hasWorkflowRunTrigger,
  planCredentialVerification
} from "@radius-project/core";

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

export function automaticBranchVerificationPolicy(input: {
  verify: WorkflowFileReadResult;
  dispatcher: WorkflowFileReadResult;
  legacyDeploy: WorkflowFileReadResult;
}): AutomaticBranchVerificationPolicy {
  return setupAutomaticBranchVerificationPolicy(input, parseYaml);
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
