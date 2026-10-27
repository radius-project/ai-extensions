export interface PullRequestBranchState {
  branch: string;
  base: string;
}

export interface WorkflowCommitOutcome {
  ok: boolean;
  // False when the existing workflow already matched the generated content and
  // no repository mutation was needed.
  changed: boolean;
  cancelled?: boolean;
  stderr?: string;
  viaPr: boolean;
  // Provenance of the write, captured from the contents API response so a later
  // rollback can prove the file on GitHub is still exactly what Radius wrote.
  // Absent when the commit failed or GitHub answered with something this code
  // could not read, which fails a post-commit rollback closed.
  commitSha?: string | null;
  blobSha?: string | null;
  contentSha256?: string | null;
  // The blob the path held before this write, or null when Radius created the
  // file. A revert restores the former and deletes the latter.
  previousBlobSha?: string | null;
  // True only when the pre-write lookup proved either the previous blob or that
  // the path was absent. A failed lookup remains unknown and blocks rollback.
  previousBlobKnown?: boolean;
}

export type SetupWorkflowCommandResult =
  import("./setup-azure-recovery.js").ProviderMutationCommandResult;
