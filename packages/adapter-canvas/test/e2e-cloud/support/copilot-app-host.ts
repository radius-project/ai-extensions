// Launches and stops the GitHub Copilot desktop app for the cloud e2e suite.
// The pure parts (path, environment, process-list parsing, and the launch
// state machine) are unit-tested; the Node ports at the bottom are the only
// code that touches real processes.

import { spawn as spawnProcess, execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import {
  cdpUrlForPort,
  probeCdpEndpoint,
  type CdpProbeResult
} from "./copilot-app-cdp.js";

export const COPILOT_APP_IMAGE_NAME = "github.exe";

/** The per-user install path that the winget and web installers use. */
export function resolveCopilotAppExecutable(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string {
  if (platform !== "win32")
    throw new Error(
      "The Copilot app cloud e2e suite runs only on Windows: the app uses " +
        `WebView2 there, and only WebView2 exposes CDP. Platform: ${platform}.`
    );
  const localAppData = env.LOCALAPPDATA?.trim();
  if (!localAppData)
    throw new Error(
      "LOCALAPPDATA is not set, so the Copilot app path is unknown."
    );
  return path.win32.join(
    localAppData,
    "Programs",
    "GitHub Copilot",
    COPILOT_APP_IMAGE_NAME
  );
}

export interface CopilotAppEnvironmentOptions {
  readonly cdpPort: number;
  /** Isolated Copilot home, so the run never reads the runner's own state. */
  readonly copilotHome: string;
  /** Isolated gh config, so the app's bundled gh uses only the env token. */
  readonly ghConfigDir: string;
  /** Token of the account that signs in to the app and runs the agent. */
  readonly signInToken: string;
  readonly packagesToken: string;
  readonly packagesUser: string;
}

const STRIPPED_VARIABLES = [
  "CLOUD_E2E_BOT_PRIVATE_KEY",
  "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"
];

/**
 * The environment for the app process only. The test runner keeps its own
 * environment; the app never sees the GitHub App private key.
 */
export function buildCopilotAppEnvironment(
  base: NodeJS.ProcessEnv,
  options: CopilotAppEnvironmentOptions
): NodeJS.ProcessEnv {
  const cdpUrl = cdpUrlForPort(options.cdpPort);
  const required: Record<string, string> = {
    copilotHome: options.copilotHome,
    ghConfigDir: options.ghConfigDir,
    signInToken: options.signInToken,
    packagesToken: options.packagesToken,
    packagesUser: options.packagesUser
  };
  for (const [name, value] of Object.entries(required))
    if (!value.trim())
      throw new Error(`The Copilot app option ${name} must not be empty.`);
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of STRIPPED_VARIABLES) delete env[name];
  return {
    ...env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${new URL(cdpUrl).port}`,
    COPILOT_HOME: options.copilotHome,
    GH_CONFIG_DIR: options.ghConfigDir,
    COPILOT_GITHUB_TOKEN: options.signInToken,
    GH_TOKEN: options.signInToken,
    GITHUB_TOKEN: options.signInToken,
    GH_PACKAGES_TOKEN: options.packagesToken,
    GH_PACKAGES_USER: options.packagesUser
  };
}

/** True when `tasklist /FO CSV /NH` output lists the image name. */
export function tasklistHasImage(output: string, image: string): boolean {
  const wanted = image.toLowerCase();
  return output
    .split(/\r?\n/)
    .some(
      (line) => /^"([^"]*)"/.exec(line.trim())?.[1]?.toLowerCase() === wanted
    );
}

export interface SpawnedApp {
  readonly pid: number;
  /** Resolves with the exit code once the process ends. */
  readonly exited: Promise<number | null>;
}

export interface CopilotAppHostPorts {
  isAppRunning(): Promise<boolean>;
  spawn(executable: string, env: NodeJS.ProcessEnv): SpawnedApp;
  probe(cdpUrl: string): Promise<CdpProbeResult>;
  kill(pid: number): Promise<void>;
  now(): number;
  wait(milliseconds: number): Promise<void>;
}

export interface CopilotAppLaunchConfig {
  readonly executable: string;
  readonly cdpPort: number;
  readonly env: NodeJS.ProcessEnv;
}

export interface LaunchedCopilotApp {
  readonly cdpUrl: string;
  readonly browser: string;
  /** Ends the app and its WebView2 children. Safe to call more than once. */
  stop(): Promise<void>;
}

export interface LaunchTiming {
  readonly timeoutMs: number;
  readonly intervalMs: number;
}

/**
 * Starts the app and waits for its CDP endpoint. It refuses to start when the
 * app already runs, because a second start only focuses the first window and
 * the new environment would never apply. It also refuses when another process
 * already answers on the CDP port.
 */
export async function launchCopilotApp(
  config: CopilotAppLaunchConfig,
  ports: CopilotAppHostPorts,
  timing: LaunchTiming
): Promise<LaunchedCopilotApp> {
  const cdpUrl = cdpUrlForPort(config.cdpPort);
  if (await ports.isAppRunning())
    throw new Error(
      `${COPILOT_APP_IMAGE_NAME} is already running. Quit the Copilot app ` +
        "fully before the suite starts it with a debugging port."
    );
  const existing = await ports.probe(cdpUrl);
  if (existing.ok)
    throw new Error(
      `Another process (${existing.browser}) already answers on ${cdpUrl}. ` +
        "Free the port before the suite starts the Copilot app."
    );

  const app = ports.spawn(config.executable, config.env);
  let exitCode: number | null | undefined;
  void app.exited.then((code) => {
    exitCode = code;
  });
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (exitCode === undefined) await ports.kill(app.pid);
  };

  const deadline = ports.now() + timing.timeoutMs;
  let lastReason: string;
  try {
    for (;;) {
      if (exitCode !== undefined)
        throw new Error(
          `The Copilot app exited with code ${String(exitCode)} before ` +
            `${cdpUrl} answered.`
        );
      const result = await ports.probe(cdpUrl);
      if (result.ok) return { cdpUrl, browser: result.browser, stop };
      lastReason = result.reason;
      if (ports.now() >= deadline)
        throw new Error(
          `The Copilot app CDP endpoint did not answer within ` +
            `${timing.timeoutMs} ms: ${lastReason}`
        );
      await ports.wait(timing.intervalMs);
    }
  } catch (error) {
    await stop();
    throw error;
  }
}

const execFileAsync = promisify(execFile);

export function createNodeCopilotAppHostPorts(): CopilotAppHostPorts {
  return {
    async isAppRunning() {
      const { stdout } = await execFileAsync("tasklist", [
        "/FI",
        `IMAGENAME eq ${COPILOT_APP_IMAGE_NAME}`,
        "/FO",
        "CSV",
        "/NH"
      ]);
      return tasklistHasImage(stdout, COPILOT_APP_IMAGE_NAME);
    },
    spawn(executable, env) {
      const child = spawnProcess(executable, [], {
        env,
        stdio: "ignore",
        windowsHide: false
      });
      if (child.pid === undefined)
        throw new Error(`Could not start ${executable}.`);
      const exited = new Promise<number | null>((resolve) => {
        child.once("exit", (code) => resolve(code));
        child.once("error", () => resolve(null));
      });
      return { pid: child.pid, exited };
    },
    probe: (cdpUrl) => probeCdpEndpoint(cdpUrl, fetch, 2_000),
    async kill(pid) {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]);
    },
    now: () => Date.now(),
    wait: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds))
  };
}
