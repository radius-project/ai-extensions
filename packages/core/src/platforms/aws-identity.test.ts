import { describe, expect, it } from "vitest";
import {
  AWS_CLI_MINIMUM_VERSION,
  awsRoleArn,
  awsRoleTags,
  buildAwsDeployRoleName,
  buildAwsEnvironmentPermissionPolicy,
  buildAwsEnvironmentPolicyName,
  buildGitHubTrustPolicy,
  checkAwsCliVersion,
  configMapClusterMessage,
  createGitHubOidcProviderCommand,
  githubOidcProviderArn,
  isAwsAccountId,
  isAwsRegion,
  isAwsRoleName,
  isRadiusManagedRole,
  mergeGitHubTrustSubject,
  parseAwsCliVersion,
  parseAwsRoleArn,
  parsePolicyDocument,
  removeGitHubTrustSubject,
  trustedGitHubSubjects
} from "./aws-identity.js";

const ACCOUNT = "123456789012";
const DEV = "repo:octo/shop:environment:dev";
const PROD = "repo:octo/shop:environment:prod";

describe("AWS CLI version gate", () => {
  it.each([
    ["aws-cli/2.15.3 Python/3.11.6 Darwin/23.0.0", true],
    ["aws-cli/2.16.0 Python/3.11.6", true],
    ["aws-cli/3.0.0 Python/3.12", true],
    ["aws-cli/2.15.2 Python/3.11.6", false],
    ["aws-cli/2.7.31 Python/3.9.11", false],
    ["aws-cli/1.29.0 Python/3.9", false]
  ])("checks %s", (output, ok) => {
    expect(checkAwsCliVersion(output).ok).toBe(ok);
  });

  it("names the installed and required versions and the upgrade link", () => {
    const result = checkAwsCliVersion("aws-cli/2.7.31 Python/3.9.11");
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining(
        `AWS CLI 2.7.31 is installed, which cannot grant the deploy role access to an EKS cluster. Radius needs AWS CLI ${AWS_CLI_MINIMUM_VERSION} or newer`
      )
    });
  });

  it("shows the CLI's own output when no version can be read", () => {
    const result = checkAwsCliVersion("command not found: aws");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain(
      "Could not run the AWS CLI: command not found: aws"
    );
    expect(parseAwsCliVersion("")).toBeNull();
  });

  it("says there was no version output when the CLI printed nothing", () => {
    const result = checkAwsCliVersion("  ");
    expect(!result.ok && result.message).toContain(
      "Could not run the AWS CLI: no version output."
    );
  });

  it("reports the parsed version on success", () => {
    expect(checkAwsCliVersion("aws-cli/2.17.1 Python/3")).toEqual({
      ok: true,
      version: "2.17.1"
    });
  });
});

describe("names and identifiers", () => {
  it("proposes radius-deploy-<owner>-<repo>", () => {
    expect(buildAwsDeployRoleName("contoso/storefront")).toBe(
      "radius-deploy-contoso-storefront"
    );
  });

  it("truncates the role name to 64 characters without a trailing dash", () => {
    const name = buildAwsDeployRoleName(
      `owner/${"a".repeat(48)}-${"b".repeat(20)}`
    );
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.endsWith("-")).toBe(false);
    expect(isAwsRoleName(name)).toBe(true);
  });

  it("names the environment policy after the environment only", () => {
    expect(buildAwsEnvironmentPolicyName("dev")).toBe("radius-deploy-dev");
    expect(buildAwsEnvironmentPolicyName("qa:east")).toBe(
      "radius-deploy-qa-east"
    );
  });

  it.each([
    ["123456789012", true],
    ["12345678901", false],
    ["abcdefghijkl", false]
  ])("validates account id %s", (value, ok) => {
    expect(isAwsAccountId(value)).toBe(ok);
  });

  it.each([
    ["us-west-2", true],
    ["us-gov-west-1", true],
    ["useast1", false],
    ["", false]
  ])("validates region %s", (value, ok) => {
    expect(isAwsRegion(value)).toBe(ok);
  });

  it("round-trips role ARNs, including role paths", () => {
    expect(awsRoleArn(ACCOUNT, "r")).toBe(`arn:aws:iam::${ACCOUNT}:role/r`);
    expect(parseAwsRoleArn(`arn:aws:iam::${ACCOUNT}:role/team/r`)).toEqual({
      partition: "aws",
      accountId: ACCOUNT,
      roleName: "r"
    });
    expect(
      parseAwsRoleArn(`arn:aws-us-gov:iam::${ACCOUNT}:role/r`)?.partition
    ).toBe("aws-us-gov");
    expect(parseAwsRoleArn("arn:aws:iam::1:user/x")).toBeNull();
  });

  it("hands over the provider and access-entry commands", () => {
    expect(createGitHubOidcProviderCommand()).toContain(
      "aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com"
    );
    expect(configMapClusterMessage("c1", "us-west-2")).toContain(
      "Cluster c1 uses CONFIG_MAP authentication, which does not support access entries."
    );
    expect(configMapClusterMessage("c1", "us-west-2")).toContain(
      "aws eks update-cluster-config --name c1 --region us-west-2 --access-config authenticationMode=API_AND_CONFIG_MAP"
    );
  });
});

describe("trust policy", () => {
  it("builds a trust policy for one subject", () => {
    const document = buildGitHubTrustPolicy(ACCOUNT, [DEV]);
    expect(document.Statement[0]).toMatchObject({
      Effect: "Allow",
      Principal: { Federated: githubOidcProviderArn(ACCOUNT) },
      Action: "sts:AssumeRoleWithWebIdentity"
    });
    expect(trustedGitHubSubjects(document, ACCOUNT)).toEqual([DEV]);
  });

  it("ignores statements without a federated principal or a subject condition", () => {
    const policy = parsePolicyDocument(
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: "*",
            Action: "sts:AssumeRoleWithWebIdentity"
          },
          {
            Effect: "Allow",
            Principal: { Federated: githubOidcProviderArn(ACCOUNT) },
            Action: "sts:AssumeRoleWithWebIdentity"
          },
          ...buildGitHubTrustPolicy(ACCOUNT, [DEV]).Statement
        ]
      })
    );
    expect(trustedGitHubSubjects(policy, ACCOUNT)).toEqual([DEV]);
  });

  it("merges a subject into what the role already trusts", () => {
    const merged = mergeGitHubTrustSubject(
      buildGitHubTrustPolicy(ACCOUNT, [DEV]),
      ACCOUNT,
      PROD
    );
    expect(merged.kept).toBe(1);
    expect(merged.changed).toBe(true);
    expect(trustedGitHubSubjects(merged.policy, ACCOUNT)).toEqual([DEV, PROD]);
  });

  const statementWith = (condition: unknown) => ({
    Effect: "Allow",
    Principal: { Federated: githubOidcProviderArn(ACCOUNT) },
    Action: "sts:AssumeRoleWithWebIdentity",
    ...(condition === undefined ? {} : { Condition: condition })
  });

  it.each([
    [
      "a custom audience",
      {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "custom",
          "token.actions.githubusercontent.com:sub": DEV
        }
      }
    ],
    [
      "an extra condition Radius cannot read",
      {
        StringEquals: { "token.actions.githubusercontent.com:sub": DEV },
        StringLike: {
          "token.actions.githubusercontent.com:job_workflow_ref": "x/*"
        }
      }
    ],
    [
      "an operator Radius cannot read",
      { ForAnyValue: { "token.actions.githubusercontent.com:sub": DEV } }
    ],
    ["a malformed condition", "StringEquals"],
    ["a malformed operator block", { StringEquals: "x" }]
  ])(
    "adds its own statement instead of relying on one with %s",
    (_label, condition) => {
      const existing = parsePolicyDocument({
        Statement: [statementWith(condition)]
      });
      const merged = mergeGitHubTrustSubject(existing, ACCOUNT, DEV);
      expect(merged.changed).toBe(true);
      expect(merged.policy.Statement).toHaveLength(2);
      expect(merged.policy.Statement[0]).toEqual(existing.Statement[0]);
      expect(merged.policy.Statement[1]).toEqual(
        buildGitHubTrustPolicy(ACCOUNT, [DEV]).Statement[0]
      );
    }
  );

  it.each([
    [
      "a wildcard audience",
      {
        StringLike: {
          "token.actions.githubusercontent.com:aud": "*",
          "token.actions.githubusercontent.com:sub": DEV
        }
      }
    ],
    [
      "the AWS audience in a list",
      {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": [
            "custom",
            "sts.amazonaws.com"
          ],
          "token.actions.githubusercontent.com:sub": DEV
        }
      }
    ]
  ])(
    "treats a subject trusted with %s as already trusted",
    (_label, condition) => {
      const existing = parsePolicyDocument({
        Statement: [statementWith(condition)]
      });
      expect(mergeGitHubTrustSubject(existing, ACCOUNT, DEV).changed).toBe(
        false
      );
    }
  );

  it("adds a subject statement beside one with no condition", () => {
    const existing = parsePolicyDocument({
      Statement: [statementWith(undefined)]
    });
    const merged = mergeGitHubTrustSubject(existing, ACCOUNT, DEV);
    expect(merged.policy.Statement).toEqual([
      existing.Statement[0],
      buildGitHubTrustPolicy(ACCOUNT, [DEV]).Statement[0]
    ]);
  });

  it("leaves the policy unchanged when the subject is already trusted", () => {
    const document = buildGitHubTrustPolicy(ACCOUNT, [DEV]);
    const merged = mergeGitHubTrustSubject(document, ACCOUNT, DEV);
    expect(merged).toEqual({ policy: document, kept: 0, changed: false });
  });

  it("keeps unrelated statements on a platform-owned role", () => {
    const other = {
      Effect: "Allow",
      Principal: { Service: "ec2.amazonaws.com" },
      Action: "sts:AssumeRole"
    };
    const merged = mergeGitHubTrustSubject(
      { Version: "2012-10-17", Statement: [other] },
      ACCOUNT,
      DEV
    );
    expect(merged.kept).toBe(0);
    expect(merged.policy.Statement).toHaveLength(2);
    expect(merged.policy.Statement[0]).toBe(other);
  });

  it("removes one subject and keeps the others", () => {
    const removal = removeGitHubTrustSubject(
      buildGitHubTrustPolicy(ACCOUNT, [DEV, PROD]),
      ACCOUNT,
      DEV
    );
    expect(removal.removed).toBe(true);
    expect(removal.remaining).toBe(1);
    expect(trustedGitHubSubjects(removal.policy, ACCOUNT)).toEqual([PROD]);
  });

  it("keeps a valid deny statement once the last subject is removed", () => {
    const removal = removeGitHubTrustSubject(
      buildGitHubTrustPolicy(ACCOUNT, [DEV]),
      ACCOUNT,
      DEV
    );
    expect(removal.remaining).toBe(0);
    expect(removal.policy.Statement).toEqual([
      expect.objectContaining({ Effect: "Deny" })
    ]);
    const readded = mergeGitHubTrustSubject(removal.policy, ACCOUNT, PROD);
    expect(readded.policy.Statement).toHaveLength(1);
    expect(trustedGitHubSubjects(readded.policy, ACCOUNT)).toEqual([PROD]);
  });

  it("reports nothing removed for a subject the role never trusted", () => {
    const removal = removeGitHubTrustSubject(
      buildGitHubTrustPolicy(ACCOUNT, [PROD]),
      ACCOUNT,
      DEV
    );
    expect(removal.removed).toBe(false);
    expect(removal.remaining).toBe(1);
  });

  it("parses encoded, string, and object documents", () => {
    const document = buildGitHubTrustPolicy(ACCOUNT, [DEV]);
    const json = JSON.stringify(document);
    expect(parsePolicyDocument(document)).toEqual(document);
    expect(parsePolicyDocument(json)).toEqual(document);
    expect(parsePolicyDocument(encodeURIComponent(json))).toEqual(document);
    expect(parsePolicyDocument({ Statement: {} })).toEqual({
      Version: "2012-10-17",
      Statement: [{}]
    });
    expect(() => parsePolicyDocument("[]")).toThrow(
      "The IAM policy document is not a JSON object."
    );
  });
});

describe("permissions and provenance", () => {
  it("limits the power-user grant to the environment's region and never grants IAM", () => {
    const policy = buildAwsEnvironmentPermissionPolicy("us-west-2");
    expect(policy.Statement[0]).toMatchObject({
      NotAction: ["iam:*", "organizations:*", "account:*"],
      Condition: { StringEquals: { "aws:RequestedRegion": ["us-west-2"] } }
    });
    expect(JSON.stringify(policy)).not.toContain('"iam:*"]');
  });

  it("skips malformed role tags", () => {
    expect(
      awsRoleTags({
        Tags: [
          "radius-managed",
          { Key: "radius-managed", Value: true },
          { Key: 7, Value: "x" },
          { Key: "team", Value: "shop" }
        ]
      })
    ).toEqual({ team: "shop" });
  });

  it("recognizes only roles Radius tagged for this repository", () => {
    const role = {
      Tags: [
        { Key: "radius-managed", Value: "true" },
        { Key: "radius-repository", Value: "Octo/Shop" }
      ]
    };
    expect(awsRoleTags(role)).toEqual({
      "radius-managed": "true",
      "radius-repository": "Octo/Shop"
    });
    expect(isRadiusManagedRole(role, "octo/shop")).toBe(true);
    expect(isRadiusManagedRole(role, "octo/other")).toBe(false);
    expect(isRadiusManagedRole({ Tags: [] }, "octo/shop")).toBe(false);
    expect(
      isRadiusManagedRole(
        { Tags: [{ Key: "radius-managed", Value: "true" }] },
        "octo/shop"
      )
    ).toBe(false);
    expect(isRadiusManagedRole(null, "octo/shop")).toBe(false);
  });
});
