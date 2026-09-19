import type { DeploymentState, DeploymentReservation } from "./types.js";
import type { DeploymentRow } from "./deployment-resolver.js";
import { shouldRetryWithKeyringCredential } from "./workflow-credential-fallback.js";
import { discardDeployedApplicationState } from "./deployed-view-state.js";
import type { DeployCommandResult } from "./deploy-dispatch.js";
import type { DeleteConflictProbe } from "./delete-conflict.js";

export interface DeleteApplicationTarget {
  repo: string;
  environment: string;
  application: string;
}

export interface DeleteApplicationPorts {
  isValidRepoSlug(value: unknown): boolean;
  activeDeploymentMutation(
    state: DeploymentState
  ): DeploymentReservation | undefined;
  localDeploymentBlocksMutation(state: DeploymentState): boolean;
  reserveDeploymentMutation(
    state: DeploymentState,
    request: DeleteApplicationTarget & { kind: "delete" }
  ): DeploymentReservation | null;
  releaseDeploymentMutation(
    state: DeploymentState,
    reservation: DeploymentReservation
  ): void;
  resolveEnvDeployment(
    repo: string,
    environment: string,
    application: string
  ): Promise<DeploymentRow | null>;
  deploymentStatusBlocksMutation(status: unknown): boolean;
  probeDeleteConflict(
    target: DeleteApplicationTarget
  ): Promise<DeleteConflictProbe>;
  ensureWorkflowsCurrent(
    repo: string,
    environment: string,
    provider: string,
    files: string[]
  ): Promise<{ created: string[]; failed: { path: string; branch: string }[] }>;
  runGh(
    args: string[],
    timeout?: number,
    env?: Record<string, string | undefined>
  ): Promise<DeployCommandResult>;
  readProcessEnv(): Record<string, string | undefined>;
  findWorkflowRun(
    repo: string,
    workflow: string,
    since: number,
    known: number | string | null
  ): Promise<number | string | null>;
  sleep(ms: number): Promise<void>;
  retainReservation(release: () => void): void;
  invalidateDeployListCache(repo: string): void;
  now(): number;
  workflowFiles: readonly [string, string];
  workflowScopeHelp: { refreshCommand: string; installationNote: string };
}

export interface DeleteApplicationResult {
  status: number;
  body: { error: string } | { success: true; runUrl: string; forced: boolean };
  execution?: {
    state: "uncertain" | "accepted";
    workflow: string;
    dispatchedAt: number;
  };
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const refused = (status: number, error: string): DeleteApplicationResult => ({
  status,
  body: { error }
});

export async function deleteApplication(
  state: DeploymentState,
  target: DeleteApplicationTarget,
  force: boolean,
  ports: DeleteApplicationPorts
): Promise<DeleteApplicationResult> {
  const { repo, environment, application } = target;
  if (!repo || !environment || !application || !ports.isValidRepoSlug(repo)) {
    return refused(
      400,
      "A valid repo, environment, and application are required."
    );
  }
  let reservation: DeploymentReservation | null = null;
  let dispatched = false;
  let accepted = false;
  let mutationAttempted = false;
  let attemptedAt = 0;
  const release = () => {
    if (reservation) ports.releaseDeploymentMutation(state, reservation);
    reservation = null;
  };
  try {
    const reserved = ports.activeDeploymentMutation(state);
    if (ports.localDeploymentBlocksMutation(state) || reserved) {
      const conflictRepo =
        reserved?.repo ||
        state.deployAttempt?.targetRepo ||
        state.deployingRepo ||
        repo;
      const conflictEnvironment =
        reserved?.environment ||
        state.deployAttempt?.environment ||
        state.envName ||
        environment;
      return refused(
        409,
        `A ${reserved?.kind || "deploy"} operation for ${conflictRepo} in environment ${conflictEnvironment} is already in progress. Wait for it to finish before starting another operation.`
      );
    }
    reservation = ports.reserveDeploymentMutation(state, {
      ...target,
      kind: "delete"
    });
    if (!reservation) {
      const conflict = ports.activeDeploymentMutation(state);
      return refused(
        409,
        conflict ?
          `A ${conflict.kind} operation for ${conflict.repo} in environment ${conflict.environment} is already starting.`
        : "Another deployment operation is already starting."
      );
    }
    let current: DeploymentRow | null;
    try {
      current = await ports.resolveEnvDeployment(
        repo,
        environment,
        application
      );
    } catch {
      return refused(
        503,
        "Could not verify the current deployment state. Check your GitHub connection and try again."
      );
    }
    if (current && ports.deploymentStatusBlocksMutation(current.status)) {
      return refused(
        409,
        current.status === "deleting" ?
          "This deployment is already being deleted."
        : "This application is still being deployed to the selected environment. Wait for the deployment to finish before deleting it."
      );
    }
    if (force && current?.status !== "delete-failed") {
      return refused(
        409,
        "A delete can only be forced after a previous delete of this application failed. Run the delete normally first."
      );
    }
    if (force) {
      let proof: DeleteConflictProbe;
      try {
        proof = await ports.probeDeleteConflict(target);
      } catch (error) {
        return refused(
          503,
          `The previous delete failure could not be verified, so this delete was not forced: ${errorMessage(error)}`
        );
      }
      if (proof.state !== "conflict") {
        return refused(
          409,
          proof.state === "clear" ?
            "The previous delete did not fail because a resource was stuck in a non-terminal state, so forcing would not help. Run the delete normally and address the reported failure."
          : `The previous delete failure could not be verified, so this delete was not forced: ${proof.detail}`
        );
      }
    }
    const ghWorkflow = async (args: string[]) => {
      mutationAttempted = true;
      attemptedAt = ports.now();
      const first = await ports.runGh(args);
      if (first.code === 0) return first;
      const env = ports.readProcessEnv();
      if (
        !shouldRetryWithKeyringCredential({
          stderr: first.stderr,
          timedOut: first.timedOut,
          hasInjectedToken: Boolean(
            env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim()
          )
        })
      )
        return first;
      const fallback = { ...env };
      delete fallback.GH_TOKEN;
      delete fallback.GITHUB_TOKEN;
      const retry = await ports.runGh(args, 20000, fallback);
      if (retry.timedOut) return { ...first, timedOut: true };
      return retry.code === 0 ? retry : first;
    };
    const [workflow, providerWorkflow] = ports.workflowFiles;
    const sync = await ports.ensureWorkflowsCurrent(repo, environment, "", [
      workflow,
      providerWorkflow
    ]);
    const commitFail = sync.failed.find(
      (failure) => failure.path.split("/").pop() === workflow
    );
    if (commitFail) {
      return refused(
        400,
        `Couldn't commit the delete workflow (${workflow}) to the "${commitFail.branch}" branch of ${repo}, so there's nothing to dispatch. The branch may be protected or your GitHub token may lack write access to ${repo}.`
      );
    }
    const justCreated = sync.created.some(
      (path) => path.split("/").pop() === workflow
    );
    const dispatchedAt = ports.now();
    const args = [
      "workflow",
      "run",
      workflow,
      "-f",
      "environment=" + environment,
      "-f",
      "application=" + application,
      ...(force ? ["-f", "force=true"] : []),
      "--repo",
      repo
    ];
    let dispatch: DeployCommandResult = { code: 1, stdout: "", stderr: "" };
    if (justCreated) await ports.sleep(3000);
    for (const delay of justCreated || force ? [0, 2000, 5000] : [0]) {
      if (delay > 0) await ports.sleep(delay);
      dispatch = await ghWorkflow(args);
      if (dispatch.code === 0 || dispatch.timedOut) break;
      if (
        !/not found|HTTP 404/i.test(dispatch.stderr || "") &&
        !(force && /unexpected inputs?|HTTP 422/i.test(dispatch.stderr || ""))
      )
        break;
    }
    if (dispatch.code !== 0) {
      const detail = (dispatch.stderr || "").trim();
      const { refreshCommand, installationNote } = ports.workflowScopeHelp;
      const installation = installationNote ? ` ${installationNote}` : "";
      const hint =
        force && /unexpected inputs?|HTTP 422/i.test(detail) ?
          ` GitHub is still rejecting the \`force\` input, which means the copy of ${workflow} on the default branch of ${repo} has not picked up that input yet. It is committed automatically, so wait a moment and retry the forced delete.`
        : /workflow.{0,20}scope/i.test(detail) ?
          refreshCommand ?
            ` Your GitHub token is missing the "workflow" scope. Run \`${refreshCommand}\` in a terminal, then retry.${installation}`
          : ` Your GitHub token is missing the "workflow" scope. ${installationNote}`
        : ` The delete workflow is committed to the default branch automatically before dispatch, so a persistent failure usually means GitHub Actions is disabled for ${repo} or the default branch is protected — check both and retry.`;
      // An ambiguous command must not release admission before GitHub can
      // publish its deployment record. It is never replayed automatically.
      if (dispatch.timedOut) {
        dispatched = true;
        ports.retainReservation(release);
      }
      const result = refused(
        400,
        `Failed to start the delete workflow (${workflow}) on ${repo}. ${detail || "The dispatch request failed."}${hint}`
      );
      if (dispatch.timedOut)
        result.execution = {
          state: "uncertain",
          workflow,
          dispatchedAt: attemptedAt
        };
      return result;
    }
    dispatched = true;
    accepted = true;
    ports.retainReservation(release);
    let runUrl = "";
    try {
      const runId = await ports.findWorkflowRun(
        repo,
        workflow,
        dispatchedAt,
        null
      );
      if (runId) runUrl = `https://github.com/${repo}/actions/runs/${runId}`;
    } catch {
      // Discovery is observational. Failure cannot undo an accepted dispatch.
    }
    ports.invalidateDeployListCache(repo);
    discardDeployedApplicationState(state, target);
    return { status: 200, body: { success: true, runUrl, forced: force } };
  } catch (error) {
    if (mutationAttempted && !dispatched) {
      dispatched = true;
      ports.retainReservation(release);
    }
    const result = refused(400, errorMessage(error));
    if (mutationAttempted)
      result.execution = {
        state: accepted ? "accepted" : "uncertain",
        workflow: ports.workflowFiles[0],
        dispatchedAt: attemptedAt
      };
    return result;
  } finally {
    if (!dispatched) release();
  }
}
