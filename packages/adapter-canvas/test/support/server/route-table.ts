import {
  createServerRouteTable,
  MIGRATED_ROUTE_KEYS,
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
