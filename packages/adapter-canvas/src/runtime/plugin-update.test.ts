import { describe, expect, it, vi } from "vitest";
import {
  automaticPluginUpdatesEnabled,
  createRadiusPluginUpdater,
  type PluginUpdatePort
} from "./plugin-update.js";
import { createFakeSession } from "../../test/support/runtime/fakes.js";

const radius = {
  name: "radius",
  marketplace: "radius-plugins",
  enabled: true
};

function fixture(enabled = true) {
  let shutDown = false;
  const list = vi.fn<PluginUpdatePort["list"]>(async () => ({
    plugins: [radius]
  }));
  const update = vi.fn<PluginUpdatePort["update"]>(async () => ({
    previousVersion: "0.4.0",
    newVersion: "0.5.0",
    skillsInstalled: 5
  }));
  const session = createFakeSession();
  session.rpc.plugins = { list, update };
  const logError = vi.fn();
  const run = createRadiusPluginUpdater({
    enabled,
    isShutDown: () => shutDown,
    logError
  });
  return {
    session,
    list,
    update,
    logError,
    run: () => run(session),
    stop: () => {
      shutDown = true;
    }
  };
}

describe("automatic Radius plugin updates", () => {
  it.each([
    [{}, true],
    [{ COPILOT_AUTO_UPDATE: "true" }, true],
    [{ COPILOT_AUTO_UPDATE: "false" }, false],
    [{ COPILOT_AUTO_UPDATE: " FALSE " }, false],
    [{ CI: "true" }, false]
  ])("honors the runtime update environment %j", (environment, enabled) => {
    expect(automaticPluginUpdatesEnabled(environment)).toBe(enabled);
  });

  it("updates only the qualified Radius install once, including concurrent starts", async () => {
    const f = fixture();
    f.list.mockResolvedValue({
      plugins: [radius, { ...radius, name: "other-plugin" }]
    });
    const first = f.run();
    expect(f.run()).toBe(first);
    await first;
    await f.run();
    expect(f.list).toHaveBeenCalledOnce();
    expect(f.update).toHaveBeenCalledExactlyOnceWith({
      name: "radius@radius-plugins"
    });
    expect(f.session.log).toHaveBeenCalledWith(
      expect.stringContaining("this session keeps its current code"),
      { level: "info", ephemeral: true }
    );
    expect(f.session.send).not.toHaveBeenCalled();
    expect(f.logError).not.toHaveBeenCalled();
  });

  it.each([
    [],
    [{ ...radius, name: "other-plugin" }],
    [{ ...radius, enabled: false }],
    [{ ...radius, marketplace: "" }],
    [{ ...radius, installedFrom: "local-marketplace" }],
    [{ ...radius, source: "builtin" }],
    [{ ...radius, managed: true }],
    [radius, { ...radius, marketplace: "another-marketplace" }]
  ])(
    "leaves absent, local, managed, and ambiguous installs unchanged: %j",
    async (...plugins) => {
      const f = fixture();
      f.list.mockResolvedValue({ plugins });
      await f.run();
      expect(f.update).not.toHaveBeenCalled();
      expect(f.session.log).not.toHaveBeenCalled();
    }
  );

  it.each(["disabled", "stopped"])("does not start while %s", async (state) => {
    const f = fixture(state !== "disabled");
    if (state === "stopped") f.stop();
    await f.run();
    expect(f.list).not.toHaveBeenCalled();
  });

  it("does not issue an update after shutdown during discovery", async () => {
    const f = fixture();
    f.list.mockImplementation(async () => {
      f.stop();
      return { plugins: [radius] };
    });
    await f.run();
    expect(f.update).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"])(
    "does not publish late %s after shutdown",
    async (outcome) => {
      const f = fixture();
      f.update.mockImplementation(async () => {
        f.stop();
        if (outcome === "failure") throw new Error("update interrupted");
        return { skillsInstalled: 5 };
      });
      await f.run();
      expect(f.update).toHaveBeenCalledOnce();
      expect(f.session.log).not.toHaveBeenCalled();
      expect(f.logError).not.toHaveBeenCalled();
    }
  );

  it("reports an unavailable runtime API without a command or filesystem fallback", async () => {
    const f = fixture();
    delete f.session.rpc.plugins;
    await f.run();
    expect(f.logError).toHaveBeenCalledWith(
      expect.stringContaining("does not support session plugin updates")
    );
    expect(f.session.log).toHaveBeenCalledWith(
      expect.stringContaining("update Radius manually"),
      { level: "warning", ephemeral: true }
    );
  });

  it.each(["discovery", "update"])(
    "reports %s failures without stopping the session",
    async (stage) => {
      const f = fixture();
      const error = new Error("fixture unavailable");
      if (stage === "discovery") f.list.mockRejectedValue(error);
      else f.update.mockRejectedValue(error);
      await expect(f.run()).resolves.toBeUndefined();
      expect(f.logError).toHaveBeenCalledWith(
        expect.stringContaining("fixture unavailable")
      );
      expect(f.session.log).toHaveBeenCalledWith(
        expect.stringContaining("This session keeps its current code"),
        { level: "warning", ephemeral: true }
      );
      await f.run();
      expect(f.list).toHaveBeenCalledOnce();
    }
  );

  it("works without an optional session logger", async () => {
    const f = fixture();
    delete f.session.log;
    await f.run();
    expect(f.update).toHaveBeenCalledOnce();
    expect(f.logError).not.toHaveBeenCalled();
  });

  it("retains failures when the session logger is unavailable", async () => {
    const f = fixture();
    delete f.session.log;
    f.list.mockRejectedValue("discovery unavailable");
    await f.run();
    expect(f.logError).toHaveBeenCalledWith(
      expect.stringContaining("discovery unavailable")
    );
  });

  it("reports a rejected notice without an unhandled promise", async () => {
    const f = fixture();
    f.list.mockRejectedValue(new Error("discovery unavailable"));
    f.session.log = vi.fn(async () => {
      throw new Error("logging unavailable");
    });
    await expect(f.run()).resolves.toBeUndefined();
    expect(f.logError).toHaveBeenCalledWith(
      expect.stringContaining("could not display its plugin update notice")
    );
  });

  it("reports a failed completion notice without repeating the update", async () => {
    const f = fixture();
    f.session.log = vi.fn(async () => {
      throw new Error("logging unavailable");
    });
    await expect(f.run()).resolves.toBeUndefined();
    expect(f.update).toHaveBeenCalledOnce();
    expect(f.logError).toHaveBeenCalledWith(
      expect.stringContaining("logging unavailable")
    );
  });
});
