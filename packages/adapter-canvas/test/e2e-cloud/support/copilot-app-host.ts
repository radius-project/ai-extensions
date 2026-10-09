// Launches and stops the GitHub Copilot desktop app for the cloud e2e suite.
// The pure parts (path, environment, process-list parsing, and the launch
// state machine) are unit-tested; the Node ports at the bottom are the only
// code that touches real processes.

import { spawn as spawnProcess, execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { redactCredentials } from "../../../src/credential-redaction.js";
import type { runCommand } from "../../../src/gh.js";
import {
  cdpUrlForPort,
  probeCdpEndpoint,
  type CdpProbeResult
} from "./copilot-app-cdp.js";

export const COPILOT_APP_IMAGE_NAME = "github.exe";

export function assertCopilotAppRunner(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): void {
  if (
    platform !== "win32" ||
    env.GITHUB_ACTIONS !== "true" ||
    env.RUNNER_ENVIRONMENT !== "github-hosted"
  )
    throw new Error(
      "The Copilot app cloud host requires a disposable GitHub-hosted Windows " +
        "runner. Local and self-hosted runs are refused before cloud setup: " +
        "desktop profile isolation is not qualified there. Use the harness locally."
    );
}

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
  readonly profileDir: string;
  /** The disposable runner's existing azure/login session, deliberately shared. */
  readonly azureConfigDir: string;
  /** Token of the account that signs in to the app and runs the agent. */
  readonly signInToken: string;
  readonly packagesToken: string;
  readonly packagesUser: string;
}

const STRIPPED_VARIABLES = [
  "CLOUD_E2E_BOT_PRIVATE_KEY",
  "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
  "COPILOT_AGENT_SESSION_ID",
  "SESSION_ID"
];

export function copilotAppProfilePaths(profileDir: string) {
  if (!/^[a-z]:[\\/]/i.test(profileDir))
    throw new Error("The Copilot app profile must use an absolute drive path.");
  const copilotHome = path.win32.join(profileDir, ".copilot");
  return {
    copilotHome,
    ghConfigDir: path.win32.join(profileDir, "gh-config"),
    appData: path.win32.join(profileDir, "AppData", "Roaming"),
    localAppData: path.win32.join(profileDir, "AppData", "Local"),
    webViewData: path.win32.join(profileDir, "webview2"),
    temp: path.win32.join(profileDir, "temp"),
    radiusState: path.win32.join(copilotHome, "radius")
  };
}

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
    profileDir: options.profileDir,
    azureConfigDir: options.azureConfigDir,
    signInToken: options.signInToken,
    packagesToken: options.packagesToken,
    packagesUser: options.packagesUser
  };
  for (const [name, value] of Object.entries(required))
    if (!value.trim())
      throw new Error(`The Copilot app option ${name} must not be empty.`);
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(base).map(([key, value]) => [key.toUpperCase(), value])
  );
  for (const name of STRIPPED_VARIABLES) delete env[name];
  const paths = copilotAppProfilePaths(options.profileDir);
  return {
    ...env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${new URL(cdpUrl).port}`,
    WEBVIEW2_USER_DATA_FOLDER: paths.webViewData,
    USERPROFILE: options.profileDir,
    HOME: options.profileDir,
    HOMEDRIVE: path.win32.parse(options.profileDir).root.slice(0, 2),
    HOMEPATH: options.profileDir.slice(2),
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData,
    TEMP: paths.temp,
    TMP: paths.temp,
    COPILOT_HOME: paths.copilotHome,
    GH_CONFIG_DIR: paths.ghConfigDir,
    AZURE_CONFIG_DIR: options.azureConfigDir,
    RADIUS_CREDENTIALS_FILE: path.win32.join(
      paths.radiusState,
      "credentials.json"
    ),
    COPILOT_GITHUB_TOKEN: options.signInToken,
    GH_TOKEN: options.signInToken,
    GITHUB_TOKEN: options.signInToken,
    GH_PACKAGES_TOKEN: options.packagesToken,
    GH_PACKAGES_USER: options.packagesUser
  };
}

export async function prepareCopilotAppGhAuth(
  appEnv: NodeJS.ProcessEnv,
  run: typeof runCommand
): Promise<void> {
  const token = appEnv.GH_TOKEN?.trim();
  const expectedLogin = appEnv.GH_PACKAGES_USER?.trim();
  if (!token || !expectedLogin || !appEnv.GH_CONFIG_DIR?.trim())
    throw new Error(
      "Copilot app sign-in requires a token, an expected account, and an isolated GH_CONFIG_DIR."
    );
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(appEnv).map(([key, value]) => [key.toUpperCase(), value])
  );
  // gh refuses stored login when a token override is present. Verification
  // must also use stored credentials, not accidentally prove the override.
  for (const name of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "COPILOT_GITHUB_TOKEN",
    "GH_PACKAGES_TOKEN",
    "GH_HOST",
    "GH_DEBUG"
  ])
    delete env[name];
  env.GH_PROMPT_DISABLED = "1";
  const options = {
    env,
    preserveGitHubToken: true,
    timeout: 60_000,
    stdin: ""
  };
  try {
    await run(
      "gh",
      [
        "auth",
        "login",
        "--hostname",
        "github.com",
        "--git-protocol",
        "https",
        "--with-token"
      ],
      { ...options, stdin: `${token}\n` }
    );
    await run(
      "gh",
      ["auth", "status", "--active", "--hostname", "github.com"],
      options
    );
    const login = await run(
      "gh",
      ["api", "user", "--hostname", "github.com", "--jq", ".login"],
      options
    );
    if (login.trim().toLowerCase() !== expectedLogin.toLowerCase())
      throw new Error(
        `Stored GitHub CLI account is ${login.trim() || "<empty>"}; expected ${expectedLogin}.`
      );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cause = new Error(redactCredentials(message, [token]));
    throw new Error(
      `Copilot app GitHub CLI sign-in failed: ${cause.message}`,
      // eslint-disable-next-line preserve-caught-error -- The raw cause can contain the PAT.
      { cause }
    );
  }
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
  spawn(executable: string, env: NodeJS.ProcessEnv): Promise<SpawnedApp>;
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

export async function cleanupCopilotApp(
  disconnect: () => Promise<void>,
  stop: () => Promise<void>,
  removeProfile: () => Promise<void>
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await disconnect();
  } catch (error) {
    errors.push(error);
  }
  try {
    await stop();
    await removeProfile();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0)
    throw new AggregateError(
      errors,
      `Copilot app cleanup failed: ${errors
        .map((error) =>
          error instanceof Error ? error.message : String(error)
        )
        .join("; ")}`
    );
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

  const app = await ports.spawn(config.executable, config.env);
  let exitCode: number | null | undefined;
  void app.exited.then((code) => {
    exitCode = code;
  });
  let stopped = false;
  let stopping: Promise<void> | undefined;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    if (stopping) return stopping;
    stopping = (async () => {
      if (exitCode === undefined) await ports.kill(app.pid);
      stopped = true;
    })();
    try {
      await stopping;
    } finally {
      stopping = undefined;
    }
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
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "App launch and cleanup failed.",
        { cause: cleanupError }
      );
    }
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
      return new Promise<SpawnedApp>((resolve, reject) => {
        const child = spawnProcess(executable, [], {
          env,
          stdio: "ignore",
          windowsHide: false
        });
        const exited = new Promise<number | null>((resolveExit) => {
          child.once("error", (error) => {
            resolveExit(null);
            reject(error);
          });
          child.once("exit", (code) => resolveExit(code));
        });
        child.once("spawn", () => {
          if (child.pid === undefined) {
            reject(new Error(`Could not start ${executable}: no process id.`));
            return;
          }
          resolve({ pid: child.pid, exited });
        });
      });
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
