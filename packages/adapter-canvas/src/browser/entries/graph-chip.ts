import { initializeGraphChip } from "../graph-chip.js";
import { runBrowserEntry } from "../registry.js";
import type { BrowserTeardown } from "../lifecycle.js";

export function installGraphChipEntry(scope: unknown): BrowserTeardown {
  return runBrowserEntry(
    scope,
    (context) => initializeGraphChip(context),
    "document"
  );
}
