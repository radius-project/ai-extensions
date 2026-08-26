import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_ORIGIN_REPO_PATH,
  UNIDENTIFIED_APPLICATION_MESSAGE,
  UNSUPPORTED_NO_DOCKERFILE_MESSAGE,
  serializeAppOrigin
} from "@radius-project/core";
import { hashAppBicep } from "../../../src/app-bicep-hash.js";
import type { RadiusExtension } from "../../../src/runtime/create-radius-extension.js";
import {
  KEEPALIVE_ACTIVE_WINDOW_MS,
  KEEPALIVE_INTERVAL_MS
} from "../../../src/runtime/create-radius-extension.js";
import {
  createFakeDependencies,
  createFakeSession
} from "../../support/runtime/fakes.js";
import { createRuntimeSdkHarness } from "../../support/runtime/sdk-harness.js";

const ACTION_NAMES = ["get_graph_resources", "update_source_refs"];

const TOOL_NAMES = [
  "radius_generate_app",
  "radius_generate_pr_diff_markdown",
  "radius_publish_custom_type_extension",
  "radius_publish_recipe",
  "radius_deploy",
  "radius_deploy_status"
];

describe("P0-A Radius runtime registration contract", () => {
  it("imports and constructs real factories without production joinSession, then bootstraps exactly once", async () => {
    vi.resetModules();
    const productionJoinSession = vi.fn();
    vi.doMock("@github/copilot-sdk/extension", () => ({
      createCanvas: vi.fn(),
      joinSession: productionJoinSession
    }));
    try {
      const [
        { createRadiusCanvas: importRadiusCanvas },
        { createRadiusExtension: importRadiusExtension }
      ] = await Promise.all([
        import("../../../src/runtime/create-radius-canvas.js"),
        import("../../../src/runtime/create-radius-extension.js")
      ]);
      const fake = createFakeDependencies();
      expect(() => importRadiusCanvas(fake.deps)).not.toThrow();
      expect(() => importRadiusExtension(fake.deps)).not.toThrow();
      expect(productionJoinSession).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("@github/copilot-sdk/extension");
    }

    const harness = await createRuntimeSdkHarness();
    expect(harness.createCanvas).toHaveBeenCalledOnce();
    expect(harness.joinSession).toHaveBeenCalledOnce();
    expect(harness.sessionHolder.get()).toBe(harness.session);
    expect(() =>
      harness.extension.attachSession(harness.session)
    ).not.toThrow();
    expect(() => harness.extension.attachSession(createFakeSession())).toThrow(
      /session is already attached/
    );
    await harness.extension.shutdown("test");
  });

  it("round-trips SDK metadata and schemas while retaining routed handlers", async () => {
    const harness = await createRuntimeSdkHarness();

    expect(harness.registration.canvas).toMatchObject({
      id: "radius",
      displayName: "Radius",
      inputSchema: {
        type: "object",
        properties: {
          page: {
            enum: [
              "credentials",
              "graph",
              "planned",
              "graph-diff",
              "deployed",
              "environment",
              "deploying"
            ]
          }
        }
      }
    });
    const canvasProperties =
      harness.registration.canvas.inputSchema.properties ?? {};
    expect(Object.keys(canvasProperties)).toEqual([
      "page",
      "repo",
      "branch",
      "baseBranch",
      "headBranch"
    ]);
    expect(canvasProperties.branch).toMatchObject({ type: "string" });
    expect(harness.registration.canvas.actions.map(({ name }) => name)).toEqual(
      ACTION_NAMES
    );
    expect(harness.registration.tools.map(({ name }) => name)).toEqual(
      TOOL_NAMES
    );
    expect(harness.registration.hooks).toEqual([
      "onPostToolUse",
      "onPostToolUseFailure",
      "onPreToolUse",
      "onSessionStart"
    ]);

    await expect(
      harness.host.open("radius-panel", {
        page: "graph",
        repo: "acme/widgets",
        branch: 42
      })
    ).rejects.toThrow("canvas input.branch must be a string");
    await expect(
      harness.host.open("radius-panel", null as never)
    ).rejects.toThrow("canvas input must be an object");
    await expect(
      harness.host.invoke("radius-panel", "get_graph_resources", null as never)
    ).rejects.toThrow("get_graph_resources input must be an object");
    await harness.extension.shutdown("test");
  });

  it("injects Radius guidance only for a worktree with an existing application model", async () => {
    const unrelated = await createRuntimeSdkHarness();
    const enabled = await createRuntimeSdkHarness({ radiusEnabled: true });

    const unrelatedResult = await unrelated.extension.hooks.onSessionStart({
      workingDirectory: "/worktrees/unrelated"
    });
    const enabledResult = await enabled.extension.hooks.onSessionStart({
      workingDirectory: "/worktrees/radius-app"
    });

    expect(unrelatedResult).toBeUndefined();
    expect(unrelated.session.send).not.toHaveBeenCalled();
    expect(unrelated.session.rpc.canvas.open).not.toHaveBeenCalled();
    expect(unrelated.deps.core.fetchBicepFromRepo).not.toHaveBeenCalled();
    expect(unrelated.deps.radiusAppBicepSkill).not.toHaveBeenCalled();
    expect(enabledResult?.additionalContext).toContain("radius-panel");
    expect(enabledResult?.additionalContext).toContain(
      "radius_generate_pr_diff_markdown"
    );
    expect(
      enabled.deps.workspace.hasRadiusApplicationModel
    ).toHaveBeenCalledExactlyOnceWith("/worktrees/radius-app");

    await unrelated.extension.shutdown("test");
    await enabled.extension.shutdown("test");
  });

  it("requires the matching application graph diff and opens the interactive PR diff", async () => {
    const harness = await createRuntimeSdkHarness({
      radiusEnabled: true,
      workspaceContext: {
        workspacePath: "/worktrees/widgets",
        repo: "acme/widgets",
        branch: "feature"
      },
      bicepByRepoBranch: {
        "remote:acme/widgets@main": "resource app {}",
        "workspace:acme/widgets@feature": "resource app {}"
      }
    });
    await harness.extension.hooks.onSessionStart({
      workingDirectory: "/worktrees/widgets"
    });
    const pullRequest = {
      toolName: "create_pull_request",
      toolArgs: { title: "Add cache", body: "" },
      workingDirectory: "/worktrees/widgets"
    };

    const denied = await harness.extension.hooks.onPreToolUse(pullRequest);
    expect(denied).toMatchObject({ permissionDecision: "deny" });
    expect(denied?.additionalContext).toContain("baseBranch `main`");
    expect(denied?.additionalContext).toContain("headBranch `feature`");

    const diffTool = harness.extension.tools.find(
      ({ name }) => name === "radius_generate_pr_diff_markdown"
    );
    if (!diffTool) throw new Error("PR graph diff tool was not registered");
    const diffResult = await diffTool.handler({
      repo: "acme/widgets",
      baseBranch: "main",
      headBranch: "feature"
    });
    if (
      typeof diffResult !== "object" ||
      !diffResult ||
      !("textResultForLlm" in diffResult) ||
      typeof diffResult.textResultForLlm !== "string"
    ) {
      throw new Error("PR graph diff tool did not return markdown");
    }
    const markdown = diffResult.textResultForLlm;
    await harness.extension.hooks.onPostToolUse({
      toolName: diffTool.name,
      toolArgs: {
        repo: "acme/widgets",
        baseBranch: "main",
        headBranch: "feature"
      },
      toolResult: diffResult,
      workingDirectory: "/worktrees/widgets"
    });

    const allowed = {
      ...pullRequest,
      toolArgs: {
        title: "Add cache",
        body: `${markdown}\nImplementation details`
      }
    };
    await expect(
      harness.extension.hooks.onPreToolUse(allowed)
    ).resolves.toBeUndefined();
    await expect(
      harness.extension.hooks.onPostToolUse(allowed)
    ).resolves.toBeUndefined();
    expect(harness.routedOpens.at(-1)).toMatchObject({
      canvasId: "radius",
      instanceId: "radius-panel",
      input: {
        page: "graph-diff",
        repo: "acme/widgets",
        baseBranch: "main",
        headBranch: "feature"
      }
    });

    await harness.extension.shutdown("test");
  });

  it("activates PR graph diffs after first-time modeling in the same session", async () => {
    const harness = await createRuntimeSdkHarness({
      workspaceContext: {
        workspacePath: "/worktrees/new-app",
        repo: "acme/new-app",
        branch: "feature"
      },
      bicepByRepoBranch: {
        "workspace:acme/new-app@feature": "resource app {}"
      }
    });
    const hasModel = harness.deps.workspace
      .hasRadiusApplicationModel as ReturnType<typeof vi.fn>;
    hasModel.mockResolvedValueOnce(false).mockResolvedValue(true);

    await expect(
      harness.extension.hooks.onSessionStart({
        workingDirectory: "/worktrees/new-app"
      })
    ).resolves.toBeUndefined();

    const pullRequest = {
      toolName: "create_pull_request",
      toolArgs: { title: "Model new application", body: "" },
      workingDirectory: "/worktrees/new-app"
    };
    const denied = await harness.extension.hooks.onPreToolUse(pullRequest);
    expect(denied).toMatchObject({ permissionDecision: "deny" });
    expect(denied?.additionalContext).toContain("repo `acme/new-app`");

    const diffTool = harness.extension.tools.find(
      ({ name }) => name === "radius_generate_pr_diff_markdown"
    );
    if (!diffTool) throw new Error("PR graph diff tool was not registered");
    const diffArgs = {
      repo: "acme/new-app",
      baseBranch: "main",
      headBranch: "feature"
    };
    const diffResult = await diffTool.handler(diffArgs);
    if (
      typeof diffResult !== "object" ||
      !diffResult ||
      !("textResultForLlm" in diffResult) ||
      typeof diffResult.textResultForLlm !== "string"
    ) {
      throw new Error("PR graph diff tool did not return markdown");
    }
    const markdown = diffResult.textResultForLlm;
    await harness.extension.hooks.onPostToolUse({
      toolName: diffTool.name,
      toolArgs: diffArgs,
      toolResult: diffResult,
      workingDirectory: "/worktrees/new-app"
    });

    const allowed = {
      ...pullRequest,
      toolArgs: {
        title: "Model new application",
        body: `${markdown}\nFirst Radius model`
      }
    };
    await expect(
      harness.extension.hooks.onPreToolUse(allowed)
    ).resolves.toBeUndefined();
    await harness.extension.hooks.onPostToolUse(allowed);
    expect(harness.routedOpens.at(-1)).toMatchObject({
      instanceId: "radius-panel",
      input: {
        page: "graph-diff",
        repo: "acme/new-app",
        baseBranch: "main",
        headBranch: "feature"
      }
    });

    await harness.extension.shutdown("test");
  });

  it("allows a modeled worktree PR when committed branches have no graph", async () => {
    const harness = await createRuntimeSdkHarness({
      radiusEnabled: true,
      workspaceContext: {
        workspacePath: "/worktrees/widgets",
        repo: "acme/widgets",
        branch: "feature"
      }
    });
    await harness.extension.hooks.onSessionStart({
      workingDirectory: "/worktrees/widgets"
    });
    const diffArgs = {
      repo: "acme/widgets",
      baseBranch: "main",
      headBranch: "feature"
    };
    const deniedDiff = await harness.extension.hooks.onPreToolUse({
      toolName: "radius_generate_pr_diff_markdown",
      toolArgs: diffArgs,
      workingDirectory: "/worktrees/widgets"
    });
    expect(deniedDiff).toMatchObject({ permissionDecision: "deny" });

    const result = await harness.extension.hooks.onPreToolUse({
      toolName: "create_pull_request",
      toolArgs: { title: "Document setup", body: "Summary" },
      workingDirectory: "/worktrees/widgets"
    });

    expect(result).not.toHaveProperty("permissionDecision");
    expect(result?.additionalContext).toContain("without a graph diff section");
    expect(harness.routedOpens).toHaveLength(0);
    await harness.extension.shutdown("test");
  });

  it("allows a modeled worktree PR when graph generation fails", async () => {
    const harness = await createRuntimeSdkHarness({
      radiusEnabled: true,
      workspaceContext: {
        workspacePath: "/worktrees/widgets",
        repo: "acme/widgets",
        branch: "feature"
      },
      bicepByRepoBranch: {
        "remote:acme/widgets@main": "resource app {}",
        "workspace:acme/widgets@feature": "resource app {}"
      }
    });
    await harness.extension.hooks.onSessionStart({
      workingDirectory: "/worktrees/widgets"
    });
    (
      harness.deps.rad.buildGraphViaRad as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("rad unavailable"));
    const diffTool = harness.extension.tools.find(
      ({ name }) => name === "radius_generate_pr_diff_markdown"
    );
    if (!diffTool) throw new Error("PR graph diff tool was not registered");
    const diffArgs = {
      repo: "acme/widgets",
      baseBranch: "main",
      headBranch: "feature"
    };
    const failed = await diffTool.handler(diffArgs);
    if (
      typeof failed !== "object" ||
      !failed ||
      !("error" in failed) ||
      typeof failed.error !== "string"
    ) {
      throw new Error("PR graph diff tool did not return a failure");
    }
    await harness.extension.hooks.onPostToolUseFailure({
      toolName: diffTool.name,
      toolArgs: diffArgs,
      error: failed.error,
      workingDirectory: "/worktrees/widgets"
    });

    const result = await harness.extension.hooks.onPreToolUse({
      toolName: "create_pull_request",
      toolArgs: { title: "Fix typo", body: "Summary" },
      workingDirectory: "/worktrees/widgets"
    });

    expect(result).not.toHaveProperty("permissionDecision");
    expect(result?.additionalContext).toContain("rad unavailable");
    expect(harness.routedOpens).toHaveLength(0);
    await harness.extension.shutdown("test");
  });

  it("leaves unrelated worktree PR creation untouched", async () => {
    const harness = await createRuntimeSdkHarness();
    const pullRequest = {
      toolName: "create_pull_request",
      toolArgs: { title: "Update documentation", body: "Summary" },
      workingDirectory: "/worktrees/unrelated"
    };

    await expect(
      harness.extension.hooks.onPreToolUse(pullRequest)
    ).resolves.toBeUndefined();
    await expect(
      harness.extension.hooks.onPostToolUse(pullRequest)
    ).resolves.toBeUndefined();
    expect(harness.deps.github.getDefaultBranch).not.toHaveBeenCalled();
    expect(harness.session.rpc.canvas.open).not.toHaveBeenCalled();

    await harness.extension.shutdown("test");
  });

  describe("P0-A RU-21 operation-aware keepalive", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function markPanelInactive(
      harness: Awaited<ReturnType<typeof createRuntimeSdkHarness>>
    ) {
      harness.setLastWebviewActivityAt(
        Date.now() - KEEPALIVE_ACTIVE_WINDOW_MS - 1
      );
    }

    it("keeps the host channel alive while setup is in flight", async () => {
      const harness = await createRuntimeSdkHarness();
      markPanelInactive(harness);
      (
        harness.deps.operations.setupInFlight as ReturnType<typeof vi.fn>
      ).mockReturnValue(true);

      await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS + 1);
      expect(harness.session.metadata?.snapshot).toHaveBeenCalledOnce();
      await harness.extension.shutdown("test");
    });

    it("stops operation-only keepalive once setup reaches a terminal state", async () => {
      const harness = await createRuntimeSdkHarness();
      markPanelInactive(harness);
      const setupInFlight = harness.deps.operations.setupInFlight as ReturnType<
        typeof vi.fn
      >;
      setupInFlight.mockReturnValue(true);

      await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS + 1);
      expect(harness.session.metadata?.snapshot).toHaveBeenCalledOnce();

      setupInFlight.mockReturnValue(false);
      await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS + 1);
      expect(harness.session.metadata?.snapshot).toHaveBeenCalledOnce();
      await harness.extension.shutdown("test");
    });

    it("treats a failing operation predicate as inactive without breaking the timer", async () => {
      const harness = await createRuntimeSdkHarness();
      markPanelInactive(harness);
      (
        harness.deps.operations.setupInFlight as ReturnType<typeof vi.fn>
      ).mockImplementation(() => {
        throw new Error("operation state unavailable");
      });

      await expect(
        vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS + 1)
      ).resolves.not.toThrow();
      expect(harness.session.metadata?.snapshot).not.toHaveBeenCalled();
      await harness.extension.shutdown("test");
    });

    it("cleans up the operation timer and session only once", async () => {
      const harness = await createRuntimeSdkHarness();
      markPanelInactive(harness);
      const setupInFlight = harness.deps.operations.setupInFlight as ReturnType<
        typeof vi.fn
      >;
      setupInFlight.mockReturnValue(true);
      const close = vi.fn();
      harness.session.close = close;

      await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS + 1);
      expect(setupInFlight).toHaveBeenCalled();
      expect(harness.session.metadata?.snapshot).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      await harness.extension.shutdown("test");
      await harness.extension.shutdown("test");
      // Both cleanup timeouts clear their losing timers, and stopKeepalive runs
      // from finally, so successful shutdown leaves no scheduled work.
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS + 1);

      expect(close).toHaveBeenCalledOnce();
      expect(harness.session.metadata?.snapshot).toHaveBeenCalledOnce();
    });
  });
});

describe("P0-A Radius SDK routing and lifecycle", () => {
  it("routes open, same-instance reopen, rehydrate, and close through one provider instance", async () => {
    const harness = await createRuntimeSdkHarness({
      workspaceContext: {
        workspacePath: "/worktrees/widgets",
        repo: "acme/widgets",
        branch: "feature/runtime-tests"
      }
    });

    await harness.host.open("radius-panel", {
      page: "graph",
      repo: "acme/widgets",
      branch: "main"
    });
    const firstEntry = harness.servers.get("radius-panel");
    expect(firstEntry?.state).toMatchObject({
      contextRepo: "acme/widgets",
      contextBranch: "main"
    });

    await harness.host.open("radius-panel", {
      page: "planned",
      repo: "acme/widgets"
    });
    expect(harness.servers.get("radius-panel")).toBe(firstEntry);
    expect(harness.servers.size).toBe(1);
    expect(firstEntry?.page).toBe("planned");

    await harness.host.rehydrate("radius-panel");
    expect(harness.servers.get("radius-panel")).toBe(firstEntry);
    expect(harness.routedOpens).toHaveLength(3);

    await harness.host.close("radius-panel");
    expect(harness.servers.has("radius-panel")).toBe(false);
    expect(firstEntry?.server.close).toHaveBeenCalledOnce();
  });

  it("surfaces provider failures instead of returning a success-shaped fallback", async () => {
    const harness = await createRuntimeSdkHarness();
    harness.getOrCreateServer.mockRejectedValueOnce(
      new Error("provider unavailable")
    );

    await expect(
      harness.host.open("broken-panel", { page: "credentials" })
    ).rejects.toThrow("provider unavailable");
    expect(harness.servers.has("broken-panel")).toBe(false);
  });

  it("uses the worktree branch when omitted and explicit base/head for graph diff", async () => {
    const harness = await createRuntimeSdkHarness({
      workspaceContext: {
        workspacePath: "/worktrees/widgets",
        repo: "acme/widgets",
        branch: "feature/runtime-tests"
      },
      bicepByRepoBranch: {
        "remote:acme/widgets@main": "resource base {}",
        "workspace:acme/widgets@feature/runtime-tests": "resource head {}"
      }
    });
    harness.deps.rad.buildGraphViaRad = vi
      .fn()
      .mockResolvedValueOnce([{ id: "base", name: "base", type: "x" }])
      .mockResolvedValueOnce([{ id: "head", name: "head", type: "x" }]);

    await harness.host.open("radius-panel", {
      page: "graph-diff",
      repo: "acme/widgets",
      baseBranch: "main",
      headBranch: "feature/runtime-tests"
    });

    expect(harness.deps.core.fetchBicepFromRepo).toHaveBeenCalledWith(
      harness.deps.github,
      "acme/widgets",
      "main"
    );
    expect(harness.deps.workspace.fetchWorkspaceBicep).toHaveBeenCalledWith(
      expect.any(Object),
      "acme/widgets",
      "feature/runtime-tests"
    );
    expect(harness.servers.get("radius-panel")?.state).toMatchObject({
      diffTargetRepo: "acme/widgets",
      diffBase: "main",
      diffHead: "feature/runtime-tests",
      activeGraphView: "diff"
    });
  });

  it("reloads source references through the same SDK instance", async () => {
    const harness = await createRuntimeSdkHarness();
    const entry = await harness.deps.getOrCreateServer("radius-panel", "graph");
    harness.deps.sourceRefs.setSourceRefResources(
      entry,
      "graph",
      [{ id: "database", name: "database", type: "Radius.Data/sql" }],
      { repo: "acme/widgets", branch: "main" }
    );
    entry.state.activeGraphView = "graph";
    const resources = (await harness.host.invoke(
      "radius-panel",
      "get_graph_resources",
      { missingOnly: false }
    )) as { contextToken: string };
    const originalEntry = harness.servers.get("radius-panel");

    await expect(
      harness.host.invoke("radius-panel", "update_source_refs", {
        contextToken: resources.contextToken,
        refs: [{ id: "database", codeReference: "src/database.ts#L10" }]
      })
    ).resolves.toMatchObject({ updated: 1 });

    expect(harness.session.rpc.canvas.open).toHaveBeenCalledWith(
      expect.objectContaining({
        canvasId: "radius",
        instanceId: "radius-panel",
        input: { page: "graph" }
      })
    );
    expect(harness.servers.get("radius-panel")).toBe(originalEntry);
    expect(originalEntry?.state.graphResources?.[0].codeReference).toBe(
      "src/database.ts#L10"
    );
  });

  it("denies a graph open against a stale workspace model and allows it once refreshed", async () => {
    const model =
      "resource app 'Radius.Core/applications@2025-08-01-preview' = {}";
    const recordedAt = "a".repeat(40);
    const origin = (sourceCommit: string) =>
      serializeAppOrigin({
        generatedAt: "2026-08-11T05:32:32.000Z",
        sourceCommit,
        skillVersion: "0.1.0-test",
        appBicepHash: hashAppBicep(model)
      });
    const harness = await createRuntimeSdkHarness({
      bicepByRepoBranch: { "workspace:acme/widgets@main": model },
      filesByRepoBranch: {
        [`workspace:acme/widgets@main:${APP_ORIGIN_REPO_PATH}`]:
          origin(recordedAt)
      },
      headCommits: { "workspace:/workspace": "b".repeat(40) },
      sourceChangedSince: true
    });
    const open = {
      toolName: "open_canvas",
      toolArgs: {
        canvasId: "radius",
        input: { page: "graph", repo: "acme/widgets", branch: "main" }
      }
    };

    const denied = await harness.extension.hooks.onPreToolUse(open);
    expect(denied).toMatchObject({
      permissionDecision: "deny",
      permissionDecisionReason: expect.stringContaining("must be regenerated")
    });
    expect(denied?.additionalContext).toContain("radius_generate_app");

    // The skill regenerates and rewrites the origin record against the branch's
    // current commit, so the worktree now reports no source change beyond the
    // app model itself.
    harness.deps.appModel.fetchWorkspaceFile = async () =>
      origin("b".repeat(40));
    harness.deps.appModel.workspaceSourceChangedSince = async () => false;

    await expect(
      harness.extension.hooks.onPreToolUse(open)
    ).resolves.toBeUndefined();

    await harness.extension.shutdown("test");
  });

  // The memo key includes the commit the record names, so a long session with
  // many regenerations would otherwise grow it without limit.
  it("keeps asking about new problems without growing the memo forever", async () => {
    const model =
      "resource app 'Radius.Core/applications@2025-08-01-preview' = {}";
    let commit = 0;
    const harness = await createRuntimeSdkHarness({
      bicepByRepoBranch: { "workspace:acme/widgets@main": model },
      headCommits: { "workspace:/workspace": "f".repeat(40) },
      sourceChangedSince: true
    });
    // Each look presents a record naming a different commit, which is what a
    // fresh regeneration produces.
    harness.deps.appModel.fetchWorkspaceFile = async () =>
      serializeAppOrigin({
        generatedAt: "2026-08-11T05:32:32.000Z",
        sourceCommit: String(commit).padStart(40, "0"),
        skillVersion: "0.1.0-test",
        appBicepHash: hashAppBicep(model)
      });
    const open = {
      toolName: "open_canvas",
      toolArgs: {
        canvasId: "radius",
        input: { page: "graph", repo: "acme/widgets", branch: "main" }
      }
    };

    // Every distinct problem is still reported, well past the memo's limit.
    for (const attempt of [1, 150, 300]) {
      commit = attempt;
      const decision = await harness.extension.hooks.onPreToolUse(open);
      expect(decision).toMatchObject({ permissionDecision: "deny" });
    }

    // And the same problem twice running is still only reported once.
    commit = 999;
    expect(await harness.extension.hooks.onPreToolUse(open)).toMatchObject({
      permissionDecision: "deny"
    });
    expect(await harness.extension.hooks.onPreToolUse(open)).toBeUndefined();

    await harness.extension.shutdown("test");
  });

  it("does not block a graph open on a stale model that lives on another branch", async () => {
    const harness = await createRuntimeSdkHarness({
      bicepByRepoBranch: { "remote:other/repo@release": "resource db {}" },
      headCommits: { "other/repo@release": "c".repeat(40) }
    });

    await expect(
      harness.extension.hooks.onPreToolUse({
        toolName: "open_canvas",
        toolArgs: {
          canvasId: "radius",
          input: { page: "graph", repo: "other/repo", branch: "release" }
        }
      })
    ).resolves.toBeUndefined();

    await harness.extension.shutdown("test");
  });

  it("routes hook failures through the assembled declaration without joining again", async () => {
    const harness = await createRuntimeSdkHarness();
    (
      harness.deps.workspace.detectWorkspaceContext as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("workspace provider failed"));

    await expect(
      harness.extension.hooks.onPreToolUse({
        toolName: "open_canvas",
        toolArgs: {
          canvasId: "radius",
          input: { page: "graph", repo: "acme/widgets" }
        }
      })
    ).resolves.toBeUndefined();
    expect(harness.joinSession).toHaveBeenCalledOnce();

    await harness.extension.shutdown("test");
  });
});

// Exception 2.1: a repository with no Dockerfile has no containerized workload
// to model, so both routes into modeling — the tool the agent calls and the hook
// that auto-triggers it — have to refuse through the real composition, not just
// in isolation.
describe("P0-A Dockerfile prerequisite through the assembled runtime", () => {
  const OPEN_GRAPH = {
    toolName: "open_canvas",
    toolArgs: {
      canvasId: "radius",
      input: { page: "graph", repo: "acme/widgets", branch: "main" }
    }
  };

  function generateApp(harness: { extension: RadiusExtension }) {
    const tool = harness.extension.tools.find(
      (candidate) => candidate.name === "radius_generate_app"
    );
    if (!tool) throw new Error("radius_generate_app not registered");
    return tool.handler({ repoPath: "/workspace" });
  }

  it("withholds the authoring instructions and denies the graph on the workspace branch", async () => {
    const harness = await createRuntimeSdkHarness({
      workspaceTreeByRepoBranch: {
        "acme/widgets@main": ["src/index.ts", "package.json", "README.md"]
      }
    });

    const generated = await generateApp(harness);
    expect(generated).toContain(UNSUPPORTED_NO_DOCKERFILE_MESSAGE);
    expect(harness.deps.radiusAppBicepSkill).not.toHaveBeenCalled();

    const denied = await harness.extension.hooks.onPreToolUse(OPEN_GRAPH);
    expect(denied).toMatchObject({ permissionDecision: "deny" });
    expect(denied?.additionalContext).toContain(
      UNSUPPORTED_NO_DOCKERFILE_MESSAGE
    );
    expect(denied?.additionalContext).not.toContain("radius_generate_app");

    await harness.extension.shutdown("test");
  });

  // Several Dockerfiles are the opposite case: not a refusal at all. The
  // assembled runtime must hand over the authoring instructions AND append the
  // brief, since the wiring under it — lister selection, branch choice, and the
  // final tool output — is the seam that can regress without the factory tests
  // noticing.
  it("hands over the skill with the ambiguity brief when the worktree builds several images", async () => {
    const harness = await createRuntimeSdkHarness({
      workspaceTreeByRepoBranch: {
        "acme/widgets@main": [
          "services/api/Dockerfile",
          "services/web/Dockerfile",
          "services/worker/Dockerfile",
          "pnpm-workspace.yaml",
          "src/index.ts"
        ]
      }
    });

    const generated = String(await generateApp(harness));

    // Not a refusal: the skill is still handed over so the services are modeled
    // as one application.
    expect(harness.deps.radiusAppBicepSkill).toHaveBeenCalledWith("/workspace");
    expect(generated).not.toContain(UNSUPPORTED_NO_DOCKERFILE_MESSAGE);

    // The brief reached the tool output, with the question verbatim.
    expect(generated).toContain(UNIDENTIFIED_APPLICATION_MESSAGE);
    expect(generated).toContain("ONE application");
    expect(generated).toContain("`services/api`");
    expect(generated).toContain("`services/web`");
    expect(generated).toContain("`services/worker`");
    expect(generated).toContain("3 Dockerfile candidate directories");
    // The manifest signal survives the re-read through listSourceTreeForBranch.
    expect(generated).toContain("`pnpm-workspace.yaml`");

    // And the graph is not denied: this repository is modelable.
    const decision = await harness.extension.hooks.onPreToolUse(OPEN_GRAPH);
    expect(decision?.additionalContext).not.toContain(
      UNSUPPORTED_NO_DOCKERFILE_MESSAGE
    );

    await harness.extension.shutdown("test");
  });

  it("does not re-ask once the user answers with a directory inside the worktree", async () => {
    const harness = await createRuntimeSdkHarness({
      workspaceTreeByRepoBranch: {
        "acme/widgets@main": [
          "services/api/Dockerfile",
          "services/web/Dockerfile"
        ]
      }
    });

    const tool = harness.extension.tools.find(
      (candidate) => candidate.name === "radius_generate_app"
    );
    const generated = String(
      await tool!.handler({ repoPath: "/workspace/services/api" })
    );

    expect(generated).not.toContain(UNIDENTIFIED_APPLICATION_MESSAGE);
    expect(harness.deps.radiusAppBicepSkill).toHaveBeenCalledWith(
      "/workspace/services/api"
    );

    await harness.extension.shutdown("test");
  });

  it("denies a repository that is not the workspace's, skipping a vendored Dockerfile the tree listing does not prune", async () => {
    const harness = await createRuntimeSdkHarness({
      remoteTreeByRepoBranch: {
        "other/service@feat": [
          "src/index.ts",
          "node_modules/some-pkg/Dockerfile"
        ]
      }
    });

    const denied = await harness.extension.hooks.onPreToolUse({
      toolName: "open_canvas",
      toolArgs: {
        canvasId: "radius",
        input: { page: "graph", repo: "other/service", branch: "feat" }
      }
    });

    expect(denied).toMatchObject({ permissionDecision: "deny" });
    expect(denied?.additionalContext).toContain(
      UNSUPPORTED_NO_DOCKERFILE_MESSAGE
    );

    await harness.extension.shutdown("test");
  });

  it("honors a caller-named branch when the workspace repository is implicit", async () => {
    const harness = await createRuntimeSdkHarness({
      workspaceTreeByRepoBranch: {
        "acme/widgets@main": ["src/index.ts", "Dockerfile"]
      },
      remoteTreeByRepoBranch: { "acme/widgets@legacy": ["src/index.ts"] }
    });

    const decision = await harness.extension.hooks.onPreToolUse({
      toolName: "open_canvas",
      toolArgs: {
        canvasId: "radius",
        input: { page: "graph", branch: "legacy" }
      }
    });

    expect(decision?.additionalContext).toContain(
      UNSUPPORTED_NO_DOCKERFILE_MESSAGE
    );
    expect(harness.deps.github.treePaths).toHaveBeenCalledWith(
      "acme/widgets",
      "legacy"
    );

    await harness.host.open("radius-panel", {
      page: "graph",
      branch: "legacy"
    });
    expect(harness.servers.get("radius-panel")?.state).toMatchObject({
      contextRepo: "acme/widgets",
      contextBranch: "legacy"
    });

    await harness.extension.shutdown("test");
  });

  it("never reports a repository as unsupported when its listing could not be read", async () => {
    const harness = await createRuntimeSdkHarness();
    (
      harness.deps.workspace.fetchWorkspaceTree as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("permission denied"));

    const generated = await generateApp(harness);
    expect(generated).not.toContain(UNSUPPORTED_NO_DOCKERFILE_MESSAGE);
    expect(harness.deps.radiusAppBicepSkill).toHaveBeenCalledWith("/workspace");

    const denied = await harness.extension.hooks.onPreToolUse(OPEN_GRAPH);
    expect(denied?.additionalContext).not.toContain(
      UNSUPPORTED_NO_DOCKERFILE_MESSAGE
    );
    expect(denied?.additionalContext).toContain("radius_generate_app");

    await harness.extension.shutdown("test");
  });

  it("hands over the authoring instructions when the repository does contain a Dockerfile", async () => {
    const harness = await createRuntimeSdkHarness({
      workspaceTreeByRepoBranch: {
        "acme/widgets@main": ["src/index.ts", "services/api/Dockerfile.dev"]
      }
    });

    const generated = await generateApp(harness);

    expect(generated).not.toContain(UNSUPPORTED_NO_DOCKERFILE_MESSAGE);
    expect(harness.deps.radiusAppBicepSkill).toHaveBeenCalledWith("/workspace");

    await harness.extension.shutdown("test");
  });
});
