// Canvas adapter — strict read-back verification of the env-delete workflows.
//
// The destructive environment-delete flow dispatches `delete-environment.yml`,
// which `uses:` the reusable `delete-environment-azure.yml`. That provider file
// carries the safety guard that refuses to delete an environment while it still
// has deployed applications (`rad application list`). `gh workflow run` resolves
// BOTH files from the repository's default branch, so a stale or missing
// provider file means Radius would dispatch a stale guard even when the
// dispatcher itself is current.
//
// Committing the files is best-effort and can silently no-op (a protected
// branch, an exception the sync helper swallows), so a successful commit call is
// not proof the branch actually holds the packaged workflow. This verifier reads
// each file back from the default branch and confirms it byte-for-byte matches
// the packaged source before the caller dispatches. Anything short of a
// confirmed match for EVERY file — an unreadable branch, a missing file, or
// drift — stops the deletion and names the offending file and branch, so the
// destructive workflow never starts against an unverified guard.

export interface ExpectedWorkflowFile {
  // Bare filename, used only in the human-readable failure detail.
  file: string;
  // Repository path the file is committed at (e.g. `.github/workflows/x.yml`).
  path: string;
  // The packaged content the committed file must match exactly.
  expected: string;
}

export interface WorkflowReadbackPorts {
  // The branch `gh workflow run` resolves the workflow from. Throwing (or an
  // empty result) is treated as "cannot verify", never as a default guess.
  defaultBranch(): Promise<string>;
  // Read a committed file from a branch. `null`/`undefined`/`""` means the file
  // is absent; a throw means the branch/file could not be read.
  readFile(path: string, branch: string): Promise<string | null | undefined>;
  // Render an error into a message for the failure detail.
  errorMessage(error: unknown): string;
}

export type WorkflowReadbackResult =
  | { ok: true; branch: string }
  | {
      ok: false;
      branch: string;
      file: string;
      reason: "branch-unreadable" | "file-unreadable" | "missing" | "mismatch";
      detail: string;
    };

/**
 * Confirm every workflow file is present on the default branch and matches the
 * packaged source, before a destructive dispatch.
 *
 * Fails closed: the first file that cannot be confirmed current stops the check
 * and is reported with the branch it was read from. A caller must treat any
 * `ok: false` as a hard stop — the guard the dispatch relies on is unverified.
 */
export async function verifyWorkflowFilesMatchSource(
  files: ExpectedWorkflowFile[],
  ports: WorkflowReadbackPorts
): Promise<WorkflowReadbackResult> {
  let branch: string;
  try {
    branch = (await ports.defaultBranch()) || "";
  } catch (error) {
    return {
      ok: false,
      branch: "",
      file: files[0]?.file ?? "",
      reason: "branch-unreadable",
      detail: `Could not read the default branch to verify the delete-environment workflows: ${ports.errorMessage(
        error
      )}`
    };
  }
  if (!branch) {
    return {
      ok: false,
      branch: "",
      file: files[0]?.file ?? "",
      reason: "branch-unreadable",
      detail:
        "Could not determine the repository's default branch to verify the delete-environment workflows."
    };
  }
  for (const target of files) {
    let committed: string | null | undefined;
    try {
      committed = await ports.readFile(target.path, branch);
    } catch (error) {
      return {
        ok: false,
        branch,
        file: target.file,
        reason: "file-unreadable",
        detail: `Could not read ${target.file} from the "${branch}" branch to verify it: ${ports.errorMessage(
          error
        )}`
      };
    }
    if (committed == null || committed === "") {
      return {
        ok: false,
        branch,
        file: target.file,
        reason: "missing",
        detail: `${target.file} is not present on the "${branch}" branch, so the delete-environment workflow could not be verified.`
      };
    }
    if (committed !== target.expected) {
      return {
        ok: false,
        branch,
        file: target.file,
        reason: "mismatch",
        detail: `${target.file} on the "${branch}" branch does not match the packaged Radius workflow template, so its safety guard could not be verified.`
      };
    }
  }
  return { ok: true, branch };
}
