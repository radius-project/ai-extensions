import { initializeDeployResultPage } from "../pages/deploy-result-page.js";
import { runBrowserEntry } from "../registry.js";
import type { BrowserTeardown } from "../lifecycle.js";

export function installDeployResultPageEntry(scope: unknown): BrowserTeardown {
  return runBrowserEntry(scope, (context) =>
    initializeDeployResultPage(context)
  );
}
