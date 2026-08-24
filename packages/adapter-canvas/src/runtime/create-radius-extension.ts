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
import { createRadiusTools } from "./create-radius-tools.js";
import { createGraphContextHelpers } from "./graph-context.js";
import { RADIUS_SESSION_START_CONTEXT } from "./declarations.js";
import {
  evaluateAppBicepHook,
  appBicepHandoffMessage,
  deployRepairHandoffMessage,
  deployFailureNoticeMessage
} from "./hooks.js";
import { createPullRequestGraphDiffGuard } from "./pr-graph-diff-guard.js";
import { errorMessage } from "./util.js";
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
    onPostToolUse: (input: {
      toolName?: unknown;
      toolArgs?: unknown;
      toolResult?: unknown;
      workingDirectory?: unknown;
    }) => Promise<{ additionalContext: string } | undefined>;
    onPostToolUseFailure: (input: {
      toolName?: unknown;
      toolArgs?: unknown;
      error?: unknown;
      workingDirectory?: unknown;
    }) => Promise<{ additionalContext: string } | undefined>;
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
  shutdown(signal?: string): Promise<void>;
  // Test/diagnostic surface: true once shutdown() has run.
  isShutDown(): boolean;
}

export function createRadiusExtension(
  deps: RadiusExtensionDependencies
): RadiusExtension {
  const { workspaceState, resolveAppModelStatus, evaluateAppSourceForBranch } =
    createGraphContextHelpers(deps);
  const pullRequestGraphDiffGuard = createPullRequestGraphDiffGuard({
    hasRadiusApplicationModel: (workspacePath) =>
      deps.workspace.hasRadiusApplicationModel(workspacePath),
    workspaceContext: async () => {
      const state = await workspaceState();
      return {
        repo: state.contextRepo || "",
        branch: state.contextBranch || ""
      };
    },
    getDefaultBranch: (repo) => deps.github.getDefaultBranch(repo),
    openGraphDiff: ({ repo, baseBranch, headBranch }) =>
      deps.session.get().rpc.canvas.open({
        canvasId: "radius",
        instanceId: "radius-panel",
        input: { page: "graph-diff", repo, baseBranch, headBranch }
      })
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
  deps.hostCallbacks.setAppBicepHandoff(({ repo, branches, page }) =>
    Promise.resolve(
      deps.session.get().send(appBicepHandoffMessage(repo, page, branches))
    )
  );
  deps.hostCallbacks.setDeployRepairHandoff(
    ({ repo, branch, error, deployRunUrl, attemptId }) =>
      deps.session.get().send(
        deployRepairHandoffMessage(repo, branch, {
          error,
          deployRunUrl,
          attemptId
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
        instanceId: "radius-source",
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
  let shutdownPromise: Promise<void> | undefined;

  // Cleanup must never hang the process: a server that refuses to close, or a
  // session whose teardown never settles, is abandoned after this budget so
  // shutdown still completes and the host can reclaim the tool registrations.
  const CLEANUP_TIMEOUT_MS = 2000;

  // Races `work` against a timeout WITHOUT leaking the timer when work wins.
  async function withTimeout(
    work: Promise<unknown>,
    ms: number
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function shutdown(signal = "shutdown"): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      shuttingDown = true;
      try {
        console.error(
          `[radius] received ${signal}; shutting down ${deps.servers.size} canvas server(s)...`
        );
      } catch {}

      try {
        const closes: Array<Promise<void>> = [];
        for (const [id, entry] of deps.servers) {
          try {
            deps.operations.markEnvironmentInstanceShuttingDown(id);
            entry.server.closeAllConnections?.();
            closes.push(
              new Promise<void>((resolve) => {
                try {
                  entry.server.close(() => resolve());
                } catch {
                  resolve();
                }
              })
            );
          } catch {
            /* ignore */
          }
          deps.servers.delete(id);
        }
        await withTimeout(Promise.all(closes), CLEANUP_TIMEOUT_MS);

        const session = deps.session.tryGet();
        if (session) {
          await withTimeout(
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
        }
      } catch (e) {
        try {
          console.error(`[radius] session teardown error: ${errorMessage(e)}`);
        } catch {}
      } finally {
        // Always release the keepalive, even if cleanup above threw or timed
        // out, so a stuck teardown can never leave the timer running.
        stopKeepalive();
      }
    })();
    return shutdownPromise;
  }

  // ─── Keepalive ─────────────────────────────────────────────────────────────
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  let keepaliveBusy = false;

  function deployInFlight(): boolean {
    for (const [, entry] of deps.servers) {
      if (entry?.state?.deployStatus === "in_progress") return true;
    }
    return false;
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
  }

  // Staleness signals already handed to the agent, so a refresh that does not
  // clear the drift cannot block every later graph open. Scoped to this
  // extension instance rather than the module.
  //
  // Bounded because the key includes the commit the record names, so every
  // regeneration produces a new one and the set would otherwise grow for as
  // long as the process runs. Set preserves insertion order, so dropping the
  // oldest evicts the least recently seen problem. Re-asking about a signal
  // that fell out is harmless: the point is to stop a tight loop, not to
  // remember forever.
  const REFRESH_MEMO_LIMIT = 100;
  const requestedRefreshes = new Set<string>();

  return {
    canvases: [createRadiusCanvas(deps)],
    tools: createRadiusTools(deps),
    hooks: {
      // Guards opening a graph canvas page: denies the call and instructs
      // the agent to author + SAVE .radius/app.bicep via the radius-app-bicep
      // skill first when no bicep exists. It fails open on any hook error.
      onPreToolUse: async (input) => {
        try {
          const graphDecision = await evaluateAppBicepHook(
            { toolName: input.toolName, toolArgs: input.toolArgs },
            {
              workspaceState,
              defaultBranchForState: deps.workspace.defaultBranchForState,
              appModelStatus: resolveAppModelStatus,
              appSource: evaluateAppSourceForBranch,
              shouldRequestRefresh: (key: string) => {
                if (requestedRefreshes.has(key)) return false;
                requestedRefreshes.add(key);
                if (requestedRefreshes.size > REFRESH_MEMO_LIMIT) {
                  const oldest = requestedRefreshes.values().next().value;
                  if (oldest !== undefined) requestedRefreshes.delete(oldest);
                }
                return true;
              }
            }
          );
          if (graphDecision) return graphDecision;
        } catch {
          // Graph generation remains fail-open; the PR guard below owns its
          // own fail-closed diagnostics once a Radius model is active.
        }
        return pullRequestGraphDiffGuard.onPreToolUse(input);
      },
      onPostToolUse: (input) => pullRequestGraphDiffGuard.onPostToolUse(input),
      onPostToolUseFailure: (input) =>
        pullRequestGraphDiffGuard.onPostToolUseFailure(input),
      onSessionStart: async (input) => {
        let active = false;
        try {
          active = await pullRequestGraphDiffGuard.activateAtSessionStart(
            input.workingDirectory
          );
        } catch (error) {
          pendingStartupDiagnostic = `Radius could not inspect the worktree for an application model during session startup: ${errorMessage(error)}. Radius remains inactive for now and will retry when a later tool call provides the worktree.`;
          if (logStartupDiagnostic(pendingStartupDiagnostic)) {
            pendingStartupDiagnostic = "";
          }
        }
        if (!active) return undefined;
        return { additionalContext: RADIUS_SESSION_START_CONTEXT };
      }
    },
    attachSession,
    shutdown,
    isShutDown: () => shuttingDown
  };
}
