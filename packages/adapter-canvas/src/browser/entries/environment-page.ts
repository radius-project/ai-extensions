import { initializeEnvironmentPage } from "../environment/page.js";
import { runBrowserEntry } from "../registry.js";
import type { BrowserTeardown } from "../lifecycle.js";

export function installEnvironmentPageEntry(scope: unknown): BrowserTeardown {
  return runBrowserEntry(scope, (context) =>
    initializeEnvironmentPage(context)
  );
}
