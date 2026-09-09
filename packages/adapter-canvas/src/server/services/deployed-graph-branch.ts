// Canvas adapter — the branch the Deployed tab resolves an application
// definition against.
//
// Shared by `/api/deployed-graph`, which derives the deployed inventory, and by
// the per-resource delete route, which must confirm at dispatch time that the
// canvas is still on the branch the confirmation was taken on. A second copy of
// this precedence would be a way for the two to disagree, which is exactly how a
// destructive action ends up authorized against another branch's definition.

import type { CanvasState } from "../../shared.js";

export type RepoMatchesWorkspace = (
  state: CanvasState,
  repo: string
) => boolean;

/**
 * resolveDeployedGraphBranch - the worktree branch this repository's definition
 * is currently read from.
 *
 * The order is observable: the workspace branch wins, then an explicit page
 * context, then the branch a deploy is running from, then the last planned
 * branch, then the last graph branch. `"main"` is only the floor, never an
 * implicit default that overrides a known branch.
 */
export function resolveDeployedGraphBranch(
  state: CanvasState,
  repo: string,
  repoMatchesWorkspace: RepoMatchesWorkspace
): string {
  if (state.workspaceBranch && repoMatchesWorkspace(state, repo)) {
    return state.workspaceBranch;
  }
  if (state.contextRepo === repo && state.contextBranch) {
    return state.contextBranch;
  }
  if (state.deployingRepo === repo && state.deployingBranch) {
    return state.deployingBranch;
  }
  if (state.plannedRepo === repo && state.plannedBranch) {
    return state.plannedBranch;
  }
  if (state.graphTargetRepo === repo && state.graphBranch) {
    return state.graphBranch;
  }
  return "main";
}

/**
 * modeledResourcesForBranch - the modeled graph the canvas currently holds for
 * exactly this repository and branch, or null when it holds none.
 *
 * Null is meaningful: a delete that cannot be re-checked against a definition
 * must be refused, not approved on the strength of a stale snapshot.
 */
export function modeledResourcesForBranch(
  state: CanvasState,
  repo: string,
  branch: string
): readonly unknown[] | null {
  if (state.graphTargetRepo !== repo || state.graphBranch !== branch) {
    return null;
  }
  return Array.isArray(state.graphResources) ? state.graphResources : null;
}
