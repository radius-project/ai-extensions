// Deterministic fixtures for the functional scenarios: one small containerized
// application on two branches, in the exact shapes the product's boundaries
// produce — a rad `app-graph.json` payload and the authored `.radius/app.bicep`.

export const REPO = "acme/storefront";
export const BASE_BRANCH = "main";
export const HEAD_BRANCH = "add-cache";

export function contentsPath(
  repo: string,
  path: string,
  branch: string
): string {
  return `/repos/${repo}/contents/${path}?ref=${branch}`;
}

export function radiusResourceId(type: string, name: string): string {
  return `/planes/radius/local/resourcegroups/default/providers/${type}/${name}`;
}

export const API_ID = radiusResourceId("Radius.Compute/containers", "api");
export const DB_ID = radiusResourceId(
  "Radius.Data/postgreSqlDatabases",
  "orders"
);
export const CACHE_ID = radiusResourceId("Radius.Data/redisCaches", "sessions");
export const IMAGE_ID = radiusResourceId(
  "Radius.Compute/containerImages",
  "apiImage"
);
export const REGISTRY_SECRET_ID = radiusResourceId(
  "Radius.Security/secrets",
  "radius-ghcr-registry-creds"
);

function hash(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}

export const APP_BICEP = `extension radius

param environment string

resource api 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'api'
  properties: {
    application: application
    environment: environment
  }
}

resource orders 'Radius.Data/postgreSqlDatabases@2025-08-01-preview' = {
  name: 'orders'
  properties: {
    environment: environment
  }
}
`;

export const APP_BICEP_WITH_CACHE = `${APP_BICEP}
resource sessions 'Radius.Data/redisCaches@2025-08-01-preview' = {
  name: 'sessions'
  properties: {
    environment: environment
  }
}
`;

// A rad `app-graph.json` payload: the container builds an image, pushes it with
// the reserved registry-creds secret, and connects to a database. The cache is
// only present on the head branch.
export function appGraphPayload(options: { withCache: boolean }) {
  const resources: any[] = [
    {
      id: API_ID,
      name: "api",
      type: "Radius.Compute/containers",
      provisioningState: "Succeeded",
      connections: [
        { id: DB_ID, direction: "Outbound" },
        { id: IMAGE_ID, direction: "Outbound" },
        ...(options.withCache ? [{ id: CACHE_ID, direction: "Outbound" }] : [])
      ],
      outputResources: [],
      // Deliberately identical across both variants: `computeGraphDiff` compares
      // connections *and* diffHash, so varying the hash alongside the cache edge
      // would let the "modified" assertion in branch-diff.test.ts pass even if
      // connection diffing were broken. A hash-only edit is covered separately by
      // the unit tests in graph/diff.test.ts.
      diffHash: hash("a"),
      properties: { codeReference: "src/api/index.ts#L1" }
    },
    {
      id: DB_ID,
      name: "orders",
      type: "Radius.Data/postgreSqlDatabases",
      provisioningState: "Succeeded",
      connections: [],
      outputResources: [],
      diffHash: hash("b")
    },
    {
      id: IMAGE_ID,
      name: "apiImage",
      type: "Radius.Compute/containerImages",
      provisioningState: "Succeeded",
      connections: [{ id: REGISTRY_SECRET_ID, direction: "Outbound" }],
      outputResources: [],
      diffHash: hash("c")
    },
    {
      id: REGISTRY_SECRET_ID,
      name: "radius-ghcr-registry-creds",
      type: "Radius.Security/secrets",
      provisioningState: "Succeeded",
      connections: [],
      outputResources: [],
      diffHash: hash("d")
    }
  ];

  if (options.withCache) {
    resources.push({
      id: CACHE_ID,
      name: "sessions",
      type: "Radius.Data/redisCaches",
      provisioningState: "Succeeded",
      connections: [],
      outputResources: [],
      diffHash: hash("e")
    });
  }

  return { resources };
}

// The Azure (AKS) recipe pack, in the committed pack's shape.
export const AZURE_RECIPE_PACK = `extension radius

resource azureRecipePack 'Radius.Core/recipePacks@2025-08-01-preview' = {
  name: 'azure-avm'
  properties: {
    recipes: {
      'Radius.Compute/containers': {
        kind: 'bicep'
        source: 'ghcr.io/radius-project/kube-recipes/containers:latest'
      }
      'Radius.Data/postgreSqlDatabases': {
        kind: 'bicep'
        source: 'mcr.microsoft.com/bicep/avm/res/db-for-postgre-sql/flexible-server:0.11.0'
        parameters: {
          name: '{{context.resource.name}}'
        }
      }
      'Radius.Data/redisCaches': {
        kind: 'bicep'
        source: 'mcr.microsoft.com/bicep/avm/res/cache/redis-enterprise:0.5.1'
      }
      'Radius.Security/secrets': {
        kind: 'bicep'
        source: 'ghcr.io/radius-project/kube-recipes/secrets:latest'
      }
    }
  }
}
`;

// The kubernetes default recipe pack, in the committed pack's shape. The same
// container recipe materializes as a plain Deployment here, which is what makes
// the provider-scoped override observable end to end.
export const KUBERNETES_RECIPE_PACK = `extension radius

resource defaultRecipePack 'Radius.Core/recipePacks@2025-08-01-preview' = {
  name: 'default'
  properties: {
    recipes: {
      'Radius.Compute/containers': {
        kind: 'bicep'
        source: 'ghcr.io/radius-project/kube-recipes/containers:latest'
      }
      'Radius.Data/redisCaches': {
        kind: 'bicep'
        source: 'ghcr.io/radius-project/kube-recipes/rediscaches:latest'
      }
      'Radius.Security/secrets': {
        kind: 'bicep'
        source: 'ghcr.io/radius-project/kube-recipes/secrets:latest'
      }
    }
  }
}
`;
