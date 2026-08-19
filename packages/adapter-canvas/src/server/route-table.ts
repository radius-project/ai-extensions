import type { CanvasRequestContext } from "./request-context.js";

export type RouteMethod = "ANY" | "GET" | "POST";
export type RouteMatcher = "exact" | "prefix" | "template";
export type RouteBodyPolicy = "none" | "json";
export type RouteMutationPolicy = "none" | "nonce-required" | "legacy-exempt";
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
  mutationPolicy: RouteMutationPolicy;
  owner: RouteOwner;
}

export type ServerRoute = RouteDeclaration & {
  handler: RouteHandler;
};

function declare(
  method: RouteMethod,
  path: string,
  match: RouteMatcher,
  bodyPolicy: RouteBodyPolicy,
  owner: RouteOwner,
  mutationPolicy: RouteMutationPolicy = method === "POST" ? "nonce-required" : (
    "none"
  )
): RouteDeclaration {
  return { method, path, match, bodyPolicy, mutationPolicy, owner };
}

function legacyPost(
  path: string,
  match: RouteMatcher,
  bodyPolicy: RouteBodyPolicy,
  owner: RouteOwner
): RouteDeclaration {
  return declare("POST", path, match, bodyPolicy, owner, "legacy-exempt");
}

interface CompiledRouteTemplate {
  pattern: RegExp;
  parameterNames: readonly string[];
}

const TEMPLATE_PARAMETER = /^:([A-Za-z][A-Za-z0-9]*)$/;

function compileRouteTemplate(template: string): CompiledRouteTemplate {
  const parameterNames: string[] = [];
  const pattern = template
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) {
        return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
      const parameter = TEMPLATE_PARAMETER.exec(segment);
      if (!parameter) {
        throw new Error(`Invalid server route template segment: ${segment}`);
      }
      const name = parameter[1];
      if (parameterNames.includes(name)) {
        throw new Error(`Duplicate server route template parameter: ${name}`);
      }
      parameterNames.push(name);
      return "([^/]+)";
    })
    .join("/");
  if (parameterNames.length === 0) {
    throw new Error(`Server route template has no parameters: ${template}`);
  }
  return {
    pattern: new RegExp(`^${pattern}$`),
    parameterNames
  };
}

export const templatePathParameters = (() => {
  const cache = new Map<string, CompiledRouteTemplate>();
  return (
    template: string,
    pathname: string
  ): Readonly<Record<string, string>> | undefined => {
    let compiled = cache.get(template);
    if (!compiled) {
      compiled = compileRouteTemplate(template);
      cache.set(template, compiled);
    }
    const match = compiled.pattern.exec(pathname);
    if (!match) return undefined;
    return Object.freeze(
      Object.fromEntries(
        compiled.parameterNames.map((name, index) => [name, match[index + 1]])
      )
    );
  };
})();

// Single source of truth for route ownership. Every method and path the canvas
// server answers is declared exactly once, in the order the legacy dispatcher
// tested them.
export const SERVER_ROUTE_DECLARATIONS: readonly RouteDeclaration[] = [
  declare("ANY", "/api/ping", "exact", "none", "liveness-source"),
  declare("GET", "/api/operations", "exact", "none", "operations-status"),
  declare("GET", "/api/operations/", "prefix", "none", "operations-status"),
  legacyPost("/api/open-source", "exact", "json", "liveness-source"),
  legacyPost(
    "/api/verify-azure-login",
    "exact",
    "json",
    "identity-credentials"
  ),
  legacyPost("/api/azure-cli-assist", "exact", "json", "identity-credentials"),
  legacyPost("/api/verify-aws-login", "exact", "json", "identity-credentials"),
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
  legacyPost(
    "/api/save-credential-profile",
    "exact",
    "json",
    "identity-credentials"
  ),
  legacyPost(
    "/api/delete-credential-profile",
    "exact",
    "json",
    "identity-credentials"
  ),
  legacyPost("/api/delete-environment", "exact", "json", "environments"),
  declare("POST", "/api/operations", "exact", "json", "operations-status"),
  legacyPost("/api/azure-auto-setup", "exact", "json", "azure-discovery"),
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
  legacyPost("/api/app-params", "exact", "json", "environments"),
  legacyPost("/api/create-environment", "exact", "json", "environments"),
  declare("GET", "/api/load-graph-stream", "exact", "none", "graphs-planning"),
  declare("GET", "/api/progress", "exact", "none", "graphs-planning"),
  declare("GET", "/api/deployed-graph", "exact", "none", "graphs-planning"),
  declare("GET", "/api/deploy-status", "exact", "none", "deployments"),
  legacyPost("/api/load-graph", "exact", "json", "graphs-planning"),
  declare("GET", "/api/list-environments", "exact", "none", "environments"),
  declare("GET", "/api/list-applications", "exact", "none", "deployments"),
  declare("GET", "/api/list-deployments", "exact", "none", "deployments"),
  legacyPost("/api/delete-deployment", "exact", "json", "deployments"),
  declare("POST", "/api/abandon-deployment", "exact", "json", "deployments"),
  declare("GET", "/api/verify-status", "exact", "none", "environments"),
  declare("GET", "/api/user-repos", "exact", "none", "repositories"),
  legacyPost("/api/repo-branches", "exact", "json", "repositories"),
  legacyPost("/api/plan-graph", "exact", "json", "graphs-planning"),
  legacyPost("/api/discover-branches", "exact", "json", "repositories"),
  legacyPost("/api/diff-branches", "exact", "json", "graphs-planning"),
  legacyPost("/api/deploy", "exact", "json", "deployments"),
  legacyPost("/api/deploy-reset", "exact", "none", "deployments"),
  legacyPost("/api/discover", "exact", "json", "azure-discovery"),
  declare(
    "POST",
    "/api/operations/:operationId/resume/:code",
    "template",
    "json",
    "operations-status"
  ),
  declare(
    "POST",
    "/api/operations/:operationId/abandon",
    "template",
    "none",
    "operations-status"
  ),
  // Cooperative controls in the same family: a durable stop request, the two
  // first-choice commands after a stop, and the three retries. All carry the
  // operation id mid-path, so they are template routes like the two above, and
  // all stay method-disjoint from the family's `GET /api/operations/` prefix
  // read.
  declare(
    "POST",
    "/api/operations/:operationId/stop",
    "template",
    "json",
    "operations-status"
  ),
  // Continue and rollback are separate typed routes rather than a mode on the
  // retry route: they have opposite intent, opposite eligibility, and only one
  // of them may ever run for a given saved record.
  declare(
    "POST",
    "/api/operations/:operationId/continue",
    "template",
    "json",
    "operations-status"
  ),
  declare(
    "POST",
    "/api/operations/:operationId/rollback",
    "template",
    "json",
    "operations-status"
  ),
  // Leaving a setup behind is its own command, not a rollback with different
  // copy: it closes the record the panel is reporting, and it removes the
  // disposable artifacts this attempt created only as a consequence of that.
  declare(
    "POST",
    "/api/operations/:operationId/exit",
    "template",
    "json",
    "operations-status"
  ),
  declare(
    "POST",
    "/api/operations/:operationId/retry/:retryKind",
    "template",
    "json",
    "operations-status"
  )
];

export function routeKey(
  route: Pick<RouteDeclaration, "method" | "path">
): string {
  return `${route.method} ${route.path}`;
}

export function createServerRouteTable(
  handlers: RouteHandlerRegistry
): readonly ServerRoute[] {
  const declarationKeys = new Set(SERVER_ROUTE_DECLARATIONS.map(routeKey));
  for (const key of Object.keys(handlers)) {
    if (!declarationKeys.has(key)) {
      throw new Error(`Handler registered for undeclared server route: ${key}`);
    }
  }
  const routes = SERVER_ROUTE_DECLARATIONS.map<ServerRoute>((declaration) => {
    const key = routeKey(declaration);
    const handler = handlers[key];
    if (!handler) {
      throw new Error(`Missing handler for server route: ${key}`);
    }
    return { ...declaration, handler };
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
      (route.match === "prefix" ? pathname.startsWith(route.path)
      : route.match === "template" ?
        templatePathParameters(route.path, pathname) !== undefined
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
  // Templates shadow by shape rather than by prefix: they match a fixed segment
  // count, so only a later concrete path with the same shape can disappear
  // behind one.
  const precedingTemplates: ServerRoute[] = [];
  for (const route of routes) {
    const key = routeKey(route);
    if (seen.has(key)) throw new Error(`Duplicate server route: ${key}`);
    seen.add(key);
    const shadow =
      precedingPrefixes.find(
        (prefix) =>
          methodsOverlap(prefix.method, route.method) &&
          route.path.startsWith(prefix.path)
      ) ||
      (route.match === "exact" ?
        precedingTemplates.find(
          (template) =>
            methodsOverlap(template.method, route.method) &&
            templatePathParameters(template.path, route.path) !== undefined
        )
      : undefined);
    if (shadow) {
      throw new Error(
        `Server route ${key} is unreachable behind earlier prefix route ${routeKey(shadow)}`
      );
    }
    if (route.match === "prefix") precedingPrefixes.push(route);
    if (route.match === "template") {
      compileRouteTemplate(route.path);
      precedingTemplates.push(route);
    }
    if (route.method === "POST" && route.mutationPolicy === "none") {
      throw new Error(`POST server route has no mutation policy: ${key}`);
    }
    if (route.method !== "POST" && route.mutationPolicy !== "none") {
      throw new Error(
        `Non-POST server route declares a mutation policy: ${key}`
      );
    }
    if (!route.owner) throw new Error(`Unowned server route: ${key}`);
    if (typeof route.handler !== "function") {
      throw new Error(`Server route has no handler: ${key}`);
    }
  }
}
