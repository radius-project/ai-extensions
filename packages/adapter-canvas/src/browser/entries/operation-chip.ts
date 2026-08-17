import { initializeOperationChip } from "../operation-chip.js";
import { runBrowserEntry } from "../registry.js";
import type { BrowserTeardown } from "../lifecycle.js";

export function installOperationChipEntry(scope: unknown): BrowserTeardown {
  return runBrowserEntry(
    scope,
    (context) => initializeOperationChip(context),
    "document"
  );
}
