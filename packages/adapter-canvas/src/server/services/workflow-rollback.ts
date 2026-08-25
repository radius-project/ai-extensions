import {
  verifySetupBranchHead,
  verifyWorkflowProvenance,
  type WorkflowCommitMode,
  type WorkflowFileVerdict,
  type WorkflowProvenancePorts,
  type WorkflowProvenanceRecord
} from "./workflow-provenance.js";
import type {
  SetupCleanupOutcome,
  SetupCleanupResult
} from "../../operations.js";

// Removing the workflow files an environment setup committed, when the customer
// has asked to roll the whole setup back.
//
// This is the only part of a rollback that writes to the customer's repository,
// so it runs first and it decides whether anything else may run at all. The
// contract the rest of the rollback depends on is narrow and absolute: unless
// every workflow file this operation committed is proven gone, or proven to be
// Radius's own work and then removed, the pass reports `blocked` and the GitHub
// environment and cloud identity behind those workflows stay exactly where they
// are. A repository left with an installed workflow whose identity was deleted
// is strictly worse than one that still has both.
//
// Two shapes of removal exist, because two shapes of commit exist:
//
//   * The workflows went to a setup branch whose pull request has not merged.
//     Nothing is installed in the customer's mainline, so the pull request is
//     closed and the branch deleted whole — but only while its head is still
//     the commit Radius left there.
//   * The workflows are on a branch the repository actually uses, either
//     because Radius committed to it directly or because the setup pull request
//     merged into it. Each file is reverted individually through a new commit:
//     restored to the blob it replaced, or deleted when Radius created it.

export type WorkflowRollbackMode =
  { kind: "delete_setup_branch"; branch: string } | { kind: "revert_files" };

/** One committed workflow file, with the labels the ledger records it under. */
export interface WorkflowRollbackFile extends WorkflowProvenanceRecord {
  target: string;
  identity: string;
}

export interface WorkflowRollbackCommitState {
  mode: WorkflowCommitMode;
  branch: string | null;
  baseBranch: string | null;
  pullRequestUrl: string | null;
  headSha: string | null;
}

export type MutationResult = { ok: true } | { ok: false; detail: string };

export type PullRequestState =
  | { status: "merged" | "open" | "closed"; number: number }
  | { status: "unknown"; detail: string };

export interface WorkflowRollbackPorts extends WorkflowProvenancePorts {
  readRepository(input: {
    repo: string;
  }): Promise<
    { status: "readable" } | { status: "unreadable"; detail: string }
  >;
  readPullRequest(input: {
    repo: string;
    pullRequestUrl: string;
  }): Promise<PullRequestState>;
  readBlob(input: {
    repo: string;
    sha: string;
  }): Promise<
    { ok: true; contentBase64: string } | { ok: false; detail: string }
  >;
  deleteFile(input: {
    repo: string;
    path: string;
    branch: string;
    blobSha: string;
    message: string;
  }): Promise<MutationResult>;
  restoreFile(input: {
    repo: string;
    path: string;
    branch: string;
    blobSha: string;
    contentBase64: string;
    message: string;
  }): Promise<MutationResult>;
  closePullRequest(input: {
    repo: string;
    number: number;
  }): Promise<MutationResult>;
  deleteBranch(input: {
    repo: string;
    branch: string;
  }): Promise<MutationResult>;
}

export interface WorkflowRollbackOutcome {
  results: SetupCleanupResult[];
  warnings: string[];
  steps: string[];
  /** True when the caller must not remove anything the workflows depend on. */
  blocked: boolean;
}

export interface WorkflowRollbackInput {
  repo: string;
  attempt: number;
  commit: WorkflowRollbackCommitState;
  files: readonly WorkflowRollbackFile[];
}

/**
 * Which removal shape applies, given what the pull request actually did.
 *
 * Deleting the branch is only correct while every recorded file lives on it and
 * the pull request has not landed. A merged pull request means the workflows
 * are installed on a branch the repository uses, so deleting the setup branch
 * would remove nothing that matters. The caller rejects an unreadable pull
 * request before selecting either mutation mode.
 */
export function selectWorkflowRollbackMode(
  commit: WorkflowRollbackCommitState,
  files: readonly WorkflowRollbackFile[],
  pullRequest: PullRequestState | null
): WorkflowRollbackMode {
  const branch = commit.branch;
  if (commit.mode !== "pull_request" || !branch)
    return { kind: "revert_files" };
  const allOnSetupBranch = files.every(
    (file) => file.mode === "pull_request" && file.branch === branch
  );
  if (!allOnSetupBranch) return { kind: "revert_files" };
  // A pull request Radius could not open at all still leaves a branch it wrote,
  // and deleting that branch is the whole rollback.
  if (!pullRequest) return { kind: "delete_setup_branch", branch };
  return pullRequest.status === "open" || pullRequest.status === "closed" ?
      { kind: "delete_setup_branch", branch }
    : { kind: "revert_files" };
}

/**
 * The branch a file must be verified against and reverted on.
 *
 * A file committed to a setup branch that has since merged now lives on the
 * base branch, and git blob ids are content-addressed, so the identity Radius
 * saved still identifies it there. Returning null means Radius cannot say where
 * the file is, which fails the rollback closed.
 */
export function resolveWorkflowRollbackRef(
  file: WorkflowRollbackFile,
  commit: WorkflowRollbackCommitState,
  pullRequestMerged: boolean
): string | null {
  if (file.mode === "pull_request" && pullRequestMerged)
    return commit.baseBranch || null;
  return file.branch || commit.branch || null;
}

function result(
  attempt: number,
  file: WorkflowRollbackFile,
  outcome: SetupCleanupOutcome,
  detail: string | null
): SetupCleanupResult {
  return {
    attempt,
    artifactType: "workflow_file",
    target: file.target,
    identity: file.identity || null,
    outcome,
    detail
  };
}

/**
 * A verdict Radius must not act on, mapped to how the customer should see it.
 *
 * `changed` is recorded as `skipped`: repeating it produces the same refusal, so
 * it is a manual action rather than a retryable one. A read that failed is
 * recorded as a `warning`, which is retryable, because the next read may well
 * succeed.
 */
function blockingOutcome(verdict: WorkflowFileVerdict): SetupCleanupOutcome {
  return verdict.state === "changed" ? "skipped" : "warning";
}

/**
 * A file whose current branch and blob id are both known, which is the only
 * shape a revert may act on: the contents API needs the blob to replace, and a
 * branch to replace it on.
 */
type LocatedWorkflowFile = WorkflowRollbackFile & { blobSha: string };

interface Accumulated {
  results: SetupCleanupResult[];
  warnings: string[];
  steps: string[];
}

export async function runWorkflowRollback(
  input: WorkflowRollbackInput,
  ports: WorkflowRollbackPorts
): Promise<WorkflowRollbackOutcome> {
  const accumulated: Accumulated = { results: [], warnings: [], steps: [] };
  if (input.files.length === 0) return { ...accumulated, blocked: false };

  // GitHub deliberately answers 404 both when a file is absent and when the
  // acting credential cannot see a private repository. Prove repository access
  // with the same pinned credential before any file-level 404 can count as
  // absence.
  const repository = await ports.readRepository({ repo: input.repo });
  if (repository.status === "unreadable") {
    const detail = `Radius could not read repository "${input.repo}" with the GitHub account selected for this setup, so it left every workflow and dependent resource in place. ${repository.detail}`;
    accumulated.warnings.push(detail);
    accumulated.steps.push(`⚠️ ${detail}`);
    for (const file of input.files) {
      accumulated.results.push(result(input.attempt, file, "warning", detail));
    }
    return { ...accumulated, blocked: true };
  }

  const pullRequest =
    input.commit.pullRequestUrl ?
      await ports.readPullRequest({
        repo: input.repo,
        pullRequestUrl: input.commit.pullRequestUrl
      })
    : null;
  if (pullRequest?.status === "unknown") {
    const detail = `Radius could not determine whether the setup pull request merged, so it left every workflow and dependent resource in place. ${pullRequest.detail}`;
    accumulated.warnings.push(detail);
    accumulated.steps.push(`⚠️ ${detail}`);
    for (const file of input.files) {
      accumulated.results.push(result(input.attempt, file, "warning", detail));
    }
    return { ...accumulated, blocked: true };
  }
  const merged = pullRequest?.status === "merged";
  const mode = selectWorkflowRollbackMode(
    input.commit,
    input.files,
    pullRequest
  );

  // Each file is rebound to the branch it actually lives on now. A file whose
  // branch cannot be resolved, or that was saved without the blob id a revert
  // has to pass back to GitHub, is unactionable — and one unactionable file
  // blocks the whole pass, because a half-removed workflow set is worse than an
  // untouched one.
  const located: LocatedWorkflowFile[] = [];
  const unlocatable: WorkflowRollbackFile[] = [];
  for (const file of input.files) {
    const ref = resolveWorkflowRollbackRef(file, input.commit, merged);
    const blobSha = file.blobSha;
    if (ref && blobSha && file.previousBlobKnown)
      located.push({ ...file, branch: ref, blobSha });
    else unlocatable.push(file);
  }
  if (unlocatable.length > 0) {
    const unlocatableFiles = new Set(unlocatable);
    for (const file of input.files) {
      const detail =
        unlocatableFiles.has(file) ?
          file.previousBlobKnown ?
            `Radius cannot tell where "${file.path}" is now, or what it committed there, so it left the file in place.`
          : `Radius did not save whether "${file.path}" existed before setup, so it left the file in place.`
        : `Radius left "${file.path}" in place because another workflow file from this setup could not be located.`;
      accumulated.warnings.push(detail);
      accumulated.results.push(result(input.attempt, file, "warning", detail));
    }
    accumulated.steps.push(
      "⚠️ Radius could not resolve where every committed workflow file is now, so it removed nothing."
    );
    return { ...accumulated, blocked: true };
  }

  const verdicts = await verifyWorkflowProvenance(
    { repo: input.repo, files: located },
    ports
  );

  // Nothing is written while any file is unaccounted for. Reporting first and
  // acting second is what keeps a partially verified set from being partially
  // deleted.
  if (verdicts.blocked) {
    for (const entry of verdicts.files) {
      const file = entry.record;
      if (entry.state === "changed" || entry.state === "unverifiable") {
        accumulated.warnings.push(entry.detail);
        accumulated.steps.push(`⚠️ ${entry.detail}`);
        accumulated.results.push(
          result(input.attempt, file, blockingOutcome(entry), entry.detail)
        );
        continue;
      }
      if (entry.state === "already_restored") {
        accumulated.steps.push(
          `ℹ️ Workflow "${file.path}" on "${file.branch}" already contains the version Radius replaced.`
        );
        accumulated.results.push(result(input.attempt, file, "restored", null));
        continue;
      }
      const detail = `Radius left "${file.path}" in place because another workflow file from this setup could not be verified.`;
      accumulated.warnings.push(detail);
      accumulated.results.push(result(input.attempt, file, "warning", detail));
    }
    return { ...accumulated, blocked: true };
  }

  if (mode.kind === "delete_setup_branch") {
    return await deleteSetupBranch(
      input,
      mode.branch,
      pullRequest,
      ports,
      accumulated
    );
  }
  if (pullRequest?.status === "open") {
    const closed = await closeOpenPullRequest(
      input,
      pullRequest,
      ports,
      accumulated
    );
    if (!closed) {
      // An open but now-empty setup pull request does not keep a workflow
      // installed, so it is a warning rather than a reason to retain the cloud
      // identity. The warning remains in the cleanup result for manual action.
      accumulated.steps.push(
        `⚠️ Setup pull request #${pullRequest.number} remains open after its workflow files were reverted.`
      );
    }
  }
  return await revertFiles(input, verdicts.files, ports, accumulated);
}

async function closeOpenPullRequest(
  input: WorkflowRollbackInput,
  pullRequest: { number: number },
  ports: WorkflowRollbackPorts,
  accumulated: Accumulated
): Promise<boolean> {
  const closed = await ports.closePullRequest({
    repo: input.repo,
    number: pullRequest.number
  });
  if (closed.ok) {
    accumulated.steps.push(
      `✅ Closed setup pull request #${pullRequest.number}.`
    );
    return true;
  }
  const detail = `Could not close setup pull request #${pullRequest.number}: ${closed.detail}`;
  accumulated.warnings.push(detail);
  return false;
}

async function deleteSetupBranch(
  input: WorkflowRollbackInput,
  branch: string,
  pullRequest: PullRequestState | null,
  ports: WorkflowRollbackPorts,
  accumulated: Accumulated
): Promise<WorkflowRollbackOutcome> {
  const { results, warnings, steps } = accumulated;
  const head = await verifySetupBranchHead(
    { repo: input.repo, branch, headSha: input.commit.headSha },
    ports
  );
  if (head.state === "moved" || head.state === "unverifiable") {
    const detail = head.detail;
    warnings.push(detail);
    steps.push(`⚠️ ${detail}`);
    for (const file of input.files) {
      results.push(
        result(
          input.attempt,
          file,
          head.state === "moved" ? "skipped" : "warning",
          detail
        )
      );
    }
    return { ...accumulated, blocked: true };
  }

  // Closing first is best effort only: GitHub closes the pull request itself
  // when the head branch goes away, so a refusal here is narrated rather than
  // treated as a failure to remove the workflows.
  if (pullRequest?.status === "open") {
    const closed = await closeOpenPullRequest(
      input,
      pullRequest,
      ports,
      accumulated
    );
    if (!closed) {
      steps.push(
        `⚠️ Setup pull request #${pullRequest.number} remains open; deleting its head branch may close it automatically.`
      );
    }
  }

  if (head.state === "already_absent") {
    steps.push(`ℹ️ Setup branch "${branch}" is already gone.`);
    for (const file of input.files) {
      results.push(result(input.attempt, file, "not_found", null));
    }
    return { ...accumulated, blocked: false };
  }

  const deleted = await ports.deleteBranch({ repo: input.repo, branch });
  if (!deleted.ok) {
    const detail = `Could not delete setup branch "${branch}": ${deleted.detail}`;
    warnings.push(detail);
    steps.push(`⚠️ ${detail}`);
    for (const file of input.files) {
      results.push(result(input.attempt, file, "warning", detail));
    }
    return { ...accumulated, blocked: true };
  }
  steps.push(`✅ Deleted setup branch "${branch}" and the workflows on it.`);
  for (const file of input.files) {
    results.push(result(input.attempt, file, "deleted", null));
  }
  return { ...accumulated, blocked: false };
}

async function revertFiles(
  input: WorkflowRollbackInput,
  verdicts: ReadonlyArray<WorkflowFileVerdict<LocatedWorkflowFile>>,
  ports: WorkflowRollbackPorts,
  accumulated: Accumulated
): Promise<WorkflowRollbackOutcome> {
  const { results, warnings, steps } = accumulated;
  let blocked = false;
  for (const entry of verdicts) {
    // The record carries the branch the file was verified on, which is the
    // branch the revert commit has to land on.
    const file = entry.record;
    const ref = file.branch;
    if (entry.state === "already_absent") {
      steps.push(`ℹ️ Workflow "${file.path}" is already gone from "${ref}".`);
      results.push(result(input.attempt, file, "not_found", null));
      continue;
    }
    if (entry.state === "already_restored") {
      steps.push(
        `ℹ️ Workflow "${file.path}" on "${ref}" already contains the version Radius replaced.`
      );
      results.push(result(input.attempt, file, "restored", null));
      continue;
    }
    const previous = file.previousBlobSha;
    const cleanupOutcome: SetupCleanupOutcome =
      previous ? "restored" : "deleted";
    const outcome =
      previous ?
        await restoreOne(input, file, ref, file.blobSha, previous, ports)
      : await deleteOne(input, file, ref, file.blobSha, ports);
    if (outcome.ok) {
      steps.push(outcome.step);
      results.push(result(input.attempt, file, cleanupOutcome, null));
      continue;
    }
    blocked = true;
    warnings.push(outcome.detail);
    steps.push(`⚠️ ${outcome.detail}`);
    results.push(result(input.attempt, file, "warning", outcome.detail));
  }
  return { ...accumulated, blocked };
}

type RemovalOutcome =
  { ok: true; step: string } | { ok: false; detail: string };

async function deleteOne(
  input: WorkflowRollbackInput,
  file: WorkflowRollbackFile,
  ref: string,
  blobSha: string,
  ports: WorkflowRollbackPorts
): Promise<RemovalOutcome> {
  const removed = await ports.deleteFile({
    repo: input.repo,
    path: file.path,
    branch: ref,
    blobSha,
    message: `Roll back Radius environment setup: remove ${file.path}`
  });
  return removed.ok ?
      { ok: true, step: `✅ Removed workflow "${file.path}" from "${ref}".` }
    : {
        ok: false,
        detail: `Could not remove workflow "${file.path}" from "${ref}": ${removed.detail}`
      };
}

async function restoreOne(
  input: WorkflowRollbackInput,
  file: WorkflowRollbackFile,
  ref: string,
  blobSha: string,
  previousBlobSha: string,
  ports: WorkflowRollbackPorts
): Promise<RemovalOutcome> {
  const blob = await ports.readBlob({
    repo: input.repo,
    sha: previousBlobSha
  });
  if (!blob.ok) {
    return {
      ok: false,
      detail: `Could not read the version of "${file.path}" that Radius replaced, so the file was left as Radius wrote it: ${blob.detail}`
    };
  }
  const restored = await ports.restoreFile({
    repo: input.repo,
    path: file.path,
    branch: ref,
    blobSha,
    contentBase64: blob.contentBase64,
    message: `Roll back Radius environment setup: restore ${file.path}`
  });
  return restored.ok ?
      { ok: true, step: `✅ Restored the previous "${file.path}" on "${ref}".` }
    : {
        ok: false,
        detail: `Could not restore the previous "${file.path}" on "${ref}": ${restored.detail}`
      };
}
