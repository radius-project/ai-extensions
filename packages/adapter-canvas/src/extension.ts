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
import { dirname, join } from "node:path";
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
  runRadBicepPublishExtension,
  runRadBicepPublish
} from "@radius-project/adapter-shared";
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
  servers,
  getOrCreateServer,
  hasActiveEnvironmentTasks,
  markEnvironmentInstanceShuttingDown,
  onEnvironmentTasksSettled,
  getLastWebviewActivityAt,
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
import { radiusAppBicepSkill } from "./skill.js";
import { createGeneratorVersionReader } from "./generator-version.js";
import { renderPrDiffMarkdown } from "./pr-diff-markdown.js";
import { withGhcrDockerConfig } from "./ghcr.js";
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const execFileAsync = promisify(execFile);

// ─── Production dependency wiring ────────────────────────────────────────────
const sessionHolder = createSessionHolder();

const dependencies: RadiusExtensionDependencies = {
  logError: (message) => console.error(message),
  session: sessionHolder,
  clock: {
    now: () => Date.now(),
    wait: (ms) =>
      new Promise<void>((resolve) => {
        // Unref'd so a pending wait cannot hold the extension process open at
        // shutdown; everything it guards is fire-and-forget.
        setTimeout(resolve, ms).unref?.();
      })
  },
  servers,
  getOrCreateServer,
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
    buildGraphViaRad: (content, bicepRepoPath, options) =>
      buildGraphViaRad(content, bicepRepoPath, options) as ReturnType<
        RadiusExtensionDependencies["rad"]["buildGraphViaRad"]
      >,
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
    execFile: (cmd, args, options) => execFileAsync(cmd, args, options)
  },
  deploy: {
    fetch: (...args: Parameters<typeof fetch>) => fetch(...args)
  },
  operations: {
    setupInFlight,
    hasActiveEnvironmentTasks,
    markEnvironmentInstanceShuttingDown,
    onEnvironmentTasksSettled
  },
  appModel: {
    generatorVersion: createGeneratorVersionReader(),
    workspaceHeadCommit,
    workspaceModelRecoverable,
    workspaceSourceChangedSince,
    branchHeadCommit: (repo, branch) => getBranchHeadSha(repo, branch),
    modelingRunLastActivityAtMs,
    fetchWorkspaceFile,
    fetchRepoFile: (repo, branch, repoPath) =>
      fetchFileFromRepo(repo, repoPath, branch)
  },
  radiusAppBicepSkill,
  renderPrDiffMarkdown,
  withGhcrDockerConfig
};

const radiusExtension = await bootstrapRadiusExtension(dependencies, {
  createCanvas,
  joinSession: async (declaration) =>
    (await joinSession(declaration)) as unknown as SessionPort
});

const reportOperationStore = (diagnostic: {
  code: string;
  message: string;
}) => {
  try {
    console.error(`[radius] ${diagnostic.code}: ${diagnostic.message}`);
  } catch {}
};
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
    const operationPath = join(
      process.env.USERPROFILE || os.homedir(),
      ".copilot",
      "session-state",
      operationSessionId,
      "radius",
      "operations",
      "operations.json"
    );
    await configureOperationStore(
      createFileOperationStore({
        filePath: operationPath,
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

function isShuttingDown(): boolean {
  return radiusExtension.isShutDown();
}

// Prepare the `rad` binary once per extension load. This is the preferred place
// to download/reconcile rad and run the `rad version --cli` check; doing it here
// (fire-and-forget) keeps that work off the hot path of most graph builds.
// If the warm-up has not finished yet (or no binary exists), the first graph
// build may still await ensureRadBinary() as a fallback.
ensureRadBinary({
  log: (m) => {
    try {
      console.error(`[radius] ${m}`);
    } catch {
      /* ignore */
    }
  }
}).catch((e) => {
  try {
    console.error(
      `[radius] rad binary preparation failed (will retry on first use): ${errorMessage(e)}`
    );
  } catch {
    /* ignore */
  }
});

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
let gracefulShutdownStarted = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (gracefulShutdownStarted) return;
  gracefulShutdownStarted = true;
  await radiusExtension.shutdown(signal);
  // Give async close callbacks a tick, then exit cleanly.
  setTimeout(() => process.exit(0), 50);
}

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  try {
    process.on(sig, () => {
      gracefulShutdown(sig);
    });
  } catch {
    /* signal may be unsupported on platform */
  }
}

// Keep the process alive on otherwise-fatal async errors. Crashing here is what
// triggers the respawn → "tool name clash" cascade, so we log and continue; the
// single live registration stays valid and the user can retry the failed action.
process.on("uncaughtException", (err) => {
  try {
    console.error(
      `[radius] uncaughtException (ignored to stay alive): ${err?.stack || err}`
    );
  } catch {}
});
process.on("unhandledRejection", (reason) => {
  try {
    console.error(
      `[radius] unhandledRejection (ignored to stay alive): ${
        reason instanceof Error ?
          reason.stack || reason.message
        : String(reason)
      }`
    );
  } catch {}
});

// ─── Dev self-reload (opt-in, off by default) ───────────────────────────────────
// In development a fresh build can hot-reload without a manual restart: we watch
// the installed extension.mjs and, when it changes, gracefully shut down so the
// host respawns a fresh process with the new code. This uses the SAME safe
// graceful-shutdown path as a host SIGTERM (close servers, leave the session) so
// the host deregisters our tools/canvas cleanly.
//
// IMPORTANT: the installed extension.mjs is user-scoped and SHARED by every
// session on this machine, so restarting the process reloads the extension in
// ALL sessions — not just the one being edited. That makes auto-reload actively
// harmful as a default: any `build --install` (from any session) would tear down
// every other active session, which shows up as sessions "constantly stopping".
//
// So this is now OFF unless a developer explicitly opts in for the current
// process with `RADIUS_CANVAS_DEV=1`. It is deliberately NOT armed by an
// on-disk sentinel: a sentinel persists across installs and silently re-enables
// the destructive behavior for everyone forever. With it off, new code is picked
// up the normal, non-disruptive way — when a session next starts a fresh
// process — rather than by killing running sessions. When explicitly enabled,
// the quiesce logic below still defers the restart until the extension is idle.
(function setupDevSelfReload() {
  try {
    const enabled = process.env.RADIUS_CANVAS_DEV === "1";
    if (!enabled) return;
    const extPath = process.env.EXTENSION_PATH || "";
    if (!extPath || !existsSync(extPath)) return;
    const extDir = dirname(extPath);
    let lastSize = -1;
    try {
      lastSize = statSync(extPath).size;
    } catch {}
    let debounce: NodeJS.Timeout | null = null;
    let triggered = false; // set once we commit to the actual restart
    let reloadPending = false; // a deferral loop is already running
    let reloadRequestedAt = 0; // when the pending reload was first requested

    // Quiesce-before-reload tuning. A rebuild that overwrites the installed
    // extension.mjs must NOT restart this process mid-flight — doing so
    // deregisters our tools/canvas and leaves the host waiting on a
    // vanished extension, which surfaces as "system unresponsive". So we
    // defer the restart until the extension is idle:
    //   • Never restart while a deploy is being monitored — the restart
    //     would kill the in-process deploy monitor (no cap; a deploy is
    //     worth waiting for).
    //   • Defer while a canvas panel is ACTIVELY serving requests, up to a
    //     cap. An idle-but-open panel only pings /api/ping every 5s, so a
    //     window just under that cadence lets a merely-open panel reload
    //     (brief reconnect) while genuine interaction bursts keep deferring.
    const RELOAD_IDLE_WINDOW_MS = 4000; // "active" if a request was served within this
    const RELOAD_DEFER_POLL_MS = 2000; // re-check cadence while deferring
    const RELOAD_MAX_DEFER_MS = 60000; // cap deferral for panel activity (not deploys)

    const reloadNow = () => {
      if (triggered || isShuttingDown()) return;
      triggered = true;
      try {
        console.error(
          "[radius][dev] extension.mjs changed — restarting for hot reload…"
        );
      } catch {}
      setTimeout(() => {
        gracefulShutdown("DEV_RELOAD");
      }, 250);
    };
    const maybeReload = () => {
      if (triggered || isShuttingDown()) return;
      let deploying = false;
      try {
        for (const [, entry] of servers) {
          if (entry?.state?.deployStatus === "in_progress") {
            deploying = true;
            break;
          }
        }
      } catch {}
      const panelActive =
        Date.now() - getLastWebviewActivityAt() < RELOAD_IDLE_WINDOW_MS;
      const waited = Date.now() - reloadRequestedAt;
      if (deploying || (panelActive && waited < RELOAD_MAX_DEFER_MS)) {
        try {
          console.error(
            `[radius][dev] reload deferred (${deploying ? "deploy in flight" : "canvas panel active"}); retrying in ${RELOAD_DEFER_POLL_MS}ms…`
          );
        } catch {}
        setTimeout(maybeReload, RELOAD_DEFER_POLL_MS);
        return;
      }
      reloadNow();
    };
    const trigger = () => {
      if (triggered || isShuttingDown()) return;
      let size = lastSize;
      try {
        size = statSync(extPath).size;
      } catch {}
      if (size === lastSize) return;
      lastSize = size;
      // Coalesce a burst of rebuild writes into a single deferral loop; if
      // one is already running it picks up the new state on its next poll.
      if (reloadPending) return;
      reloadPending = true;
      reloadRequestedAt = Date.now();
      maybeReload();
    };
    const watcher = fsWatch(extDir, { persistent: false }, (_evt, filename) => {
      if (filename && filename !== "extension.mjs") return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(trigger, 300);
    });
    try {
      watcher.unref?.();
    } catch {}
    try {
      console.error(`[radius][dev] self-reload armed (watching ${extPath})`);
    } catch {}
  } catch (e) {
    try {
      console.error(
        `[radius][dev] self-reload setup failed (ignored): ${errorMessage(e)}`
      );
    } catch {}
  }
})();
