import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { setupAutomaticBranchVerificationPolicy } from "./setup-verification-policy.js";
import type { SetupWorkflowRead as WorkflowFileReadResult } from "./setup-environment-contracts.js";

const evaluate = (
  input: Parameters<typeof setupAutomaticBranchVerificationPolicy>[0]
) => setupAutomaticBranchVerificationPolicy(input, parse);

const dispatcher = (env: string, chain = true) => `name: Radius
on:
  workflow_dispatch:
    inputs:
      environment:
        default: '${env}'
${
  chain ?
    `  workflow_run:\n    workflows: ["Radius - Verify Credentials"]\n`
  : ""
}jobs:
  detect:
    environment: \${{ inputs.environment || '${env}' }}
`;

describe("automatic setup-branch verification safety", () => {
  const absent = {
    content: null,
    error: "HTTP 404: Not Found",
    status: 404
  };
  const present = (content: string) => ({
    content,
    error: null,
    status: 200
  });
  const input = (
    verify: WorkflowFileReadResult,
    dispatcherResult: WorkflowFileReadResult,
    legacyDeploy: WorkflowFileReadResult = absent
  ) => ({ verify, dispatcher: dispatcherResult, legacyDeploy });

  it.each([
    ["an absent dispatcher", absent],
    ["a chain-free dispatcher", present(dispatcher("dev", false))]
  ])("enables first-time verification with %s", (_name, safeDispatcher) => {
    expect(evaluate(input(absent, safeDispatcher))).toEqual({
      state: "enabled"
    });
  });

  it("fails closed for a legacy chained dispatcher", () => {
    expect(evaluate(input(absent, present(dispatcher("dev"))))).toEqual({
      state: "disabled",
      reason: "dispatcher-legacy-chain"
    });
  });

  it.each([
    ["a generic missing result", { content: null, error: null, status: null }],
    [
      "an unreadable result",
      { content: null, error: "connection reset", status: null }
    ],
    ["malformed workflow YAML", { content: "on: [", error: null, status: 200 }],
    [
      "a workflow without a trigger mapping",
      { content: "name: legacy", error: null, status: 200 }
    ]
  ])("does not treat %s as absence", (_name, dispatcherResult) => {
    expect(evaluate(input(absent, dispatcherResult))).toEqual({
      state: "disabled",
      reason: "dispatcher-unreadable"
    });
  });

  it("preserves branch dispatch when the default verify workflow exists", () => {
    expect(evaluate(input(present("on: workflow_dispatch"), absent))).toEqual({
      state: "disabled",
      reason: "verify-present"
    });
  });

  it("does not enable automatic verification when verify absence is unreadable", () => {
    expect(
      evaluate(
        input({ content: null, error: "timed out", status: null }, absent)
      )
    ).toEqual({ state: "disabled", reason: "verify-unreadable" });
  });

  it.each([
    ["is present", present("on:\n  workflow_run:\n"), "legacy-deploy-present"],
    [
      "cannot be read",
      { content: null, error: "forbidden", status: 403 },
      "legacy-deploy-unreadable"
    ]
  ])(
    "fails closed when the legacy deploy workflow %s",
    (_name, legacy, reason) => {
      expect(evaluate(input(absent, absent, legacy))).toEqual({
        state: "disabled",
        reason
      });
    }
  );

  it.each([
    [
      "the verify workflow is also unreadable",
      { content: null, error: "timed out", status: null },
      absent
    ],
    [
      "the dispatcher is also unreadable",
      absent,
      { content: null, error: "forbidden", status: 403 }
    ]
  ])(
    "prioritizes legacy workflow cleanup when %s",
    (_name, verify, dispatcherResult) => {
      expect(
        evaluate(
          input(verify, dispatcherResult, present("on:\n  workflow_run:\n"))
        )
      ).toEqual({ state: "disabled", reason: "legacy-deploy-present" });
    }
  );
});
