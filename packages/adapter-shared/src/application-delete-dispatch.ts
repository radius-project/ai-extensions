import {
  BARE_GH_COMMAND_PRESENTATION,
  DELETE_APP_DISPATCHER_FILE,
  displayGhCommand,
  shouldRetryWithKeyringCredential,
  type ApplicationDeletionDispatch,
  type ApplicationDeletionRequest,
  type GhCommandPresentation
} from "@radius-project/core";

export interface ApplicationDeleteDispatchPorts {
  now(): number;
  id(): string;
  ghCommandPresentation?: GhCommandPresentation;
  ensureWorkflowsCurrent(
    repo: string,
    environment: string,
    provider: string,
    only: string[]
  ): Promise<{
    created: string[];
    failed: { path: string; branch: string }[];
  }>;
  deleteApplicationWorkflowFiles: readonly string[];
  findWorkflowRun(
    repo: string,
    file: string,
    since: number,
    known: null,
    correlation: string
  ): Promise<number | string | null>;
  runGh(
    args: string[],
    timeout?: number,
    extraEnv?: NodeJS.ProcessEnv
  ): Promise<CommandResult>;
  readProcessEnv(): NodeJS.ProcessEnv;
  sleep(ms: number): Promise<void>;
}

interface CommandResult {
  code: string | number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

function dispatchUnconfirmed(result: CommandResult): boolean {
  return (
    result.timedOut === true ||
    /connection reset|connection .*closed|ECONNRESET|socket hang up|\bEOF\b|timed? ?out|HTTP 5\d\d/i.test(
      result.stderr
    )
  );
}

export async function dispatchApplicationDelete(
  { repo, environment, application, force }: ApplicationDeletionRequest,
  dependencies: ApplicationDeleteDispatchPorts
): Promise<ApplicationDeletionDispatch> {
  // Dispatching a workflow requires the `workflow` scope, which an injected
  // GH_TOKEN often lacks. Retry with it stripped ONLY when that fallback is
  // safe: the failure names the missing scope, and the dispatch did not time
  // out (a timed-out dispatch may already have been accepted, and a retry
  // would start a second delete run).
  const ghWorkflow = async (args: string[]): Promise<CommandResult> => {
    const first = await dependencies.runGh(args);
    if (first.code === 0 || dispatchUnconfirmed(first)) return first;
    const env = dependencies.readProcessEnv();
    const retryAllowed = shouldRetryWithKeyringCredential({
      stderr: first.stderr,
      timedOut: first.timedOut,
      hasInjectedToken: Boolean(
        env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim()
      )
    });
    if (!retryAllowed) return first;
    const fallbackEnv = { ...env };
    delete fallbackEnv.GH_TOKEN;
    delete fallbackEnv.GITHUB_TOKEN;
    const retry = await dependencies.runGh(args, 20000, fallbackEnv);
    return retry.code === 0 || dispatchUnconfirmed(retry) ? retry : first;
  };

  // Deleting a deployment runs `rad app delete` via the committed
  // delete-application.yml workflow. This tears down the Radius application on
  // the ephemeral control plane while leaving the GitHub Environment (and its
  // credentials) intact.
  //
  // Ensure the delete workflow files are in sync with upstream before
  // dispatching, so the run never executes a drifted copy — and author them if
  // they're missing (the #273 case). Delete workflow content is
  // provider-agnostic, and workflow_dispatch runs from the default branch, so
  // provider/workingBranch aren't needed.
  const sync = await dependencies.ensureWorkflowsCurrent(
    repo,
    environment,
    "",
    [...dependencies.deleteApplicationWorkflowFiles]
  );
  // If the sync couldn't commit the dispatcher to the default branch (e.g.
  // it's protected, or the token lacks write access), the dispatch below will
  // 404 on a genuinely-absent workflow. Fail fast with a specific message
  // naming the branch instead of the generic hint.
  const commitFail = sync.failed.find(
    (f) => f.path.split("/").pop() === DELETE_APP_DISPATCHER_FILE
  );
  if (commitFail) {
    return {
      kind: "refused",
      error:
        "Couldn't commit the delete workflow (" +
        DELETE_APP_DISPATCHER_FILE +
        ') to the "' +
        commitFail.branch +
        '" branch of ' +
        repo +
        ", so there's nothing to dispatch. The branch may be protected" +
        " or your GitHub token may lack write access to " +
        repo +
        "."
    };
  }
  // A just-authored workflow isn't registered by GitHub synchronously, so an
  // immediate workflow_dispatch would 404. When we created it, wait briefly
  // and retry the not-found race a few times (mirroring the create-environment
  // verify dispatch); when it was already present, the single [0]-delay
  // attempt keeps the common path fast.
  const justCreated = sync.created.some(
    (p) => p.split("/").pop() === DELETE_APP_DISPATCHER_FILE
  );
  const dispatchedAt = dependencies.now();
  const correlationId = `dep-${dependencies.id()}`;
  if (
    !/^dep-[a-zA-Z0-9-]{1,64}$/.test(correlationId) ||
    `Radius - Delete ${environment} [radius:v1 app=${application}] ${correlationId}`
      .length > 256
  )
    throw new Error(
      "The delete identity cannot fit the supported run-title contract. No workflow was dispatched."
    );
  const dispatchArgs = [
    "workflow",
    "run",
    DELETE_APP_DISPATCHER_FILE,
    "-f",
    "environment=" + environment,
    "-f",
    "application=" + application,
    "-f",
    "correlation_id=" + correlationId,
    ...(force ? ["-f", "force=true"] : []),
    "--repo",
    repo
  ];
  let dispatch: CommandResult = { code: 1, stdout: "", stderr: "" };
  // A `force` dispatch also has to survive the *input-schema* race: the
  // dispatcher that was just committed or updated declares the `force` input,
  // but GitHub answers 422 "unexpected inputs" until it has re-read the file
  // from the default branch. Give that the same bounded retry the
  // not-yet-registered workflow gets, rather than reporting a failure the
  // user cannot act on.
  const dispatchDelays = [0, 2000, 5000];
  if (justCreated) await dependencies.sleep(3000);
  for (const delay of dispatchDelays) {
    // `> 0` vs `> 1` is equivalent over the fixed delay set {0, 2000, 5000}:
    // no member lies between the two thresholds.
    if (delay > 0) await dependencies.sleep(delay);
    dispatch = await ghWorkflow(dispatchArgs);
    if (dispatch.code === 0) break;
    if (dispatchUnconfirmed(dispatch)) break;
    // Only the not-found registration race and the unexpected-input race
    // self-resolve; any other failure (scope, Actions disabled, …) won't, so
    // stop retrying.
    if (
      !/not found|HTTP 404/i.test(dispatch.stderr || "") &&
      !/unexpected inputs?/i.test(dispatch.stderr || "")
    ) {
      break;
    }
  }
  if (dispatch.code !== 0) {
    const de = (dispatch.stderr || "").trim();
    if (dispatchUnconfirmed(dispatch))
      return {
        kind: "ambiguous",
        error: `GitHub did not confirm whether the delete workflow started on ${repo}. Check Actions before retrying.`
      };
    // `{0,20}` vs `{1,20}` differs only for the literal "workflowscope" with
    // no separator, which no real `gh` diagnostic emits; left alive.
    const ghCommandPresentation =
      dependencies.ghCommandPresentation || BARE_GH_COMMAND_PRESENTATION;
    const refreshCommand = displayGhCommand(ghCommandPresentation, [
      "auth",
      "refresh",
      "-h",
      "github.com",
      "-s",
      "workflow"
    ]);
    const installation =
      ghCommandPresentation.installationNote ?
        ` ${ghCommandPresentation.installationNote}`
      : "";
    // An exhausted unexpected-input retry is a stale dispatcher, not a
    // permissions or Actions problem, so it says so instead of sending the
    // user to check settings that are already correct.
    const staleForceInput = /unexpected inputs?/i.test(de);
    const hint =
      staleForceInput ?
        " GitHub is still rejecting " +
        (force ? "the `force` input" : "the workflow inputs") +
        ", which means the copy" +
        " of " +
        DELETE_APP_DISPATCHER_FILE +
        " on the default branch of " +
        repo +
        " has not picked up that input yet. It is committed automatically," +
        " so wait a moment and retry the forced delete."
      : /workflow.{0,20}scope/i.test(de) ?
        refreshCommand ?
          ` Your GitHub token is missing the "workflow" scope. Run \`${refreshCommand}\` in a terminal, then retry.${installation}`
        : ` Your GitHub token is missing the "workflow" scope. ${ghCommandPresentation.installationNote}`
      : " The delete workflow is committed to the default branch" +
        " automatically before dispatch, so a persistent failure usually" +
        " means GitHub Actions is disabled for " +
        repo +
        " or the default branch is protected — check both and retry.";
    return {
      kind: "refused",
      error:
        "Failed to start the delete workflow (" +
        DELETE_APP_DISPATCHER_FILE +
        ") on " +
        repo +
        ". " +
        (de || "The dispatch request failed.") +
        hint
    };
  }

  return {
    kind: "accepted",
    async discoverRunUrl() {
      const runId = await dependencies.findWorkflowRun(
        repo,
        DELETE_APP_DISPATCHER_FILE,
        dispatchedAt,
        null,
        correlationId
      );
      return runId ? `https://github.com/${repo}/actions/runs/${runId}` : "";
    }
  };
}
