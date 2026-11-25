// Shared "current workspace + bicep fetch" helpers used by both createRadiusCanvas
// and createRadiusTools. Factored out so the two factories don't duplicate the
// same dependency-driven logic.

import { createHash } from "node:crypto";
import type {
  CommittedModelIdentity,
  ObservedModelFile
} from "../../../../extensions/radius/skills/radius-app-bicep/scripts/app-model-staging.mjs";
import {
  APP_ORIGIN_REPO_PATH,
  APP_ORIGIN_ROOT_PATH,
  createGraphOrchestrator,
  evaluateAppSource,
  readAppModelEvidence
} from "@radius-project/core";
import type {
  AppModelFreshness,
  AppSourceEvaluation,
  GraphSourceIdentity,
  GraphSourceRead
} from "@radius-project/core";
import { hashAppBicep } from "../app-bicep-hash.js";
import type { RadiusExtensionDependencies } from "./dependencies.js";
import type { CanvasState } from "../shared.js";

export function createRuntimeGraphOrchestrator(
  deps: RadiusExtensionDependencies,
  log?: (message: string) => void
) {
  return createGraphOrchestrator({
    stage: (selection) => deps.graphSources.stage(selection),
    compile: (content, path, options) =>
      deps.rad.buildGraphViaRad(content, path, { ...options, log }),
    diff: deps.core.computeGraphDiff,
    diagnostic: deps.logError
  });
}

// A branch's application model, classified. `refreshable` is the branch-safety
// half of the decision: the skill writes the working tree, so only a model that
// actually came from the worktree can be refreshed by regenerating. Refreshing
// any other branch would need a commit and a push, which modeling deliberately
// never does.
export interface AppModelStatus {
  repo: string;
  branch: string;
  source: GraphSourceIdentity;
  refreshable: boolean;
  freshness: AppModelFreshness;
  observedFiles?: readonly ObservedModelFile[];
  identity?: CommittedModelIdentity;
}

export interface GraphContextHelpers {
  workspaceState(): Promise<CanvasState>;
  readBicepForBranch(
    repo: string,
    branch: string,
    state: CanvasState
  ): Promise<GraphSourceRead>;
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
  if (!deps.graphSources)
    throw new Error("Graph source bindings are required.");
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

  async function readBicepForBranch(
    repo: string,
    branch: string,
    state: CanvasState
  ): Promise<GraphSourceRead> {
    return deps.graphSources.read({
      repo,
      ref: branch,
      workspace: {
        repo: state.workspaceRepo || "",
        ref: state.workspaceBranch || "",
        path: state.workspacePath || "",
        authorized: deps.workspace.isWorkspaceSelection(state, repo, branch)
      }
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
  const hashBytes = (text: string) =>
    createHash("sha256").update(text).digest("hex");

  async function readAppOrigin(
    source: GraphSourceIdentity,
    observed: ObservedModelFile[]
  ): Promise<string | null> {
    for (const repoPath of [APP_ORIGIN_REPO_PATH, APP_ORIGIN_ROOT_PATH]) {
      const read = await deps.graphSources.readFile(source, repoPath);
      if (read.status === "unavailable") {
        if (
          source.kind === "workspace" &&
          source.definitionPath === "app.bicep"
        )
          throw new Error(read.diagnostic);
        if (source.kind === "workspace") throw new Error(read.diagnostic);
        deps.logError(
          `Application model origin is unavailable: ${read.diagnostic}`
        );
        return null;
      }
      observed.push({
        path: repoPath,
        hash: read.status === "present" ? hashBytes(read.content) : null
      });
      if (read.status === "present") return read.content;
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
    const read = await readBicepForBranch(repo, branch, state);
    const workspacePath = read.source.workspacePath;
    const observed: ObservedModelFile[] = [];
    const { freshness, observation } = await readAppModelEvidence(read, {
      assertSource: () => deps.graphSources.assertWorkspaceSource(read.source),
      origin: () => readAppOrigin(read.source, observed),
      headCommit: () =>
        deps.appModel.workspaceHeadCommit(workspacePath).catch(() => ""),
      sourceChangedSince: (commit) =>
        deps.appModel
          .workspaceSourceChangedSince(workspacePath, commit)
          .catch(() => undefined),
      modelRecoverable: () =>
        deps.appModel
          .workspaceModelRecoverable(workspacePath)
          .catch(() => undefined),
      generatorVersion: () => deps.appModel.generatorVersion(),
      radiusVersion: () => deps.appModel.radiusVersion().catch(() => ""),
      hashAppBicep
    });
    const definitionHash =
      read.status === "present" ? hashBytes(read.content) : null;
    const originHash = observed.find(({ hash }) => hash !== null)?.hash;
    return {
      repo,
      branch,
      source: read.source,
      refreshable:
        read.source.kind === "workspace" && observation.kind === "present",
      freshness,
      ...((
        read.source.kind === "workspace" &&
        read.source.definitionPath === "app.bicep" &&
        definitionHash
      ) ?
        {
          observedFiles: [
            { path: ".radius/app.bicep", hash: null },
            { path: read.source.definitionPath, hash: definitionHash },
            ...observed
          ]
        }
      : {}),
      ...((
        read.source.kind === "workspace" &&
        read.source.definitionPath === ".radius/app.bicep" &&
        observed[0]?.hash &&
        definitionHash &&
        originHash
      ) ?
        { identity: { definitionHash, originHash } }
      : {})
    };
  }

  return {
    workspaceState,
    readBicepForBranch,
    evaluateAppSourceForBranch,
    listSourceTreeForBranch,
    resolveAppModelStatus
  };
}
