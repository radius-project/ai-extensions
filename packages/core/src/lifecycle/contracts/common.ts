import type { FromSchema } from "json-schema-to-ts";

export const DRAFT_07 = {
  $schema: "http://json-schema.org/draft-07/schema#"
} as const;
export const LIFECYCLE_OPERATIONS = [
  "application.delete",
  "application.inspect",
  "application.list",
  "capabilities.get",
  "credentials.configure",
  "credentials.inspect",
  "definition.author",
  "definition.validate",
  "deployment.start",
  "environment.configure",
  "environment.create",
  "environment.delete",
  "environment.inspect",
  "environment.list",
  "graph.diff",
  "graph.get",
  "operation.cancel",
  "operation.get",
  "operation.list",
  "operation.repair",
  "operation.respond"
] as const;

export const textSchema = {
  type: "string",
  minLength: 1,
  maxLength: 4096
} as const;
export const handleSchema = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]*$",
  description:
    "Opaque reference resolved through trusted context; never an authority claim or filesystem path."
} as const;
export const stagedOutputRefSchema = {
  type: "string",
  minLength: 3,
  maxLength: 512,
  pattern:
    "^(?![A-Za-z]:)[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}/(?!(?:[Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|[Cc][Oo][Mm][1-9]|[Ll][Pp][Tt][1-9])(?:\\.|$))(?!.*\\.$)[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$(?![\\s\\S])",
  description:
    "An opaque staging handle followed by one safe filename. The source adapter must verify staging ownership and the permitted output set; this reference is not a filesystem path."
} as const;
export const repositorySchema = {
  type: "string",
  maxLength: 201,
  pattern: "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9_.-]{1,100}$"
} as const;
export const nameSchema = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*$"
} as const;
export const commitSchema = {
  type: "string",
  pattern: "^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$",
  description:
    "Full Git SHA-1 or SHA-256 object ID. Publication and equality to the resolved repository commit require source-access verification."
} as const;
export const gitRefSchema = {
  type: "string",
  minLength: 1,
  maxLength: 1024,
  pattern:
    "^(?![-/.])(?!@$)(?!.*(?:\\.\\.|@\\{|//|/\\.|\\.lock(?:/|$)))(?!.*[/.]$)[^\\u0000-\\u0020\\u007f~^:?*\\[\\\\]+$",
  description:
    "Explicit branch, tag, or ref name, not a filesystem path, option, or revision expression. The source adapter verifies its resolved commit."
} as const;
export const fingerprintSchema = {
  type: "string",
  pattern: "^sha256:[0-9a-f]{64}$"
} as const;
export const timestampSchema = {
  type: "string",
  pattern:
    "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,9})?Z$",
  description: "UTC observation timestamp in RFC 3339 form."
} as const;
export const definitionPathSchema = {
  type: "string",
  minLength: 1,
  maxLength: 1024,
  pattern:
    '^(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*[. ](?:/|$))[^/\\\\:%<>"|?*\\u0000-\\u001f\\u007f]+(?:/[^/\\\\:%<>"|?*\\u0000-\\u001f\\u007f]+)*$',
  description:
    "Normalized repository-relative slash-separated path. No dot segments, backslashes, drives, URI encoding or control characters. The source adapter must also confine resolved symlinks/junctions."
} as const;
export const providerSchema = {
  type: "string",
  enum: ["azure", "aws"]
} as const;
export type Provider = (typeof providerSchema.enum)[number];
export const diagnosticSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: textSchema,
    truncated: { type: "boolean" },
    classification: nameSchema,
    location: definitionPathSchema
  },
  required: ["message", "truncated"]
} as const;
export const diagnosticsSchema = {
  type: "array",
  maxItems: 100,
  items: diagnosticSchema
} as const;

export const workspaceSourceSchema = {
  ...DRAFT_07,
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { const: "workspace" },
    workspaceRef: handleSchema,
    branch: gitRefSchema,
    expectedFingerprint: fingerprintSchema
  },
  required: ["kind", "workspaceRef", "branch", "expectedFingerprint"]
} as const;
export const gitSourceSchema = {
  ...DRAFT_07,
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { const: "git" },
    ref: gitRefSchema,
    expectedCommit: commitSchema
  },
  required: ["kind", "ref", "expectedCommit"]
} as const;
export const sourceSchema = {
  ...DRAFT_07,
  oneOf: [workspaceSourceSchema, gitSourceSchema]
} as const;
export type Source = FromSchema<typeof sourceSchema>;

export const targetSchema = {
  ...DRAFT_07,
  type: "object",
  additionalProperties: false,
  properties: {
    repo: repositorySchema,
    environment: nameSchema,
    application: nameSchema,
    definition: definitionPathSchema,
    source: sourceSchema
  },
  required: ["repo"]
} as const;
export type Target = FromSchema<typeof targetSchema>;

const resolvedProperties = {
  repo: repositorySchema,
  fingerprint: fingerprintSchema,
  resolvedAt: timestampSchema
} as const;
export const resolvedSourceSchema = {
  ...DRAFT_07,
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ...resolvedProperties,
        kind: { const: "workspace" },
        workspaceRef: handleSchema,
        branch: gitRefSchema,
        baseCommit: commitSchema
      },
      required: [
        "repo",
        "fingerprint",
        "resolvedAt",
        "kind",
        "workspaceRef",
        "branch"
      ]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ...resolvedProperties,
        kind: { const: "git" },
        ref: gitRefSchema,
        commit: commitSchema
      },
      required: ["repo", "fingerprint", "resolvedAt", "kind", "ref", "commit"]
    }
  ]
} as const;
export type ResolvedSource = FromSchema<typeof resolvedSourceSchema>;

export const definitionInputSchema = {
  ...DRAFT_07,
  type: "object",
  additionalProperties: false,
  properties: {
    path: definitionPathSchema,
    kind: {
      enum: [
        "definition",
        "module",
        "file",
        "configuration",
        "custom-type",
        "recipe"
      ]
    },
    contentHash: { anyOf: [fingerprintSchema, { type: "null" }] },
    existed: { type: "boolean" }
  },
  required: ["path", "kind", "contentHash", "existed"]
} as const;
export type DefinitionInput = FromSchema<typeof definitionInputSchema>;

export const observationSchema = {
  ...DRAFT_07,
  type: "object",
  additionalProperties: false,
  properties: {
    quality: { enum: ["current", "stale", "unknown"] },
    observedAt: timestampSchema,
    evidence: {
      enum: [
        "source",
        "configuration",
        "radius",
        "workflow",
        "artifact",
        "session"
      ]
    },
    completeness: { enum: ["complete", "partial", "unavailable"] },
    limitation: textSchema
  },
  required: ["quality", "evidence", "completeness"]
} as const;
export type Observation = FromSchema<typeof observationSchema>;

export const validationCheckSchema = {
  ...DRAFT_07,
  type: "object",
  additionalProperties: false,
  properties: {
    checkId: nameSchema,
    classification: { enum: ["required", "advisory"] },
    status: { enum: ["passed", "failed", "unavailable", "skipped"] },
    reason: textSchema,
    location: definitionPathSchema
  },
  required: ["checkId", "classification", "status", "reason"]
} as const;
export type ValidationCheck = FromSchema<typeof validationCheckSchema>;
export const validationReportSchema = {
  ...DRAFT_07,
  type: "object",
  additionalProperties: false,
  description:
    "Policy assigns check classifications before execution and reduces required failures to failed, required unavailable/skipped to incomplete, otherwise passed. Advisory outcomes remain separate warnings. A report is not approval to promote or deploy.",
  properties: {
    status: { enum: ["passed", "failed", "incomplete"] },
    checks: {
      type: "array",
      minItems: 1,
      maxItems: 256,
      items: validationCheckSchema
    },
    warnings: { type: "array", maxItems: 100, items: textSchema },
    diagnostics: diagnosticsSchema,
    sourceFingerprint: fingerprintSchema,
    proposalFingerprint: fingerprintSchema
  },
  required: ["status", "checks", "warnings", "diagnostics", "sourceFingerprint"]
} as const;
export type ValidationReport = FromSchema<typeof validationReportSchema>;

export const actionResponseSchema = {
  ...DRAFT_07,
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { const: "user.decision" },
        choice: nameSchema,
        approvalRef: handleSchema,
        input: {
          type: "object",
          additionalProperties: false,
          properties: {
            configurationRef: handleSchema,
            identityRef: handleSchema
          }
        }
      },
      required: ["kind", "choice"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { const: "agent.outcome" },
        status: { const: "completed" },
        stagedOutputRefs: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          uniqueItems: true,
          items: stagedOutputRefSchema
        },
        diagnostics: diagnosticsSchema
      },
      required: ["kind", "status", "stagedOutputRefs"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { const: "agent.outcome" },
        status: { enum: ["failed", "cancelled"] },
        diagnostics: diagnosticsSchema
      },
      required: ["kind", "status", "diagnostics"]
    }
  ]
} as const;
export type ActionResponse = FromSchema<typeof actionResponseSchema>;

const actionProperties = {
  actionId: handleSchema,
  operationId: handleSchema,
  target: targetSchema,
  source: resolvedSourceSchema,
  status: {
    enum: ["outstanding", "accepted", "rejected", "expired", "superseded"]
  },
  message: textSchema,
  expiresAt: timestampSchema
} as const;
export const requiredActionSchema = {
  ...DRAFT_07,
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ...actionProperties,
        kind: { enum: ["user.decision", "user.authenticate"] },
        responder: { const: "user" },
        response: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { const: "user.decision" },
            choices: {
              type: "array",
              minItems: 1,
              maxItems: 32,
              uniqueItems: true,
              items: nameSchema
            },
            permittedInput: {
              type: "array",
              uniqueItems: true,
              items: {
                enum: ["configurationRef", "identityRef", "approvalRef"]
              }
            }
          },
          required: ["kind", "choices", "permittedInput"]
        }
      },
      required: [
        "actionId",
        "operationId",
        "target",
        "status",
        "kind",
        "responder",
        "response",
        "message"
      ]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ...actionProperties,
        kind: { enum: ["agent.author_definition", "agent.repair_definition"] },
        responder: { const: "agent" },
        response: {
          type: "object",
          additionalProperties: false,
          properties: { kind: { const: "agent.outcome" } },
          required: ["kind"]
        }
      },
      required: [
        "actionId",
        "operationId",
        "target",
        "source",
        "status",
        "kind",
        "responder",
        "response",
        "message"
      ]
    }
  ]
} as const;
export type RequiredAction = FromSchema<typeof requiredActionSchema>;

export const lifecycleErrorSchema = {
  ...DRAFT_07,
  type: "object",
  additionalProperties: false,
  properties: {
    code: {
      enum: [
        "INVALID_REQUEST",
        "VERSION_UNSUPPORTED",
        "FORBIDDEN",
        "CAPABILITY_UNAVAILABLE",
        "SOURCE_CHANGED",
        "DEFINITION_NOT_FOUND",
        "SOURCE_UNAVAILABLE",
        "RECIPE_PACK_REQUIRED",
        "VALIDATION_FAILED",
        "VALIDATION_INCOMPLETE",
        "ACTION_NOT_OUTSTANDING",
        "ACTION_RESPONSE_INVALID",
        "OPERATION_UNAVAILABLE",
        "DISPATCH_UNCONFIRMED",
        "RESULT_UNAVAILABLE",
        "EVIDENCE_MISMATCH",
        "EVIDENCE_CONFLICT",
        "PRECONDITION_FAILED",
        "REPAIR_LIMIT_REACHED"
      ]
    },
    message: textSchema,
    retryable: { type: "boolean" },
    operationId: handleSchema,
    details: diagnosticsSchema,
    nextAction: textSchema
  },
  required: ["code", "message", "retryable"]
} as const;
export type LifecycleError = FromSchema<typeof lifecycleErrorSchema>;

export const lifecycleStateSchema = {
  enum: [
    "queued",
    "running",
    "action_required",
    "succeeded",
    "failed",
    "cancelled"
  ]
} as const;
export type LifecycleState = FromSchema<typeof lifecycleStateSchema>;
export const phaseOutcomeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    phase: {
      enum: [
        "dispatch",
        "checkout",
        "restore",
        "command",
        "state-save",
        "cleanup"
      ]
    },
    status: {
      enum: [
        "succeeded",
        "failed",
        "skipped",
        "cancelled",
        "unknown",
        "not_applicable"
      ]
    },
    reason: textSchema,
    exitCode: { type: "integer" }
  },
  required: ["phase", "status", "reason"]
} as const;
export const executionAttemptSchema = {
  ...DRAFT_07,
  type: "object",
  additionalProperties: false,
  properties: {
    attemptId: handleSchema,
    operationId: handleSchema,
    repairsOperationId: handleSchema,
    repairsAttemptId: handleSchema,
    expectedCommit: commitSchema,
    provider: providerSchema,
    run: {
      type: "object",
      additionalProperties: false,
      properties: {
        repo: repositorySchema,
        workflow: definitionPathSchema,
        runId: handleSchema,
        runAttempt: { type: "integer", minimum: 1 },
        commit: commitSchema,
        conclusion: {
          enum: [
            "queued",
            "in_progress",
            "success",
            "failure",
            "cancelled",
            "skipped",
            "timed_out",
            "action_required",
            "neutral",
            "stale",
            "unknown"
          ]
        }
      },
      required: [
        "repo",
        "workflow",
        "runId",
        "runAttempt",
        "commit",
        "conclusion"
      ]
    },
    phases: { type: "array", maxItems: 6, items: phaseOutcomeSchema },
    observation: observationSchema
  },
  required: ["attemptId", "operationId", "phases", "observation"]
} as const;
export type ExecutionAttempt = FromSchema<typeof executionAttemptSchema>;

export const definitionProposalSchema = {
  ...DRAFT_07,
  type: "object",
  additionalProperties: false,
  properties: {
    operationId: handleSchema,
    actionId: handleSchema,
    stagingRef: handleSchema,
    outputs: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: definitionInputSchema
    },
    originalFingerprint: fingerprintSchema,
    validation: validationReportSchema,
    promotion: {
      enum: ["pending", "promoted", "refused", "failed", "rolled_back"]
    }
  },
  required: [
    "operationId",
    "actionId",
    "stagingRef",
    "outputs",
    "originalFingerprint",
    "validation",
    "promotion"
  ]
} as const;
export type DefinitionProposal = FromSchema<typeof definitionProposalSchema>;

export const deletionPhaseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    phase: { enum: ["workloads", "state", "workflows", "identity"] },
    treatment: { enum: ["delete", "retain"] },
    ownership: { enum: ["owned", "shared", "unknown"] },
    provenance: textSchema,
    requiredPermission: textSchema,
    approvalRef: handleSchema,
    status: { enum: ["completed", "blocked", "failed", "not_started"] },
    reason: textSchema
  },
  required: [
    "phase",
    "treatment",
    "ownership",
    "provenance",
    "requiredPermission",
    "status",
    "reason"
  ]
} as const;
export const deletionPlanSchema = {
  ...DRAFT_07,
  type: "object",
  additionalProperties: false,
  properties: {
    planRef: handleSchema,
    target: targetSchema,
    phases: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: deletionPhaseSchema
    },
    recovery: { type: "array", maxItems: 20, items: textSchema }
  },
  required: ["planRef", "target", "phases", "recovery"]
} as const;
export type DeletionPlan = FromSchema<typeof deletionPlanSchema>;

export const configurationResultSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { const: "configuration" },
    identityRef: handleSchema,
    provider: providerSchema,
    phases: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          phase: { enum: ["identity", "environment", "workflows", "recipes"] },
          status: { enum: ["succeeded", "failed", "skipped", "unknown"] },
          reason: textSchema
        },
        required: ["phase", "status", "reason"]
      }
    }
  },
  required: ["kind", "phases"]
} as const;
export type ConfigurationResult = FromSchema<typeof configurationResultSchema>;

export const operationRecordSchema = {
  ...DRAFT_07,
  type: "object",
  additionalProperties: false,
  properties: {
    operationId: handleSchema,
    operation: { enum: LIFECYCLE_OPERATIONS },
    target: targetSchema,
    source: resolvedSourceSchema,
    state: lifecycleStateSchema,
    observation: observationSchema,
    attempts: { type: "array", maxItems: 6, items: executionAttemptSchema },
    actions: { type: "array", maxItems: 100, items: requiredActionSchema },
    cancellationRequestedAt: timestampSchema,
    repairPolicy: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { enum: ["manual", "automatic"] },
        maxAttempts: { type: "integer", minimum: 0, maximum: 5 }
      },
      required: ["mode", "maxAttempts"]
    },
    repairsOperationId: handleSchema,
    repairsAttemptId: handleSchema,
    error: lifecycleErrorSchema,
    result: {
      oneOf: [
        configurationResultSchema,
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { const: "definition" },
            proposal: definitionProposalSchema
          },
          required: ["kind", "proposal"]
        },
        {
          type: "object",
          additionalProperties: false,
          properties: { kind: { const: "deletion" }, plan: deletionPlanSchema },
          required: ["kind", "plan"]
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { const: "execution" },
            phases: { type: "array", maxItems: 6, items: phaseOutcomeSchema },
            primaryFailure: lifecycleErrorSchema,
            additionalFailures: {
              type: "array",
              maxItems: 10,
              items: lifecycleErrorSchema
            },
            diagnostics: diagnosticsSchema
          },
          required: ["kind", "phases"]
        }
      ]
    }
  },
  required: [
    "operationId",
    "operation",
    "target",
    "state",
    "observation",
    "attempts",
    "actions"
  ]
} as const;
export type OperationRecord = FromSchema<typeof operationRecordSchema>;

export const concreteResourceSchema = {
  ...DRAFT_07,
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    type: textSchema,
    displayType: { type: "string" },
    provider: { type: "string" },
    apiVersion: { type: "string" }
  },
  required: ["name", "type", "displayType", "provider", "apiVersion"]
} as const;
export type ConcreteResourceRecord = FromSchema<typeof concreteResourceSchema>;
export const recipeRegistrationSchema = {
  ...DRAFT_07,
  type: "object",
  additionalProperties: false,
  properties: {
    resourceType: textSchema,
    kind: textSchema,
    source: textSchema
  },
  required: ["resourceType", "kind", "source"]
} as const;
export type RecipeRegistration = FromSchema<typeof recipeRegistrationSchema>;
export const graphResourceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: textSchema,
    name: { type: "string" },
    type: textSchema,
    provisioningState: textSchema,
    diffHash: fingerprintSchema,
    diffStatus: { enum: ["added", "removed", "modified", "unchanged"] },
    connections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: textSchema,
          direction: { enum: ["Inbound", "Outbound"] },
          diffStatus: { enum: ["added", "removed", "unchanged"] }
        },
        required: ["id", "direction"]
      }
    },
    outputResources: { type: "array", items: concreteResourceSchema },
    definitionFile: definitionPathSchema,
    definitionLine: { type: "integer", minimum: 0 },
    codeReference: { type: "string", maxLength: 4096 }
  },
  required: ["id", "name", "type", "diffHash", "connections", "outputResources"]
} as const;
export const canonicalGraphSchema = {
  ...DRAFT_07,
  type: "object",
  additionalProperties: false,
  description:
    "Canonical Radius resource identity, connections and compiler diff hashes; no UI layout or independent graph algorithm.",
  properties: { resources: { type: "array", items: graphResourceSchema } },
  required: ["resources"]
} as const;
export type CanonicalGraph = FromSchema<typeof canonicalGraphSchema>;

export const commonSchemas = {
  target: targetSchema,
  source: sourceSchema,
  resolvedSource: resolvedSourceSchema,
  definitionInput: definitionInputSchema,
  observation: observationSchema,
  validationCheck: validationCheckSchema,
  validationReport: validationReportSchema,
  actionResponse: actionResponseSchema,
  requiredAction: requiredActionSchema,
  error: lifecycleErrorSchema,
  executionAttempt: executionAttemptSchema,
  definitionProposal: definitionProposalSchema,
  deletionPlan: deletionPlanSchema,
  operationRecord: operationRecordSchema,
  canonicalGraph: canonicalGraphSchema,
  concreteResource: concreteResourceSchema,
  recipeRegistration: recipeRegistrationSchema
} as const;
