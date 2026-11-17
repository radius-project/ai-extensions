import { describe, expect, it } from "vitest";
import {
  ACCOUNT,
  addAwsEnvironment,
  appBoundary,
  APPLICATION,
  appRoleName,
  containerTags,
  createCleanupScenario,
  MAIN,
  NAMESPACE,
  POD_IDENTITY_TRUST,
  REPO_ID,
  tagList,
  type CleanupScenario
} from "../../support/aws/cleanup-scenario.js";
import {
  checkAwsPodIdentity,
  type AwsPodIdentityExpectation
} from "./aws-pod-identity.js";

const ENVIRONMENT = "radtest-aws-aaaa11112222";
const OTHER = "radtest-aws-bbbb33334444";
const EXPECTED: AwsPodIdentityExpectation = {
  accountId: ACCOUNT,
  repositoryId: REPO_ID,
  environment: ENVIRONMENT,
  cluster: MAIN,
  namespace: NAMESPACE,
  containers: ["web"]
};

async function deployed(): Promise<CleanupScenario> {
  const s = createCleanupScenario();
  await addAwsEnvironment(s, ENVIRONMENT, { deployed: true });
  return s;
}

function check(
  s: CleanupScenario,
  state: "deployed" | "deleted",
  expected = EXPECTED
) {
  return checkAwsPodIdentity(s.outside.runAws, expected, state);
}

function addRole(s: CleanupScenario, name: string, path: string) {
  return s.aws.addRole({
    name,
    trust: POD_IDENTITY_TRUST,
    path,
    boundary: appBoundary(ENVIRONMENT).arn,
    tags: tagList(containerTags(ENVIRONMENT))
  });
}

function association(s: CleanupScenario) {
  const [item] = [
    ...s.aws.clusters.get(`${MAIN.region}:${MAIN.name}`)!.podIdentity.values()
  ];
  return item!;
}

describe("checkAwsPodIdentity", () => {
  it("finds each container's app role and association while deployed, and neither once the app is deleted", async () => {
    const s = await deployed();
    // Names that only start like the Recipe's don't count.
    addRole(
      s,
      "radius-app-web-api-1234567890123",
      appBoundary(ENVIRONMENT).path
    );
    addRole(s, "radius-app-web-UPPERCASE0000", appBoundary(ENVIRONMENT).path);
    expect(await check(s, "deployed")).toEqual([]);

    await s.ports.github.deleteApplication(ENVIRONMENT, APPLICATION);
    s.aws.roles.delete("radius-app-web-api-1234567890123");
    s.aws.roles.delete("radius-app-web-uppercase0000");
    expect(await check(s, "deleted")).toEqual([]);
  });

  it("names the app role and association still there after the app is deleted", async () => {
    const s = await deployed();
    const role = s.aws.role(appRoleName(ENVIRONMENT))!;
    // An association for the container whose role is elsewhere is also left.
    const outside = s.aws.addRole({
      name: "elsewhere",
      trust: POD_IDENTITY_TRUST
    });
    const stray = s.aws.addPodIdentityAssociation(MAIN.region, MAIN.name, {
      namespace: NAMESPACE,
      serviceAccount: "radius-app-api",
      roleArn: outside.Arn
    });
    expect(
      await check(s, "deleted", { ...EXPECTED, containers: ["web", "api"] })
    ).toEqual([
      `App role ${role.Arn} is still there.`,
      `Pod Identity association ${association(s).associationId} (${NAMESPACE}/radius-app-web) on cluster ${MAIN.name} is still there.`,
      `Pod Identity association ${stray.associationId} (${NAMESPACE}/radius-app-api) on cluster ${MAIN.name} is still there.`
    ]);
  });

  it.each([
    [
      "only under another repository's path",
      (s: CleanupScenario) => {
        s.aws.roles.delete(appRoleName(ENVIRONMENT));
        addRole(s, appRoleName(ENVIRONMENT), `/radius/apps/42/${ENVIRONMENT}/`);
        return [
          `Container web has no app role named radius-app-web-<uniqueString> under role${appBoundary(ENVIRONMENT).path}.`
        ];
      }
    ],
    [
      "tagged for another environment",
      (s: CleanupScenario) => {
        const role = s.aws.role(appRoleName(ENVIRONMENT))!;
        role.Tags = tagList(containerTags(OTHER));
        return [
          `App role ${role.Arn} is not tagged radapp.io/environment for ${ENVIRONMENT}.`
        ];
      }
    ],
    [
      "on another environment's boundary",
      (s: CleanupScenario) => {
        const role = s.aws.role(appRoleName(ENVIRONMENT))!;
        role.boundary = appBoundary(OTHER).arn;
        return [
          `App role ${role.Arn} has permissions boundary ${appBoundary(OTHER).arn}, not ${appBoundary(ENVIRONMENT).arn}.`
        ];
      }
    ],
    [
      "without a boundary",
      (s: CleanupScenario) => {
        const role = s.aws.role(appRoleName(ENVIRONMENT))!;
        role.boundary = "";
        return [
          `App role ${role.Arn} has permissions boundary (none), not ${appBoundary(ENVIRONMENT).arn}.`
        ];
      }
    ],
    [
      "with an association that uses another role",
      (s: CleanupScenario) => {
        const item = association(s);
        item.roleArn = `arn:aws:iam::${ACCOUNT}:role/radius-app-web-other`;
        return [
          `Pod Identity association ${item.associationId} (${NAMESPACE}/radius-app-web) on cluster ${MAIN.name} uses ${item.roleArn}, not ${s.aws.role(appRoleName(ENVIRONMENT))!.Arn}.`
        ];
      }
    ],
    [
      "without an association",
      (s: CleanupScenario) => {
        s.aws.clusters.get(`${MAIN.region}:${MAIN.name}`)!.podIdentity.clear();
        return [
          `Cluster ${MAIN.name} has no Pod Identity association for ${NAMESPACE}/radius-app-web.`
        ];
      }
    ],
    [
      "with two roles for one container",
      (s: CleanupScenario) => {
        addRole(
          s,
          "radius-app-web-zzzzzzzzzzzzz",
          appBoundary(ENVIRONMENT).path
        );
        return [
          `Container web has 2 app roles named radius-app-web-<uniqueString> under role${appBoundary(ENVIRONMENT).path}.`
        ];
      }
    ]
  ])("reports a container %s", async (_case, change) => {
    const s = await deployed();
    const differences = change(s);
    expect(await check(s, "deployed")).toEqual(differences);
  });

  it("matches a long container name the way the Recipe shortens its role name", async () => {
    const s = createCleanupScenario();
    await addAwsEnvironment(s, ENVIRONMENT);
    const container = "a".repeat(45);
    const role = addRole(
      s,
      `radius-app-${"a".repeat(39)}-0123456789abc`,
      appBoundary(ENVIRONMENT).path
    );
    s.aws.addPodIdentityAssociation(MAIN.region, MAIN.name, {
      namespace: NAMESPACE,
      serviceAccount: `radius-app-${container}`,
      roleArn: role.Arn
    });
    expect(
      await check(s, "deployed", { ...EXPECTED, containers: [container] })
    ).toEqual([]);
  });

  it("throws when it can't read", async () => {
    const s = await deployed();
    s.aws.refuseOnce("iam list-roles", "AccessDenied");
    await expect(check(s, "deployed")).rejects.toThrow(
      /aws iam list-roles: .*AccessDenied/
    );
    s.aws.refuseOnce("iam get-role", "AccessDenied");
    await expect(check(s, "deployed")).rejects.toThrow(
      /aws iam get-role: .*AccessDenied/
    );
    const noRole = async (args: string[]) =>
      args[1] === "get-role" ?
        { code: 0, stdout: "{}", stderr: "" }
      : s.outside.runAws(args);
    await expect(
      checkAwsPodIdentity(noRole, EXPECTED, "deployed")
    ).rejects.toThrow(
      `IAM did not describe app role ${appRoleName(ENVIRONMENT)}.`
    );
  });
});
