// Selects where the cloud journey drives the Radius canvas.
//
// - "harness" (the default) serves the canvas from this checkout with the
//   CanvasHarness and drives it in headless Chromium. This is the production
//   path that the scheduled workflow runs.
// - "copilot-app" starts the real GitHub Copilot desktop app on Windows, asks
//   the Radius agent to model the fixture, and drives the canvas inside the
//   app over CDP. It is opt-in.

export const CLOUD_CANVAS_HOST_ENV = "RADIUS_CLOUD_E2E_CANVAS_HOST";

export const CLOUD_CANVAS_HOSTS = ["harness", "copilot-app"] as const;

export type CloudCanvasHost = (typeof CLOUD_CANVAS_HOSTS)[number];

function isCloudCanvasHost(value: string): value is CloudCanvasHost {
  return (CLOUD_CANVAS_HOSTS as readonly string[]).includes(value);
}

/**
 * Reads the canvas host from its environment value. An unset or blank value
 * selects the harness. An unknown value fails, so a typo cannot silently run
 * the wrong journey.
 */
export function resolveCloudCanvasHost(
  value: string | undefined
): CloudCanvasHost {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized === "") return "harness";
  if (isCloudCanvasHost(normalized)) return normalized;
  throw new Error(
    `${CLOUD_CANVAS_HOST_ENV} must be one of ${CLOUD_CANVAS_HOSTS.join(", ")}; ` +
      `got "${value ?? ""}".`
  );
}
