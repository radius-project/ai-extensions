import type { RequestListener } from "node:http";
import { createRequestContext } from "./request-context.js";
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
}

export function createRequestHandler({
  instanceId,
  instances,
  routes,
  legacyFallback,
  markActivity
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
    const route = matchRoute(routes, request.method, context.pathname);
    if (route?.migration === "migrated") {
      await route.handler(context);
      return;
    }
    await Promise.resolve(legacyFallback(request, response));
  };
}
