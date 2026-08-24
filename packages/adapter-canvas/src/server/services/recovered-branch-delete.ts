import {
  settleProviderMutation,
  unresolvedProviderMutations,
  type ProviderMutationRecord
} from "../../operations.js";
import {
  isNotFoundResponse,
  proveBranchAbsent,
  REF_PAGE_SIZE
} from "./branch-absence.js";

export { REF_PAGE_SIZE };

// Recovering the one destructive request setup issues on its own behalf.
//
// When reconciliation proves an interrupted attempt created the setup branch,
// Radius deletes that branch once before the general rollback starts. If the
// answer to that DELETE is lost, the journal holds an unresolved
// `github_branch.delete` — and that entry is dangerous in a way the others are
// not. Every other unresolved mutation asks "did I create this?"; this one asks
// "did I destroy this?", and answering it wrong in the optimistic direction
// tells the customer a branch is gone while their work sits on it.
//
// So the entry gets its own recovery rather than being swept along by whatever
// the scheduler would otherwise have run. Nothing here deletes: the branch is
// read, compared against the exact commit the journal recorded, and either
// settled or handed to the customer with the branch named.

export interface BranchRefReadResult {
  code: string | number;
  stdout: string;
  stderr: string;
}

export interface RecoveredBranchDeleteTarget {
  repo: string;
  branch: string;
  baseSha: string;
}

export type RecoveredBranchDeleteOutcome =
  | { state: "removed"; branch: string; evidence: string }
  | { state: "manual_required"; branch: string | null; guidance: string }
  | { state: "unreadable"; branch: string | null; guidance: string }; /**
 * The repository, branch, and base commit a delete entry names.
 *
 * The target is NUL-separated at the write site precisely so it can be split
 * back apart without guessing: none of the three fields may contain a NUL.
 */
export function parseBranchDeleteTarget(
  target: unknown
): RecoveredBranchDeleteTarget | null {
  if (typeof target !== "string") return null;
  const parts = target.split("\0");
  if (parts.length !== 3) return null;
  const [repo, branch, baseSha] = parts;
  if (!repo || !branch || !baseSha) return null;
  return { repo, branch, baseSha };
}

/** The unresolved setup-branch delete this operation still owes an answer for. */
export function pendingBranchDelete(
  operation: unknown
): ProviderMutationRecord | null {
  return (
    unresolvedProviderMutations(operation, ["github_branch.delete"])[0] || null
  );
}

function branchHeadSha(result: BranchRefReadResult): string | null {
  try {
    const parsed = JSON.parse(result.stdout) as { object?: { sha?: unknown } };
    const sha = parsed.object?.sha;
    return typeof sha === "string" && sha ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Settle an unresolved setup-branch delete from the branch's current state.
 *
 * Returns `removed` only for a branch GitHub reports as gone. A branch that is
 * still there — at the recorded commit or any other — is the customer's to
 * remove, because Radius already issued its one delete and repeating it blindly
 * is how a branch holding replacement work disappears.
 */
export async function reconcileRecoveredBranchDelete(input: {
  operation: object;
  mutation: ProviderMutationRecord;
  readBranchRef(repo: string, branch: string): Promise<BranchRefReadResult>;
  listBranchRefs(
    repo: string,
    branch: string,
    page: number
  ): Promise<BranchRefReadResult>;
}): Promise<RecoveredBranchDeleteOutcome> {
  const target = parseBranchDeleteTarget(input.mutation.target);
  if (!target) {
    const guidance =
      "Radius recorded a setup-branch deletion without the repository, branch, and commit it applied to, so it cannot check whether that branch is gone. " +
      "Review the repository's `radius/setup-*` branches and remove any this attempt left behind.";
    settleProviderMutation(
      input.operation,
      input.mutation.mutationId,
      "manual_required",
      guidance
    );
    return { state: "manual_required", branch: null, guidance };
  }
  let read: BranchRefReadResult;
  try {
    read = await input.readBranchRef(target.repo, target.branch);
  } catch (error) {
    return {
      state: "unreadable",
      branch: target.branch,
      guidance:
        `Radius could not read branch "${target.branch}" in ${target.repo}, so it still cannot say whether its deletion took effect: ` +
        `${error instanceof Error ? error.message : String(error)}. It changed nothing further.`
    };
  }
  const ok = read.code === 0 || read.code === "0";
  if (!ok) {
    if (isNotFoundResponse(read)) {
      // GitHub returns the same 404 for a ref that is gone and for a ref this
      // token is not allowed to see, and it decides that per resource: an
      // account can read a repository's metadata and still be refused its refs.
      // So the corroborating read has to be in the same permission family — a
      // ref listing the account can actually complete — and the branch has to
      // be missing from all of it. A branch that is merely invisible is a
      // branch still holding the customer's work.
      const proof = await proveBranchAbsent({
        repo: target.repo,
        branch: target.branch,
        ports: {
          listBranchRefs: (page) =>
            input.listBranchRefs(target.repo, target.branch, page),
          readBranchRef: () => input.readBranchRef(target.repo, target.branch)
        }
      });
      if (proof.state === "unknown") {
        return {
          state: "unreadable",
          branch: target.branch,
          guidance: `${proof.detail} Radius changed nothing further.`
        };
      }
      if (proof.state === "present") {
        const guidance =
          `GitHub reported branch "${target.branch}" in ${target.repo} as gone from its own endpoint but still lists it, ` +
          "so Radius cannot say whether its deletion took effect. Review that branch and remove it yourself if it is unwanted.";
        settleProviderMutation(
          input.operation,
          input.mutation.mutationId,
          "manual_required",
          guidance
        );
        return { state: "manual_required", branch: target.branch, guidance };
      }
      const evidence = `GitHub confirmed the recovered setup branch "${target.branch}" is absent. ${proof.evidence}`;
      settleProviderMutation(
        input.operation,
        input.mutation.mutationId,
        "confirmed",
        evidence
      );
      return { state: "removed", branch: target.branch, evidence };
    }
    return {
      state: "unreadable",
      branch: target.branch,
      guidance:
        `Radius could not read branch "${target.branch}" in ${target.repo}, so it still cannot say whether its deletion took effect. ` +
        "It changed nothing further."
    };
  }
  const head = branchHeadSha(read);
  if (!head) {
    return {
      state: "unreadable",
      branch: target.branch,
      guidance:
        `GitHub returned unreadable state for branch "${target.branch}" in ${target.repo}, so Radius still cannot say whether its deletion took effect. ` +
        "It changed nothing further."
    };
  }
  const guidance =
    head === target.baseSha ?
      `Setup branch "${target.branch}" in ${target.repo} still exists at the commit Radius created it from, after Radius had already issued its one delete request. ` +
      "Radius will not repeat that delete. Remove the branch yourself before starting another setup."
    : `Setup branch "${target.branch}" in ${target.repo} now points at a different commit than the one Radius created, so it may hold work Radius did not write. ` +
      "Radius will not delete it. Review the branch and remove it yourself if it is unwanted.";
  settleProviderMutation(
    input.operation,
    input.mutation.mutationId,
    "manual_required",
    guidance
  );
  return { state: "manual_required", branch: target.branch, guidance };
}
