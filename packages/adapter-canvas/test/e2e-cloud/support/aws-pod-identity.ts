import { awsAppBoundary } from "../../../src/aws-deploy-role-name.js";
import {
  appAssociationLabel,
  readAppRoles,
  readAssociations,
  readRoleBoundary,
  recipeEnvironment,
  waitFor,
  type AwsCleanupCluster
} from "./aws-cloud-cleanup.js";
import type { AwsJourneyPorts } from "./aws-journey-support.js";
import { AWS_SETTLE_MS, AWS_SETTLE_POLL_MS } from "./aws-timeout-budget.js";

// The journey's check of what the containers Recipe made for an environment
// through Cloud Control. While the app is deployed, each container has an app
// role in the environment's folder of the repository's app path, with the
// environment's app boundary and tag, and a Pod Identity association that
// lets the container's service account use that role. Once the app is
// deleted, none of either is left. It reads with the cleanup sweep's
// selectors, so the journey and the sweep agree on what an app role is.

// The Recipe names a container's role `take('radius-app-<name>', 50)`, a
// dash, and Bicep's uniqueString, which is 13 lowercase letters and digits.
// https://learn.microsoft.com/azure/azure-resource-manager/bicep/bicep-functions-string#uniquestring
const UNIQUE_STRING = /^[a-z0-9]{13}$/;
const ROLE_NAME_MAX = 50;

export interface AwsPodIdentityExpectation {
  readonly accountId: string;
  readonly repositoryId: number;
  readonly environment: string;
  // The environment's cluster.
  readonly cluster: AwsCleanupCluster;
  // The app's namespace.
  readonly namespace: string;
  readonly containers: readonly string[];
}

function serviceAccount(container: string): string {
  return `radius-app-${container}`;
}

async function readAppIdentity(
  ports: Pick<AwsJourneyPorts, "runAws">,
  expected: AwsPodIdentityExpectation
) {
  const boundary = awsAppBoundary(
    expected.accountId,
    expected.repositoryId,
    expected.environment
  );
  const roles = (
    await readAppRoles(ports, {
      accountId: expected.accountId,
      repositoryId: expected.repositoryId,
      prefix: expected.environment
    })
  ).filter((role) => role.path === boundary.path);
  const associations = await readAssociations(ports, expected.cluster);
  return { boundary, roles, associations };
}

async function readLeftovers(
  ports: Pick<AwsJourneyPorts, "runAws">,
  expected: AwsPodIdentityExpectation
): Promise<string[]> {
  const { boundary, roles, associations } = await readAppIdentity(
    ports,
    expected
  );
  const folder = `arn:aws:iam::${expected.accountId}:role${boundary.path}`;
  const accounts = new Set(expected.containers.map(serviceAccount));
  return [
    ...roles.map((role) => `App role ${role.arn} is still there.`),
    ...associations
      .filter(
        (item) =>
          item.roleArn.startsWith(folder) ||
          (item.namespace === expected.namespace &&
            accounts.has(item.serviceAccount))
      )
      .map((item) => `${appAssociationLabel(item)} is still there.`)
  ];
}

/**
 * How the environment's app roles and Pod Identity associations differ from
 * what `state` expects, in words. Empty when they match. A read that fails
 * throws.
 */
export async function checkAwsPodIdentity(
  ports: Pick<AwsJourneyPorts, "runAws" | "sleep" | "now">,
  expected: AwsPodIdentityExpectation,
  state: "deployed" | "deleted"
): Promise<string[]> {
  if (state === "deleted") {
    // IAM and Pod Identity deletes can take a while to show, so what is left
    // gets the settle window to go.
    let left: string[] = [];
    await waitFor(ports, AWS_SETTLE_MS, AWS_SETTLE_POLL_MS, async () => {
      left = await readLeftovers(ports, expected);
      return left.length === 0;
    });
    return left;
  }

  const { cluster, environment, namespace } = expected;
  const { boundary, roles, associations } = await readAppIdentity(
    ports,
    expected
  );
  const differences: string[] = [];
  for (const container of expected.containers) {
    const prefix = `${serviceAccount(container).slice(0, ROLE_NAME_MAX)}-`;
    const matching = roles.filter(
      (role) =>
        role.name.startsWith(prefix) &&
        UNIQUE_STRING.test(role.name.slice(prefix.length))
    );
    const role = matching.length === 1 ? matching[0] : undefined;
    if (!role) {
      differences.push(
        `Container ${container} has ${matching.length === 0 ? "no app role" : `${matching.length} app roles`} named ${prefix}<uniqueString> under role${boundary.path}.`
      );
    } else {
      if (
        recipeEnvironment(role.tags, environment) !== environment.toLowerCase()
      )
        differences.push(
          `App role ${role.arn} is not tagged radapp.io/environment for ${environment}.`
        );
      const actual = await readRoleBoundary(ports, role.name);
      if (actual !== boundary.arn)
        differences.push(
          `App role ${role.arn} has permissions boundary ${actual || "(none)"}, not ${boundary.arn}.`
        );
    }
    const association = associations.find(
      (item) =>
        item.namespace === namespace &&
        item.serviceAccount === serviceAccount(container)
    );
    if (!association) {
      differences.push(
        `Cluster ${cluster.name} has no Pod Identity association for ${namespace}/${serviceAccount(container)}.`
      );
    } else if (role && association.roleArn !== role.arn) {
      differences.push(
        `${appAssociationLabel(association)} uses ${association.roleArn}, not ${role.arn}.`
      );
    }
  }
  return differences;
}
