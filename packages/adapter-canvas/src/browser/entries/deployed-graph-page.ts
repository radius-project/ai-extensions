import { runBrowserEntry } from "../registry.js";
import { initializeDeployedGraphPage } from "../pages/deployed-graph-page.js";
import type { BrowserTeardown } from "../lifecycle.js";

export function installDeployedGraphPageEntry(scope: unknown): BrowserTeardown {
  return runBrowserEntry(scope, (context, globalScope) =>
    initializeDeployedGraphPage(context, globalScope)
  );
}
