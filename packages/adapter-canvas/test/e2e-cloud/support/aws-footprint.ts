import {
  awsRoleArn,
  buildAwsAppRolesPolicyName,
  parsePolicyDocument,
  trustedGitHubSubjects
} from "@radius-project/core";
import {
  awsAppBoundary,
  awsEnvironmentPolicyName
} from "../../../src/aws-deploy-role-name.js";
import {
  awsDetail,
  awsError,
  readAws,
  succeeded,
  waitFor,
  type AwsCleanupCluster
} from "./aws-cloud-cleanup.js";
import {
  asRecord,
  clusterLabel,
  text,
  type AwsJourneyPorts
} from "./aws-journey-support.js";
import { AWS_SETTLE_MS, AWS_SETTLE_POLL_MS } from "./aws-timeout-budget.js";

// What the AWS environments of a run leave on the deploy role and the
// clusters, read from IAM and EKS. Preflight, each create and delete stage,
// and the leftover check compare against the same expectation:
//
//   - one trust subject per environment on the deploy role;
//   - one inline policy per environment, plus the repository's app-roles
//     policy while any environment exists, and no other inline policy;
//   - one access entry for the deploy role on each cluster an environment
//     uses, and none on a cluster no environment uses;
//   - one app permissions boundary per environment under the repository's
//     app path, and no other.
//
// App roles and Pod Identity associations are read by aws-pod-identity.ts.

export interface AwsFootprintScope {
  readonly accountId: string;
  readonly repositoryId: number;
  readonly deployRoleName: string;
  readonly clusters: readonly AwsCleanupCluster[];
}

/** An environment the run created and hasn't deleted yet. */
export interface AwsLiveEnvironment {
  readonly name: string;
  readonly region: string;
  readonly cluster: string;
  readonly trustSubjects: readonly string[];
}

/** Each expected item, with what it is for. */
export interface ExpectedAwsFootprint {
  readonly trustSubjects: ReadonlyMap<string, string>;
  readonly inlinePolicies: ReadonlyMap<string, string>;
  readonly accessEntries: ReadonlyMap<string, string>;
  readonly appBoundaries: ReadonlyMap<string, string>;
}

export interface ActualAwsFootprint {
  readonly trustSubjects: readonly string[];
  readonly inlinePolicies: readonly string[];
  // Labels of the clusters that have an access entry for the deploy role.
  readonly accessEntries: readonly string[];
  readonly appBoundaries: readonly string[];
}

/** The path every app boundary of the repository is under. */
export function appBoundaryPathPrefix(repositoryId: number): string {
  return `/radius/apps/${repositoryId}/`;
}

/** What IAM and EKS should hold for these live environments. */
export function expectedAwsFootprint(
  scope: AwsFootprintScope,
  environments: readonly AwsLiveEnvironment[]
): ExpectedAwsFootprint {
  const trustSubjects = new Map<string, string>();
  const inlinePolicies = new Map<string, string>();
  const clusters = new Map<string, string[]>();
  const appBoundaries = new Map<string, string>();
  const names = new Set<string>();
  for (const environment of environments) {
    const key = environment.name.toLowerCase();
    if (names.has(key))
      throw new Error(`Environment ${environment.name} is listed twice.`);
    names.add(key);
    const cluster = scope.clusters.find(
      (item) =>
        item.region === environment.region && item.name === environment.cluster
    );
    if (!cluster)
      throw new Error(
        `Environment ${environment.name} names cluster ${environment.cluster} in ${environment.region}, which is not one of the Cloud E2E clusters.`
      );
    if (environment.trustSubjects.length === 0)
      throw new Error(
        `Environment ${environment.name} has no trust subject, so its access can't be checked.`
      );
    const label = `environment ${environment.name}`;
    for (const subject of environment.trustSubjects)
      trustSubjects.set(subject, label);
    inlinePolicies.set(
      awsEnvironmentPolicyName(scope.repositoryId, environment.name),
      label
    );
    const entry = clusterLabel(cluster);
    clusters.set(entry, [...(clusters.get(entry) ?? []), environment.name]);
    appBoundaries.set(
      awsAppBoundary(scope.accountId, scope.repositoryId, environment.name).arn,
      label
    );
  }
  if (environments.length > 0)
    inlinePolicies.set(
      buildAwsAppRolesPolicyName(scope.repositoryId),
      "the app roles of every environment"
    );
  const accessEntries = new Map(
    [...clusters].map(([entry, users]) => [
      entry,
      users.length === 1 ?
        `environment ${users[0]}`
      : `environments ${users.join(" and ")}`
    ])
  );
  return { trustSubjects, inlinePolicies, accessEntries, appBoundaries };
}

/** Differences between what is expected and what is there, empty on a match. */
export function compareAwsFootprint(
  scope: AwsFootprintScope,
  expected: ExpectedAwsFootprint,
  actual: ActualAwsFootprint
): string[] {
  const role = `Deploy role ${scope.deployRoleName}`;
  const differences: string[] = [];
  const compare = (
    want: ReadonlyMap<string, string>,
    have: readonly string[],
    missing: (item: string, owner: string) => string,
    extra: (item: string) => string
  ) => {
    const present = new Set(have);
    for (const [item, owner] of [...want].sort(([a], [b]) =>
      a.localeCompare(b)
    ))
      if (!present.has(item)) differences.push(missing(item, owner));
    for (const item of [...present].sort())
      if (!want.has(item)) differences.push(extra(item));
  };
  compare(
    expected.trustSubjects,
    actual.trustSubjects,
    (subject, owner) => `${role} doesn't trust ${subject}, of ${owner}.`,
    (subject) => `${role} trusts ${subject}, which no live environment uses.`
  );
  compare(
    expected.inlinePolicies,
    actual.inlinePolicies,
    (name, owner) => `${role} is missing inline policy ${name}, for ${owner}.`,
    (name) =>
      `${role} has inline policy ${name}, which no live environment uses.`
  );
  compare(
    expected.accessEntries,
    actual.accessEntries,
    (cluster, owner) =>
      `Cluster ${cluster} has no access entry for ${scope.deployRoleName}, which ${owner} uses.`,
    (cluster) =>
      `Cluster ${cluster} has an access entry for ${scope.deployRoleName}, but no live environment uses that cluster.`
  );
  compare(
    expected.appBoundaries,
    actual.appBoundaries,
    (arn, owner) => `App boundary ${arn}, for ${owner}, is missing.`,
    (arn) => `App boundary ${arn} is there, but no live environment uses it.`
  );
  return differences;
}

/** The deploy role's trust, inline policies, access entries, and boundaries. */
export async function readAwsFootprint(
  scope: AwsFootprintScope,
  ports: Pick<AwsJourneyPorts, "runAws">
): Promise<ActualAwsFootprint> {
  const roleName = scope.deployRoleName;
  const role = asRecord(
    asRecord(await readAws(ports, ["iam", "get-role", "--role-name", roleName]))
      ?.Role
  );
  const trustSubjects = trustedGitHubSubjects(
    parsePolicyDocument(role?.AssumeRolePolicyDocument),
    scope.accountId
  );
  const policyNames = asRecord(
    await readAws(ports, ["iam", "list-role-policies", "--role-name", roleName])
  )?.PolicyNames;
  if (!Array.isArray(policyNames))
    throw new Error(`IAM listed no PolicyNames for ${roleName}.`);
  const accessEntries: string[] = [];
  for (const cluster of scope.clusters) {
    const result = await ports.runAws([
      "eks",
      "describe-access-entry",
      "--region",
      cluster.region,
      "--cluster-name",
      cluster.name,
      "--principal-arn",
      awsRoleArn(scope.accountId, roleName),
      "--output",
      "json"
    ]);
    if (succeeded(result)) accessEntries.push(clusterLabel(cluster));
    else if (!awsError(result, "ResourceNotFoundException"))
      throw new Error(
        `Could not read the access entry for ${roleName} on cluster ${clusterLabel(cluster)}: ${awsDetail(result)}`
      );
  }
  const policies = asRecord(
    await readAws(ports, [
      "iam",
      "list-policies",
      "--scope",
      "Local",
      "--path-prefix",
      appBoundaryPathPrefix(scope.repositoryId)
    ])
  )?.Policies;
  if (!Array.isArray(policies))
    throw new Error("IAM listed no Policies under the app path.");
  return {
    trustSubjects,
    inlinePolicies: policyNames.map(text),
    accessEntries,
    appBoundaries: policies.map((item) => text(asRecord(item)?.Arn))
  };
}

/**
 * How the deploy role and clusters differ from what these live environments
 * need, as sentences. Empty when they match. IAM and EKS are eventually
 * consistent, so differences get the settle window to clear, and the last
 * read's are returned. Throws when a read fails.
 */
export async function checkAwsFootprint(
  scope: AwsFootprintScope,
  environments: readonly AwsLiveEnvironment[],
  ports: Pick<AwsJourneyPorts, "runAws" | "sleep" | "now">
): Promise<string[]> {
  const expected = expectedAwsFootprint(scope, environments);
  let differences: string[] = [];
  await waitFor(ports, AWS_SETTLE_MS, AWS_SETTLE_POLL_MS, async () => {
    differences = compareAwsFootprint(
      scope,
      expected,
      await readAwsFootprint(scope, ports)
    );
    return differences.length === 0;
  });
  return differences;
}
