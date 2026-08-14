import { needsWorkflowScope } from "./create-environment-gh-runner.js";
import type {
  CreateEnvironmentCommandResult,
  PullRequestBranchState,
  WorkflowCommitOutcome
} from "./create-environment-types.js";

// Seam 3 of the `POST /api/create-environment` slice: committing workflow files.
//
// Workflow files are normally committed straight to the repo's default branch
// via the contents API. When that branch is protected (or the user otherwise
// lacks direct-push permission), the PUT fails; instead of aborting, we lazily
// create a feature branch, commit every workflow file there, and open a PR the
// user can merge. The PR link is surfaced in `steps`.

export interface WorkflowTempFilePort {
  // Writes the request body for `gh api --input` and returns its path.
  write(contents: string): string;
  // Best-effort removal; the legacy arm swallowed unlink failures.
  remove(path: string): void;
}

export interface WorkflowFileCommitterPorts {
  runGh(args: string[]): Promise<CreateEnvironmentCommandResult>;
  runGhWorkflow(args: string[]): Promise<CreateEnvironmentCommandResult>;
  getDefaultBranch(repo: string): Promise<string | null | undefined>;
  getBranchHeadSha(
    repo: string,
    branch: string
  ): Promise<string | null | undefined>;
  createBranchRef(
    repo: string,
    branch: string,
    sha: string
  ): Promise<{ ok: boolean; stderr: string }>;
  tempFile: WorkflowTempFilePort;
  errorMessage(error: unknown): string;
  pushStep(message: string): void;
  now(): number;
}

export interface WorkflowFileCommitterTarget {
  targetRepo: string;
  envName: string;
}

export interface WorkflowFileCommitter {
  // The lazily created PR branch, or undefined while commits still go direct.
  pullRequestState(): PullRequestBranchState | undefined;
  commitWorkflowFileSmart(
    path: string,
    contentB64: string,
    message: string
  ): Promise<WorkflowCommitOutcome>;
}

// A protected-branch / missing-write-access failure (as opposed to a missing
// `workflow` token scope, which a PR can't fix). Kept deliberately broad; branch
// creation gates the fallback, so a genuine no-access repo still surfaces the
// original error.
export function isProtectedBranchFailure(stderr: string): boolean {
  const s = stderr || "";
  if (needsWorkflowScope(s)) return false;
  return /HTTP 40[39]|protected branch|through a pull request|required status check|approving review|not have permission|Resource not accessible|refusing to allow|review is required|push declined|branch protection/i.test(
    s
  );
}

export function createWorkflowFileCommitter(
  ports: WorkflowFileCommitterPorts,
  target: WorkflowFileCommitterTarget
): WorkflowFileCommitter {
  // PR-fallback state; populated lazily on the first protected-branch failure.
  // Once set, every subsequent workflow commit targets the PR branch instead of
  // the default branch.
  let prState: PullRequestBranchState | undefined;

  const beginPrFallback = async (): Promise<PullRequestBranchState> => {
    if (prState) return prState;
    const base = (await ports.getDefaultBranch(target.targetRepo)) || "main";
    const baseSha = await ports.getBranchHeadSha(target.targetRepo, base);
    if (!baseSha)
      throw new Error(`could not resolve head of base branch "${base}"`);
    const branch = `radius/setup-${target.envName}-workflows-${ports.now()}`;
    const created = await ports.createBranchRef(
      target.targetRepo,
      branch,
      baseSha
    );
    if (!created.ok)
      throw new Error(
        `could not create branch "${branch}": ${created.stderr}`
      );
    prState = { branch, base };
    ports.pushStep(
      `ℹ️ No permission to push to "${base}" directly — committing workflows to branch "${branch}" and opening a pull request.`
    );
    return prState;
  };

  // Commit one workflow file via the contents API. `branch === ''` targets the
  // default branch. Looks up the existing blob SHA on the same ref so a
  // re-commit is an update rather than a rejected create. Returns the raw
  // runGhWorkflow result ({ code, stderr }).
  const putWorkflowContent = async (
    path: string,
    contentB64: string,
    message: string,
    branch = ""
  ): Promise<CreateEnvironmentCommandResult> => {
    const refQ = branch ? "?ref=" + encodeURIComponent(branch) : "";
    const shaRes = await ports.runGh([
      "api",
      "/repos/" + target.targetRepo + "/contents/" + path + refQ,
      "--jq",
      ".sha"
    ]);
    const sha = shaRes.code === 0 ? shaRes.stdout.trim() : "";
    const bodyObj = {
      message,
      content: contentB64,
      ...(branch ? { branch } : {}),
      ...(sha ? { sha } : {})
    };
    const tmp = ports.tempFile.write(JSON.stringify(bodyObj));
    const r = await ports.runGhWorkflow([
      "api",
      "--method",
      "PUT",
      "/repos/" + target.targetRepo + "/contents/" + path,
      "--input",
      tmp
    ]);
    ports.tempFile.remove(tmp);
    return r;
  };

  // Commit a workflow file, transparently switching to the PR branch (creating
  // it on first use) when the default branch rejects the push for permission
  // reasons. Returns { ok, stderr, viaPr }.
  const commitWorkflowFileSmart = async (
    path: string,
    contentB64: string,
    message: string
  ): Promise<WorkflowCommitOutcome> => {
    if (prState) {
      const r = await putWorkflowContent(
        path,
        contentB64,
        message,
        prState.branch
      );
      return { ok: r.code === 0, stderr: r.stderr, viaPr: true };
    }
    const direct = await putWorkflowContent(path, contentB64, message, "");
    if (direct.code === 0) return { ok: true, viaPr: false };
    if (isProtectedBranchFailure(direct.stderr)) {
      let fallback: PullRequestBranchState;
      try {
        fallback = await beginPrFallback();
        prState = fallback;
      } catch (e) {
        return {
          ok: false,
          stderr: `${direct.stderr} (PR fallback failed: ${ports.errorMessage(
            e
          )})`,
          viaPr: false
        };
      }
      const r = await putWorkflowContent(
        path,
        contentB64,
        message,
        fallback.branch
      );
      return { ok: r.code === 0, stderr: r.stderr, viaPr: true };
    }
    return { ok: false, stderr: direct.stderr, viaPr: false };
  };

  return {
    pullRequestState: () => prState,
    commitWorkflowFileSmart
  };
}
