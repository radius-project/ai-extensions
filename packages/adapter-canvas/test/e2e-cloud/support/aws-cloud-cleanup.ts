import {
  AWS_LOCK_REMOVABLE_AFTER_MS,
  AWS_REGION_PATTERN,
  awsLockPolicyArn,
  parseAwsLockHolder,
  parseAwsRoleArn,
  parsePolicyDocument,
  radiusRoleRepositoryId,
  stateRegistryForEnvironment,
  trustedGitHubSubjects
} from "@radius-project/core";
import { defaultAwsDeployRoleName } from "../../../src/aws-deploy-role-name.js";
import type { AwsCommandResult } from "../../../src/server/services/aws-cli-session.js";
import {
  removeAwsDeployIdentityLock,
  type AwsLockWait
} from "../../../src/server/services/aws-deploy-identity-lock.js";
import type { AwsEnvironmentRemovalResult } from "../../../src/server/services/aws-environment-access.js";
import { parseTrustSubjects } from "../../../src/server/services/environment-target.js";
import {
  selectExpiredEnvironments,
  selectLeakedClusterWorkloads,
  selectPrefixedEnvironments,
  selectStaleStatePackages,
  type LeakedClusterWorkload
} from "./cloud-cleanup.js";

// The AWS half of the scheduled Cloud E2E cleanup. For each stale AWS test
// environment it follows the order the AWS Cloud E2E design sets:
//
//   1. Ask the product to delete the application, and wait.
//   2. Sweep the MySQL recipe's RDS resources, the containers Recipe's app
//      roles and Pod Identity associations, and the Radius workloads that
//      are left.
//   3. Check nothing of that environment is left.
//   4. Only then remove its deployment records and GHCR state, and, under the
//      deploy role's lock, its trust subject, inline policy, app boundary, and
//      access entry (with the product's own removal code) and its GitHub
//      environment.
//
// If step 2 or 3 fails, everything step 4 removes stays, so the next run can
// retry, and the sweep fails. A failed step 1 fails the sweep too, but, as in
// the Azure sweep, when the delete's run finished without succeeding the
// environment still goes on to step 4 if steps 2 and 3 pass and fresh reads
// of AWS and the clusters list nothing of it. A run that may still be going
// keeps everything. A delete
// that fails the same way every day would otherwise keep the environment's
// access forever. The GitHub environment goes last: it is what makes a later
// sweep find the environment again.
//
// Every delete is limited to what the suite creates: in one of the two test
// regions, named the way the MySQL recipe names it, tagged with an AWS test
// environment, and in one of the two clusters' VPCs. App roles and
// associations are deleted only when their role's IAM path is a test
// environment's folder under the fixture repository's app path and their tag
// names the same environment. The deploy and test roles, the identity
// provider, clusters, node groups, and VPCs are never deleted. A read that
// fails stops that sweep without deleting.

export const AWS_MAIN_NODE_GROUPS = ["default", "isolated"] as const;
// Radius's own tests and their cleanup job use this region. Neither role may
// act in it, and this sweep refuses to be pointed at it.
export const RADIUS_TEST_REGION = "us-west-2";

const RECIPE_RESOURCE_PREFIX = "mysql-";
const FINAL_SNAPSHOT_PREFIX = "rds-snapshot-";
const ENVIRONMENT_TAG = "radapp.io/environment";
// The tag Radius's own cleanup job matches. A resource carrying it is
// Radius's, whatever else it looks like.
const RADIUS_CREATION_TAG = "RadiusCreationTimestamp";
const ENVIRONMENT_ID_PATTERN = /\/providers\/[^/]+\/environments\/([^/]+)$/i;
const CLUSTER_NAME_PATTERN = /^[0-9A-Za-z][A-Za-z0-9_-]{0,99}$/;
const RDS_ARN_PATTERN = /^arn:aws:rds:([a-z0-9-]+):\d{12}:[a-z]+:/;

// How long the sweep waits on AWS and Kubernetes to finish what it started.
export const RDS_DELETE_TIMEOUT_MS = 40 * 60 * 1000;
export const SNAPSHOT_READY_TIMEOUT_MS = 20 * 60 * 1000;
export const SNAPSHOT_DELETE_TIMEOUT_MS = 20 * 60 * 1000;
// RDS deletes a group at once, but a read just after can still list it.
export const GROUP_GONE_TIMEOUT_MS = 5 * 60 * 1000;
export const NODE_GROUP_READY_TIMEOUT_MS = 15 * 60 * 1000;
export const WORKLOAD_GONE_TIMEOUT_MS = 5 * 60 * 1000;
const RDS_POLL_MS = 30 * 1000;
const NODE_GROUP_POLL_MS = 15 * 1000;
const WORKLOAD_POLL_MS = 10 * 1000;
const GROUP_POLL_MS = 10 * 1000;
// IAM and EKS are eventually consistent: a read just after a delete can still
// find what was deleted.
export const LOCK_GONE_TIMEOUT_MS = 60 * 1000;
export const LEFTOVER_SETTLE_MS = 2 * 60 * 1000;
const LOCK_POLL_MS = 5 * 1000;
const LEFTOVER_POLL_MS = 15 * 1000;

export interface AwsCleanupCluster {
  readonly region: string;
  readonly name: string;
}

export interface AwsCleanupConfig {
  readonly repository: string;
  readonly application: string;
  readonly namespace: string;
  readonly environmentPrefix: string;
  readonly accountId: string;
  // The main cluster first: it has the node groups.
  readonly clusters: readonly [AwsCleanupCluster, AwsCleanupCluster];
  readonly deployRoleName: string;
  readonly cutoff: string;
  // Names this run on the deploy role's lock.
  readonly operationId: string;
}

export interface AwsCleanupGitHub {
  // GitHub's ID for the fixture repository. Its app roles and their
  // boundaries are under `/radius/apps/<id>/`. Throws when it can't be read.
  readRepositoryId(): Promise<number>;
  // `gh api --paginate --slurp repos/<repo>/environments` pages.
  listEnvironments(): Promise<unknown>;
  readEnvironmentVariables(
    environment: string
  ): Promise<Record<string, string>>;
  // Dispatch delete-application.yml and wait for it to succeed, with no
  // other run for the environment unfinished. Throws ApplicationDeleteFailed
  // when its run finished without succeeding and no other run is going, and
  // any other error when a run may still be going: it can't be dispatched,
  // found, or read, doesn't finish in time, or another run is unfinished.
  deleteApplication(environment: string, application: string): Promise<void>;
  listDeployments(): Promise<unknown>;
  // Deactivate, delete, and confirm the record is gone.
  deleteDeployment(id: number): Promise<void>;
  listPackages(): Promise<unknown>;
  // Delete a private state package linked to the fixture, and confirm it is
  // gone. "absent" when there was none.
  deletePackage(name: string): Promise<"deleted" | "absent">;
  // Delete the GitHub environment and confirm it is gone.
  deleteEnvironment(environment: string): Promise<void>;
}

export interface AwsCleanupKubernetes {
  // `kubectl get <workload kinds> -A -l radapp.io/environment -o json`.
  listWorkloads(cluster: AwsCleanupCluster): Promise<unknown>;
  deleteWorkload(
    cluster: AwsCleanupCluster,
    workload: LeakedClusterWorkload
  ): Promise<void>;
  namespaceExists(
    cluster: AwsCleanupCluster,
    namespace: string
  ): Promise<boolean>;
  deleteNamespace(cluster: AwsCleanupCluster, namespace: string): Promise<void>;
}

export interface AwsAccessRemovalRequest {
  readonly environment: string;
  readonly roleArn: string;
  readonly region: string;
  readonly cluster: string;
  readonly trustSubjects: readonly string[];
  readonly operationId: string;
  waiting(wait: AwsLockWait, line: string | null): Promise<void>;
  // Runs under the lock, after the removal succeeded.
  whileLocked(
    removal: Extract<AwsEnvironmentRemovalResult, { ok: true }>
  ): Promise<void>;
}

export interface AwsCleanupPorts {
  runAws(args: string[]): Promise<AwsCommandResult>;
  readonly github: AwsCleanupGitHub;
  readonly kubernetes: AwsCleanupKubernetes;
  // The product's `createAwsEnvironmentAccess().remove()` for the fixture.
  removeAccess(
    request: AwsAccessRemovalRequest
  ): Promise<AwsEnvironmentRemovalResult>;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
  log(line: string): void;
}

export interface AwsCleanupReport {
  readonly failures: string[];
  readonly warnings: string[];
  readonly done: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function succeeded(result: AwsCommandResult): boolean {
  return result.code === 0 || result.code === "0";
}

export function awsDetail(result: AwsCommandResult): string {
  return (result.stderr || result.stdout).trim() || `exit ${result.code}`;
}

export function awsError(result: AwsCommandResult, code: string): boolean {
  return result.stderr.includes(`(${code})`);
}

class ReadFailure extends Error {}

/**
 * The delete-application.yml run finished without succeeding. Only then is
 * nothing still deleting the app, so only then can the sweep go on to step 4
 * without a successful delete.
 */
export class ApplicationDeleteFailed extends Error {}

// --- Configuration --------------------------------------------------------

/**
 * The sweep's scope from the workflow's environment, or null when the AWS
 * variables are not set, so the job skips with a notice. Set only in part,
 * or set to something unexpected, is an error: deleting against a scope
 * nobody intended is what this guards.
 */
export function resolveAwsCleanupConfig(
  env: Readonly<Record<string, string | undefined>>,
  now: number
): AwsCleanupConfig | null {
  const value = (name: string) => (env[name] ?? "").trim();
  const aws = [
    "AWS_TEST_ROLE_ARN",
    "AWS_MAIN_REGION",
    "AWS_MAIN_CLUSTER",
    "AWS_SECOND_REGION",
    "AWS_SECOND_CLUSTER"
  ];
  const set = aws.filter((name) => value(name) !== "");
  if (set.length === 0) return null;
  if (set.length !== aws.length) {
    throw new Error(
      `The AWS Cloud E2E variables must be set together. Missing: ${aws
        .filter((name) => !set.includes(name))
        .join(", ")}.`
    );
  }
  const role = parseAwsRoleArn(value("AWS_TEST_ROLE_ARN"));
  if (!role || role.partition !== "aws") {
    throw new Error(
      `AWS_TEST_ROLE_ARN must be an IAM role ARN in the aws partition; got "${value("AWS_TEST_ROLE_ARN")}".`
    );
  }
  const clusters = (["MAIN", "SECOND"] as const).map((which) => {
    const region = value(`AWS_${which}_REGION`);
    const name = value(`AWS_${which}_CLUSTER`);
    if (!AWS_REGION_PATTERN.test(region) || region === RADIUS_TEST_REGION) {
      throw new Error(
        `AWS_${which}_REGION must be an AWS region other than ${RADIUS_TEST_REGION}, which Radius's own tests use; got "${region}".`
      );
    }
    if (!CLUSTER_NAME_PATTERN.test(name)) {
      throw new Error(
        `AWS_${which}_CLUSTER is not a valid EKS cluster name: "${name}".`
      );
    }
    return { region, name };
  }) as [AwsCleanupCluster, AwsCleanupCluster];
  if (
    clusters[0].region === clusters[1].region &&
    clusters[0].name === clusters[1].name
  ) {
    throw new Error("The two AWS Cloud E2E clusters must be different.");
  }
  const repository = value("FIXTURE_REPOSITORY");
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error(
      `FIXTURE_REPOSITORY must be owner/name; got "${repository}".`
    );
  }
  const prefix = value("AWS_ENVIRONMENT_PREFIX");
  if (!prefix.endsWith("aws-")) {
    throw new Error(
      `AWS_ENVIRONMENT_PREFIX must be the AWS environment prefix; got "${prefix}".`
    );
  }
  const hours = value("MAX_AGE_HOURS");
  if (!/^\d+$/.test(hours) || Number(hours) > 720) {
    throw new Error(
      `MAX_AGE_HOURS must be a whole number from 0 to 720; got "${hours}".`
    );
  }
  const application = value("FIXTURE_APPLICATION");
  const namespace = value("RADIUS_ENVIRONMENT_NAMESPACE");
  if (!application || !namespace) {
    throw new Error(
      "FIXTURE_APPLICATION and RADIUS_ENVIRONMENT_NAMESPACE are required."
    );
  }
  const runId = value("GITHUB_RUN_ID") || "local";
  return {
    repository,
    application,
    namespace,
    environmentPrefix: prefix,
    accountId: role.accountId,
    clusters,
    deployRoleName: defaultAwsDeployRoleName(repository),
    cutoff: new Date(now - Number(hours) * 3600 * 1000).toISOString(),
    operationId: `cloud-e2e-cleanup-${runId}`
  };
}

// --- Selectors ------------------------------------------------------------

/**
 * The environment a `radapp.io/environment` tag names, when it is an AWS
 * test environment. The MySQL recipe tags each resource with the Radius
 * environment's resource ID, whose last segment is the GitHub environment's
 * name.
 */
export function awsEnvironmentFromTag(
  value: unknown,
  prefix: string
): string | null {
  const match = ENVIRONMENT_ID_PATTERN.exec(text(value));
  const name = match?.[1]?.toLowerCase() ?? "";
  return name.startsWith(prefix.toLowerCase()) ? name : null;
}

function readTags(value: unknown): Map<string, string> {
  const tags = new Map<string, string>();
  if (!Array.isArray(value)) return tags;
  for (const entry of value) {
    const tag = asRecord(entry);
    if (typeof tag?.Key === "string") tags.set(tag.Key, text(tag.Value));
  }
  return tags;
}

/**
 * The AWS test environment a resource's tags name, or null when the tags
 * don't name one, or carry Radius's own cleanup tag.
 */
export function recipeEnvironment(
  tagList: unknown,
  prefix: string
): string | null {
  const tags = readTags(tagList);
  if (tags.has(RADIUS_CREATION_TAG)) return null;
  return awsEnvironmentFromTag(tags.get(ENVIRONMENT_TAG), prefix);
}

function arnRegion(arn: unknown): string {
  return RDS_ARN_PATTERN.exec(text(arn))?.[1] ?? "";
}

export interface AwsRdsScope {
  readonly region: string;
  readonly vpcIds: ReadonlySet<string>;
  readonly prefix: string;
}

export interface RecipeDbInstance {
  readonly id: string;
  readonly status: string;
  readonly environment: string;
}

function requireList(payload: unknown, field: string, context: string) {
  const list = asRecord(payload)?.[field];
  if (!Array.isArray(list))
    throw new Error(`${context} did not include a ${field} array.`);
  return list;
}

/** DB instances the MySQL recipe made for an AWS test environment. */
export function selectRecipeDbInstances(
  payload: unknown,
  scope: AwsRdsScope
): RecipeDbInstance[] {
  const selected: RecipeDbInstance[] = [];
  for (const entry of requireList(
    payload,
    "DBInstances",
    "aws rds describe-db-instances"
  )) {
    const item = asRecord(entry);
    const id = text(item?.DBInstanceIdentifier);
    if (!id.startsWith(RECIPE_RESOURCE_PREFIX)) continue;
    if (arnRegion(item?.DBInstanceArn) !== scope.region) continue;
    if (!scope.vpcIds.has(text(asRecord(item?.DBSubnetGroup)?.VpcId))) continue;
    const environment = recipeEnvironment(item?.TagList, scope.prefix);
    if (!environment) continue;
    selected.push({
      id,
      status: text(item?.DBInstanceStatus),
      environment
    });
  }
  return selected;
}

export interface RecipeGroupCandidate {
  readonly name: string;
  readonly arn: string;
}

/**
 * DB subnet groups named the way the recipe names them, in a cluster's VPC.
 * Their tags are read separately: DescribeDBSubnetGroups doesn't return them.
 */
export function selectRecipeSubnetGroupCandidates(
  payload: unknown,
  scope: AwsRdsScope
): RecipeGroupCandidate[] {
  return requireList(
    payload,
    "DBSubnetGroups",
    "aws rds describe-db-subnet-groups"
  )
    .map(asRecord)
    .filter(
      (item) =>
        text(item?.DBSubnetGroupName).startsWith(RECIPE_RESOURCE_PREFIX) &&
        arnRegion(item?.DBSubnetGroupArn) === scope.region &&
        scope.vpcIds.has(text(item?.VpcId))
    )
    .map((item) => ({
      name: text(item?.DBSubnetGroupName),
      arn: text(item?.DBSubnetGroupArn)
    }));
}

/**
 * DB parameter groups named the way the recipe names them. A parameter group
 * belongs to a region, not a VPC, so only its region, name, and tags place it.
 */
export function selectRecipeParameterGroupCandidates(
  payload: unknown,
  scope: AwsRdsScope
): RecipeGroupCandidate[] {
  return requireList(
    payload,
    "DBParameterGroups",
    "aws rds describe-db-parameter-groups"
  )
    .map(asRecord)
    .filter(
      (item) =>
        text(item?.DBParameterGroupName).startsWith(RECIPE_RESOURCE_PREFIX) &&
        arnRegion(item?.DBParameterGroupArn) === scope.region
    )
    .map((item) => ({
      name: text(item?.DBParameterGroupName),
      arn: text(item?.DBParameterGroupArn)
    }));
}

export interface RecipeSnapshot {
  readonly id: string;
  readonly status: string;
  readonly environment: string;
}

/**
 * Final snapshots Cloud Control took when it deleted a recipe's instance, in
 * a cluster's VPC. Tagged ones are the suite's. One with no environment tag
 * can't be tied to the suite, so it is only reported.
 */
export function selectFinalSnapshots(
  payload: unknown,
  scope: AwsRdsScope
): { tagged: RecipeSnapshot[]; untagged: string[] } {
  const tagged: RecipeSnapshot[] = [];
  const untagged: string[] = [];
  for (const entry of requireList(
    payload,
    "DBSnapshots",
    "aws rds describe-db-snapshots"
  )) {
    const item = asRecord(entry);
    const id = text(item?.DBSnapshotIdentifier);
    if (!id.startsWith(FINAL_SNAPSHOT_PREFIX)) continue;
    if (text(item?.SnapshotType) !== "manual") continue;
    if (arnRegion(item?.DBSnapshotArn) !== scope.region) continue;
    if (!scope.vpcIds.has(text(item?.VpcId))) continue;
    const tags = readTags(item?.TagList);
    if (!tags.has(ENVIRONMENT_TAG) && !tags.has(RADIUS_CREATION_TAG)) {
      untagged.push(id);
      continue;
    }
    const environment = recipeEnvironment(item?.TagList, scope.prefix);
    if (environment)
      tagged.push({ id, status: text(item?.Status), environment });
  }
  return { tagged, untagged };
}

export interface AwsDeploymentRecord {
  readonly id: number;
  readonly environment: string;
  readonly createdAt: string;
}

/** GitHub deployment records of AWS test environments. */
export function selectAwsDeployments(
  payload: unknown,
  prefix: string
): AwsDeploymentRecord[] {
  if (!Array.isArray(payload))
    throw new Error("GitHub deployments did not return a JSON array.");
  return payload
    .flatMap((page) => (Array.isArray(page) ? page : [page]))
    .map(asRecord)
    .filter(
      (item) =>
        text(item?.environment)
          .toLowerCase()
          .startsWith(prefix.toLowerCase()) &&
        typeof item?.id === "number" &&
        Number.isInteger(item.id)
    )
    .map((item) => ({
      id: Number(item?.id),
      environment: text(item?.environment).toLowerCase(),
      createdAt: text(item?.created_at)
    }));
}

/** The GHCR package that holds an environment's Radius state. */
export function statePackageName(
  repository: string,
  environment: string
): string {
  return stateRegistryForEnvironment(repository, environment)
    .split("/")
    .at(-1) as string;
}

/** The prefix every AWS environment's state package name starts with. */
export function awsStatePackagePrefix(config: AwsCleanupConfig): string {
  const repository = config.repository.split("/")[1] ?? "";
  return `${repository.toLowerCase()}-radius-state-${config.environmentPrefix}`;
}

// --- App roles, boundaries, and Pod Identity -------------------------------

// The product's setup writes each AWS environment a permissions boundary for
// its app roles, under the fixture repository's app path. Step 4's removal
// deletes it, but keeps one it can't read or that an app role still uses, and
// the environment goes anyway. The leftover check finds what it kept.
//
// For each container, the containers Recipe creates through Cloud Control an
// IAM role under the environment's folder of the repository's app path, with
// the environment's app boundary, and a Pod Identity association on the
// environment's cluster that lets the container's service account use it.
// Both carry the Recipe's `radapp.io/*` tags.

export interface AwsAppScope {
  readonly accountId: string;
  readonly repositoryId: number;
  readonly prefix: string;
}

export interface AwsTag {
  readonly Key: string;
  readonly Value: string;
}

// The app scope of the fixture repository, or null with a message when its
// ID can't be read.
async function readAppScope(
  config: AwsCleanupConfig,
  ports: AwsCleanupPorts
): Promise<{ scope: AwsAppScope } | { scope: null; message: string }> {
  try {
    return {
      scope: {
        accountId: config.accountId,
        repositoryId: await ports.github.readRepositoryId(),
        prefix: config.environmentPrefix
      }
    };
  } catch (error) {
    return { scope: null, message: errorMessage(error) };
  }
}

/** The IAM path the repository's app roles and boundaries are under. */
export function appPathRoot(repositoryId: number): string {
  return `/radius/apps/${repositoryId}/`;
}

/**
 * The AWS test environment whose folder an IAM path is, the way the product
 * names it: `/radius/apps/<repositoryId>/<environment>/`. Null for any other
 * path.
 */
export function appPathEnvironment(
  path: string,
  scope: AwsAppScope
): string | null {
  const root = appPathRoot(scope.repositoryId);
  if (!path.startsWith(root)) return null;
  const folder = /^([^/]+)\/$/.exec(path.slice(root.length))?.[1] ?? "";
  return folder.startsWith(scope.prefix.toLowerCase()) ? folder : null;
}

const ROLE_ARN_PATTERN = /^arn:aws:iam::\d{12}:role\/(?:[^/]+\/)*[^/]+$/;

// The IAM path of a role in the scope's account, or "" for any other ARN.
function rolePath(roleArn: string, scope: AwsAppScope): string {
  const prefix = `arn:aws:iam::${scope.accountId}:role`;
  return ROLE_ARN_PATTERN.test(roleArn) && roleArn.startsWith(`${prefix}/`) ?
      roleArn.slice(prefix.length, roleArn.lastIndexOf("/") + 1)
    : "";
}

/** Whether a role is under the repository's app path, in the scope's account. */
export function underAppPath(roleArn: string, scope: AwsAppScope): boolean {
  return rolePath(roleArn, scope).startsWith(appPathRoot(scope.repositoryId));
}

/** Whether tags carry Radius's own cleanup tag, which makes a resource Radius's. */
export function radiusTagged(tagList: unknown): boolean {
  return readTags(tagList).has(RADIUS_CREATION_TAG);
}

/**
 * The AWS test environment an app role or association belongs to: its role's
 * path is the environment's folder under the repository's app path, and its
 * tag names the same environment. Null for anything else, or for anything
 * with Radius's own cleanup tag.
 */
export function appIdentityEnvironment(
  roleArn: string,
  tagList: unknown,
  scope: AwsAppScope
): string | null {
  const folder = appPathEnvironment(rolePath(roleArn, scope), scope);
  return (
      folder !== null && recipeEnvironment(tagList, scope.prefix) === folder
    ) ?
      folder
    : null;
}

// The environment folder an app role or association is in, whatever its
// tags say, unless it is Radius's own. What the step 3 check keys on, so an
// environment keeps its access while anything is under its folder.
function appFolderEnvironment(
  roleArn: string,
  tagList: unknown,
  scope: AwsAppScope
): string | null {
  if (radiusTagged(tagList)) return null;
  return appPathEnvironment(rolePath(roleArn, scope), scope);
}

export interface AppRoleCandidate {
  readonly name: string;
  readonly arn: string;
  readonly path: string;
}

/**
 * Roles under the repository's app path, from `aws iam list-roles
 * --path-prefix`. ListRoles leaves out tags, so they are read separately.
 */
export function selectAppRoleCandidates(
  payload: unknown,
  scope: AwsAppScope
): AppRoleCandidate[] {
  const root = appPathRoot(scope.repositoryId);
  return requireList(payload, "Roles", "aws iam list-roles")
    .map(asRecord)
    .flatMap((item) => {
      const name = text(item?.RoleName);
      const path = text(item?.Path);
      const arn = text(item?.Arn);
      return (
          name &&
            path.startsWith(root) &&
            arn === `arn:aws:iam::${scope.accountId}:role${path}${name}`
        ) ?
          [{ name, arn, path }]
        : [];
    });
}

export interface AppAssociationCandidate {
  readonly id: string;
  readonly namespace: string;
  readonly serviceAccount: string;
}

/**
 * The associations `aws eks list-pod-identity-associations` lists. The list
 * leaves out each one's role and tags, so they are described separately.
 */
export function selectAssociationCandidates(
  payload: unknown
): AppAssociationCandidate[] {
  return requireList(
    payload,
    "associations",
    "aws eks list-pod-identity-associations"
  ).map((entry) => {
    const item = asRecord(entry);
    const id = text(item?.associationId);
    if (!id)
      throw new ReadFailure(
        "aws eks list-pod-identity-associations listed an association without an ID."
      );
    return {
      id,
      namespace: text(item?.namespace),
      serviceAccount: text(item?.serviceAccount)
    };
  });
}

/**
 * The role and tags `aws eks describe-pod-identity-association` reports. EKS
 * returns tags as a map; they are returned in IAM's list form.
 */
export function describedAssociation(
  payload: unknown,
  id: string
): { roleArn: string; tags: AwsTag[] } {
  const association = asRecord(asRecord(payload)?.association);
  const roleArn = association?.roleArn;
  if (typeof roleArn !== "string")
    throw new ReadFailure(
      `EKS did not describe the role of Pod Identity association ${id}.`
    );
  return {
    roleArn,
    tags: Object.entries(asRecord(association?.tags) ?? {}).map(
      ([Key, Value]) => ({ Key, Value: text(Value) })
    )
  };
}

export interface AppBoundary {
  readonly arn: string;
  readonly name: string;
  readonly path: string;
  readonly createdAt: string;
}

/**
 * Managed policies under the repository's app path, from `aws iam
 * list-policies --scope Local --path-prefix`. ListPolicies leaves out tags.
 */
export function selectAppBoundaries(
  payload: unknown,
  scope: AwsAppScope
): AppBoundary[] {
  const root = appPathRoot(scope.repositoryId);
  return requireList(payload, "Policies", "aws iam list-policies")
    .map(asRecord)
    .flatMap((item) => {
      const name = text(item?.PolicyName);
      const path = text(item?.Path);
      const arn = text(item?.Arn);
      return (
          name &&
            path.startsWith(root) &&
            arn === `arn:aws:iam::${scope.accountId}:policy${path}${name}`
        ) ?
          [{ arn, name, path, createdAt: text(item?.CreateDate) }]
        : [];
    });
}

/**
 * Boundaries of AWS test environments that no longer exist, created before
 * the cutoff: in a test environment's folder, named the way the product
 * names it. Their tags are read separately.
 */
export function selectOrphanBoundaryCandidates(
  payload: unknown,
  scope: AwsAppScope,
  known: ReadonlySet<string>,
  cutoff: string
): Array<AppBoundary & { environment: string }> {
  return selectAppBoundaries(payload, scope).flatMap((boundary) => {
    const environment = appPathEnvironment(boundary.path, scope);
    return (
        environment !== null &&
          !known.has(environment) &&
          boundary.name ===
            `radius-app-boundary-${scope.repositoryId}-${environment}` &&
          Date.parse(boundary.createdAt) < Date.parse(cutoff)
      ) ?
        [{ ...boundary, environment }]
      : [];
  });
}

// --- The sweep ------------------------------------------------------------

interface Target {
  readonly name: string;
  roleArn: string;
  region: string;
  cluster: string;
  trustSubjects: string[];
  // Why steps 1 to 3 keep this environment, or "" while nothing has.
  blocked: string;
  // Whether step 1's Radius application delete failed.
  deleteFailed: boolean;
}

// Failures and warnings are logged as GitHub annotations, in the order they
// happen.
class Report implements AwsCleanupReport {
  readonly failures: string[] = [];
  readonly warnings: string[] = [];
  readonly done: string[] = [];
  constructor(private readonly log: (line: string) => void) {}
  fail(line: string): void {
    this.failures.push(line);
    this.log(`::error::${line}`);
  }
  warn(line: string): void {
    this.warnings.push(line);
    this.log(`::warning::${line}`);
  }
  did(line: string): void {
    this.done.push(line);
    this.log(line);
  }
}

function parseAwsJson(result: AwsCommandResult, args: string[]): unknown {
  if (!succeeded(result))
    throw new ReadFailure(
      `aws ${args.slice(0, 2).join(" ")}: ${awsDetail(result)}`
    );
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new ReadFailure(
      `aws ${args.slice(0, 2).join(" ")} did not return JSON.`
    );
  }
}

export async function readAws(
  ports: Pick<AwsCleanupPorts, "runAws">,
  args: string[]
): Promise<unknown> {
  return parseAwsJson(await ports.runAws([...args, "--output", "json"]), args);
}

// As readAws, but undefined when AWS answers `notFound`: the resource is
// already gone. JSON never parses to undefined.
export async function readAwsIfFound(
  ports: Pick<AwsCleanupPorts, "runAws">,
  args: string[],
  notFound: string
): Promise<unknown> {
  const result = await ports.runAws([...args, "--output", "json"]);
  return awsError(result, notFound) ? undefined : parseAwsJson(result, args);
}

export async function waitFor(
  ports: Pick<AwsCleanupPorts, "sleep" | "now">,
  timeoutMs: number,
  pollMs: number,
  done: () => Promise<boolean>
): Promise<boolean> {
  const deadline = ports.now() + timeoutMs;
  for (;;) {
    if (await done()) return true;
    if (ports.now() >= deadline) return false;
    await ports.sleep(pollMs);
  }
}

async function clusterVpc(
  ports: Pick<AwsCleanupPorts, "runAws">,
  cluster: AwsCleanupCluster
): Promise<string> {
  const described = await readAws(ports, [
    "eks",
    "describe-cluster",
    "--region",
    cluster.region,
    "--name",
    cluster.name
  ]);
  const vpc = text(
    asRecord(asRecord(asRecord(described)?.cluster)?.resourcesVpcConfig)?.vpcId
  );
  if (!vpc)
    throw new ReadFailure(`EKS reported no VPC for cluster ${cluster.name}.`);
  return vpc;
}

/** The regions the sweep reads, each with its clusters' VPCs. */
export async function rdsScopes(
  config: Pick<AwsCleanupConfig, "clusters" | "environmentPrefix">,
  ports: Pick<AwsCleanupPorts, "runAws">
): Promise<AwsRdsScope[]> {
  const scopes = new Map<string, Set<string>>();
  for (const cluster of config.clusters) {
    const vpc = await clusterVpc(ports, cluster);
    const vpcs = scopes.get(cluster.region) ?? new Set<string>();
    vpcs.add(vpc);
    scopes.set(cluster.region, vpcs);
  }
  return [...scopes].map(([region, vpcIds]) => ({
    region,
    vpcIds,
    prefix: config.environmentPrefix
  }));
}

export interface RdsFootprint {
  readonly instances: RecipeDbInstance[];
  readonly subnetGroups: Array<RecipeGroupCandidate & { environment: string }>;
  readonly parameterGroups: Array<
    RecipeGroupCandidate & { environment: string }
  >;
  readonly snapshots: RecipeSnapshot[];
  readonly untaggedSnapshots: string[];
}

async function taggedGroups(
  ports: Pick<AwsCleanupPorts, "runAws">,
  scope: AwsRdsScope,
  candidates: readonly RecipeGroupCandidate[]
): Promise<Array<RecipeGroupCandidate & { environment: string }>> {
  const groups: Array<RecipeGroupCandidate & { environment: string }> = [];
  for (const candidate of candidates) {
    const tags = await readAws(ports, [
      "rds",
      "list-tags-for-resource",
      "--region",
      scope.region,
      "--resource-name",
      candidate.arn
    ]);
    const environment = recipeEnvironment(
      asRecord(tags)?.TagList,
      scope.prefix
    );
    if (environment) groups.push({ ...candidate, environment });
  }
  return groups;
}

/**
 * The groups instances outside the sweep's scope use. A group named and
 * tagged like the suite's but used by such an instance is not the suite's to
 * delete or to report.
 */
export function groupsUsedElsewhere(
  payload: unknown,
  selected: readonly RecipeDbInstance[]
): Set<string> {
  const ours = new Set(selected.map((item) => item.id));
  const used = new Set<string>();
  for (const entry of requireList(
    payload,
    "DBInstances",
    "aws rds describe-db-instances"
  )) {
    const item = asRecord(entry);
    if (ours.has(text(item?.DBInstanceIdentifier))) continue;
    used.add(text(asRecord(item?.DBSubnetGroup)?.DBSubnetGroupName));
    const parameters = item?.DBParameterGroups;
    for (const group of Array.isArray(parameters) ? parameters : [])
      used.add(text(asRecord(group)?.DBParameterGroupName));
  }
  used.delete("");
  return used;
}

/** Every recipe resource of an AWS test environment in one region. */
export async function readRdsFootprint(
  ports: Pick<AwsCleanupPorts, "runAws">,
  scope: AwsRdsScope
): Promise<RdsFootprint> {
  const region = ["--region", scope.region];
  const described = await readAws(ports, [
    "rds",
    "describe-db-instances",
    ...region
  ]);
  const instances = selectRecipeDbInstances(described, scope);
  const elsewhere = groupsUsedElsewhere(described, instances);
  const ownGroups = (candidates: RecipeGroupCandidate[]) =>
    candidates.filter((group) => !elsewhere.has(group.name));
  const subnetGroups = await taggedGroups(
    ports,
    scope,
    ownGroups(
      selectRecipeSubnetGroupCandidates(
        await readAws(ports, ["rds", "describe-db-subnet-groups", ...region]),
        scope
      )
    )
  );
  const parameterGroups = await taggedGroups(
    ports,
    scope,
    ownGroups(
      selectRecipeParameterGroupCandidates(
        await readAws(ports, [
          "rds",
          "describe-db-parameter-groups",
          ...region
        ]),
        scope
      )
    )
  );
  const snapshots = selectFinalSnapshots(
    await readAws(ports, [
      "rds",
      "describe-db-snapshots",
      ...region,
      "--snapshot-type",
      "manual"
    ]),
    scope
  );
  return {
    instances,
    subnetGroups,
    parameterGroups,
    snapshots: snapshots.tagged,
    untaggedSnapshots: snapshots.untagged
  };
}

export function rdsLabels(
  region: string,
  footprint: RdsFootprint
): Array<{
  environment: string;
  label: string;
}> {
  return [
    ...footprint.instances.map((item) => ({
      environment: item.environment,
      label: `RDS DB instance ${item.id} (${item.status}) in ${region}`
    })),
    ...footprint.subnetGroups.map((item) => ({
      environment: item.environment,
      label: `RDS DB subnet group ${item.name} in ${region}`
    })),
    ...footprint.parameterGroups.map((item) => ({
      environment: item.environment,
      label: `RDS DB parameter group ${item.name} in ${region}`
    })),
    ...footprint.snapshots.map((item) => ({
      environment: item.environment,
      label: `RDS DB snapshot ${item.id} (${item.status}) in ${region}`
    }))
  ];
}

// The instance's status, or "gone" once RDS has removed it.
async function instanceStatus(
  ports: Pick<AwsCleanupPorts, "runAws">,
  region: string,
  id: string
): Promise<string> {
  const result = await ports.runAws([
    "rds",
    "describe-db-instances",
    "--region",
    region,
    "--db-instance-identifier",
    id,
    "--output",
    "json"
  ]);
  if (awsError(result, "DBInstanceNotFound")) return "gone";
  if (!succeeded(result))
    throw new ReadFailure(
      `aws rds describe-db-instances: ${awsDetail(result)}`
    );
  const instances = asRecord(JSON.parse(result.stdout))?.DBInstances;
  return text(
    asRecord(Array.isArray(instances) ? instances[0] : null)?.DBInstanceStatus
  );
}

async function instanceGone(
  ports: Pick<AwsCleanupPorts, "runAws">,
  region: string,
  id: string
): Promise<boolean> {
  return (await instanceStatus(ports, region, id)) === "gone";
}

// Whether RDS no longer lists one named resource: a describe filtered to the
// name answers its NotFound fault. Any other failure is a failed read.
async function rdsResourceGone(
  ports: Pick<AwsCleanupPorts, "runAws">,
  region: string,
  describe: { verb: string; nameFlag: string; notFound: string },
  name: string
): Promise<boolean> {
  const result = await ports.runAws([
    "rds",
    describe.verb,
    "--region",
    region,
    describe.nameFlag,
    name,
    "--output",
    "json"
  ]);
  if (awsError(result, describe.notFound)) return true;
  if (!succeeded(result))
    throw new ReadFailure(`aws rds ${describe.verb}: ${awsDetail(result)}`);
  return false;
}

const SNAPSHOT_DESCRIBE = {
  verb: "describe-db-snapshots",
  nameFlag: "--db-snapshot-identifier",
  notFound: "DBSnapshotNotFound"
};

/**
 * Delete one region's recipe resources of the environments `sweepable`
 * accepts. Instances first, without a final snapshot, then, once they are
 * gone, the groups they used, then the final snapshots Cloud Control took.
 */
async function sweepRds(
  ports: AwsCleanupPorts,
  scope: AwsRdsScope,
  sweepable: (environment: string) => boolean,
  report: Report
): Promise<boolean> {
  const footprint = await readRdsFootprint(ports, scope);
  const region = scope.region;
  for (const id of footprint.untaggedSnapshots) {
    report.warn(
      `RDS DB snapshot ${id} in ${region} has no environment tag, so the sweep kept it. See the AWS section of docs/eng/CLOUD_E2E_RUNBOOK.md.`
    );
  }
  let clean = true;
  const instances = footprint.instances.filter((item) =>
    sweepable(item.environment)
  );
  // Only an instance RDS is deleting is waited on. One whose delete was
  // refused would never go, and waiting on it would only use up the job.
  const deleting: RecipeDbInstance[] = [];
  for (const instance of instances) {
    if (instance.status === "deleting") {
      deleting.push(instance);
      continue;
    }
    const result = await ports.runAws([
      "rds",
      "delete-db-instance",
      "--region",
      region,
      "--db-instance-identifier",
      instance.id,
      "--skip-final-snapshot"
    ]);
    if (succeeded(result) || awsError(result, "DBInstanceNotFound")) {
      deleting.push(instance);
      continue;
    }
    // RDS refuses a second delete of an instance it is already deleting, as
    // when the app delete started one after the sweep read the list.
    if (
      awsError(result, "InvalidDBInstanceState") &&
      (await instanceStatus(ports, region, instance.id)) === "deleting"
    ) {
      deleting.push(instance);
      continue;
    }
    report.fail(
      `Deleting RDS DB instance ${instance.id} in ${region}: ${awsDetail(result)}`
    );
    clean = false;
  }
  for (const instance of deleting) {
    const gone = await waitFor(ports, RDS_DELETE_TIMEOUT_MS, RDS_POLL_MS, () =>
      instanceGone(ports, region, instance.id)
    );
    if (gone) {
      report.did(`Deleted RDS DB instance ${instance.id} in ${region}`);
    } else {
      report.fail(
        `RDS DB instance ${instance.id} in ${region} was still there after ${RDS_DELETE_TIMEOUT_MS / 60000} minutes.`
      );
      clean = false;
    }
  }
  // A group an instance still uses can't be deleted, so the groups wait for
  // every instance to be gone.
  if (!clean) return false;
  const groups = [
    ...footprint.parameterGroups.map((group) => ({
      ...group,
      kind: "parameter",
      verb: "delete-db-parameter-group",
      describe: {
        verb: "describe-db-parameter-groups",
        nameFlag: "--db-parameter-group-name",
        notFound: "DBParameterGroupNotFound"
      }
    })),
    ...footprint.subnetGroups.map((group) => ({
      ...group,
      kind: "subnet",
      verb: "delete-db-subnet-group",
      describe: {
        verb: "describe-db-subnet-groups",
        nameFlag: "--db-subnet-group-name",
        notFound: "DBSubnetGroupNotFoundFault"
      }
    }))
  ].filter((group) => sweepable(group.environment));
  for (const group of groups) {
    const result = await ports.runAws([
      "rds",
      group.verb,
      "--region",
      region,
      group.describe.nameFlag,
      group.name
    ]);
    if (!succeeded(result) && !awsError(result, group.describe.notFound)) {
      report.fail(
        `Deleting RDS DB ${group.kind} group ${group.name} in ${region}: ${awsDetail(result)}`
      );
      clean = false;
      continue;
    }
    const gone = await waitFor(
      ports,
      GROUP_GONE_TIMEOUT_MS,
      GROUP_POLL_MS,
      () => rdsResourceGone(ports, region, group.describe, group.name)
    );
    if (gone) {
      report.did(
        `Deleted RDS DB ${group.kind} group ${group.name} in ${region}`
      );
    } else {
      report.fail(
        `RDS DB ${group.kind} group ${group.name} in ${region} was still there after ${GROUP_GONE_TIMEOUT_MS / 60000} minutes.`
      );
      clean = false;
    }
  }
  for (const snapshot of footprint.snapshots.filter((item) =>
    sweepable(item.environment)
  )) {
    if (!(await deleteSnapshot(ports, scope, snapshot, report))) clean = false;
  }
  return clean;
}

async function deleteSnapshot(
  ports: AwsCleanupPorts,
  scope: AwsRdsScope,
  snapshot: RecipeSnapshot,
  report: Report
): Promise<boolean> {
  const region = scope.region;
  let status = snapshot.status;
  if (status === "creating") {
    const ready = await waitFor(
      ports,
      SNAPSHOT_READY_TIMEOUT_MS,
      RDS_POLL_MS,
      async () => {
        status = await snapshotStatus(ports, scope, snapshot.id);
        return status !== "creating";
      }
    );
    if (!ready) {
      report.fail(
        `RDS DB snapshot ${snapshot.id} in ${region} was still being created after ${SNAPSHOT_READY_TIMEOUT_MS / 60000} minutes.`
      );
      return false;
    }
  }
  if (status === "gone") return true;
  if (status === "available") {
    const result = await ports.runAws([
      "rds",
      "delete-db-snapshot",
      "--region",
      region,
      "--db-snapshot-identifier",
      snapshot.id
    ]);
    // RDS refuses a snapshot it is already deleting, as when an earlier
    // request landed with its answer lost.
    const refused =
      !succeeded(result) &&
      !awsError(result, "DBSnapshotNotFound") &&
      !(
        awsError(result, "InvalidDBSnapshotState") &&
        (await snapshotStatus(ports, scope, snapshot.id)) === "deleting"
      );
    if (refused) {
      report.fail(
        `Deleting RDS DB snapshot ${snapshot.id} in ${region}: ${awsDetail(result)}`
      );
      return false;
    }
  } else if (status !== "deleting") {
    report.fail(
      `RDS DB snapshot ${snapshot.id} in ${region} is ${status}, and only an available snapshot can be deleted.`
    );
    return false;
  }
  // An accepted delete leaves the snapshot listed as `deleting` for a while,
  // and the check that follows must not find it.
  const gone = await waitFor(
    ports,
    SNAPSHOT_DELETE_TIMEOUT_MS,
    RDS_POLL_MS,
    () => rdsResourceGone(ports, region, SNAPSHOT_DESCRIBE, snapshot.id)
  );
  if (!gone) {
    report.fail(
      `RDS DB snapshot ${snapshot.id} in ${region} was still being deleted after ${SNAPSHOT_DELETE_TIMEOUT_MS / 60000} minutes.`
    );
    return false;
  }
  report.did(`Deleted RDS DB snapshot ${snapshot.id} in ${region}`);
  return true;
}

// The snapshot's status, or "gone" once RDS no longer lists it.
async function snapshotStatus(
  ports: Pick<AwsCleanupPorts, "runAws">,
  scope: AwsRdsScope,
  id: string
): Promise<string> {
  const listed = selectFinalSnapshots(
    await readAws(ports, [
      "rds",
      "describe-db-snapshots",
      "--region",
      scope.region,
      "--snapshot-type",
      "manual"
    ]),
    scope
  ).tagged.find((item) => item.id === id);
  return listed?.status ?? "gone";
}

// A cutoff in the future selects every workload, whatever its age.
const ANY_AGE = "9999-12-31T23:59:59Z";

async function readWorkloads(
  config: AwsCleanupConfig,
  ports: AwsCleanupPorts,
  cluster: AwsCleanupCluster,
  cutoff: string
): Promise<LeakedClusterWorkload[]> {
  return selectLeakedClusterWorkloads(
    await ports.kubernetes.listWorkloads(cluster),
    config.environmentPrefix,
    config.application,
    cutoff
  );
}

async function sweepWorkloads(
  config: AwsCleanupConfig,
  ports: AwsCleanupPorts,
  cluster: AwsCleanupCluster,
  sweepable: (environment: string) => boolean,
  keepNamespace: boolean,
  report: Report
): Promise<boolean> {
  const where = `cluster ${cluster.name} (${cluster.region})`;
  const leaked = (
    await readWorkloads(config, ports, cluster, config.cutoff)
  ).filter((item) => sweepable(item.environment.toLowerCase()));
  let clean = true;
  for (const workload of leaked) {
    try {
      await ports.kubernetes.deleteWorkload(cluster, workload);
    } catch (error) {
      report.fail(
        `Deleting ${workload.kind} ${workload.namespace}/${workload.name} on ${where}: ${errorMessage(error)}`
      );
      clean = false;
    }
  }
  if (leaked.length > 0) {
    const names = new Set(
      leaked.map((item) => `${item.kind}/${item.namespace}/${item.name}`)
    );
    const gone = await waitFor(
      ports,
      WORKLOAD_GONE_TIMEOUT_MS,
      WORKLOAD_POLL_MS,
      async () =>
        !(await readWorkloads(config, ports, cluster, ANY_AGE)).some((item) =>
          names.has(`${item.kind}/${item.namespace}/${item.name}`)
        )
    );
    if (gone)
      report.did(`Deleted ${leaked.length} leaked workloads on ${where}`);
    else {
      report.fail(
        `Leaked workloads on ${where} were still there after deletion.`
      );
      clean = false;
    }
  }
  if (keepNamespace) return clean;
  if (!(await ports.kubernetes.namespaceExists(cluster, config.namespace)))
    return clean;
  try {
    await ports.kubernetes.deleteNamespace(cluster, config.namespace);
  } catch (error) {
    report.fail(
      `Deleting namespace ${config.namespace} on ${where}: ${errorMessage(error)}`
    );
    return false;
  }
  const gone = await waitFor(
    ports,
    WORKLOAD_GONE_TIMEOUT_MS,
    WORKLOAD_POLL_MS,
    async () =>
      !(await ports.kubernetes.namespaceExists(cluster, config.namespace))
  );
  if (!gone) {
    report.fail(
      `Namespace ${config.namespace} on ${where} is still terminating.`
    );
    return false;
  }
  report.did(`Deleted namespace ${config.namespace} on ${where}`);
  return clean;
}

export interface AppRole extends AppRoleCandidate {
  readonly tags: unknown[];
}

/**
 * Something a list still shows but its describe no longer finds, as an
 * eventually consistent read can answer while a delete settles. Its
 * environment is null when the list doesn't say which it is.
 */
export interface ListedButGone {
  readonly environment: string | null;
  readonly label: string;
}

/**
 * The repository's app roles, each with its tags. A role whose tags are
 * already gone is left out, and added to `gone` when it is given.
 */
export async function readAppRoles(
  ports: Pick<AwsCleanupPorts, "runAws">,
  scope: AwsAppScope,
  gone?: ListedButGone[]
): Promise<AppRole[]> {
  const roles: AppRole[] = [];
  for (const role of selectAppRoleCandidates(
    await readAws(ports, [
      "iam",
      "list-roles",
      "--path-prefix",
      appPathRoot(scope.repositoryId)
    ]),
    scope
  )) {
    // A role deleted since the list is skipped.
    const tags = await readAwsIfFound(
      ports,
      ["iam", "list-role-tags", "--role-name", role.name],
      "NoSuchEntity"
    );
    if (tags !== undefined)
      roles.push({
        ...role,
        tags: requireList(tags, "Tags", "aws iam list-role-tags")
      });
    else
      gone?.push({
        environment: appPathEnvironment(role.path, scope),
        label: `app role ${role.name}`
      });
  }
  return roles;
}

export interface AppAssociation extends AppAssociationCandidate {
  readonly cluster: AwsCleanupCluster;
  readonly roleArn: string;
  readonly tags: AwsTag[];
}

/**
 * A cluster's Pod Identity associations, each with its role and tags. One
 * whose describe is already gone is left out, and added to `gone` when it is
 * given.
 */
export async function readAssociations(
  ports: Pick<AwsCleanupPorts, "runAws">,
  cluster: AwsCleanupCluster,
  gone?: ListedButGone[]
): Promise<AppAssociation[]> {
  const where = ["--region", cluster.region, "--cluster-name", cluster.name];
  const associations: AppAssociation[] = [];
  for (const candidate of selectAssociationCandidates(
    await readAws(ports, ["eks", "list-pod-identity-associations", ...where])
  )) {
    // An association deleted since the list is skipped.
    const described = await readAwsIfFound(
      ports,
      [
        "eks",
        "describe-pod-identity-association",
        ...where,
        "--association-id",
        candidate.id
      ],
      "ResourceNotFoundException"
    );
    if (described !== undefined)
      associations.push({
        ...candidate,
        cluster,
        ...describedAssociation(described, candidate.id)
      });
    else
      gone?.push({
        environment: null,
        label: `Pod Identity association ${candidate.id} (${candidate.namespace}/${candidate.serviceAccount}) on cluster ${cluster.name}`
      });
  }
  return associations;
}

/** A cluster's associations whose role is under the repository's app path. */
export async function readAppAssociations(
  ports: Pick<AwsCleanupPorts, "runAws">,
  scope: AwsAppScope,
  cluster: AwsCleanupCluster,
  gone?: ListedButGone[]
): Promise<AppAssociation[]> {
  return (await readAssociations(ports, cluster, gone)).filter((item) =>
    underAppPath(item.roleArn, scope)
  );
}

/** The permissions boundary of a role, or "" for none. ListRoles leaves it out. */
export async function readRoleBoundary(
  ports: Pick<AwsCleanupPorts, "runAws">,
  roleName: string
): Promise<string> {
  const role = asRecord(
    asRecord(await readAws(ports, ["iam", "get-role", "--role-name", roleName]))
      ?.Role
  );
  if (!role)
    throw new ReadFailure(`IAM did not describe app role ${roleName}.`);
  return text(asRecord(role.PermissionsBoundary)?.PermissionsBoundaryArn);
}

/**
 * The repository's app roles, whatever their tags say, except what Radius's
 * own cleanup tag marks as Radius's. The leftover check and preflight both
 * use it.
 */
export async function appRoleLeftovers(
  ports: Pick<AwsCleanupPorts, "runAws">,
  scope: AwsAppScope
): Promise<string[]> {
  return (await readAppRoles(ports, scope))
    .filter((role) => !radiusTagged(role.tags))
    .map((role) => `app role ${role.arn}`);
}

/**
 * A cluster's associations whose role is under the repository's app path, by
 * the same rule. An association outlives its role, so this is the only check
 * that sees one whose role is gone.
 */
export async function associationLeftovers(
  ports: Pick<AwsCleanupPorts, "runAws">,
  scope: AwsAppScope,
  cluster: AwsCleanupCluster
): Promise<string[]> {
  return (await readAppAssociations(ports, scope, cluster))
    .filter((item) => !radiusTagged(item.tags))
    .map((item) => `${appAssociationLabel(item)}, for ${item.roleArn}`);
}

function associationKey(item: AppAssociation): string {
  return `${item.cluster.region}/${item.cluster.name}/${item.id}`;
}

export function appAssociationLabel(item: AppAssociation): string {
  return `Pod Identity association ${item.id} (${item.namespace}/${item.serviceAccount}) on cluster ${item.cluster.name}`;
}

/**
 * Delete the app roles and Pod Identity associations of the environments
 * `sweepable` accepts. Each one, and each role's inline policies, is read
 * before anything is deleted. Associations go first, and the roles only once
 * every association is gone, so none is left naming a deleted role. Returns
 * what it deleted, which IAM may still list for a moment.
 */
async function sweepAppIdentities(
  config: AwsCleanupConfig,
  ports: AwsCleanupPorts,
  scope: AwsAppScope,
  sweepable: (environment: string) => boolean,
  report: Report
): Promise<{ clean: boolean; deleted: Set<string> }> {
  const selected = (roleArn: string, tags: unknown) => {
    const environment = appIdentityEnvironment(roleArn, tags, scope);
    return environment !== null && sweepable(environment);
  };
  const associations: AppAssociation[] = [];
  for (const cluster of config.clusters)
    associations.push(
      ...(await readAppAssociations(ports, scope, cluster)).filter((item) =>
        selected(item.roleArn, item.tags)
      )
    );
  const roles: Array<AppRole & { policies: string[] }> = [];
  for (const role of (await readAppRoles(ports, scope)).filter((item) =>
    selected(item.arn, item.tags)
  )) {
    const listed = await readAwsIfFound(
      ports,
      ["iam", "list-role-policies", "--role-name", role.name],
      "NoSuchEntity"
    );
    if (listed !== undefined)
      roles.push({
        ...role,
        policies: requireList(
          listed,
          "PolicyNames",
          "aws iam list-role-policies"
        ).map(text)
      });
  }
  const deleted = new Set<string>();
  let clean = true;
  for (const item of associations) {
    const result = await ports.runAws([
      "eks",
      "delete-pod-identity-association",
      "--region",
      item.cluster.region,
      "--cluster-name",
      item.cluster.name,
      "--association-id",
      item.id
    ]);
    if (succeeded(result) || awsError(result, "ResourceNotFoundException")) {
      deleted.add(associationKey(item));
      report.did(`Deleted ${appAssociationLabel(item)}`);
    } else {
      report.fail(
        `Deleting ${appAssociationLabel(item)}: ${awsDetail(result)}`
      );
      clean = false;
    }
  }
  if (!clean) return { clean, deleted };
  for (const role of roles) {
    if (await deleteAppRole(ports, role, report)) deleted.add(role.arn);
    else clean = false;
  }
  return { clean, deleted };
}

// IAM is eventually consistent: for a while after the sweep deletes a role's
// inline policies, or a role that used a boundary, IAM may still count them
// and refuse the next delete (DeleteConflict). That is retried with a
// growing wait before it is reported.
export const IAM_CONFLICT_RETRY_MS = [5_000, 10_000, 20_000, 40_000] as const;
const IAM_CONFLICT_RETRY_SECONDS =
  IAM_CONFLICT_RETRY_MS.reduce((total, wait) => total + wait, 0) / 1000;

async function runIamDelete(
  ports: Pick<AwsCleanupPorts, "runAws" | "sleep">,
  args: string[]
): Promise<AwsCommandResult> {
  let result = await ports.runAws(args);
  for (const wait of IAM_CONFLICT_RETRY_MS) {
    if (!awsError(result, "DeleteConflict")) break;
    await ports.sleep(wait);
    result = await ports.runAws(args);
  }
  return result;
}

// Delete a role's inline policies, then the role. The Recipe attaches no
// managed policy, and the test role can't detach one, so IAM's refusal of a
// role that has one is reported, not worked around.
async function deleteAppRole(
  ports: Pick<AwsCleanupPorts, "runAws" | "sleep">,
  role: AppRole & { policies: readonly string[] },
  report: Report
): Promise<boolean> {
  for (const policy of role.policies) {
    const result = await ports.runAws([
      "iam",
      "delete-role-policy",
      "--role-name",
      role.name,
      "--policy-name",
      policy
    ]);
    if (succeeded(result) || awsError(result, "NoSuchEntity")) continue;
    report.fail(
      `Deleting inline policy ${policy} of app role ${role.arn}: ${awsDetail(result)}`
    );
    return false;
  }
  const result = await runIamDelete(ports, [
    "iam",
    "delete-role",
    "--role-name",
    role.name
  ]);
  if (succeeded(result) || awsError(result, "NoSuchEntity")) {
    report.did(`Deleted app role ${role.arn}`);
    return true;
  }
  report.fail(
    `Deleting app role ${role.arn}: ${awsDetail(result)}${
      awsError(result, "DeleteConflict") ?
        ` IAM still refused after ${IAM_CONFLICT_RETRY_SECONDS} seconds of retries, so the role has a managed policy or an instance profile, which the test role can't remove.`
      : ""
    }`
  );
  return false;
}

/** What is left of each AWS test environment, by environment name. */
async function readFootprintByEnvironment(
  config: AwsCleanupConfig,
  ports: AwsCleanupPorts,
  scopes: readonly AwsRdsScope[],
  app: AwsAppScope,
  // What the sweep just deleted, which IAM may still list.
  deleted: ReadonlySet<string>,
  gone?: ListedButGone[]
): Promise<Map<string, string[]>> {
  const left = new Map<string, string[]>();
  const add = (environment: string, label: string) =>
    left.set(environment, [...(left.get(environment) ?? []), label]);
  for (const scope of scopes) {
    for (const item of rdsLabels(
      scope.region,
      await readRdsFootprint(ports, scope)
    ))
      add(item.environment, item.label);
  }
  for (const role of await readAppRoles(ports, app, gone)) {
    const environment = appFolderEnvironment(role.arn, role.tags, app);
    if (environment && !deleted.has(role.arn))
      add(environment, `app role ${role.name}`);
  }
  for (const cluster of config.clusters) {
    for (const item of await readAppAssociations(ports, app, cluster, gone)) {
      const environment = appFolderEnvironment(item.roleArn, item.tags, app);
      if (environment && !deleted.has(associationKey(item)))
        add(environment, appAssociationLabel(item));
    }
    for (const item of await readWorkloads(config, ports, cluster, ANY_AGE))
      add(
        item.environment.toLowerCase(),
        `${item.kind} ${item.namespace}/${item.name} on cluster ${cluster.name}`
      );
  }
  return left;
}

/**
 * What is left of each AWS test environment, read again until `names` have
 * nothing, or for at most LEFTOVER_SETTLE_MS. For an environment whose app
 * delete failed, only these reads decide: nothing the sweep deleted is taken
 * on trust, so a role, association, or workload that IAM, EKS, or Kubernetes
 * still lists while it goes keeps the environment. That includes one a list
 * shows but its describe no longer finds. An association's list doesn't say
 * whose it is, so it keeps every one of `names`.
 */
async function settledFootprint(
  config: AwsCleanupConfig,
  ports: AwsCleanupPorts,
  scopes: readonly AwsRdsScope[],
  app: AwsAppScope,
  names: readonly string[]
): Promise<Map<string, string[]>> {
  let left = new Map<string, string[]>();
  await waitFor(ports, LEFTOVER_SETTLE_MS, LEFTOVER_POLL_MS, async () => {
    const gone: ListedButGone[] = [];
    left = await readFootprintByEnvironment(
      config,
      ports,
      scopes,
      app,
      new Set(),
      gone
    );
    for (const item of gone)
      for (const name of item.environment === null ? names : [item.environment])
        left.set(name, [
          ...(left.get(name) ?? []),
          `${item.label} (still listed)`
        ]);
    return names.every((name) => !left.has(name));
  });
  return left;
}

function readTarget(
  config: AwsCleanupConfig,
  name: string,
  variables: Record<string, string>
): Target {
  const target: Target = {
    name,
    roleArn: (variables.AWS_ROLE_ARN ?? "").trim(),
    region: (variables.AWS_REGION ?? "").trim(),
    cluster: (variables.AWS_EKS_CLUSTER_NAME ?? "").trim(),
    trustSubjects: parseTrustSubjects(variables.AWS_TRUST_SUBJECTS),
    blocked: "",
    deleteFailed: false
  };
  const role = parseAwsRoleArn(target.roleArn);
  if (!role) {
    target.blocked = `GitHub environment ${name} has no AWS_ROLE_ARN, so the sweep can't tell which role it changed.`;
  } else if (
    role.accountId !== config.accountId ||
    role.roleName.toLowerCase() !== config.deployRoleName.toLowerCase()
  ) {
    target.blocked = `GitHub environment ${name} names role ${target.roleArn}, not the fixture's deploy role ${config.deployRoleName} in account ${config.accountId}.`;
  } else if (
    !config.clusters.some(
      (cluster) =>
        cluster.region === target.region && cluster.name === target.cluster
    )
  ) {
    target.blocked = `GitHub environment ${name} names cluster ${target.cluster || "(none)"} in ${target.region || "(no region)"}, which is not one of the Cloud E2E clusters.`;
  }
  return target;
}

async function readCallerAccount(
  ports: Pick<AwsCleanupPorts, "runAws">
): Promise<string> {
  const identity = await readAws(ports, ["sts", "get-caller-identity"]);
  return text(asRecord(identity)?.Account);
}

/**
 * Sweep what the AWS Cloud E2E stage leaks. Never throws for an outside
 * failure: each is in the report, and the caller fails the job when the
 * report has any.
 */
export async function sweepAwsCloudE2E(
  config: AwsCleanupConfig,
  ports: AwsCleanupPorts
): Promise<AwsCleanupReport> {
  const report = new Report(ports.log);
  try {
    const account = await readCallerAccount(ports);
    if (account !== config.accountId) {
      report.fail(
        `AWS is signed in to account ${account || "(unknown)"}, not ${config.accountId}. Nothing was changed.`
      );
      return report;
    }
  } catch (error) {
    report.fail(
      `Could not read the AWS account: ${errorMessage(error)}. Nothing was changed.`
    );
    return report;
  }

  let existing: Set<string> | null = null;
  const targets: Target[] = [];
  try {
    const pages = await ports.github.listEnvironments();
    existing = new Set(
      selectPrefixedEnvironments(pages, config.environmentPrefix).map((name) =>
        name.toLowerCase()
      )
    );
    for (const name of selectExpiredEnvironments(
      pages,
      config.environmentPrefix,
      config.cutoff
    )) {
      try {
        targets.push(
          readTarget(
            config,
            name,
            await ports.github.readEnvironmentVariables(name)
          )
        );
      } catch (error) {
        targets.push({
          name,
          roleArn: "",
          region: "",
          cluster: "",
          trustSubjects: [],
          blocked: `Could not read the variables of GitHub environment ${name}: ${errorMessage(error)}`,
          deleteFailed: false
        });
      }
    }
  } catch (error) {
    report.fail(
      `Could not list the fixture's GitHub environments: ${errorMessage(error)}. No environment, RDS resource, app role, or workload was deleted.`
    );
  }
  for (const target of targets) {
    if (target.blocked) report.fail(target.blocked);
  }

  // First, so a run that times out on a long delete still stops the nodes.
  await scaleDownNodeGroups(config, ports, report);

  if (existing) {
    const live = new Set(existing);
    for (const target of targets) live.delete(target.name.toLowerCase());
    // A resource is swept when its environment is stale or already gone. A
    // newer environment keeps everything it made.
    const sweepable = (environment: string) => !live.has(environment);

    // Step 1.
    for (const target of targets.filter((item) => !item.blocked)) {
      try {
        await ports.github.deleteApplication(target.name, config.application);
        report.did(`Deleted the Radius application in ${target.name}`);
      } catch (error) {
        const line = `Deleting the Radius application in ${target.name} failed: ${errorMessage(error)}`;
        if (error instanceof ApplicationDeleteFailed) {
          target.deleteFailed = true;
          report.fail(line);
        } else {
          // The run may still be deleting, and needs the access step 4
          // removes until it ends.
          target.blocked = `${line} A delete run may still be going, so ${target.name} keeps its access and GitHub state for a retry.`;
          report.fail(target.blocked);
        }
      }
    }

    // Steps 2 and 3. Any failure here keeps every environment.
    let swept = true;
    let scopes: AwsRdsScope[] = [];
    try {
      scopes = await rdsScopes(config, ports);
      for (const scope of scopes) {
        if (!(await sweepRds(ports, scope, sweepable, report))) swept = false;
      }
    } catch (error) {
      report.fail(
        `RDS sweep stopped without deleting further: ${errorMessage(error)}`
      );
      swept = false;
    }
    let appIdentities: Awaited<ReturnType<typeof sweepAppIdentities>> = {
      clean: false,
      deleted: new Set()
    };
    // App roles are under the repository's ID. Without it, the rest of the
    // sweep still runs, and every environment keeps its access.
    const app = await readAppScope(config, ports);
    if (app.scope === null) {
      report.fail(
        `No app role, Pod Identity association, or app boundary was swept, because the fixture repository's ID could not be read: ${app.message}`
      );
    } else {
      try {
        appIdentities = await sweepAppIdentities(
          config,
          ports,
          app.scope,
          sweepable,
          report
        );
      } catch (error) {
        report.fail(
          `App role and Pod Identity sweep stopped without deleting further: ${errorMessage(error)}`
        );
      }
    }
    if (!appIdentities.clean) swept = false;
    for (const cluster of config.clusters) {
      try {
        if (
          !(await sweepWorkloads(
            config,
            ports,
            cluster,
            sweepable,
            live.size > 0,
            report
          ))
        )
          swept = false;
      } catch (error) {
        report.fail(
          `Workload sweep of cluster ${cluster.name} stopped without deleting further: ${errorMessage(error)}`
        );
        swept = false;
      }
    }
    let left = new Map<string, string[]>();
    if (swept && app.scope) {
      try {
        left = await readFootprintByEnvironment(
          config,
          ports,
          scopes,
          app.scope,
          appIdentities.deleted
        );
        const unconfirmed = targets
          .filter((item) => item.deleteFailed && !item.blocked)
          .map((item) => item.name.toLowerCase())
          .filter((name) => !left.has(name));
        if (unconfirmed.length > 0) {
          const settled = await settledFootprint(
            config,
            ports,
            scopes,
            app.scope,
            unconfirmed
          );
          for (const name of unconfirmed) {
            const items = settled.get(name);
            if (items) left.set(name, items);
          }
        }
      } catch (error) {
        report.fail(`Could not check what is left: ${errorMessage(error)}`);
        swept = false;
      }
    }
    for (const target of targets.filter((item) => !item.blocked)) {
      const items = left.get(target.name.toLowerCase());
      if (!swept) {
        target.blocked = `The RDS, app role, or workload sweep failed, so ${target.name} keeps its access and GitHub state for a retry.`;
      } else if (items) {
        target.blocked = `${target.deleteFailed ? `The Radius application delete in ${target.name} failed, and it` : target.name} still has ${items.join(", ")}, so it keeps its access and GitHub state for a retry.`;
        report.fail(target.blocked);
      } else if (target.deleteFailed) {
        report.warn(
          `The Radius application delete in ${target.name} failed, but AWS and the clusters list none of its RDS resources, app roles, Pod Identity associations, or workloads, so the sweep goes on to remove its access and GitHub environment.`
        );
      }
    }

    // Step 4.
    let deployments: AwsDeploymentRecord[] | null = null;
    try {
      deployments = selectAwsDeployments(
        await ports.github.listDeployments(),
        config.environmentPrefix
      );
    } catch (error) {
      report.fail(`Could not list deployment records: ${errorMessage(error)}`);
    }
    for (const target of targets.filter((item) => !item.blocked)) {
      if (!deployments) {
        report.fail(
          `${target.name} keeps its access and GitHub state, because its deployment records could not be listed.`
        );
        continue;
      }
      await removeEnvironment(
        config,
        ports,
        target,
        deployments.filter(
          (record) => record.environment === target.name.toLowerCase()
        ),
        report
      );
    }

    await sweepOrphanedGitHubState(
      config,
      ports,
      [...existing],
      deployments,
      report
    );
    // A boundary IAM still sees an app role use can't be deleted, so this
    // waits for the app role sweep.
    if (appIdentities.clean && app.scope)
      await sweepOrphanedBoundaries(config, ports, app.scope, existing, report);
  }

  await clearStaleLock(config, ports, report);
  return report;
}

async function removeEnvironment(
  config: AwsCleanupConfig,
  ports: AwsCleanupPorts,
  target: Target,
  records: readonly AwsDeploymentRecord[],
  report: Report
): Promise<void> {
  try {
    for (const record of records) {
      await ports.github.deleteDeployment(record.id);
    }
    if (records.length > 0)
      report.did(
        `Deleted ${records.length} deployment records of ${target.name}`
      );
    const state = await ports.github.deletePackage(
      statePackageName(config.repository, target.name)
    );
    if (state === "deleted")
      report.did(`Deleted the GHCR state package of ${target.name}`);
  } catch (error) {
    report.fail(
      `${target.name} keeps its access and GitHub environment, because removing its deployment records or state failed: ${errorMessage(error)}`
    );
    return;
  }

  const removedLocks = new Set<string>();
  let environmentDeleted = false;
  let lockedFailure = "";
  let result: AwsEnvironmentRemovalResult = { ok: false, message: "" };
  // What every attempt removed, not only the last one.
  const removed: string[] = [];
  const lockWarnings: string[] = [];
  // A removal that kept something it couldn't check or delete, such as an
  // access entry it couldn't read or a boundary IAM still counts an app role
  // just deleted against, is tried again after each IAM retry wait. After
  // that the environment goes anyway, as the product's delete does: a later
  // run could not sign in to delete the app again.
  const waits = [0, ...IAM_CONFLICT_RETRY_MS];
  for (const [attempt, wait] of waits.entries()) {
    const last = attempt === waits.length - 1;
    if (wait > 0) await ports.sleep(wait);
    let again = false;
    try {
      result = await ports.removeAccess({
        environment: target.name,
        roleArn: target.roleArn,
        region: target.region,
        cluster: target.cluster,
        trustSubjects: target.trustSubjects,
        operationId: config.operationId,
        waiting: async (wait, line) => {
          if (line) ports.log(line);
          // The product's rule: a lock 10 or more minutes old may be
          // removed. No Radius run shares the fixture with this sweep, so
          // nothing else could still be using it.
          if (!wait.removable || removedLocks.has(wait.policyId)) return;
          removedLocks.add(wait.policyId);
          const removal = await removeAwsDeployIdentityLock(
            { policyArn: wait.policyArn, policyId: wait.policyId },
            ports.runAws
          );
          // Thrown, so the removal stops instead of waiting on a lock it
          // can't take.
          if (!removal.ok)
            throw new Error(
              `Could not remove the abandoned lock ${wait.policyId}: ${removal.message}`
            );
          report.did(
            `Removed the abandoned lock ${wait.policyId} on ${config.deployRoleName}`
          );
        },
        whileLocked: async (removal) => {
          if (removal.warnings.length > 0 && !last) {
            again = true;
            return;
          }
          try {
            await ports.github.deleteEnvironment(target.name);
            environmentDeleted = true;
          } catch (error) {
            lockedFailure = errorMessage(error);
          }
        }
      });
    } catch (error) {
      result = { ok: false, message: errorMessage(error) };
    }
    if (result.ok) {
      removed.push(...result.removed);
      if (result.lockWarning) lockWarnings.push(result.lockWarning);
    }
    if (!result.ok || !again) break;
  }
  if (!result.ok) {
    report.fail(
      `Removing ${target.name} from deploy role ${config.deployRoleName} failed, so its GitHub environment was kept: ${result.message} To finish by hand, see the AWS section of docs/eng/CLOUD_E2E_RUNBOOK.md.`
    );
    return;
  }
  for (const line of lockWarnings) report.warn(`${target.name}: ${line}`);
  for (const line of result.warnings) report.fail(`${target.name}: ${line}`);
  for (const line of result.kept) ports.log(`${target.name} kept ${line}`);
  if (removed.length > 0)
    report.did(`Removed from ${config.deployRoleName}: ${removed.join(", ")}`);
  if (!environmentDeleted) {
    report.fail(
      `Removed ${target.name}'s access, but kept its GitHub environment${lockedFailure ? `: ${lockedFailure}` : ", because the deploy role's lock was lost"}. The next run tries again. See the AWS section of docs/eng/CLOUD_E2E_RUNBOOK.md.`
    );
    return;
  }
  report.did(`Deleted GitHub environment ${target.name}`);
}

/**
 * Deployment records and state packages of AWS environments that no longer
 * exist. Nothing else can find them once their environment is gone.
 */
async function sweepOrphanedGitHubState(
  config: AwsCleanupConfig,
  ports: AwsCleanupPorts,
  // Every AWS environment the run started with. Their records and state are
  // removed with them in step 4, or kept for a retry.
  known: readonly string[],
  deployments: readonly AwsDeploymentRecord[] | null,
  report: Report
): Promise<void> {
  const cutoff = Date.parse(config.cutoff);
  const kept = new Set(known);
  for (const record of deployments ?? []) {
    if (kept.has(record.environment)) continue;
    const created = Date.parse(record.createdAt);
    if (!(created < cutoff)) continue;
    try {
      await ports.github.deleteDeployment(record.id);
      report.did(
        `Deleted orphaned deployment record ${record.id} of ${record.environment}`
      );
    } catch (error) {
      report.fail(
        `Deleting orphaned deployment record ${record.id}: ${errorMessage(error)}`
      );
    }
  }
  let packages: string[];
  try {
    packages = selectStaleStatePackages(
      await ports.github.listPackages(),
      awsStatePackagePrefix(config),
      config.cutoff
    );
  } catch (error) {
    report.fail(`Could not list GHCR state packages: ${errorMessage(error)}`);
    return;
  }
  const owned = new Set(
    known.map((name) => statePackageName(config.repository, name))
  );
  for (const name of packages.filter((item) => !owned.has(item))) {
    try {
      if ((await ports.github.deletePackage(name)) === "deleted")
        report.did(`Deleted orphaned GHCR state package ${name}`);
    } catch (error) {
      report.fail(
        `Deleting orphaned GHCR state package ${name}: ${errorMessage(error)}`
      );
    }
  }
}

/**
 * App boundaries of AWS environments that no longer exist. The product's
 * removal deletes an environment's boundary in step 4, but keeps one an app
 * role still used. Each is deleted only when Radius tagged it for the fixture
 * repository.
 */
async function sweepOrphanedBoundaries(
  config: AwsCleanupConfig,
  ports: AwsCleanupPorts,
  scope: AwsAppScope,
  // Every AWS environment the run started with. Step 4 removes their
  // boundaries, or keeps them for a retry.
  known: ReadonlySet<string>,
  report: Report
): Promise<void> {
  let boundaries: AppBoundary[];
  try {
    boundaries = selectOrphanBoundaryCandidates(
      await readAws(ports, [
        "iam",
        "list-policies",
        "--scope",
        "Local",
        "--path-prefix",
        appPathRoot(scope.repositoryId)
      ]),
      scope,
      known,
      config.cutoff
    );
  } catch (error) {
    report.fail(
      `Could not list app permissions boundaries: ${errorMessage(error)}`
    );
    return;
  }
  for (const boundary of boundaries) {
    const label = `permissions boundary ${boundary.arn}`;
    try {
      const read = await readAwsIfFound(
        ports,
        ["iam", "get-policy", "--policy-arn", boundary.arn],
        "NoSuchEntity"
      );
      if (read === undefined) continue;
      if (
        radiusRoleRepositoryId(asRecord(read)?.Policy) !== scope.repositoryId
      ) {
        report.warn(
          `The orphaned ${label} is not tagged for ${config.repository}, so the sweep kept it.`
        );
        continue;
      }
    } catch (error) {
      report.fail(
        `Could not read the orphaned ${label}: ${errorMessage(error)}`
      );
      continue;
    }
    const result = await runIamDelete(ports, [
      "iam",
      "delete-policy",
      "--policy-arn",
      boundary.arn
    ]);
    if (succeeded(result) || awsError(result, "NoSuchEntity")) {
      report.did(`Deleted orphaned ${label}`);
    } else {
      report.fail(
        `Deleting orphaned ${label}: ${awsDetail(result)}${
          awsError(result, "DeleteConflict") ?
            ` IAM still refused after ${IAM_CONFLICT_RETRY_SECONDS} seconds of retries, so an app role still uses the policy, or it has more than one version, which the test role can't delete.`
          : ""
        }`
      );
    }
  }
}

interface NodeGroupState {
  readonly status: string;
  readonly minSize: number;
  readonly maxSize: number;
  readonly desiredSize: number;
}

async function readNodeGroup(
  ports: Pick<AwsCleanupPorts, "runAws">,
  cluster: AwsCleanupCluster,
  name: string
): Promise<NodeGroupState> {
  const described = asRecord(
    asRecord(
      await readAws(ports, [
        "eks",
        "describe-nodegroup",
        "--region",
        cluster.region,
        "--cluster-name",
        cluster.name,
        "--nodegroup-name",
        name
      ])
    )?.nodegroup
  );
  const scaling = asRecord(described?.scalingConfig);
  const size = (field: string) => {
    const value = scaling?.[field];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
      throw new ReadFailure(`EKS reported no ${field} for node group ${name}.`);
    return value;
  };
  return {
    status: text(described?.status),
    minSize: size("minSize"),
    maxSize: size("maxSize"),
    desiredSize: size("desiredSize")
  };
}

/** Scale the main cluster's node groups to zero if a run left them up. */
async function scaleDownNodeGroups(
  config: AwsCleanupConfig,
  ports: AwsCleanupPorts,
  report: Report
): Promise<void> {
  const cluster = config.clusters[0];
  for (const name of AWS_MAIN_NODE_GROUPS) {
    try {
      let group = await readNodeGroup(ports, cluster, name);
      // A group still updating may be on its way up from zero.
      if (
        group.status === "ACTIVE" &&
        group.desiredSize === 0 &&
        group.minSize === 0
      )
        continue;
      if (group.status !== "ACTIVE") {
        const ready = await waitFor(
          ports,
          NODE_GROUP_READY_TIMEOUT_MS,
          NODE_GROUP_POLL_MS,
          async () => {
            group = await readNodeGroup(ports, cluster, name);
            return group.status === "ACTIVE";
          }
        );
        if (!ready) {
          report.fail(
            `Node group ${name} on ${cluster.name} is ${group.status} with ${group.desiredSize} nodes, so it could not be scaled to zero.`
          );
          continue;
        }
        if (group.desiredSize === 0 && group.minSize === 0) continue;
      }
      const result = await runNodeGroupUpdate(ports, [
        "eks",
        "update-nodegroup-config",
        "--region",
        cluster.region,
        "--cluster-name",
        cluster.name,
        "--nodegroup-name",
        name,
        "--scaling-config",
        `minSize=0,maxSize=${Math.max(group.maxSize, 1)},desiredSize=0`
      ]);
      if (succeeded(result))
        report.did(
          `Scaled node group ${name} on ${cluster.name} to zero from ${group.desiredSize}`
        );
      else
        report.fail(
          `Scaling node group ${name} on ${cluster.name} to zero: ${awsDetail(result)}`
        );
    } catch (error) {
      report.fail(
        `Could not read node group ${name} on ${cluster.name}: ${errorMessage(error)}`
      );
    }
  }
}

/**
 * Run a node group update, waiting out another update that still holds the
 * group. EKS refuses an update while one is in progress
 * (ResourceInUseException), and a describe right after an update may still
 * show the group ACTIVE.
 */
export async function runNodeGroupUpdate(
  ports: Pick<AwsCleanupPorts, "runAws" | "sleep" | "now">,
  args: string[]
): Promise<AwsCommandResult> {
  const deadline = ports.now() + NODE_GROUP_READY_TIMEOUT_MS;
  let result = await ports.runAws(args);
  while (awsError(result, "ResourceInUseException") && ports.now() < deadline) {
    await ports.sleep(NODE_GROUP_POLL_MS);
    result = await ports.runAws(args);
  }
  return result;
}

interface LockState {
  readonly policyArn: string;
  readonly policyId: string;
  readonly createdAt: string;
  readonly holder: string;
}

async function readLock(
  config: AwsCleanupConfig,
  ports: Pick<AwsCleanupPorts, "runAws">
): Promise<LockState | null> {
  const policyArn = awsLockPolicyArn(config.accountId, config.deployRoleName);
  const result = await ports.runAws([
    "iam",
    "get-policy",
    "--policy-arn",
    policyArn,
    "--output",
    "json"
  ]);
  if (!succeeded(result)) {
    if (awsError(result, "NoSuchEntity")) return null;
    throw new ReadFailure(`aws iam get-policy: ${awsDetail(result)}`);
  }
  const policy = asRecord(asRecord(JSON.parse(result.stdout))?.Policy);
  const holder = parseAwsLockHolder(policy?.Description);
  return {
    policyArn,
    policyId: text(policy?.PolicyId),
    createdAt: text(policy?.CreateDate),
    holder:
      holder ?
        `${holder.action} of ${holder.environment} in ${holder.repo}${holder.operationId ? ` (operation ${holder.operationId})` : ""}`
      : "an unknown holder"
  };
}

/**
 * Remove a lock a stopped run left on the deploy role, by the product's rule:
 * only once it is 10 or more minutes old. A newer one is reported.
 */
async function clearStaleLock(
  config: AwsCleanupConfig,
  ports: AwsCleanupPorts,
  report: Report
): Promise<void> {
  let lock: LockState | null;
  try {
    lock = await readLock(config, ports);
  } catch (error) {
    report.fail(
      `Could not read the lock on ${config.deployRoleName}: ${errorMessage(error)}`
    );
    return;
  }
  if (!lock) return;
  const created = Date.parse(lock.createdAt);
  if (!(ports.now() - created >= AWS_LOCK_REMOVABLE_AFTER_MS)) {
    report.fail(
      `The lock on ${config.deployRoleName}, held by ${lock.holder} since ${lock.createdAt || "an unknown time"}, is less than 10 minutes old, so the sweep kept it.`
    );
    return;
  }
  const removal = await removeAwsDeployIdentityLock(
    { policyArn: lock.policyArn, policyId: lock.policyId },
    ports.runAws
  );
  if (removal.ok) {
    const removed = lock;
    const gone = await waitFor(
      ports,
      LOCK_GONE_TIMEOUT_MS,
      LOCK_POLL_MS,
      async () => (await readLock(config, ports))?.policyId !== removed.policyId
    );
    if (!gone) {
      report.fail(
        `IAM still listed the lock on ${config.deployRoleName} ${LOCK_GONE_TIMEOUT_MS / 1000} seconds after it was removed.`
      );
      return;
    }
    if (removal.removed)
      report.did(
        `Removed the abandoned lock on ${config.deployRoleName}, held by ${lock.holder}`
      );
  } else {
    report.fail(
      `Removing the abandoned lock on ${config.deployRoleName}: ${removal.message}`
    );
  }
}

// --- The leftover check -----------------------------------------------------

/**
 * Everything of the AWS stage that is left, whatever its age. The check
 * deletes nothing. A read that fails is itself a finding, so the job fails
 * rather than passing on what it couldn't see.
 */
export async function findAwsLeftovers(
  config: AwsCleanupConfig,
  ports: AwsCleanupPorts
): Promise<{ findings: string[]; warnings: string[] }> {
  // A delete the sweep just made can take a moment to show, so findings get
  // a short while to clear. A wrong account is final.
  const deadline = ports.now() + LEFTOVER_SETTLE_MS;
  for (;;) {
    const result = await readAwsLeftovers(config, ports);
    if (
      result.findings.length === 0 ||
      result.wrongAccount ||
      ports.now() >= deadline
    )
      return { findings: result.findings, warnings: result.warnings };
    await ports.sleep(LEFTOVER_POLL_MS);
  }
}

async function readAwsLeftovers(
  config: AwsCleanupConfig,
  ports: AwsCleanupPorts
): Promise<{ findings: string[]; warnings: string[]; wrongAccount: boolean }> {
  const findings: string[] = [];
  const warnings: string[] = [];
  const check = async (what: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      findings.push(`Could not check ${what}: ${errorMessage(error)}`);
    }
  };
  await check("the AWS account", async () => {
    const account = await readCallerAccount(ports);
    if (account !== config.accountId)
      throw new Error(
        `AWS is signed in to account ${account || "(unknown)"}, not ${config.accountId}.`
      );
  });
  if (findings.length > 0) return { findings, warnings, wrongAccount: true };
  await check("RDS", async () => {
    for (const scope of await rdsScopes(config, ports)) {
      const footprint = await readRdsFootprint(ports, scope);
      findings.push(
        ...rdsLabels(scope.region, footprint).map((item) => item.label)
      );
      warnings.push(
        ...footprint.untaggedSnapshots.map(
          (id) =>
            `RDS DB snapshot ${id} in ${scope.region} has no environment tag`
        )
      );
    }
  });
  for (const cluster of config.clusters) {
    await check(`cluster ${cluster.name}`, async () => {
      for (const item of await readWorkloads(config, ports, cluster, ANY_AGE))
        findings.push(
          `${item.kind} ${item.namespace}/${item.name} on cluster ${cluster.name}`
        );
      if (await ports.kubernetes.namespaceExists(cluster, config.namespace))
        findings.push(
          `namespace ${config.namespace} on cluster ${cluster.name}`
        );
    });
  }
  // Everything under the repository's app path, whatever its tags say,
  // except what Radius's own cleanup tag marks as Radius's.
  const app = await readAppScope(config, ports);
  const scope = app.scope;
  if (scope === null) {
    findings.push(
      `Could not check app roles, Pod Identity associations, or app boundaries: ${app.message}`
    );
  } else {
    await check("app roles", async () => {
      findings.push(...(await appRoleLeftovers(ports, scope)));
    });
    for (const cluster of config.clusters) {
      await check(`Pod Identity associations on ${cluster.name}`, async () => {
        findings.push(...(await associationLeftovers(ports, scope, cluster)));
      });
    }
    await check("app permissions boundaries", async () => {
      for (const boundary of selectAppBoundaries(
        await readAws(ports, [
          "iam",
          "list-policies",
          "--scope",
          "Local",
          "--path-prefix",
          appPathRoot(scope.repositoryId)
        ]),
        scope
      ))
        findings.push(`permissions boundary ${boundary.arn}`);
    });
  }
  for (const name of AWS_MAIN_NODE_GROUPS) {
    await check(`node group ${name}`, async () => {
      const group = await readNodeGroup(ports, config.clusters[0], name);
      if (group.desiredSize > 0 || group.minSize > 0)
        findings.push(
          `node group ${name} on cluster ${config.clusters[0].name} at ${group.desiredSize} nodes`
        );
    });
  }
  await check(`the lock on ${config.deployRoleName}`, async () => {
    const lock = await readLock(config, ports);
    if (lock)
      findings.push(
        `lock ${lock.policyId} on ${config.deployRoleName}, held by ${lock.holder}`
      );
  });
  await check(`deploy role ${config.deployRoleName}`, async () => {
    const role = asRecord(
      asRecord(
        await readAws(ports, [
          "iam",
          "get-role",
          "--role-name",
          config.deployRoleName
        ])
      )?.Role
    );
    for (const subject of trustedGitHubSubjects(
      parsePolicyDocument(role?.AssumeRolePolicyDocument),
      config.accountId
    ))
      findings.push(`trust subject ${subject} on ${config.deployRoleName}`);
    const policies = asRecord(
      await readAws(ports, [
        "iam",
        "list-role-policies",
        "--role-name",
        config.deployRoleName
      ])
    )?.PolicyNames;
    if (!Array.isArray(policies))
      throw new Error("IAM returned no PolicyNames.");
    for (const name of policies)
      findings.push(`inline policy ${text(name)} on ${config.deployRoleName}`);
  });
  const roleArn = `arn:aws:iam::${config.accountId}:role/${config.deployRoleName}`;
  for (const cluster of config.clusters) {
    await check(`access entries on ${cluster.name}`, async () => {
      const result = await ports.runAws([
        "eks",
        "describe-access-entry",
        "--region",
        cluster.region,
        "--cluster-name",
        cluster.name,
        "--principal-arn",
        roleArn,
        "--output",
        "json"
      ]);
      if (succeeded(result))
        findings.push(
          `access entry for ${config.deployRoleName} on cluster ${cluster.name}`
        );
      else if (!awsError(result, "ResourceNotFoundException"))
        throw new Error(awsDetail(result));
    });
  }
  return { findings, warnings, wrongAccount: false };
}
