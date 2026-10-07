import { describe, expect, it } from "vitest";

import type { CdpProbeResult } from "./copilot-app-cdp.js";
import {
  buildCopilotAppEnvironment,
  launchCopilotApp,
  resolveCopilotAppExecutable,
  tasklistHasImage,
  type CopilotAppHostPorts,
  type SpawnedApp
} from "./copilot-app-host.js";

const OPTIONS = {
  cdpPort: 9222,
  copilotHome: "C:\\tmp\\copilot-home",
  ghConfigDir: "C:\\tmp\\gh-config",
  signInToken: "test-sign-in",
  packagesToken: "test-packages",
  packagesUser: "radius-bot"
};

describe("resolveCopilotAppExecutable", () => {
  it("uses the per-user install path", () => {
    expect(
      resolveCopilotAppExecutable(
        { LOCALAPPDATA: "C:\\Users\\runner\\AppData\\Local" },
        "win32"
      )
    ).toBe(
      "C:\\Users\\runner\\AppData\\Local\\Programs\\GitHub Copilot\\github.exe"
    );
  });

  it.each(["linux", "darwin"] as const)("refuses %s", (platform) => {
    expect(() =>
      resolveCopilotAppExecutable({ LOCALAPPDATA: "C:\\x" }, platform)
    ).toThrow(/runs only on Windows/);
  });

  it.each([{}, { LOCALAPPDATA: "  " }])(
    "refuses a missing LOCALAPPDATA %#",
    (env) => {
      expect(() => resolveCopilotAppExecutable(env, "win32")).toThrow(
        /LOCALAPPDATA is not set/
      );
    }
  );
});

describe("buildCopilotAppEnvironment", () => {
  it("sets the debugging port, isolation folders, and tokens", () => {
    const env = buildCopilotAppEnvironment({ PATH: "C:\\bin" }, OPTIONS);
    expect(env).toEqual({
      PATH: "C:\\bin",
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222",
      COPILOT_HOME: OPTIONS.copilotHome,
      GH_CONFIG_DIR: OPTIONS.ghConfigDir,
      COPILOT_GITHUB_TOKEN: "test-sign-in",
      GH_TOKEN: "test-sign-in",
      GITHUB_TOKEN: "test-sign-in",
      GH_PACKAGES_TOKEN: "test-packages",
      GH_PACKAGES_USER: "radius-bot"
    });
  });

  it("removes the GitHub App private key and overrides inherited values", () => {
    const base = {
      CLOUD_E2E_BOT_PRIVATE_KEY: "key",
      GH_TOKEN: "app-token",
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--other"
    };
    const env = buildCopilotAppEnvironment(base, OPTIONS);
    expect(env.CLOUD_E2E_BOT_PRIVATE_KEY).toBeUndefined();
    expect(env.GH_TOKEN).toBe("test-sign-in");
    expect(env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS).toBe(
      "--remote-debugging-port=9222"
    );
    expect(base.CLOUD_E2E_BOT_PRIVATE_KEY).toBe("key");
  });

  it.each([
    "copilotHome",
    "ghConfigDir",
    "signInToken",
    "packagesToken",
    "packagesUser"
  ] as const)("refuses an empty %s", (name) => {
    expect(() =>
      buildCopilotAppEnvironment({}, { ...OPTIONS, [name]: " " })
    ).toThrow(`The Copilot app option ${name} must not be empty.`);
  });

  it("refuses an invalid port", () => {
    expect(() =>
      buildCopilotAppEnvironment({}, { ...OPTIONS, cdpPort: 0 })
    ).toThrow(/integer from 1 to 65535/);
  });
});

describe("tasklistHasImage", () => {
  it("finds the image in CSV output, ignoring case", () => {
    const output =
      '"System","4","Services","0","1,234 K"\r\n' +
      '"GitHub.exe","8120","Console","1","98,000 K"\r\n';
    expect(tasklistHasImage(output, "github.exe")).toBe(true);
  });

  it.each([
    "INFO: No tasks are running which match the specified criteria.",
    '"githubx.exe","1","Console","1","1 K"',
    ""
  ])("does not match %j", (output) => {
    expect(tasklistHasImage(output, "github.exe")).toBe(false);
  });
});

interface FakeHost {
  readonly ports: CopilotAppHostPorts;
  readonly calls: string[];
  exit(code: number | null): void;
}

function fakeHost(options: {
  running?: boolean;
  probes: CdpProbeResult[];
  killFails?: boolean;
}): FakeHost {
  const calls: string[] = [];
  let clock = 0;
  let resolveExit: (code: number | null) => void = () => {
    throw new Error("The app was not spawned.");
  };
  const probes = [...options.probes];
  const ports: CopilotAppHostPorts = {
    isAppRunning: () => Promise.resolve(options.running ?? false),
    spawn(executable, env) {
      calls.push(`spawn ${executable} ${env.COPILOT_HOME ?? ""}`);
      const exited = new Promise<number | null>((resolve) => {
        resolveExit = resolve;
      });
      const app: SpawnedApp = { pid: 42, exited };
      return app;
    },
    probe(cdpUrl) {
      calls.push(`probe ${cdpUrl}`);
      const next = probes.shift();
      if (!next) throw new Error("No probe result was scripted.");
      return Promise.resolve(next);
    },
    kill(pid) {
      calls.push(`kill ${pid}`);
      return options.killFails ?
          Promise.reject(new Error("taskkill failed"))
        : Promise.resolve();
    },
    now: () => clock,
    wait(milliseconds) {
      calls.push(`wait ${milliseconds}`);
      clock += milliseconds;
      return Promise.resolve();
    }
  };
  return { ports, calls, exit: (code) => resolveExit(code) };
}

const DOWN: CdpProbeResult = { ok: false, reason: "connection refused" };
const UP: CdpProbeResult = { ok: true, browser: "Edg/140.0" };
const CONFIG = {
  executable: "C:\\app\\github.exe",
  cdpPort: 9222,
  env: { COPILOT_HOME: "C:\\home" }
};
const TIMING = { timeoutMs: 1_000, intervalMs: 500 };

describe("launchCopilotApp", () => {
  it("starts the app and returns once CDP answers", async () => {
    const host = fakeHost({ probes: [DOWN, DOWN, UP] });
    const app = await launchCopilotApp(CONFIG, host.ports, TIMING);
    expect(app.cdpUrl).toBe("http://127.0.0.1:9222");
    expect(app.browser).toBe("Edg/140.0");
    expect(host.calls).toEqual([
      "probe http://127.0.0.1:9222",
      "spawn C:\\app\\github.exe C:\\home",
      "probe http://127.0.0.1:9222",
      "wait 500",
      "probe http://127.0.0.1:9222"
    ]);
  });

  it("stops the app once even when stop is called again", async () => {
    const host = fakeHost({ probes: [DOWN, UP] });
    const app = await launchCopilotApp(CONFIG, host.ports, TIMING);
    await app.stop();
    await app.stop();
    expect(host.calls.filter((call) => call.startsWith("kill"))).toEqual([
      "kill 42"
    ]);
  });

  it("does not kill an app that already exited", async () => {
    const host = fakeHost({ probes: [DOWN, UP] });
    const app = await launchCopilotApp(CONFIG, host.ports, TIMING);
    host.exit(0);
    await Promise.resolve();
    await app.stop();
    expect(host.calls.some((call) => call.startsWith("kill"))).toBe(false);
  });

  it("refuses to start when the app already runs", async () => {
    const host = fakeHost({ running: true, probes: [] });
    await expect(launchCopilotApp(CONFIG, host.ports, TIMING)).rejects.toThrow(
      /github\.exe is already running/
    );
    expect(host.calls).toEqual([]);
  });

  it("refuses to start when another process owns the port", async () => {
    const host = fakeHost({ probes: [UP] });
    await expect(launchCopilotApp(CONFIG, host.ports, TIMING)).rejects.toThrow(
      /Another process \(Edg\/140\.0\) already answers/
    );
    expect(host.calls.some((call) => call.startsWith("spawn"))).toBe(false);
  });

  it("kills the app and reports the last reason at the deadline", async () => {
    const host = fakeHost({ probes: [DOWN, DOWN, DOWN, DOWN] });
    await expect(launchCopilotApp(CONFIG, host.ports, TIMING)).rejects.toThrow(
      "The Copilot app CDP endpoint did not answer within 1000 ms: connection refused"
    );
    expect(host.calls.at(-1)).toBe("kill 42");
    expect(host.calls.filter((call) => call === "wait 500")).toHaveLength(2);
  });

  it("fails fast when the app exits before CDP answers", async () => {
    const host = fakeHost({ probes: [DOWN, DOWN] });
    host.ports.wait = async () => {
      host.exit(3);
      await Promise.resolve();
    };
    await expect(launchCopilotApp(CONFIG, host.ports, TIMING)).rejects.toThrow(
      "The Copilot app exited with code 3 before http://127.0.0.1:9222 answered."
    );
    expect(host.calls.some((call) => call.startsWith("kill"))).toBe(false);
  });

  it("propagates a failure to stop the app", async () => {
    const host = fakeHost({ probes: [DOWN, UP], killFails: true });
    const app = await launchCopilotApp(CONFIG, host.ports, TIMING);
    await expect(app.stop()).rejects.toThrow("taskkill failed");
  });
});
