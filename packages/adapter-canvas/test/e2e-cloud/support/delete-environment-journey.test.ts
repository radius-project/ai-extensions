import { describe, expect, it } from "vitest";

import {
  DELETE_ENVIRONMENT_PATH,
  describeProblems,
  findDeleteEnvironmentSuccessProblems
} from "./delete-environment-journey.js";

const ENVIRONMENT = "radtest-abc123";

function outcome(
  status: number,
  payload: unknown
): Parameters<typeof findDeleteEnvironmentSuccessProblems>[0] {
  return { status, payload, environmentName: ENVIRONMENT };
}

describe("DELETE_ENVIRONMENT_PATH", () => {
  it("matches the path the environments page posts to", () => {
    expect(DELETE_ENVIRONMENT_PATH).toBe("/api/delete-environment");
  });
});

describe("findDeleteEnvironmentSuccessProblems", () => {
  it("accepts a tracked delete operation", () => {
    expect(
      findDeleteEnvironmentSuccessProblems(
        outcome(202, { operationId: "op_delete" })
      )
    ).toEqual([]);
  });

  it("ignores extra fields alongside the operation id", () => {
    expect(
      findDeleteEnvironmentSuccessProblems(
        outcome(202, {
          operationId: "op_delete",
          statusUrl: "/api/operations/op_delete",
          operation: { state: "queued" }
        })
      )
    ).toEqual([]);
  });

  it("quotes the refusal, including the code the browser branches on", () => {
    expect(
      findDeleteEnvironmentSuccessProblems(
        outcome(409, {
          error: 'Application "demo" is still deployed.',
          code: "app-deployed"
        })
      )
    ).toEqual([
      `Deleting environment "${ENVIRONMENT}" answered 409, not 202 (code "app-deployed"): ` +
        'Application "demo" is still deployed.'
    ]);
  });

  it("quotes a fail-closed error that carries no code", () => {
    expect(
      findDeleteEnvironmentSuccessProblems(
        outcome(503, {
          error: "Could not determine whether an app is deployed"
        })
      )
    ).toEqual([
      `Deleting environment "${ENVIRONMENT}" answered 503, not 202: ` +
        "Could not determine whether an app is deployed"
    ]);
  });

  it.each([
    ["no body at all", null],
    ["a body that is not an object", "gateway timeout"],
    ["an array", []],
    ["an object with no error", {}],
    ["an empty error string", { error: "   " }],
    ["a non-string error", { error: 500 }],
    ["a blank code", { code: "  ", error: "" }]
  ])("reports a failure carrying %s without inventing a reason", (_l, body) => {
    expect(findDeleteEnvironmentSuccessProblems(outcome(500, body))).toEqual([
      `Deleting environment "${ENVIRONMENT}" answered 500, not 202.`
    ]);
  });

  it("reports a non-string code as no code", () => {
    expect(
      findDeleteEnvironmentSuccessProblems(
        outcome(400, { code: 7, error: "bad request" })
      )
    ).toEqual([
      `Deleting environment "${ENVIRONMENT}" answered 400, not 202: bad request`
    ]);
  });

  it.each([
    ["null", null],
    ["a string", "ok"],
    ["an array", [{ operationId: "op_delete" }]]
  ])("reports a 202 whose body was %s", (_label, payload) => {
    const problems = findDeleteEnvironmentSuccessProblems(
      outcome(202, payload)
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /answered 202 but its body was not a JSON object/
    );
  });

  it.each([
    ["an absent operation id", {}],
    ["a numeric operation id", { operationId: 7 }],
    ["a blank operation id", { operationId: " " }]
  ])("reports a 202 carrying %s", (_label, payload) => {
    const problems = findDeleteEnvironmentSuccessProblems(
      outcome(202, payload)
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/did not identify the delete operation/);
  });
});

describe("describeProblems", () => {
  it("says nothing when there is nothing wrong", () => {
    expect(describeProblems([], "Something went wrong.")).toBe("");
  });

  it("lists every finding under the headline", () => {
    expect(describeProblems(["first", "second"], "Two things:")).toBe(
      "Two things:\n  - first\n  - second"
    );
  });
});
