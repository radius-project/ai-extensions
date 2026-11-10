import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  acceptedGitHubSubjects,
  AWS_CLI_MINIMUM_VERSION,
  AWS_LOCK_REMOVABLE_AFTER_MS,
  awsLockHolderLabel,
  awsLockPolicyArn,
  awsRoleArn,
  awsRoleTags,
  buildAwsDeployRoleName,
  buildAwsEnvironmentPermissionPolicy,
  buildAwsEnvironmentPolicyName,
  buildLegacyAwsEnvironmentPolicyName,
  buildAwsLockPolicyDocument,
  buildAwsLockPolicyName,
  buildGitHubTrustPolicy,
  checkAwsCliVersion,
  classifyAwsCliFailure,
  configMapClusterMessage,
  createGitHubOidcProviderCommand,
  describeAwsLockHolder,
  formatAwsLockTime,
  eksAcceptsAccessEntries,
  eksAuthenticationMode,
  githubOidcProviderArn,
  isAwsAccountId,
  isAwsRegion,
  isAwsRoleName,
  isEksClusterName,
  isRadiusManagedRole,
  legacyAwsPolicyOwnershipError,
  mergeGitHubTrustSubject,
  namesGitHubProvider,
  parseAwsCliVersion,
  parseAwsLockHolder,
  parseAwsRoleArn,
  parsePolicyDocument,
  readRecordedAwsLock,
  radiusRoleRepositoryId,
  describeRadiusRoleOwner,
  namesOneEnvironment,
  namesRepositoryEnvironment,
  immutableEnvironmentRepository,
  removeGitHubTrustSubject,
  restrictedGitHubSubjects,
  repositoryLessSubjectMessage,
  subjectNamesRepository,
  trustAllowsOnlySubjects,
  trustedGitHubSubjects
} from "./aws-identity.js";

describe("immutable environment repository ownership", () => {
  it.each([
    "repo:old-owner@7/old-name@42:environment:dev",
    "repo:old-owner/old-name:repository_id:42:environment:dev",
    "repository:old-owner/old-name:repository_id:42:environment:dev"
  ])("retains the repository ID behind an old name: %s", (subject) => {
    expect(immutableEnvironmentRepository(subject, "dev")).toEqual({
      repo: "old-owner/old-name",
      repoId: 42
    });
  });
  it.each([
    "",
    "repo:old/name:environment:dev",
    "repo:old@7/name:environment:dev",
    "repo:old@invalid/name@42:environment:dev",
    "repo:old@7/name@42:environment:prod",
    "repo:old@7/name@42:environment:*",
    "repo:old@7/name@42:repository:other/name:environment:dev",
    "repo:old@7/name@42:repository_id:43:environment:dev",
    "repo:old/name:repository_id:0:environment:dev",
    "repo:old/name:repository_id:1e2:environment:dev",
    "repo:old/name:repository_id:99999999999999999:environment:dev",
    "repository_id:42:environment:dev"
  ])(
    "does not infer ownership from incomplete or ambiguous claims: %s",
    (subject) => {
      expect(immutableEnvironmentRepository(subject, "dev")).toBeNull();
    }
  );
});

const ACCOUNT = "123456789012";
const GITHUB = "token.actions.githubusercontent.com";
const DEV = "repo:octo/shop:environment:dev";
const PROD = "repo:octo/shop:environment:prod";

describe("AWS CLI failure classification", () => {
  it.each([
    ["spawn aws ENOENT", "missing-cli"],
    ["aws: command not found", "missing-cli"],
    ["aws is not recognized as an internal command", "missing-cli"],
    [
      "Error when retrieving credentials from custom-process: credential-helper: command not found",
      "provider-failed"
    ],
    ["credential_process: spawn helper ENOENT", "provider-failed"],
    [
      "Error when retrieving token from sso: Token has expired and refresh failed",
      "login-required"
    ],
    ["Unable to locate credentials", "login-required"],
    ["ExpiredToken", "credentials-expired"],
    ["InvalidClientTokenId", "credentials-invalid"],
    ["AccessDenied", "access-denied"],
    [
      "An error occurred (AccessDenied) when calling the AssumeRole operation: User: arn:aws:iam::123456789012:user/dev is not authorized to perform: sts:AssumeRole on resource: arn:aws:iam::123456789012:role/MFA-admin",
      "access-denied"
    ],
    [
      "Enter MFA code for arn:aws:iam::123456789012:mfa/dev:",
      "provider-failed"
    ],
    ["credential process failed", "provider-failed"],
    ["connection timed out", "timeout"],
    ["unavailable endpoint", "command-failed"]
  ])("classifies %s as %s", (output, failure) => {
    expect(classifyAwsCliFailure({ output })).toBe(failure);
  });

  it("preserves a subprocess timeout over provider diagnostics", () => {
    expect(
      classifyAwsCliFailure({
        output: "credential_process is waiting for input",
        timedOut: true
      })
    ).toBe("timeout");
  });
});

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

  it("reports an unreadable version without echoing process output", () => {
    const result = checkAwsCliVersion("command not found: aws");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain(
      "Could not read the AWS CLI version."
    );
    expect(!result.ok && result.message).not.toContain("command not found");
    expect(!result.ok && result.message).toContain("2.15.3");
    expect(!result.ok && result.message).toContain(
      "getting-started-install.html"
    );
    expect(parseAwsCliVersion("")).toBeNull();
  });

  it("reports an unreadable version when the CLI printed nothing", () => {
    const result = checkAwsCliVersion("  ");
    expect(!result.ok && result.message).toContain(
      "Could not read the AWS CLI version."
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
  const unusedHash = (): string => {
    throw new Error("A name that fits must not be hashed.");
  };
  const DIGEST =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  it("proposes radius-deploy-<owner>-<repo>", () => {
    expect(buildAwsDeployRoleName("contoso/storefront", unusedHash)).toBe(
      "radius-deploy-contoso-storefront"
    );
  });

  it("keeps a name of exactly 64 characters as it is", () => {
    const name = buildAwsDeployRoleName(`o/${"a".repeat(48)}`, unusedHash);
    expect(name).toBe(`radius-deploy-o-${"a".repeat(48)}`);
    expect(name).toHaveLength(64);
  });

  it("shortens a longer name to 57 characters, a dash, and 6 hash characters", () => {
    const hashed: string[] = [];
    const name = buildAwsDeployRoleName(`o/${"a".repeat(49)}`, (text) => {
      hashed.push(text);
      return DIGEST;
    });
    expect(name).toBe(`radius-deploy-o-${"a".repeat(41)}-012345`);
    expect(name).toHaveLength(64);
    expect(isAwsRoleName(name)).toBe(true);
    expect(hashed).toEqual([`o/${"a".repeat(49)}`]);
  });

  it("hashes the repository in lowercase, as GitHub and IAM ignore case", () => {
    const hashed: string[] = [];
    buildAwsDeployRoleName(`Octo/${"A".repeat(60)}`, (text) => {
      hashed.push(text);
      return DIGEST;
    });
    expect(hashed).toEqual([`octo/${"a".repeat(60)}`]);
  });

  it("recognizes legacy policy names without using them for new policies", () => {
    expect(buildLegacyAwsEnvironmentPolicyName("dev")).toBe(
      "radius-deploy-dev"
    );
    expect(buildLegacyAwsEnvironmentPolicyName("qa:east")).toBe(
      "radius-deploy-qa-east"
    );
  });

  const hash = (value: string): string =>
    createHash("sha256").update(value).digest("hex");

  it("separates repositories and environments on a shared role", () => {
    const names = [
      buildAwsEnvironmentPolicyName("octo/shop", "dev", hash),
      buildAwsEnvironmentPolicyName("octo/api", "dev", hash),
      buildAwsEnvironmentPolicyName("octo/shop", "prod", hash),
      buildAwsEnvironmentPolicyName("octo/shop", "qa:east", hash),
      buildAwsEnvironmentPolicyName("octo/shop", "qa-east", hash)
    ];
    expect(new Set(names).size).toBe(names.length);
    expect(names[0]).toBe("radius-deploy-dev-f5fb7acf8f59");
  });

  it("uses the same policy for case-insensitive repository and environment names", () => {
    expect(buildAwsEnvironmentPolicyName("Octo/Shop", "DEV", hash)).toBe(
      buildAwsEnvironmentPolicyName("octo/shop", "dev", hash)
    );
  });

  it("keeps the identity suffix when environment names require truncation", () => {
    const environment = "a".repeat(200);
    const first = buildAwsEnvironmentPolicyName("octo/shop", environment, hash);
    const second = buildAwsEnvironmentPolicyName(
      "octo/shop",
      `${environment}b`,
      hash
    );
    expect(first).toHaveLength(128);
    expect(first).toMatch(/-[a-f0-9]{12}$/);
    expect(second).toHaveLength(128);
    expect(first).not.toBe(second);
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

  describe("a statement that restricts the subject with more than one operator", () => {
    const AUD = "token.actions.githubusercontent.com:aud";
    const SUB = "token.actions.githubusercontent.com:sub";
    const both = (equals: string[], like: string[]) =>
      parsePolicyDocument({
        Statement: [
          statementWith({
            StringEquals: { [AUD]: "sts.amazonaws.com", [SUB]: equals },
            StringLike: { [SUB]: like }
          })
        ]
      });

    it("keeps it unchanged and adds a separate exact statement for a new subject", () => {
      const existing = both([PROD], [PROD]);
      const merged = mergeGitHubTrustSubject(existing, ACCOUNT, DEV);
      expect(merged.changed).toBe(true);
      expect(merged.policy.Statement).toEqual([
        existing.Statement[0],
        buildGitHubTrustPolicy(ACCOUNT, [DEV]).Statement[0]
      ]);
    });

    it("does not count a subject named in only one of the operators as trusted", () => {
      const existing = both([PROD, DEV], [PROD]);
      const merged = mergeGitHubTrustSubject(existing, ACCOUNT, DEV);
      expect(merged.changed).toBe(true);
      expect(merged.policy.Statement[1]).toEqual(
        buildGitHubTrustPolicy(ACCOUNT, [DEV]).Statement[0]
      );
    });

    it("counts a subject every operator accepts as trusted", () => {
      const existing = both([PROD, DEV], ["repo:octo/shop:environment:*"]);
      const merged = mergeGitHubTrustSubject(existing, ACCOUNT, DEV);
      expect(merged.changed).toBe(false);
      expect(merged.policy).toBe(existing);
    });
  });

  it.each([
    ["a wildcard", "repo:octo/shop:environment:*", false],
    ["a single-character wildcard", "repo:octo/shop:environment:de?", false],
    [
      "a pattern for another environment",
      "repo:octo/shop:environment:pro?",
      true
    ],
    ["an exact pattern for another environment", PROD, true],
    ["a literal dot", "repo:octo.shop:environment:dev", true]
  ])("evaluates a StringLike subject with %s", (_label, pattern, changed) => {
    const existing = parsePolicyDocument({
      Statement: [
        statementWith({
          StringLike: { "token.actions.githubusercontent.com:sub": pattern }
        })
      ]
    });
    const merged = mergeGitHubTrustSubject(
      existing,
      ACCOUNT,
      "repo:octo/shop:environment:dev"
    );
    expect(merged.changed).toBe(changed);
    if (changed) {
      // A StringLike statement is never extended; a new exact one is added.
      expect(merged.policy.Statement).toEqual([
        existing.Statement[0],
        buildGitHubTrustPolicy(ACCOUNT, ["repo:octo/shop:environment:dev"])
          .Statement[0]
      ]);
    }
  });

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

  describe("trustAllowsOnlySubjects", () => {
    const PROVIDER = githubOidcProviderArn(ACCOUNT);
    const github = (condition: unknown, extra: object = {}) => ({
      Effect: "Allow",
      Principal: { Federated: PROVIDER },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: condition,
      ...extra
    });

    it.each([
      ["the listed subjects", [DEV, PROD], [DEV, PROD]],
      ["a subset of the listed subjects", [PROD], [DEV, PROD]]
    ])("accepts a policy that trusts %s", (_label, trusted, listed) => {
      expect(
        trustAllowsOnlySubjects(
          buildGitHubTrustPolicy(ACCOUNT, trusted),
          ACCOUNT,
          listed
        )
      ).toBe(true);
    });

    it("accepts the deny-only policy left after the last subject", () => {
      const { policy } = removeGitHubTrustSubject(
        buildGitHubTrustPolicy(ACCOUNT, [DEV]),
        ACCOUNT,
        DEV
      );
      expect(trustAllowsOnlySubjects(policy, ACCOUNT, [])).toBe(true);
    });

    it.each([
      ["a subject outside the list", buildGitHubTrustPolicy(ACCOUNT, [DEV])],
      [
        "a wildcard pattern",
        {
          Version: "2012-10-17",
          Statement: [
            github({ StringLike: { [`${GITHUB}:sub`]: "repo:octo/*" } })
          ]
        }
      ],
      [
        "a GitHub statement with no subject constraint",
        {
          Version: "2012-10-17",
          Statement: [
            github({ StringEquals: { [`${GITHUB}:aud`]: "sts.amazonaws.com" } })
          ]
        }
      ],
      [
        "another principal",
        {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "ec2.amazonaws.com" },
              Action: "sts:AssumeRole"
            }
          ]
        }
      ],
      [
        "another principal beside the GitHub provider",
        {
          Version: "2012-10-17",
          Statement: [
            github(
              { StringEquals: { [`${GITHUB}:sub`]: PROD } },
              {
                Principal: {
                  Federated: PROVIDER,
                  AWS: `arn:aws:iam::${ACCOUNT}:root`
                }
              }
            )
          ]
        }
      ],
      [
        "another identity provider",
        {
          Version: "2012-10-17",
          Statement: [
            github(
              { StringEquals: { [`${GITHUB}:sub`]: PROD } },
              {
                Principal: {
                  Federated: [PROVIDER, "arn:aws:iam::1:oidc-provider/other"]
                }
              }
            )
          ]
        }
      ],
      [
        "a statement with no principal",
        { Version: "2012-10-17", Statement: [{ Effect: "Allow" }] }
      ]
    ])("rejects a policy with %s", (_label, policy) => {
      expect(trustAllowsOnlySubjects(policy, ACCOUNT, [PROD])).toBe(false);
    });

    it.each([`${PROD}*`, "repo:octo/shop:environment:pro?"])(
      "rejects the wildcard %s even when the pattern itself is listed",
      (pattern) => {
        const policy = {
          Version: "2012-10-17",
          Statement: [github({ StringLike: { [`${GITHUB}:sub`]: pattern } })]
        };
        expect(trustAllowsOnlySubjects(policy, ACCOUNT, [pattern])).toBe(false);
      }
    );

    it("accepts a StringLike value with no wildcard", () => {
      const policy = {
        Version: "2012-10-17",
        Statement: [github({ StringLike: { [`${GITHUB}:sub`]: PROD } })]
      };
      expect(trustAllowsOnlySubjects(policy, ACCOUNT, [PROD])).toBe(true);
    });
  });

  describe("namesOneEnvironment", () => {
    it.each([
      ["the name form", "repo:octo/shop:environment:dev"],
      ["the ID form", "repo:octo@7/shop@42:environment:dev"],
      ["an older name from before a rename", "repo:octo/old:environment:dev"],
      ["a repository ID", "repository_id:42:environment:dev"],
      ["the environment in another case", "repo:octo/shop:environment:DEV"]
    ])("accepts %s", (_label, subject) => {
      expect(namesOneEnvironment(subject, "dev")).toBe(true);
    });

    it("matches an environment name with a colon by its encoded form", () => {
      expect(
        namesOneEnvironment("repo:octo/shop:environment:a%3Ab", "a:b")
      ).toBe(true);
    });

    it.each([
      ["no environment", "repository_id:42"],
      ["no repository", "repository_owner:octo:environment:dev"],
      ["another environment", "repo:octo/shop:environment:prod"],
      ["two environments", "repo:octo/shop:environment:dev:environment:dev"],
      ["a wildcard", "repo:octo/shop:environment:*"],
      ["an empty value", "repo::environment:dev"],
      ["a malformed subject", "repo:octo/shop:environment"]
    ])("rejects %s", (_label, subject) => {
      expect(namesOneEnvironment(subject, "dev")).toBe(false);
    });
  });

  describe("namesRepositoryEnvironment", () => {
    const shop = { fullName: "octo/Shop", ownerId: 7, repoId: 42 };

    it.each([
      ["the name form", "repo:octo/shop:environment:prod"],
      ["the ID form", "repo:octo@7/shop@42:environment:prod"],
      ["a repository claim", "repository:octo/shop:environment:prod"],
      [
        "a repository ID",
        "repository_owner:octo:repository_id:42:environment:prod"
      ],
      ["another case", "repo:Octo/SHOP:environment:prod"]
    ])("accepts %s", (_label, subject) => {
      expect(namesRepositoryEnvironment(subject, shop)).toBe(true);
    });

    it.each([
      ["an owner-wide subject", "repository_owner:octo:environment:prod"],
      ["an owner ID subject", "repository_owner_id:7:environment:prod"],
      ["no environment", "repo:octo/shop"],
      [
        "a branch instead of an environment",
        "repo:octo/shop:ref:refs/heads/main"
      ],
      ["another repository", "repo:octo/other:environment:prod"],
      ["another repository ID", "repository_id:43:environment:prod"],
      ["a mismatched ID form", "repo:octo@7/shop@43:environment:prod"],
      ["a wildcard environment", "repo:octo/shop:environment:*"],
      ["a wildcard repository", "repo:octo/*:environment:prod"],
      ["an empty value", "repo::environment:prod"],
      ["an odd number of parts", "repo:octo/shop:environment"],
      ["an empty subject", ""]
    ])("rejects %s", (_label, subject) => {
      expect(namesRepositoryEnvironment(subject, shop)).toBe(false);
    });
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
  it.each(["us-east-2", "ap-southeast-7"])(
    "fits 17 regional grants without account-email access in %s",
    (region) => {
      const policy = buildAwsEnvironmentPermissionPolicy(region);
      expect(JSON.stringify(policy).length * 17).toBeLessThanOrEqual(10240);
      expect(JSON.stringify(policy)).not.toContain("account:GetPrimaryEmail");
    }
  );

  it("compact exclusions omit only access administration, preserving the EKS read APIs", () => {
    const patterns =
      buildAwsEnvironmentPermissionPolicy("us-east-2").Statement[0].NotAction;
    if (!Array.isArray(patterns)) throw new Error("Missing exclusions");
    const excluded = (action: string) =>
      patterns.some(
        (pattern) =>
          typeof pattern === "string" &&
          new RegExp(`^${pattern.replaceAll("*", ".*")}$`, "i").test(
            `eks:${action}`
          )
      );
    for (const action of [
      "CreateAccessEntry",
      "UpdateAccessEntry",
      "DeleteAccessEntry",
      "AssociateAccessPolicy",
      "DisassociateAccessPolicy"
    ])
      expect(excluded(action)).toBe(true);
    for (const action of [
      "DescribeAccessEntry",
      "ListAccessEntries",
      "ListAccessPolicies",
      "ListAssociatedAccessPolicies",
      "DescribeCluster"
    ])
      expect(excluded(action)).toBe(false);
  });

  it("recognizes picked-role ownership from trust and refuses unknown trust conditions", () => {
    const input = {
      repoId: 42,
      environment: "dev",
      accountId: ACCOUNT,
      subjects: [DEV]
    };
    const trust = buildGitHubTrustPolicy(ACCOUNT, [DEV, PROD]);
    expect(
      legacyAwsPolicyOwnershipError({
        ...input,
        role: { AssumeRolePolicyDocument: trust }
      })
    ).toBeNull();
    trust.Statement.push({
      Effect: "Allow",
      Principal: { Federated: githubOidcProviderArn(ACCOUNT) },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: { Bool: { "aws:MultiFactorAuthPresent": true } }
    });
    expect(
      legacyAwsPolicyOwnershipError({
        ...input,
        role: { AssumeRolePolicyDocument: trust }
      })
    ).toContain("cannot interpret");
  });

  it("accepts the legacy policy's role by its repository ID tag, not its name tag", () => {
    const input = {
      repoId: 42,
      environment: "dev",
      accountId: ACCOUNT,
      subjects: [DEV]
    };
    const role = (id: string | null) => ({
      AssumeRolePolicyDocument: buildGitHubTrustPolicy(ACCOUNT, []),
      Tags: [
        { Key: "radius-managed", Value: "true" },
        { Key: "radius-repository", Value: "octo/shop" },
        ...(id === null ? [] : [{ Key: "radius-repository-id", Value: id }])
      ]
    });
    expect(legacyAwsPolicyOwnershipError({ ...input, role: role("42") })).toBe(
      null
    );
    for (const id of ["99", null]) {
      expect(
        legacyAwsPolicyOwnershipError({ ...input, role: role(id) })
      ).toContain("Neither the role's trust subjects nor its ownership tags");
    }
  });

  it("limits the power-user grant to the environment's region and never grants IAM", () => {
    const policy = buildAwsEnvironmentPermissionPolicy("us-west-2");
    expect(policy.Statement[0]).toMatchObject({
      NotAction: [
        "iam:*",
        "organizations:*",
        "account:*",
        "eks:*teAccessEntry",
        "eks:*AccessPolicy"
      ],
      Condition: { StringEquals: { "aws:RequestedRegion": "us-west-2" } }
    });
    expect(JSON.stringify(policy)).not.toContain('"iam:*"]');
  });

  it("allows only recipe service-linked-role creation and never adds a deny", () => {
    const policy = buildAwsEnvironmentPermissionPolicy("us-east-2");
    expect(
      policy.Statement.every((statement) => statement.Effect === "Allow")
    ).toBe(true);
    expect(policy.Statement[1].Action).not.toContain(
      "iam:CreateServiceLinkedRole"
    );
    expect(JSON.stringify(policy)).not.toContain("iam:DeleteServiceLinkedRole");
    expect(policy.Statement[1]).not.toHaveProperty("Condition");
    expect(policy.Statement[2]).toEqual({
      Effect: "Allow",
      Action: "iam:CreateServiceLinkedRole",
      Resource: "*",
      Condition: {
        StringEquals: {
          "iam:AWSServiceName": [
            "rds.amazonaws.com",
            "elasticache.amazonaws.com",
            "opensearchservice.amazonaws.com"
          ]
        }
      }
    });
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

  it("recognizes only roles Radius tagged with this repository's ID", () => {
    const role = {
      Tags: [
        { Key: "radius-managed", Value: "true" },
        { Key: "radius-repository", Value: "Octo/Shop" },
        { Key: "radius-repository-id", Value: "42" }
      ]
    };
    expect(radiusRoleRepositoryId(role)).toBe(42);
    expect(isRadiusManagedRole(role, 42)).toBe(true);
    expect(isRadiusManagedRole(role, 43)).toBe(false);
    expect(isRadiusManagedRole(null, 42)).toBe(false);
  });

  it("gives a role with the right name but another repository's ID to that repository", () => {
    // A repository created at a renamed repository's old name.
    const role = {
      Tags: [
        { Key: "radius-managed", Value: "true" },
        { Key: "radius-repository", Value: "octo/shop" },
        { Key: "radius-repository-id", Value: "42" }
      ]
    };
    expect(isRadiusManagedRole(role, 99)).toBe(false);
    expect(describeRadiusRoleOwner(role)).toBe("octo/shop (repository ID 42)");
  });

  it("gives no repository a role an earlier build tagged only by name", () => {
    const role = {
      Tags: [
        { Key: "radius-managed", Value: "true" },
        { Key: "radius-repository", Value: "octo/shop" }
      ]
    };
    expect(radiusRoleRepositoryId(role)).toBeNull();
    expect(describeRadiusRoleOwner(role)).toBeNull();
  });

  it("reads Radius's tags whatever their key case, as IAM role tag keys ignore case", () => {
    const role = {
      Tags: [
        { Key: "Radius-Managed", Value: "true" },
        { Key: "RADIUS-REPOSITORY-ID", Value: "7" }
      ]
    };
    expect(radiusRoleRepositoryId(role)).toBe(7);
    expect(isRadiusManagedRole(role, 7)).toBe(true);
    expect(describeRadiusRoleOwner(role)).toBe("repository ID 7");
  });

  it.each([
    ["no tags", { Tags: [] }],
    ["no managed tag", { Tags: [{ Key: "radius-repository-id", Value: "7" }] }],
    [
      "a managed tag that is not true",
      {
        Tags: [
          { Key: "radius-managed", Value: "false" },
          { Key: "radius-repository-id", Value: "7" }
        ]
      }
    ],
    ...["", "0", "-7", "07", "7.0", " 7", "1e3", "abc", "9007199254740992"].map(
      (value) => [
        `the repository ID tag ${JSON.stringify(value)}`,
        {
          Tags: [
            { Key: "radius-managed", Value: "true" },
            { Key: "radius-repository-id", Value: value }
          ]
        }
      ]
    ),
    ["a value that is not a role", "role"]
  ])("names no repository for a role with %s", (_label, role) => {
    expect(radiusRoleRepositoryId(role)).toBeNull();
  });

  it("accepts the largest safe repository ID", () => {
    expect(
      radiusRoleRepositoryId({
        Tags: [
          { Key: "radius-managed", Value: "true" },
          { Key: "radius-repository-id", Value: "9007199254740991" }
        ]
      })
    ).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("namesGitHubProvider", () => {
  it("finds a role that trusts this account's GitHub provider", () => {
    expect(
      namesGitHubProvider(buildGitHubTrustPolicy(ACCOUNT, [DEV]), ACCOUNT)
    ).toBe(true);
  });

  it("finds a Radius role whose last GitHub subject was removed", () => {
    const { policy } = removeGitHubTrustSubject(
      buildGitHubTrustPolicy(ACCOUNT, [DEV]),
      ACCOUNT,
      DEV
    );
    expect(trustedGitHubSubjects(policy, ACCOUNT)).toEqual([]);
    expect(namesGitHubProvider(policy, ACCOUNT)).toBe(true);
  });

  it.each([
    ["another account's provider", "999988887777"],
    ["an unknown account", ""]
  ])("ignores %s", (_label, account) => {
    expect(
      namesGitHubProvider(buildGitHubTrustPolicy(ACCOUNT, [DEV]), account)
    ).toBe(false);
  });

  it("ignores a role only a service can assume", () => {
    expect(
      namesGitHubProvider(
        {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "ec2.amazonaws.com" },
              Action: "sts:AssumeRole"
            }
          ]
        },
        ACCOUNT
      )
    ).toBe(false);
  });
});

describe("EKS authentication mode", () => {
  it.each([
    [{ cluster: { accessConfig: { authenticationMode: "API" } } }, "API"],
    [
      {
        cluster: { accessConfig: { authenticationMode: "API_AND_CONFIG_MAP" } }
      },
      "API_AND_CONFIG_MAP"
    ],
    [{ cluster: { accessConfig: { authenticationMode: "" } } }, "CONFIG_MAP"],
    [{ cluster: { accessConfig: { authenticationMode: 7 } } }, "CONFIG_MAP"],
    [{ cluster: { accessConfig: {} } }, "CONFIG_MAP"],
    [{ cluster: { accessConfig: null } }, "CONFIG_MAP"],
    [{ cluster: {} }, "CONFIG_MAP"],
    [{ cluster: null }, "CONFIG_MAP"],
    [{}, "CONFIG_MAP"],
    [null, "CONFIG_MAP"],
    ["text", "CONFIG_MAP"]
  ])("reads %j as %s", (output, mode) => {
    expect(eksAuthenticationMode(output)).toBe(mode);
  });

  it("accepts access entries in every mode except CONFIG_MAP", () => {
    expect(eksAcceptsAccessEntries("API")).toBe(true);
    expect(eksAcceptsAccessEntries("API_AND_CONFIG_MAP")).toBe(true);
    expect(eksAcceptsAccessEntries("CONFIG_MAP")).toBe(false);
  });
});

describe("deploy identity lock", () => {
  const holder = {
    repo: "octo/shop",
    environment: "dev",
    action: "setup" as const,
    operationId: "op-1"
  };

  it("names the lock after the role, inside IAM's 128-character policy name limit", () => {
    const longest = "r".repeat(64);
    expect(buildAwsLockPolicyName("radius-deploy-octo-shop")).toBe(
      "radius-lock-radius-deploy-octo-shop"
    );
    expect(buildAwsLockPolicyName(longest)).toHaveLength(76);
    expect(awsLockPolicyArn(ACCOUNT, "shop")).toBe(
      `arn:aws:iam::${ACCOUNT}:policy/radius-lock-shop`
    );
  });

  it("writes a document that only denies passing the lock itself", () => {
    expect(buildAwsLockPolicyDocument(ACCOUNT, "shop")).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "RadiusDeployIdentityLock",
          Effect: "Deny",
          Action: "iam:PassRole",
          Resource: `arn:aws:iam::${ACCOUNT}:policy/radius-lock-shop`
        }
      ]
    });
  });

  it("round-trips the holder through the policy description", () => {
    const description = describeAwsLockHolder(holder);
    expect(description).toBe(
      '{"repo":"octo/shop","environment":"dev","action":"setup","operationId":"op-1"}'
    );
    expect(parseAwsLockHolder(description)).toEqual(holder);
  });

  it("escapes characters IAM descriptions refuse and restores them on read", () => {
    const unicode = { ...holder, environment: "prod-é-✓-😀" };
    const description = describeAwsLockHolder(unicode);
    expect(description).toMatch(/^[\x20-\x7e]*$/);
    expect(parseAwsLockHolder(description)).toEqual(unicode);
  });

  it("drops the repository and environment when they would pass the 1,000-character limit", () => {
    const description = describeAwsLockHolder({
      ...holder,
      environment: "é".repeat(255)
    });
    expect(description.length).toBeLessThanOrEqual(1000);
    expect(parseAwsLockHolder(description)).toEqual({
      repo: "",
      environment: "",
      action: "setup",
      operationId: "op-1"
    });
  });

  it.each([
    [undefined],
    [""],
    ["not json"],
    ["[]"],
    ['{"action":"takeover"}'],
    ['{"repo":"octo/shop"}']
  ])("reads %j as no holder", (description) => {
    expect(parseAwsLockHolder(description)).toBeNull();
  });

  it("reads missing text fields as empty", () => {
    expect(parseAwsLockHolder('{"action":"delete","repo":7}')).toEqual({
      repo: "",
      environment: "",
      action: "delete",
      operationId: ""
    });
  });

  it.each([
    [holder, "The setup of environment dev in octo/shop"],
    [
      { ...holder, action: "delete" as const },
      "The delete of environment dev in octo/shop"
    ],
    [{ ...holder, environment: "" }, "The setup of octo/shop"],
    [
      { ...holder, repo: "", environment: "" },
      "The setup of an unnamed environment"
    ],
    [null, "Another run"]
  ])("labels %j as %s", (value, label) => {
    expect(awsLockHolderLabel(value)).toBe(label);
  });

  it("offers removal after ten minutes", () => {
    expect(AWS_LOCK_REMOVABLE_AFTER_MS).toBe(600000);
  });
});

describe("formatAwsLockTime", () => {
  it.each([
    ["2026-10-30T11:58:30Z", "2026-10-30 11:58 UTC"],
    ["2026-10-30T04:58:30-07:00", "2026-10-30 11:58 UTC"],
    ["", "an unknown time"],
    ["not a date", "an unknown time"]
  ])("formats %j as %s", (since, text) => {
    expect(formatAwsLockTime(since)).toBe(text);
  });
});

describe("isEksClusterName", () => {
  it("accepts names EKS allows, up to 100 characters", () => {
    expect(isEksClusterName("shop")).toBe(true);
    expect(isEksClusterName("0-shop_Prod")).toBe(true);
    expect(isEksClusterName("a".repeat(100))).toBe(true);
  });

  it.each([
    ["an empty name", ""],
    ["a leading hyphen", "-shop"],
    ["a space", "shop prod"],
    ["a dot", "shop.prod"],
    ["101 characters", "a".repeat(101)]
  ])("rejects %s", (_label, value) => {
    expect(isEksClusterName(value)).toBe(false);
  });
});

describe("acceptedGitHubSubjects", () => {
  const DEV = "repo:octo/shop:environment:dev";
  const PROD = "repo:octo/shop:environment:prod";
  const statement = (condition: Record<string, unknown>) => ({
    Effect: "Allow",
    Principal: { Federated: githubOidcProviderArn(ACCOUNT) },
    Action: "sts:AssumeRoleWithWebIdentity",
    Condition: condition
  });
  const policy = (...statements: Record<string, unknown>[]) => ({
    Version: "2012-10-17",
    Statement: statements
  });

  it("lists the exact subjects GitHub's AWS tokens can sign in with", () => {
    expect(
      acceptedGitHubSubjects(
        buildGitHubTrustPolicy(ACCOUNT, [DEV, PROD]),
        ACCOUNT
      )
    ).toEqual([DEV, PROD]);
  });

  it.each([
    [
      "another sub constraint excludes it",
      statement({
        StringEquals: { [`token.actions.githubusercontent.com:sub`]: DEV },
        StringLike: {
          [`token.actions.githubusercontent.com:sub`]: "repo:octo/web:*"
        }
      })
    ],
    [
      "a condition Radius cannot read restricts it",
      statement({
        StringEquals: { [`token.actions.githubusercontent.com:sub`]: DEV },
        IpAddress: { "aws:SourceIp": "203.0.113.0/24" }
      })
    ],
    [
      "it needs another audience",
      statement({
        StringEquals: {
          [`token.actions.githubusercontent.com:sub`]: DEV,
          [`token.actions.githubusercontent.com:aud`]: "example"
        }
      })
    ],
    [
      "it is a pattern",
      statement({
        StringLike: {
          [`token.actions.githubusercontent.com:sub`]: "repo:octo/shop:*"
        }
      })
    ],
    [
      "it is denied",
      {
        ...statement({
          StringEquals: { [`token.actions.githubusercontent.com:sub`]: DEV }
        }),
        Effect: "Deny"
      }
    ]
  ])("leaves out a subject when %s", (_label, entry) => {
    expect(acceptedGitHubSubjects(policy(entry), ACCOUNT)).toEqual([]);
  });
});

describe("subjectNamesRepository", () => {
  it.each([
    ["repo:octo/shop:environment:dev", true],
    ["repo:octo@7/shop@42:environment:dev", true],
    ["repository:octo/shop:environment:dev", true],
    ["repository_owner_id:7:environment:dev:repository_id:42", true],
    ["repository_owner:octo:environment:dev", false],
    ["repository_owner_id:7:environment:dev", false],
    ["repo:octo/shop:environment", false],
    ["repo::environment:dev", false],
    ["", false]
  ])("%s names a repository: %s", (subject, names) => {
    expect(subjectNamesRepository(subject)).toBe(names);
  });
});

describe("repositoryLessSubjectMessage", () => {
  it("names the subjects, the claim keys, and the fix", () => {
    expect(
      repositoryLessSubjectMessage(
        ["repository_owner:octo:environment:dev"],
        "octo/shop",
        { useDefault: false, includeClaimKeys: ["repository_owner", "context"] }
      )
    ).toBe(
      "GitHub's OIDC subject for this environment, repository_owner:octo:environment:dev, does not name the repository, because the OIDC subject customization for octo/shop, set on the repository or its organization, includes only the claims repository_owner, context. Other repositories with the same claim values present the same subject, so trusting it would let their workflows sign in to the deploy role. This attempt changed nothing in AWS. Add repo or repository_id to the customization's include_claim_keys, then retry."
    );
  });

  it("lists several subjects and leaves out claim keys GitHub did not report", () => {
    const message = repositoryLessSubjectMessage(
      ["environment:dev", "environment:prod"],
      "octo/shop",
      { useDefault: false }
    );

    expect(message).toContain(
      "this environment, environment:dev, environment:prod, does not name"
    );
    expect(message).toContain(
      "customization for octo/shop, set on the repository or its organization. Other"
    );
    expect(message).not.toContain("includes only");
  });
});

describe("restrictedGitHubSubjects", () => {
  const DEV = "repo:octo/shop:environment:dev";
  const SUB = "token.actions.githubusercontent.com:sub";
  const AUD = "token.actions.githubusercontent.com:aud";
  const statement = (condition: Record<string, unknown>, effect = "Allow") => ({
    Effect: effect,
    Principal: { Federated: githubOidcProviderArn(ACCOUNT) },
    Action: "sts:AssumeRoleWithWebIdentity",
    Condition: condition
  });
  const restricted = (...statements: Record<string, unknown>[]) =>
    restrictedGitHubSubjects(
      { Version: "2012-10-17", Statement: statements },
      ACCOUNT,
      [DEV]
    );

  it.each([
    [
      "a pattern under a source IP condition",
      statement({
        StringLike: { [SUB]: "repo:octo/shop:environment:*" },
        IpAddress: { "aws:SourceIp": "203.0.113.0/24" }
      })
    ],
    [
      "an exact name under a source IP condition",
      statement({
        StringEquals: { [SUB]: DEV },
        IpAddress: { "aws:SourceIp": "203.0.113.0/24" }
      })
    ],
    [
      "a pattern for another audience",
      statement({
        StringLike: { [SUB]: "repo:octo/*", [AUD]: "example" }
      })
    ],
    [
      "a name another sub constraint excludes",
      statement({
        StringEquals: { [SUB]: DEV },
        StringLike: { [SUB]: "repo:octo/web:*" }
      })
    ]
  ])("counts a subject covered by %s", (_label, entry) => {
    expect(restricted(entry)).toEqual([DEV]);
  });

  it.each([
    [
      "a pattern that does not match it, under a condition",
      statement({
        StringLike: { [SUB]: "repo:octo/web:*" },
        IpAddress: { "aws:SourceIp": "203.0.113.0/24" }
      })
    ],
    [
      "a condition with no sub constraint",
      statement({ IpAddress: { "aws:SourceIp": "203.0.113.0/24" } })
    ],
    [
      "a Deny statement",
      statement(
        {
          StringLike: { [SUB]: "repo:octo/shop:*" },
          IpAddress: { "aws:SourceIp": "203.0.113.0/24" }
        },
        "Deny"
      )
    ],
    [
      "only other subjects",
      statement({ StringEquals: { [SUB]: "repo:octo/shop:environment:prod" } })
    ]
  ])("does not count a subject when the policy has %s", (_label, entry) => {
    expect(restricted(entry)).toEqual([]);
  });
});

describe("readRecordedAwsLock", () => {
  const ARN = "arn:aws:iam::123456789012:policy/radius-lock-radius-deploy-shop";

  it("reads the lock and the role it protects", () => {
    expect(
      readRecordedAwsLock({
        awsDeployIdentityLock: { policyArn: ARN, policyId: "LOCK0" }
      })
    ).toEqual({
      policyArn: ARN,
      policyId: "LOCK0",
      roleName: "radius-deploy-shop"
    });
  });

  it.each([
    ["no context", undefined],
    ["a non-object context", "context"],
    ["no lock", {}],
    ["a released lock", { awsDeployIdentityLock: null }],
    ["a non-object", { awsDeployIdentityLock: "LOCK0" }],
    ["no ARN", { awsDeployIdentityLock: { policyId: "LOCK0" } }],
    [
      "a numeric ARN",
      { awsDeployIdentityLock: { policyArn: 1, policyId: "x" } }
    ],
    [
      "an ARN that is not a lock",
      {
        awsDeployIdentityLock: {
          policyArn: "arn:aws:iam::123456789012:policy/radius-deploy-shop",
          policyId: "LOCK0"
        }
      }
    ],
    [
      "a lock ARN with no role",
      {
        awsDeployIdentityLock: {
          policyArn: "arn:aws:iam::123456789012:policy/radius-lock-",
          policyId: "LOCK0"
        }
      }
    ],
    ["no ID", { awsDeployIdentityLock: { policyArn: ARN } }],
    [
      "an empty ID",
      { awsDeployIdentityLock: { policyArn: ARN, policyId: "" } }
    ],
    ["a numeric ID", { awsDeployIdentityLock: { policyArn: ARN, policyId: 7 } }]
  ])("reads nothing from %s", (_label, context) => {
    expect(readRecordedAwsLock(context)).toBeNull();
  });
});
