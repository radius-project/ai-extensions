import type { CanvasRequestContext } from "../request-context.js";

export async function runSetupHttpHandler(
  context: CanvasRequestContext,
  work: () => Promise<void>,
  report: (diagnostic: { code: string; message: string }) => void
): Promise<void> {
  try {
    await work();
  } catch (error) {
    const diagnostic = {
      code: "setup-handler-failed",
      message:
        "Setup could not finish reporting its outcome. Inspect the operation before retrying."
    };
    try {
      report({
        code: diagnostic.code,
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      const { response } = context;
      if (
        response.headersSent ||
        response.writableEnded ||
        response.destroyed
      ) {
        if (!response.writableEnded && !response.destroyed) response.destroy();
      } else {
        context.json(500, { error: diagnostic.message, code: diagnostic.code });
      }
    }
  }
}
