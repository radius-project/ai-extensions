import { beginEntry, NOOP_TEARDOWN } from "./lifecycle.js";
import type { BrowserTeardown } from "./lifecycle.js";
import type { AbortHandle, BrowserContext } from "./ports.js";

export const HEARTBEAT_ENTRY_KEY = "heartbeat";
export const HEARTBEAT_PING_PATH = "/api/ping";
export const HEARTBEAT_OVERLAY_ID = "radius-reconnect-overlay";
export const HEARTBEAT_INTERVAL_MS = 5000;
export const HEARTBEAT_REQUEST_TIMEOUT_MS = 4000;
export const HEARTBEAT_MISS_THRESHOLD = 2;
export const HEARTBEAT_RELOAD_RETRY_MS = 15000;

export interface HeartbeatOptions {
  intervalMs?: number;
  requestTimeoutMs?: number;
  missThreshold?: number;
  reloadRetryMs?: number;
}

export function initializeHeartbeat(
  context: BrowserContext,
  options: HeartbeatOptions = {}
): BrowserTeardown {
  const claimedScope = beginEntry(context, HEARTBEAT_ENTRY_KEY);
  if (claimedScope === null) return NOOP_TEARDOWN;
  const scope = claimedScope;

  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? HEARTBEAT_REQUEST_TIMEOUT_MS;
  const missThreshold = options.missThreshold ?? HEARTBEAT_MISS_THRESHOLD;
  const reloadRetryMs = options.reloadRetryMs ?? HEARTBEAT_RELOAD_RETRY_MS;
  const overlay = context.dom.byId(HEARTBEAT_OVERLAY_ID);

  let down = false;
  let misses = 0;
  let inFlight = false;
  let reloadRequestedAt: number | null = null;
  let activeAbort: AbortHandle | null = null;

  function recordMiss(): void {
    misses += 1;
    if (misses >= missThreshold && !down) {
      down = true;
      if (overlay !== null) overlay.style.display = "flex";
    }
  }

  // A reload the host accepts without navigating leaves this page alive, so the
  // request is throttled rather than latched: an unnoticed non-navigation is
  // retried once the retry window elapses instead of wedging the overlay open
  // for the life of the page.
  function reloadDue(): boolean {
    return (
      reloadRequestedAt === null ||
      context.clock.now() - reloadRequestedAt >= reloadRetryMs
    );
  }

  function ping(): Promise<void> {
    if (!scope.active || inFlight) return Promise.resolve();
    inFlight = true;
    const abort = context.net.createAbort();
    activeAbort = abort;
    const deadline =
      abort === null ? null : (
        scope.after(requestTimeoutMs, () => {
          abort.abort();
        })
      );

    return Promise.resolve()
      .then(() =>
        context.net.fetch(HEARTBEAT_PING_PATH, {
          cache: "no-store",
          signal: abort === null ? undefined : abort.signal
        })
      )
      .then(
        (response) => {
          if (!scope.active) return;
          if (!response.ok) {
            recordMiss();
            return;
          }
          if (down && reloadDue()) {
            reloadRequestedAt = context.clock.now();
            try {
              context.nav.reload();
            } catch (error) {
              reloadRequestedAt = null;
              throw error;
            }
            return;
          }
          misses = 0;
        },
        () => {
          if (scope.active) recordMiss();
        }
      )
      .catch((error: unknown) => {
        if (scope.active) {
          context.logger.error("Radius heartbeat recovery failed.", error);
        }
      })
      .finally(() => {
        if (deadline !== null) scope.cancel(deadline);
        if (activeAbort === abort) activeAbort = null;
        inFlight = false;
      });
  }

  scope.every(intervalMs, () => {
    void ping();
  });
  scope.on(context.dom.document, "visibilitychange", () => {
    if (context.dom.document.visibilityState === "visible") void ping();
  });
  scope.on(context.page, "focus", () => {
    void ping();
  });
  scope.onTeardown(() => {
    activeAbort?.abort();
    activeAbort = null;
  });

  return () => {
    scope.teardown();
  };
}
