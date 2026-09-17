import type {
  CancellationSignal,
  RequestControl
} from "@radius-project/core/lifecycle";
import type { CanvasRequestContext } from "../request-context.js";

export function discoveryCancellation(
  context: CanvasRequestContext
): CancellationSignal {
  return {
    get aborted() {
      return context.response.destroyed;
    },
    onAbort(listener) {
      if (context.response.destroyed) listener();
      else context.response.once("close", listener);
      return () => context.response.removeListener("close", listener);
    }
  };
}

export function discoveryControl(
  requestId: string,
  signal: AbortSignal
): RequestControl {
  return {
    requestId,
    cancellation: {
      get aborted() {
        return signal.aborted;
      },
      onAbort(listener) {
        if (signal.aborted) listener();
        else signal.addEventListener("abort", listener, { once: true });
        return () => signal.removeEventListener("abort", listener);
      }
    }
  };
}
