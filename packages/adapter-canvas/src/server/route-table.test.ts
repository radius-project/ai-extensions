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
  it("pins all 37 routes to one owner and an explicit legacy fallback", () => {
    expect(SERVER_ROUTE_TABLE).toHaveLength(37);
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
      const offset = legacySource.indexOf(matcher);
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
  });
});
