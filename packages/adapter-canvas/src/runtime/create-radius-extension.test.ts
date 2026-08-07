import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRadiusExtension,
  KEEPALIVE_INTERVAL_MS,
  KEEPALIVE_ACTIVE_WINDOW_MS
} from "./create-radius-extension.js";
import {
  createFakeDependencies,
  createFakeSession
} from "./test-support/fakes.js";

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
    expect(result?.permissionDecision).toBe("deny");
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
  it("returns additionalContext with the stable instanceId + core tool guidance", async () => {
    const { ext } = setup();
    const result = await ext.hooks.onSessionStart();
    expect(result.additionalContext).toContain("radius-panel");
    expect(result.additionalContext).toContain("radius_generate_app");
    expect(result.additionalContext).toContain(
      "radius_generate_pr_diff_markdown"
    );
  });
});

describe("RU-19: host-channel callback wiring (context/permission/session)", () => {
  it("registers an app.bicep handoff that sends the handoff prompt through the attached session", async () => {
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
    expect(
      (session.send as ReturnType<typeof vi.fn>).mock.calls[0][0]
    ).toContain("acme/widgets");
    void deps;
  });

  it("registers a deploy-repair handoff that sends the repair prompt", async () => {
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
    expect(
      (session.send as ReturnType<typeof vi.fn>).mock.calls[0][0]
    ).toContain("BCP037");
  });

  it("registers a session-prompt handler that forwards the prompt string", async () => {
    const { ext, capturedHostCallbacks } = setup();
    const session = createFakeSession();
    ext.attachSession(session);
    await capturedHostCallbacks.sessionPromptHandler!("please log in");
    expect(session.send).toHaveBeenCalledWith("please log in");
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
        instanceId: "radius-source",
        input: expect.objectContaining({ path: "src/index.ts" })
      })
    );
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
