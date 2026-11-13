// createRadiusExtension — the composition factory: builds the canvas + tools
// (via createRadiusCanvas/createRadiusTools), the onPreToolUse/onSessionStart
// hooks, the host-channel callbacks (app.bicep handoff, deploy repair handoff,
// open-source, session-prompt), and the keepalive + idempotent shutdown
// lifecycle — all wired against `deps` only.
//
// IMPORTANT: this module never calls joinSession(). The production entry
// point (src/extension.ts) is the ONLY place that does: it builds `deps`,
// calls createRadiusExtension(deps) to get {canvases, tools, hooks}, passes
// those to joinSession(), and only then calls attachSession(session). Every
// closure here that needs the live session reads it lazily through
// deps.session.get()/tryGet(), so constructing (or unit-testing) this factory
// never touches the network or a real SDK session.

import { createRadiusCanvas } from "./create-radius-canvas.js";
import { redactCredentials } from "@radius-project/core";
import { createRadiusTools } from "./create-radius-tools.js";
import { createGraphContextHelpers } from "./graph-context.js";
import { createAppModelHandoff } from "./app-model-handoff.js";
import { readSelectedSourceRevision } from "../app-model-authoring-failure.js";
import {
  createModelingActivity,
  observeWorkspaceModelingRun
} from "./modeling-activity.js";
import { createMissingModelHandoffClaims } from "./missing-model-handoff-claims.js";
import {
  RADIUS_CANVAS_INSTANCE_ID,
  RADIUS_SESSION_START_CONTEXT
} from "./declarations.js";
import {
  deployRepairHandoffMessage,
  deployFailureNoticeMessage
} from "./hooks.js";
import { sourceEditorInstanceId } from "./canvas-lifecycle.js";
import { createRadiusCanvasInstanceRegistry } from "./canvas-instance-registry.js";
import { errorMessage } from "./util.js";
import { createRadiusPluginUpdater } from "./plugin-update.js";
import type { RadiusExtensionDependencies } from "./dependencies.js";
import type { SessionPort } from "./session.js";

// The host reaps an idle extension process with a clean SIGTERM after ~10
// minutes of no host<->extension JSON-RPC traffic. A user watching an open
// canvas panel (webview polling /api/ping, or a deploy monitor polling
// /api/deploy-status) still looks idle on that channel, so we send a benign,
// read-only request (session.metadata.snapshot()) to keep the connection warm
// whenever a panel was recently active or a deploy is in flight.
export const KEEPALIVE_INTERVAL_MS = 120000; // 2 min — comfortably under the ~10 min reaper
export const KEEPALIVE_ACTIVE_WINDOW_MS = 180000; // panel counts as "open" if seen within 3 min

export interface RadiusShutdownOutcome {
  complete: boolean;
  exitCode: 0 | 1;
}

export interface RadiusExtension {
  canvases: ReturnType<typeof createRadiusCanvas>[];
  tools: ReturnType<typeof createRadiusTools>;
  hooks: {
    onPreToolUse: (input: {
      toolName?: unknown;
      toolArgs?: unknown;
      workingDirectory?: unknown;
    }) => Promise<
      | {
          permissionDecision: "deny";
          permissionDecisionReason: string;
          additionalContext: string;
        }
      | {
          additionalContext: string;
        }
      | undefined
    >;
    onPostToolUseFailure: (input: {
      toolName?: unknown;
      toolArgs?: unknown;
      error?: unknown;
      workingDirectory?: unknown;
    }) => Promise<undefined>;
    onSessionStart: (input: {
      workingDirectory?: unknown;
    }) => Promise<{ additionalContext: string } | undefined>;
  };
  // Attaches the real (or fake) joined session. Must be called exactly once,
  // strictly after joinSession() resolves in production.
  attachSession(session: SessionPort): void;
  // Closes every open canvas server and tears down the session. Idempotent:
  // a second call (e.g. a duplicate SIGTERM) is a no-op and resolves
  // immediately without repeating the teardown.
  shutdown(signal?: string): Promise<RadiusShutdownOutcome>;
  // Test/diagnostic surface: true once shutdown() has run.
  isShutDown(): boolean;
}

export function createRadiusExtension(
  deps: RadiusExtensionDependencies
): RadiusExtension {
  if (!deps.executionOwner) {
    throw new Error("Missing Radius runtime dependency: executionOwner");
  }
  if (!deps.deployment)
    throw new Error("Missing Radius runtime dependency: deployment");
  const { workspaceState, resolveAppModelStatus, evaluateAppSourceForBranch } =
    createGraphContextHelpers(deps);
  const canvasInstances = createRadiusCanvasInstanceRegistry();

  // Staleness signals already handed to the agent, so a refresh that does not
  // clear the drift cannot re-prompt on every later render. Scoped to this
  // extension instance rather than the module, and outliving any one canvas
  // instance's state.
  //
  // Bounded because the key includes the commit the record names, so every
  // regeneration produces a new one and the set would otherwise grow for as
  // long as the process runs. Set preserves insertion order, so dropping the
  // oldest evicts the least recently seen problem. Re-asking about a signal
  // that fell out is harmless: the point is to stop a tight loop, not to
  // remember forever.
  const REFRESH_MEMO_LIMIT = 100;
  const requestedRefreshes = new Set<string>();

  function shouldRequestRefresh(key: string): boolean {
    if (requestedRefreshes.has(key)) return false;
    requestedRefreshes.add(key);
    if (requestedRefreshes.size > REFRESH_MEMO_LIMIT) {
      const oldest = requestedRefreshes.values().next().value;
      if (oldest !== undefined) requestedRefreshes.delete(oldest);
    }
    return true;
  }

  const missingModelHandoffs = createMissingModelHandoffClaims(() =>
    deps.clock.now()
  );

  // Modeling runs already under way, so a render that finds no model does not
  // ask the agent to generate one that something else is mid-way through
  // generating. Extension-scoped, because a run outlives the canvas instance
  // whose render observed it.
  //
  // Staging directories only ever describe the workspace checkout, so the probe
  // is refused for any other target: local activity says nothing about a remote
  // branch or a different repository, and reading it as evidence would let
  // unrelated work silence a handoff that should have been sent.
  const modelingActivity = createModelingActivity({
    now: () => deps.clock.now(),
    observeStagedRun: (repo, branches, workspace) =>
      observeWorkspaceModelingRun(
        repo,
        branches,
        workspace,
        deps.appModel.modelingRunLastActivityAtMs
      )
  });

  let pendingStartupDiagnostic = "";

  function logStartupDiagnostic(message: string): boolean {
    const session = deps.session.tryGet();
    if (!session?.log) return false;
    try {
      void Promise.resolve(
        session.log(message, { level: "warning", ephemeral: true })
      ).catch(() => undefined);
      return true;
    } catch {
      return false;
    }
  }

  // ─── Host-channel callbacks ────────────────────────────────────────────────
  // Registered immediately (no session required yet): each callback only
  // reads deps.session.get() when the host actually invokes it, which is
  // always after attachSession() has run.
  //
  // Every graph render reaches this callback through the HTTP routes, which is
  // why it, and no hook or canvas-open fallback, decides whether the model needs
  // authoring, refreshing, confirming, or only a note.
  const handOffAppModel = createAppModelHandoff({
    resolveContext: () => workspaceState(),
    resolveStatus: (repo, branch, state) =>
      resolveAppModelStatus(repo, branch, state),
    evaluateSource: (repo, branch, state) =>
      evaluateAppSourceForBranch(repo, branch, state),
    send: (message) =>
      Promise.resolve(deps.session.get().send(message)).then(() => undefined),
    readSourceRevision: (repo, branch, context) =>
      readSelectedSourceRevision(context, repo, branch, {
        isWorkspaceSelection: deps.workspace.isWorkspaceSelection,
        workspaceSourceRevision: deps.appModel.workspaceSourceRevision,
        branchHeadCommit: deps.appModel.branchHeadCommit
      }),
    modelingInFlight: (repo, branches, context, waitStartedAtMs) =>
      modelingActivity.inFlight(repo, branches, {
        repo: context.workspaceRepo || "",
        branch: context.workspaceBranch || "",
        path: context.workspacePath,
        waitStartedAtMs
      }),
    wait: (ms) => deps.clock.wait(ms),
    log: (message) => {
      try {
        deps.session.get().log?.(message);
      } catch {
        /* session.log unavailable → drop the notice */
      }
    },
    shouldRequestRefresh,
    releaseRefreshMemo: (key: string) => {
      requestedRefreshes.delete(key);
    },
    missingModelHandoffs
  });
  deps.hostCallbacks.setAppBicepHandoff(
    ({
      repo,
      branches,
      page,
      progressView,
      state,
      isCurrent,
      environmentKey
    }) =>
      handOffAppModel({
        repo,
        branches,
        page,
        progressView,
        state,
        isCurrent,
        environmentKey
      })
  );
  deps.hostCallbacks.setDeployRepairHandoff(
    ({ repo, branch, error, deployRunUrl, attemptId, appFile }) =>
      deps.session.get().send(
        deployRepairHandoffMessage(repo, branch, {
          error,
          deployRunUrl,
          attemptId,
          appFile
        })
      )
  );
  // The informational sibling of the repair handoff: a deploy whose run could
  // not be confirmed is relayed to chat as a report, never as a repair loop.
  deps.hostCallbacks.setDeployFailureNotice(
    ({ repo, branch, error, deployRunUrl }) =>
      deps.session
        .get()
        .send(deployFailureNoticeMessage(repo, branch, { error, deployRunUrl }))
  );
  // Routes hand us either a bare prompt or an already-paired
  // {prompt, displayPrompt}; forward both shapes untouched so the server owns
  // the wording and this seam only bridges to the session.
  deps.hostCallbacks.setSessionPromptHandler((prompt) =>
    Promise.resolve(
      deps.session
        .get()
        .send(typeof prompt === "string" ? String(prompt || "") : prompt)
    )
  );
  // Wires the "View source code" click for local-workspace graphs to the
  // Copilot editor canvas (side pane). See the original extension.ts history
  // for the NOT_ON_WORKTREE rationale: canvas.open({createIfMissing:false})
  // silently resolves for a file that isn't on the worktree, so we verify
  // existence first and throw so the webview falls back to a GitHub URL.
  deps.hostCallbacks.setOpenSourceHandler(async ({ path: relPath, state }) => {
    let safe = "";
    const session = deps.session.get();
    try {
      safe = deps.workspace.toSafeRepoRelPath(relPath);
      const worktree = state && state.workspacePath;
      if (
        !worktree ||
        !(await deps.workspace.workspaceFileExists(worktree as string, safe))
      ) {
        const err = new Error("file is not on this worktree", {
          cause: { code: "NOT_ON_WORKTREE" }
        });
        throw err;
      }
      await session.rpc.canvas.open({
        canvasId: "editor",
        // Per-file handle: a shared instanceId would make the host focus the
        // panel already showing the first file instead of opening this one.
        instanceId: sourceEditorInstanceId(safe),
        input: {
          scope: "repo",
          path: safe,
          title: safe.split("/").pop() || safe,
          placement: { focus: true, surface: "side" },
          createIfMissing: false
        }
      });
    } catch (e) {
      try {
        session.log?.(
          `Radius: could not open ${safe || relPath} in the editor canvas: ${errorMessage(e)}`,
          { level: "warning" }
        );
      } catch {}
      throw e;
    }
  });

  // ─── Shutdown (idempotent) ─────────────────────────────────────────────────
  let shuttingDown = false;
  let shutdownPromise: Promise<RadiusShutdownOutcome> | undefined;
  const updatePlugin = createRadiusPluginUpdater({
    enabled: deps.automaticPluginUpdates,
    preferences: deps.pluginUpdatePreferences,
    now: () => deps.clock.now(),
    isShutDown: () => shuttingDown,
    logError: deps.logError
  });

  // Cleanup must never hang the process: a server that refuses to close, or a
  // session whose teardown never settles, is abandoned after this budget so
  // shutdown still completes and the host can reclaim the tool registrations.
  const CLEANUP_TIMEOUT_MS = 2000;

  // Races `work` against a timeout WITHOUT leaking the timer when work wins.
  async function withTimeout(
    work: Promise<unknown>,
    ms: number
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), ms);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function shutdown(signal = "shutdown"): Promise<RadiusShutdownOutcome> {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      shuttingDown = true;
      const drain = deps.executionOwner.shutdown();
      const deploymentDrain =
        deps.deployment.owner.shutdown(CLEANUP_TIMEOUT_MS);
      let complete = true;
      try {
        console.error(
          `[radius] received ${signal}; shutting down ${deps.servers.size} canvas server(s)...`
        );
      } catch {}

      try {
        const closes = [...deps.servers.keys()].map(async (id) => {
          try {
            deps.executionOwner.markEnvironmentInstanceShuttingDown(id);
            await deps.stopServer(id, true);
          } catch (error) {
            complete = false;
            deps.logError(
              `Could not stop Radius canvas ${id}: ${errorMessage(error)}`
            );
          }
        });
        const drained = drain.then((outcome) => {
          if (!outcome.complete) {
            complete = false;
            deps.logError(
              `Radius setup drain failed: ${outcome.failures
                .slice(0, 10)
                .map((failure) => failure.replace(/[\r\n]/g, " ").slice(0, 120))
                .join("; ")}`
            );
          }
        });
        const deploymentsDrained = deploymentDrain.then((outcome) => {
          if (!outcome.complete) {
            complete = false;
            deps.logError(
              `Radius deployment drain incomplete; pending attempts: ${outcome.pending
                .slice(0, 10)
                .map((id) => id.replace(/[^a-zA-Z0-9_.:-]/g, "?").slice(0, 100))
                .join(
                  ", "
                )}. Remote workflows may still be running; inspect Actions before redeploying.`
            );
          }
        });
        if (
          !(await withTimeout(
            Promise.all([...closes, drained, deploymentsDrained]),
            CLEANUP_TIMEOUT_MS
          ))
        ) {
          complete = false;
          const pending = deps.executionOwner
            .pendingOperationIds()
            .slice(0, 10)
            .map((id) => id.replace(/[^a-zA-Z0-9_.-]/g, "?").slice(0, 80));
          deps.logError(
            `Radius shutdown incomplete after ${CLEANUP_TIMEOUT_MS}ms; pending operations: ${pending.join(", ") || "none"}; pending readiness checks: ${deps.executionOwner.pendingReadinessCount()}; server/task cleanup may remain pending. External work, journal saves or account restoration may be interrupted; inspect operation recovery before retrying.`
          );
        }

        const session = deps.session.tryGet();
        if (session) {
          const sessionClosed = await withTimeout(
            (async () => {
              let tornDown = false;
              for (const name of [
                "close",
                "dispose",
                "leave",
                "stop",
                "disconnect"
              ]) {
                const candidate = Reflect.get(session, name);
                if (typeof candidate === "function") {
                  await Reflect.apply(candidate, session, []);
                  tornDown = true;
                  break;
                }
              }
              // Symbol.asyncDispose is a FALLBACK, not an additional step: a
              // session exposing both close() and asyncDispose must not be
              // torn down twice.
              if (!tornDown) {
                const asyncDispose = Reflect.get(session, Symbol.asyncDispose);
                if (typeof asyncDispose === "function") {
                  await Reflect.apply(asyncDispose, session, []);
                }
              }
            })(),
            CLEANUP_TIMEOUT_MS
          );
          if (!sessionClosed) {
            complete = false;
            deps.logError(
              `Radius session teardown incomplete after ${CLEANUP_TIMEOUT_MS}ms.`
            );
          }
        }
      } catch (e) {
        complete = false;
        try {
          console.error(`[radius] session teardown error: ${errorMessage(e)}`);
        } catch {}
      } finally {
        // Always release the keepalive, even if cleanup above threw or timed
        // out, so a stuck teardown can never leave the timer running.
        stopKeepalive();
      }
      return { complete, exitCode: complete ? (0 as const) : (1 as const) };
    })();
    return shutdownPromise;
  }

  // ─── Keepalive ─────────────────────────────────────────────────────────────
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  let keepaliveBusy = false;

  function deployInFlight(): boolean {
    return deps.deployment.owner.hasActiveWork();
  }

  function startKeepalive(): void {
    if (keepaliveTimer) return;
    keepaliveTimer = setInterval(async () => {
      if (keepaliveBusy || shuttingDown) return;
      const panelRecentlyActive =
        Date.now() - deps.getLastWebviewActivityAt() <
        KEEPALIVE_ACTIVE_WINDOW_MS;
      let settingUp = false;
      try {
        settingUp = deps.operations.setupInFlight();
      } catch {
        /* never let the predicate break the keepalive */
      }
      if (!panelRecentlyActive && !deployInFlight() && !settingUp) return;
      keepaliveBusy = true;
      try {
        const session = deps.session.tryGet();
        const metadata = session && Reflect.get(session, "metadata");
        const snapshot =
          metadata && typeof metadata === "object" ?
            Reflect.get(metadata, "snapshot")
          : undefined;
        if (typeof snapshot === "function") {
          await Reflect.apply(snapshot, metadata, []);
        }
      } catch {
        /* keepalive must never crash or surface errors */
      } finally {
        keepaliveBusy = false;
      }
    }, KEEPALIVE_INTERVAL_MS);
    try {
      keepaliveTimer.unref?.();
    } catch {}
  }

  function stopKeepalive(): void {
    if (!keepaliveTimer) return;
    clearInterval(keepaliveTimer);
    keepaliveTimer = undefined;
  }

  // Production calls this exactly once, from bootstrap, after joinSession()
  // resolves. A second call with a DIFFERENT session would silently orphan the
  // first one — shutdown only tears down the session the holder currently
  // points at — so it is rejected rather than allowed to leak a live session.
  let attachedSession: SessionPort | undefined;

  function attachSession(session: SessionPort): void {
    // Shutdown has already run and will not run again, so a session stored now
    // would never be torn down. Reject it before mutating either session holder.
    if (shutdownPromise) {
      throw new Error(
        "Radius runtime: cannot attach a session after shutdown; the runtime can no longer tear it down."
      );
    }
    if (attachedSession) {
      if (attachedSession !== session) {
        throw new Error(
          "Radius runtime: a session is already attached; attachSession() must be called exactly once."
        );
      }
      return;
    }
    attachedSession = session;
    deps.session.set(session);
    if (
      pendingStartupDiagnostic &&
      logStartupDiagnostic(pendingStartupDiagnostic)
    ) {
      pendingStartupDiagnostic = "";
    }
    startKeepalive();
    void updatePlugin(session).catch((error: unknown) => {
      deps.logError(
        redactCredentials(`Radius plugin update failed: ${errorMessage(error)}`)
      );
    });
  }

  return {
    canvases: [createRadiusCanvas(deps, canvasInstances)],
    tools: createRadiusTools(deps, modelingActivity, missingModelHandoffs),
    hooks: {
      // Nothing here inspects the application model any more. Opening a graph
      // page used to be denied until .radius/app.bicep existed, but every graph
      // render already passes through the HTTP routes, which report the missing
      // model in the page and drive the authoring turn themselves. Keeping the
      // deny as well produced two authoring prompts for one open.
      onPreToolUse: async (input) => {
        if (input.toolName === "open_canvas") {
          const canvasId =
            input.toolArgs !== null && typeof input.toolArgs === "object" ?
              Reflect.get(input.toolArgs, "canvasId")
            : undefined;
          const instanceId =
            input.toolArgs !== null && typeof input.toolArgs === "object" ?
              Reflect.get(input.toolArgs, "instanceId")
            : undefined;
          if (canvasId === "radius") {
            const requestedInstanceId =
              typeof instanceId === "string" && instanceId ?
                instanceId
              : RADIUS_CANVAS_INSTANCE_ID;
            const selectedInstanceId =
              canvasInstances.claim(requestedInstanceId);
            if (requestedInstanceId === selectedInstanceId) {
              return undefined;
            }
            return {
              permissionDecision: "deny",
              permissionDecisionReason:
                "A Radius canvas is already open in this session.",
              additionalContext: `Retry open_canvas with the existing instanceId \`${selectedInstanceId}\`. Reopening that exact instance refreshes its server and client connections; do not create another Radius panel.`
            };
          }
        }
        return undefined;
      },
      onPostToolUseFailure: async (input) => {
        const canvasId =
          input.toolArgs !== null && typeof input.toolArgs === "object" ?
            Reflect.get(input.toolArgs, "canvasId")
          : undefined;
        const instanceId =
          input.toolArgs !== null && typeof input.toolArgs === "object" ?
            Reflect.get(input.toolArgs, "instanceId")
          : undefined;
        const failedInstanceId =
          typeof instanceId === "string" && instanceId ?
            instanceId
          : RADIUS_CANVAS_INSTANCE_ID;
        if (
          input.toolName === "open_canvas" &&
          canvasId === "radius" &&
          !deps.servers.has(failedInstanceId)
        ) {
          canvasInstances.release(failedInstanceId);
        }
        return undefined;
      },
      onSessionStart: async (input) => {
        const workspacePath =
          typeof input.workingDirectory === "string" ?
            input.workingDirectory.trim()
          : "";
        if (!workspacePath) return undefined;
        let modeled = false;
        try {
          modeled =
            await deps.workspace.hasRadiusApplicationModel(workspacePath);
        } catch (error) {
          pendingStartupDiagnostic = `Radius could not inspect the worktree for an application model during session startup: ${errorMessage(error)}. Radius session guidance was not loaded for this session.`;
          if (logStartupDiagnostic(pendingStartupDiagnostic)) {
            pendingStartupDiagnostic = "";
          }
        }
        if (!modeled) return undefined;
        return { additionalContext: RADIUS_SESSION_START_CONTEXT };
      }
    },
    attachSession,
    shutdown,
    isShutDown: () => shuttingDown
  };
}
