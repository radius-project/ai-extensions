// Dependency ports for the Radius runtime factories.
//
// createRadiusCanvas / createRadiusTools / createRadiusExtension take a single
// RadiusExtensionDependencies object instead of importing server.ts, gh.ts,
// workspace.ts, etc. directly. Production wiring (the thin src/extension.ts
// composition root) constructs this object from the real adapter modules;
// tests construct it from fakes. No factory or its module-level code performs
// I/O, binds a port, spawns a process, or calls joinSession — only invoking a
// handler exercises the injected dependencies.

import type { CanvasServerEntry, SessionPromptMessage } from "../server.js";
import type { CanvasGraphResource, CanvasState } from "../shared.js";
import type {
  DeployServerEntry,
  DeployToolArgs,
  DeployPayload,
  DeployStatusInput,
  DeployStatusSummary
} from "../deploy-tools.js";
import type { SessionHolder } from "./session.js";

export interface WorkspaceContext {
  workspacePath: string;
  repo: string;
  branch: string;
}

export interface WorkspaceDependencies {
  hasRadiusApplicationModel(
    workspacePath: string | null | undefined
  ): Promise<boolean>;
  detectWorkspaceContext(session: {
    cwd?: string;
    workspacePath?: string;
  }): Promise<WorkspaceContext>;
  defaultBranchForState(state: CanvasState | null | undefined): string;
  isWorkspaceSelection(
    state: CanvasState | null | undefined,
    repo: string | null | undefined,
    branch: string | null | undefined
  ): boolean;
  fetchWorkspaceBicep(
    state: CanvasState,
    repo: string,
    branch: string
  ): Promise<string | null>;
  // Repo-relative paths in the local worktree, or null when the selection is not
  // the workspace or the tree could not be walked. Null is distinct from an
  // empty list on purpose: a listing that failed proves nothing about the
  // repository's contents.
  fetchWorkspaceTree(
    state: CanvasState,
    repo: string | null | undefined,
    branch: string | null | undefined
  ): Promise<string[] | null>;
  parseRepoFromRemote(remoteUrl: unknown): string;
  toSafeRepoRelPath(input: unknown): string;
  isWorkspacePath(
    workspacePath: string | null | undefined,
    candidate: string | null | undefined
  ): boolean;
  workspaceFileExists(worktree: string, relPath: string): Promise<boolean>;
}

export interface GitHubContentReader {
  getContent(apiPath: string): Promise<string | null>;
  getContentBytes(apiPath: string): Promise<Buffer | { tooLarge: true } | null>;
  listNames(apiPath: string): Promise<string[]>;
  treePaths(requestedRepo: string, branch?: string): Promise<string[]>;
  getDefaultBranch(repo: string): Promise<string>;
}

export interface CoreGraphDependencies {
  computeGraphDiff(
    base: CanvasGraphResource[],
    head: CanvasGraphResource[]
  ): CanvasGraphResource[];
  fetchBicepFromRepo(
    github: GitHubContentReader,
    repo: string,
    branch: string
  ): Promise<string | null>;
  filterGraphVisualizationResources(
    resources: CanvasGraphResource[]
  ): CanvasGraphResource[];
}

export interface RadArtifactsSelection {
  isLocal: boolean;
  state?: CanvasState;
  github?: GitHubContentReader;
  repo?: string;
  branch?: string;
  bicepRepoPath: string;
  log?: (message: string) => void;
}

export interface RadDependencies {
  buildGraphViaRad(
    content: string,
    bicepRepoPath: string,
    options: {
      log?: (message: string) => void;
      radArtifactsDir?: string;
      cleanupRadArtifactsDir?: boolean;
    }
  ): Promise<CanvasGraphResource[]>;
  ensureRadBinary(options: {
    log?: (message: string) => void;
  }): Promise<unknown>;
  runRadBicepPublishExtension(options: {
    fromFile: string;
    target: string;
    log?: (message: string) => void;
  }): Promise<unknown>;
  runRadBicepPublish(options: {
    file: string;
    target: string;
    env?: Record<string, string>;
    log?: (message: string) => void;
  }): Promise<unknown>;
  radArtifactsDirForSelection(
    selection: RadArtifactsSelection
  ): Promise<{ dir: string; remote: boolean }>;
}

export interface DeployToolsDependencies {
  selectDeployEntry(
    servers: ReadonlyMap<string, CanvasServerEntry>,
    attemptId?: string
  ): DeployServerEntry | null;
  buildDeployPayload(args: DeployToolArgs, state: CanvasState): DeployPayload;
  validateDeployPayload(payload: {
    targetRepo?: unknown;
    environment?: unknown;
  }): string | null;
  validateDeployAttempt(
    args: DeployToolArgs,
    state: CanvasState
  ): string | null;
  summarizeDeployStatus(
    input: DeployStatusInput,
    logLines?: number
  ): DeployStatusSummary;
  describeDeployStarted(
    payload: { targetRepo?: string; branch?: string; environment?: string },
    result: { repairAttempt?: unknown; repairAttemptCap?: unknown }
  ): string;
}

export interface SourceRefsDependencies {
  getSourceRefResources(
    entry: CanvasServerEntry,
    requestedView?: string
  ): {
    ready: boolean;
    view: string;
    context?: {
      token: string;
      repo?: string;
      branch?: string;
      baseBranch?: string;
      headBranch?: string;
    };
    resources: CanvasGraphResource[];
  };
  prepareSourceRefResources(
    entry: CanvasServerEntry,
    view: unknown,
    context: Record<string, unknown>
  ): { token: string };
  setSourceRefResources(
    entry: CanvasServerEntry,
    view: unknown,
    resources: CanvasGraphResource[],
    context: Record<string, unknown>,
    expectedToken?: string
  ): boolean;
  updateSourceRefs(
    entry: CanvasServerEntry,
    contextToken: string,
    refs: ReadonlyArray<{ id: string; codeReference: string }>
  ): {
    error?: string;
    updated: number;
    queued: number;
    skipped: number;
    view?: string;
  };
}

export interface PublishTargetsDependencies {
  resolveExistingRadiusArtifact(
    workspacePath: string | null | undefined,
    value: unknown,
    fallback: string | null | undefined
  ): string;
  resolveRadiusArtifactTarget(
    workspacePath: string | null | undefined,
    value: unknown,
    fallback: string | null | undefined
  ): string;
  resolveStagingDirPrefix(
    workspacePath: string | null | undefined,
    value: unknown
  ): string;
  validateGhcrTargetForRepo(
    target: unknown,
    workspaceRepo: string | null | undefined
  ): string | null;
}

export interface HostCallbackDependencies {
  setAppBicepHandoff(
    fn: (input: {
      repo: string;
      branches: string[];
      page: string;
      // The canvas instance's state, so the runtime resolves each branch's model
      // against the same workspace context the route rendered from and can
      // deduplicate against this panel's last handoff.
      state?: CanvasState;
    }) => Promise<unknown>
  ): void;
  setDeployRepairHandoff(
    fn:
      | ((input: {
          repo: string;
          branch: string;
          error: string;
          deployRunUrl: string;
          attemptId: string;
          instanceId: string;
        }) => unknown)
      | null
  ): void;
  setDeployFailureNotice(
    fn:
      | ((input: {
          repo: string;
          branch: string;
          error: string;
          deployRunUrl: string;
          instanceId: string;
        }) => unknown)
      | null
  ): void;
  setOpenSourceHandler(
    fn: (input: {
      path: string;
      line: number;
      instanceId: string;
      state?: CanvasState;
    }) => Promise<unknown>
  ): void;
  setSessionPromptHandler(
    fn: (prompt: string | SessionPromptMessage) => Promise<unknown>
  ): void;
}

export interface DeployRunnerDependencies {
  fetch: typeof globalThis.fetch;
}

export interface ProcessDependencies {
  existsSync(path: string): boolean;
  execFile(
    cmd: string,
    args: string[],
    options: { timeout?: number; encoding?: BufferEncoding }
  ): Promise<{ stdout: string; stderr: string }>;
}

// Facts needed to decide whether an existing application model still describes
// the branch it sits on. Grouped into one narrow port so the freshness check has
// a single seam: a graph open reads an origin record, a head commit, and the installed
// generator version, and nothing else.
export interface AppModelDependencies {
  // Installed generator (radius-app-bicep) version, or "" when unresolvable.
  generatorVersion(): string;
  // Commit the local worktree is on. "" when it cannot be resolved.
  workspaceHeadCommit(
    workspacePath: string | null | undefined
  ): Promise<string>;
  // Whether application source (excluding the model's own directory) changed
  // between a recorded commit and the worktree head. undefined when git cannot
  // answer, so the caller falls back instead of reading silence as "unchanged".
  workspaceSourceChangedSince(
    workspacePath: string | null | undefined,
    sinceCommit: string
  ): Promise<boolean | undefined>;
  // Head commit of a branch on GitHub. "" when it cannot be resolved.
  branchHeadCommit(repo: string, branch: string): Promise<string>;
  // Repo-relative file read from the local worktree, when the selection is it.
  fetchWorkspaceFile(
    state: CanvasState,
    repo: string,
    branch: string,
    repoPath: string
  ): Promise<string | null>;
  // Repo-relative file read from a branch on GitHub.
  fetchRepoFile(
    repo: string,
    branch: string,
    repoPath: string
  ): Promise<string | null>;
}

export interface OperationsDependencies {
  setupInFlight(): boolean;
  hasActiveEnvironmentTasks(instanceId: string): boolean;
  markEnvironmentInstanceShuttingDown(instanceId: string): void;
  onEnvironmentTasksSettled(
    instanceId: string,
    listener: () => void
  ): () => void;
}

// The single dependency object shared by createRadiusCanvas, createRadiusTools,
// and createRadiusExtension. Every I/O boundary the runtime touches is named
// here, so a test can construct a complete fake without importing any adapter
// module (server.ts/gh.ts/workspace.ts/...) or performing real I/O.
export interface RadiusExtensionDependencies {
  session: SessionHolder;
  servers: Map<string, CanvasServerEntry>;
  getOrCreateServer(
    instanceId: string,
    page?: string
  ): Promise<CanvasServerEntry>;
  getLastWebviewActivityAt(): number;
  workspace: WorkspaceDependencies;
  github: GitHubContentReader;
  core: CoreGraphDependencies;
  rad: RadDependencies;
  deployTools: DeployToolsDependencies;
  sourceRefs: SourceRefsDependencies;
  publishTargets: PublishTargetsDependencies;
  hostCallbacks: HostCallbackDependencies;
  process: ProcessDependencies;
  deploy: DeployRunnerDependencies;
  operations: OperationsDependencies;
  appModel: AppModelDependencies;
  radiusAppBicepSkill(repoPath?: string): string;
  renderPrDiffMarkdown(
    resources: CanvasGraphResource[],
    baseBranch: string,
    headBranch: string
  ): string;
  withGhcrDockerConfig(
    fn: (env: { DOCKER_CONFIG: string }) => Promise<unknown>
  ): Promise<unknown>;
}
