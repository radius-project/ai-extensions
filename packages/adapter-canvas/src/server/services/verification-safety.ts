import type { SelectedGhExecutor } from "../../gh.js";
import {
  planCredentialVerification,
  type WorkflowFileReadResult
} from "../../verification-plan.js";

export function createVerificationSafety(deps: {
  fetchFile(
    executor: SelectedGhExecutor,
    repo: string,
    path: string,
    branch: string
  ): Promise<string | null | undefined>;
  fetchFileResult(
    executor: SelectedGhExecutor,
    repo: string,
    path: string,
    branch: string
  ): Promise<WorkflowFileReadResult>;
}) {
  if (
    typeof deps.fetchFile !== "function" ||
    typeof deps.fetchFileResult !== "function"
  )
    throw new Error(
      "Verification safety requires selected-account workflow readers."
    );
  return async (
    executor: SelectedGhExecutor,
    repo: string
  ): Promise<string | null> => {
    const observed = await executor.run(
      ["api", `/repos/${repo}`, "--jq", ".default_branch"],
      { timeout: 15000 }
    );
    const branch = observed.stdout.trim();
    if (observed.code !== 0 || !branch)
      return "Radius could not establish the repository's default branch; no deployment was authorized.";
    const plan = await planCredentialVerification({
      targetRepo: repo,
      defaultBranch: branch,
      prState: null,
      fetchFile: (targetRepo, path, ref) =>
        deps.fetchFile(executor, targetRepo, path, ref),
      fetchFileResult: (targetRepo, path, ref) =>
        deps.fetchFileResult(executor, targetRepo, path, ref)
    });
    return plan.shouldDispatch ? null : plan.skipReason;
  };
}
