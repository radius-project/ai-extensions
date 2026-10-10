export interface ModelingCase {
  id: string;
  request: string;
  environment: {
    name?: string;
    contractSupplied: boolean;
    registration: "not-supplied" | "verified";
  };
  recipe: "azure" | "unavailable";
  expected: {
    status: "ready" | "blocked";
    blocker: "none" | "registration" | "recipe_behavior";
  };
}

export const MODELING_CASES: readonly ModelingCase[] = [
  {
    id: "no-environment",
    request: "Show me the app graph. No deployment Environment is selected.",
    environment: { contractSupplied: false, registration: "not-supplied" },
    recipe: "azure",
    expected: { status: "ready", blocker: "none" }
  },
  {
    id: "named-registered",
    request: "Model the application for the named Environment eval-azure.",
    environment: {
      name: "eval-azure",
      contractSupplied: true,
      registration: "verified"
    },
    recipe: "azure",
    expected: { status: "ready", blocker: "none" }
  },
  {
    id: "named-unverified",
    request: "Model the application for the named Environment eval-azure.",
    environment: {
      name: "eval-azure",
      contractSupplied: false,
      registration: "not-supplied"
    },
    recipe: "azure",
    expected: { status: "blocked", blocker: "registration" }
  },
  {
    id: "contract-without-name",
    request:
      "Use the supplied Environment contract. Its name and registration evidence are not supplied.",
    environment: { contractSupplied: true, registration: "not-supplied" },
    recipe: "azure",
    expected: { status: "blocked", blocker: "registration" }
  },
  {
    id: "aws-with-azure-evidence",
    request:
      "Model for an explicit AWS Recipe profile. Only Azure Recipe evidence is supplied; no AWS Recipe behavior evidence is available.",
    environment: { contractSupplied: false, registration: "not-supplied" },
    recipe: "azure",
    expected: { status: "blocked", blocker: "recipe_behavior" }
  },
  {
    id: "recipe-unavailable",
    request: "Show me the app graph. No deployment Environment is selected.",
    environment: { contractSupplied: false, registration: "not-supplied" },
    recipe: "unavailable",
    expected: { status: "blocked", blocker: "recipe_behavior" }
  }
];

export function modelingEnvironment(testCase: ModelingCase) {
  const type = "Radius.Compute/containers";
  const redisType = "Radius.Data/redisCaches";
  return {
    ...testCase.environment,
    contract:
      testCase.environment.contractSupplied ?
        {
          recipeSelections: {
            [type]: {
              recipePack: "azure-avm",
              profile: "managed-default-azure"
            },
            [redisType]: {
              recipePack: "azure-avm",
              profile: "managed-default-azure"
            }
          },
          registrations:
            testCase.environment.registration === "verified" ?
              [type, redisType].map((resourceType) => ({
                environment: testCase.environment.name,
                type: resourceType,
                recipePack: "azure-avm",
                profile: "managed-default-azure",
                matchesResolvedRecipe: true,
                evidence: "Controlled Environment registration record."
              }))
            : null
        }
      : null
  };
}

export function modelingEvidence(testCase: ModelingCase) {
  return {
    environment: modelingEnvironment(testCase),
    contractVersion: 1,
    resources: [
      {
        type: "Radius.Compute/containers",
        apiVersion: "2025-08-01-preview",
        schema: {
          type: "object",
          required: ["properties"],
          properties: {
            properties: {
              type: "object",
              required: ["application", "container"],
              properties: {
                application: { type: "string" },
                container: {
                  type: "object",
                  required: ["image"],
                  properties: { image: { type: "string" } }
                }
              }
            }
          }
        },
        recipe:
          testCase.recipe === "azure" ?
            {
              status: "available",
              profile: "managed-default-azure",
              recipePack: "azure-avm",
              definition:
                "param context object\nparam resource object\noutput result object = {\n  values: {}\n  secrets: {}\n}\n",
              behavior:
                "Compatible container runtime with explicit REDIS_URL environment binding. The Container Recipe needs no generated outputs, credentials, or omitted Recipe inputs. All Recipe inputs are supplied."
            }
          : {
              status: "unavailable",
              message:
                "Controlled fixture: required Recipe behavior is unavailable."
            }
      },
      {
        type: "Radius.Data/redisCaches",
        apiVersion: "2025-08-01-preview",
        schema: {
          properties: {
            properties: {
              properties: { url: { type: "string", readOnly: true } }
            }
          }
        },
        recipe:
          testCase.recipe === "azure" ?
            {
              status: "available",
              recipePack: "azure-avm",
              profile: "managed-default-azure",
              definition:
                "param context object\nparam resource object\noutput result object = {\n  values: { url: 'redis://redis.fixture:6379' }\n  secrets: {}\n}\n",
              behavior:
                "Controlled Redis Recipe: unauthenticated plain Redis protocol, port 6379. result.values.url maps to properties.url. All inputs supplied; no omitted inputs or credentials."
            }
          : {
              status: "unavailable",
              message:
                "Controlled fixture: required Redis Recipe behavior is unavailable."
            },
        requiredConsumer: {
          source: "app uses REDIS_URL with a redis:// URL parser",
          binding: "redis.properties.url",
          protocolCompatibility: "verified",
          tls: "not required",
          authentication: "not required",
          mapping: "result.values.url -> properties.url -> REDIS_URL"
        }
      }
    ],
    notFound: []
  };
}
