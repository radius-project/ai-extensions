import { runBrowserEntry } from "../registry.js";
import { initializeGraphDiffPage } from "../pages/graph-diff-page.js";
import type { BrowserTeardown } from "../lifecycle.js";

export function installGraphDiffPageEntry(scope: unknown): BrowserTeardown {
  return runBrowserEntry(scope, (context, globalScope) =>
    initializeGraphDiffPage(context, globalScope)
  );
}
