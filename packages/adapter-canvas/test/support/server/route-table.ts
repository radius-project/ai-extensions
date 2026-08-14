import {
  createServerRouteTable,
  LEGACY_ROUTE_INVENTORY,
  MIGRATED_ROUTE_KEYS,
  routeKey,
  SERVER_ROUTE_DECLARATIONS,
  type RouteHandlerRegistry,
  type RouteMethod,
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
 * The path of a route that still reaches the legacy fallback, for a test that
 * needs to prove fallthrough survives alongside the migrated table.
 *
 * Derived from the residual inventory rather than named, because a named
 * fallthrough probe silently inherits that route's migration expiry: the slice
 * that migrates it turns the probe from "reaches the fallback" into "dispatches
 * to a stub", which fails somewhere unrelated to the change that caused it.
 * That has now happened twice on this stack.
 *
 * Throws when no residual route of that method remains, so the last migration
 * removes these probes deliberately instead of leaving them asserting nothing.
 */
export function residualRoutePathForProbe(method: RouteMethod): string {
  const exactResidual = SERVER_ROUTE_DECLARATIONS.filter(
    (declaration) =>
      declaration.method === method &&
      declaration.match === "exact" &&
      LEGACY_ROUTE_INVENTORY.includes(routeKey(declaration))
  );
  const [declaration] = exactResidual;
  if (!declaration) {
    throw new Error(
      `No residual ${method} route remains to probe legacy fallthrough with. ` +
        "Every declared route of that method is now migrated, so this probe " +
        "can no longer assert anything and should be deleted with the slice " +
        "that emptied the inventory."
    );
  }
  return declaration.path;
}
