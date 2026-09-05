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
  it("accepts a delete the product reported as successful", () => {
    expect(
      findDeleteEnvironmentSuccessProblems(outcome(200, { success: true }))
    ).toEqual([]);
  });

  it("ignores extra fields alongside the success flag", () => {
    expect(
      findDeleteEnvironmentSuccessProblems(
        outcome(200, { success: true, environment: ENVIRONMENT })
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
      `Deleting environment "${ENVIRONMENT}" answered 409, not 200 (code "app-deployed"): ` +
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
      `Deleting environment "${ENVIRONMENT}" answered 503, not 200: ` +
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
      `Deleting environment "${ENVIRONMENT}" answered 500, not 200.`
    ]);
  });

  it("reports a non-string code as no code", () => {
    expect(
      findDeleteEnvironmentSuccessProblems(
        outcome(400, { code: 7, error: "bad request" })
      )
    ).toEqual([
      `Deleting environment "${ENVIRONMENT}" answered 400, not 200: bad request`
    ]);
  });

  it.each([
    ["null", null],
    ["a string", "ok"],
    ["an array", [{ success: true }]]
  ])("reports a 200 whose body was %s", (_label, payload) => {
    const problems = findDeleteEnvironmentSuccessProblems(
      outcome(200, payload)
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /answered 200 but its body was not a JSON object/
    );
  });

  it.each([
    ["an absent flag", {}],
    ["a false flag", { success: false }],
    ["a truthy non-boolean flag", { success: "true" }]
  ])("reports a 200 carrying %s", (_label, payload) => {
    const problems = findDeleteEnvironmentSuccessProblems(
      outcome(200, payload)
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/did not report success/);
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
