// Shared "current workspace + bicep fetch" helpers used by both createRadiusCanvas
// and createRadiusTools. Factored out so the two factories don't duplicate the
// same dependency-driven logic.

import type { RadiusExtensionDependencies } from "./dependencies.js";
import type { CanvasState } from "../shared.js";

export interface GraphContextHelpers {
  workspaceState(): Promise<CanvasState>;
  fetchBicepForBranch(
    repo: string,
    branch: string,
    state: CanvasState
  ): Promise<string | null>;
  listBranchPaths(
    repo: string,
    branch: string,
    state: CanvasState
  ): Promise<string[]>;
}

export function createGraphContextHelpers(
  deps: RadiusExtensionDependencies
): GraphContextHelpers {
  async function workspaceState(): Promise<CanvasState> {
    const session = deps.session.get();
    const workspace = await deps.workspace.detectWorkspaceContext(session);
    return {
      workspacePath: workspace.workspacePath,
      workspaceRepo: workspace.repo,
      workspaceBranch: workspace.branch,
      contextRepo: workspace.repo,
      contextBranch: workspace.branch
    };
  }

  async function fetchBicepForBranch(
    repo: string,
    branch: string,
    state: CanvasState
  ): Promise<string | null> {
    if (deps.workspace.isWorkspaceSelection(state, repo, branch)) {
      const local = await deps.workspace.fetchWorkspaceBicep(
        state,
        repo,
        branch
      );
      if (local) return local;
    }
    return await deps.core.fetchBicepFromRepo(deps.github, repo, branch);
  }

  // Every path on a branch, resolved through the same workspace-or-remote rule
  // as fetchBicepForBranch so the answer describes the tree the graph would be
  // built from. Resolves empty when the tree cannot be read.
  async function listBranchPaths(
    repo: string,
    branch: string,
    state: CanvasState
  ): Promise<string[]> {
    if (deps.workspace.isWorkspaceSelection(state, repo, branch)) {
      const local = await deps.workspace.fetchWorkspaceTree(
        state,
        repo,
        branch
      );
      if (local) return local;
    }
    return await deps.github.treePaths(repo, branch);
  }

  return { workspaceState, fetchBicepForBranch, listBranchPaths };
}
