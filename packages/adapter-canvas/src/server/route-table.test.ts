import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertRouteTable,
  createServerRouteTable,
  LEGACY_ROUTE_INVENTORY,
  matchRoute,
  MIGRATED_ROUTE_KEYS,
  routeKey,
  SERVER_ROUTE_DECLARATIONS,
  type RouteHandler,
  type ServerRoute
} from "./route-table.js";
import { createLivenessSourceRoutes } from "./routes/liveness-source.js";
import { createOperationsStatusRoutes } from "./routes/operations-status.js";

interface CompatibilityRoute {
  method: "ANY" | "GET" | "POST";
  path: string;
  match: "exact" | "prefix";
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../../test/fixtures/runtime-compatibility.json", import.meta.url),
    "utf8"
  )
) as { routes: CompatibilityRoute[] };
const legacySource = readFileSync(
  new URL("../server.ts", import.meta.url),
  "utf8"
);

const productionHandlers = {
  ...createLivenessSourceRoutes({
    getOpenSourceHandler: () => null,
    readInstanceState: () => undefined,
    toSafeRepoRelPath: (input) => String(input)
  }),
  ...createOperationsStatusRoutes({
    latest: () => null,
    latestAny: () => null,
    get: () => null,
    toClientView: () => null
  })
};
const table = createServerRouteTable(productionHandlers);

describe("server route ownership boundary", () => {
  it("pins all 37 routes to one owner and matches the compatibility fixture", () => {
    expect(SERVER_ROUTE_DECLARATIONS).toHaveLength(37);
    expect(
      SERVER_ROUTE_DECLARATIONS.map(({ method, path, match }) => ({
        method,
        path,
        match
      }))
    ).toEqual(fixture.routes);
    expect(
      SERVER_ROUTE_DECLARATIONS.every((route) => route.owner.length > 0)
    ).toBe(true);
    expect(() => assertRouteTable(table)).not.toThrow();
  });

  it("owns the liveness-source and operations-status families and leaves 33 routes on the legacy fallback", () => {
    expect(MIGRATED_ROUTE_KEYS).toEqual([
      "ANY /api/ping",
      "GET /api/operations",
      "GET /api/operations/",
      "POST /api/open-source"
    ]);
    expect(Object.keys(productionHandlers).sort()).toEqual(
      [...MIGRATED_ROUTE_KEYS].sort()
    );
    expect(LEGACY_ROUTE_INVENTORY).toHaveLength(33);
    expect(LEGACY_ROUTE_INVENTORY).toEqual(
      fixture.routes
        .map(routeKey)
        .filter((key) => !MIGRATED_ROUTE_KEYS.includes(key))
    );
    expect(
      table
        .filter((route) => route.migration === "migrated")
        .map(routeKey)
        .sort()
    ).toEqual([...MIGRATED_ROUTE_KEYS].sort());
    expect(
      table
        .filter((route) => route.migration === "legacy")
        .every((route) => route.handler === null)
    ).toBe(true);
  });

  it("keeps the residual legacy dispatcher exactly equal to the inventory", () => {
    const residualLegacyCount =
      (legacySource.match(/pathname === "\/api\//g) || []).length +
      (legacySource.match(/pathname\.startsWith\("\/api\//g) || []).length;
    expect(residualLegacyCount).toBe(LEGACY_ROUTE_INVENTORY.length);

    for (const route of table) {
      const matcher =
        route.match === "prefix" ?
          `pathname.startsWith("${route.path}")`
        : `pathname === "${route.path}"`;
      const offset = legacySource.indexOf(matcher);
      if (route.migration === "migrated") {
        // A migrated route must no longer be answered by the legacy chain.
        expect(offset, routeKey(route)).toBe(-1);
        continue;
      }
      expect(offset, routeKey(route)).toBeGreaterThan(-1);
      if (route.method !== "ANY") {
        expect(legacySource.slice(offset, offset + 180)).toContain(
          `req.method === "${route.method}"`
        );
      }
    }
  });

  it("fails when a migrated route has no handler", () => {
    expect(() => createServerRouteTable({})).toThrow(
      "Missing handler for migrated server route: ANY /api/ping"
    );
    expect(() =>
      createServerRouteTable({
        "ANY /api/ping": productionHandlers["ANY /api/ping"] as RouteHandler
      })
    ).toThrow("Missing handler for migrated server route: GET /api/operations");
  });

  it("matches the exact operations route before the by-id prefix route", () => {
    const latest = matchRoute(table, "GET", "/api/operations");
    const byId = matchRoute(table, "GET", "/api/operations/abc");
    expect(routeKey(latest!)).toBe("GET /api/operations");
    expect(routeKey(byId!)).toBe("GET /api/operations/");
    // The prefix rule must not swallow the exact route, and the two routes must
    // land on genuinely different handlers.
    expect(latest?.handler).not.toBe(byId?.handler);
    // A trailing slash with no id is a by-id lookup for the empty id.
    expect(routeKey(matchRoute(table, "GET", "/api/operations/")!)).toBe(
      "GET /api/operations/"
    );
    // Declaration order is what makes that true, so pin it.
    expect(
      SERVER_ROUTE_DECLARATIONS.findIndex(
        (route) => routeKey(route) === "GET /api/operations"
      )
    ).toBeLessThan(
      SERVER_ROUTE_DECLARATIONS.findIndex(
        (route) => routeKey(route) === "GET /api/operations/"
      )
    );
    // Only GET is declared, so other methods still fall through to the legacy
    // fallback.
    expect(matchRoute(table, "POST", "/api/operations")).toBeUndefined();
  });

  it("fails on duplicate, unowned, or handlerless routes", () => {
    const legacyRoute = table.find((route) => route.migration === "legacy")!;
    expect(() => assertRouteTable([...table, table[0]])).toThrow(
      "Duplicate server route: ANY /api/ping"
    );

    expect(() =>
      assertRouteTable([{ ...table[0], owner: "" } as unknown as ServerRoute])
    ).toThrow("Unowned server route: ANY /api/ping");

    expect(() =>
      assertRouteTable([
        {
          ...table[0],
          migration: "migrated",
          handler: null
        } as unknown as ServerRoute
      ])
    ).toThrow("Migrated server route has no handler: ANY /api/ping");

    expect(() =>
      assertRouteTable([
        {
          ...legacyRoute,
          migration: "legacy",
          handler: () => {}
        } as unknown as ServerRoute
      ])
    ).toThrow(
      `Legacy server route unexpectedly has a handler: ${routeKey(legacyRoute)}`
    );
  });
});
