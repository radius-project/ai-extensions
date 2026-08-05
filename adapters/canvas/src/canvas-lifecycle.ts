// Reload an already-open canvas panel by re-opening the same instanceId, which
// makes the host focus the panel and reload its iframe (re-fetching current
// server state). `input` is echoed so the reopen stays idempotent even on a host
// build that routes a same-instance reopen back through the provider's open()
// (which would otherwise fall back to its default page). Never throws: the
// caller's real work is already done, so a reload/plumbing failure must not fail
// the operation — it is logged best-effort and swallowed.
export interface CanvasInstanceContext {
  extensionId: string;
  canvasId: string;
  instanceId: string;
}

export interface CanvasReloadSession {
  rpc: {
    canvas: {
      open(options: {
        extensionId: string;
        canvasId: string;
        instanceId: string;
        input?: unknown;
      }): Promise<unknown>;
    };
  };
  log?: (message: string, options: { level: "warning" }) => void;
}

export async function reloadCanvasInstance(
  session: CanvasReloadSession,
  context: CanvasInstanceContext,
  input?: unknown
): Promise<unknown> {
  try {
    return await session.rpc.canvas.open({
      extensionId: context.extensionId,
      canvasId: context.canvasId,
      instanceId: context.instanceId,
      ...(input ? { input } : {})
    });
  } catch (error: unknown) {
    try {
      session?.log?.(
        `Radius: could not reload canvas ${context.instanceId}: ${error instanceof Error ? error.message : String(error)}`,
        { level: "warning" }
      );
    } catch {
      /* logging is best-effort */
    }
    return undefined;
  }
}
