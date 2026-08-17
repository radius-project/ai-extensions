import { runBrowserEntry } from "../registry.js";
import { initializeGraphPage } from "../pages/graph-page.js";
import type { BrowserTeardown } from "../lifecycle.js";

export function installGraphPageEntry(scope: unknown): BrowserTeardown {
  return runBrowserEntry(scope, (context, globalScope) =>
    initializeGraphPage(context, globalScope)
  );
}
