// Proof that the workflow files Radius committed are still exactly the files
// Radius wrote.
//
// A rollback after the workflow commit point reaches into the customer's
// repository, so it is only safe while nothing else has touched those files.
// This module answers one question per artifact — is the thing on GitHub still
// the thing Radius wrote? — and never decides what to do about the answer. The
// caller owns the destructive step, and every verdict other than "unchanged" or
// "already absent" is a refusal it must honor.
//
// Everything external is a narrow port so the whole decision is testable
// against a GitHub API fake: no `gh`, no network, and no repository state.

export type WorkflowCommitMode = "default_branch" | "pull_request";

/** One committed workflow file as the operation ledger recorded it. */
export interface WorkflowProvenanceRecord {
  path: string;
  branch: string;
  mode: WorkflowCommitMode;
  commitSha: string | null;
  blobSha: string | null;
  contentSha256: string | null;
  previousBlobSha: string | null;
  previousBlobKnown: boolean;
}

/** What the repository currently holds at one path on one ref. */
export type RepositoryFileState =
  | {
      status: "present";
      blobSha: string | null;
      contentSha256: string | null;
    }
  | { status: "absent" }
  | { status: "unreadable"; detail: string };

export type BranchHeadState =
  | { status: "present"; sha: string }
  | { status: "absent" }
  | { status: "unreadable"; detail: string };

export interface WorkflowProvenancePorts {
  readFile(input: {
    repo: string;
    path: string;
    ref: string;
  }): Promise<RepositoryFileState>;
  readBranchHead(input: {
    repo: string;
    branch: string;
  }): Promise<BranchHeadState>;
}

/**
 * One file's verdict, carrying the record it was reached from so a caller never
 * has to re-associate a parallel array with its inputs.
 *
 * `unchanged` is safe to revert; `already_absent` and `already_restored` mean
 * the goal is already met, so none carries a reason. `changed` (someone edited
 * or replaced the file) and `unverifiable` (GitHub could not be read, or the
 * record cannot prove what it wrote) always carry one, because a caller that
 * refuses has to say why. That is a type rule rather than a convention, so no
 * refusal can reach a customer without its sentence.
 */
export type WorkflowFileVerdict<
  T extends WorkflowProvenanceRecord = WorkflowProvenanceRecord
> = { record: T } & (
  | {
      state: "unchanged" | "already_absent" | "already_restored";
      detail: null;
    }
  | { state: "changed" | "unverifiable"; detail: string }
);

export interface WorkflowProvenanceVerdict<
  T extends WorkflowProvenanceRecord = WorkflowProvenanceRecord
> {
  files: Array<WorkflowFileVerdict<T>>;
  /** True when at least one file must not be touched. */
  blocked: boolean;
  /** One customer-readable sentence per blocking file. */
  reasons: string[];
}

export type BranchProvenanceVerdict =
  | { state: "unchanged" | "already_absent"; detail: null }
  | { state: "moved" | "unverifiable"; detail: string };

function describe(path: string, branch: string): string {
  return branch ? `"${path}" on "${branch}"` : `"${path}"`;
}

/**
 * Compare every recorded file with what the repository holds now.
 *
 * Both digests are checked when both are available: the blob SHA proves the
 * file is byte-identical to the object GitHub created for Radius's write, and
 * the content digest proves the same thing independently of how GitHub stored
 * it, so a rewritten history that reproduces one identity but not the other is
 * still caught. A record that never saved either identity is unverifiable, not
 * unchanged.
 */
export async function verifyWorkflowProvenance<
  T extends WorkflowProvenanceRecord
>(
  input: { repo: string; files: readonly T[] },
  ports: WorkflowProvenancePorts
): Promise<WorkflowProvenanceVerdict<T>> {
  const files: Array<WorkflowFileVerdict<T>> = [];
  for (const file of input.files) {
    files.push(await verifyOne(input.repo, file, ports));
  }
  const reasons: string[] = [];
  for (const entry of files) {
    if (entry.state === "changed" || entry.state === "unverifiable")
      reasons.push(entry.detail);
  }
  return { files, blocked: reasons.length > 0, reasons };
}

async function verifyOne<T extends WorkflowProvenanceRecord>(
  repo: string,
  file: T,
  ports: WorkflowProvenancePorts
): Promise<WorkflowFileVerdict<T>> {
  const base = { record: file };
  if (!file.blobSha && !file.contentSha256) {
    return {
      ...base,
      state: "unverifiable",
      detail: `Radius did not save what it committed for ${describe(file.path, file.branch)}, so it cannot prove the file is unchanged.`
    };
  }
  const current = await ports.readFile({
    repo,
    path: file.path,
    ref: file.branch
  });
  if (current.status === "unreadable") {
    return {
      ...base,
      state: "unverifiable",
      detail: `Radius could not read ${describe(file.path, file.branch)} from GitHub: ${current.detail}`
    };
  }
  if (current.status === "absent") {
    return { ...base, state: "already_absent", detail: null };
  }
  if (
    file.previousBlobSha &&
    current.blobSha &&
    current.blobSha === file.previousBlobSha
  ) {
    return { ...base, state: "already_restored", detail: null };
  }
  if (file.blobSha && current.blobSha && current.blobSha !== file.blobSha) {
    return {
      ...base,
      state: "changed",
      detail: `${describe(file.path, file.branch)} has changed since Radius committed it, so Radius left it in place.`
    };
  }
  if (
    file.contentSha256 &&
    current.contentSha256 &&
    current.contentSha256 !== file.contentSha256
  ) {
    return {
      ...base,
      state: "changed",
      detail: `The contents of ${describe(file.path, file.branch)} no longer match what Radius committed, so Radius left the file in place.`
    };
  }
  // Neither identity could be compared: GitHub answered, but with nothing this
  // code can match against the record. That is a read Radius does not
  // understand, not a match.
  if (
    !(file.blobSha && current.blobSha) &&
    !(file.contentSha256 && current.contentSha256)
  ) {
    return {
      ...base,
      state: "unverifiable",
      detail: `GitHub did not report an identity for ${describe(file.path, file.branch)} that Radius can compare with what it committed.`
    };
  }
  return { ...base, state: "unchanged", detail: null };
}

/**
 * Whether a setup branch still points at the commit Radius left there.
 *
 * Deleting a branch discards every commit on it, so it is only allowed while
 * the branch head is still Radius's own last workflow commit. A head that moved
 * carries someone else's work.
 */
export async function verifySetupBranchHead(
  input: { repo: string; branch: string; headSha: string | null },
  ports: WorkflowProvenancePorts
): Promise<BranchProvenanceVerdict> {
  if (!input.branch) {
    return {
      state: "unverifiable",
      detail: "Radius did not save which branch it committed the workflows to."
    };
  }
  if (!input.headSha) {
    return {
      state: "unverifiable",
      detail: `Radius did not save the commit it left at the head of "${input.branch}".`
    };
  }
  const head = await ports.readBranchHead({
    repo: input.repo,
    branch: input.branch
  });
  if (head.status === "unreadable") {
    return {
      state: "unverifiable",
      detail: `Radius could not read the head of "${input.branch}" from GitHub: ${head.detail}`
    };
  }
  if (head.status === "absent")
    return { state: "already_absent", detail: null };
  if (head.sha !== input.headSha) {
    return {
      state: "moved",
      detail: `Branch "${input.branch}" has commits Radius did not write, so Radius left the branch in place.`
    };
  }
  return { state: "unchanged", detail: null };
}
