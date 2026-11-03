import { describe, expect, it, vi } from "vitest";
import type { SessionPort } from "../../../src/runtime/session.js";
import type { PluginUpdatePreferences } from "../../../src/runtime/plugin-update-preferences.js";
import { createRuntimeSdkHarness } from "../../support/runtime/sdk-harness.js";

function configureApproval(
  session: SessionPort,
  confirm: (message: string) => Promise<boolean>
) {
  session.capabilities = { ui: { elicitation: true } };
  session.ui = {
    select: async () => {
      throw new Error("unexpected selection");
    },
    confirm
  };
}

describe("session-start Radius plugin update", () => {
  it("uses the joined session API once without changing canvas registration or reloading it", async () => {
    const update = vi.fn(async () => ({ skillsInstalled: 5 }));
    const confirm = vi.fn(async () => true);
    const harness = await createRuntimeSdkHarness({}, (deps, session) => {
      deps.automaticPluginUpdates = true;
      configureApproval(session, confirm);
      session.rpc.plugins = {
        list: async () => ({
          plugins: [
            {
              name: "radius",
              marketplace: "custom-catalog",
              version: "0.4.0",
              enabled: true
            }
          ]
        }),
        update
      };
    });
    try {
      await vi.waitFor(() => {
        expect(harness.session.log).toHaveBeenCalledWith(
          expect.stringContaining("plugin update completed"),
          { level: "info", ephemeral: true }
        );
      });
      harness.extension.attachSession(harness.session);
      expect(update).toHaveBeenCalledExactlyOnceWith({
        name: "radius@custom-catalog"
      });
      expect(confirm).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("radius@custom-catalog to the latest version")
      );
      expect(confirm.mock.invocationCallOrder[0]).toBeLessThan(
        update.mock.invocationCallOrder[0]
      );
      expect(harness.joinSession).toHaveBeenCalledOnce();
      expect(harness.registration.canvas.id).toBe("radius");
      expect(harness.session.send).not.toHaveBeenCalled();
      expect(harness.extension.isShutDown()).toBe(false);
    } finally {
      await harness.extension.shutdown("test");
    }
  });

  it("keeps the canvas usable while waiting for approval and does not repeat a declined request", async () => {
    let decline: (approved: boolean) => void = () => {
      throw new Error("approval was not requested");
    };
    const confirm = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          decline = resolve;
        })
    );
    const update = vi.fn(async () => ({ skillsInstalled: 5 }));
    const harness = await createRuntimeSdkHarness({}, (deps, session) => {
      deps.automaticPluginUpdates = true;
      configureApproval(session, confirm);
      session.rpc.plugins = {
        list: async () => ({
          plugins: [
            {
              name: "radius",
              marketplace: "radius-plugins",
              version: "0.4.0",
              enabled: true
            }
          ]
        }),
        update
      };
    });
    try {
      await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
      await expect(
        harness.host.open("panel", { page: "environment" })
      ).resolves.toBeDefined();
      expect(update).not.toHaveBeenCalled();
      decline(false);
      await Promise.resolve();
      harness.extension.attachSession(harness.session);
      expect(confirm).toHaveBeenCalledOnce();
      expect(update).not.toHaveBeenCalled();
      expect(harness.extension.isShutDown()).toBe(false);
    } finally {
      decline(false);
      await harness.extension.shutdown("test");
    }
  });

  it("retains a usable runtime and surfaces an update rejection", async () => {
    const harness = await createRuntimeSdkHarness({}, (deps, session) => {
      deps.automaticPluginUpdates = true;
      configureApproval(session, async () => true);
      session.rpc.plugins = {
        list: async () => ({
          plugins: [
            {
              name: "radius",
              marketplace: "radius-plugins",
              version: "0.4.0",
              enabled: true
            }
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
      configureApproval(session, async () => true);
      session.rpc.plugins = {
        list: () =>
          new Promise((resolve) => {
            finishDiscovery = () =>
              resolve({
                plugins: [
                  {
                    name: "radius",
                    marketplace: "radius-plugins",
                    version: "0.4.0",
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
      configureApproval(session, async () => true);
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

  it("honors a saved decline in a later runtime without showing another request", async () => {
    let declined = false;
    const preferences: PluginUpdatePreferences = {
      hasDeclined: vi.fn(async () => declined),
      rememberDecline: vi.fn(async () => {
        declined = true;
      })
    };
    const confirm = vi.fn(async () => false);
    const update = vi.fn(async () => ({ skillsInstalled: 5 }));
    const configure = (
      deps: {
        automaticPluginUpdates: boolean;
        pluginUpdatePreferences: PluginUpdatePreferences;
      },
      session: SessionPort
    ) => {
      deps.automaticPluginUpdates = true;
      deps.pluginUpdatePreferences = preferences;
      configureApproval(session, confirm);
      session.rpc.plugins = {
        list: async () => ({
          plugins: [
            {
              name: "radius",
              marketplace: "radius-plugins",
              version: "0.4.0",
              enabled: true
            }
          ]
        }),
        update
      };
    };
    const first = await createRuntimeSdkHarness({}, configure);
    try {
      await vi.waitFor(() =>
        expect(preferences.rememberDecline).toHaveBeenCalledOnce()
      );
    } finally {
      await first.extension.shutdown("test");
    }
    const next = await createRuntimeSdkHarness({}, configure);
    try {
      await vi.waitFor(() =>
        expect(preferences.hasDeclined).toHaveBeenCalledTimes(2)
      );
      await expect(
        next.host.open("panel", { page: "environment" })
      ).resolves.toBeDefined();
      expect(confirm).toHaveBeenCalledOnce();
      expect(update).not.toHaveBeenCalled();
      expect(next.session.log).not.toHaveBeenCalled();
    } finally {
      await next.extension.shutdown("test");
    }
  });
});
