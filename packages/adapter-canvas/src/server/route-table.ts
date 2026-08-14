import type { CanvasRequestContext } from "./request-context.js";

export type RouteMethod = "ANY" | "GET" | "POST";
export type RouteMatcher = "exact" | "prefix";
export type RouteBodyPolicy = "none" | "json";
export type RouteOwner =
  | "liveness-source"
  | "operations-status"
  | "identity-credentials"
  | "azure-discovery"
  | "repositories"
  | "graphs-planning"
  | "environments"
  | "deployments";

export type RouteHandler = (
  context: CanvasRequestContext
) => void | Promise<void>;

export type RouteHandlerRegistry = Readonly<Record<string, RouteHandler>>;

export interface RouteDeclaration {
  method: RouteMethod;
  path: string;
  match: RouteMatcher;
  bodyPolicy: RouteBodyPolicy;
  owner: RouteOwner;
}

export type ServerRoute =
  | (RouteDeclaration & {
      migration: "legacy";
      handler: null;
    })
  | (RouteDeclaration & {
      migration: "migrated";
      handler: RouteHandler;
    });

function declare(
  method: RouteMethod,
  path: string,
  match: RouteMatcher,
  bodyPolicy: RouteBodyPolicy,
  owner: RouteOwner
): RouteDeclaration {
  return { method, path, match, bodyPolicy, owner };
}

// Single source of truth for route ownership. Every method and path the canvas
// server answers is declared exactly once, in the order the legacy dispatcher
// tested them.
export const SERVER_ROUTE_DECLARATIONS: readonly RouteDeclaration[] = [
  declare("ANY", "/api/ping", "exact", "none", "liveness-source"),
  declare("GET", "/api/operations", "exact", "none", "operations-status"),
  declare("GET", "/api/operations/", "prefix", "none", "operations-status"),
  declare("POST", "/api/open-source", "exact", "json", "liveness-source"),
  declare("POST", "/api/oidc", "exact", "json", "identity-credentials"),
  declare(
    "POST",
    "/api/verify-azure-login",
    "exact",
    "json",
    "identity-credentials"
  ),
  declare(
    "POST",
    "/api/azure-cli-assist",
    "exact",
    "json",
    "identity-credentials"
  ),
  declare(
    "POST",
    "/api/verify-aws-login",
    "exact",
    "json",
    "identity-credentials"
  ),
  declare(
    "GET",
    "/api/credential-profiles",
    "exact",
    "none",
    "identity-credentials"
  ),
  declare(
    "GET",
    "/api/github-identity",
    "exact",
    "none",
    "identity-credentials"
  ),
  declare(
    "POST",
    "/api/github-account",
    "exact",
    "json",
    "identity-credentials"
  ),
  declare(
    "POST",
    "/api/save-credential-profile",
    "exact",
    "json",
    "identity-credentials"
  ),
  declare(
    "POST",
    "/api/delete-credential-profile",
    "exact",
    "json",
    "identity-credentials"
  ),
  declare("POST", "/api/delete-environment", "exact", "json", "environments"),
  declare("POST", "/api/operations", "exact", "json", "operations-status"),
  declare("POST", "/api/azure-auto-setup", "exact", "json", "azure-discovery"),
  declare(
    "GET",
    "/api/list-azure-app-registrations",
    "exact",
    "none",
    "azure-discovery"
  ),
  declare(
    "GET",
    "/api/azure-app-serves-repos",
    "exact",
    "none",
    "azure-discovery"
  ),
  declare("POST", "/api/app-params", "exact", "json", "environments"),
  declare("POST", "/api/create-environment", "exact", "json", "environments"),
  declare("GET", "/api/load-graph-stream", "exact", "none", "graphs-planning"),
  declare("GET", "/api/progress", "exact", "none", "graphs-planning"),
  declare("GET", "/api/deployed-graph", "exact", "none", "graphs-planning"),
  declare("GET", "/api/deploy-status", "exact", "none", "deployments"),
  declare("POST", "/api/load-graph", "exact", "json", "graphs-planning"),
  declare("GET", "/api/list-environments", "exact", "none", "environments"),
  declare("GET", "/api/list-applications", "exact", "none", "deployments"),
  declare("GET", "/api/list-deployments", "exact", "none", "deployments"),
  declare("POST", "/api/delete-deployment", "exact", "json", "deployments"),
  declare("GET", "/api/verify-status", "exact", "none", "environments"),
  declare("GET", "/api/user-repos", "exact", "none", "repositories"),
  declare("POST", "/api/repo-branches", "exact", "json", "repositories"),
  declare("POST", "/api/plan-graph", "exact", "json", "graphs-planning"),
  declare("POST", "/api/discover-branches", "exact", "json", "repositories"),
  declare("POST", "/api/diff-branches", "exact", "json", "graphs-planning"),
  declare("POST", "/api/deploy", "exact", "json", "deployments"),
  declare("POST", "/api/deploy-reset", "exact", "none", "deployments"),
  declare("POST", "/api/discover", "exact", "json", "azure-discovery")
];

// Routes whose owner module already answers the request. Everything else is
// still served by the temporary legacy fallback in `server.ts`; this list is the
// migration ledger the boundary test enforces after every slice.
export const MIGRATED_ROUTE_KEYS: readonly string[] = [
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
  "GET /api/list-azure-app-registrations",
  "GET /api/azure-app-serves-repos",
  "GET /api/user-repos",
  "POST /api/repo-branches",
  "POST /api/discover-branches",
  "GET /api/deploy-status",
  "GET /api/list-applications",
  "GET /api/list-deployments",
  "POST /api/deploy-reset",
  "POST /api/delete-deployment",
  "GET /api/progress",
  "GET /api/deployed-graph",
  "POST /api/discover"
];

export function routeKey(
  route: Pick<RouteDeclaration, "method" | "path">
): string {
  return `${route.method} ${route.path}`;
}

export const LEGACY_ROUTE_INVENTORY = Object.freeze(
  SERVER_ROUTE_DECLARATIONS.map(routeKey).filter(
    (key) => !MIGRATED_ROUTE_KEYS.includes(key)
  )
);

export function createServerRouteTable(
  handlers: RouteHandlerRegistry
): readonly ServerRoute[] {
  const routes = SERVER_ROUTE_DECLARATIONS.map<ServerRoute>((declaration) => {
    const key = routeKey(declaration);
    if (!MIGRATED_ROUTE_KEYS.includes(key)) {
      return { ...declaration, migration: "legacy", handler: null };
    }
    const handler = handlers[key];
    if (!handler) {
      throw new Error(`Missing handler for migrated server route: ${key}`);
    }
    return { ...declaration, migration: "migrated", handler };
  });
  assertRouteTable(routes);
  return routes;
}

export function matchRoute(
  routes: readonly ServerRoute[],
  method: string | undefined,
  pathname: string
): ServerRoute | undefined {
  const normalizedMethod = String(method || "").toUpperCase();
  return routes.find(
    (route) =>
      (route.method === "ANY" || route.method === normalizedMethod) &&
      (route.match === "prefix" ?
        pathname.startsWith(route.path)
      : pathname === route.path)
  );
}

function methodsOverlap(a: RouteMethod, b: RouteMethod): boolean {
  return a === "ANY" || b === "ANY" || a === b;
}

export function assertRouteTable(routes: readonly ServerRoute[]): void {
  const seen = new Set<string>();
  // `matchRoute` takes the first declaration that matches, mirroring the legacy
  // if-chain. That makes a route unreachable when an earlier prefix route
  // covers its path on an overlapping method, so reject the ordering at
  // construction instead of ranking exact over prefix at dispatch time.
  const precedingPrefixes: ServerRoute[] = [];
  for (const route of routes) {
    const key = routeKey(route);
    if (seen.has(key)) throw new Error(`Duplicate server route: ${key}`);
    seen.add(key);
    const shadow = precedingPrefixes.find(
      (prefix) =>
        methodsOverlap(prefix.method, route.method) &&
        route.path.startsWith(prefix.path)
    );
    if (shadow) {
      throw new Error(
        `Server route ${key} is unreachable behind earlier prefix route ${routeKey(shadow)}`
      );
    }
    if (route.match === "prefix") precedingPrefixes.push(route);
    if (!route.owner) throw new Error(`Unowned server route: ${key}`);
    if (route.migration === "migrated" && !route.handler) {
      throw new Error(`Migrated server route has no handler: ${key}`);
    }
    if (route.migration === "legacy" && route.handler) {
      throw new Error(`Legacy server route unexpectedly has a handler: ${key}`);
    }
  }
}
