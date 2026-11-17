import { describe, expect, it } from "vitest";
import { evaluateIam } from "./iam-policy-evaluator.js";

const policy = (...Statement: unknown[]) => ({
  Version: "2012-10-17",
  Statement
});

describe("evaluateIam", () => {
  it("allows only what an identity statement allows", () => {
    const identity = [
      policy({ Effect: "Allow", Action: "rds:Describe*", Resource: "*" })
    ];
    expect(
      evaluateIam(
        { action: "rds:DescribeDBInstances", resource: "*" },
        identity
      )
    ).toBe("allowed");
    expect(
      evaluateIam({ action: "rds:DeleteDBInstance", resource: "*" }, identity)
    ).toBe("implicitDeny");
  });

  it("matches action names in any case, resources exactly, and ? as one character", () => {
    const identity = [
      policy({
        Effect: "Allow",
        Action: "IAM:getrole",
        Resource: "arn:aws:iam::1:role/app-?"
      })
    ];
    expect(
      evaluateIam(
        { action: "iam:GetRole", resource: "arn:aws:iam::1:role/app-1" },
        identity
      )
    ).toBe("allowed");
    for (const resource of [
      "arn:aws:iam::1:role/app-12",
      "arn:aws:iam::1:role/APP-1"
    ])
      expect(evaluateIam({ action: "iam:GetRole", resource }, identity)).toBe(
        "implicitDeny"
      );
  });

  it("lets * cross path separators", () => {
    const identity = [
      policy({
        Effect: "Allow",
        Action: "iam:GetRole",
        Resource: "arn:aws:iam::1:role/radius/apps/7/*"
      })
    ];
    expect(
      evaluateIam(
        {
          action: "iam:GetRole",
          resource: "arn:aws:iam::1:role/radius/apps/7/dev/radius-app-web"
        },
        identity
      )
    ).toBe("allowed");
  });

  it("lets an explicit deny anywhere win over an allow", () => {
    const allow = policy({ Effect: "Allow", Action: "*", Resource: "*" });
    const deny = policy({ Effect: "Deny", Action: "iam:*", Resource: "*" });
    const request = { action: "iam:DeleteRole", resource: "*" };
    expect(evaluateIam(request, [allow, deny])).toBe("explicitDeny");
    expect(evaluateIam(request, [allow], deny)).toBe("explicitDeny");
    expect(evaluateIam(request, [deny], allow)).toBe("explicitDeny");
  });

  it("needs both the identity policy and the boundary to allow", () => {
    const rds = policy({ Effect: "Allow", Action: "rds:*", Resource: "*" });
    const eks = policy({ Effect: "Allow", Action: "eks:*", Resource: "*" });
    const request = { action: "rds:CreateDBInstance", resource: "*" };
    expect(evaluateIam(request, [rds], rds)).toBe("allowed");
    expect(evaluateIam(request, [rds], eks)).toBe("implicitDeny");
    expect(evaluateIam(request, [eks], rds)).toBe("implicitDeny");
  });

  it("applies NotAction and NotResource as everything except", () => {
    const deny = policy(
      { Effect: "Allow", Action: "*", Resource: "*" },
      { Effect: "Deny", NotAction: "iam:GetRole", Resource: "arn:r/a-*" },
      { Effect: "Deny", Action: "iam:*", NotResource: ["arn:r/a-*", "arn:r/b"] }
    );
    expect(
      evaluateIam({ action: "iam:GetRole", resource: "arn:r/a-1" }, [deny])
    ).toBe("allowed");
    expect(
      evaluateIam({ action: "iam:DeleteRole", resource: "arn:r/a-1" }, [deny])
    ).toBe("explicitDeny");
    expect(
      evaluateIam({ action: "iam:DeleteRole", resource: "arn:r/b" }, [deny])
    ).toBe("allowed");
    expect(
      evaluateIam({ action: "iam:DeleteRole", resource: "arn:r/c" }, [deny])
    ).toBe("explicitDeny");
  });

  it.each([
    ["StringEquals", "us-east-2", "us-east-2", true],
    ["StringEquals", "us-east-2", "us-west-2", false],
    ["StringEquals", "us-east-2", undefined, false],
    ["StringNotEquals", "us-east-2", "us-west-2", true],
    ["StringNotEquals", "us-east-2", "us-east-2", false],
    ["StringNotEquals", "us-east-2", undefined, true],
    ["StringLike", "us-*", "us-west-1", true],
    ["StringLike", "us-*", "eu-west-1", false],
    ["StringLike", "us-*", undefined, false],
    ["StringNotLike", "us-*", "eu-west-1", true],
    ["StringNotLike", "us-*", "us-west-1", false],
    ["StringNotLike", "us-*", undefined, true],
    ["ArnLike", "arn:p/*", "arn:p/x/y", true],
    ["ArnLike", "arn:p/*", "arn:q/x", false],
    ["ArnLike", "arn:p/*", undefined, false],
    ["ArnNotLike", "arn:p/*", "arn:q/x", true],
    ["ArnNotLike", "arn:p/*", "arn:p/x", false],
    ["ArnNotLike", "arn:p/*", undefined, true]
  ] as const)(
    "%s %s against %s holds: %s",
    (operator, pattern, value, holds) => {
      const identity = [
        policy({
          Effect: "Allow",
          Action: "s3:GetObject",
          Resource: "*",
          Condition: { [operator]: { "aws:RequestedRegion": pattern } }
        })
      ];
      expect(
        evaluateIam(
          {
            action: "s3:GetObject",
            resource: "*",
            context: value === undefined ? {} : { "aws:RequestedRegion": value }
          },
          identity
        )
      ).toBe(holds ? "allowed" : "implicitDeny");
    }
  );

  it("matches any value of a key, needs every key, and reads key names in any case", () => {
    const identity = [
      policy({
        Effect: "Allow",
        Action: "iam:PassRole",
        Resource: "*",
        Condition: {
          StringEquals: {
            "iam:PassedToService": [
              "pods.eks.amazonaws.com",
              "eks.amazonaws.com"
            ],
            "aws:RequestedRegion": "us-east-1"
          }
        }
      })
    ];
    const request = (context: Record<string, string>) =>
      evaluateIam({ action: "iam:PassRole", resource: "*", context }, identity);
    expect(
      request({
        "IAM:passedtoservice": "eks.amazonaws.com",
        "aws:requestedregion": "us-east-1"
      })
    ).toBe("allowed");
    expect(request({ "iam:PassedToService": "eks.amazonaws.com" })).toBe(
      "implicitDeny"
    );
  });

  it("accepts a single statement object", () => {
    expect(
      evaluateIam({ action: "sts:GetCallerIdentity", resource: "*" }, [
        {
          Version: "2012-10-17",
          Statement: {
            Effect: "Allow",
            Action: "sts:GetCallerIdentity",
            Resource: "*"
          }
        }
      ])
    ).toBe("allowed");
  });

  it.each([
    [{ Statement: [] as unknown[] }, null],
    [{}, "An IAM policy needs a Statement."],
    [
      policy({ Effect: "Allow", Action: "*", Resource: "*", Principal: "*" }),
      "The IAM evaluator does not know element Principal."
    ],
    [
      policy({ Effect: "Allow", Action: "*", NotAction: "x", Resource: "*" }),
      "A statement needs exactly one of Action and NotAction."
    ],
    [
      policy({ Effect: "Allow", Action: "*" }),
      "A statement needs exactly one of Resource and NotResource."
    ],
    [
      policy({
        Effect: "Allow",
        Action: "*",
        Resource: "*",
        Condition: { NumericLessThan: { "aws:MultiFactorAuthAge": "3600" } }
      }),
      "The IAM evaluator does not know operator NumericLessThan."
    ],
    [
      policy({ Effect: "Maybe", Action: "*", Resource: "*" }),
      "Unknown Effect Maybe."
    ]
  ])("refuses what it can't evaluate: %j", (input, message) => {
    const run = () =>
      evaluateIam({ action: "s3:GetObject", resource: "*" }, [input]);
    if (message === null) expect(run()).toBe("implicitDeny");
    else expect(run).toThrow(message);
  });
});
