import type { RequestListener } from "node:http";
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
  legacyFallback: RequestListener;
  markActivity(): void;
  // Global pre-routing applied to every request. It runs before route
  // selection and before any body read so migrated routes cannot bypass the
  // checks the legacy dispatcher performed at the top of its if-chain.
  // Returning true means the request was fully answered.
  preRoute?(context: CanvasRequestContext): boolean;
}

export function createRequestHandler({
  instanceId,
  instances,
  routes,
  legacyFallback,
  markActivity,
  preRoute
}: CreateRequestHandlerInput): RequestListener {
  assertRouteTable(routes);
  return async (request, response) => {
    markActivity();
    const context = createRequestContext(
      request,
      response,
      instanceId,
      instances
    );
    if (preRoute?.(context)) return;
    const route = matchRoute(routes, request.method, context.pathname);
    if (route?.migration === "migrated") {
      await route.handler(context);
      return;
    }
    await Promise.resolve(legacyFallback(request, response));
  };
}
