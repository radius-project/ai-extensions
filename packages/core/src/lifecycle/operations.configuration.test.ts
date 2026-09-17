import { expect, it } from "vitest";
import {
  createOperationRecord,
  createSessionOperationRegistry,
  reduceOperation,
  type OperationEvent
} from "./operations.js";
import type { AuthorizedScope, ReadonlyData } from "./ports.js";
import type { OperationRecord } from "./contracts/common.js";
import { lifecycleError } from "./errors.js";

const observation = {
  quality: "current" as const,
  completeness: "complete" as const,
  evidence: "configuration" as const,
  observedAt: "2026-09-17T00:00:00Z"
};
const control = {
  requestId: "request",
  cancellation: { aborted: false, onAbort: () => () => {} }
};
function fixture() {
  const deps = {
    ids: { next: () => "operation" },
    clock: { now: () => observation.observedAt }
  };
  const scope: AuthorizedScope<"credentials.configure"> = {
    authorizationRef: "authority",
    principalRef: "principal",
    operation: "credentials.configure",
    target: { repo: "owner/repo" }
  };
  const record = createOperationRecord(deps, scope);
  const operation: ReadonlyData<OperationRecord> = {
    ...record,
    actions: [
      {
        actionId: "action",
        operationId: record.operationId,
        target: scope.target,
        kind: "user.authenticate",
        responder: "user",
        status: "accepted",
        message: "Authenticate",
        response: {
          kind: "user.decision",
          choices: ["continue"],
          permittedInput: []
        }
      }
    ]
  };
  const event: Extract<OperationEvent, { kind: "configuration_updated" }> = {
    kind: "configuration_updated",
    state: "succeeded",
    observation,
    result: {
      kind: "configuration",
      provider: "azure",
      identityRef: "identity",
      phases: [{ phase: "identity", status: "succeeded", reason: "verified" }]
    }
  };
  return {
    operation,
    event,
    scope,
    registry: createSessionOperationRegistry(deps)
  };
}

it.each([
  "other-operation",
  "terminal",
  "cancel-requested",
  "missing-action",
  "duplicate-phase",
  "foreign-phase",
  "success-with-error",
  "missing-identity",
  "stale",
  "partial",
  "missing-phase",
  "failed-phase"
])("refuses configuration evidence with %s", (scenario) => {
  let { operation, event } = fixture();
  if (scenario === "other-operation")
    operation = { ...operation, operation: "deployment.start" };
  if (scenario === "terminal") operation = { ...operation, state: "succeeded" };
  if (scenario === "cancel-requested")
    operation = {
      ...operation,
      cancellationRequestedAt: observation.observedAt
    };
  if (scenario === "missing-action") operation = { ...operation, actions: [] };
  if (scenario === "duplicate-phase")
    event = {
      ...event,
      result: {
        ...event.result,
        phases: [...event.result.phases, ...event.result.phases]
      }
    };
  if (scenario === "foreign-phase")
    event = {
      ...event,
      result: {
        ...event.result,
        phases: [
          { phase: "environment", status: "succeeded", reason: "verified" }
        ]
      }
    };
  if (scenario === "success-with-error")
    event = { ...event, error: lifecycleError("PRECONDITION_FAILED") };
  if (scenario === "missing-identity")
    event = { ...event, result: { ...event.result, identityRef: undefined } };
  if (scenario === "stale")
    event = { ...event, observation: { ...observation, quality: "stale" } };
  if (scenario === "partial")
    event = {
      ...event,
      observation: { ...observation, completeness: "partial" }
    };
  if (scenario === "missing-phase")
    event = { ...event, result: { ...event.result, phases: [] } };
  if (scenario === "failed-phase")
    event = {
      ...event,
      result: {
        ...event.result,
        phases: [
          { phase: "identity", status: "failed", reason: "not verified" }
        ]
      }
    };
  expect(reduceOperation(operation, event)).toMatchObject({
    status: "failed",
    error: { code: "PRECONDITION_FAILED" }
  });
});

it("independently rejects forged success at the registry terminal boundary", async () => {
  const { operation, event, scope, registry } = fixture();
  const created = await registry.create(scope, operation, control);
  if (created.status !== "ok") throw new Error("Expected saved operation");
  const forged = {
    ...operation,
    state: "succeeded" as const,
    result: {
      ...event.result,
      phases: [
        {
          phase: "identity" as const,
          status: "failed" as const,
          reason: "not verified"
        }
      ]
    },
    observation
  };
  expect(
    await registry.compareAndSwap(
      scope,
      {
        operationId: operation.operationId,
        expectedRevision: created.value.revision,
        replacement: forged
      },
      control
    )
  ).toMatchObject({
    status: "failed",
    error: { code: "PRECONDITION_FAILED" }
  });
});
