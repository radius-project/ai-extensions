// Shared test fakes for the runtime factory unit suites. This file lives outside
// src/ so test infrastructure cannot be counted as production coverage.
//
// Every fake here is in-memory only: no port is bound, no CLI is spawned, no
// network call is made, and no real filesystem is mutated. Pure, already
// well-tested adapter modules (deploy-tools.ts, source-refs.ts,
// publish-targets.ts) are reused as-is since they perform no I/O themselves;
// everything that actually touches the outside world (servers, github,
// workspace/git, rad, fetch, fs, execFile, the SDK session) is faked.

import { vi } from "vitest";
import type { Mock } from "vitest";
import {
  selectDeployEntry,
  buildDeployPayload,
  validateDeployPayload,
  validateDeployAttempt,
  summarizeDeployStatus,
  describeDeployStarted
} from "../../../src/deploy-tools.js";
import {
  getSourceRefResources,
  prepareSourceRefResources,
  setSourceRefResources,
  updateSourceRefs
} from "../../../src/source-refs.js";
import {
  resolveExistingRadiusArtifact,
  resolveRadiusArtifactTarget,
  resolveStagingDirPrefix,
  validateGhcrTargetForRepo
} from "../../../src/publish-targets.js";
import {
  isWorkspacePath,
  isWorkspaceSelection
} from "../../../src/workspace.js";
import { renderPrDiffMarkdown } from "../../../src/pr-diff-markdown.js";
import { createSessionHolder } from "../../../src/runtime/session.js";
import type { SessionPort } from "../../../src/runtime/session.js";
import type {
  RadiusExtensionDependencies,
  WorkspaceContext
} from "../../../src/runtime/dependencies.js";
import type {
  CanvasServerEntry,
  SessionPromptMessage
} from "../../../src/server.js";
import type { CanvasGraphResource } from "../../../src/shared.js";

export interface FakeServer {
  close: Mock;
  closeAllConnections?: Mock;
  closed: boolean;
}

export function createFakeServerEntry(
  instanceId: string,
  page: string
): CanvasServerEntry {
  const fakeServer: FakeServer = {
    closed: false,
    closeAllConnections: vi.fn(),
    close: vi.fn((cb?: () => void) => {
      fakeServer.closed = true;
      cb?.();
    })
  };
  return {
    server: fakeServer as unknown as CanvasServerEntry["server"],
    baseUrl: `http://127.0.0.1:0/${instanceId}`,
    url: `http://127.0.0.1:0/${instanceId}/?page=${page}`,
    page,
    state: {}
  };
}

export function createFakeSession(
  overrides: Partial<SessionPort> = {}
): SessionPort {
  return {
    workspacePath: "/workspace",
    log: vi.fn(),
    send: vi.fn(async () => undefined),
    rpc: { canvas: { open: vi.fn(async () => ({})) } },
    metadata: { snapshot: vi.fn(async () => ({})) },
    ...overrides
  };
}

export interface FakeDependenciesOptions {
  radiusEnabled?: boolean;
  defaultBranch?: string;
  workspaceContext?: WorkspaceContext;
  bicepByRepoBranch?: Record<string, string | null>;
  // Keyed `workspace:<repo>@<branch>:<repoPath>` / `remote:<repo>@<branch>:<repoPath>`.
  filesByRepoBranch?: Record<string, string | null>;
  // Keyed `workspace:<workspacePath>` / `<repo>@<branch>`.
  headCommits?: Record<string, string>;
  // Answer for workspaceSourceChangedSince; undefined means "git cannot say".
  sourceChangedSince?: boolean;
  generatorVersion?: string;
  // Worktree file listings keyed `<repo>@<branch>`. A missing key resolves to
  // null, matching fetchWorkspaceTree's "could not list" answer.
  workspaceTreeByRepoBranch?: Record<string, string[] | null>;
  // Remote git-tree listings keyed `<repo>@<branch>`. A missing key resolves to
  // an empty array, matching what the real lister returns on failure.
  remoteTreeByRepoBranch?: Record<string, string[]>;
}

// Builds a complete RadiusExtensionDependencies fake. `servers` is a real Map
// (not a fake) since it is just in-memory bookkeeping the SUT is expected to
// read/write directly, mirroring server.ts's own module-level Map.
export function createFakeDependencies(options: FakeDependenciesOptions = {}) {
  const servers = new Map<string, CanvasServerEntry>();
  const sessionHolder = createSessionHolder();

  const workspaceContext: WorkspaceContext = options.workspaceContext ?? {
    workspacePath: "/workspace",
    repo: "acme/widgets",
    branch: "main"
  };

  const bicepByRepoBranch = options.bicepByRepoBranch ?? {};
  const filesByRepoBranch = options.filesByRepoBranch ?? {};
  const headCommits = options.headCommits ?? {};
  const workspaceTreeByRepoBranch = options.workspaceTreeByRepoBranch ?? {};
  const remoteTreeByRepoBranch = options.remoteTreeByRepoBranch ?? {};

  const getOrCreateServer = vi.fn(
    async (instanceId: string, page?: string): Promise<CanvasServerEntry> => {
      let entry = servers.get(instanceId);
      if (entry) {
        if (page && entry.page !== page) {
          entry.page = page;
          entry.url = `${entry.baseUrl}/?page=${page}`;
        }
        return entry;
      }
      entry = createFakeServerEntry(instanceId, page || "graph");
      servers.set(instanceId, entry);
      return entry;
    }
  );

  let lastWebviewActivityAt = 0;

  const capturedHostCallbacks: {
    appBicepHandoff?: (input: {
      repo: string;
      branches: string[];
      page: string;
    }) => Promise<unknown>;
    deployRepairHandoff?:
      | ((input: {
          repo: string;
          branch: string;
          error: string;
          deployRunUrl: string;
          attemptId: string;
          instanceId: string;
        }) => unknown)
      | null;
    deployFailureNotice?:
      | ((input: {
          repo: string;
          branch: string;
          error: string;
          deployRunUrl: string;
          instanceId: string;
        }) => unknown)
      | null;
    openSourceHandler?: (input: {
      path: string;
      line: number;
      instanceId: string;
      state?: { workspacePath?: string };
    }) => Promise<unknown>;
    sessionPromptHandler?: (
      prompt: string | SessionPromptMessage
    ) => Promise<unknown>;
  } = {};

  const deps: RadiusExtensionDependencies = {
    session: sessionHolder,
    servers,
    getOrCreateServer,
    getLastWebviewActivityAt: vi.fn(() => lastWebviewActivityAt),
    workspace: {
      hasRadiusApplicationModel: vi.fn(
        async () => options.radiusEnabled ?? false
      ),
      detectWorkspaceContext: vi.fn(async () => workspaceContext),
      defaultBranchForState: vi.fn(
        (state) => (state?.contextBranch as string) || "main"
      ),
      // Real implementation, not a restatement. This predicate is fail-closed on
      // an empty repo or branch, and the "never a false unsupported" argument
      // rests on it, so a hand-synced copy that drifted looser would let tests
      // assert behavior production cannot produce.
      isWorkspaceSelection: vi.fn(isWorkspaceSelection),
      fetchWorkspaceBicep: vi.fn(
        async (_state, repo: string, branch: string) =>
          bicepByRepoBranch[`workspace:${repo}@${branch}`] ?? null
      ),
      fetchWorkspaceTree: vi.fn(
        async (
          _state,
          repo: string | null | undefined,
          branch: string | null | undefined
        ) => workspaceTreeByRepoBranch[`${repo}@${branch}`] ?? null
      ),
      parseRepoFromRemote: vi.fn((url: unknown) => {
        const match = String(url || "").match(
          /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/
        );
        return match ? match[1] : "";
      }),
      toSafeRepoRelPath: vi.fn((input: unknown) => {
        const raw = String(input ?? "");
        if (!raw || raw.includes("..")) throw new Error("invalid path");
        return raw.replace(/^\/+/, "");
      }),
      workspaceFileExists: vi.fn(async () => true),
      // Real implementation: path confinement is exactly the behavior the gate
      // depends on, so a hand-rolled fake would test the wrong thing.
      isWorkspacePath: vi.fn(isWorkspacePath)
    },
    github: {
      getContent: vi.fn(async () => null),
      getContentBytes: vi.fn(async () => null),
      listNames: vi.fn(async () => []),
      treePaths: vi.fn(
        async (requestedRepo: string, branch = "main") =>
          remoteTreeByRepoBranch[`${requestedRepo}@${branch}`] ?? []
      ),
      getDefaultBranch: vi.fn(async () => options.defaultBranch ?? "main")
    },
    core: {
      computeGraphDiff: vi.fn(
        (base: CanvasGraphResource[], head: CanvasGraphResource[]) => {
          const baseIds = new Set(base.map((r) => r.id));
          const headIds = new Set(head.map((r) => r.id));
          const added = head
            .filter((r) => !baseIds.has(r.id))
            .map((r) => ({ ...r, diffStatus: "added" as const }));
          const removed = base
            .filter((r) => !headIds.has(r.id))
            .map((r) => ({ ...r, diffStatus: "removed" as const }));
          const unchanged = head
            .filter((r) => baseIds.has(r.id))
            .map((r) => ({ ...r, diffStatus: "unchanged" as const }));
          return [...unchanged, ...added, ...removed];
        }
      ),
      fetchBicepFromRepo: vi.fn(
        async (_github, repo: string, branch: string) =>
          bicepByRepoBranch[`remote:${repo}@${branch}`] ?? null
      ),
      filterGraphVisualizationResources: vi.fn(
        (resources: CanvasGraphResource[]) =>
          resources.filter((r) => r.type !== "containerImages")
      )
    },
    rad: {
      buildGraphViaRad: vi.fn(async () => []),
      ensureRadBinary: vi.fn(async () => undefined),
      runRadBicepPublishExtension: vi.fn(async () => undefined),
      runRadBicepPublish: vi.fn(
        async () => "br:ghcr.io/acme/widgets/recipe:v1"
      ),
      radArtifactsDirForSelection: vi.fn(async () => ({
        dir: "/workspace/.radius",
        remote: false
      }))
    },
    deployTools: {
      selectDeployEntry,
      buildDeployPayload,
      validateDeployPayload,
      validateDeployAttempt,
      summarizeDeployStatus,
      describeDeployStarted
    },
    sourceRefs: {
      getSourceRefResources,
      prepareSourceRefResources,
      setSourceRefResources,
      updateSourceRefs
    },
    publishTargets: {
      resolveExistingRadiusArtifact: vi.fn(resolveExistingRadiusArtifact),
      resolveRadiusArtifactTarget: vi.fn(resolveRadiusArtifactTarget),
      resolveStagingDirPrefix: vi.fn(resolveStagingDirPrefix),
      validateGhcrTargetForRepo: vi.fn(validateGhcrTargetForRepo)
    },
    hostCallbacks: {
      setAppBicepHandoff: vi.fn((fn) => {
        capturedHostCallbacks.appBicepHandoff = fn;
      }),
      setDeployRepairHandoff: vi.fn((fn) => {
        capturedHostCallbacks.deployRepairHandoff = fn;
      }),
      setDeployFailureNotice: vi.fn((fn) => {
        capturedHostCallbacks.deployFailureNotice = fn;
      }),
      setOpenSourceHandler: vi.fn((fn) => {
        capturedHostCallbacks.openSourceHandler = fn;
      }),
      setSessionPromptHandler: vi.fn((fn) => {
        capturedHostCallbacks.sessionPromptHandler = fn;
      })
    },
    process: {
      existsSync: vi.fn(() => true),
      execFile: vi.fn(async () => ({ stdout: "", stderr: "" }))
    },
    deploy: {
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({}), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          })
      )
    },
    operations: {
      setupInFlight: vi.fn(() => false),
      hasActiveEnvironmentTasks: vi.fn((_instanceId: string) => false),
      markEnvironmentInstanceShuttingDown: vi.fn(),
      onEnvironmentTasksSettled: vi.fn(
        (_instanceId: string, _listener: () => void) => () => {}
      )
    },
    appModel: {
      generatorVersion: vi.fn(() => options.generatorVersion ?? "0.1.0-test"),
      workspaceHeadCommit: vi.fn(
        async (workspacePath: string | null | undefined) =>
          headCommits[`workspace:${workspacePath}`] ?? ""
      ),
      workspaceSourceChangedSince: vi.fn(
        async () => options.sourceChangedSince
      ),
      branchHeadCommit: vi.fn(
        async (repo: string, branch: string) =>
          headCommits[`${repo}@${branch}`] ?? ""
      ),
      fetchWorkspaceFile: vi.fn(
        async (_state, repo: string, branch: string, repoPath: string) =>
          filesByRepoBranch[`workspace:${repo}@${branch}:${repoPath}`] ?? null
      ),
      fetchRepoFile: vi.fn(
        async (repo: string, branch: string, repoPath: string) =>
          filesByRepoBranch[`remote:${repo}@${branch}:${repoPath}`] ?? null
      )
    },
    radiusAppBicepSkill: vi.fn(
      (repoPath?: string) => `SKILL.md content for ${repoPath || "."}`
    ),
    renderPrDiffMarkdown,
    withGhcrDockerConfig: vi.fn(async (fn) =>
      fn({ DOCKER_CONFIG: "/tmp/fake-docker-config" })
    )
  };

  return {
    deps,
    servers,
    sessionHolder,
    getOrCreateServer,
    capturedHostCallbacks,
    setLastWebviewActivityAt: (at: number) => {
      lastWebviewActivityAt = at;
    }
  };
}
