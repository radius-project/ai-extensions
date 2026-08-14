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
import { createRepositoriesRoutes } from "./routes/repositories.js";
import { createIdentityProfilesRoutes } from "./routes/identity-profiles.js";
import { createIdentityAuthRoutes } from "./routes/identity-auth.js";
import {
  createGraphsPlanningReadsRoutes,
  createGraphsPlanningStreamRoutes
} from "./routes/graphs-planning-reads.js";

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
  }),
  ...createRepositoriesRoutes({
    cliExec: () => {},
    readInstanceState: () => undefined,
    repoMatchesWorkspace: () => false
  }),
  ...createIdentityProfilesRoutes({
    listCredentialProfiles: () => [],
    saveCredentialProfile: () => null,
    deleteCredentialProfile: () => false,
    getGitHubIdentity: () =>
      Promise.resolve({
        actingLogin: "",
        displayLogin: "",
        mismatch: false,
        actingHasWorkflow: false,
        actingHasPackages: false,
        preferredLogin: null,
        reason: "",
        accounts: []
      }),
    resetGhIdentityCache: () => {},
    switchGhAccount: () => Promise.resolve({ ok: true }),
    setPreferredGitHubLogin: () => {},
    preflightRepoAdmin: () => Promise.resolve(""),
    isValidRepoSlug: () => false,
    errorMessage: (error) => String(error)
  }),
  ...createIdentityAuthRoutes({
    validateAzureCredentials: () => Promise.resolve({ success: false }),
    generateAzureOIDC: () => ({ message: "", output: "" }),
    generateAWSOIDC: () => ({ message: "", output: "" }),
    readInstanceState: () => undefined,
    setSharedAzureCredentials: () => {},
    saveCredentials: () => {},
    azureCredentialIdValidationError: () => "",
    azureLoginRequiredResponse: () => ({ error: "", code: "", tenantId: "" }),
    isCliCommandMissing: () => false,
    isUuid: () => false,
    buildAzureCliAssistMessage: () => ({ prompt: "", displayPrompt: "" }),
    runSessionPrompt: () => Promise.resolve({ status: 200 }),
    runCommand: () => Promise.resolve(""),
    errorMessage: (error) => String(error)
  }),
  ...createGraphsPlanningReadsRoutes({
    readInstanceEntry: () => undefined,
    createDeployStatusReader: () => ({
      graph: () => Promise.resolve({ graph: null, status: "missing" }),
      progress: () => Promise.resolve(null)
    }),
    buildDeployStatusMap: () => new Map(),
    buildDeployMessageMap: () => new Map(),
    deployStatusKeys: () => [],
    projectDeployedGraph: () => [],
    canvasGraphResources: () => [],
    applyDeployMessages: () => {},
    record: () => ({}),
    errorMessage: (error) => String(error),
    repoMatchesWorkspace: () => false
  }),
  ...createGraphsPlanningStreamRoutes({
    readInstanceEntry: () => undefined,
    defaultBranchForState: () => "main",
    prepareSourceRef: () => ({ token: "" }),
    commitSourceRef: () => true,
    triggerAppBicepHandoff: () => {},
    fetchBicepSelection: () =>
      Promise.resolve({
        content: null,
        fromWorkspace: false,
        branch: "main",
        bicepPath: ""
      }),
    workspaceGraphJsonPath: () => "",
    radArtifactsDirForSelection: () =>
      Promise.resolve({ dir: "", remote: false }),
    buildGraphViaRad: () => Promise.resolve([]),
    canvasGraphResources: () => [],
    errorMessage: (error) => String(error)
  })
};
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

  // operations-status is deliberately split: main added POST /api/operations
  // after the GETs migrated, so the family owns two migrated routes and one
  // that is still on the legacy fallback. graphs-planning is split for the same
  // reason by construction: its two read-only routes plus the load-graph-stream
  // SSE route are migrated, and its three remaining POST routes stay on the
  // legacy fallback. Naming both splits here keeps either family from reading as
  // fully migrated in the ledger.
  it("owns the liveness-source, repositories, identity-profile, and identity-auth families, the operations-status GETs, and the graphs-planning reads and load-graph-stream, and leaves 19 routes on the legacy fallback", () => {
    expect(MIGRATED_ROUTE_KEYS).toEqual([
      "ANY /api/ping",
      "GET /api/operations",
      "GET /api/operations/",
      "POST /api/open-source",
      "GET /api/credential-profiles",
      "GET /api/github-identity",
      "POST /api/github-account",
      "POST /api/save-credential-profile",
      "POST /api/delete-credential-profile",
      "POST /api/oidc",
      "POST /api/verify-azure-login",
      "POST /api/azure-cli-assist",
      "POST /api/verify-aws-login",
      "GET /api/user-repos",
      "POST /api/repo-branches",
      "POST /api/discover-branches",
      "GET /api/load-graph-stream",
      "GET /api/progress",
      "GET /api/deployed-graph"
    ]);
    expect(Object.keys(productionHandlers).sort()).toEqual(
      [...MIGRATED_ROUTE_KEYS].sort()
    );
    expect(LEGACY_ROUTE_INVENTORY).toHaveLength(19);
    // The split families, pinned explicitly so a later slice cannot quietly
    // assume either one is done.
    expect(LEGACY_ROUTE_INVENTORY).toContain("POST /api/operations");
    expect(LEGACY_ROUTE_INVENTORY).toEqual(
      expect.arrayContaining([
        "POST /api/load-graph",
        "POST /api/plan-graph",
        "POST /api/diff-branches"
      ])
    );
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
    // Cross-checked against the inventory, and independently pinned: 19 of 38
    // after this slice. The regex counts only `pathname ===` and
    // `pathname.startsWith` matchers, so the two regex-matched routes main
    // added under /api/operations/ (:id/resume/:code and the abandon route) are
    // not counted here and are not declared in the route table either.
    expect(residualLegacyCount).toBe(LEGACY_ROUTE_INVENTORY.length);
    expect(residualLegacyCount).toBe(19);

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
    // POST /api/operations is declared but still legacy, so it must resolve to
    // its own declaration rather than being swallowed by the GET rule, and it
    // must carry no handler so it keeps falling through to the legacy chain.
    const created = matchRoute(table, "POST", "/api/operations");
    expect(routeKey(created!)).toBe("POST /api/operations");
    expect(created?.migration).toBe("legacy");
    expect(created?.handler).toBeNull();
    // A method with no declaration at all still falls through.
    expect(matchRoute(table, "DELETE", "/api/operations")).toBeUndefined();
  });

  it("leaves main's undeclared sub-routes under /api/operations/ to the legacy chain", () => {
    // `main` serves two routes under this family's prefix with regexes rather
    // than declarations: POST /api/operations/:id/resume/:code and
    // POST /api/operations/:id/abandon. They are not in the route table, so the
    // dispatcher must not claim them -- and it only fails to claim them because
    // the migrated prefix route is GET-only. That disjointness is the whole
    // reason the migration is safe for those paths, so pin it: the dispatcher
    // now runs the table BEFORE the entire legacy chain, so if either route
    // were ever widened past POST this route would start shadowing it silently.
    expect(
      matchRoute(table, "POST", "/api/operations/op-1/resume/abc")
    ).toBeUndefined();
    expect(
      matchRoute(table, "POST", "/api/operations/op-1/abandon")
    ).toBeUndefined();

    // The shadowing is real for GET, and is pre-existing rather than a
    // regression: legacy's GET prefix branch claimed these composite paths too,
    // answering 404 for the whole tail as an operation id.
    const resumeAsGet = matchRoute(
      table,
      "GET",
      "/api/operations/op-1/resume/abc"
    );
    expect(routeKey(resumeAsGet!)).toBe("GET /api/operations/");
  });

  it("treats a missing request method as matching nothing but ANY routes", () => {
    // Node types `req.method` as optional, so the table must not blow up or
    // accidentally match a verb route when it is absent.
    expect(matchRoute(table, undefined, "/api/operations")).toBeUndefined();
    expect(matchRoute(table, undefined, "/api/operations/abc")).toBeUndefined();
    expect(routeKey(matchRoute(table, undefined, "/api/ping")!)).toBe(
      "ANY /api/ping"
    );
    // Method comparison is case-insensitive on the way in.
    expect(routeKey(matchRoute(table, "get", "/api/operations")!)).toBe(
      "GET /api/operations"
    );
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
