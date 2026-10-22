// Extension: radius — SDK entry (joinSession wiring).
//
// This is the ONLY place in the codebase that imports the SDK's joinSession
// and the ONLY place that calls it. Its entire job is:
//   1. Build the production RadiusExtensionDependencies from the concrete
//      adapter modules (server.ts, gh.ts, workspace.ts, ...).
//   2. Ask createRadiusExtension() for the canvas/tools/hooks declarations.
//   3. Call joinSession exactly once with those declarations.
//   4. Attach the resulting session, then wire process lifecycle (signals,
//      uncaught-error resilience, the rad binary warm-up, and the opt-in dev
//      self-reload watcher).
//
// No product logic lives here — see src/runtime/*.ts for the canvas/tools/
// hooks construction and src/*.ts (server/pages/deploy/infra/gh/workspace/...)
// for everything each handler ultimately delegates to.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, statSync, watch as fsWatch } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";
import {
  computeGraphDiff,
  fetchBicepFromRepo,
  filterGraphVisualizationResources
} from "@radius-project/core";
import {
  buildGraphViaRad,
  ensureRadBinary,
  resolveInstalledRadiusVersion,
  runRadBicepPublishExtension,
  runRadBicepPublish
} from "@radius-project/adapter-shared";
import { createRadiusCliVersionReader } from "./radius-cli-version.js";
import { github, fetchFileFromRepo, getBranchHeadSha } from "./gh.js";
import {
  defaultBranchForState,
  detectWorkspaceContext,
  fetchWorkspaceBicep,
  fetchWorkspaceFile,
  hasRadiusApplicationModel,
  fetchWorkspaceTree,
  isWorkspacePath,
  isWorkspaceSelection,
  modelingRunLastActivityAtMs,
  parseRepoFromRemote,
  resolvePersistedSessionId,
  toSafeRepoRelPath,
  workspaceFileExists,
  workspaceHeadCommit,
  workspaceSourceRevision,
  workspaceModelRecoverable,
  workspaceSourceChangedSince
} from "./workspace.js";
import { radArtifactsDirForSelection } from "./remote-rad-artifacts.js";
import {
  selectDeployEntry,
  buildDeployPayload,
  validateDeployPayload,
  validateDeployAttempt,
  summarizeDeployStatus,
  describeDeployStarted
} from "./deploy-tools.js";
import {
  createProductionCanvasServerRuntime,
  setAppBicepHandoff,
  setDeployRepairHandoff,
  setDeployFailureNotice,
  setSessionPromptHandler,
  setOpenSourceHandler
} from "./server.js";
import {
  getSourceRefResources,
  prepareSourceRefResources,
  setSourceRefResources,
  updateSourceRefs
} from "./source-refs.js";
import {
  announcementOptions,
  configureOperationStore,
  onOperationTerminal,
  setupInFlight,
  summarize
} from "./operations.js";
import {
  createFileOperationStore,
  disabledOperationStore
} from "./operation-store.js";
import { configureCredentialProvenanceStore } from "./credential-provenance.js";
import { createFileCredentialProvenanceStore } from "./credential-provenance-store.js";
import { radiusAppBicepSkill } from "./skill.js";
import { createGeneratorVersionReader } from "./generator-version.js";
import { renderPrDiffMarkdown } from "./pr-diff-markdown.js";
import { withGhcrDockerConfig } from "./ghcr.js";
import { resolveGhCommandPresentation } from "./gh-command-resolution.js";
import {
  resolveExistingRadiusArtifact,
  resolveRadiusArtifactTarget,
  resolveStagingDirPrefix,
  validateGhcrTargetForRepo
} from "./publish-targets.js";
import { createSessionHolder } from "./runtime/session.js";
import type { SessionPort } from "./runtime/session.js";
import { bootstrapRadiusExtension } from "./runtime/bootstrap.js";
import type { RadiusExtensionDependencies } from "./runtime/dependencies.js";
import { createEnvironmentExecutionOwner } from "./runtime/environment-execution-owner.js";
import { createProductionGitHubAccountContext } from "./runtime/production-github-account-context.js";
import { setupDevSelfReload } from "./runtime/dev-reload.js";
import {
  configureProcessLifecycle,
  warmRadBinary
} from "./runtime/process-lifecycle.js";

const execFileAsync = promisify(execFile);

// ─── Production dependency wiring ────────────────────────────────────────────
const sessionHolder = createSessionHolder();
const executionOwner = createEnvironmentExecutionOwner();
const accountContext = createProductionGitHubAccountContext();
const { servers, getOrCreateServer, stopServer, getLastWebviewActivityAt } =
  createProductionCanvasServerRuntime({ executionOwner, accountContext });

const ghCommandPresentation = resolveGhCommandPresentation();
const dependencies: RadiusExtensionDependencies = {
  logError: console.error.bind(console),
  session: sessionHolder,
  executionOwner,
  clock: {
    now: Date.now,
    wait: (ms) => delay(ms, undefined, { ref: false })
  },
  servers,
  getOrCreateServer,
  stopServer,
  getLastWebviewActivityAt,
  workspace: {
    hasRadiusApplicationModel,
    detectWorkspaceContext,
    defaultBranchForState,
    isWorkspaceSelection,
    fetchWorkspaceBicep,
    fetchWorkspaceTree,
    parseRepoFromRemote,
    toSafeRepoRelPath,
    isWorkspacePath,
    workspaceFileExists
  },
  github,
  core: {
    computeGraphDiff,
    fetchBicepFromRepo,
    filterGraphVisualizationResources
  },
  rad: {
    buildGraphViaRad:
      buildGraphViaRad as RadiusExtensionDependencies["rad"]["buildGraphViaRad"],
    ensureRadBinary,
    runRadBicepPublishExtension,
    runRadBicepPublish,
    radArtifactsDirForSelection
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
    resolveExistingRadiusArtifact,
    resolveRadiusArtifactTarget,
    resolveStagingDirPrefix,
    validateGhcrTargetForRepo
  },
  hostCallbacks: {
    setAppBicepHandoff,
    setDeployRepairHandoff,
    setDeployFailureNotice,
    setSessionPromptHandler,
    setOpenSourceHandler
  },
  process: {
    existsSync,
    execFile: execFileAsync
  },
  deploy: {
    fetch
  },
  operations: {
    setupInFlight
  },
  appModel: {
    generatorVersion: createGeneratorVersionReader(),
    radiusVersion: createRadiusCliVersionReader(resolveInstalledRadiusVersion),
    workspaceHeadCommit,
    workspaceSourceRevision,
    workspaceModelRecoverable,
    workspaceSourceChangedSince,
    branchHeadCommit: getBranchHeadSha,
    modelingRunLastActivityAtMs,
    fetchWorkspaceFile,
    fetchRepoFile: (repo, branch, repoPath) =>
      fetchFileFromRepo(repo, repoPath, branch)
  },
  radiusAppBicepSkill,
  renderPrDiffMarkdown,
  withGhcrDockerConfig: (fn) =>
    withGhcrDockerConfig(fn, { ghCommandPresentation })
};

const reportOperationStore = (diagnostic: {
  code: string;
  message: string;
}) => {
  try {
    console.error(`[radius] ${diagnostic.code}: ${diagnostic.message}`);
  } catch {}
};
try {
  await configureCredentialProvenanceStore(
    createFileCredentialProvenanceStore({
      directory: join(
        process.env.USERPROFILE || os.homedir(),
        ".copilot",
        "radius",
        "credential-provenance"
      ),
      report: reportOperationStore
    })
  );
} catch (error) {
  reportOperationStore({
    code: "credential-provenance-unavailable",
    message: `Durable credential provenance is unavailable, so credential setup and cleanup will fail closed: ${String(error)}`
  });
}

const radiusExtension = await bootstrapRadiusExtension(dependencies, {
  createCanvas,
  joinSession: async (declaration) =>
    (await joinSession(declaration)) as unknown as SessionPort
});

try {
  const operationSessionId = await resolvePersistedSessionId();
  if (!operationSessionId) {
    reportOperationStore({
      code: "operation-store-unavailable",
      message:
        "Durable operation recovery is disabled because no verified Copilot session directory was found."
    });
    await configureOperationStore(disabledOperationStore());
  } else {
    const operationsDir = join(
      process.env.USERPROFILE || os.homedir(),
      ".copilot",
      "session-state",
      operationSessionId,
      "radius",
      "operations"
    );
    await configureOperationStore(
      createFileOperationStore({
        filePath: join(operationsDir, "operations.json"),
        report: reportOperationStore
      })
    );
  }
} catch (error) {
  reportOperationStore({
    code: "operation-store-unavailable",
    message: `Durable operation recovery is disabled: ${String(error)}`
  });
  await configureOperationStore(disabledOperationStore());
}

onOperationTerminal((op: any) => {
  try {
    const message = summarize(op);
    if (!message) return false;
    sessionHolder.get().log?.(`Radius: ${message}`, announcementOptions(op));
    return true;
  } catch {
    return false;
  }
});

// Prepare the `rad` binary once per extension load. This is the preferred place
// to download/reconcile rad and run the `rad version --cli` check; doing it here
// (fire-and-forget) keeps that work off the hot path of most graph builds.
// If the warm-up has not finished yet (or no binary exists), the first graph
// build may still await ensureRadBinary() as a fallback.
warmRadBinary(ensureRadBinary, console.error.bind(console));

// The extension runs as a long-lived Node process that registers canvases/tools
// with the host. Two failure modes were observed:
//   1. A stray throw / unhandled rejection in an async request handler (e.g. the
//      deploy stream) would crash the whole process. The host then respawns it,
//      but the previous registration can still be lingering, producing
//      "External tool name clash: radius_* already registered by another
//      connection" on the new process.
//   2. On SIGTERM (host cleaning up stale processes during a restart/session
//      switch) the process exited without closing its canvas HTTP servers or
//      leaving the session, so tool registrations were not released cleanly.
//
// To make the extension resilient we (a) swallow otherwise-fatal errors so the
// process stays up and its single registration remains valid, and (b) shut down
// gracefully via radiusExtension.shutdown() — closing every canvas server and
// leaving the session so the host can release the tool names before any
// replacement process registers them.
const { gracefulShutdown, isShuttingDown } = configureProcessLifecycle({
  extension: radiusExtension,
  onSignal: (signal, handler) => {
    process.on(signal as NodeJS.Signals, handler);
  },
  onUncaughtException: (handler) => {
    process.on("uncaughtException", handler);
  },
  onUnhandledRejection: (handler) => {
    process.on("unhandledRejection", handler);
  },
  setTimer: setTimeout,
  exit: process.exit,
  log: console.error.bind(console)
});

setupDevSelfReload({
  enabled: process.env.RADIUS_CANVAS_DEV === "1",
  extensionPath: process.env.EXTENSION_PATH || "",
  exists: existsSync,
  fileSize: (path) => statSync(path).size,
  watchDirectory: (path, listener) =>
    fsWatch(path, { persistent: false }, (_event, filename) =>
      listener(filename)
    ),
  isShuttingDown,
  isDeploying: () => {
    for (const [, entry] of servers) {
      if (entry?.state?.deployStatus === "in_progress") return true;
    }
    return false;
  },
  getLastActivityAt: getLastWebviewActivityAt,
  now: Date.now,
  setTimer: setTimeout,
  clearTimer: clearTimeout,
  log: console.error.bind(console),
  shutdown: gracefulShutdown
});
