import { expect, it } from "vitest";
import {
  lifecycleError,
  type OperationRecord
} from "@radius-project/core/lifecycle";
import { lifecycleEnvironmentView } from "./lifecycle-environment-view.js";

function record(): OperationRecord {
  return {
    operationId: "operation",
    operation: "environment.create",
    target: { repo: "owner/repo", environment: "dev" },
    state: "queued",
    attempts: [],
    actions: [],
    observation: {
      quality: "current",
      completeness: "complete",
      evidence: "session"
    }
  };
}

it.each([
  ["succeeded", "complete", "succeeded", "completed and was verified"],
  ["failed", "partial", "failed_partial", "did not complete"],
  ["failed", "complete", "failed", "did not complete"],
  ["cancelled", "complete", "cancelled", "was cancelled"],
  ["action_required", "complete", "action_required", "explicit user action"],
  ["running", "unavailable", "unconfirmed", "is unconfirmed"],
  ["running", "complete", "running", "is in progress"]
] as const)(
  "projects %s/%s without inventing stronger completion",
  (state, completeness, projected, summary) => {
    const operation = record();
    operation.state = state;
    operation.observation = {
      quality: "current",
      completeness,
      evidence: "configuration"
    };
    const view = lifecycleEnvironmentView(operation);
    expect(view.state).toBe(projected);
    expect(view.summary).toContain(summary);
    expect(view.terminalState).toBe(
      projected === "running" ? null
      : projected === "unconfirmed" ? "action_required"
      : projected
    );
    expect(view.actions).toEqual([]);
  }
);
it("projects an environment authentication prerequisite without starting credential configuration", () => {
  const operation = record();
  operation.actions = [
    {
      actionId: "action",
      operationId: operation.operationId,
      target: operation.target,
      kind: "user.authenticate",
      responder: "user",
      status: "outstanding",
      message: "Configure the selected identity separately.",
      response: {
        kind: "user.decision",
        choices: ["continue"],
        permittedInput: []
      }
    }
  ];
  expect(lifecycleEnvironmentView(operation).actions).toEqual([
    expect.objectContaining({
      kind: "lifecycle.configure",
      label: "Recheck credentials and continue",
      path: "/api/operations/operation/continue"
    })
  ]);
});

it("uses explicit credential provider evidence rather than decoding opaque identities", () => {
  const operation = record();
  operation.operation = "credentials.configure";
  operation.target = { repo: "owner/repo" };
  operation.result = {
    kind: "configuration",
    identityRef: "opaque-reference",
    provider: "aws",
    phases: [
      {
        phase: "identity",
        status: "failed",
        reason: "Identity could not be verified."
      }
    ]
  };
  operation.error = lifecycleError("PRECONDITION_FAILED");
  const view = lifecycleEnvironmentView(operation);
  expect(view).toMatchObject({
    kind: "lifecycle_credentials",
    environment: "",
    provider: "aws",
    failure: { code: "PRECONDITION_FAILED" },
    stages: [{ key: "identity", state: "failed" }]
  });
  operation.result = { ...operation.result, provider: undefined };
  expect(lifecycleEnvironmentView(operation).provider).toBe("");
});
