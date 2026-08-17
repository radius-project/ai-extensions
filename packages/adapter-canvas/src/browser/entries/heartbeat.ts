import { initializeHeartbeat } from "../heartbeat.js";
import { runBrowserEntry } from "../registry.js";
import type { BrowserTeardown } from "../lifecycle.js";

export function installHeartbeatEntry(scope: unknown): BrowserTeardown {
  return runBrowserEntry(
    scope,
    (context) => initializeHeartbeat(context),
    "document"
  );
}
