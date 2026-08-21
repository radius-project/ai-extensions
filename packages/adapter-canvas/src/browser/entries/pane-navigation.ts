import {
  createPaneNavigation,
  initializePaneNavigation
} from "../pane-navigation.js";
import { resolvePageRegistry, runBrowserEntry } from "../registry.js";
import type { BrowserTeardown } from "../lifecycle.js";

export function installPaneNavigationEntry(scope: unknown): BrowserTeardown {
  return runBrowserEntry(
    scope,
    (context) =>
      initializePaneNavigation(
        context,
        createPaneNavigation(context, resolvePageRegistry(scope))
      ),
    "document"
  );
}
