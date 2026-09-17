import type { FromSchema } from "json-schema-to-ts";
import {
  commitSchema,
  diagnosticsSchema,
  handleSchema,
  lifecycleErrorSchema,
  nameSchema,
  repositorySchema,
  timestampSchema
} from "./common.js";

const phaseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    outcome: {
      enum: [
        "succeeded",
        "failed",
        "cancelled",
        "skipped",
        "unknown",
        "not_applicable"
      ]
    },
    exitCode: { type: "integer", minimum: 0, maximum: 255 },
    reason: { type: "string", minLength: 1, maxLength: 4096 }
  },
  required: ["outcome"],
  allOf: [
    {
      if: { properties: { outcome: { const: "succeeded" } } },
      then: { properties: { exitCode: { const: 0 } }, required: ["exitCode"] }
    },
    {
      if: { properties: { outcome: { const: "failed" } } },
      then: { properties: { exitCode: { minimum: 1 } }, required: ["exitCode"] }
    },
    {
      if: {
        properties: {
          outcome: {
            enum: ["cancelled", "skipped", "unknown", "not_applicable"]
          }
        }
      },
      then: { required: ["reason"] }
    }
  ]
} as const;

export const lifecycleExecutionSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  properties: {
    executionSchemaVersion: { const: 1 },
    operationId: handleSchema,
    attemptId: handleSchema,
    operation: { const: "deployment.start" },
    repo: repositorySchema,
    environment: nameSchema,
    application: nameSchema,
    expectedCommit: commitSchema,
    actualCommit: commitSchema,
    runId: { type: "integer", minimum: 1 },
    runAttempt: { type: "integer", minimum: 1 },
    sequence: { type: "integer", minimum: 0 },
    observedAt: timestampSchema,
    phases: {
      type: "object",
      additionalProperties: false,
      properties: {
        restore: phaseSchema,
        commands: phaseSchema,
        stateSave: phaseSchema,
        cleanup: phaseSchema
      },
      required: ["restore", "commands", "stateSave", "cleanup"]
    },
    primaryFailure: lifecycleErrorSchema,
    additionalFailures: {
      type: "array",
      maxItems: 10,
      items: lifecycleErrorSchema
    },
    diagnostics: diagnosticsSchema
  },
  required: [
    "executionSchemaVersion",
    "operationId",
    "attemptId",
    "operation",
    "repo",
    "environment",
    "application",
    "expectedCommit",
    "actualCommit",
    "runId",
    "runAttempt",
    "sequence",
    "observedAt",
    "phases"
  ]
} as const;
export type LifecycleExecutionDocument = FromSchema<
  typeof lifecycleExecutionSchema
>;

export const lifecycleProgressSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 2 },
    operationId: handleSchema,
    attemptId: handleSchema,
    operation: { const: "deployment.start" },
    repo: repositorySchema,
    environment: nameSchema,
    application: nameSchema,
    expectedCommit: commitSchema,
    actualCommit: commitSchema,
    runId: { type: "integer", minimum: 1 },
    runAttempt: { type: "integer", minimum: 1 },
    sequence: { type: "integer", minimum: 1 },
    updatedAt: timestampSchema,
    state: { const: "in_progress" },
    diagnosticsRedacted: { const: true },
    resources: {
      type: "array",
      maxItems: 1000,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", maxLength: 4096 },
          name: { type: "string", maxLength: 4096 },
          type: { type: "string", maxLength: 4096 },
          provisioningState: { type: "string", maxLength: 128 },
          outputResourceIds: {
            type: "array",
            maxItems: 1000,
            items: { type: "string", maxLength: 4096 }
          },
          status: { enum: ["success", "failed", "in_progress"] },
          message: { const: "Resource diagnostic withheld." }
        },
        required: [
          "id",
          "name",
          "type",
          "provisioningState",
          "outputResourceIds",
          "status",
          "message"
        ]
      }
    }
  },
  required: [
    "schemaVersion",
    "operationId",
    "attemptId",
    "operation",
    "repo",
    "environment",
    "application",
    "expectedCommit",
    "actualCommit",
    "runId",
    "runAttempt",
    "sequence",
    "updatedAt",
    "state",
    "diagnosticsRedacted",
    "resources"
  ]
} as const;
export type LifecycleProgressDocument = FromSchema<
  typeof lifecycleProgressSchema
>;
