import type {
  DeploymentState,
  DeploymentWorkspace
} from "@radius-project/core";
import type { WorkflowObservationScope } from "./workflow-observation-scope.js";

export interface DeploymentFilePorts {
  readWorkspaceFile(
    workspacePath: string,
    repoPath: string
  ): Promise<string | null>;
  readRepositoryFile(
    repo: string,
    repoPath: string,
    branch: string
  ): Promise<string | null>;
}

/** Retains the existing exact-selection workspace read and remote fallback. */
export function createDeploymentFileReader(
  workspace: DeploymentWorkspace | undefined,
  ports: DeploymentFilePorts
) {
  const trusted = workspace ? { ...workspace } : undefined;
  return async (
    repo: string,
    branch: string,
    repoPath: string
  ): Promise<string | null> => {
    if (
      trusted?.workspacePath &&
      trusted.repo === repo &&
      trusted.branch === branch
    ) {
      const local = await ports.readWorkspaceFile(
        trusted.workspacePath,
        repoPath
      );
      if (local !== null) return local;
    }
    return ports.readRepositoryFile(repo, repoPath, branch);
  };
}

/** An invocation owns its readers; no frontend entry lookup participates. */
export function createDeploymentStatusReader(
  observation: WorkflowObservationScope,
  resolveApplicationName: (repo: string, branch: string) => Promise<string>
) {
  return async (
    state: DeploymentState,
    repo: string,
    branch: string,
    runId?: string | number | null
  ) => {
    let application = state.deployAppName || "";
    if (!application && repo) {
      application = await resolveApplicationName(
        repo,
        branch || state.deployingBranch || ""
      );
      if (application) state.deployAppName = application;
    }
    return observation.reader({
      repo,
      environment: state.deployEnvName || state.envName || "",
      application,
      runId: runId ?? state.deployRunId ?? null
    });
  };
}
