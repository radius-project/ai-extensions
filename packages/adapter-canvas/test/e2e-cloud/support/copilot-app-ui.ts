// Playwright glue that drives the GitHub Copilot desktop app UI. The app has
// no test API, so these helpers use the accessible roles and names that the
// app shows. They need the real app, so the pure rules they rely on live in
// copilot-app-cdp.ts and copilot-app-modeling.ts, where they are unit-tested.

import {
  chromium,
  expect,
  type Browser,
  type Frame,
  type Locator,
  type Page,
  type TestInfo
} from "@playwright/test";

import {
  canvasCdpUrls,
  canvasPageUrl,
  findRadiusCanvasTarget,
  probeCdpEndpoint
} from "./copilot-app-cdp.js";
import {
  parseSessionInfo,
  parseSessionStatus,
  sessionIdFromAppUrl,
  sessionTitleFromInfoLabel,
  type SessionInfo
} from "./copilot-app-modeling.js";

export type CanvasTarget = Page | Frame;

const SHELL_TIMEOUT_MS = 120_000;
const PROJECT_CLONE_TIMEOUT_MS = 300_000;
const SESSION_START_TIMEOUT_MS = 120_000;
const CANVAS_WAIT_MS = 60_000;
const PROBE_TIMEOUT_MS = 2_000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function projectsRegion(appPage: Page): Locator {
  return appPage.getByRole("region", { name: "Projects" });
}

export type AppStateSink = (
  fileName: string,
  body: Buffer | string
) => Promise<void>;

export async function captureAppState(
  source: {
    screenshot(): Promise<Buffer>;
    ariaSnapshot(): Promise<string>;
  },
  name: string,
  sink: AppStateSink,
  onWarning: (message: string) => void
): Promise<void> {
  const results = await Promise.allSettled([
    source.screenshot().then((body) => sink(`${name}.png`, body)),
    source.ariaSnapshot().then((body) => sink(`${name}.aria.yml`, body))
  ]);
  for (const [index, result] of results.entries())
    if (result.status === "rejected")
      onWarning(
        `Could not capture ${name} ${index === 0 ? "screenshot" : "accessibility tree"}: ${describeError(result.reason)}`
      );
}

/** Saves a screenshot and the accessibility tree for diagnosis. */
export async function attachAppState(
  appPage: Page,
  name: string,
  sink: AppStateSink
): Promise<void> {
  await captureAppState(
    {
      screenshot: () => appPage.screenshot(),
      ariaSnapshot: () => appPage.locator("body").ariaSnapshot()
    },
    name,
    sink,
    (message) => console.warn(message)
  );
}

/** A sink that attaches the files to the current test report. */
export function testInfoSink(testInfo: TestInfo): AppStateSink {
  return async (fileName, body) => {
    await testInfo.attach(fileName, { body });
  };
}

/**
 * Waits for the signed-in app shell. When the env token did not sign the app
 * in, the shell never shows, and the error says so instead of a later locator
 * timeout.
 */
export async function waitForSignedInShell(
  appPage: Page,
  onDeviceCode?: (code: string) => void
): Promise<void> {
  try {
    const ready = appPage
      .getByRole("navigation", { name: "Quick links" })
      .getByRole("button", { name: "New", exact: true });
    const signIn = appPage.getByRole("button", {
      name: /^Sign in to GitHub(?:,|$)/
    });
    const deviceCode = appPage.getByRole("button", {
      name: /^[A-Z0-9]{4}-[A-Z0-9]{4}\. Copy device code to clipboard$/
    });
    const repositories = appPage.getByRole("heading", {
      name: /^Connect your repositories/
    });
    await expect(
      ready.or(signIn).or(deviceCode).or(repositories).first()
    ).toBeVisible({
      timeout: SHELL_TIMEOUT_MS
    });
    if (!(await ready.isVisible()) && (await signIn.isVisible()))
      await signIn.click();
    await expect(ready.or(deviceCode).or(repositories).first()).toBeVisible({
      timeout: SHELL_TIMEOUT_MS
    });
    if (await deviceCode.isVisible()) {
      if (!onDeviceCode)
        throw new Error(
          "The Copilot app requires device authorization. Dispatch with manual-app-sign-in enabled and authorize the bot account."
        );
      const snapshot = await deviceCode.ariaSnapshot();
      const code = snapshot.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0];
      if (!code) throw new Error("The app did not expose its device code.");
      onDeviceCode(code);
      await expect(ready.or(repositories).first()).toBeVisible({
        timeout: 10 * 60_000
      });
    }
    if (await repositories.isVisible())
      await appPage
        .getByRole("button", { name: "Continue", exact: true })
        .click();
    await expect(ready).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(
      projectsRegion(appPage).getByRole("button", {
        name: "New project or session"
      })
    ).toBeVisible();
  } catch (error) {
    throw new Error(
      "The Copilot app did not show the signed-in shell. Check that the " +
        "sign-in token is valid and that the account has a Copilot seat. " +
        `Cause: ${describeError(error)}`,
      { cause: error }
    );
  }
}

function newSessionButton(appPage: Page, projectName: string): Locator {
  return projectsRegion(appPage).getByRole("button", {
    name: `New session in ${projectName}`,
    exact: true
  });
}

/**
 * Adds the fixture repository as an app project when it is not one yet. The
 * app clones it into its own folder, so the session worktree starts from the
 * remote default branch.
 */
export async function ensureFixtureProject(
  appPage: Page,
  repository: string,
  projectName: string
): Promise<void> {
  const ready = newSessionButton(appPage, projectName);
  if ((await ready.count()) > 0) return;

  await projectsRegion(appPage)
    .getByRole("button", { name: "New project or session" })
    .click();
  const addProject = appPage
    .getByRole("menuitem", { name: /project/i })
    .or(appPage.getByRole("button", { name: /^(add|new|clone).*project/i }));
  await addProject.first().click();

  const dialog = appPage.getByRole("dialog").last();
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("combobox")
    .or(dialog.getByRole("textbox"))
    .or(dialog.getByRole("searchbox"))
    .first()
    .fill(repository);
  const option = dialog
    .getByRole("option", { name: new RegExp(escapeRegExp(repository), "i") })
    .or(
      dialog.getByRole("button", {
        name: new RegExp(`^${escapeRegExp(repository)}$`, "i")
      })
    );
  await expect(
    option.first(),
    `No project search result for ${repository}`
  ).toBeVisible({ timeout: 30_000 });
  await option.first().click();
  const confirm = dialog.getByRole("button", {
    name: /^(clone|add|create|open)\b/i
  });
  if ((await confirm.count()) > 0) await confirm.first().click();

  try {
    await expect(ready).toBeVisible({ timeout: PROJECT_CLONE_TIMEOUT_MS });
  } catch (error) {
    throw new Error(
      `The Copilot app did not add ${repository} as project "${projectName}". ` +
        "The project-add UI may have changed. " +
        `Cause: ${describeError(error)}`,
      { cause: error }
    );
  }
}

/**
 * Starts a new session from the New page: selects the project, sets Autopilot
 * mode, and sends the prompt. Returns the new session ID.
 */
export async function startSessionFromNewPage(
  appPage: Page,
  options: { readonly projectName: string; readonly prompt: string }
): Promise<string> {
  await appPage
    .getByRole("navigation", { name: "Quick links" })
    .getByRole("button", { name: "New", exact: true })
    .click();
  const main = appPage.getByRole("main");
  await expect(main.getByRole("heading", { name: "New" })).toBeVisible();

  const project = main.getByRole("combobox", { name: /^Project:/ });
  await project.click();
  const picker = appPage.getByRole("dialog");
  await picker
    .getByRole("combobox", { name: "Search" })
    .fill(options.projectName);
  const option = picker.getByRole("option", {
    name: options.projectName,
    exact: true
  });
  try {
    await expect(option).toBeVisible({ timeout: 30_000 });
  } catch (error) {
    await appPage.keyboard.press("Escape");
    throw new Error(
      `Project "${options.projectName}" is not in the app project picker.`,
      { cause: error }
    );
  }
  await option.click();
  await expect(project).toHaveAccessibleName(
    new RegExp(escapeRegExp(options.projectName))
  );

  const mode = main.getByRole("button", { name: /^Mode:/ });
  await mode.click();
  await appPage.getByRole("menuitemradio", { name: /^Autopilot\b/ }).click();
  if (await appPage.getByRole("menu").isVisible())
    await appPage.keyboard.press("Escape");
  await expect(mode).toHaveAccessibleName(/Autopilot/);

  await main.getByRole("textbox", { name: "Message" }).fill(options.prompt);
  await main.getByRole("button", { name: "Send message" }).click();
  await appPage.waitForURL(
    (url) => sessionIdFromAppUrl(url.href) !== undefined,
    { timeout: SESSION_START_TIMEOUT_MS }
  );
  const sessionId = sessionIdFromAppUrl(appPage.url());
  if (!sessionId)
    throw new Error(`The app did not open a session page: ${appPage.url()}`);
  return sessionId;
}

export async function sendSessionPrompt(
  appPage: Page,
  prompt: string
): Promise<void> {
  const main = appPage.getByRole("main");
  await main.getByRole("textbox", { name: "Message" }).fill(prompt);
  await main.getByRole("button", { name: "Send message" }).click();
}

export async function waitForIdleSession(appPage: Page): Promise<void> {
  await expect
    .poll(() => readCurrentSessionStatus(appPage), {
      message:
        "The Copilot session did not report Idle. Refusing to modify its workspace.",
      timeout: SESSION_START_TIMEOUT_MS
    })
    .toMatch(/^idle$/i);
}

function sessionInfoButton(appPage: Page): Locator {
  return appPage.getByRole("button", { name: /session information$/ }).first();
}

/** Opens the session information dialog, reads it, and closes it. */
export async function readSessionInfo(appPage: Page): Promise<SessionInfo> {
  await sessionInfoButton(appPage).click();
  const dialog = appPage.getByRole("dialog", { name: "Session information" });
  await expect(dialog).toBeVisible();
  const labels = await dialog
    .getByRole("button")
    .evaluateAll((elements) =>
      elements.map(
        (element) =>
          element.getAttribute("aria-label") ?? element.textContent ?? ""
      )
    );
  await appPage.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  return parseSessionInfo(labels);
}

/**
 * Reads the status of the open session from its sidebar entry. Returns
 * `undefined` when the app shows no status for it.
 */
export async function readCurrentSessionStatus(
  appPage: Page
): Promise<string | undefined> {
  const label = await sessionInfoButton(appPage).getAttribute("aria-label");
  if (!label) return undefined;
  const title = sessionTitleFromInfoLabel(label);
  const names = await projectsRegion(appPage)
    .getByRole("tree", { name: "Projects" })
    .locator("[aria-label]")
    .evaluateAll(
      (elements, wanted) =>
        elements
          .map((element) => element.getAttribute("aria-label") ?? "")
          .filter((name) => name.includes(wanted)),
      title
    );
  for (const name of names) {
    const status = parseSessionStatus(name);
    if (status) return status;
  }
  return undefined;
}

export interface AttachedRadiusCanvas {
  /** The Radius canvas page, read over CDP. */
  readonly target: CanvasTarget;
  /** Disconnects from the canvas browser and closes the Radius tab. */
  dispose(onWarning: (message: string) => void): Promise<void>;
}

function tabBar(appPage: Page): Locator {
  return appPage.getByTestId("tab-shell-tab-bar");
}

async function openRadiusTab(appPage: Page): Promise<void> {
  const tab = tabBar(appPage).getByRole("tab", { name: "Radius", exact: true });
  if ((await tab.count()) > 0) {
    await tab.click();
    return;
  }
  await appPage
    .getByTestId("tab-shell-tab-actions")
    .getByRole("button", { name: /^Add tab\b/ })
    .click();
  await appPage.getByRole("menuitem", { name: "Canvas", exact: true }).hover();
  await appPage
    .getByRole("menu", { name: "Canvas" })
    .getByRole("menuitem", { name: "Radius", exact: true })
    .click();
}

function pagesOf(browsers: readonly Browser[], exclude: Page): Page[] {
  return browsers
    .flatMap((browser) => browser.contexts())
    .flatMap((context) => context.pages())
    .filter((page) => page !== exclude);
}

/**
 * Opens or selects the Radius canvas in the open session and finds its page
 * over CDP. A canvas runs in its own WebView2 browser process, which opens the
 * CDP port on the other loopback address family. The caller must dispose it.
 */
export async function attachRadiusCanvas(
  appBrowser: Browser,
  appPage: Page,
  cdpUrl: string
): Promise<AttachedRadiusCanvas> {
  await openRadiusTab(appPage);
  const pendingUrls = canvasCdpUrls(cdpUrl);
  const searched = [cdpUrl, ...pendingUrls].join(", ");
  const canvasBrowsers: Browser[] = [];
  let disposed = false;
  const dispose = async (
    onWarning: (message: string) => void
  ): Promise<void> => {
    if (disposed) return;
    disposed = true;
    const results = await Promise.allSettled(
      canvasBrowsers.map((browser) => browser.close())
    );
    for (const result of results)
      if (result.status === "rejected")
        onWarning(
          `Could not disconnect a canvas browser: ${describeError(result.reason)}`
        );
    try {
      await tabBar(appPage)
        .getByRole("button", { name: "Close Radius", exact: true })
        .click({ timeout: 5_000 });
    } catch (error) {
      onWarning(`Could not close the Radius tab: ${describeError(error)}`);
    }
  };

  const found: { target?: CanvasTarget } = {};
  try {
    await expect
      .poll(
        async () => {
          for (const url of [...pendingUrls]) {
            const probe = await probeCdpEndpoint(url, fetch, PROBE_TIMEOUT_MS);
            if (!probe.ok) continue;
            canvasBrowsers.push(
              await chromium.connectOverCDP(url, { timeout: 15_000 })
            );
            pendingUrls.splice(pendingUrls.indexOf(url), 1);
          }
          found.target = await findRadiusCanvasTarget([
            ...appPage.frames(),
            ...pagesOf([appBrowser, ...canvasBrowsers], appPage)
          ]);
          return found.target !== undefined;
        },
        {
          message: `The Radius canvas page was not found over CDP (searched ${searched})`,
          timeout: CANVAS_WAIT_MS
        }
      )
      .toBe(true);
  } catch (error) {
    await dispose(() => undefined);
    throw error;
  }
  if (!found.target) {
    await dispose(() => undefined);
    throw new Error("The Radius canvas target was lost after it was found.");
  }
  return { target: found.target, dispose };
}

export function pageOf(target: CanvasTarget): Page {
  return "page" in target ? target.page() : target;
}

/** Moves the canvas to one page, such as "graph" or "deploying". */
export async function gotoCanvasPage(
  target: CanvasTarget,
  page: string
): Promise<void> {
  await target.goto(canvasPageUrl(target.url(), page), {
    waitUntil: "domcontentloaded"
  });
}
