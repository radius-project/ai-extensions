import {
  createServerRouteTable,
  MIGRATED_ROUTE_KEYS,
  routeKey,
  SERVER_ROUTE_DECLARATIONS,
  type RouteHandlerRegistry,
  type ServerRoute
} from "../../../src/server/route-table.js";

/**
 * Build a route table for a test that exercises only some of the migrated
 * families.
 *
 * Every migrated key the caller does not supply is filled with a stub that
 * throws if the dispatcher ever reaches it, so an unexpected dispatch still
 * fails loudly while a test that does not care about a family no longer needs a
 * manual stub edit each time another family migrates.
 *
 * Test support only. This supplies handlers, it does not relax validation: the
 * table is still built by `createServerRouteTable`, which continues to throw on
 * a migrated key with no handler. Production composition roots must keep
 * passing a real handler for every migrated route, so this helper is
 * deliberately not exported from `src/`.
 *
 * This helper cannot hide a production wiring omission. `src/server.ts` builds
 * its table once at module initialization, so a migrated key with no real
 * handler throws while `src/server.js` is being imported and hard-fails every
 * suite that imports it, including `src/server.test.ts`.
 */
export function createTestRouteTable(
  handlers: RouteHandlerRegistry = {}
): readonly ServerRoute[] {
  const stubs: Record<string, () => never> = {};
  for (const key of MIGRATED_ROUTE_KEYS) {
    if (key in handlers) continue;
    stubs[key] = () => {
      throw new Error(`unexpected dispatch to un-stubbed route: ${key}`);
    };
  }
  return createServerRouteTable({ ...stubs, ...handlers });
}

/**
 * A request the legacy fallback still owns after every declared route has
 * migrated. `GET /api/operations/` is a migrated prefix route, but it claims
 * only GET, so this POST sub-route stays undeclared and keeps reaching the
 * fallback, which still answers it in `src/server.ts`.
 */
const UNDECLARED_FALLBACK = {
  method: "POST",
  path: "/api/operations/probe-nonexistent/abandon"
} as const;

/**
 * Exercise a request the migrated route table does not own, so the dispatcher
 * has to hand it to the legacy fallback.
 *
 * While a declared route is still residual, that route is the target: the
 * request uses the declaration's own method so migrating it makes the test
 * route table intercept the request and fail loudly instead of leaving a
 * method-mismatch probe green.
 *
 * Once the declared inventory is empty the fallback is still live, because it
 * owns undeclared dynamic sub-routes such as the operations resume and abandon
 * paths. The probe then targets one of those. It is not named blindly: the
 * declarations are checked first, so if that path is ever declared and migrated
 * the probe fails loudly rather than quietly testing nothing.
 */
export function fetchResidualRoute(baseUrl: string): Promise<Response> {
  const declaration = SERVER_ROUTE_DECLARATIONS.find(
    (route) => !MIGRATED_ROUTE_KEYS.includes(routeKey(route))
  );
  if (declaration) {
    return fetch(`${baseUrl}${declaration.path}`, {
      method: declaration.method === "ANY" ? "GET" : declaration.method
    });
  }
  const claimed = SERVER_ROUTE_DECLARATIONS.some(
    (route) =>
      (route.method === "ANY" || route.method === UNDECLARED_FALLBACK.method) &&
      (route.match === "prefix" ?
        UNDECLARED_FALLBACK.path.startsWith(route.path)
      : UNDECLARED_FALLBACK.path === route.path)
  );
  if (claimed) {
    throw new Error(
      `The fallback probe target ${UNDECLARED_FALLBACK.method} ` +
        `${UNDECLARED_FALLBACK.path} is now a declared route, so it no longer ` +
        "reaches the legacy fallback. Point the probe at a path the fallback " +
        "still owns, or delete the fallback and this helper together."
    );
  }
  return fetch(`${baseUrl}${UNDECLARED_FALLBACK.path}`, {
    method: UNDECLARED_FALLBACK.method
  });
}
