import { runBrowserEntry } from "../registry.js";
import { initializePlannedGraphPage } from "../pages/planned-graph-page.js";
import type { BrowserTeardown } from "../lifecycle.js";

export function installPlannedGraphPageEntry(scope: unknown): BrowserTeardown {
  return runBrowserEntry(scope, (context, globalScope) =>
    initializePlannedGraphPage(context, globalScope)
  );
}
