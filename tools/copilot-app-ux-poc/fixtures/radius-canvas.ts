import {
  chromium,
  expect,
  type Browser,
  type Frame,
  type Locator,
  type Page
} from "@playwright/test";
import { test as appTest } from "./app.ts";
import {
  canvasCdpUrls,
  findRadiusCanvasTarget,
  probeCdpEndpoint
} from "./cdp.ts";

export { expect } from "@playwright/test";

export type CanvasTarget = Page | Frame;

export interface RadiusCanvas {
  /** The "Radius" tab in the right panel of the selected session. */
  tab: Locator;
  /** The Radius canvas page, read over CDP. */
  target: CanvasTarget;
  /** True when the fixture opened the tab and closes it at teardown. */
  openedByTest: boolean;
}

export interface AttachedRadiusCanvas extends RadiusCanvas {
  /** Disconnects from the canvas and closes the tab if it was opened here. */
  dispose(onWarning: (message: string) => void): Promise<void>;
}

const CANVAS_WAIT_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_000;

function tabBar(appPage: Page): Locator {
  return appPage.getByTestId("tab-shell-tab-bar");
}

function radiusTab(appPage: Page): Locator {
  return tabBar(appPage).getByRole("tab", { name: "Radius", exact: true });
}

/** True when the selected session shows the panel that holds canvas tabs. */
export async function isSessionPanelVisible(appPage: Page): Promise<boolean> {
  return appPage.getByTestId("tab-shell-tab-actions").isVisible();
}

/** Selects the Radius tab, or opens it with Add tab > Canvas > Radius. */
async function openRadiusTab(appPage: Page): Promise<boolean> {
  const tab = radiusTab(appPage);
  if ((await tab.count()) > 0) {
    await tab.click();
    return false;
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
  return true;
}

function pagesOf(browsers: readonly Browser[], exclude: Page): Page[] {
  return browsers
    .flatMap((browser) => browser.contexts())
    .flatMap((context) => context.pages())
    .filter((page) => page !== exclude);
}

async function closeRadiusTab(appPage: Page): Promise<void> {
  await tabBar(appPage)
    .getByRole("button", { name: "Close Radius", exact: true })
    .click({ timeout: 5_000 });
}

/**
 * Opens or selects the Radius canvas in the selected session and finds its
 * page over CDP. The caller must call `dispose`.
 */
export async function attachRadiusCanvas(
  appBrowser: Browser,
  appPage: Page,
  cdpUrl: string
): Promise<AttachedRadiusCanvas> {
  const openedByTest = await openRadiusTab(appPage);
  // A canvas runs in its own WebView2 browser process. That process opens the
  // CDP port on the other loopback address, so connect to it when it starts.
  const pendingUrls = canvasCdpUrls(
    cdpUrl,
    process.env.COPILOT_APP_CANVAS_CDP_URL
  );
  const searchedUrls = [cdpUrl, ...pendingUrls].join(", ");
  const canvasBrowsers: Browser[] = [];
  let disposed = false;
  const dispose = async (onWarning: (message: string) => void) => {
    if (disposed) return;
    disposed = true;
    await Promise.allSettled(canvasBrowsers.map((browser) => browser.close()));
    if (openedByTest) {
      try {
        await closeRadiusTab(appPage);
      } catch (error) {
        onWarning(
          `Could not close the Radius tab: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  };

  const found: { target?: CanvasTarget } = {};
  try {
    await expect
      .poll(
        async () => {
          for (const url of [...pendingUrls]) {
            const probe = await probeCdpEndpoint(url, fetch, PROBE_TIMEOUT_MS);
            if (probe.ok) {
              canvasBrowsers.push(
                await chromium.connectOverCDP(url, { timeout: 15_000 })
              );
              pendingUrls.splice(pendingUrls.indexOf(url), 1);
            }
          }
          found.target = await findRadiusCanvasTarget([
            ...appPage.frames(),
            ...pagesOf([appBrowser, ...canvasBrowsers], appPage)
          ]);
          return found.target !== undefined;
        },
        {
          message: `Radius canvas page not found over CDP (searched ${searchedUrls})`,
          timeout: CANVAS_WAIT_MS
        }
      )
      .toBe(true);
    if (!found.target) {
      throw new Error("Radius canvas target was lost after it was found");
    }
  } catch (error) {
    await dispose(() => undefined);
    throw error;
  }
  return {
    tab: radiusTab(appPage),
    target: found.target,
    openedByTest,
    dispose
  };
}

export const test = appTest.extend<{ radiusCanvas: RadiusCanvas }>({
  radiusCanvas: [
    async ({ appBrowser, appPage, cdpUrl }, use, testInfo) => {
      if (!(await isSessionPanelVisible(appPage))) {
        testInfo.skip(
          true,
          "The session panel is not visible. Select a session in the app, then run the test again."
        );
        return;
      }
      const canvas = await attachRadiusCanvas(appBrowser, appPage, cdpUrl);
      try {
        await use(canvas);
      } finally {
        await canvas.dispose((description) =>
          testInfo.annotations.push({ type: "cleanup-warning", description })
        );
      }
    },
    { timeout: CANVAS_WAIT_MS + 30_000 }
  ]
});
