import type { CanvasState } from "../../shared.js";

/** The deployment a delete is about to tear down. */
export interface DeletedDeploymentIdentity {
  environment: string;
  application: string;
}

// Radius environment and application names are matched case-insensitively
// everywhere the canvas compares a selection to session state, so this uses the
// same rule rather than a second, stricter one.
function namesMatch(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
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
 * nothing, so an unidentifiable graph is never discarded.
 *
 * Safe to call before the delete run finishes: if the delete fails, the
 * artifact still exists and the next read repopulates the view.
 *
 * Returns whether anything was discarded.
 */
export function discardDeployedApplicationState(
  state: CanvasState,
  target: DeletedDeploymentIdentity
): boolean {
  if (!target.environment.trim() || !target.application.trim()) return false;
  const sessionEnvironment = state.deployEnvName || state.envName || "";
  const sessionApplication = state.deployAppName || "";
  if (!sessionEnvironment.trim() || !sessionApplication.trim()) return false;
  if (
    !namesMatch(sessionEnvironment, target.environment) ||
    !namesMatch(sessionApplication, target.application)
  ) {
    return false;
  }
  state.deployedGraph = null;
  state.deployedGraphRepo = undefined;
  // Per-resource statuses seed the Deployed view even when no graph was
  // published, and a `complete` status alone settles every node green, so both
  // have to go with the graph.
  state.deployingResources = null;
  state.deployStatus = "";
  state.deployRunId = null;
  return true;
}
