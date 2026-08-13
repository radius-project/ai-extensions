import type { CanvasState } from "../../shared.js";
import type { CanvasRequestContext } from "../request-context.js";
import type { RouteHandlerRegistry } from "../route-table.js";

export interface OpenSourceRequest {
  path: string;
  line: number;
  instanceId: string;
  state?: CanvasState;
}

export type OpenSourceInvoker = (input: OpenSourceRequest) => unknown;

export interface LivenessSourceDependencies {
  // Resolved per request, never snapshotted: the SDK entry registers the open
  // handler after the server is constructed, so late binding is part of the
  // contract.
  getOpenSourceHandler(): OpenSourceInvoker | null;
  readInstanceState(instanceId: string): CanvasState | undefined;
  toSafeRepoRelPath(input: unknown): string;
}

const NO_STORE = Object.freeze({ "Cache-Control": "no-store" });

// Lightweight liveness probe used by the client-side heartbeat so pages can
// detect when the server has come back after an idle respawn.
export function handlePing(context: CanvasRequestContext): void {
  context.json(200, { ok: true, instanceId: context.instanceId }, NO_STORE);
}

// Only the webview for a local-workspace graph calls this (client passes
// localSource); the actual open is delegated to the SDK session via the handler
// registered in extension.ts. Status codes are meaningful so the webview can
// flag a failed open to the user: 400 invalid path, 503 handler unavailable,
// 500 open failed, 200 ok.
export async function handleOpenSource(
  context: CanvasRequestContext,
  dependencies: LivenessSourceDependencies
): Promise<void> {
  const body = await context.readTextBody();
  // Both headers are set before parsing so an invalid-path 400 still carries
  // them, exactly as the legacy dispatcher did.
  context.response.setHeader("Content-Type", "application/json");
  context.response.setHeader("Cache-Control", "no-store");
  let relPath: string;
  // `line` is reserved: the editor canvas has no line-selection input yet, so
  // it is validated and threaded through but not acted on. When the canvas
  // gains line support, the handler can start honoring it.
  let line: number;
  try {
    const data = JSON.parse(body || "{}");
    relPath = dependencies.toSafeRepoRelPath(data.path);
    const lineRaw = Number.parseInt(data.line, 10);
    line = Number.isFinite(lineRaw) && lineRaw > 0 ? lineRaw : 0;
  } catch {
    context.json(400, { ok: false, error: "invalid path" }, NO_STORE);
    return;
  }
  const openSource = dependencies.getOpenSourceHandler();
  if (typeof openSource !== "function") {
    context.json(503, { ok: false, error: "unavailable" }, NO_STORE);
    return;
  }
  try {
    await Promise.resolve(
      openSource({
        path: relPath,
        line,
        instanceId: context.instanceId,
        state: dependencies.readInstanceState(context.instanceId)
      })
    );
    context.json(200, { ok: true }, NO_STORE);
  } catch (e) {
    context.json(
      500,
      { ok: false, error: e instanceof Error ? e.message : "failed" },
      NO_STORE
    );
  }
}

export function createLivenessSourceRoutes(
  dependencies: LivenessSourceDependencies
): RouteHandlerRegistry {
  return {
    "ANY /api/ping": handlePing,
    "POST /api/open-source": (context) =>
      handleOpenSource(context, dependencies)
  };
}
