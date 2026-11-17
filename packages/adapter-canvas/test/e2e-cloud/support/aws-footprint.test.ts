import { describe, expect, it } from "vitest";
import { buildAwsAppRolesPolicyName } from "@radius-project/core";
import {
  awsAppBoundary,
  awsEnvironmentPolicyName
} from "../../../src/aws-deploy-role-name.js";
import {
  ACCOUNT,
  MAIN,
  REPO,
  REPO_ID,
  ROLE,
  ROLE_ARN,
  SECOND
} from "../../support/aws/cleanup-scenario.js";
import {
  addLiveEnvironment,
  createJourneyWorld,
  liveEnvironment,
  removeLiveEnvironment,
  type JourneyWorld
} from "../../support/aws/journey-scenario.js";
import {
  appBoundaryPathPrefix,
  checkAwsFootprint,
  expectedAwsFootprint,
  type AwsFootprintScope
} from "./aws-footprint.js";

const SCOPE: AwsFootprintScope = {
  accountId: ACCOUNT,
  repositoryId: REPO_ID,
  deployRoleName: ROLE,
  clusters: [MAIN, SECOND]
};
const FIRST = liveEnvironment("radtest-aws-run1-main");
const SECOND_ENV = liveEnvironment("radtest-aws-run1-second", SECOND);
const MAIN_LABEL = `${MAIN.name} (${MAIN.region})`;
const SECOND_LABEL = `${SECOND.name} (${SECOND.region})`;
const APP_ROLES = buildAwsAppRolesPolicyName(REPO_ID);
const policyOf = (name: string) => awsEnvironmentPolicyName(REPO_ID, name);
const boundaryOf = (name: string) => awsAppBoundary(ACCOUNT, REPO_ID, name).arn;

function check(world: JourneyWorld, environments = [...world.live.values()]) {
  return checkAwsFootprint(SCOPE, environments, world.ports);
}

describe("expectedAwsFootprint", () => {
  it("expects nothing when no environment is live", () => {
    expect(expectedAwsFootprint(SCOPE, [])).toEqual({
      trustSubjects: new Map(),
      inlinePolicies: new Map(),
      accessEntries: new Map(),
      appBoundaries: new Map()
    });
  });

  it("expects each environment's subject, policy, boundary, and an entry on its own cluster", () => {
    expect(expectedAwsFootprint(SCOPE, [FIRST, SECOND_ENV])).toEqual({
      trustSubjects: new Map([
        [`repo:${REPO}:environment:${FIRST.name}`, `environment ${FIRST.name}`],
        [
          `repo:${REPO}:environment:${SECOND_ENV.name}`,
          `environment ${SECOND_ENV.name}`
        ]
      ]),
      inlinePolicies: new Map([
        [policyOf(FIRST.name), `environment ${FIRST.name}`],
        [policyOf(SECOND_ENV.name), `environment ${SECOND_ENV.name}`],
        [APP_ROLES, "the app roles of every environment"]
      ]),
      accessEntries: new Map([
        [MAIN_LABEL, `environment ${FIRST.name}`],
        [SECOND_LABEL, `environment ${SECOND_ENV.name}`]
      ]),
      appBoundaries: new Map([
        [boundaryOf(FIRST.name), `environment ${FIRST.name}`],
        [boundaryOf(SECOND_ENV.name), `environment ${SECOND_ENV.name}`]
      ])
    });
  });

  it("expects one access entry for two environments on the same cluster", () => {
    const other = liveEnvironment("radtest-aws-run1-other");
    expect(expectedAwsFootprint(SCOPE, [FIRST, other]).accessEntries).toEqual(
      new Map([[MAIN_LABEL, `environments ${FIRST.name} and ${other.name}`]])
    );
  });

  it.each([
    [
      "an environment on another cluster",
      [{ ...FIRST, cluster: "other" }],
      "names cluster other in us-east-2, which is not one of the Cloud E2E clusters"
    ],
    [
      "an environment in the other cluster's region",
      [{ ...FIRST, region: SECOND.region }],
      "which is not one of the Cloud E2E clusters"
    ],
    [
      "an environment listed twice",
      [FIRST, { ...FIRST, name: FIRST.name.toUpperCase() }],
      "is listed twice"
    ],
    [
      "an environment with no trust subject",
      [{ ...FIRST, trustSubjects: [] }],
      "has no trust subject"
    ]
  ])("refuses %s", (_case, environments, message) => {
    expect(() => expectedAwsFootprint(SCOPE, environments)).toThrow(message);
  });
});

describe("checkAwsFootprint", () => {
  it("matches the deploy role setup leaves before any environment", async () => {
    expect(await check(createJourneyWorld())).toEqual([]);
  });

  it("matches after each create and delete, and names what the other count leaves", async () => {
    const world = createJourneyWorld();
    addLiveEnvironment(world, FIRST);
    expect(await check(world)).toEqual([]);
    expect(await check(world, [])).toEqual([
      `Deploy role ${ROLE} trusts repo:${REPO}:environment:${FIRST.name}, which no live environment uses.`,
      `Deploy role ${ROLE} has inline policy ${APP_ROLES}, which no live environment uses.`,
      `Deploy role ${ROLE} has inline policy ${policyOf(FIRST.name)}, which no live environment uses.`,
      `Cluster ${MAIN_LABEL} has an access entry for ${ROLE}, but no live environment uses that cluster.`,
      `App boundary ${boundaryOf(FIRST.name)} is there, but no live environment uses it.`
    ]);

    addLiveEnvironment(world, SECOND_ENV);
    expect(await check(world)).toEqual([]);
    expect(await check(world, [FIRST])).toEqual([
      `Deploy role ${ROLE} trusts repo:${REPO}:environment:${SECOND_ENV.name}, which no live environment uses.`,
      `Deploy role ${ROLE} has inline policy ${policyOf(SECOND_ENV.name)}, which no live environment uses.`,
      `Cluster ${SECOND_LABEL} has an access entry for ${ROLE}, but no live environment uses that cluster.`,
      `App boundary ${boundaryOf(SECOND_ENV.name)} is there, but no live environment uses it.`
    ]);

    removeLiveEnvironment(world, SECOND_ENV.name);
    expect(await check(world)).toEqual([]);
    removeLiveEnvironment(world, FIRST.name);
    expect(await check(world)).toEqual([]);
  });

  it("names each missing item and the environment it is for", async () => {
    expect(await check(createJourneyWorld(), [FIRST])).toEqual([
      `Deploy role ${ROLE} doesn't trust repo:${REPO}:environment:${FIRST.name}, of environment ${FIRST.name}.`,
      `Deploy role ${ROLE} is missing inline policy ${APP_ROLES}, for the app roles of every environment.`,
      `Deploy role ${ROLE} is missing inline policy ${policyOf(FIRST.name)}, for environment ${FIRST.name}.`,
      `Cluster ${MAIN_LABEL} has no access entry for ${ROLE}, which environment ${FIRST.name} uses.`,
      `App boundary ${boundaryOf(FIRST.name)}, for environment ${FIRST.name}, is missing.`
    ]);
  });

  it("catches an access entry on the wrong cluster and an unrelated inline policy", async () => {
    const world = createJourneyWorld();
    addLiveEnvironment(world, FIRST);
    world.aws.clusters.get(`${MAIN.region}:${MAIN.name}`)?.entries.clear();
    world.aws.addAccessEntry(SECOND.region, SECOND.name, ROLE_ARN);
    world.aws.role(ROLE)?.inline.set("hand-made", {});
    expect(await check(world)).toEqual([
      `Deploy role ${ROLE} has inline policy hand-made, which no live environment uses.`,
      `Cluster ${MAIN_LABEL} has no access entry for ${ROLE}, which environment ${FIRST.name} uses.`,
      `Cluster ${SECOND_LABEL} has an access entry for ${ROLE}, but no live environment uses that cluster.`
    ]);
  });

  it("doesn't count another repository's boundary whose ID starts the same way", async () => {
    const world = createJourneyWorld();
    world.aws.addManagedPolicy({
      path: `/radius/apps/${REPO_ID}1/${FIRST.name}/`,
      name: "radius-app-boundary-other",
      document: {}
    });
    world.aws.addManagedPolicy({
      path: "/radius/apps/",
      name: "radius-app-boundary-root",
      document: {}
    });
    expect(appBoundaryPathPrefix(REPO_ID)).toBe(`/radius/apps/${REPO_ID}/`);
    expect(await check(world)).toEqual([]);
  });

  it("fails when a read fails, rather than reporting a match", async () => {
    const world = createJourneyWorld();
    world.aws.refuseOnce("eks describe-access-entry", "AccessDeniedException");
    await expect(check(world)).rejects.toThrow(
      `Could not read the access entry for ${ROLE} on cluster ${MAIN_LABEL}`
    );
    world.aws.roles.clear();
    await expect(check(world)).rejects.toThrow("aws iam get-role");
  });

  it.each([
    ["list-role-policies", "IAM listed no PolicyNames"],
    ["list-policies", "IAM listed no Policies under the app path"]
  ])("fails when %s returns no list", async (command, message) => {
    const world = createJourneyWorld();
    const ports = {
      runAws: async (args: string[]) =>
        args[1] === command ?
          { code: 0, stdout: "{}", stderr: "" }
        : world.ports.runAws(args)
    };
    await expect(checkAwsFootprint(SCOPE, [], ports)).rejects.toThrow(message);
  });
});
