import type { CanvasState } from "../../shared.js";

/** The deployment a delete is about to tear down. */
export interface DeletedDeploymentIdentity {
  environment: string;
  application: string;
}

export function captureDeployedApplicationState(
  state: CanvasState,
  target: DeletedDeploymentIdentity & { repo: string }
): () => void {
  const captured = { ...state };
  const repository = (value: CanvasState) =>
    firstNamed(
      value.deployAttempt?.targetRepo,
      value.deployingRepo,
      value.deployedGraphRepo,
      value.contextRepo,
      value.workspaceRepo
    );
  const capturedRepository = repository(state);
  const attemptId = state.deployAttempt?.id;
  const attemptRepo = state.deployAttempt?.targetRepo;
  const attemptEnvironment = state.deployAttempt?.environment;
  const keys = [
    "deployAttempt",
    "deployGeneration",
    "deployRunId",
    "deployRunUrl",
    "deployStatus",
    "deployedGraph",
    "deployedGraphRepo",
    "deployingResources",
    "deployAppName",
    "deployEnvName",
    "envName"
  ] as const;
  const matches =
    capturedRepository.toLowerCase() === target.repo.toLowerCase() &&
    matchesDeployedApplicationState(captured, target);
  return () => {
    if (
      matches &&
      repository(state) === capturedRepository &&
      state.deployAttempt?.id === attemptId &&
      state.deployAttempt?.targetRepo === attemptRepo &&
      state.deployAttempt?.environment === attemptEnvironment &&
      keys.every((key) => state[key] === captured[key])
    )
      discardDeployedApplicationState(state, target);
  };
}

// Radius environment and application names are matched case-insensitively
// everywhere the canvas compares a selection to session state, so this uses the
// same rule rather than a second, stricter one.
function namesMatch(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

// The first candidate that actually names something. A plain `a || b` would
// stop at a blank-but-truthy string, and nothing trims what reaches
// `deployEnvName`: prepareAndDispatch persists `envName || requestedEnvironment
// || "dev"` as-is, so a whitespace-only request is stored verbatim. The Deployed
// view falls back to `envName` when rendering such a graph, so resolving the
// same way here is what keeps "discarded" and "rendered" describing one set.
function firstNamed(...candidates: (string | undefined)[]): string {
  return candidates.find((candidate) => candidate && candidate.trim()) || "";
}

/**
 * discardDeployedApplicationState - forget this session's copy of a deployed
 * application graph when that application is being deleted.
 *
 * The Deployed view is rendered from two sources: the deploy-status workflow
 * artifact (which the delete workflow removes for exactly this environment and
 * application) and the session's own record of the deploy it ran. Removing only
 * the artifact would still leave the session that pressed Delete rendering
 * "Last deployment ..." from `deployedGraph` and a `complete` deploy status for
 * the rest of its life, so the session-held copy is retired here.
 *
 * Scoped to one deployment: the state is only cleared when it describes the
 * exact (environment, application) pair being deleted. A session holding
 * another application's graph, or the same application's graph in another
 * environment, is left untouched. An unnamed session deployment matches
 * nothing, so an unidentifiable graph is never discarded. "Unnamed" means
 * blank, not merely absent: a whitespace-only `deployEnvName` names no
 * environment, so the session's selected environment is used instead — the same
 * resolution the Deployed view uses to decide which environment that graph
 * belongs to.
 *
 * Safe to call before the delete run finishes: if the delete fails, the
 * artifact still exists and the next read repopulates the view.
 *
 * Returns whether the state described the deployment being deleted, not whether
 * any field actually changed: clearing is idempotent, so a repeated call for
 * the same identity still returns true with nothing left to clear.
 */
export function discardDeployedApplicationState(
  state: CanvasState,
  target: DeletedDeploymentIdentity
): boolean {
  if (!matchesDeployedApplicationState(state, target)) return false;
  state.deployedGraph = null;
  state.deployedGraphRepo = undefined;
  // Per-resource statuses and a complete attempt can each render a successful graph.
  state.deployingResources = null;
  state.deployStatus = "";
  state.deployRunId = null;
  return true;
}

export function matchesDeployedApplicationState(
  state: Pick<CanvasState, "deployEnvName" | "envName" | "deployAppName">,
  target: DeletedDeploymentIdentity
): boolean {
  if (!target.environment.trim() || !target.application.trim()) return false;
  const sessionEnvironment = firstNamed(state.deployEnvName, state.envName);
  const sessionApplication = firstNamed(state.deployAppName);
  if (!sessionEnvironment || !sessionApplication) return false;
  if (
    !namesMatch(sessionEnvironment, target.environment) ||
    !namesMatch(sessionApplication, target.application)
  ) {
    return false;
  }
  return true;
}
