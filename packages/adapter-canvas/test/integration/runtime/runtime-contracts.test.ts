import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KEEPALIVE_ACTIVE_WINDOW_MS,
  KEEPALIVE_INTERVAL_MS
} from "../../../src/runtime/create-radius-extension.js";
import { createFakeDependencies } from "../../support/runtime/fakes.js";
import { createRuntimeSdkHarness } from "../../support/runtime/sdk-harness.js";

const ACTION_NAMES = [
  "configure_oidc",
  "render_graph",
  "render_graph_diff",
  "create_environment",
  "get_graph_resources",
  "update_source_refs"
];

const TOOL_NAMES = [
  "radius_configure_oidc",
  "radius_generate_app",
  "radius_render_graph",
  "radius_render_graph_diff",
  "radius_generate_pr_diff_markdown",
  "radius_create_environment",
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
    expect(harness.registration.canvas.actions.map(({ name }) => name)).toEqual(
      ACTION_NAMES
    );
    expect(harness.registration.tools.map(({ name }) => name)).toEqual(
      TOOL_NAMES
    );
    expect(harness.registration.hooks).toEqual([
      "onPreToolUse",
      "onSessionStart"
    ]);

    await expect(
      harness.host.invoke("radius-panel", "configure_oidc", {
        provider: "invalid"
      })
    ).rejects.toThrow(/must be one of azure, aws/);

    await expect(
      harness.host.invoke("radius-panel", "configure_oidc", {
        provider: "azure",
        tenantId: "tenant"
      })
    ).resolves.toMatchObject({
      message: "Azure OIDC configuration generated"
    });
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
      // shutdown's bounded server-close race leaves its losing 2s timeout
      // scheduled briefly; after that settles, the keepalive interval must be
      // gone too.
      await vi.advanceTimersByTimeAsync(2_000);
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
      contextBranch: "feature/runtime-tests"
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

  it("uses the worktree branch for the session repository and explicit base/head for graph diff", async () => {
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
    await harness.host.invoke("radius-panel", "render_graph", {
      resources: [{ id: "database", name: "database", type: "Radius.Data/sql" }]
    });
    const resources = (await harness.host.invoke(
      "radius-panel",
      "get_graph_resources",
      { missingOnly: false }
    )) as { contextToken: string };
    const entry = harness.servers.get("radius-panel");

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
    expect(harness.servers.get("radius-panel")).toBe(entry);
    expect(entry?.state.graphResources?.[0].codeReference).toBe(
      "src/database.ts#L10"
    );
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
