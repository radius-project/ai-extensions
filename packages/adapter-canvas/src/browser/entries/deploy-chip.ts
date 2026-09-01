import { initializeDeployChip } from "../deploy-chip.js";
import { runBrowserEntry } from "../registry.js";
import type { BrowserTeardown } from "../lifecycle.js";

export function installDeployChipEntry(scope: unknown): BrowserTeardown {
  return runBrowserEntry(
    scope,
    (context) => initializeDeployChip(context),
    "document"
  );
}
