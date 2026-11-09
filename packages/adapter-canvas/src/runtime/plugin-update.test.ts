import { describe, expect, it, vi } from "vitest";
import {
  automaticPluginUpdatesEnabled,
  createRadiusPluginUpdater
} from "./plugin-update.js";
import type { SessionPluginsPort } from "./session.js";
import type { PluginUpdatePreferences } from "./plugin-update-preferences.js";
import { createFakeSession } from "../../test/support/runtime/fakes.js";

const radius = {
  name: "radius",
  marketplace: "radius-plugins",
  version: "0.4.0",
  enabled: true
};

const NOW = Date.UTC(2026, 0, 1);
const WEEK = 7 * 24 * 60 * 60 * 1000;

function fixture(enabled = true, answers = new Map<string, number>()) {
  let shutDown = false;
  let now = NOW;
  const list = vi.fn<SessionPluginsPort["list"]>(async () => ({
    plugins: [radius]
  }));
  const update = vi.fn<SessionPluginsPort["update"]>(async () => ({
    previousVersion: "0.4.0",
    newVersion: "0.5.0",
    skillsInstalled: 5
  }));
  const session = createFakeSession();
  const confirm = vi.fn(async () => true);
  session.capabilities = { ui: { elicitation: true } };
  session.ui = {
    select: async () => {
      throw new Error("unexpected selection");
    },
    confirm
  };
  session.rpc.plugins = { list, update };
  const preferences = {
    lastAnsweredAt: vi.fn<PluginUpdatePreferences["lastAnsweredAt"]>(
      async (marketplace) => answers.get(marketplace)
    ),
    rememberAnswer: vi.fn<PluginUpdatePreferences["rememberAnswer"]>(
      async (marketplace, answeredAt) => {
        answers.set(marketplace, answeredAt);
      }
    )
  };
  const logError = vi.fn();
  const run = createRadiusPluginUpdater({
    enabled,
    preferences,
    now: () => now,
    isShutDown: () => shutDown,
    logError
  });
  return {
    session,
    list,
    update,
    confirm,
    preferences,
    answers,
    setNow: (value: number) => {
      now = value;
    },
    logError,
    run: () => run(session),
    stop: () => {
      shutDown = true;
    }
  };
}

describe("approval-based Radius plugin updates", () => {
  it.each([
    [{}, true],
    [{ COPILOT_AUTO_UPDATE: "true" }, true],
    [{ COPILOT_AUTO_UPDATE: "false" }, false],
    [{ COPILOT_AUTO_UPDATE: " FALSE " }, false],
    [{ COPILOT_AUTO_UPDATE: "0" }, false],
    [{ COPILOT_AUTO_UPDATE: "1" }, true],
    [{ COPILOT_AUTO_UPDATE: " " }, true],
    [{ CI: "true" }, false],
    [{ CI: " TRUE " }, false],
    [{ CI: "1" }, false],
    [{ CI: "false" }, true],
    [{ CI: " FALSE " }, true],
    [{ CI: "0" }, true],
    [{ CI: " " }, true]
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
    expect(f.confirm).toHaveBeenCalledExactlyOnceWith(
      "Update radius@radius-plugins to the latest version available from this marketplace? Installed changes will load in a new session; this session keeps its current code. After any answer, including cancellation, Radius waits 7 days before asking again for this marketplace."
    );
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
    [
      {
        ...radius,
        marketplace: "radius-local",
        installedFrom: "/opt/local-marketplace"
      }
    ],
    [
      {
        ...radius,
        marketplace: "radius-local",
        installedFrom: "C:\\local-marketplace"
      }
    ],
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
      expect(f.confirm).not.toHaveBeenCalled();
      expect(f.session.log).not.toHaveBeenCalled();
    }
  );

  it.each(["disabled", "stopped"])("does not start while %s", async (state) => {
    const f = fixture(state !== "disabled");
    if (state === "stopped") f.stop();
    await f.run();
    expect(f.list).not.toHaveBeenCalled();
    expect(f.confirm).not.toHaveBeenCalled();
  });

  it("does not issue an update after shutdown during discovery", async () => {
    const f = fixture();
    f.list.mockImplementation(async () => {
      f.stop();
      return { plugins: [radius] };
    });
    await f.run();
    expect(f.update).not.toHaveBeenCalled();
    expect(f.confirm).not.toHaveBeenCalled();
  });

  it("does not update when approval is declined or cancelled", async () => {
    const f = fixture();
    f.confirm.mockResolvedValue(false);
    await f.run();
    await f.run();
    expect(f.confirm).toHaveBeenCalledOnce();
    expect(f.update).not.toHaveBeenCalled();
    expect(f.session.log).not.toHaveBeenCalled();
    expect(f.logError).not.toHaveBeenCalled();
    expect(f.preferences.rememberAnswer).toHaveBeenCalledExactlyOnceWith(
      radius.marketplace,
      NOW
    );
  });

  it.each([false, true])(
    "suppresses another request after answer %s across updater instances and version changes",
    async (approved) => {
      const first = fixture();
      first.confirm.mockResolvedValue(approved);
      await first.run();
      const next = fixture(true, first.answers);
      next.list.mockResolvedValue({
        plugins: [{ ...radius, version: "0.5.0" }]
      });
      await next.run();
      expect(next.confirm).not.toHaveBeenCalled();
      expect(next.update).not.toHaveBeenCalled();
      expect(next.session.log).not.toHaveBeenCalled();
    }
  );

  it("asks again for a different marketplace", async () => {
    const first = fixture();
    first.confirm.mockResolvedValue(false);
    await first.run();
    const next = fixture(true, first.answers);
    next.list.mockResolvedValue({
      plugins: [
        {
          ...radius,
          marketplace: "another-marketplace"
        }
      ]
    });
    await next.run();
    expect(next.confirm).toHaveBeenCalledOnce();
    expect(next.update).toHaveBeenCalledOnce();
  });

  it.each([
    [0, false],
    [WEEK - 1, false],
    [WEEK, true],
    [WEEK + 1, true],
    [-1, true]
  ])(
    "checks the seven-day boundary at elapsed %d ms",
    async (elapsed, asks) => {
      const f = fixture(true, new Map([[radius.marketplace, NOW]]));
      f.setNow(NOW + elapsed);
      await f.run();
      expect(f.confirm).toHaveBeenCalledTimes(asks ? 1 : 0);
      expect(f.update).toHaveBeenCalledTimes(asks ? 1 : 0);
      expect(f.preferences.rememberAnswer).toHaveBeenCalledTimes(asks ? 1 : 0);
    }
  );

  it("recognizes an answer saved at the Unix epoch", async () => {
    const f = fixture(true, new Map([[radius.marketplace, 0]]));
    f.setNow(WEEK - 1);
    await f.run();
    expect(f.confirm).not.toHaveBeenCalled();
  });

  it("starts the cooldown when the answer arrives, not when the prompt opens", async () => {
    const f = fixture();
    f.confirm.mockImplementation(async () => {
      f.setNow(NOW + WEEK);
      return true;
    });
    await f.run();
    expect(f.preferences.rememberAnswer).toHaveBeenCalledExactlyOnceWith(
      radius.marketplace,
      NOW + WEEK
    );
  });

  it("records approval even when the plugin is already current", async () => {
    const first = fixture();
    first.update.mockResolvedValue({
      previousVersion: radius.version,
      newVersion: radius.version,
      skillsInstalled: 5
    });
    await first.run();
    const next = fixture(true, first.answers);
    await next.run();
    expect(next.confirm).not.toHaveBeenCalled();
    expect(next.update).not.toHaveBeenCalled();
  });

  it.each([undefined, "", " "])(
    "can save a marketplace cooldown without installed version metadata %j",
    async (version) => {
      const f = fixture();
      f.list.mockResolvedValue({ plugins: [{ ...radius, version }] });
      await f.run();
      expect(f.confirm).toHaveBeenCalledOnce();
      expect(f.update).toHaveBeenCalledOnce();
      expect(f.preferences.rememberAnswer).toHaveBeenCalledExactlyOnceWith(
        radius.marketplace,
        NOW
      );
      expect(f.logError).not.toHaveBeenCalled();
    }
  );

  it("does not ask or update after shutdown during preference loading", async () => {
    const f = fixture();
    f.preferences.lastAnsweredAt.mockImplementation(async () => {
      f.stop();
      return undefined;
    });
    await f.run();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
    expect(f.session.log).not.toHaveBeenCalled();
  });

  it("skips a preference read failure with only a diagnostic", async () => {
    const f = fixture();
    f.preferences.lastAnsweredAt.mockRejectedValue(
      new Error("preference read failed")
    );
    await f.run();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
    expect(f.session.log).not.toHaveBeenCalled();
    expect(f.logError).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        "could not read its approval history: preference read failed"
      )
    );
  });

  it.each([false, true])(
    "retains answer %s when saving its timestamp fails, without a warning",
    async (approved) => {
      const f = fixture();
      f.confirm.mockResolvedValue(approved);
      f.preferences.rememberAnswer.mockRejectedValue(
        new Error("preference save failed")
      );
      await f.run();
      expect(f.update).toHaveBeenCalledTimes(approved ? 1 : 0);
      expect(f.session.log).not.toHaveBeenCalledWith(expect.anything(), {
        level: "warning",
        ephemeral: true
      });
      expect(f.logError).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(
          "could not save its plugin update approval history: preference save failed"
        )
      );
    }
  );

  it.each(["read", "save"] as const)(
    "does not report a late preference %s failure after shutdown",
    async (operation) => {
      const f = fixture();
      const fail = async () => {
        f.stop();
        throw new Error("interrupted preference access");
      };
      if (operation === "read")
        f.preferences.lastAnsweredAt.mockImplementation(fail);
      else f.preferences.rememberAnswer.mockImplementation(fail);
      await f.run();
      expect(f.confirm).toHaveBeenCalledTimes(operation === "read" ? 0 : 1);
      expect(f.update).not.toHaveBeenCalled();
      expect(f.session.log).not.toHaveBeenCalled();
      expect(f.logError).not.toHaveBeenCalled();
    }
  );

  it("does not update after shutdown while saving an answer", async () => {
    const f = fixture();
    f.preferences.rememberAnswer.mockImplementation(async () => {
      f.stop();
    });
    await f.run();
    expect(f.update).not.toHaveBeenCalled();
    expect(f.session.log).not.toHaveBeenCalled();
  });

  it("waits for explicit approval and shares a pending request across starts", async () => {
    const f = fixture();
    let approve: (approved: boolean) => void = () => {
      throw new Error("approval was not requested");
    };
    f.confirm.mockImplementation(
      () =>
        new Promise((resolve) => {
          approve = resolve;
        })
    );
    const first = f.run();
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce());
    expect(f.run()).toBe(first);
    expect(f.update).not.toHaveBeenCalled();
    expect(f.preferences.rememberAnswer).not.toHaveBeenCalled();
    approve(true);
    await first;
    expect(f.update).toHaveBeenCalledOnce();
  });

  it.each(["success", "failure"])(
    "does not update or publish late approval %s after shutdown",
    async (outcome) => {
      const f = fixture();
      f.confirm.mockImplementation(async () => {
        f.stop();
        if (outcome === "failure") {
          throw new Error("approval interrupted");
        }
        return true;
      });
      await f.run();
      expect(f.update).not.toHaveBeenCalled();
      expect(f.session.log).not.toHaveBeenCalled();
      expect(f.logError).not.toHaveBeenCalled();
    }
  );

  it.each([
    "no-capabilities",
    "no-ui-capability",
    "unsupported",
    "no-ui",
    "no-confirm"
  ])("does not update when approval is unavailable: %s", async (state) => {
    const f = fixture();
    if (state === "no-capabilities") delete f.session.capabilities;
    if (state === "no-ui-capability") f.session.capabilities = {};
    if (state === "unsupported") {
      f.session.capabilities = { ui: { elicitation: false } };
    }
    if (state === "no-ui") delete f.session.ui;
    if (state === "no-confirm" && f.session.ui) {
      delete f.session.ui.confirm;
    }
    await f.run();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
    expect(f.session.log).not.toHaveBeenCalled();
    expect(f.list).not.toHaveBeenCalled();
    expect(f.logError).toHaveBeenCalledWith(
      expect.stringContaining("does not support interactive approval")
    );
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
    expect(f.session.log).not.toHaveBeenCalled();
    expect(f.list).not.toHaveBeenCalled();
  });

  it.each(["discovery", "approval", "update"])(
    "reports %s failures without stopping the session",
    async (stage) => {
      const f = fixture();
      const error = new Error("fixture unavailable");
      if (stage === "discovery") f.list.mockRejectedValue(error);
      else if (stage === "approval") f.confirm.mockRejectedValue(error);
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
      if (stage !== "update") {
        expect(f.update).not.toHaveBeenCalled();
      }
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
      expect.stringContaining(
        "could not display its completed plugin update notice: logging unavailable"
      )
    );
    expect(f.session.log).toHaveBeenCalledOnce();
    expect(f.logError).not.toHaveBeenCalledWith(
      expect.stringContaining("could not complete its plugin update")
    );
  });

  it.each([
    [
      { previousVersion: "0.4.0", newVersion: "0.5.0" },
      "Updated Radius from 0.4.0 to 0.5.0."
    ],
    [
      { previousVersion: "0.5.0", newVersion: "0.5.0" },
      "Radius is already up to date (0.5.0)."
    ],
    [{ newVersion: "0.5.0" }, "Updated Radius to 0.5.0."],
    [{}, "Radius plugin update completed."]
  ])("reports the actual update outcome %j", async (versions, message) => {
    const f = fixture();
    f.update.mockResolvedValue({ ...versions, skillsInstalled: 5 });
    await f.run();
    expect(f.session.log).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(message),
      { level: "info", ephemeral: true }
    );
  });

  it("does not report a completion logging failure after shutdown", async () => {
    const f = fixture();
    f.session.log = vi.fn(async () => {
      f.stop();
      throw new Error("logging interrupted");
    });
    await f.run();
    expect(f.update).toHaveBeenCalledOnce();
    expect(f.logError).not.toHaveBeenCalled();
  });

  it("does not report a rejected warning after shutdown", async () => {
    const f = fixture();
    f.list.mockRejectedValue(new Error("discovery unavailable"));
    f.session.log = vi.fn(async () => {
      f.stop();
      throw new Error("logging interrupted");
    });
    await expect(f.run()).resolves.toBeUndefined();
    expect(f.logError).toHaveBeenCalledOnce();
    expect(f.logError).not.toHaveBeenCalledWith(
      expect.stringContaining("could not display")
    );
  });
});
