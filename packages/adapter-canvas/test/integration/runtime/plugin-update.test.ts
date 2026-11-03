import { describe, expect, it, vi } from "vitest";
import { createRuntimeSdkHarness } from "../../support/runtime/sdk-harness.js";

describe("session-start Radius plugin update", () => {
  it("uses the joined session API once without changing canvas registration or reloading it", async () => {
    const update = vi.fn(async () => ({ skillsInstalled: 5 }));
    const harness = await createRuntimeSdkHarness({}, (deps, session) => {
      deps.automaticPluginUpdates = true;
      session.rpc.plugins = {
        list: async () => ({
          plugins: [
            { name: "radius", marketplace: "custom-catalog", enabled: true }
          ]
        }),
        update
      };
    });
    try {
      await vi.waitFor(() => {
        expect(harness.session.log).toHaveBeenCalledWith(
          expect.stringContaining("update check completed"),
          { level: "info", ephemeral: true }
        );
      });
      harness.extension.attachSession(harness.session);
      expect(update).toHaveBeenCalledExactlyOnceWith({
        name: "radius@custom-catalog"
      });
      expect(harness.joinSession).toHaveBeenCalledOnce();
      expect(harness.registration.canvas.id).toBe("radius");
      expect(harness.session.send).not.toHaveBeenCalled();
      expect(harness.extension.isShutDown()).toBe(false);
    } finally {
      await harness.extension.shutdown("test");
    }
  });

  it("retains a usable runtime and surfaces an update rejection", async () => {
    const harness = await createRuntimeSdkHarness({}, (deps, session) => {
      deps.automaticPluginUpdates = true;
      session.rpc.plugins = {
        list: async () => ({
          plugins: [
            { name: "radius", marketplace: "radius-plugins", enabled: true }
          ]
        }),
        update: async () => {
          throw new Error("marketplace unavailable");
        }
      };
    });
    try {
      await vi.waitFor(() => {
        expect(harness.session.log).toHaveBeenCalledWith(
          expect.stringContaining("marketplace unavailable"),
          { level: "warning", ephemeral: true }
        );
      });
      expect(harness.registration.canvas.id).toBe("radius");
      expect(harness.extension.isShutDown()).toBe(false);
      await expect(
        harness.host.open("panel", { page: "environment" })
      ).resolves.toBeDefined();
    } finally {
      await harness.extension.shutdown("test");
    }
  });

  it("does not start an update if discovery completes after shutdown", async () => {
    let finishDiscovery: () => void = () => {
      throw new Error("discovery was not started");
    };
    const update = vi.fn(async () => ({ skillsInstalled: 5 }));
    const harness = await createRuntimeSdkHarness({}, (deps, session) => {
      deps.automaticPluginUpdates = true;
      session.rpc.plugins = {
        list: () =>
          new Promise((resolve) => {
            finishDiscovery = () =>
              resolve({
                plugins: [
                  {
                    name: "radius",
                    marketplace: "radius-plugins",
                    enabled: true
                  }
                ]
              });
          }),
        update
      };
    });
    await harness.extension.shutdown("test");
    finishDiscovery();
    await Promise.resolve();
    expect(update).not.toHaveBeenCalled();
    expect(harness.session.log).not.toHaveBeenCalled();
  });

  it("observes a rejected update task when the diagnostic sink fails", async () => {
    const report = vi.fn().mockImplementationOnce(() => {
      throw new Error("diagnostic sink unavailable");
    });
    const harness = await createRuntimeSdkHarness({}, (deps, session) => {
      deps.automaticPluginUpdates = true;
      deps.logError = report;
      session.rpc.plugins = {
        list: async () => {
          throw new Error("discovery unavailable");
        },
        update: async () => {
          throw new Error("unexpected update");
        }
      };
    });
    try {
      await vi.waitFor(() => {
        expect(report).toHaveBeenLastCalledWith(
          "Radius plugin update failed: diagnostic sink unavailable"
        );
      });
      expect(harness.extension.isShutDown()).toBe(false);
    } finally {
      await harness.extension.shutdown("test");
    }
  });
});
