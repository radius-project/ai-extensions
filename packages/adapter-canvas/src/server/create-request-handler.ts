import type { IncomingMessage, RequestListener } from "node:http";
import {
  createRequestContext,
  type CanvasRequestContext
} from "./request-context.js";
import {
  assertRouteTable,
  matchRoute,
  type ServerRoute
} from "./route-table.js";
import type { CanvasServerEntry } from "./types.js";

export interface CreateRequestHandlerInput {
  instanceId: string;
  instances: ReadonlyMap<string, CanvasServerEntry>;
  routes: readonly ServerRoute[];
  handleUnmatchedRequest: RequestListener;
  // Receives the request so the caller can exclude traffic that must not count
  // as user activity (server-owned internal calls).
  markActivity(request: IncomingMessage): void;
  // Global pre-routing applied to every request. It runs before route
  // selection and before any body read so typed routes cannot bypass the
  // checks required before typed dispatch.
  // Returning true means the request was fully answered.
  preRoute?(context: CanvasRequestContext): boolean;
}

export function createRequestHandler({
  instanceId,
  instances,
  routes,
  handleUnmatchedRequest,
  markActivity,
  preRoute
}: CreateRequestHandlerInput): RequestListener {
  assertRouteTable(routes);
  return async (request, response) => {
    markActivity(request);
    const context = createRequestContext(
      request,
      response,
      instanceId,
      instances
    );
    if (preRoute?.(context)) return;
    const route = matchRoute(routes, request.method, context.pathname);
    if (route) {
      await route.handler(context);
      return;
    }
    await Promise.resolve(handleUnmatchedRequest(request, response));
  };
}
