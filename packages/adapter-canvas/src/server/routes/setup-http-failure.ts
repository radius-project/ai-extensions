import type { CanvasRequestContext } from "../request-context.js";
import { setupHandlerFailure } from "../services/setup-outcome.js";

export async function runSetupHttpHandler(
  context: CanvasRequestContext,
  work: () => Promise<void>,
  report: (diagnostic: { code: string; message: string }) => void
): Promise<void> {
  try {
    await work();
  } catch (error) {
    const outcome = setupHandlerFailure(error, report);
    const { response } = context;
    if (response.headersSent || response.writableEnded || response.destroyed) {
      if (!response.writableEnded && !response.destroyed) response.destroy();
    } else {
      context.json(outcome.status, outcome.body);
    }
  }
}
