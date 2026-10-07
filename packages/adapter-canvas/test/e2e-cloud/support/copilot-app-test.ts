// The Playwright worker fixture that starts the real GitHub Copilot desktop
// app for the cloud journey. It installs the Radius extension that this
// checkout builds into an isolated Copilot home, starts the app with a CDP
// port, and attaches Playwright to the app window. Teardown stops the app and
// removes the isolated folders.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test as base, type Browser, type Page } from "@playwright/test";

import { COPILOT_APP_SETUP_TIMEOUT_MS } from "./cloud-timeout-budget.js";
import {
  COPILOT_APP_DEFAULT_CDP_PORT,
  selectMainPage
} from "./copilot-app-cdp.js";
import {
  buildCopilotAppEnvironment,
  createNodeCopilotAppHostPorts,
  launchCopilotApp,
  resolveCopilotAppExecutable
} from "./copilot-app-host.js";
import { attachAppState, waitForSignedInShell } from "./copilot-app-ui.js";

export interface CopilotAppSession {
  readonly browser: Browser;
  readonly appPage: Page;
  readonly cdpUrl: string;
}

const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));
const execFileAsync = promisify(execFile);
const APP_LAUNCH_TIMEOUT_MS = 3 * 60 * 1000;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required to start the Copilot app.`);
  return value;
}

export const test = base.extend<object, { copilotApp: CopilotAppSession }>({
  copilotApp: [
    // `playwright` is requested so the first argument is a real destructuring
    // pattern, as Playwright requires; it also supplies `connectOverCDP`.
    async ({ playwright }, use, workerInfo) => {
      const executable = resolveCopilotAppExecutable(
        process.env,
        process.platform
      );
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "radius-copilot-app-")
      );
      const copilotHome = path.join(root, "copilot-home");
      const ghConfigDir = path.join(root, "gh-config");
      let stopApp: (() => Promise<void>) | undefined;
      let browser: Browser | undefined;
      try {
        await fs.mkdir(ghConfigDir, { recursive: true });
        await execFileAsync(process.execPath, ["build.mjs", "--install"], {
          cwd: packageRoot,
          env: {
            ...process.env,
            RADIUS_CANVAS_INSTALL_PATH: path.join(
              copilotHome,
              "extensions",
              "radius",
              "extension.mjs"
            )
          },
          maxBuffer: 32 * 1024 * 1024
        });
        // The bot PAT signs in to the app. The GitHub App installation token
        // expires after one hour and the app cannot receive a refreshed one.
        const packagesToken = requireEnv("GH_PACKAGES_TOKEN");
        const app = await launchCopilotApp(
          {
            executable,
            cdpPort: COPILOT_APP_DEFAULT_CDP_PORT,
            env: buildCopilotAppEnvironment(process.env, {
              cdpPort: COPILOT_APP_DEFAULT_CDP_PORT,
              copilotHome,
              ghConfigDir,
              signInToken: packagesToken,
              packagesToken,
              packagesUser: requireEnv("GH_PACKAGES_USER")
            })
          },
          createNodeCopilotAppHostPorts(),
          { timeoutMs: APP_LAUNCH_TIMEOUT_MS, intervalMs: 1_000 }
        );
        stopApp = app.stop;
        browser = await playwright.chromium.connectOverCDP(app.cdpUrl, {
          timeout: 30_000
        });
        const appPage = selectMainPage(
          browser.contexts().flatMap((context) => context.pages())
        );
        try {
          await waitForSignedInShell(appPage);
        } catch (error) {
          const outputDir = workerInfo.project.outputDir;
          await fs.mkdir(outputDir, { recursive: true });
          await attachAppState(appPage, "copilot-app-sign-in", (name, body) =>
            fs.writeFile(path.join(outputDir, name), body)
          );
          throw error;
        }
        await use({ browser, appPage, cdpUrl: app.cdpUrl });
      } finally {
        try {
          await browser?.close();
        } finally {
          try {
            await stopApp?.();
          } finally {
            await fs.rm(root, { recursive: true, force: true });
          }
        }
      }
    },
    { scope: "worker", timeout: COPILOT_APP_SETUP_TIMEOUT_MS }
  ]
});

export { expect } from "@playwright/test";
