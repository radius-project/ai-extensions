import { createHash } from "node:crypto";
import {
  providerMutationId,
  providerMutationRecord,
  providerMutationsByKind,
  shouldStop,
  settleProviderMutation
} from "../../operations.js";
import { needsWorkflowScope } from "./create-environment-gh-runner.js";
import type {
  CreateEnvironmentCommandResult,
  PullRequestBranchState,
  WorkflowCommitOutcome
} from "./create-environment-types.js";
import {
  executeRecoverableMutation,
  providerMutationWillWrite,
  ProviderMutationRecoveryError
} from "../services/provider-mutation-recovery.js";
import { parseBranchDeleteTarget } from "../services/recovered-branch-delete.js";
import {
  branchRefListingArgs,
  branchRefReadArgs,
  proveBranchAbsent
} from "../services/branch-absence.js";

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
  ): Promise<{ ok: boolean; stderr: string; timedOut?: boolean }>;
  mutationRecovery?: {
    operation: object & {
      operationId: string;
      providerRecovery?: { state?: string };
    };
    persist(): Promise<void>;
    beforeMutation?(kind: string, target: string): Promise<boolean>;
  };
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

/** The sha256 of the exact bytes a base64 request body carries. */
export function workflowContentDigest(contentB64: string): string {
  return createHash("sha256")
    .update(Buffer.from(contentB64, "base64"))
    .digest("hex");
}

class WorkflowCommitCancelledError extends Error {}

/**
 * The branch and base commit an interrupted attempt already journaled.
 *
 * Looked up by kind rather than by recomputing the target, because the target
 * embeds the base commit: recomputing it after the default branch moved would
 * produce a different mutation id, leave the original entry unresolvable, and
 * lock the repository behind a journal entry nothing could ever settle.
 */
export function recordedSetupBranchCreate(
  operation: unknown,
  repo: string
): { branch: string; baseSha: string } | null {
  for (const mutation of providerMutationsByKind(
    operation,
    "github_branch.create"
  )) {
    const parsed = parseBranchDeleteTarget(mutation.target);
    if (parsed && parsed.repo === repo) {
      return { branch: parsed.branch, baseSha: parsed.baseSha };
    }
  }
  return null;
}

/**
 * The commit and blob identities the contents API reported for a write.
 *
 * Returns nulls rather than throwing when the response is unreadable: a
 * successful commit whose provenance could not be captured is still a
 * successful commit, and the null is what later refuses to roll it back
 * automatically.
 */
export function readWorkflowCommitProvenance(stdout: string | undefined): {
  commitSha: string | null;
  blobSha: string | null;
} {
  const readSha = (value: unknown): string | null => {
    if (!value || typeof value !== "object") return null;
    const sha = (value as { sha?: unknown }).sha;
    return typeof sha === "string" && sha.trim() ? sha.trim() : null;
  };
  try {
    const parsed: unknown = JSON.parse((stdout || "").trim() || "null");
    if (!parsed || typeof parsed !== "object") {
      return { commitSha: null, blobSha: null };
    }
    const body = parsed as { content?: unknown; commit?: unknown };
    return {
      commitSha: readSha(body.commit),
      blobSha: readSha(body.content)
    };
  } catch {
    return { commitSha: null, blobSha: null };
  }
}

export function createWorkflowFileCommitter(
  ports: WorkflowFileCommitterPorts,
  target: WorkflowFileCommitterTarget
): WorkflowFileCommitter {
  // PR-fallback state; populated lazily on the first protected-branch failure.
  // Once set, every subsequent workflow commit targets the PR branch instead of
  // the default branch.
  let prState: PullRequestBranchState | undefined;
  let atomicFallbackWrite = false;

  const readBranchHead = async (
    branch: string
  ): Promise<{ state: "absent" } | { state: "present"; sha: string }> => {
    const result = await ports.runGh([
      "api",
      `/repos/${target.targetRepo}/git/ref/heads/${encodeURIComponent(branch)}`
    ]);
    if (result.code !== 0 && result.code !== "0") {
      if (
        /(?:HTTP\s+404|\bNot Found\b)/i.test(result.stderr || result.stdout)
      ) {
        return { state: "absent" };
      }
      throw new Error(
        result.stderr ||
          result.stdout ||
          `GitHub branch "${branch}" could not be read.`
      );
    }
    let sha = "";
    try {
      const parsed = JSON.parse(result.stdout) as {
        object?: { sha?: unknown };
      };
      sha = typeof parsed.object?.sha === "string" ? parsed.object.sha : "";
    } catch {
      throw new Error(
        `GitHub returned unreadable state for branch "${branch}".`
      );
    }
    if (!sha) {
      throw new Error(`GitHub did not report the head of branch "${branch}".`);
    }
    return { state: "present", sha };
  };

  const beginPrFallback = async (): Promise<PullRequestBranchState> => {
    if (prState) return prState;
    const base = await ports.getDefaultBranch(target.targetRepo);
    if (!base)
      throw new Error("could not resolve the repository default branch");
    const suffix =
      ports.mutationRecovery?.operation.operationId
        .replace(/^op_/, "")
        .slice(0, 12) || String(ports.now());
    // The commit this branch was cut from is part of the mutation's identity
    // and is also what a later delete compares the branch head against. Reading
    // it fresh on every attempt would move that identity whenever the default
    // branch advanced, journaling a second entry the interrupted one could
    // never be settled from — and comparing the recovered branch against a
    // commit Radius never created it at. So a recorded attempt supplies both.
    const recorded = recordedSetupBranchCreate(
      ports.mutationRecovery?.operation,
      target.targetRepo
    );
    const baseSha =
      recorded?.baseSha ||
      (await ports.getBranchHeadSha(target.targetRepo, base));
    if (!baseSha)
      throw new Error(`could not resolve head of base branch "${base}"`);
    const branch =
      recorded?.branch || `radius/setup-${target.envName}-workflows-${suffix}`;
    if (ports.mutationRecovery) {
      const mutationTarget = `${target.targetRepo}\0${branch}\0${baseSha}`;
      if (
        providerMutationWillWrite(
          ports.mutationRecovery.operation,
          "github_branch.create",
          mutationTarget
        ) &&
        ports.mutationRecovery.beforeMutation &&
        !(await ports.mutationRecovery.beforeMutation(
          "github_branch.create",
          mutationTarget
        ))
      ) {
        throw new WorkflowCommitCancelledError(
          "Operation stopped before creating the setup branch."
        );
      }
      const creation = await executeRecoverableMutation({
        operation: ports.mutationRecovery.operation,
        kind: "github_branch.create",
        target: mutationTarget,
        providerIdempotencyKey: branch,
        persist: ports.mutationRecovery.persist,
        mutate: async () => {
          const result = await ports.createBranchRef(
            target.targetRepo,
            branch,
            baseSha
          );
          return {
            code: result.ok ? 0 : 1,
            stdout: "",
            stderr: result.stderr,
            timedOut: result.timedOut
          };
        },
        accept: () => ({ branch, base }),
        reconcile: async () => {
          const current = await readBranchHead(branch);
          if (current.state === "absent") {
            // A bare 404 is what GitHub answers both for a ref that is gone and
            // for one this token may not read, and `not_applied` is the verdict
            // that licenses reissuing the create. So absence is proven from the
            // ref listing the account can actually enumerate — the same proof
            // the delete reconcile below and restart recovery both use, so no
            // two paths reach different conclusions about the same branch.
            const proof = await proveBranchAbsent({
              repo: target.targetRepo,
              branch,
              ports: {
                listBranchRefs: (page) =>
                  ports.runGh(
                    branchRefListingArgs(target.targetRepo, branch, page)
                  ),
                readBranchRef: () =>
                  ports.runGh(branchRefReadArgs(target.targetRepo, branch))
              }
            });
            if (proof.state !== "absent") {
              throw new Error(
                `The setup branch "${branch}" could not be proven absent after the interrupted create. ${proof.detail}`
              );
            }
            return {
              state: "not_applied" as const,
              evidence: `GitHub confirmed the setup branch is absent. ${proof.evidence}`
            };
          }
          if (current.sha !== baseSha) {
            return {
              state: "manual_required" as const,
              guidance:
                `Branch "${branch}" exists at a different commit than the saved base. ` +
                "Radius will not overwrite or delete it."
            };
          }
          return {
            state: "applied" as const,
            value: { branch, base },
            evidence:
              "The exact operation-specific branch exists at the saved base commit."
          };
        }
      });
      if (creation.state === "not_applied") {
        throw new Error(`could not create branch "${branch}"`);
      }
      if (
        creation.recovered &&
        ports.mutationRecovery.operation.providerRecovery?.state ===
          "rollback_pending"
      ) {
        const removal = await executeRecoverableMutation({
          operation: ports.mutationRecovery.operation,
          kind: "github_branch.delete",
          target: `${target.targetRepo}\0${branch}\0${baseSha}`,
          providerIdempotencyKey: branch,
          persist: ports.mutationRecovery.persist,
          mutate: () =>
            ports.runGhWorkflow([
              "api",
              "--method",
              "DELETE",
              `/repos/${target.targetRepo}/git/refs/heads/${encodeURIComponent(
                branch
              )}`
            ]),
          // GitHub answering "no" is not the branch being gone. Reporting a
          // removal here — and then starting the rollback that removal was meant
          // to unblock — would tell the customer their setup branch had been
          // cleaned up while it is still sitting in the repository. The refusal
          // is recorded as the blocker itself, in the same settle, so a crash
          // cannot reload a record that looks resolved with the branch present.
          rejectionGuidance: (result) =>
            `Radius could not remove the setup branch "${branch}" it recovered in ${target.targetRepo}: ` +
            `${result.stderr?.trim() || result.stdout?.trim() || "GitHub refused the request."} ` +
            "It did not repeat the delete and did not start a rollback, because a rollback that leaves this branch behind would report work it has not done. " +
            "Remove that exact branch yourself, then start setup again.",
          accept: () => true,
          reconcile: async () => {
            // A 404 from the ref endpoint is not the branch being gone: GitHub
            // answers the same way for a ref this token is not allowed to see.
            // The proof is the ref listing the account can actually enumerate,
            // read to its end and confirmed once more against the ref itself —
            // the same proof restart recovery uses, so the two paths cannot
            // reach different conclusions about the same branch.
            const proof = await proveBranchAbsent({
              repo: target.targetRepo,
              branch,
              ports: {
                listBranchRefs: (page) =>
                  ports.runGh(
                    branchRefListingArgs(target.targetRepo, branch, page)
                  ),
                readBranchRef: () =>
                  ports.runGh(branchRefReadArgs(target.targetRepo, branch))
              }
            });
            if (proof.state === "absent") {
              return {
                state: "applied" as const,
                value: true,
                evidence: `GitHub confirmed the recovered setup branch is absent. ${proof.evidence}`
              };
            }
            if (proof.state === "unknown") {
              // Unreadable, not refused. Leaving the entry unresolved is what
              // keeps the next pass from repeating a delete whose outcome
              // nobody can establish.
              throw new Error(proof.detail);
            }
            const current = await readBranchHead(branch);
            return {
              state: "manual_required" as const,
              guidance:
                current.state === "present" && current.sha !== baseSha ?
                  `Recovered branch "${branch}" now points to a different commit. Radius will not delete it because it may contain replacement work.`
                : `Recovered branch "${branch}" still exists after Radius's single rollback request. Radius will not repeat the delete blindly. Delete that exact branch manually before retrying setup.`
            };
          }
        });
        if (removal.state !== "applied") {
          const guidance =
            `Radius could not remove the setup branch "${branch}" it recovered in ${target.targetRepo}. ` +
            "It did not repeat the delete and did not start a rollback, because a rollback that leaves this branch behind would report work it has not done. " +
            "Remove that exact branch yourself, then start setup again.";
          settleProviderMutation(
            ports.mutationRecovery.operation,
            providerMutationId(
              ports.mutationRecovery.operation.operationId,
              "github_branch.delete",
              `${target.targetRepo}\0${branch}\0${baseSha}`
            ),
            "manual_required",
            guidance
          );
          await ports.mutationRecovery.persist();
          throw new ProviderMutationRecoveryError(
            guidance,
            "provider-mutation-manual-required"
          );
        }
        if (ports.mutationRecovery.operation.providerRecovery) {
          ports.mutationRecovery.operation.providerRecovery.state =
            "rollback_pending";
        }
        await ports.mutationRecovery.persist();
        throw new ProviderMutationRecoveryError(
          `Radius reconciled and removed recovered setup branch "${branch}". The remaining proven-owned setup resources will now be rolled back.`,
          "provider-mutation-recovered-rollback"
        );
      }
    } else {
      const created = await ports.createBranchRef(
        target.targetRepo,
        branch,
        baseSha
      );
      if (!created.ok)
        throw new Error(
          `could not create branch "${branch}": ${created.stderr}`
        );
    }
    prState = { branch, base };
    ports.pushStep(
      `ℹ️ No permission to push to "${base}" directly — committing workflows to branch "${branch}" and opening a pull request.`
    );
    return prState;
  };

  // Commit one workflow file via the contents API. `branch === ''` targets the
  // default branch. Looks up the existing blob SHA on the same ref so a
  // re-commit is an update rather than a rejected create, and keeps that SHA as
  // the blob a revert would restore. Returns the raw runGhWorkflow result plus
  // the provenance read back out of the response.
  const putWorkflowContent = async (
    path: string,
    contentB64: string,
    message: string,
    branch = ""
  ): Promise<
    CreateEnvironmentCommandResult & {
      previousBlobSha: string | null;
      previousBlobKnown: boolean;
      commitSha: string | null;
      blobSha: string | null;
      cancelled?: boolean;
    }
  > => {
    const refQ = branch ? "?ref=" + encodeURIComponent(branch) : "";
    const shaRes = await ports.runGh([
      "api",
      "/repos/" + target.targetRepo + "/contents/" + path + refQ,
      "--jq",
      ".sha"
    ]);
    const sha = shaRes.code === 0 ? shaRes.stdout.trim() : "";
    const previousBlobKnown =
      sha !== "" ||
      /(?:HTTP\s+404|\bNot Found\b)/i.test(
        `${shaRes.stderr || ""}\n${shaRes.stdout || ""}`
      );
    const mutationKind = "github_workflow.put";
    const mutationTarget = `${target.targetRepo}:${branch || "<default>"}:${path}`;
    const mutationRecovery = ports.mutationRecovery;
    const recoveryOperation = mutationRecovery?.operation;
    const existingMutation =
      recoveryOperation ?
        providerMutationRecord(recoveryOperation, mutationKind, mutationTarget)
      : null;
    if (
      mutationRecovery &&
      !atomicFallbackWrite &&
      providerMutationWillWrite(
        mutationRecovery.operation,
        mutationKind,
        mutationTarget
      ) &&
      mutationRecovery.beforeMutation &&
      !(await mutationRecovery.beforeMutation(mutationKind, mutationTarget))
    ) {
      return {
        code: 1,
        stdout: "",
        stderr: "Operation stopped before writing the workflow.",
        previousBlobSha: sha || null,
        previousBlobKnown,
        commitSha: null,
        blobSha: null,
        cancelled: true
      };
    }
    // A refused or hand-off write is not a write this attempt is reconciling —
    // it is one this attempt is about to make for the first time. Its recorded
    // intent describes a repository state that has since moved on, so only a
    // record still awaiting an answer contributes the predecessor a revert
    // would restore.
    const reconcilableIntent =
      (
        existingMutation?.status === "prepared" ||
        existingMutation?.status === "outcome_unknown" ||
        existingMutation?.status === "confirmed"
      ) ?
        existingMutation
      : null;
    const existingIntent = reconcilableIntent?.intent;
    const operationMarker =
      typeof existingIntent?.operationMarker === "string" ?
        existingIntent.operationMarker
      : recoveryOperation ?
        `radius-operation:${recoveryOperation.operationId}:workflow:${workflowContentDigest(contentB64).slice(0, 16)}`
      : "";
    const intendedPreviousBlobSha =
      (
        existingIntent &&
        "previousBlobSha" in existingIntent &&
        (typeof existingIntent.previousBlobSha === "string" ||
          existingIntent.previousBlobSha === null)
      ) ?
        existingIntent.previousBlobSha
      : sha || null;
    const intendedPreviousBlobKnown =
      typeof existingIntent?.previousBlobKnown === "boolean" ?
        existingIntent.previousBlobKnown
      : previousBlobKnown;
    const commitMessage =
      operationMarker ?
        `${message}\n\nRadius-Operation: ${operationMarker}`
      : message;
    const bodyObj = {
      message: commitMessage,
      content: contentB64,
      ...(branch ? { branch } : {}),
      ...(sha ? { sha } : {})
    };
    const tmp = ports.tempFile.write(JSON.stringify(bodyObj));
    const args = [
      "api",
      "--method",
      "PUT",
      "/repos/" + target.targetRepo + "/contents/" + path,
      "--input",
      tmp
    ];
    let r: CreateEnvironmentCommandResult;
    try {
      if (mutationRecovery) {
        const mutation =
          await executeRecoverableMutation<CreateEnvironmentCommandResult>({
            operation: mutationRecovery.operation,
            kind: mutationKind,
            target: mutationTarget,
            intent: {
              branch: branch || "<default>",
              path,
              previousBlobSha: intendedPreviousBlobSha,
              previousBlobKnown: intendedPreviousBlobKnown,
              contentSha256: workflowContentDigest(contentB64),
              operationMarker
            },
            persist: mutationRecovery.persist,
            mutate: () => ports.runGhWorkflow(args),
            accept: (result) => result,
            reconcile: async () => {
              const current = await ports.runGh([
                "api",
                "/repos/" + target.targetRepo + "/contents/" + path + refQ
              ]);
              if (current.code !== 0 && current.code !== "0") {
                const detail = `${current.stderr}\n${current.stdout}`;
                if (/(?:HTTP\s+404|\bNot Found\b)/i.test(detail)) {
                  return {
                    state: "not_applied" as const,
                    evidence: "GitHub confirmed the workflow path is absent."
                  };
                }
                throw new Error(
                  current.stderr ||
                    current.stdout ||
                    "GitHub workflow state could not be read."
                );
              }
              let body: { sha?: unknown; content?: unknown };
              try {
                body = JSON.parse(current.stdout) as {
                  sha?: unknown;
                  content?: unknown;
                };
              } catch {
                return {
                  state: "manual_required" as const,
                  guidance:
                    `GitHub returned unreadable state for "${path}" on "${branch || "the default branch"}". ` +
                    "Radius will not overwrite or remove that file."
                };
              }
              const currentContent =
                typeof body.content === "string" ?
                  body.content.replace(/\s+/g, "")
                : "";
              const currentDigest =
                currentContent ? workflowContentDigest(currentContent) : "";
              const expectedDigest = workflowContentDigest(contentB64);
              const durableIntent = providerMutationRecord(
                mutationRecovery.operation,
                mutationKind,
                mutationTarget
              )?.intent;
              if (
                typeof body.sha !== "string" ||
                !body.sha ||
                currentDigest !== expectedDigest
              ) {
                return {
                  state: "manual_required" as const,
                  guidance:
                    `Workflow "${path}" on "${branch || "the default branch"}" does not match the exact content from this operation. ` +
                    "Radius will not overwrite or remove it."
                };
              }
              if (
                typeof durableIntent?.operationMarker !== "string" ||
                durableIntent.operationMarker !== operationMarker ||
                durableIntent.contentSha256 !== expectedDigest ||
                durableIntent.path !== path ||
                durableIntent.branch !== (branch || "<default>") ||
                typeof durableIntent.previousBlobKnown !== "boolean"
              ) {
                return {
                  state: "manual_required" as const,
                  guidance:
                    `Radius does not have complete pre-write rollback provenance for "${path}" on "${branch || "the default branch"}". ` +
                    "It will not accept, overwrite, or remove that workflow."
                };
              }
              const commitsPath =
                `/repos/${target.targetRepo}/commits?path=${encodeURIComponent(path)}` +
                `${branch ? `&sha=${encodeURIComponent(branch)}` : ""}&per_page=10`;
              const commits = await ports.runGh(["api", commitsPath]);
              if (commits.code !== 0 && commits.code !== "0") {
                throw new Error(
                  commits.stderr ||
                    commits.stdout ||
                    "GitHub workflow commit history could not be read."
                );
              }
              let matchingCommits: Array<{ sha: string }> = [];
              try {
                const parsed: unknown = JSON.parse(commits.stdout);
                if (Array.isArray(parsed)) {
                  matchingCommits = parsed.filter(
                    (
                      candidate
                    ): candidate is {
                      sha: string;
                      commit: { message: string };
                    } =>
                      candidate !== null &&
                      typeof candidate === "object" &&
                      "sha" in candidate &&
                      typeof candidate.sha === "string" &&
                      candidate.sha.length === 40 &&
                      "commit" in candidate &&
                      candidate.commit !== null &&
                      typeof candidate.commit === "object" &&
                      "message" in candidate.commit &&
                      typeof candidate.commit.message === "string" &&
                      candidate.commit.message.includes(
                        `Radius-Operation: ${operationMarker}`
                      )
                  );
                }
              } catch {
                return {
                  state: "manual_required" as const,
                  guidance:
                    `GitHub returned unreadable commit history for "${path}" on "${branch || "the default branch"}". ` +
                    "Radius will not accept, overwrite, or remove that workflow."
                };
              }
              if (matchingCommits.length !== 1) {
                return {
                  state: "manual_required" as const,
                  guidance:
                    `Radius could not prove one exact commit for "${path}" on "${branch || "the default branch"}" using this operation's immutable marker. ` +
                    "It will not accept, overwrite, or remove that workflow."
                };
              }
              return {
                state: "applied" as const,
                value: {
                  code: 0,
                  stdout: JSON.stringify({
                    content: { sha: body.sha },
                    commit: { sha: matchingCommits[0].sha }
                  }),
                  stderr: ""
                },
                evidence:
                  "The workflow path, branch, blob identity, and content digest matched."
              };
            }
          });
        r =
          mutation.state === "applied" ?
            mutation.value
          : mutation.result || {
              code: 1,
              stdout: "",
              stderr: "GitHub confirmed the workflow write was not applied."
            };
      } else {
        r = await ports.runGhWorkflow(args);
      }
    } finally {
      ports.tempFile.remove(tmp);
    }
    return {
      ...r,
      previousBlobSha: intendedPreviousBlobSha,
      previousBlobKnown: intendedPreviousBlobKnown,
      ...readWorkflowCommitProvenance(r.stdout)
    };
  };

  const succeeded = (
    result: Awaited<ReturnType<typeof putWorkflowContent>>,
    contentB64: string,
    viaPr: boolean
  ): WorkflowCommitOutcome => ({
    ok: true,
    stderr: result.stderr,
    viaPr,
    commitSha: result.commitSha,
    blobSha: result.blobSha,
    contentSha256: workflowContentDigest(contentB64),
    previousBlobSha: result.previousBlobSha,
    previousBlobKnown: result.previousBlobKnown
  });

  // Commit a workflow file, transparently switching to the PR branch (creating
  // it on first use) when the default branch rejects the push for permission
  // reasons. Returns { ok, stderr, viaPr } plus the write's provenance.
  const commitWorkflowFileSmart = async (
    path: string,
    contentB64: string,
    message: string
  ): Promise<WorkflowCommitOutcome> => {
    if (
      !prState &&
      ports.mutationRecovery &&
      shouldStop(ports.mutationRecovery.operation) &&
      recordedSetupBranchCreate(
        ports.mutationRecovery.operation,
        target.targetRepo
      )
    ) {
      // A restart must return to the exact recorded fallback branch before it
      // considers another default-branch write. This lets the saved branch or
      // workflow mutation reconcile and prevents Stop from deadlocking behind a
      // fresh replay of the already-refused direct write.
      prState = await beginPrFallback();
    }
    if (prState) {
      const r = await putWorkflowContent(
        path,
        contentB64,
        message,
        prState.branch
      );
      if (r.cancelled) {
        return { ok: false, cancelled: true, stderr: r.stderr, viaPr: true };
      }
      return r.code === 0 ?
          succeeded(r, contentB64, true)
        : { ok: false, stderr: r.stderr, viaPr: true };
    }
    const direct = await putWorkflowContent(path, contentB64, message, "");
    if (direct.cancelled) {
      return {
        ok: false,
        cancelled: true,
        stderr: direct.stderr,
        viaPr: false
      };
    }
    if (direct.code === 0) return succeeded(direct, contentB64, false);
    if (isProtectedBranchFailure(direct.stderr)) {
      let fallback: PullRequestBranchState;
      try {
        // Branch creation and its first workflow commit are one atomic fallback.
        // Stopping between them would leave an untracked setup branch that no
        // operation record can resume or remove.
        fallback = await beginPrFallback();
        prState = fallback;
        atomicFallbackWrite = true;
      } catch (e) {
        if (e instanceof WorkflowCommitCancelledError) {
          return {
            ok: false,
            cancelled: true,
            stderr: e.message,
            viaPr: false
          };
        }
        if (e instanceof ProviderMutationRecoveryError) throw e;
        return {
          ok: false,
          stderr: `${direct.stderr} (PR fallback failed: ${ports.errorMessage(
            e
          )})`,
          viaPr: false
        };
      }
      let r: Awaited<ReturnType<typeof putWorkflowContent>>;
      try {
        r = await putWorkflowContent(
          path,
          contentB64,
          message,
          fallback.branch
        );
      } finally {
        atomicFallbackWrite = false;
      }
      if (r.cancelled) {
        return { ok: false, cancelled: true, stderr: r.stderr, viaPr: true };
      }
      return r.code === 0 ?
          succeeded(r, contentB64, true)
        : { ok: false, stderr: r.stderr, viaPr: true };
    }
    return { ok: false, stderr: direct.stderr, viaPr: false };
  };

  return {
    pullRequestState: () => prState,
    commitWorkflowFileSmart
  };
}
