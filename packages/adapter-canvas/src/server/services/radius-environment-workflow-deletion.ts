import {
  DELETE_ENV_DISPATCHER_FILE,
  WORKFLOW_READ_LIMITS,
  type WorkflowRunDetail
} from "@radius-project/core";
import {
  createWorkflowReadSession,
  type WorkflowReadRequest
} from "@radius-project/adapter-shared";
import { classifyCompletedDeleteEnvRun } from "./delete-env-run-classifier.js";
import { verifyWorkflowFilesMatchSource } from "./delete-environment-workflow-verification.js";
import type { RadiusEnvDeletionOutcome } from "./environment-deletion.js";
import type { GhCommandResult } from "./gh-command-result.js";
import { shouldRetryWithKeyringCredential } from "./workflow-credential-fallback.js";

export interface EnvironmentDeletionDispatch {
  dispatchedAt: number;
  correlationId: string;
}

export type RadiusEnvironmentWorkflowDeletionDependencies = {
  // The delete dispatcher and every provider workflow it `uses:`.
  readonly workflowFiles: readonly string[];
  ensureWorkflowsCurrent(
    repo: string,
    environment: string,
    provider: string,
    only: string[]
  ): Promise<{ created: string[] }>;
  generateDeleteWorkflow(environment: string): Promise<Record<string, string>>;
  getDefaultBranch(repo: string): Promise<string | null>;
  fetchFileFromRepo(
    repo: string,
    path: string,
    branch: string
  ): Promise<string | null>;
  // `gh` with a 30s timeout. Resolves, never rejects, on a non-zero exit.
  runGh(
    args: string[],
    options?: { env?: NodeJS.ProcessEnv }
  ): Promise<GhCommandResult>;
  // The live process environment, read when a dispatch fails.
  readonly processEnv?: NodeJS.ProcessEnv;
  findWorkflowRun(
    repo: string,
    workflowFile: string,
    sinceMs: number,
    knownId: null,
    executor: undefined,
    afterRunId: undefined,
    correlationId: string
  ): Promise<number | string | null>;
  getRunDetail(
    repo: string,
    runId: number | string,
    executor: undefined,
    request: WorkflowReadRequest
  ): Promise<
    | (Pick<WorkflowRunDetail, "status" | "conclusion"> &
        Partial<Pick<WorkflowRunDetail, "steps">>)
    | null
  >;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
  random(): number;
  errorMessage(error: unknown): string;
} & (
  | {
      readonly readIdentity: "selected";
      getBranchHead(repo: string, branch: string): Promise<string>;
      beforeDispatch(dispatch: EnvironmentDeletionDispatch): Promise<void>;
      recoverDispatch?(): EnvironmentDeletionDispatch | undefined;
    }
  | {
      readonly readIdentity?: undefined;
      getBranchHead?: never;
      beforeDispatch?: never;
      recoverDispatch?: never;
    }
);

// Dispatch the just-committed delete-environment workflow and wait for its run
// to finish. Tearing down the Radius environment needs cluster access, so it
// runs on the ephemeral control plane the workflow spins up (authenticating with
// the environment's still-present federated credential — hence this must run
// before the credential is removed). Best-effort: a dispatch or run failure is
// reported as a `failed` outcome the runner records as a warning, never a throw.
export function createRadiusEnvironmentWorkflowDeletion(
  dependencies: RadiusEnvironmentWorkflowDeletionDependencies
): (
  input: { repo: string; environment: string },
  onHeartbeat?: () => void | Promise<void>
) => Promise<RadiusEnvDeletionOutcome> {
  return async (
    { repo, environment },
    onHeartbeat
  ): Promise<RadiusEnvDeletionOutcome> => {
    async function observe({
      dispatchedAt,
      correlationId
    }: EnvironmentDeletionDispatch): Promise<RadiusEnvDeletionOutcome> {
      const deadline = dependencies.now() + 30 * 60 * 1000;
      let runId: number | string | null = null;
      const reads = createWorkflowReadSession();
      let delayMs = 5000;
      while (dependencies.now() < deadline) {
        if (!runId) {
          runId = await dependencies.findWorkflowRun(
            repo,
            DELETE_ENV_DISPATCHER_FILE,
            dispatchedAt,
            null,
            undefined,
            undefined,
            correlationId
          );
        }
        if (dependencies.now() >= deadline) break;
        if (runId) {
          const detail = await dependencies.getRunDetail(
            repo,
            runId,
            undefined,
            {
              identity: dependencies.readIdentity ?? "ambient",
              context: reads.observe(WORKFLOW_READ_LIMITS.runMs)
            }
          );
          if (detail && detail.status === "completed") {
            return classifyCompletedDeleteEnvRun(
              detail.conclusion,
              detail.steps || []
            );
          }
        }
        if (onHeartbeat) {
          try {
            await onHeartbeat();
          } catch {
            // A heartbeat failure must never abort an in-flight deletion.
          }
        }
        await dependencies.sleep(
          Math.min(delayMs, Math.max(0, deadline - dependencies.now()))
        );
        delayMs = Math.min(Math.ceil(delayMs * 1.5), 15000);
      }
      return {
        outcome: "failed",
        detail:
          runId ?
            "The delete-environment workflow did not complete within 30 minutes."
          : dependencies.readIdentity === "selected" ?
            "GitHub may have accepted the delete-environment workflow, but Radius could not confirm its outcome. Check GitHub Actions before starting another deletion."
          : "The delete-environment workflow was dispatched but its run could not be found to confirm completion."
      };
    }
    const recovered = dependencies.recoverDispatch?.();
    if (recovered) return observe(recovered);
    const workflowFiles = [...dependencies.workflowFiles];
    const sync = await dependencies.ensureWorkflowsCurrent(
      repo,
      environment,
      "",
      workflowFiles
    );
    // Committing the workflows is best-effort and can silently no-op (a protected
    // branch, or an exception `ensureWorkflowsCurrent` swallows), and the delete
    // dispatcher `uses:` the reusable provider file that carries the "no deployed
    // applications" safety guard. `gh workflow run` resolves BOTH files from the
    // default branch, so before dispatching we read BOTH back from that branch and
    // confirm they match the packaged source. Any file that is missing, stale, or
    // unreadable stops the deletion here — a stale provider means a stale guard,
    // and dispatching against it could tear down an environment that still has
    // deployed applications. (The narrow `sync.failed` list only names files whose
    // commit definitely failed; the read-back is the authoritative gate because it
    // also catches a swallowed sync exception that reports no failure at all.)
    let expectedDeleteWorkflows: Record<string, string>;
    try {
      expectedDeleteWorkflows =
        await dependencies.generateDeleteWorkflow(environment);
    } catch (error) {
      return {
        outcome: "failed",
        detail: `Could not build the delete-environment workflow templates to verify them: ${dependencies.errorMessage(
          error
        )}`
      };
    }
    let verifiedHead: string | undefined;
    const workflowVerification = await verifyWorkflowFilesMatchSource(
      workflowFiles.map((file) => ({
        file,
        path: `.github/workflows/${file}`,
        expected: expectedDeleteWorkflows[file] || ""
      })),
      {
        defaultBranch: async () => {
          const branch = (await dependencies.getDefaultBranch(repo)) || "";
          if (branch && dependencies.readIdentity === "selected") {
            verifiedHead = await dependencies.getBranchHead(repo, branch);
            if (!/^[a-f0-9]{40}$/i.test(verifiedHead))
              throw new Error("Could not verify the default branch revision.");
          }
          return branch;
        },
        readFile: (path, branch) =>
          dependencies.fetchFileFromRepo(repo, path, verifiedHead ?? branch),
        errorMessage: dependencies.errorMessage
      }
    );
    if (!workflowVerification.ok) {
      return {
        outcome: "failed",
        detail: `${workflowVerification.detail} Radius did not start the deletion of "${environment}" in ${repo}.`
      };
    }
    const ghWorkflow = async (args: string[]): Promise<GhCommandResult> => {
      const first = await dependencies.runGh(args);
      if (first.code === 0 || dependencies.readIdentity === "selected")
        return first;
      const env = dependencies.processEnv;
      // Dispatching a workflow requires the `workflow` scope, which an injected
      // GH_TOKEN often lacks. Retry with it stripped ONLY when that fallback is
      // safe: the failure positively names the missing scope, and the dispatch did
      // not time out. A timed-out (or otherwise killed) dispatch may already have
      // been accepted by GitHub, so re-running it would start the destructive
      // delete workflow a SECOND time; and the retry runs as whichever account the
      // keyring holds, so it must never be entered on an unknown failure.
      const retryAllowed = shouldRetryWithKeyringCredential({
        stderr: first.stderr,
        timedOut: first.timedOut === true,
        hasInjectedToken: Boolean(
          env?.GH_TOKEN?.trim() || env?.GITHUB_TOKEN?.trim()
        )
      });
      if (!retryAllowed) return first;
      const fallbackEnv = { ...env };
      delete fallbackEnv.GH_TOKEN;
      delete fallbackEnv.GITHUB_TOKEN;
      const retry = await dependencies.runGh(args, { env: fallbackEnv });
      return retry.code === 0 ? retry : first;
    };
    const justCreated = sync.created.some(
      (p) => p.split("/").pop() === DELETE_ENV_DISPATCHER_FILE
    );
    const dispatchedAt = dependencies.now();
    // A unique id echoed into the run's display name (via the dispatcher's
    // `run-name:`) so the specific run this call started can be matched exactly —
    // never a concurrent or manual deletion of a different environment.
    const correlationId = `del-${dispatchedAt.toString(36)}-${dependencies
      .random()
      .toString(36)
      .slice(2, 10)}`;
    const dispatchArgs = [
      "workflow",
      "run",
      DELETE_ENV_DISPATCHER_FILE,
      "-f",
      "environment=" + environment,
      "-f",
      "correlation_id=" + correlationId,
      "--repo",
      repo
    ];
    if (dependencies.readIdentity === "selected")
      dispatchArgs.push("--ref", workflowVerification.branch);
    let dispatch: GhCommandResult = { code: 1, stdout: "", stderr: "" };
    const dispatchDelays = justCreated ? [0, 2000, 5000] : [0];
    if (justCreated) await dependencies.sleep(3000);
    for (const delay of dispatchDelays) {
      if (delay > 0) await dependencies.sleep(delay);
      if (dependencies.readIdentity === "selected") {
        // GitHub dispatch accepts a branch ref, not a commit pin. Refuse
        // observed drift before recording intent; the API does not make this atomic.
        const branch = workflowVerification.branch;
        try {
          if (
            (await dependencies.getDefaultBranch(repo)) !== branch ||
            (await dependencies.getBranchHead(repo, branch)) !== verifiedHead
          ) {
            return {
              outcome: "failed",
              detail:
                "The default branch changed after workflow verification. Radius did not start the deletion."
            };
          }
        } catch (error) {
          return {
            outcome: "failed",
            detail: `Could not recheck the default branch before deletion: ${dependencies.errorMessage(error)}`
          };
        }
        await dependencies.beforeDispatch({ dispatchedAt, correlationId });
      }
      dispatch = await ghWorkflow(dispatchArgs);
      if (dispatch.code === 0) break;
      if (!/not found|HTTP 404/i.test(dispatch.stderr || "")) break;
    }
    if (dispatch.code !== 0) {
      return {
        outcome: "failed",
        detail:
          (dispatch.stderr || "").trim() ||
          `Failed to start ${DELETE_ENV_DISPATCHER_FILE} on ${repo}.`
      };
    }
    return observe({ dispatchedAt, correlationId });
  };
}
