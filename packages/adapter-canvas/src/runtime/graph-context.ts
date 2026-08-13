// Shared "current workspace + bicep fetch" helpers used by both createRadiusCanvas
// and createRadiusTools. Factored out so the two factories don't duplicate the
// same dependency-driven logic.

import {
  APP_ORIGIN_REPO_PATH,
  APP_ORIGIN_ROOT_PATH,
  evaluateAppModelFreshness,
  parseAppOrigin
} from "@radius-project/core";
import type { AppModelFreshness } from "@radius-project/core";
import { hashAppBicep } from "../app-bicep-hash.js";
import type { RadiusExtensionDependencies } from "./dependencies.js";
import type { CanvasState } from "../shared.js";

// A branch's application model, classified. `refreshable` is the branch-safety
// half of the decision: the skill writes the working tree, so only a model that
// actually came from the worktree can be refreshed by regenerating. Refreshing
// any other branch would need a commit and a push, which modeling deliberately
// never does.
export interface AppModelStatus {
  repo: string;
  branch: string;
  refreshable: boolean;
  freshness: AppModelFreshness;
}

export interface GraphContextHelpers {
  workspaceState(): Promise<CanvasState>;
  fetchBicepForBranch(
    repo: string,
    branch: string,
    state: CanvasState
  ): Promise<string | null>;
  resolveAppModelStatus(
    repo: string,
    branch: string,
    state: CanvasState
  ): Promise<AppModelStatus>;
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

  // The model itself is read from `.radius/app.bicep` or, for older layouts, a
  // root `app.bicep`, and the record is written beside whichever one the
  // generator wrote. So the record has to be looked for in both places, or a
  // root-level model would read as permanently unrecorded.
  async function readAppOrigin(
    repo: string,
    branch: string,
    state: CanvasState,
    fromWorkspace: boolean
  ): Promise<string | null> {
    for (const repoPath of [APP_ORIGIN_REPO_PATH, APP_ORIGIN_ROOT_PATH]) {
      const text = await (
        fromWorkspace ?
          deps.appModel.fetchWorkspaceFile(state, repo, branch, repoPath)
        : deps.appModel.fetchRepoFile(repo, branch, repoPath)).catch(
        () => null
      );
      if (text) return text;
    }
    return null;
  }

  // Reads the model, its origin record, and the branch's head commit from the
  // SAME place: a model served from the worktree is judged against the worktree,
  // one served from GitHub against that branch on GitHub. Mixing the two (a
  // worktree model against a remote head commit, say) would manufacture drift
  // that does not exist.
  async function resolveAppModelStatus(
    repo: string,
    branch: string,
    state: CanvasState
  ): Promise<AppModelStatus> {
    let model: string | null = null;
    let fromWorkspace = false;
    if (repo && deps.workspace.isWorkspaceSelection(state, repo, branch)) {
      model = await deps.workspace
        .fetchWorkspaceBicep(state, repo, branch)
        .catch(() => null);
      fromWorkspace = !!model;
    }
    if (!model) {
      model = await deps.core
        .fetchBicepFromRepo(deps.github, repo, branch)
        .catch(() => null);
    }

    const [originText, headCommit] = await Promise.all([
      readAppOrigin(repo, branch, state, fromWorkspace),
      (fromWorkspace ?
        deps.appModel.workspaceHeadCommit(state.workspacePath)
        // A transient gh failure resolves to "", which the classifier reads as
        // "revision unknown" and therefore as fresh. That is deliberate: never
        // regenerate on our own inability to read. But it does mean flaky
        // GitHub access silently suppresses drift detection on remote branches.
      : deps.appModel.branchHeadCommit(repo, branch)
      ).catch(() => "")
    ]);

    // Head equality alone is not a usable freshness test: committing a freshly
    // generated model advances the head past the commit that model recorded. The
    // worktree can answer the real question (did application source change,
    // ignoring the model's own directory), so ask it there. A remote branch has
    // no cheap equivalent, and its only consequence is an advisory notice, so it
    // falls back to the coarse comparison.
    const recordedCommit = parseAppOrigin(originText)?.sourceCommit;
    const sourceChanged =
      fromWorkspace && recordedCommit ?
        await deps.appModel
          .workspaceSourceChangedSince(state.workspacePath, recordedCommit)
          .catch(() => undefined)
      : undefined;

    return {
      repo,
      branch,
      refreshable: fromWorkspace,
      freshness: evaluateAppModelFreshness({
        model,
        originText,
        headCommit,
        sourceChanged,
        generatorVersion: deps.appModel.generatorVersion(),
        hashAppBicep
      })
    };
  }

  return { workspaceState, fetchBicepForBranch, resolveAppModelStatus };
}
