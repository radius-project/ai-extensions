import { describe, expect, it } from "vitest";

import {
  assertEnvironmentDeletionIdentityOutcome,
  DELETE_ENVIRONMENT_PATH,
  describeProblems,
  findDeleteEnvironmentSuccessProblems
} from "./delete-environment-journey.js";

const ENVIRONMENT = "radtest-abc123";
const SUBJECTS = [
  "repo:radius-project/fixture:environment:radtest-abc123",
  "repo:radius-project/fixture:pull_request"
] as const;
const PRINCIPAL_ID = "principal-1";
const APP = {
  appId: "app-1",
  objectId: "object-1",
  displayName: "radius-deploy-fixture"
} as const;

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

describe("assertEnvironmentDeletionIdentityOutcome", () => {
  type Assertions = Parameters<
    typeof assertEnvironmentDeletionIdentityOutcome
  >[0]["assertions"];

  function recordingAssertions(
    options: {
      readonly failAt?: string;
      readonly appReplacement?: {
        readonly call: number;
        readonly appId?: string;
        readonly objectId?: string;
      };
    } = {}
  ): {
    readonly assertions: Assertions;
    readonly calls: string[];
    readonly failure: Error;
  } {
    const calls: string[] = [];
    const failure = new Error("presence guard failed");
    const record = async (call: string): Promise<void> => {
      calls.push(call);
      if (call === options.failAt) throw failure;
    };
    let appCalls = 0;
    return {
      assertions: {
        assertAppRegistrationExists: async () => {
          appCalls += 1;
          await record(`app-registration:present:${appCalls}`);
          return appCalls === options.appReplacement?.call ?
              {
                ...APP,
                appId: options.appReplacement.appId ?? APP.appId,
                objectId: options.appReplacement.objectId ?? APP.objectId
              }
            : APP;
        },
        assertFederatedCredentialAbsent: (subject, expectedApp) =>
          record(
            `federated-credential:absent:${subject}:${expectedApp?.objectId ?? "unscoped"}`
          ),
        assertRoleAssignmentExists: (principalId) =>
          record(`role-assignment:present:${principalId}`)
      },
      calls,
      failure
    };
  }

  it("checks the app registration, each credential, then the role assignment", async () => {
    const { assertions, calls } = recordingAssertions();

    await assertEnvironmentDeletionIdentityOutcome({
      assertions,
      expectedAppRegistration: APP,
      federatedSubjects: SUBJECTS,
      principalId: PRINCIPAL_ID
    });

    expect(calls).toEqual([
      "app-registration:present:1",
      `federated-credential:absent:${SUBJECTS[0]}:${APP.objectId}`,
      `federated-credential:absent:${SUBJECTS[1]}:${APP.objectId}`,
      `role-assignment:present:${PRINCIPAL_ID}`,
      "app-registration:present:2"
    ]);
  });

  it.each([
    [
      "app registration",
      "app-registration:present:1",
      ["app-registration:present:1"]
    ],
    [
      "federated credential",
      `federated-credential:absent:${SUBJECTS[0]}:${APP.objectId}`,
      [
        "app-registration:present:1",
        `federated-credential:absent:${SUBJECTS[0]}:${APP.objectId}`
      ]
    ],
    [
      "role assignment",
      `role-assignment:present:${PRINCIPAL_ID}`,
      [
        "app-registration:present:1",
        `federated-credential:absent:${SUBJECTS[0]}:${APP.objectId}`,
        `federated-credential:absent:${SUBJECTS[1]}:${APP.objectId}`,
        `role-assignment:present:${PRINCIPAL_ID}`
      ]
    ],
    [
      "final app registration",
      "app-registration:present:2",
      [
        "app-registration:present:1",
        `federated-credential:absent:${SUBJECTS[0]}:${APP.objectId}`,
        `federated-credential:absent:${SUBJECTS[1]}:${APP.objectId}`,
        `role-assignment:present:${PRINCIPAL_ID}`,
        "app-registration:present:2"
      ]
    ]
  ])(
    "preserves the %s failure and skips later identity assertions",
    async (_label, failAt, expectedCalls) => {
      const { assertions, calls, failure } = recordingAssertions({ failAt });

      await expect(
        assertEnvironmentDeletionIdentityOutcome({
          assertions,
          expectedAppRegistration: APP,
          federatedSubjects: SUBJECTS,
          principalId: PRINCIPAL_ID
        })
      ).rejects.toBe(failure);
      expect(calls).toEqual(expectedCalls);
    }
  );

  it.each([
    ["initial app id", 1, { appId: "replacement-app" }],
    ["initial object id", 1, { objectId: "replacement-object" }],
    ["final app id", 2, { appId: "replacement-app" }],
    ["final object id", 2, { objectId: "replacement-object" }]
  ] as const)("rejects an %s mismatch", async (_label, call, replacement) => {
    const { assertions } = recordingAssertions({
      appReplacement: { call, ...replacement }
    });

    await expect(
      assertEnvironmentDeletionIdentityOutcome({
        assertions,
        expectedAppRegistration: APP,
        federatedSubjects: SUBJECTS,
        principalId: PRINCIPAL_ID
      })
    ).rejects.toThrow(
      /Expected app registration app-1 \(object-1\).*but found/
    );
  });
});

describe("findDeleteEnvironmentSuccessProblems", () => {
  it("accepts a delete the product reported as successful", () => {
    expect(
      findDeleteEnvironmentSuccessProblems(
        outcome(202, { operationId: "op_delete" })
      )
    ).toEqual([]);
  });

  it("ignores extra fields alongside the success flag", () => {
    expect(
      findDeleteEnvironmentSuccessProblems(
        outcome(202, {
          operationId: "op_delete",
          environment: ENVIRONMENT
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
    ["an array", [{ success: true }]]
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
    ["an empty operation id", { operationId: " " }],
    ["a non-string operation id", { operationId: 7 }]
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
