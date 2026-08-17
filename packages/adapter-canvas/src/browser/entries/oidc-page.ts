import { initializeOidcPage } from "../oidc.js";
import { runBrowserEntry } from "../registry.js";
import type { BrowserTeardown } from "../lifecycle.js";

export function installOidcPageEntry(scope: unknown): BrowserTeardown {
  return runBrowserEntry(scope, (context) => initializeOidcPage(context));
}
