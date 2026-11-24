import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAwsAppBoundaryPolicy,
  buildAwsAppRolesPolicy,
  buildAwsAppRolesPolicyName,
  buildAwsEnvironmentPermissionPolicy
} from "@radius-project/core";
import {
  awsAppBoundary,
  awsEnvironmentPolicyName
} from "../../../src/aws-deploy-role-name.js";
import type { AwsCommandResult } from "../../../src/server/services/aws-cli-session.js";
import type { AwsLiveEnvironment } from "../../e2e-cloud/support/aws-footprint.js";
import type { AwsJourneyPorts } from "../../e2e-cloud/support/aws-journey-support.js";
import {
  ACCOUNT,
  deployRoleTrust,
  MAIN,
  MAIN_VPC,
  REPO,
  REPO_ID,
  ROLE,
  ROLE_ARN,
  SECOND,
  SECOND_VPC
} from "./cleanup-scenario.js";
import { FakeAws, isFakeAwsWrite } from "./fake-aws.js";

// The AWS account as the one-time setup leaves it for the Cloud E2E journey:
// the two clusters, the main cluster's node groups at zero, the isolated
// group's launch template, and the deploy role with its tags, deny-only
// trust, and the committed permissions boundary. Live environments are added
// the way setup adds them, with the product's own policies, so the policy
// simulator answers as the real one would.

export const BOUNDARY_NAME = "ai-extensions-cloud-e2e-deploy-boundary";
export const BOUNDARY_ARN = `arn:aws:iam::${ACCOUNT}:policy/${BOUNDARY_NAME}`;
export const ISOLATED_TEMPLATE = "lt-isolated";
export const ISOLATED_SECURITY_GROUP = "sg-isolated";
export const CLUSTERS = [MAIN, SECOND] as const;

const SETUP_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../build/cloud-e2e/aws"
);

const SETUP_VALUES: Record<string, string> = {
  ACCOUNT,
  MAIN_REGION: MAIN.region,
  SECOND_REGION: SECOND.region,
  MAIN_CLUSTER: MAIN.name,
  SECOND_CLUSTER: SECOND.name,
  DEPLOY_ROLE: ROLE,
  FIXTURE_REPO: REPO,
  FIXTURE_REPO_ID: String(REPO_ID)
};

/** A committed setup file, with its placeholders filled as envsubst does. */
export function renderSetupFile(file: string): unknown {
  const raw = readFileSync(path.join(SETUP_DIRECTORY, file), "utf8");
  return JSON.parse(
    raw.replace(/\$\{([A-Z_]+)\}/g, (_match, name: string) => {
      const value = SETUP_VALUES[name];
      if (value === undefined) throw new Error(`No value for \${${name}}`);
      return value;
    })
  );
}

export interface JourneyWorld {
  readonly aws: FakeAws;
  readonly clock: { now: number };
  // Every AWS call, in order.
  readonly calls: string[][];
  readonly ports: AwsJourneyPorts;
  readonly live: Map<string, AwsLiveEnvironment>;
}

export function createJourneyWorld(): JourneyWorld {
  const clock = { now: Date.parse("2026-11-17T04:23:00Z") };
  const aws = new FakeAws({ accountId: ACCOUNT, now: () => clock.now });
  aws.iamSettleMs = 10_000;
  aws.addCluster(MAIN.name, MAIN.region, "API", MAIN_VPC);
  aws.addCluster(SECOND.name, SECOND.region, "API", SECOND_VPC);
  aws.addNodegroup(MAIN.region, MAIN.name, "default", {
    minSize: 0,
    maxSize: 2,
    desiredSize: 0
  }).labels = { "radius-e2e/pool": "default" };
  const isolated = aws.addNodegroup(MAIN.region, MAIN.name, "isolated", {
    minSize: 0,
    maxSize: 1,
    desiredSize: 0
  });
  isolated.labels = { "radius-e2e/pool": "isolated" };
  isolated.taints = [
    { key: "radius-e2e/isolated", value: "true", effect: "NO_SCHEDULE" }
  ];
  isolated.launchTemplate = { id: ISOLATED_TEMPLATE, version: "1" };
  aws.addLaunchTemplate(MAIN.region, ISOLATED_TEMPLATE, {
    "1": { SecurityGroupIds: [ISOLATED_SECURITY_GROUP] }
  });
  aws.addGitHubProvider();
  aws.addManagedPolicy({
    path: "/",
    name: BOUNDARY_NAME,
    document: renderSetupFile("deploy-role-boundary.json")
  });
  aws.addRole({
    name: ROLE,
    trust: deployRoleTrust([]),
    boundary: BOUNDARY_ARN,
    tags: [
      { Key: "radius-managed", Value: "true" },
      { Key: "radius-repository", Value: REPO },
      { Key: "radius-repository-id", Value: String(REPO_ID) }
    ]
  });
  const calls: string[][] = [];
  return {
    aws,
    clock,
    calls,
    live: new Map(),
    ports: {
      runAws: async (args): Promise<AwsCommandResult> => {
        calls.push([...args]);
        return aws.run(args);
      },
      sleep: async (milliseconds) => {
        clock.now += milliseconds;
      },
      now: () => clock.now
    }
  };
}

/** The AWS writes the world saw, as `service command`. */
export function awsWrites(world: JourneyWorld): string[] {
  return world.calls
    .filter((args) => isFakeAwsWrite(args))
    .map((args) => args.slice(0, 2).join(" "));
}

function rebuildTrust(world: JourneyWorld): void {
  const role = world.aws.role(ROLE);
  if (!role) throw new Error("The deploy role is missing.");
  role.AssumeRolePolicyDocument = deployRoleTrust(
    [...world.live.values()].flatMap((item) => item.trustSubjects)
  );
}

export function liveEnvironment(
  name: string,
  cluster: { region: string; name: string } = MAIN
): AwsLiveEnvironment {
  return {
    name,
    region: cluster.region,
    cluster: cluster.name,
    trustSubjects: [`repo:${REPO}:environment:${name}`]
  };
}

/** What setup leaves for one environment, with the product's policies. */
export function addLiveEnvironment(
  world: JourneyWorld,
  environment: AwsLiveEnvironment
): void {
  world.live.set(environment.name, environment);
  rebuildTrust(world);
  const role = world.aws.role(ROLE);
  role?.inline.set(
    buildAwsAppRolesPolicyName(REPO_ID),
    buildAwsAppRolesPolicy(ACCOUNT, REPO_ID)
  );
  role?.inline.set(
    awsEnvironmentPolicyName(REPO_ID, environment.name),
    buildAwsEnvironmentPermissionPolicy(environment.region)
  );
  const cluster = world.aws.clusters.get(
    `${environment.region}:${environment.cluster}`
  );
  if (!cluster?.entries.has(ROLE_ARN))
    world.aws.addAccessEntry(
      environment.region,
      environment.cluster,
      ROLE_ARN,
      {
        "radius-managed": "true"
      }
    );
  const boundary = awsAppBoundary(ACCOUNT, REPO_ID, environment.name);
  world.aws.addManagedPolicy({
    path: boundary.path,
    name: boundary.name,
    document: buildAwsAppBoundaryPolicy(ACCOUNT, environment.region)
  });
}

/** What delete leaves after one environment goes. */
export function removeLiveEnvironment(world: JourneyWorld, name: string): void {
  const environment = world.live.get(name);
  if (!environment) throw new Error(`No live environment ${name}.`);
  world.live.delete(name);
  rebuildTrust(world);
  const role = world.aws.role(ROLE);
  role?.inline.delete(awsEnvironmentPolicyName(REPO_ID, name));
  if (world.live.size === 0)
    role?.inline.delete(buildAwsAppRolesPolicyName(REPO_ID));
  const sharesCluster = [...world.live.values()].some(
    (item) =>
      item.region === environment.region && item.cluster === environment.cluster
  );
  if (!sharesCluster)
    world.aws.clusters
      .get(`${environment.region}:${environment.cluster}`)
      ?.entries.delete(ROLE_ARN);
  world.aws.policies.delete(awsAppBoundary(ACCOUNT, REPO_ID, name).arn);
}
