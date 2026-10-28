import {
  assertSetupExecutionActive,
  isSetupExecutionInterrupted,
  ensureGitHubEnvironment as ensureCoreGitHubEnvironment,
  type EnsureGitHubEnvironmentInput,
  type GitHubEnvironmentCommandResult
} from "@radius-project/core";
export {
  GitHubEnvironmentEnsureError,
  GitHubEnvironmentEnsureCancelled,
  parseEnvironmentProviderId,
  readEnsuredGitHubEnvironment,
  type GitHubEnvironmentCommandResult,
  type GitHubEnvironmentReadResult,
  type EnsuredGitHubEnvironment,
  type GitHubEnvironmentCreatedCandidate,
  type GitHubEnvironmentResolutionRecord
} from "@radius-project/core";
import { providerMutationRecord } from "../../operations.js";
import {
  executeRecoverableMutation,
  providerMutationWillWrite
} from "./provider-mutation-recovery.js";

const ENVIRONMENT_READ_TIMEOUT_MS = 20000;

// Result of deleting a GitHub Environment. `deleted` removed a live environment;
// `not_found` means it was already gone AND that absence was confirmed against a
// complete environment listing read by the same account (idempotent success);
// `failed` records a best-effort warning without asserting anything was torn
// down — including the case where the DELETE returned 404 but absence could not
// be confirmed, because GitHub also returns 404 when the acting credential
// simply lacks permission to see the environment.
//
// This delete primitive is deliberately shared: both the Delete Environment flow
// (PR #398) and Create-Environment rollback (separate PR) remove a GitHub
// environment with the identical idempotent contract. The design note
// `docs/design/2026-08-environment-deletion-cloud-cleanup.md` calls this out as
// a primitive that must live in one place so the two flows never drift on how a
// "not found" result is classified or when the environment-list cache is
// invalidated. Each flow keeps its own decision layer (which environment, and
// whether it is allowed to delete it) and only calls this primitive to do the
// work.
export interface GitHubEnvDeletionOutcome {
  outcome: "deleted" | "not_found" | "failed";
  detail?: string;
}

// The narrow I/O the delete primitive needs, injected so it can be unit-tested
// with a deterministic fake and reused by any flow regardless of how that flow
// runs `gh` or holds the environment-list cache.
export interface GitHubEnvironmentDeletionPorts {
  // Run a `gh` command. Never throws; a spawn failure surfaces as a non-zero
  // `code` with `stderr`. `stdout` carries the command's output, which the 404
  // absence check reads. The delete and the absence-confirming listing MUST run
  // through this one executor so both act as the same GitHub account.
  runGh(args: string[]): Promise<{
    code: number | string;
    stdout?: string;
    stderr?: string;
  }>;
  // Drop the cached environment list for the repo so the next listing reflects
  // the deletion. Called on every path that converges the environment to "gone"
  // (both `deleted` and confirmed `not_found`), never on a genuine failure.
  invalidateEnvListCache(repo: string): void;
}

export function buildGitHubEnvironmentDeleteArgs(
  repo: string,
  environment: string
): string[] {
  return [
    "api",
    "--method",
    "DELETE",
    "/repos/" + repo + "/environments/" + encodeURIComponent(environment)
  ];
}

// List every environment on the repo, paginated, emitting one name per line.
// `--paginate` walks every page so a large repo cannot hide the environment on a
// page the check never read, and `--jq` extracts names on GitHub's own bundled
// jq so no separate tool is required. Used only to confirm a DELETE's 404 really
// means the environment is gone.
export function buildGitHubEnvironmentListArgs(repo: string): string[] {
  return [
    "api",
    "--paginate",
    "-H",
    "Accept: application/vnd.github+json",
    "/repos/" + repo + "/environments",
    "--jq",
    ".environments[].name"
  ];
}

// Whether the DELETE's stderr looks like a GitHub 404 / "not found". A 404 is
// NOT trusted on its own — GitHub returns it both for a genuinely absent
// environment and for one the acting credential cannot see — so a match here
// only triggers the absence confirmation below.
function looksLikeNotFound(stderr: string | undefined): boolean {
  return /HTTP 404|not found/i.test(stderr || "");
}

// Confirm the environment is absent by reading a COMPLETE environment listing
// through the same executor that ran the delete. An unreadable listing (any
// non-zero exit) or one that still names the environment is treated as "not
// confirmed absent", so a permission-masked 404 can never be recorded as a
// successful idempotent deletion.
async function confirmGitHubEnvironmentAbsent(
  repo: string,
  environment: string,
  ports: GitHubEnvironmentDeletionPorts
): Promise<{ absent: boolean; detail?: string }> {
  const listing = await ports.runGh(buildGitHubEnvironmentListArgs(repo));
  const code = Number(listing.code);
  if (!Number.isFinite(code) || code !== 0) {
    return {
      absent: false,
      detail:
        (listing.stderr || "").trim() ||
        "GitHub returned 404 for the delete, but the repository's environment list could not be read to confirm the environment is gone. The 404 may be masking a permission problem."
    };
  }
  const target = environment.trim().toLowerCase();
  const stillListed = (listing.stdout || "")
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean)
    .some((name) => name.toLowerCase() === target);
  if (stillListed) {
    return {
      absent: false,
      detail:
        `GitHub returned 404 for the delete, but "${environment}" is still present in the repository's environment list, ` +
        "so the 404 reflects a permission problem rather than absence."
    };
  }
  return { absent: true };
}

// Delete the GitHub Environment. Idempotent, but never trusts a bare 404: GitHub
// returns 404 both when the environment is genuinely gone and when the acting
// credential lacks permission to see it. A 404 is therefore only reported as
// `not_found` after a complete environment listing — read by the same account —
// confirms the environment is truly absent. If that listing cannot be read, or
// still shows the environment, the result is `failed` so an auth-masked 404 is
// never recorded as a successful deletion.
export async function deleteGitHubEnvironmentIdempotent(
  repo: string,
  environment: string,
  ports: GitHubEnvironmentDeletionPorts
): Promise<GitHubEnvDeletionOutcome> {
  const result = await ports.runGh(
    buildGitHubEnvironmentDeleteArgs(repo, environment)
  );
  if (result.code === 0 || result.code === "0") {
    ports.invalidateEnvListCache(repo);
    return { outcome: "deleted" };
  }
  if (looksLikeNotFound(result.stderr)) {
    const absence = await confirmGitHubEnvironmentAbsent(
      repo,
      environment,
      ports
    );
    if (absence.absent) {
      ports.invalidateEnvListCache(repo);
      return { outcome: "not_found" };
    }
    return { outcome: "failed", detail: absence.detail };
  }
  return {
    outcome: "failed",
    detail:
      (result.stderr || "").trim() || "Deleting the GitHub environment failed."
  };
}

/**
 * Read a GitHub environment back through the account that created it.
 *
 * The cleanup's identity gate compares the id the name answers for now against
 * the one the ledger recorded, and refuses to delete when it cannot read.
 * Reading on ambient `gh` would answer for whichever account the shell happens
 * to hold, so every cleanup path is handed a reader pinned to the executor the
 * operation selected. A refusal stays a refusal: an unreadable environment must
 * never come back as an empty, successful-looking answer that reads as absence.
 */
export function selectedEnvironmentReader(executor: {
  run(
    args: string[],
    options: { timeout: number }
  ): Promise<{
    code: string | number;
    stdout?: string;
    stderr?: string;
    timedOut?: boolean;
  }>;
}): (args: string[]) => Promise<GitHubEnvironmentCommandResult> {
  return async (args) => {
    // The production executor has no default deadline, so a stalled read
    // would block failure cleanup unless every read carries its own.
    const result = await executor.run(args, {
      timeout: ENVIRONMENT_READ_TIMEOUT_MS
    });
    if (result.timedOut) {
      throw new Error(
        "The selected GitHub account's environment lookup timed out."
      );
    }
    const code = Number(result.code);
    return {
      // A code that will not parse is not a success. Anything but an exact 0
      // leaves the caller unable to claim the environment is gone.
      code: Number.isFinite(code) ? code : 1,
      stdout: String(result.stdout || ""),
      stderr: String(result.stderr || "")
    };
  };
}

export async function ensureGitHubEnvironment(
  input: Omit<EnsureGitHubEnvironmentInput, "recovery" | "now" | "sleep"> & {
    mutationRecovery?: {
      isStopped(): boolean;
      operation: object & { operationId: string };
      persist(): Promise<void>;
    };
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  }
) {
  const { mutationRecovery, ...request } = input;
  return ensureCoreGitHubEnvironment({
    ...request,
    now: input.now ?? Date.now,
    sleep:
      input.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds))),
    recovery:
      mutationRecovery ?
        {
          find: (kind, target) =>
            providerMutationRecord(mutationRecovery.operation, kind, target),
          willWrite: (kind, target) =>
            providerMutationWillWrite(mutationRecovery.operation, kind, target),
          execute: (mutation) =>
            executeRecoverableMutation({
              ...mutation,
              operation: mutationRecovery.operation,
              persist: mutationRecovery.persist,
              rethrowReconciliationError: isSetupExecutionInterrupted,
              assertActive: () => {
                assertSetupExecutionActive(mutationRecovery.isStopped);
                mutation.assertActive?.();
              }
            })
        }
      : undefined
  });
}
