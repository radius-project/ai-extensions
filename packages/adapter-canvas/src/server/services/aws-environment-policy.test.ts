import { describe, expect, it } from "vitest";
import {
  buildGitHubTrustPolicy,
  buildAwsEnvironmentPermissionPolicy
} from "@radius-project/core";
import { awsEnvironmentPolicyName } from "../../aws-deploy-role-name.js";
import {
  attachEnvironmentPolicy,
  readLegacyEnvironmentPolicy,
  resolveEnvironmentPolicyForRemoval,
  resolveEnvironmentPolicyForSetup
} from "./aws-environment-policy.js";
import type { AwsCommandResult } from "./aws-deploy-identity.js";

const ACCOUNT = "123456789012";
const SUBJECT = "repo:octo/shop:environment:dev";
const request = {
  repo: "octo/shop",
  environment: "dev",
  roleName: "picked",
  accountId: ACCOUNT,
  subjects: [SUBJECT]
};
const role = {
  AssumeRolePolicyDocument: buildGitHubTrustPolicy(ACCOUNT, [SUBJECT])
};
const document = buildAwsEnvironmentPermissionPolicy("us-east-2");
document.Statement.push({
  Effect: "Allow",
  Action: "iam:DeleteServiceLinkedRole",
  Resource: "*"
});
const legacy = { ok: true as const, name: "radius-deploy-dev", document };
const policyName = awsEnvironmentPolicyName(request.repo, request.environment);
const ok = (value: unknown = ""): AwsCommandResult => ({
  code: 0,
  stdout: typeof value === "string" ? value : JSON.stringify(value),
  stderr: ""
});
const fail = (stderr: string): AwsCommandResult => ({
  code: 254,
  stdout: "",
  stderr
});
function runner(...answers: AwsCommandResult[]) {
  const calls: string[][] = [];
  return {
    calls,
    runAws: async (args: string[]) => {
      calls.push(args);
      const answer = answers.shift();
      if (!answer) throw new Error(`Unscripted AWS command: ${args.join(" ")}`);
      return answer;
    }
  };
}

describe("legacy policy ownership", () => {
  const response = ok({ PolicyName: legacy.name, PolicyDocument: document });
  it("recognizes a picked role through its exact trust subjects without Radius tags", async () => {
    expect(
      await readLegacyEnvironmentPolicy(request, role, runner(response))
    ).toEqual(legacy);
  });
  it.each([
    ["no owner", []],
    ["other repository", [SUBJECT, "repo:octo/other:environment:dev"]],
    ["sanitized collision", [SUBJECT, "repo:octo/shop:environment:dev!"]],
    ["wildcard", [SUBJECT, "repo:octo/shop:environment:*"]],
    ["unrecognized subject", [SUBJECT, "repository_id:22:ref:main"]]
  ])("rejects a picked role with %s", async (_label, subjects) => {
    const ports = runner(response);
    expect(
      await readLegacyEnvironmentPolicy(
        request,
        { AssumeRolePolicyDocument: buildGitHubTrustPolicy(ACCOUNT, subjects) },
        ports
      )
    ).toMatchObject({ ok: false });
    expect(ports.calls).toHaveLength(1);
  });
  it.each([
    fail("AccessDenied"),
    ok("not json"),
    ok({ PolicyName: "other", PolicyDocument: document }),
    ok({ PolicyName: legacy.name }),
    ok({ PolicyName: legacy.name, PolicyDocument: "invalid" })
  ])("fails closed on an unreadable policy response", async (answer) => {
    expect(
      await readLegacyEnvironmentPolicy(request, role, runner(answer))
    ).toMatchObject({ ok: false });
  });
  it("treats only NoSuchEntity as an absent policy", async () => {
    expect(
      await readLegacyEnvironmentPolicy(
        request,
        role,
        runner(fail("NoSuchEntity"))
      )
    ).toEqual({ ok: true, name: null, document: null });
  });
});

describe("migration at the inline-policy quota", () => {
  const input = { ...request, region: "us-east-2", legacy };
  it.each([
    [{ code: 1, stdout: "", stderr: "", timedOut: true }, "timed out"],
    [{ code: 1, stdout: "stdout diagnostic", stderr: "" }, "stdout diagnostic"],
    [{ code: 1, stdout: "", stderr: "" }, "no output"]
  ])(
    "reports timeout and output-only policy failures",
    async (answer, message) => {
      expect(
        await attachEnvironmentPolicy(input, runner(answer))
      ).toMatchObject({
        ok: false,
        message: expect.stringContaining(message),
        policyWritten: false
      });
    }
  );
  it("reuses the legacy policy's quota instead of requiring two copies", async () => {
    const ports = runner(fail("LimitExceeded"), ok(), ok());
    expect(await attachEnvironmentPolicy(input, ports)).toEqual({
      ok: true,
      policyName
    });
    expect(
      ports.calls.map((args) => [
        args[1],
        args[args.indexOf("--policy-name") + 1]
      ])
    ).toEqual([
      ["put-role-policy", policyName],
      ["delete-role-policy", legacy.name],
      ["put-role-policy", policyName]
    ]);
    expect(ports.calls.at(-1)).not.toContain(JSON.stringify(document));
  });
  it.each([ok(), fail("AccessDenied")])(
    "reports whether a failed replacement restored the original grant",
    async (restored) => {
      const ports = runner(
        fail("LimitExceeded"),
        ok(),
        fail("AccessDenied: replacement"),
        restored
      );
      const result = await attachEnvironmentPolicy(input, ports);
      expect(result).toMatchObject({ ok: false, policyWritten: false });
      expect(!result.ok && result.message).toContain(
        restored.code === 0 ?
          "original legacy policy was restored"
        : "Restoring the original policy"
      );
      expect(ports.calls.at(-1)).toContain(JSON.stringify(document));
      expect(ports.calls.at(-1)).toContain(legacy.name);
    }
  );
  it("does not retry the replacement when legacy deletion fails", async () => {
    const ports = runner(fail("LimitExceeded"), fail("AccessDenied"));
    expect(await attachEnvironmentPolicy(input, ports)).toMatchObject({
      ok: false,
      code: "aws-legacy-policy-removal-failed",
      policyWritten: false
    });
    expect(ports.calls).toHaveLength(2);
  });
  it("reports the remaining broad grant when ordinary migration cannot delete it", async () => {
    const ports = runner(ok(), fail("AccessDenied"));
    expect(await attachEnvironmentPolicy(input, ports)).toMatchObject({
      ok: false,
      policyWritten: true,
      message: expect.stringContaining("legacy permissions may still be active")
    });
  });
  it.each([fail("NoSuchEntity"), ok()])(
    "accepts an already removed legacy policy",
    async (removed) => {
      expect(
        await attachEnvironmentPolicy(input, runner(ok(), removed))
      ).toEqual({ ok: true, policyName });
    }
  );
  it.each(["AccessDenied", "LimitExceeded"])(
    "reports a new-policy failure without deleting other environments: %s",
    async (error) => {
      const ports = runner(fail(error));
      expect(
        await attachEnvironmentPolicy(
          { ...input, legacy: { ok: true, name: null, document: null } },
          ports
        )
      ).toMatchObject({ ok: false, policyWritten: false });
      expect(ports.calls).toHaveLength(1);
    }
  );
});

describe("recorded policy identity", () => {
  it("uses the saved name after a repository rename without recomputing its hash", async () => {
    const ports = runner();
    expect(
      await resolveEnvironmentPolicyForRemoval(
        { ...request, repo: "new/name", policyName },
        ports
      )
    ).toEqual({ ok: true, policyName });
    expect(ports.calls).toEqual([]);
  });

  describe("unrecorded setup policies", () => {
    const setup = {
      ...request,
      roleArn: `arn:aws:iam::${ACCOUNT}:role/picked`
    };
    const unexpectedForeignPolicy = async (): Promise<never> => {
      throw new Error("unexpected foreign policy lookup");
    };
    it("refuses conflicting immutable owners without consulting mutable metadata", async () => {
      expect(
        await resolveEnvironmentPolicyForSetup(
          {
            ...setup,
            subjects: [
              "repo:octo@7/other@42:environment:dev",
              "repo:octo@7/other@77:environment:dev"
            ]
          },
          {
            ...runner(
              ok({
                PolicyNames: [awsEnvironmentPolicyName("octo/other", "dev")]
              })
            ),
            isRecordedForeignPolicy: unexpectedForeignPolicy
          }
        )
      ).toMatchObject({ ok: false });
    });
    it("allows new and existing grants without changing unrelated policies", async () => {
      const ports = runner(
        ok({
          PolicyNames: [
            policyName,
            legacy.name,
            awsEnvironmentPolicyName("octo/shop", "prod")
          ]
        })
      );
      expect(
        await resolveEnvironmentPolicyForSetup(setup, {
          ...ports,
          isRecordedForeignPolicy: unexpectedForeignPolicy
        })
      ).toEqual({ ok: true, policyName });
    });
    it("refuses an older hash that has no repository ownership evidence", async () => {
      expect(
        await resolveEnvironmentPolicyForSetup(setup, {
          ...runner(
            ok({ PolicyNames: [awsEnvironmentPolicyName("old/name", "dev")] })
          ),
          isRecordedForeignPolicy: unexpectedForeignPolicy
        })
      ).toMatchObject({ ok: false });
    });
    it.each([true, false])(
      "preserves another repository's same-name environment only with saved binding: %s",
      async (recorded) => {
        const foreign = awsEnvironmentPolicyName("octo/other", "dev");
        const result = await resolveEnvironmentPolicyForSetup(
          {
            ...setup,
            subjects: [SUBJECT, "repo:octo/other:environment:dev"]
          },
          {
            ...runner(ok({ PolicyNames: [foreign] })),
            isRecordedForeignPolicy: async (candidate) => {
              expect(candidate).toEqual({
                repo: "octo/other",
                environment: "dev",
                roleArn: setup.roleArn,
                policyName: foreign
              });
              return recorded;
            }
          }
        );
        expect(result).toMatchObject({ ok: recorded });
        if (recorded) expect(result).toEqual({ ok: true, policyName });
      }
    );
    it("fails closed when another repository's binding cannot be read", async () => {
      expect(
        await resolveEnvironmentPolicyForSetup(
          {
            ...setup,
            subjects: ["repo:old/name:environment:dev"]
          },
          {
            ...runner(
              ok({ PolicyNames: [awsEnvironmentPolicyName("old/name", "dev")] })
            ),
            isRecordedForeignPolicy: async () => {
              throw new Error("GitHub AccessDenied");
            }
          }
        )
      ).toMatchObject({ ok: false });
    });
    it.each([fail("AccessDenied"), ok({ PolicyNames: [42] })])(
      "refuses an unreadable inventory before a new grant",
      async (answer) => {
        expect(
          await resolveEnvironmentPolicyForSetup(setup, {
            ...runner(answer),
            isRecordedForeignPolicy: unexpectedForeignPolicy
          })
        ).toMatchObject({ ok: false });
      }
    );
  });
  it.each(["", "unrelated", awsEnvironmentPolicyName("octo/shop", "prod")])(
    "rejects an invalid recorded name %s",
    async (name) => {
      expect(
        await resolveEnvironmentPolicyForRemoval(
          { ...request, policyName: name },
          runner()
        )
      ).toMatchObject({ ok: false });
    }
  );
  it("confirms a fallback name against IAM for environments without a saved name", async () => {
    expect(
      await resolveEnvironmentPolicyForRemoval(
        request,
        runner(ok({ PolicyNames: [policyName] }))
      )
    ).toEqual({ ok: true, policyName });
  });
  it("does not report success when the old input slug produced an unknown hash", async () => {
    expect(
      await resolveEnvironmentPolicyForRemoval(
        request,
        runner(
          ok({ PolicyNames: [awsEnvironmentPolicyName("old/alias", "dev")] })
        )
      )
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("did not guess")
    });
  });
  it("leaves other environments alone when this grant is already absent", async () => {
    expect(
      await resolveEnvironmentPolicyForRemoval(
        request,
        runner(
          ok({ PolicyNames: [awsEnvironmentPolicyName("octo/shop", "prod")] })
        )
      )
    ).toEqual({ ok: true, policyName: null });
  });
  it.each([
    fail("AccessDenied"),
    ok("invalid"),
    ok({}),
    ok({ PolicyNames: [42] })
  ])("refuses an unreadable fallback inventory", async (answer) => {
    expect(
      await resolveEnvironmentPolicyForRemoval(request, runner(answer))
    ).toMatchObject({ ok: false });
  });
});
