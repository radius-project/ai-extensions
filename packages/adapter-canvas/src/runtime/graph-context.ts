// Shared "current workspace + bicep fetch" helpers used by both createRadiusCanvas
// and createRadiusTools. Factored out so the two factories don't duplicate the
// same dependency-driven logic.

import {
  APP_ORIGIN_REPO_PATH,
  APP_ORIGIN_ROOT_PATH,
  evaluateAppModelFreshness,
  evaluateAppSource,
  parseAppOrigin
} from "@radius-project/core";
import type {
  AppModelFreshness,
  AppSourceEvaluation
} from "@radius-project/core";
import { hashAppBicep } from "../app-bicep-hash.js";
import type { RadiusExtensionDependencies } from "./dependencies.js";
import type { CanvasGraphResource, CanvasState } from "../shared.js";

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
  fetchGraphForBranch(
    repo: string,
    branch: string,
    state: CanvasState
  ): Promise<{ content: string; path: string } | null>;
  loadBranchGraphResources(
    repo: string,
    branch: string,
    state: CanvasState,
    bicepContent: string,
    log: (message: string) => void
  ): Promise<CanvasGraphResource[]>;
  evaluateAppSourceForBranch(
    repo: string,
    branch: string,
    state: CanvasState
  ): Promise<AppSourceEvaluation>;
  // The raw listing behind evaluateAppSourceForBranch, for a caller that needs
  // more than the classification. Null means the listing could not be
  // established — never that the repository holds no files. An empty listing is
  // normalized to null, so a returned array is always non-empty.
  listSourceTreeForBranch(
    repo: string,
    branch: string,
    state: CanvasState
  ): Promise<string[] | null>;
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

  async function fetchGraphForBranch(
    repo: string,
    branch: string,
    state: CanvasState
  ): Promise<{ content: string; path: string } | null> {
    const useWorkspace = deps.workspace.isWorkspaceSelection(
      state,
      repo,
      branch
    );
    if (useWorkspace) {
      for (const path of [".radius/app-graph.json", "app-graph.json"]) {
        const content = await deps.appModel.fetchWorkspaceFile(
          state,
          repo,
          branch,
          path
        );
        if (content) return { content, path };
      }
      return null;
    }
    for (const path of [".radius/app-graph.json", "app-graph.json"]) {
      const content = await deps.appModel.fetchRepoFile(repo, branch, path);
      if (content) return { content, path };
    }
    return null;
  }

  async function loadBranchGraphResources(
    repo: string,
    branch: string,
    state: CanvasState,
    bicepContent: string,
    log: (message: string) => void
  ): Promise<CanvasGraphResource[]> {
    const graph = await fetchGraphForBranch(repo, branch, state);
    if (graph) {
      const definitionFile = graph.path.replace("app-graph.json", "app.bicep");
      return deps.core.filterGraphVisualizationResources(
        deps.core.applicationGraphToResources(
          JSON.parse(graph.content),
          definitionFile,
          bicepContent
        )
      );
    }

    const { dir, remote } = await deps.rad.radArtifactsDirForSelection({
      isLocal: deps.workspace.isWorkspaceSelection(state, repo, branch),
      state,
      github: deps.github,
      repo,
      branch,
      bicepRepoPath: ".radius/app.bicep",
      log
    });
    return deps.rad.buildGraphViaRad(bicepContent, ".radius/app.bicep", {
      log,
      radArtifactsDir: dir,
      cleanupRadArtifactsDir: remote
    });
  }

  // Picks the lister that can actually see the branch — the local worktree for
  // the workspace selection, the repository's git tree for any other branch.
  // Lister selection lives here, once, so no call site has to know which of the
  // two can see a given branch.
  //
  // A lookup that did not happen must never read as a repository with no
  // Dockerfile, and the two listers fail differently: the local one rejects or
  // resolves null, while the remote one resolves an empty array on any error
  // rather than throwing. Catching to null covers the first, and core mapping an
  // empty listing to `unknown` covers the second, so neither failure reaches a
  // verdict. An empty array here is therefore "could not establish", not "the
  // repository has nothing".
  //
  // The returned value carries that distinction rather than leaving it to the
  // caller: an empty listing is normalized to null below, so null is the single
  // "could not establish" shape and a non-empty array is always real evidence.
  async function listSourceTreeForBranch(
    repo: string,
    branch: string,
    state: CanvasState
  ): Promise<string[] | null> {
    // Without a repository there is nothing to list. The worktree predicate is
    // fail-closed on an empty repo, so this would otherwise fall through to the
    // remote lister and spend a doomed `gh api /repos//git/trees/` call, and its
    // timeout, to arrive at the same answer.
    if (!repo) return null;
    const paths = await (
      deps.workspace.isWorkspaceSelection(state, repo, branch) ?
        deps.workspace.fetchWorkspaceTree(state, repo, branch)
      : deps.github.treePaths(repo, branch)).catch(() => null);
    // Normalized so the contract holds in the returned value, not merely in the
    // comment: `treePaths` resolves to [] on failure, and a caller reading the
    // raw listing cannot tell that apart from a real listing that happens to be
    // empty. Collapsing it to null makes "unavailable" the single shape a caller
    // has to handle.
    return paths && paths.length > 0 ? paths : null;
  }

  // Classifies a branch's source listing, handing the paths to core, which owns
  // what counts as application source. This adapter holds no filename rule.
  async function evaluateAppSourceForBranch(
    repo: string,
    branch: string,
    state: CanvasState
  ): Promise<AppSourceEvaluation> {
    return evaluateAppSource(
      await listSourceTreeForBranch(repo, branch, state)
    );
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
      // Only the worktree's head is worth fetching. On any other branch the
      // comparison it feeds cannot say anything useful, because committing an
      // app model is itself a commit past the one its record names, so the two
      // never match. Nothing consumes that verdict, and skipping it saves a
      // GitHub round trip per branch on the graph-diff path.
      fromWorkspace ?
        deps.appModel.workspaceHeadCommit(state.workspacePath).catch(() => "")
      : Promise.resolve("")
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

    // Only asked when there is no record to judge the model by, which is the one
    // case where we would replace a file without being able to say we wrote it.
    // Once a record exists this never runs again for that model, so the cost is
    // a one-time migration cost rather than a per-open one. Off the workspace
    // branch nothing is regenerated at all, so the answer would go unused.
    const modelRecoverable =
      fromWorkspace && !recordedCommit ?
        await deps.appModel
          .workspaceModelRecoverable(state.workspacePath)
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
        modelRecoverable,
        generatorVersion: deps.appModel.generatorVersion(),
        hashAppBicep
      })
    };
  }

  return {
    workspaceState,
    fetchBicepForBranch,
    fetchGraphForBranch,
    loadBranchGraphResources,
    evaluateAppSourceForBranch,
    listSourceTreeForBranch,
    resolveAppModelStatus
  };
}
