import {
  test as base,
  chromium,
  type Browser,
  type Page
} from "@playwright/test";
import { probeCdpEndpoint, resolveCdpUrl, selectMainPage } from "./cdp.ts";

export { expect } from "@playwright/test";

type AppFixtures = {
  cdpUrl: string;
  appBrowser: Browser;
  appPage: Page;
};

const PROBE_TIMEOUT_MS = 3_000;
const CONNECT_TIMEOUT_MS = 15_000;

export const test = base.extend<AppFixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured first argument.
  cdpUrl: async ({}, use) => {
    await use(resolveCdpUrl(process.env.COPILOT_APP_CDP_URL));
  },

  appBrowser: async ({ cdpUrl }, use, testInfo) => {
    const probe = await probeCdpEndpoint(cdpUrl, fetch, PROBE_TIMEOUT_MS);
    if (!probe.ok) {
      testInfo.skip(
        true,
        `Copilot app CDP endpoint is not reachable (${probe.reason}). ` +
          "Quit the app fully, run scripts/launch-app.ps1, then run the tests again."
      );
      return;
    }
    const browser = await chromium.connectOverCDP(cdpUrl, {
      timeout: CONNECT_TIMEOUT_MS
    });
    try {
      await use(browser);
    } finally {
      // For a CDP-attached browser, close() only drops the connection. The
      // Copilot app keeps running.
      await browser.close();
    }
  },

  appPage: async ({ appBrowser }, use, testInfo) => {
    const pages = appBrowser.contexts().flatMap((context) => context.pages());
    const page = selectMainPage(pages);
    await use(page);
    // Playwright only captures failure screenshots for pages it creates, so
    // capture the attached app page here.
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach("failure-screenshot", {
        body: await page.screenshot(),
        contentType: "image/png"
      });
    }
  }
});
