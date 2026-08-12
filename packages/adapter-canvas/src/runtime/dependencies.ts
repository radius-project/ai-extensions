// Dependency ports for the Radius runtime factories.
//
// createRadiusCanvas / createRadiusTools / createRadiusExtension take a single
// RadiusExtensionDependencies object instead of importing server.ts, gh.ts,
// workspace.ts, etc. directly. Production wiring (the thin src/extension.ts
// composition root) constructs this object from the real adapter modules;
// tests construct it from fakes. No factory or its module-level code performs
// I/O, binds a port, spawns a process, or calls joinSession — only invoking a
// handler exercises the injected dependencies.

import type { CanvasServerEntry } from "../server.js";
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
  parseRepoFromRemote(remoteUrl: unknown): string;
  toSafeRepoRelPath(input: unknown): string;
  workspaceFileExists(worktree: string, relPath: string): Promise<boolean>;
}

export interface GitHubContentReader {
  getContent(apiPath: string): Promise<string | null>;
  getContentBytes(apiPath: string): Promise<Buffer | { tooLarge: true } | null>;
  listNames(apiPath: string): Promise<string[]>;
  treePaths(requestedRepo: string, branch?: string): Promise<string[]>;
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
  validateGhcrTargetForRepo(
    target: unknown,
    workspaceRepo: string | null | undefined
  ): string | null;
}

export interface OidcResult {
  message: string;
  output: string;
}

export interface InfraDependencies {
  generateAzureOIDC(data: Record<string, unknown>): OidcResult;
  generateAWSOIDC(data: Record<string, unknown>): OidcResult;
}

export interface HostCallbackDependencies {
  setAppBicepHandoff(
    fn: (input: {
      repo: string;
      branches: string[];
      page: string;
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
  setOpenSourceHandler(
    fn: (input: {
      path: string;
      line: number;
      instanceId: string;
      state?: CanvasState;
    }) => Promise<unknown>
  ): void;
  setSessionPromptHandler(fn: (prompt: string) => Promise<unknown>): void;
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

export interface OperationsDependencies {
  setupInFlight(): boolean;
  hasActiveEnvironmentTasks(): boolean;
  onEnvironmentTasksSettled(listener: () => void): () => void;
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
  infra: InfraDependencies;
  hostCallbacks: HostCallbackDependencies;
  process: ProcessDependencies;
  deploy: DeployRunnerDependencies;
  operations: OperationsDependencies;
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
