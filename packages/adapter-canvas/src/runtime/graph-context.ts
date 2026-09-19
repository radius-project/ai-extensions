import type { AppSourceEvaluation } from "@radius-project/core";
import {
  createAppModelStatusReader,
  graphSourceBranch
} from "@radius-project/core/github-radius/graphs";
import type {
  AppModelStatus,
  AppModelStatusReader,
  GraphSource
} from "@radius-project/core/github-radius/graphs";
import { hashAppBicep } from "../app-bicep-hash.js";
import type { RadiusExtensionDependencies } from "./dependencies.js";
import type { CanvasState } from "../shared.js";

export type { AppModelStatus } from "@radius-project/core/github-radius/graphs";

export interface GraphContextHelpers {
  workspaceState(): Promise<CanvasState>;
  fetchBicepForBranch(
    repo: string,
    branch: string,
    state: CanvasState
  ): Promise<string | null>;
  evaluateAppSourceForBranch(
    repo: string,
    branch: string,
    state: CanvasState
  ): Promise<AppSourceEvaluation>;
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
  function sourceFor(
    repo: string,
    branch: string,
    state: CanvasState
  ): GraphSource {
    return (
        state.workspacePath &&
          deps.workspace.isWorkspaceSelection(state, repo, branch)
      ) ?
        {
          kind: "workspace",
          repo,
          branch,
          workspacePath: state.workspacePath
        }
      : { kind: "committed", repo, ref: branch };
  }

  async function fetchBicepForBranch(
    repo: string,
    branch: string,
    state: CanvasState
  ): Promise<string | null> {
    // A missing or uncommitted local definition must not reveal the remote's
    // older copy. Source selection and file existence are different decisions.
    return deps.workspace.isWorkspaceSelection(state, repo, branch) ?
        deps.workspace.fetchWorkspaceBicep(state, repo, branch)
      : deps.core.fetchBicepFromRepo(deps.github, repo, branch);
  }

  async function listSourceTreeForBranch(
    repo: string,
    branch: string,
    state: CanvasState
  ): Promise<string[] | null> {
    if (!repo) return null;
    const paths = await ((
      deps.workspace.isWorkspaceSelection(state, repo, branch)
    ) ?
      deps.workspace.fetchWorkspaceTree(state, repo, branch)
    : deps.github.treePaths(repo, branch));
    return paths;
  }

  function modelReader(state: CanvasState): AppModelStatusReader {
    return createAppModelStatusReader({
      async readDefinition(source) {
        return {
          content: await fetchBicepForBranch(
            source.repo,
            graphSourceBranch(source),
            state
          ),
          bicepPath: ""
        };
      },
      readFile: (source, path) =>
        source.kind === "workspace" ?
          deps.appModel.fetchWorkspaceFile(
            state,
            source.repo,
            source.branch,
            path
          )
        : deps.appModel.fetchRepoFile(source.repo, source.ref, path),
      listPaths: (source) =>
        listSourceTreeForBranch(source.repo, graphSourceBranch(source), state),
      workspaceHeadCommit: deps.appModel.workspaceHeadCommit,
      workspaceSourceChangedSince: deps.appModel.workspaceSourceChangedSince,
      workspaceModelRecoverable: deps.appModel.workspaceModelRecoverable,
      generatorVersion: deps.appModel.generatorVersion,
      hashAppBicep
    });
  }

  return {
    async workspaceState() {
      const workspace = await deps.workspace.detectWorkspaceContext(
        deps.session.get()
      );
      return {
        workspacePath: workspace.workspacePath,
        workspaceRepo: workspace.repo,
        workspaceBranch: workspace.branch,
        contextRepo: workspace.repo,
        contextBranch: workspace.branch
      };
    },
    fetchBicepForBranch,
    listSourceTreeForBranch,
    async evaluateAppSourceForBranch(repo, branch, state) {
      return modelReader(state).evaluateSource(sourceFor(repo, branch, state));
    },
    async resolveAppModelStatus(repo, branch, state) {
      return modelReader(state).resolveStatus(sourceFor(repo, branch, state));
    }
  };
}
