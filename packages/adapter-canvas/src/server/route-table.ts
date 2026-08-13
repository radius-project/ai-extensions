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

interface RouteMetadata {
  method: RouteMethod;
  path: string;
  match: RouteMatcher;
  bodyPolicy: RouteBodyPolicy;
  owner: RouteOwner;
}

export type ServerRoute =
  | (RouteMetadata & {
      migration: "legacy";
      handler: null;
    })
  | (RouteMetadata & {
      migration: "migrated";
      handler: RouteHandler;
    });

function legacy(
  method: RouteMethod,
  path: string,
  match: RouteMatcher,
  bodyPolicy: RouteBodyPolicy,
  owner: RouteOwner
): ServerRoute {
  return {
    method,
    path,
    match,
    bodyPolicy,
    owner,
    migration: "legacy",
    handler: null
  };
}

export const SERVER_ROUTE_TABLE: readonly ServerRoute[] = [
  legacy("ANY", "/api/ping", "exact", "none", "liveness-source"),
  legacy("GET", "/api/operations", "exact", "none", "operations-status"),
  legacy("GET", "/api/operations/", "prefix", "none", "operations-status"),
  legacy("POST", "/api/open-source", "exact", "json", "liveness-source"),
  legacy("POST", "/api/oidc", "exact", "json", "identity-credentials"),
  legacy(
    "POST",
    "/api/verify-azure-login",
    "exact",
    "json",
    "identity-credentials"
  ),
  legacy(
    "POST",
    "/api/azure-cli-assist",
    "exact",
    "json",
    "identity-credentials"
  ),
  legacy(
    "POST",
    "/api/verify-aws-login",
    "exact",
    "json",
    "identity-credentials"
  ),
  legacy(
    "GET",
    "/api/credential-profiles",
    "exact",
    "none",
    "identity-credentials"
  ),
  legacy(
    "GET",
    "/api/github-identity",
    "exact",
    "none",
    "identity-credentials"
  ),
  legacy(
    "POST",
    "/api/github-account",
    "exact",
    "json",
    "identity-credentials"
  ),
  legacy(
    "POST",
    "/api/save-credential-profile",
    "exact",
    "json",
    "identity-credentials"
  ),
  legacy(
    "POST",
    "/api/delete-credential-profile",
    "exact",
    "json",
    "identity-credentials"
  ),
  legacy("POST", "/api/delete-environment", "exact", "json", "environments"),
  legacy("POST", "/api/azure-auto-setup", "exact", "json", "azure-discovery"),
  legacy(
    "GET",
    "/api/list-azure-app-registrations",
    "exact",
    "none",
    "azure-discovery"
  ),
  legacy(
    "GET",
    "/api/azure-app-serves-repos",
    "exact",
    "none",
    "azure-discovery"
  ),
  legacy("POST", "/api/app-params", "exact", "json", "environments"),
  legacy("POST", "/api/create-environment", "exact", "json", "environments"),
  legacy("GET", "/api/load-graph-stream", "exact", "none", "graphs-planning"),
  legacy("GET", "/api/progress", "exact", "none", "graphs-planning"),
  legacy("GET", "/api/deployed-graph", "exact", "none", "graphs-planning"),
  legacy("GET", "/api/deploy-status", "exact", "none", "deployments"),
  legacy("POST", "/api/load-graph", "exact", "json", "graphs-planning"),
  legacy("GET", "/api/list-environments", "exact", "none", "environments"),
  legacy("GET", "/api/list-applications", "exact", "none", "deployments"),
  legacy("GET", "/api/list-deployments", "exact", "none", "deployments"),
  legacy("POST", "/api/delete-deployment", "exact", "json", "deployments"),
  legacy("GET", "/api/verify-status", "exact", "none", "environments"),
  legacy("GET", "/api/user-repos", "exact", "none", "repositories"),
  legacy("POST", "/api/repo-branches", "exact", "json", "repositories"),
  legacy("POST", "/api/plan-graph", "exact", "json", "graphs-planning"),
  legacy("POST", "/api/discover-branches", "exact", "json", "repositories"),
  legacy("POST", "/api/diff-branches", "exact", "json", "graphs-planning"),
  legacy("POST", "/api/deploy", "exact", "json", "deployments"),
  legacy("POST", "/api/deploy-reset", "exact", "none", "deployments"),
  legacy("POST", "/api/discover", "exact", "json", "azure-discovery")
];

export function routeKey(route: Pick<ServerRoute, "method" | "path">): string {
  return `${route.method} ${route.path}`;
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

export function assertRouteTable(routes: readonly ServerRoute[]): void {
  const seen = new Set<string>();
  for (const route of routes) {
    const key = routeKey(route);
    if (seen.has(key)) throw new Error(`Duplicate server route: ${key}`);
    seen.add(key);
    if (!route.owner) throw new Error(`Unowned server route: ${key}`);
    if (route.migration === "migrated" && !route.handler) {
      throw new Error(`Migrated server route has no handler: ${key}`);
    }
    if (route.migration === "legacy" && route.handler) {
      throw new Error(`Legacy server route unexpectedly has a handler: ${key}`);
    }
  }
}

export const LEGACY_ROUTE_INVENTORY = Object.freeze(
  SERVER_ROUTE_TABLE.filter((route) => route.migration === "legacy").map(
    routeKey
  )
);
