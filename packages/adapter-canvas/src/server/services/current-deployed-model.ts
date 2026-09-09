// Canvas adapter — the application definition as it stands RIGHT NOW, reloaded
// from the exact repository and branch the canvas currently reads it from.
//
// Exists for one reason: a per-resource delete is authorized against a modeled
// graph, and everything between that authorization and the workflow dispatch is
// awaited work — resolving GitHub's deployment record, committing the delete
// workflows, waiting out a registration race. A definition read before those
// awaits is a claim about the past. This service re-reads it after them, through
// the same modeled-graph loader `/api/deployed-graph` uses, so the delete is
// dispatched against a definition the server has just confirmed rather than one
// it remembers.
//
// Fails closed everywhere: a load failure, a branch that moved while the load
// ran, or a modeled graph that is no longer held for exactly this repository and
// branch all resolve to "not ok", never to a stale fallback.

import type { CanvasState } from "../../shared.js";
import {
  modeledResourcesForBranch,
  resolveDeployedGraphBranch,
  type RepoMatchesWorkspace
} from "./deployed-graph-branch.js";
import {
  deployedInventoryRevision,
  type DeployedResourceIdentity
} from "./deployed-inventory.js";

// The modeled-graph loader, narrowed to what this service calls. Shaped exactly
// like the `loadModeledGraph` seam the graphs-planning reads already inject, so
// both paths build the definition through one workflow and one cache.
export type ReloadModeledGraph = (
  instanceId: string,
  repo: string,
  branch: string
) => Promise<{ status: number; error?: string; retry?: boolean }>;

export interface CurrentDeployedModelDependencies {
  readInstanceEntry(instanceId: string): { state?: CanvasState } | undefined;
  repoMatchesWorkspace: RepoMatchesWorkspace;
  reloadModeledGraph: ReloadModeledGraph;
}

export interface CurrentDeployedModelRequest {
  instanceId: string;
  repo: string;
  environment: string;
  application: string;
  // The deployed identities the confirmation was taken against. The revision is
  // only comparable when it is re-derived over the same deployed set, so the
  // caller pins it here rather than letting this service guess at one.
  deployed: readonly DeployedResourceIdentity[];
}

export interface CurrentDeployedModel {
  // The branch this repository's definition is currently read from.
  branch: string;
  // The modeled resources of that branch, or null when the canvas holds none.
  // Null is meaningful rather than empty: a delete that cannot be re-checked
  // against a definition must be refused, not approved on the strength of a
  // stale snapshot.
  modeled: readonly unknown[] | null;
  // The deterministic revision that branch's definition produces for the given
  // selection, or null when there is no definition to derive one from.
  revision: string | null;
}

export type LoadedCurrentDeployedModel =
  | { ok: true; model: CurrentDeployedModel }
  | { ok: false; status: number; error: string };

export interface CurrentDeployedModelState {
  state: CanvasState;
  repo: string;
  environment: string;
  application: string;
  deployed: readonly DeployedResourceIdentity[];
  repoMatchesWorkspace: RepoMatchesWorkspace;
}

/**
 * readCurrentDeployedModel - the definition the canvas holds for this
 * repository's active branch right now, plus the revision it produces for the
 * given selection.
 *
 * Synchronous: it reports what state already holds. `loadCurrentDeployedModel`
 * below is the same answer after re-reading the definition from its source.
 */
export function readCurrentDeployedModel(
  input: CurrentDeployedModelState
): CurrentDeployedModel {
  const branch = resolveDeployedGraphBranch(
    input.state,
    input.repo,
    input.repoMatchesWorkspace
  );
  const modeled = modeledResourcesForBranch(input.state, input.repo, branch);
  return {
    branch,
    modeled,
    revision:
      modeled ?
        deployedInventoryRevision({
          repo: input.repo,
          branch,
          environment: input.environment,
          application: input.application,
          complete: true,
          modeled,
          resources: input.deployed
        })
      : null
  };
}

/**
 * loadCurrentDeployedModel - reload the modeled application definition for the
 * branch this repository is currently read from, and report the deterministic
 * revision it produces for the given selection.
 *
 * The branch is resolved both before and after the reload. They can differ: the
 * user can switch worktree branches while the load runs, and a definition
 * loaded for the old branch says nothing about the new one.
 *
 * `ok: false` is reserved for a model that could not be established at all. A
 * reload that succeeds but leaves no definition for the branch is reported as
 * `modeled: null`, which the authorization refuses on its own terms.
 */
export async function loadCurrentDeployedModel(
  dependencies: CurrentDeployedModelDependencies,
  request: CurrentDeployedModelRequest
): Promise<LoadedCurrentDeployedModel> {
  const before = dependencies.readInstanceEntry(request.instanceId)?.state;
  if (!before) {
    return {
      ok: false,
      status: 503,
      error: "Canvas server state is unavailable."
    };
  }
  const branch = resolveDeployedGraphBranch(
    before,
    request.repo,
    dependencies.repoMatchesWorkspace
  );
  let reload: { status: number; error?: string };
  try {
    reload = await dependencies.reloadModeledGraph(
      request.instanceId,
      request.repo,
      branch
    );
  } catch (error) {
    return {
      ok: false,
      status: 503,
      error: `The application definition of ${request.repo} on "${branch}" could not be re-read: ${
        error instanceof Error ? error.message : String(error)
      }`
    };
  }
  if (reload.error || reload.status >= 400) {
    return {
      ok: false,
      status: 503,
      error: `The application definition of ${request.repo} on "${branch}" could not be re-read: ${
        reload.error || `modeled graph load failed with status ${reload.status}`
      }`
    };
  }
  const after = dependencies.readInstanceEntry(request.instanceId)?.state;
  if (!after) {
    return {
      ok: false,
      status: 503,
      error: "Canvas server state is unavailable."
    };
  }
  const model = readCurrentDeployedModel({
    state: after,
    repo: request.repo,
    environment: request.environment,
    application: request.application,
    deployed: request.deployed,
    repoMatchesWorkspace: dependencies.repoMatchesWorkspace
  });
  // A branch that moved during the reload explains why the definition no longer
  // matches, so it is reported as its own failure rather than as a definition
  // that happens to disagree.
  if (model.branch !== branch) {
    return {
      ok: false,
      status: 409,
      error: `The canvas moved from branch "${branch}" to "${model.branch}" while the application definition was being re-read.`
    };
  }
  return { ok: true, model };
}
