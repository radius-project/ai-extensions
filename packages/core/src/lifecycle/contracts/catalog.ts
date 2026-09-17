import type { FromSchema, JSONSchema } from "json-schema-to-ts";
import {
  DRAFT_07,
  LIFECYCLE_OPERATIONS,
  actionResponseSchema,
  canonicalGraphSchema,
  definitionPathSchema,
  definitionProposalSchema,
  diagnosticsSchema,
  gitSourceSchema,
  handleSchema,
  lifecycleErrorSchema,
  nameSchema,
  observationSchema,
  operationRecordSchema,
  providerSchema,
  recipeRegistrationSchema,
  repositorySchema,
  requiredActionSchema,
  resolvedSourceSchema,
  sourceSchema,
  targetSchema,
  textSchema,
  timestampSchema,
  validationReportSchema,
  workspaceSourceSchema
} from "./common.js";

export const PAGE_SIZE_MIN = 1;
export const PAGE_SIZE_MAX = 100;
export const paginationSchema = {
  type: "object",
  additionalProperties: false,
  description:
    "Optional integer pageSize is 1 through 100 inclusive. Omission delegates page size to the service, not schema default injection. Continuation tokens bind to caller scope and unchanged filters.",
  properties: {
    pageSize: {
      type: "integer",
      minimum: PAGE_SIZE_MIN,
      maximum: PAGE_SIZE_MAX
    },
    continuationToken: handleSchema
  }
} as const;
export const repairPolicySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: { enum: ["manual", "automatic"] },
    maxAttempts: {
      type: "integer",
      minimum: 0,
      maximum: 5,
      description:
        "At most five repairs, independent of handoff delivery retries. Zero disables repair."
    }
  },
  required: ["mode", "maxAttempts"]
} as const;
export type RepairPolicy = FromSchema<typeof repairPolicySchema>;

const emptyInput = {
  type: "object",
  additionalProperties: false,
  properties: {}
} as const;
const repositoryTarget = {
  type: "object",
  additionalProperties: false,
  properties: { repo: repositorySchema },
  required: ["repo"]
} as const;
const scopedTarget = {
  ...repositoryTarget,
  properties: { ...repositoryTarget.properties, environment: nameSchema }
} as const;
const environmentTarget = {
  ...scopedTarget,
  required: ["repo", "environment"]
} as const;
const operationTarget = {
  ...scopedTarget,
  properties: { ...scopedTarget.properties, application: nameSchema }
} as const;
const applicationTarget = {
  ...operationTarget,
  required: ["repo", "environment", "application"]
} as const;
const definitionTarget = {
  ...repositoryTarget,
  properties: {
    repo: repositorySchema,
    source: sourceSchema,
    definition: definitionPathSchema
  },
  required: ["repo", "source", "definition"]
} as const;
const workspaceDefinitionTarget = {
  ...definitionTarget,
  properties: { ...definitionTarget.properties, source: workspaceSourceSchema }
} as const;
const plannedTarget = {
  ...definitionTarget,
  properties: { ...definitionTarget.properties, environment: nameSchema },
  required: ["repo", "source", "definition", "environment"]
} as const;
const deploymentTarget = {
  ...applicationTarget,
  properties: {
    ...applicationTarget.properties,
    source: gitSourceSchema,
    definition: definitionPathSchema
  },
  required: ["repo", "environment", "application", "source", "definition"]
} as const;
const authoredApplicationTarget = {
  ...definitionTarget,
  properties: { ...definitionTarget.properties, application: nameSchema },
  required: ["repo", "source", "definition", "application"]
} as const;
const inspectionTarget = {
  oneOf: [
    authoredApplicationTarget,
    applicationTarget,
    {
      ...authoredApplicationTarget,
      properties: {
        ...authoredApplicationTarget.properties,
        environment: nameSchema
      },
      required: ["repo", "source", "definition", "application", "environment"]
    }
  ]
} as const;

const azureSettings = {
  type: "object",
  additionalProperties: false,
  properties: {
    subscriptionId: handleSchema,
    resourceGroup: nameSchema,
    location: nameSchema
  }
} as const;
const awsSettings = {
  type: "object",
  additionalProperties: false,
  properties: {
    accountId: { type: "string", pattern: "^\\d{12}$" },
    region: nameSchema,
    roleName: nameSchema
  }
} as const;
const recipeReference = {
  ...recipeRegistrationSchema,
  properties: {
    resourceType: {
      type: "string",
      pattern: "^[A-Za-z][A-Za-z0-9.]*/[A-Za-z][A-Za-z0-9]*$"
    },
    kind: { const: "bicep" },
    source: {
      type: "string",
      maxLength: 1024,
      pattern:
        "^br:[A-Za-z0-9.-]+(?::[0-9]{1,5})?/[a-z0-9]+(?:[._/-][a-z0-9]+)*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$",
      description:
        "Tagged OCI Bicep reference, never a local path, credential-bearing URL or executable command. Registry access is separately authorized."
    }
  }
} as const;
const configurationProperties = {
  identityRef: handleSchema,
  recipes: { type: "array", maxItems: 100, items: recipeReference }
} as const;
export const environmentConfigurationSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ...configurationProperties,
        provider: { const: "azure" },
        settings: {
          ...azureSettings,
          required: ["subscriptionId", "resourceGroup", "location"]
        }
      },
      required: ["provider", "settings", "identityRef", "recipes"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ...configurationProperties,
        provider: { const: "aws" },
        settings: {
          ...awsSettings,
          required: ["accountId", "region", "roleName"]
        }
      },
      required: ["provider", "settings", "identityRef", "recipes"]
    }
  ]
} as const;
export type EnvironmentConfiguration = FromSchema<
  typeof environmentConfigurationSchema
>;
const configurationPatch = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      minProperties: 2,
      properties: {
        ...configurationProperties,
        provider: { const: "azure" },
        settings: { ...azureSettings, minProperties: 1 }
      },
      required: ["provider"]
    },
    {
      type: "object",
      additionalProperties: false,
      minProperties: 2,
      properties: {
        ...configurationProperties,
        provider: { const: "aws" },
        settings: { ...awsSettings, minProperties: 1 }
      },
      required: ["provider"]
    }
  ]
} as const;
export type EnvironmentConfigurationPatch = FromSchema<
  typeof configurationPatch
>;

const envelopeProperties = {
  apiVersion: { const: "github-radius/v1" },
  requestId: handleSchema
} as const;

// These constructors only compose JSON data, preserving literal inference for
// each variant instead of expanding the entire catalog at every type use.
function request<
  const O extends string,
  const T extends JSONSchema,
  const I extends JSONSchema
>(operation: O, target: T, input: I) {
  return {
    ...DRAFT_07,
    type: "object",
    additionalProperties: false,
    properties: {
      ...envelopeProperties,
      operation: { const: operation },
      target,
      input
    },
    required: ["apiVersion", "requestId", "operation", "target", "input"]
  } as const;
}
function response<const O extends string, const R extends JSONSchema>(
  operation: O,
  result: R
) {
  return {
    ...DRAFT_07,
    type: "object",
    additionalProperties: false,
    properties: {
      ...envelopeProperties,
      operation: { const: operation },
      result,
      metadata: {
        type: "object",
        additionalProperties: { type: "string", maxLength: 4096 },
        description:
          "Non-authoritative additive metadata; never used to establish identity, approval or execution state."
      }
    },
    required: ["apiVersion", "requestId", "operation", "result"]
  } as const;
}

function accepted<
  const T extends JSONSchema,
  const S extends JSONSchema,
  const R extends readonly string[]
>(target: T, source: S, requiredSource: R) {
  const properties = {
    operationId: handleSchema,
    target,
    source,
    observation: observationSchema,
    requiredAction: requiredActionSchema
  } as const;
  return {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        properties: { ...properties, state: { enum: ["queued", "running"] } },
        required: [
          "operationId",
          "target",
          "state",
          "observation",
          ...requiredSource
        ]
      },
      {
        type: "object",
        additionalProperties: false,
        properties: { ...properties, state: { const: "action_required" } },
        required: [
          "operationId",
          "target",
          "state",
          "observation",
          "requiredAction",
          ...requiredSource
        ]
      }
    ]
  } as const;
}
const operationIdInput = {
  type: "object",
  additionalProperties: false,
  properties: { operationId: handleSchema },
  required: ["operationId"]
} as const;
const pageProperties = {
  target: operationTarget,
  continuationToken: handleSchema,
  observation: observationSchema
} as const;
const authoredEvidence = {
  type: "object",
  additionalProperties: false,
  properties: {
    provenance: resolvedSourceSchema,
    definition: definitionPathSchema,
    graph: canonicalGraphSchema,
    observation: observationSchema
  },
  required: ["provenance", "definition", "observation"]
} as const;
const deployedEvidence = {
  type: "object",
  additionalProperties: false,
  properties: {
    environment: nameSchema,
    graph: canonicalGraphSchema,
    operationId: handleSchema,
    observation: observationSchema
  },
  required: ["environment", "observation"]
} as const;
const applicationIdentity = {
  type: "object",
  additionalProperties: false,
  properties: { repo: repositorySchema, application: nameSchema },
  required: ["repo", "application"]
} as const;
const applicationItem = {
  type: "object",
  additionalProperties: false,
  properties: {
    target: applicationIdentity,
    authored: authoredEvidence,
    deployed: { type: "array", items: deployedEvidence },
    observation: observationSchema
  },
  required: ["target", "observation"]
} as const;
const environmentItem = {
  type: "object",
  additionalProperties: false,
  properties: {
    target: environmentTarget,
    provider: providerSchema,
    observation: observationSchema
  },
  required: ["target", "observation"]
} as const;
const environmentReadConfiguration = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        provider: { const: "azure" },
        settings: azureSettings,
        identityRef: handleSchema,
        recipes: {
          type: "array",
          maxItems: 100,
          items: recipeRegistrationSchema
        }
      },
      required: ["provider"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        provider: { const: "aws" },
        settings: awsSettings,
        identityRef: handleSchema,
        recipes: {
          type: "array",
          maxItems: 100,
          items: recipeRegistrationSchema
        }
      },
      required: ["provider"]
    }
  ]
} as const;
const graphProperties = {
  graph: canonicalGraphSchema,
  observation: observationSchema
} as const;
const authoredGraph = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...graphProperties,
    kind: { const: "authored" },
    target: definitionTarget,
    provenance: resolvedSourceSchema
  },
  required: ["kind", "target", "provenance", "graph", "observation"]
} as const;
const plannedGraph = {
  ...authoredGraph,
  properties: {
    ...authoredGraph.properties,
    kind: { const: "planned" },
    target: plannedTarget,
    enrichment: {
      type: "object",
      additionalProperties: false,
      properties: {
        recipes: { type: "array", items: recipeRegistrationSchema },
        observation: observationSchema
      },
      required: ["recipes", "observation"]
    }
  },
  required: [
    "kind",
    "target",
    "provenance",
    "graph",
    "observation",
    "enrichment"
  ]
} as const;
const deployedGraph = {
  ...authoredGraph,
  properties: {
    ...authoredGraph.properties,
    kind: { const: "deployed" },
    target: applicationTarget
  },
  required: ["kind", "target", "graph", "observation"]
} as const;
const diffSelection = {
  ...plannedTarget,
  properties: { ...plannedTarget.properties, application: nameSchema },
  required: ["repo", "source", "definition", "environment", "application"]
} as const;
const diffUnavailable = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { const: "unavailable" },
    source: { enum: ["base", "head", "both"] },
    reason: {
      enum: [
        "DEFINITION_NOT_FOUND",
        "SOURCE_UNAVAILABLE",
        "SOURCE_CHANGED",
        "FORBIDDEN",
        "CAPABILITY_UNAVAILABLE",
        "RESULT_UNAVAILABLE"
      ]
    },
    message: textSchema,
    observation: observationSchema
  },
  required: ["status", "source", "reason", "message", "observation"]
} as const;
const diffAvailable = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...graphProperties,
    status: { const: "available" },
    kind: { enum: ["authored", "planned", "deployed"] },
    base: resolvedSourceSchema,
    head: resolvedSourceSchema,
    baseTarget: targetSchema,
    headTarget: targetSchema
  },
  required: [
    "status",
    "kind",
    "base",
    "head",
    "baseTarget",
    "headTarget",
    "graph",
    "observation"
  ]
} as const;
const diffResult = {
  oneOf: [
    {
      ...diffAvailable,
      properties: {
        ...diffAvailable.properties,
        kind: { const: "authored" },
        baseTarget: definitionTarget,
        headTarget: definitionTarget
      }
    },
    {
      ...diffAvailable,
      properties: {
        ...diffAvailable.properties,
        kind: { const: "planned" },
        baseTarget: plannedTarget,
        headTarget: plannedTarget
      }
    },
    {
      ...diffAvailable,
      properties: {
        ...diffAvailable.properties,
        kind: { const: "deployed" },
        baseTarget: diffSelection,
        headTarget: diffSelection
      }
    },
    diffUnavailable
  ]
} as const;

function completedDefinition<
  const S extends "succeeded" | "failed" | "cancelled",
  const R extends readonly string[]
>(state: S, required: R) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      operationId: handleSchema,
      target: workspaceDefinitionTarget,
      source: resolvedSourceSchema.oneOf[0],
      state: { const: state },
      observation: observationSchema,
      proposal: definitionProposalSchema,
      error: lifecycleErrorSchema
    },
    required: [
      "operationId",
      "target",
      "source",
      "state",
      "observation",
      ...required
    ]
  } as const;
}
export const operationSchemas = {
  "application.delete": {
    request: request("application.delete", applicationTarget, {
      type: "object",
      additionalProperties: false,
      properties: { intent: { const: "delete" }, planRef: handleSchema },
      required: ["intent"]
    }),
    response: response(
      "application.delete",
      accepted(applicationTarget, resolvedSourceSchema, [])
    )
  },
  "application.inspect": {
    request: request("application.inspect", inspectionTarget, emptyInput),
    response: response("application.inspect", applicationItem)
  },
  "application.list": {
    request: request("application.list", scopedTarget, {
      ...paginationSchema,
      properties: {
        ...paginationSchema.properties,
        source: sourceSchema,
        definition: definitionPathSchema
      }
    }),
    response: response("application.list", {
      type: "object",
      additionalProperties: false,
      properties: {
        ...pageProperties,
        items: {
          type: "array",
          maxItems: PAGE_SIZE_MAX,
          items: applicationItem
        }
      },
      required: ["target", "items", "observation"]
    })
  },
  "capabilities.get": {
    request: request("capabilities.get", scopedTarget, emptyInput),
    response: response("capabilities.get", {
      type: "object",
      additionalProperties: false,
      properties: {
        target: scopedTarget,
        capabilities: {
          type: "array",
          maxItems: 21,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              operation: { enum: LIFECYCLE_OPERATIONS },
              apiVersion: envelopeProperties.apiVersion,
              contexts: {
                type: "array",
                minItems: 1,
                uniqueItems: true,
                items: { enum: ["workspace", "git", "environment", "session"] }
              },
              providers: {
                type: "array",
                uniqueItems: true,
                items: providerSchema
              },
              requiresAgent: { type: "boolean" },
              limitations: { type: "array", items: textSchema }
            },
            required: [
              "operation",
              "apiVersion",
              "contexts",
              "providers",
              "requiresAgent",
              "limitations"
            ]
          }
        },
        limitations: { type: "array", items: textSchema }
      },
      required: ["target", "capabilities", "limitations"]
    })
  },
  "credentials.configure": {
    request: request("credentials.configure", scopedTarget, {
      type: "object",
      additionalProperties: false,
      properties: {
        provider: providerSchema,
        intent: { enum: ["authenticate", "select_identity"] },
        identityRef: handleSchema
      },
      required: ["provider", "intent"]
    }),
    response: response(
      "credentials.configure",
      accepted(scopedTarget, resolvedSourceSchema, [])
    )
  },
  "credentials.inspect": {
    request: request("credentials.inspect", scopedTarget, {
      type: "object",
      additionalProperties: false,
      properties: { provider: providerSchema }
    }),
    response: response("credentials.inspect", {
      type: "object",
      additionalProperties: false,
      properties: {
        target: scopedTarget,
        prerequisites: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              provider: providerSchema,
              identityRef: handleSchema,
              status: {
                enum: ["satisfied", "missing", "unavailable", "forbidden"]
              },
              reason: textSchema
            },
            required: ["provider", "status", "reason"]
          }
        },
        actions: { type: "array", items: requiredActionSchema },
        observation: observationSchema
      },
      required: ["target", "prerequisites", "actions", "observation"]
    })
  },
  "definition.author": {
    request: request("definition.author", workspaceDefinitionTarget, {
      type: "object",
      additionalProperties: false,
      properties: { intent: textSchema, provider: providerSchema },
      required: ["intent", "provider"]
    }),
    response: response("definition.author", {
      oneOf: [
        ...accepted(workspaceDefinitionTarget, resolvedSourceSchema.oneOf[0], [
          "source"
        ]).oneOf,
        completedDefinition("succeeded", ["proposal"]),
        completedDefinition("failed", ["error"]),
        completedDefinition("cancelled", [])
      ]
    })
  },
  "definition.validate": {
    request: request("definition.validate", definitionTarget, {
      type: "object",
      additionalProperties: false,
      properties: { policyVersion: { const: "github-radius/validation/v1" } },
      required: ["policyVersion"]
    }),
    response: response("definition.validate", {
      type: "object",
      additionalProperties: false,
      properties: {
        target: definitionTarget,
        provenance: resolvedSourceSchema,
        report: validationReportSchema,
        observation: observationSchema
      },
      required: ["target", "provenance", "report", "observation"]
    })
  },
  "deployment.start": {
    request: request("deployment.start", deploymentTarget, {
      type: "object",
      additionalProperties: false,
      description:
        "An omitted approvalRef requires policy resolution or an operation-bound approval action; absence never grants approval.",
      properties: {
        approvalRef: handleSchema,
        repairPolicy: repairPolicySchema
      },
      required: ["repairPolicy"]
    }),
    response: response(
      "deployment.start",
      accepted(deploymentTarget, resolvedSourceSchema.oneOf[1], ["source"])
    )
  },
  "environment.configure": {
    request: request("environment.configure", environmentTarget, {
      type: "object",
      additionalProperties: false,
      properties: { patch: configurationPatch, approvalRef: handleSchema },
      required: ["patch"]
    }),
    response: response(
      "environment.configure",
      accepted(environmentTarget, resolvedSourceSchema, [])
    )
  },
  "environment.create": {
    request: request("environment.create", environmentTarget, {
      type: "object",
      additionalProperties: false,
      properties: {
        configuration: environmentConfigurationSchema,
        approvalRef: handleSchema
      },
      required: ["configuration"]
    }),
    response: response(
      "environment.create",
      accepted(environmentTarget, resolvedSourceSchema, [])
    )
  },
  "environment.delete": {
    request: request("environment.delete", environmentTarget, {
      type: "object",
      additionalProperties: false,
      properties: { intent: { const: "teardown" }, planRef: handleSchema },
      required: ["intent"]
    }),
    response: response(
      "environment.delete",
      accepted(environmentTarget, resolvedSourceSchema, [])
    )
  },
  "environment.inspect": {
    request: request("environment.inspect", environmentTarget, emptyInput),
    response: response("environment.inspect", {
      type: "object",
      additionalProperties: false,
      properties: {
        target: environmentTarget,
        configuration: environmentReadConfiguration,
        recipeObservation: observationSchema,
        protections: {
          type: "object",
          additionalProperties: false,
          properties: {
            requiredReviewers: { type: "boolean" },
            waitTimerMinutes: { type: "integer", minimum: 0 },
            branchPolicy: textSchema
          },
          required: ["requiredReviewers"]
        },
        limitations: { type: "array", items: textSchema },
        observation: observationSchema
      },
      required: ["target", "protections", "limitations", "observation"],
      allOf: [
        {
          if: {
            not: {
              required: ["configuration"],
              properties: {
                configuration: {
                  type: "object",
                  properties: { recipes: {} },
                  required: ["recipes"]
                }
              }
            }
          },
          then: {
            properties: { recipeObservation: observationSchema },
            required: ["recipeObservation"]
          }
        },
        {
          if: {
            properties: {
              recipeObservation: {
                type: "object",
                properties: { completeness: { const: "unavailable" } },
                required: ["completeness"]
              }
            },
            required: ["recipeObservation"]
          },
          then: {
            properties: {
              configuration: {
                type: "object",
                not: { properties: { recipes: {} }, required: ["recipes"] }
              }
            }
          }
        }
      ]
    })
  },
  "environment.list": {
    request: request("environment.list", repositoryTarget, paginationSchema),
    response: response("environment.list", {
      type: "object",
      additionalProperties: false,
      properties: {
        ...pageProperties,
        target: repositoryTarget,
        items: {
          type: "array",
          maxItems: PAGE_SIZE_MAX,
          items: environmentItem
        }
      },
      required: ["target", "items", "observation"]
    })
  },
  "graph.diff": {
    request: {
      ...DRAFT_07,
      oneOf: [
        request("graph.diff", repositoryTarget, {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { const: "authored" },
            base: definitionTarget,
            head: definitionTarget
          },
          required: ["kind", "base", "head"]
        }),
        request("graph.diff", repositoryTarget, {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { const: "planned" },
            base: plannedTarget,
            head: plannedTarget
          },
          required: ["kind", "base", "head"]
        }),
        request("graph.diff", repositoryTarget, {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { const: "deployed" },
            base: diffSelection,
            head: diffSelection
          },
          required: ["kind", "base", "head"]
        })
      ]
    },
    response: response("graph.diff", diffResult)
  },
  "graph.get": {
    request: {
      ...DRAFT_07,
      oneOf: [
        request("graph.get", definitionTarget, {
          ...emptyInput,
          properties: { kind: { const: "authored" } },
          required: ["kind"]
        }),
        request("graph.get", plannedTarget, {
          ...emptyInput,
          properties: { kind: { const: "planned" } },
          required: ["kind"]
        }),
        request("graph.get", applicationTarget, {
          ...emptyInput,
          properties: { kind: { const: "deployed" } },
          required: ["kind"]
        })
      ]
    },
    response: response("graph.get", {
      oneOf: [authoredGraph, plannedGraph, deployedGraph]
    })
  },
  "operation.cancel": {
    request: request("operation.cancel", operationTarget, operationIdInput),
    response: response("operation.cancel", {
      type: "object",
      additionalProperties: false,
      properties: {
        cancellation: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: {
              enum: [
                "requested",
                "already_requested",
                "not_cancellable",
                "unavailable"
              ]
            },
            requestedAt: timestampSchema,
            reason: textSchema
          },
          required: ["status"]
        },
        operation: operationRecordSchema
      },
      required: ["cancellation", "operation"]
    })
  },
  "operation.get": {
    request: request("operation.get", operationTarget, operationIdInput),
    response: response("operation.get", operationRecordSchema)
  },
  "operation.list": {
    request: request("operation.list", operationTarget, paginationSchema),
    response: response("operation.list", {
      type: "object",
      additionalProperties: false,
      properties: {
        ...pageProperties,
        items: {
          type: "array",
          maxItems: PAGE_SIZE_MAX,
          items: operationRecordSchema
        }
      },
      required: ["target", "items", "observation"]
    })
  },
  "operation.repair": {
    request: request("operation.repair", operationTarget, {
      type: "object",
      additionalProperties: false,
      properties: {
        operationId: handleSchema,
        source: workspaceSourceSchema,
        repairPolicy: repairPolicySchema,
        approvalRef: handleSchema
      },
      required: ["operationId", "source", "repairPolicy"]
    }),
    response: response(
      "operation.repair",
      accepted(operationTarget, resolvedSourceSchema.oneOf[0], ["source"])
    )
  },
  "operation.respond": {
    request: request("operation.respond", operationTarget, {
      type: "object",
      additionalProperties: false,
      properties: {
        operationId: handleSchema,
        actionId: handleSchema,
        response: actionResponseSchema
      },
      required: ["operationId", "actionId", "response"]
    }),
    response: response("operation.respond", operationRecordSchema)
  }
} as const;

export const lifecycleErrorResponseSchema = {
  ...DRAFT_07,
  type: "object",
  additionalProperties: false,
  properties: {
    ...envelopeProperties,
    error: lifecycleErrorSchema,
    diagnostics: diagnosticsSchema
  },
  required: ["apiVersion", "requestId", "error"]
} as const;
export type LifecycleErrorResponse = FromSchema<
  typeof lifecycleErrorResponseSchema
>;
export type LifecycleOperation = keyof typeof operationSchemas;
type RequestTypes = {
  "application.delete": FromSchema<
    (typeof operationSchemas)["application.delete"]["request"]
  >;
  "application.inspect": FromSchema<
    (typeof operationSchemas)["application.inspect"]["request"]
  >;
  "application.list": FromSchema<
    (typeof operationSchemas)["application.list"]["request"]
  >;
  "capabilities.get": FromSchema<
    (typeof operationSchemas)["capabilities.get"]["request"]
  >;
  "credentials.configure": FromSchema<
    (typeof operationSchemas)["credentials.configure"]["request"]
  >;
  "credentials.inspect": FromSchema<
    (typeof operationSchemas)["credentials.inspect"]["request"]
  >;
  "definition.author": FromSchema<
    (typeof operationSchemas)["definition.author"]["request"]
  >;
  "definition.validate": FromSchema<
    (typeof operationSchemas)["definition.validate"]["request"]
  >;
  "deployment.start": FromSchema<
    (typeof operationSchemas)["deployment.start"]["request"]
  >;
  "environment.configure": FromSchema<
    (typeof operationSchemas)["environment.configure"]["request"]
  >;
  "environment.create": FromSchema<
    (typeof operationSchemas)["environment.create"]["request"]
  >;
  "environment.delete": FromSchema<
    (typeof operationSchemas)["environment.delete"]["request"]
  >;
  "environment.inspect": FromSchema<
    (typeof operationSchemas)["environment.inspect"]["request"]
  >;
  "environment.list": FromSchema<
    (typeof operationSchemas)["environment.list"]["request"]
  >;
  "graph.diff": FromSchema<(typeof operationSchemas)["graph.diff"]["request"]>;
  "graph.get": FromSchema<(typeof operationSchemas)["graph.get"]["request"]>;
  "operation.cancel": FromSchema<
    (typeof operationSchemas)["operation.cancel"]["request"]
  >;
  "operation.get": FromSchema<
    (typeof operationSchemas)["operation.get"]["request"]
  >;
  "operation.list": FromSchema<
    (typeof operationSchemas)["operation.list"]["request"]
  >;
  "operation.repair": FromSchema<
    (typeof operationSchemas)["operation.repair"]["request"]
  >;
  "operation.respond": FromSchema<
    (typeof operationSchemas)["operation.respond"]["request"]
  >;
};
type ResponseTypes = {
  "application.delete": FromSchema<
    (typeof operationSchemas)["application.delete"]["response"]
  >;
  "application.inspect": FromSchema<
    (typeof operationSchemas)["application.inspect"]["response"]
  >;
  "application.list": FromSchema<
    (typeof operationSchemas)["application.list"]["response"]
  >;
  "capabilities.get": FromSchema<
    (typeof operationSchemas)["capabilities.get"]["response"]
  >;
  "credentials.configure": FromSchema<
    (typeof operationSchemas)["credentials.configure"]["response"]
  >;
  "credentials.inspect": FromSchema<
    (typeof operationSchemas)["credentials.inspect"]["response"]
  >;
  "definition.author": FromSchema<
    (typeof operationSchemas)["definition.author"]["response"]
  >;
  "definition.validate": FromSchema<
    (typeof operationSchemas)["definition.validate"]["response"]
  >;
  "deployment.start": FromSchema<
    (typeof operationSchemas)["deployment.start"]["response"]
  >;
  "environment.configure": FromSchema<
    (typeof operationSchemas)["environment.configure"]["response"]
  >;
  "environment.create": FromSchema<
    (typeof operationSchemas)["environment.create"]["response"]
  >;
  "environment.delete": FromSchema<
    (typeof operationSchemas)["environment.delete"]["response"]
  >;
  "environment.inspect": FromSchema<
    (typeof operationSchemas)["environment.inspect"]["response"]
  >;
  "environment.list": FromSchema<
    (typeof operationSchemas)["environment.list"]["response"]
  >;
  "graph.diff": FromSchema<(typeof operationSchemas)["graph.diff"]["response"]>;
  "graph.get": FromSchema<(typeof operationSchemas)["graph.get"]["response"]>;
  "operation.cancel": FromSchema<
    (typeof operationSchemas)["operation.cancel"]["response"]
  >;
  "operation.get": FromSchema<
    (typeof operationSchemas)["operation.get"]["response"]
  >;
  "operation.list": FromSchema<
    (typeof operationSchemas)["operation.list"]["response"]
  >;
  "operation.repair": FromSchema<
    (typeof operationSchemas)["operation.repair"]["response"]
  >;
  "operation.respond": FromSchema<
    (typeof operationSchemas)["operation.respond"]["response"]
  >;
};
export type LifecycleRequestFor<O extends LifecycleOperation> = RequestTypes[O];
export type LifecycleResponseFor<O extends LifecycleOperation> =
  ResponseTypes[O];
export type LifecycleRequest = RequestTypes[LifecycleOperation];
export type LifecycleResponse =
  ResponseTypes[LifecycleOperation] | LifecycleErrorResponse;

export const lifecycleRequestSchema = {
  ...DRAFT_07,
  oneOf: Object.values(operationSchemas).map((variant) => variant.request)
} as const;
export const lifecycleResponseSchema = {
  ...DRAFT_07,
  oneOf: [
    ...Object.values(operationSchemas).map((variant) => variant.response),
    lifecycleErrorResponseSchema
  ]
} as const;
