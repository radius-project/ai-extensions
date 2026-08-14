import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertRouteTable,
  LEGACY_ROUTE_INVENTORY,
  routeKey,
  SERVER_ROUTE_TABLE,
  type ServerRoute
} from "./route-table.js";

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

describe("server route ownership boundary", () => {
  it("pins all 38 routes to one owner and an explicit legacy fallback", () => {
    expect(SERVER_ROUTE_TABLE).toHaveLength(38);
    expect(
      SERVER_ROUTE_TABLE.map(({ method, path, match }) => ({
        method,
        path,
        match
      }))
    ).toEqual(fixture.routes);
    expect(LEGACY_ROUTE_INVENTORY).toEqual(fixture.routes.map(routeKey));
    expect(SERVER_ROUTE_TABLE.every((route) => route.owner.length > 0)).toBe(
      true
    );
    expect(
      SERVER_ROUTE_TABLE.every(
        (route) => route.migration === "legacy" && route.handler === null
      )
    ).toBe(true);
    const residualLegacyCount =
      (legacySource.match(/pathname === "\/api\//g) || []).length +
      (legacySource.match(/pathname\.startsWith\("\/api\//g) || []).length;
    expect(residualLegacyCount).toBe(LEGACY_ROUTE_INVENTORY.length);
    for (const route of SERVER_ROUTE_TABLE) {
      const matcher =
        route.match === "prefix" ?
          `pathname.startsWith("${route.path}")`
        : `pathname === "${route.path}"`;
      const methodMatcher =
        route.method === "ANY" ? "" : `req.method === "${route.method}"`;
      // A path can carry more than one method (GET and POST /api/operations),
      // so advance past occurrences whose method does not match.
      let offset = legacySource.indexOf(matcher);
      while (
        offset >= 0 &&
        methodMatcher &&
        !legacySource.slice(offset, offset + 180).includes(methodMatcher)
      ) {
        offset = legacySource.indexOf(matcher, offset + matcher.length);
      }
      expect(offset, routeKey(route)).toBeGreaterThan(-1);
      if (route.method !== "ANY") {
        expect(legacySource.slice(offset, offset + 180)).toContain(
          `req.method === "${route.method}"`
        );
      }
    }
    expect(() => assertRouteTable(SERVER_ROUTE_TABLE)).not.toThrow();
  });

  it("fails on duplicate or unowned routes", () => {
    expect(() =>
      assertRouteTable([...SERVER_ROUTE_TABLE, SERVER_ROUTE_TABLE[0]])
    ).toThrow("Duplicate server route: ANY /api/ping");

    expect(() =>
      assertRouteTable([
        {
          ...SERVER_ROUTE_TABLE[0],
          owner: ""
        } as unknown as ServerRoute
      ])
    ).toThrow("Unowned server route: ANY /api/ping");
  });

  it("fails when migrated metadata has no handler", () => {
    expect(() =>
      assertRouteTable([
        {
          ...SERVER_ROUTE_TABLE[0],
          migration: "migrated",
          handler: null
        } as unknown as ServerRoute
      ])
    ).toThrow("Migrated server route has no handler: ANY /api/ping");

    expect(() =>
      assertRouteTable([
        {
          ...SERVER_ROUTE_TABLE[0],
          migration: "legacy",
          handler: () => undefined
        } as unknown as ServerRoute
      ])
    ).toThrow("Legacy server route unexpectedly has a handler: ANY /api/ping");
  });

  it("fails when a prefix route makes a later route unreachable", () => {
    const prefix = SERVER_ROUTE_TABLE.find(
      (route) => route.path === "/api/operations/"
    );
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
    const prefix = SERVER_ROUTE_TABLE.find(
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
