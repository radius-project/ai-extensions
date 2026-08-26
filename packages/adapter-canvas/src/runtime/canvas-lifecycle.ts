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
        input?: Record<string, unknown>;
      }): Promise<unknown>;
    };
  };
  log?: (
    message: string,
    options?: { level?: "info" | "warning" | "error"; ephemeral?: boolean }
  ) => Promise<void> | void;
}

// Editor panels are addressed by instanceId, and re-opening an instanceId that
// already exists focuses that panel rather than re-initializing it with the new
// input. A shared handle therefore pins every "View source code" click to
// whichever file was opened first, so each distinct path gets its own handle.
// The slug keeps the handle readable in host diagnostics; the hash keeps two
// paths that slug identically (or that differ past the slug cutoff) apart.
export const SOURCE_EDITOR_INSTANCE_PREFIX = "radius-source";

const SOURCE_EDITOR_SLUG_MAX = 60;

function hashPath(value: string): string {
  // FNV-1a (32-bit): a stable, dependency-free digest. This disambiguates
  // handles, it is not a security boundary.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

export function sourceEditorInstanceId(safePath: string): string {
  const slug = safePath
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SOURCE_EDITOR_SLUG_MAX)
    .replace(/-+$/, "");
  const parts = [SOURCE_EDITOR_INSTANCE_PREFIX];
  if (slug) parts.push(slug);
  parts.push(hashPath(safePath));
  return parts.join("-");
}

export async function reloadCanvasInstance(
  session: CanvasReloadSession,
  context: CanvasInstanceContext,
  input?: Record<string, unknown>
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
