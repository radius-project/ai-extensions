import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertRouteTable,
  createServerRouteTable,
  LEGACY_ROUTE_INVENTORY,
  MIGRATED_ROUTE_KEYS,
  routeKey,
  SERVER_ROUTE_DECLARATIONS,
  type RouteHandler,
  type ServerRoute
} from "./route-table.js";
import { createLivenessSourceRoutes } from "./routes/liveness-source.js";

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

const productionHandlers = createLivenessSourceRoutes({
  getOpenSourceHandler: () => null,
  readInstanceState: () => undefined,
  toSafeRepoRelPath: (input) => String(input)
});
const table = createServerRouteTable(productionHandlers);

describe("server route ownership boundary", () => {
  it("pins all 38 routes to one owner and matches the compatibility fixture", () => {
    expect(SERVER_ROUTE_DECLARATIONS).toHaveLength(38);
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

  it("owns the liveness-source family and leaves 36 routes on the legacy fallback", () => {
    expect(MIGRATED_ROUTE_KEYS).toEqual([
      "ANY /api/ping",
      "POST /api/open-source"
    ]);
    expect(Object.keys(productionHandlers).sort()).toEqual(
      [...MIGRATED_ROUTE_KEYS].sort()
    );
    expect(LEGACY_ROUTE_INVENTORY).toHaveLength(36);
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
      const methodMatcher =
        route.method === "ANY" ? "" : `req.method === "${route.method}"`;
      // A path can carry more than one method (GET and POST /api/operations),
      // so advance past occurrences whose method does not match. This also keeps
      // the migrated-absence check below method-aware: a migrated GET must not be
      // considered still-legacy just because a sibling POST shares its path.
      let offset = legacySource.indexOf(matcher);
      while (
        offset >= 0 &&
        methodMatcher &&
        !legacySource.slice(offset, offset + 180).includes(methodMatcher)
      ) {
        offset = legacySource.indexOf(matcher, offset + matcher.length);
      }
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
    ).toThrow(
      "Missing handler for migrated server route: POST /api/open-source"
    );
  });

  it("fails on duplicate, unowned, or handlerless routes", () => {
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
          ...table[1],
          migration: "legacy",
          handler: () => {}
        } as unknown as ServerRoute
      ])
    ).toThrow(
      "Legacy server route unexpectedly has a handler: GET /api/operations"
    );
  });

  it("fails when a prefix route makes a later route unreachable", () => {
    const prefix = table.find((route) => route.path === "/api/operations/");
    expect(prefix?.method).toBe("GET");

    expect(() =>
      assertRouteTable([
        prefix as ServerRoute,
        {
          ...(prefix as ServerRoute),
          path: "/api/operations/summary",
          match: "exact"
        } as ServerRoute
      ])
    ).toThrow(
      "Server route GET /api/operations/summary is unreachable behind earlier prefix route GET /api/operations/"
    );

    expect(() =>
      assertRouteTable([
        prefix as ServerRoute,
        {
          ...(prefix as ServerRoute),
          path: "/api/operations/logs/",
          method: "ANY"
        } as ServerRoute
      ])
    ).toThrow(
      "Server route ANY /api/operations/logs/ is unreachable behind earlier prefix route GET /api/operations/"
    );
  });

  it("allows routes an earlier prefix route cannot claim", () => {
    const prefix = table.find(
      (route) => route.path === "/api/operations/"
    ) as ServerRoute;

    // Disjoint method: the prefix cannot claim a POST sub-route.
    expect(() =>
      assertRouteTable([
        prefix,
        {
          ...prefix,
          path: "/api/operations/abandon",
          match: "exact",
          method: "POST"
        } as ServerRoute
      ])
    ).not.toThrow();

    // Outside the prefix, and the exact sibling that legitimately precedes it.
    expect(() =>
      assertRouteTable([
        prefix,
        { ...prefix, path: "/api/operation", match: "exact" } as ServerRoute
      ])
    ).not.toThrow();
    expect(() =>
      assertRouteTable([
        { ...prefix, path: "/api/operations", match: "exact" } as ServerRoute,
        prefix
      ])
    ).not.toThrow();
  });
});
