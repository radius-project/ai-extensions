import {
  deploymentApplicationPaths,
  fetchBicepFromRepo
} from "@radius-project/core";
import type { CanvasState } from "./shared.js";
import type { SelectedRepositoryReader } from "./selected-repository-reader.js";
import {
  defaultBranchForState,
  isWorkspaceSelection,
  resolveWorkspaceBicep
} from "./workspace.js";

export async function fetchDeploymentBicep(
  repo: string,
  branch: string,
  appFile: string,
  reader: SelectedRepositoryReader
) {
  const paths = deploymentApplicationPaths(
    appFile === ".radius/app.bicep" ? undefined : appFile
  );
  for (const bicepPath of paths) {
    const content = await reader.getContent(
      `/repos/${repo}/contents/${bicepPath}?ref=${encodeURIComponent(branch)}`
    );
    if (content !== null)
      return { content, fromWorkspace: false, branch, bicepPath };
  }
  return { content: null, fromWorkspace: false, branch, bicepPath: paths[0] };
}

export async function fetchSelectedBicep(
  state: CanvasState,
  repo: string,
  branch: string,
  reader: SelectedRepositoryReader,
  workspace: {
    isSelection: typeof isWorkspaceSelection;
    resolve: typeof resolveWorkspaceBicep;
  } = {
    isSelection: isWorkspaceSelection,
    resolve: resolveWorkspaceBicep
  }
) {
  const selectedBranch = branch || defaultBranchForState(state);
  if (workspace.isSelection(state, repo, selectedBranch)) {
    const local = await workspace.resolve(state, repo, selectedBranch);
    if (local)
      return {
        content: local.content,
        fromWorkspace: true,
        branch: selectedBranch,
        bicepPath: local.repoPath
      };
  }
  return {
    content: await fetchBicepFromRepo(reader, repo, selectedBranch),
    fromWorkspace: false,
    branch: selectedBranch,
    bicepPath: ""
  };
}
