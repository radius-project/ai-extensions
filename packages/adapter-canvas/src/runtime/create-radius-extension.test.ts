import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRadiusExtension,
  KEEPALIVE_INTERVAL_MS,
  KEEPALIVE_ACTIVE_WINDOW_MS
} from "./create-radius-extension.js";
import { sourceEditorInstanceId } from "./canvas-lifecycle.js";
import {
  createFakeDependencies,
  createFakeSession
} from "../../test/support/runtime/fakes.js";
import {
  appBicepHandoffPrompt,
  appBicepHandoffDisplayPrompt,
  deployRepairHandoffDisplayPrompt,
  deployFailureNoticeDisplayPrompt
} from "./hooks.js";

// RU-20: the composition factory never calls joinSession — only the
// production thin entry (src/extension.ts) does, exactly once. The real
// guarantee is that no runtime/*.ts module imports the SDK's joinSession at
// all (a module that never imports it cannot call it), so that is what these
// checks assert rather than banning the word "joinSession" from comments.
describe("RU-20: createRadiusExtension never joins a session", () => {
  it("this module never imports the SDK's joinSession", () => {
    const source = readFileSync(
      new URL("./create-radius-extension.ts", import.meta.url),
      "utf8"
    );
    expect(source).not.toMatch(/import[^;]*joinSession[^;]*from/);
    expect(source).not.toMatch(/@github\/copilot-sdk/);
  });

  it("factory and dependency modules never import the SDK at all", () => {
    for (const file of [
      "create-radius-canvas.ts",
      "create-radius-tools.ts",
      "bootstrap.ts",
      "dependencies.ts",
      "session.ts",
      "declarations.ts"
    ]) {
      const source = readFileSync(
        new URL(`./${file}`, import.meta.url),
        "utf8"
      );
      expect(source).not.toMatch(/@github\/copilot-sdk/);
    }
  });

  it("constructing and attaching a session never touches the network or a real SDK session", () => {
    const { deps } = createFakeDependencies();
    // Constructing the factory + attaching a fake session must not throw or
    // require any join — this is the entire point of the deferred holder.
    const ext = createRadiusExtension(deps);
    expect(() => ext.attachSession(createFakeSession())).not.toThrow();
  });
});

// Review follow-up: attachSession() is a once-per-process operation. Replacing
// an attached session would orphan the original, which shutdown would then
// never tear down.
describe("attachSession is single-use", () => {
  it("rejects a second attach with a different session", () => {
    const { deps } = createFakeDependencies();
    const ext = createRadiusExtension(deps);
    ext.attachSession(createFakeSession());

    expect(() => ext.attachSession(createFakeSession())).toThrow(
      /already attached/
    );
  });

  it("keeps the originally attached session as the one shutdown tears down", async () => {
    const { deps } = createFakeDependencies();
    const ext = createRadiusExtension(deps);
    const first = createFakeSession({ close: vi.fn() } as never);
    const second = createFakeSession({ close: vi.fn() } as never);
    ext.attachSession(first);
    try {
      ext.attachSession(second);
    } catch {
      /* expected */
    }

    await ext.shutdown("SIGTERM");
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).not.toHaveBeenCalled();
  });

  it("treats re-attaching the identical session as a no-op", () => {
    const { deps } = createFakeDependencies();
    const ext = createRadiusExtension(deps);
    const session = createFakeSession();
    ext.attachSession(session);

    expect(() => ext.attachSession(session)).not.toThrow();
  });

  it("rejects a session attached after shutdown without mutating the holder or starting keepalive", async () => {
    vi.useFakeTimers();
    try {
      const { deps } = createFakeDependencies();
      const ext = createRadiusExtension(deps);
      await ext.shutdown("SIGTERM");

      const session = createFakeSession();
      let attachError: unknown;
      try {
        ext.attachSession(session);
      } catch (error) {
        attachError = error;
      }
      // Assert state first: the old store-then-return behavior must fail here,
      // even before checking the public error contract.
      expect(deps.session.tryGet()).toBeUndefined();
      expect(() => {
        throw attachError;
      }).toThrow(/cannot attach a session after shutdown/);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

function setup() {
  const fake = createFakeDependencies();
  fake.sessionHolder.set(createFakeSession());
  const ext = createRadiusExtension(fake.deps);
  return { ...fake, ext };
}

// RU-19: hooks context/permission/session/keepalive/failure.
describe("RU-19: onPreToolUse hook", () => {
  it("allows (returns undefined) for a non-graph-triggering tool", async () => {
    const { ext } = setup();
    const result = await ext.hooks.onPreToolUse({
      toolName: "some_other_tool",
      toolArgs: {}
    });
    expect(result).toBeUndefined();
  });

  it("denies with a permission decision + additionalContext when app.bicep is missing", async () => {
    const { ext, deps } = setup();
    (
      deps.workspace.detectWorkspaceContext as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      workspacePath: "/ws",
      repo: "acme/widgets",
      branch: "main"
    });
    const result = await ext.hooks.onPreToolUse({
      toolName: "open_canvas",
      toolArgs: {
        canvasId: "radius",
        input: { page: "graph", repo: "acme/widgets" }
      }
    });
    expect(result).toMatchObject({ permissionDecision: "deny" });
    expect(result?.additionalContext).toContain(".radius/app.bicep");
  });

  it("allows when app.bicep exists on the branch", async () => {
    const fake = createFakeDependencies({
      bicepByRepoBranch: { "remote:acme/widgets@main": "resource db {}" }
    });
    fake.sessionHolder.set(createFakeSession());
    const ext = createRadiusExtension(fake.deps);
    const result = await ext.hooks.onPreToolUse({
      toolName: "open_canvas",
      toolArgs: {
        canvasId: "radius",
        input: { page: "graph", repo: "acme/widgets", branch: "main" }
      }
    });
    expect(result).toBeUndefined();
  });

  it("fails open (never throws, returns undefined) when a dependency throws", async () => {
    const { ext, deps } = setup();
    (
      deps.workspace.detectWorkspaceContext as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("workspace lookup exploded"));
    await expect(
      ext.hooks.onPreToolUse({
        toolName: "open_canvas",
        toolArgs: {
          canvasId: "radius",
          input: { page: "graph", repo: "acme/widgets" }
        }
      })
    ).resolves.toBeUndefined();
  });
});

describe("RU-19: onSessionStart hook", () => {
  it("returns the full guidance for a Radius-enabled worktree before session attachment", async () => {
    const fake = createFakeDependencies({ radiusEnabled: true });
    const ext = createRadiusExtension(fake.deps);

    const result = await ext.hooks.onSessionStart({
      workingDirectory: "/worktrees/radius-app"
    });

    expect(result?.additionalContext).toContain("radius-panel");
    expect(result?.additionalContext).toContain("radius_generate_app");
    expect(result?.additionalContext).toContain(
      "radius_generate_pr_diff_markdown"
    );
    expect(
      fake.deps.workspace.hasRadiusApplicationModel
    ).toHaveBeenCalledExactlyOnceWith("/worktrees/radius-app");
  });

  it("returns no context or side effects for an unrelated worktree", async () => {
    const fake = createFakeDependencies();
    const session = createFakeSession();
    fake.sessionHolder.set(session);
    const ext = createRadiusExtension(fake.deps);

    const result = await ext.hooks.onSessionStart({
      workingDirectory: "/worktrees/unrelated"
    });

    expect(result).toBeUndefined();
    expect(session.send).not.toHaveBeenCalled();
    expect(session.rpc.canvas.open).not.toHaveBeenCalled();
    expect(fake.deps.radiusAppBicepSkill).not.toHaveBeenCalled();
    expect(fake.deps.core.fetchBicepFromRepo).not.toHaveBeenCalled();
  });

  it("returns no context when the working directory is unavailable", async () => {
    const { ext, deps } = setup();

    await expect(
      ext.hooks.onSessionStart({ workingDirectory: undefined })
    ).resolves.toBeUndefined();
    expect(deps.workspace.hasRadiusApplicationModel).not.toHaveBeenCalled();
  });

  it("does not block session startup when model detection fails", async () => {
    const { ext, deps } = setup();
    (
      deps.workspace.hasRadiusApplicationModel as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("filesystem unavailable"));

    await expect(
      ext.hooks.onSessionStart({ workingDirectory: "/worktrees/widgets" })
    ).resolves.toBeUndefined();
    expect(deps.session.get().log).toHaveBeenCalledWith(
      expect.stringContaining("filesystem unavailable"),
      { level: "warning", ephemeral: true }
    );
  });

  it("logs a deferred startup diagnostic after the session attaches", async () => {
    const fake = createFakeDependencies();
    const ext = createRadiusExtension(fake.deps);
    (
      fake.deps.workspace.hasRadiusApplicationModel as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("worktree still materializing"));

    await ext.hooks.onSessionStart({
      workingDirectory: "/worktrees/widgets"
    });
    const session = createFakeSession();
    ext.attachSession(session);

    expect(session.log).toHaveBeenCalledWith(
      expect.stringContaining("worktree still materializing"),
      { level: "warning", ephemeral: true }
    );
  });

  it("does not block attachment when startup diagnostic logging fails", async () => {
    const fake = createFakeDependencies();
    const ext = createRadiusExtension(fake.deps);
    (
      fake.deps.workspace.hasRadiusApplicationModel as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("worktree still materializing"));
    await ext.hooks.onSessionStart({
      workingDirectory: "/worktrees/widgets"
    });
    const session = createFakeSession({
      log: vi.fn(() => {
        throw new Error("log unavailable");
      })
    });

    expect(() => ext.attachSession(session)).not.toThrow();
  });
});

describe("RU-19: host-channel callback wiring (context/permission/session)", () => {
  it("registers an app.bicep handoff that sends the full prompt to the agent and a short display prompt to the timeline", async () => {
    const { ext, deps, capturedHostCallbacks } = setup();
    const session = createFakeSession();
    ext.attachSession(session);
    expect(capturedHostCallbacks.appBicepHandoff).toBeTypeOf("function");
    await capturedHostCallbacks.appBicepHandoff!({
      repo: "acme/widgets",
      branches: ["main"],
      page: "graph"
    });
    expect(session.send).toHaveBeenCalledOnce();
    const sent = (session.send as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { prompt: string; displayPrompt: string };
    // The agent half must carry the full instructions...
    expect(sent.prompt).toBe(
      appBicepHandoffPrompt("acme/widgets", "graph", ["main"])
    );
    // ...and the timeline half must be the short stand-in, not the reverse.
    expect(sent.displayPrompt).toBe(
      appBicepHandoffDisplayPrompt("acme/widgets", "graph", ["main"])
    );
    expect(sent.displayPrompt).not.toContain("radius_generate_app");
    void deps;
  });

  it("registers a deploy-repair handoff that sends the full prompt to the agent and a short display prompt to the timeline", async () => {
    const { ext, capturedHostCallbacks } = setup();
    const session = createFakeSession();
    ext.attachSession(session);
    await capturedHostCallbacks.deployRepairHandoff!({
      repo: "acme/widgets",
      branch: "main",
      error: "BCP037",
      deployRunUrl: "https://github.com/acme/widgets/actions/runs/1",
      attemptId: "attempt-A",
      instanceId: "radius-panel"
    });
    expect(session.send).toHaveBeenCalledOnce();
    const sent = (session.send as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { prompt: string; displayPrompt: string };
    expect(sent.prompt).toContain("BCP037");
    expect(sent.prompt).toContain("attempt-A");
    expect(sent.displayPrompt).toBe(
      deployRepairHandoffDisplayPrompt("acme/widgets", "main")
    );
    // The raw deploy diagnostic must never reach the timeline half.
    expect(sent.displayPrompt).not.toContain("BCP037");
    expect(sent.displayPrompt).not.toContain("radius_deploy_status");
  });

  it("registers a deploy-failure notice that reports a run-unconfirmed failure without a repair prompt", async () => {
    const { ext, capturedHostCallbacks } = setup();
    const session = createFakeSession();
    ext.attachSession(session);
    await capturedHostCallbacks.deployFailureNotice!({
      repo: "acme/widgets",
      branch: "main",
      error: "dispatch rejected: missing workflow scope",
      deployRunUrl: "https://github.com/acme/widgets/actions/runs/1",
      instanceId: "radius-panel"
    });
    expect(session.send).toHaveBeenCalledOnce();
    const sent = (session.send as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { prompt: string; displayPrompt: string };
    expect(sent.prompt).toContain("missing workflow scope");
    expect(sent.prompt).toMatch(/do not automatically redeploy/i);
    // A run-unconfirmed failure must not push the agent into the repair loop.
    expect(sent.prompt).not.toContain("radius_generate_app");
    expect(sent.displayPrompt).toBe(
      deployFailureNoticeDisplayPrompt("acme/widgets", "main")
    );
    expect(sent.displayPrompt).not.toContain("missing workflow scope");
  });

  it("registers a session-prompt handler that forwards a bare prompt string", async () => {
    const { ext, capturedHostCallbacks } = setup();
    const session = createFakeSession();
    ext.attachSession(session);
    await capturedHostCallbacks.sessionPromptHandler!("please log in");
    expect(session.send).toHaveBeenCalledWith("please log in");
  });

  it("forwards an already-paired session prompt message untouched", async () => {
    const { ext, capturedHostCallbacks } = setup();
    const session = createFakeSession();
    ext.attachSession(session);
    const message = { prompt: "run az login …", displayPrompt: "Signing in." };
    await capturedHostCallbacks.sessionPromptHandler!(message);
    expect(session.send).toHaveBeenCalledWith(message);
  });

  it("registers an open-source handler that opens the editor canvas only for a file on the worktree", async () => {
    const { ext, deps, capturedHostCallbacks } = setup();
    const session = createFakeSession();
    ext.attachSession(session);
    (
      deps.workspace.workspaceFileExists as ReturnType<typeof vi.fn>
    ).mockResolvedValue(true);
    await capturedHostCallbacks.openSourceHandler!({
      path: "src/index.ts",
      line: 1,
      instanceId: "radius-panel",
      state: { workspacePath: "/ws" }
    });
    expect(session.rpc.canvas.open).toHaveBeenCalledWith(
      expect.objectContaining({
        canvasId: "editor",
        instanceId: sourceEditorInstanceId("src/index.ts"),
        input: expect.objectContaining({ path: "src/index.ts" })
      })
    );
  });

  it("opens each source file under its own editor handle so a second node does not just refocus the first file", async () => {
    const { ext, deps, capturedHostCallbacks } = setup();
    const session = createFakeSession();
    ext.attachSession(session);
    (
      deps.workspace.workspaceFileExists as ReturnType<typeof vi.fn>
    ).mockResolvedValue(true);

    for (const path of ["src/api.ts", "src/worker.ts"]) {
      await capturedHostCallbacks.openSourceHandler!({
        path,
        line: 0,
        instanceId: "radius-panel",
        state: { workspacePath: "/ws" }
      });
    }

    const open = session.rpc.canvas.open as ReturnType<typeof vi.fn>;
    expect(open).toHaveBeenCalledTimes(2);
    const [first, second] = open.mock.calls.map(
      (call) => call[0] as { instanceId: string; input: { path: string } }
    );
    expect(first.input.path).toBe("src/api.ts");
    expect(second.input.path).toBe("src/worker.ts");
    expect(second.instanceId).not.toBe(first.instanceId);
  });

  it("throws (and logs) instead of opening a file that is not on the worktree", async () => {
    const { ext, deps, capturedHostCallbacks } = setup();
    const session = createFakeSession();
    ext.attachSession(session);
    (
      deps.workspace.workspaceFileExists as ReturnType<typeof vi.fn>
    ).mockResolvedValue(false);
    await expect(
      capturedHostCallbacks.openSourceHandler!({
        path: "src/index.ts",
        line: 1,
        instanceId: "radius-panel",
        state: { workspacePath: "/ws" }
      })
    ).rejects.toThrow(/not on this worktree/);
    expect(session.log).toHaveBeenCalled();
    expect(session.rpc.canvas.open).not.toHaveBeenCalled();
  });
});

describe("RU-19: keepalive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pings session.metadata.snapshot when a canvas panel was recently active", async () => {
    const { ext, deps, setLastWebviewActivityAt } = setup();
    const session = createFakeSession();
    ext.attachSession(session);
    setLastWebviewActivityAt(Date.now());
    void deps;

    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS + 10);
    expect(session.metadata!.snapshot).toHaveBeenCalled();
  });

  it("does not ping when no panel is active and no deploy is in flight", async () => {
    const { ext, setLastWebviewActivityAt } = setup();
    const session = createFakeSession();
    ext.attachSession(session);
    setLastWebviewActivityAt(Date.now() - KEEPALIVE_ACTIVE_WINDOW_MS - 1000);

    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS + 10);
    expect(session.metadata!.snapshot).not.toHaveBeenCalled();
  });

  it("pings when a deploy is in flight even if the panel is not recently active", async () => {
    const { ext, deps, setLastWebviewActivityAt } = setup();
    const session = createFakeSession();
    ext.attachSession(session);
    setLastWebviewActivityAt(Date.now() - KEEPALIVE_ACTIVE_WINDOW_MS - 1000);
    deps.servers.set("radius-panel", {
      server: {} as never,
      baseUrl: "http://127.0.0.1:0",
      url: "http://127.0.0.1:0/?page=deployed",
      page: "deployed",
      state: { deployStatus: "in_progress" }
    });

    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS + 10);
    expect(session.metadata!.snapshot).toHaveBeenCalled();
  });

  it("never throws even when session.metadata.snapshot rejects", async () => {
    const { ext, setLastWebviewActivityAt } = setup();
    const session = createFakeSession({
      metadata: { snapshot: vi.fn().mockRejectedValue(new Error("boom")) }
    });
    ext.attachSession(session);
    setLastWebviewActivityAt(Date.now());

    await expect(
      vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS + 10)
    ).resolves.not.toThrow();
  });

  it("stops pinging once shutdown has run", async () => {
    const { ext, setLastWebviewActivityAt } = setup();
    const session = createFakeSession();
    ext.attachSession(session);
    setLastWebviewActivityAt(Date.now());
    await ext.shutdown("test");

    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS + 10);
    expect(session.metadata!.snapshot).not.toHaveBeenCalled();
  });
});

describe("RU-21: operation-aware host keepalive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the host channel alive while setup is in flight, then stops after terminal state", async () => {
    const { ext, deps, setLastWebviewActivityAt } = setup();
    const session = createFakeSession();
    // Model the operation registry as state rather than a call-ordered mock, so
    // the assertions describe "setup running" vs "setup finished" instead of
    // how many times the runtime happens to read the predicate per tick.
    let setupRunning = true;
    const setupInFlight = deps.operations.setupInFlight as ReturnType<
      typeof vi.fn
    >;
    setupInFlight.mockImplementation(() => setupRunning);
    ext.attachSession(session);
    setLastWebviewActivityAt(Date.now() - KEEPALIVE_ACTIVE_WINDOW_MS - 1000);

    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS + 10);
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);
    expect(session.metadata!.snapshot).toHaveBeenCalledTimes(2);

    // The operation reaches a terminal state: the panel is still inactive and no
    // deploy is running, so the host channel must stop being kept alive.
    setupRunning = false;
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS * 2);
    expect(session.metadata!.snapshot).toHaveBeenCalledTimes(2);
  });

  it("fails safely when setup state cannot be read", async () => {
    const { ext, deps, setLastWebviewActivityAt } = setup();
    const session = createFakeSession();
    (
      deps.operations.setupInFlight as ReturnType<typeof vi.fn>
    ).mockImplementation(() => {
      throw new Error("operation registry unavailable");
    });
    ext.attachSession(session);
    setLastWebviewActivityAt(Date.now() - KEEPALIVE_ACTIVE_WINDOW_MS - 1000);

    await expect(
      vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS + 10)
    ).resolves.not.toThrow();
    expect(session.metadata!.snapshot).not.toHaveBeenCalled();
  });

  it("stops keeping the channel alive after shutdown even while setup is still in flight", async () => {
    const { ext, deps, setLastWebviewActivityAt } = setup();
    const session = createFakeSession();
    const setupInFlight = deps.operations.setupInFlight as ReturnType<
      typeof vi.fn
    >;
    // The operation never reaches a terminal state: shutdown, not the operation,
    // must be what stops the keepalive.
    setupInFlight.mockReturnValue(true);
    ext.attachSession(session);
    setLastWebviewActivityAt(Date.now() - KEEPALIVE_ACTIVE_WINDOW_MS - 1000);

    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS + 10);
    expect(session.metadata!.snapshot).toHaveBeenCalledTimes(1);

    await ext.shutdown("SIGTERM");
    const readsAtShutdown = setupInFlight.mock.calls.length;

    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS * 3);
    expect(session.metadata!.snapshot).toHaveBeenCalledTimes(1);
    // The runtime also stops polling the operation registry after teardown.
    expect(setupInFlight.mock.calls.length).toBe(readsAtShutdown);
    // Cleanup runs once and completely: the interval is released rather than
    // left firing behind the shutdown guard.
    expect(vi.getTimerCount()).toBe(0);
  });
});

// RU-18 (extension half): shutdown closes every server and tears down the
// session exactly once, even under a duplicate/concurrent call.
describe("RU-18: shutdown is idempotent and closes every server exactly once", () => {
  it("closes every open canvas server and never twice", async () => {
    const { ext, deps } = setup();
    const closeA = vi.fn((cb?: () => void) => cb?.());
    const closeB = vi.fn((cb?: () => void) => cb?.());
    deps.servers.set("panel-a", {
      server: { close: closeA, closeAllConnections: vi.fn() } as never,
      baseUrl: "http://127.0.0.1:0",
      url: "http://127.0.0.1:0/?page=graph",
      page: "graph",
      state: {}
    });
    deps.servers.set("panel-b", {
      server: { close: closeB, closeAllConnections: vi.fn() } as never,
      baseUrl: "http://127.0.0.1:0",
      url: "http://127.0.0.1:0/?page=graph",
      page: "graph",
      state: {}
    });

    await ext.shutdown("SIGTERM");
    expect(
      deps.operations.markEnvironmentInstanceShuttingDown
    ).toHaveBeenCalledWith("panel-a");
    expect(
      deps.operations.markEnvironmentInstanceShuttingDown
    ).toHaveBeenCalledWith("panel-b");
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).toHaveBeenCalledTimes(1);
    expect(deps.servers.size).toBe(0);

    // A second (duplicate) shutdown call must be a no-op.
    await ext.shutdown("SIGTERM");
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).toHaveBeenCalledTimes(1);
  });

  it("tears down the session via its close/dispose method exactly once", async () => {
    const { ext } = setup();
    const close = vi.fn();
    const session = createFakeSession({ close } as never);
    ext.attachSession(session);

    await ext.shutdown("SIGTERM");
    await ext.shutdown("SIGTERM");
    expect(close).toHaveBeenCalledTimes(1);
  });

  // Review follow-up: a session exposing BOTH a named teardown and
  // Symbol.asyncDispose was previously cleaned up twice.
  it("uses Symbol.asyncDispose only as a fallback, never in addition to close()", async () => {
    const { ext } = setup();
    const close = vi.fn();
    const asyncDispose = vi.fn();
    const session = createFakeSession({
      close,
      [Symbol.asyncDispose]: asyncDispose
    } as never);
    ext.attachSession(session);

    await ext.shutdown("SIGTERM");
    expect(close).toHaveBeenCalledTimes(1);
    expect(asyncDispose).not.toHaveBeenCalled();
  });

  it("falls back to Symbol.asyncDispose when no named teardown method exists", async () => {
    const { ext } = setup();
    const asyncDispose = vi.fn();
    const session = createFakeSession({
      [Symbol.asyncDispose]: asyncDispose
    } as never);
    ext.attachSession(session);

    await ext.shutdown("SIGTERM");
    expect(asyncDispose).toHaveBeenCalledTimes(1);
  });

  // Review follow-up: a session teardown that never settles must not hang
  // shutdown or leave the keepalive running.
  it("completes and stops the keepalive even when session teardown never settles", async () => {
    vi.useFakeTimers();
    try {
      const { ext, setLastWebviewActivityAt } = setup();
      const session = createFakeSession({
        close: vi.fn(() => new Promise<void>(() => {}))
      } as never);
      ext.attachSession(session);
      setLastWebviewActivityAt(Date.now());

      let settled = false;
      const shutdownDone = ext.shutdown("SIGTERM").then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(5000);
      await shutdownDone;

      expect(settled).toBe(true);
      expect(ext.isShutDown()).toBe(true);
      // The hung teardown must not leave the keepalive interval behind.
      await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS * 2);
      expect(session.metadata!.snapshot).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the same in-flight promise for concurrent shutdown calls", async () => {
    const { ext } = setup();
    const promise1 = ext.shutdown("SIGTERM");
    const promise2 = ext.shutdown("SIGINT");
    expect(promise1).toBe(promise2);
    await Promise.all([promise1, promise2]);
    expect(ext.isShutDown()).toBe(true);
  });

  it("marks isShutDown() true after shutdown and stays true", async () => {
    const { ext } = setup();
    expect(ext.isShutDown()).toBe(false);
    await ext.shutdown("SIGTERM");
    expect(ext.isShutDown()).toBe(true);
  });

  it("never throws even when a server's close callback throws", async () => {
    const { ext, deps } = setup();
    deps.servers.set("panel-a", {
      server: {
        close: () => {
          throw new Error("close exploded");
        }
      } as never,
      baseUrl: "http://127.0.0.1:0",
      url: "http://127.0.0.1:0/?page=graph",
      page: "graph",
      state: {}
    });
    await expect(ext.shutdown("SIGTERM")).resolves.toBeUndefined();
  });
});
