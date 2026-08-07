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
  appBicepHandoffPrompt,
  deployRepairHandoffPrompt
} from "./hooks.js";
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
    }) => Promise<
      | {
          permissionDecision: "deny";
          permissionDecisionReason: string;
          additionalContext: string;
        }
      | undefined
    >;
    onSessionStart: () => Promise<{ additionalContext: string }>;
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
  const { workspaceState, fetchBicepForBranch } =
    createGraphContextHelpers(deps);

  // ─── Host-channel callbacks ────────────────────────────────────────────────
  // Registered immediately (no session required yet): each callback only
  // reads deps.session.get() when the host actually invokes it, which is
  // always after attachSession() has run.
  deps.hostCallbacks.setAppBicepHandoff(({ repo, branches, page }) =>
    Promise.resolve(
      deps.session.get().send(appBicepHandoffPrompt(repo, page, branches))
    )
  );
  deps.hostCallbacks.setDeployRepairHandoff(
    ({ repo, branch, error, deployRunUrl, attemptId }) =>
      deps.session.get().send(
        deployRepairHandoffPrompt(repo, branch, {
          error,
          deployRunUrl,
          attemptId
        })
      )
  );
  deps.hostCallbacks.setSessionPromptHandler((prompt) =>
    Promise.resolve(deps.session.get().send(String(prompt || "")))
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

  function shutdown(signal = "shutdown"): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      shuttingDown = true;
      try {
        console.error(
          `[radius] received ${signal}; shutting down ${deps.servers.size} canvas server(s)...`
        );
      } catch {}

      const closes: Array<Promise<void>> = [];
      for (const [id, entry] of deps.servers) {
        try {
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
      await Promise.race([
        Promise.all(closes),
        new Promise<void>((resolve) => setTimeout(resolve, 2000))
      ]);

      try {
        const session = deps.session.tryGet();
        if (session) {
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
              break;
            }
          }
          const asyncDispose = Reflect.get(session, Symbol.asyncDispose);
          if (typeof asyncDispose === "function") {
            await Reflect.apply(asyncDispose, session, []);
          }
        }
      } catch (e) {
        try {
          console.error(`[radius] session teardown error: ${errorMessage(e)}`);
        } catch {}
      }
      stopKeepalive();
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
      if (!panelRecentlyActive && !deployInFlight()) return;
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

  function attachSession(session: SessionPort): void {
    deps.session.set(session);
    startKeepalive();
  }

  return {
    canvases: [createRadiusCanvas(deps)],
    tools: createRadiusTools(deps),
    hooks: {
      // Guards the graph-generating tool calls: denies the call and instructs
      // the agent to author + SAVE .radius/app.bicep via the radius-app-bicep
      // skill first when no bicep exists. Fails open on any hook error.
      onPreToolUse: async (input) => {
        try {
          return await evaluateAppBicepHook(
            { toolName: input.toolName, toolArgs: input.toolArgs },
            {
              workspaceState,
              fetchBicep: fetchBicepForBranch,
              defaultBranchForState: deps.workspace.defaultBranchForState
            }
          );
        } catch {
          return undefined;
        }
      },
      onSessionStart: async () => ({
        additionalContext: RADIUS_SESSION_START_CONTEXT
      })
    },
    attachSession,
    shutdown,
    isShutDown: () => shuttingDown
  };
}
