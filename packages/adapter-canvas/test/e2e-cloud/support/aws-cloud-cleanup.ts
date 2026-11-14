import {
  AWS_LOCK_REMOVABLE_AFTER_MS,
  AWS_REGION_PATTERN,
  awsLockPolicyArn,
  parseAwsLockHolder,
  parseAwsRoleArn,
  parsePolicyDocument,
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
//   2. Sweep the MySQL recipe's RDS resources and the Radius workloads that
//      are left.
//   3. Check nothing of that environment is left.
//   4. Only then remove its deployment records and GHCR state, and, under the
//      deploy role's lock, its trust subject, inline policy, and access entry
//      (with the product's own removal code) and its GitHub environment.
//
// If any of steps 1 to 3 fails, everything step 4 removes stays, so the next
// run can retry, and the sweep fails. The GitHub environment goes last: it is
// what makes a later sweep find the environment again.
//
// Every delete is limited to what the suite creates: in one of the two test
// regions, named the way the MySQL recipe names it, tagged with an AWS test
// environment, and in one of the two clusters' VPCs. Roles, the identity
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
export const NODE_GROUP_READY_TIMEOUT_MS = 15 * 60 * 1000;
export const WORKLOAD_GONE_TIMEOUT_MS = 5 * 60 * 1000;
const RDS_POLL_MS = 30 * 1000;
const NODE_GROUP_POLL_MS = 15 * 1000;
const WORKLOAD_POLL_MS = 10 * 1000;

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
  // `gh api --paginate --slurp repos/<repo>/environments` pages.
  listEnvironments(): Promise<unknown>;
  readEnvironmentVariables(
    environment: string
  ): Promise<Record<string, string>>;
  // Dispatch delete-application.yml and wait for it to succeed. Throws when
  // it can't be dispatched, found, or does not succeed.
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

function succeeded(result: AwsCommandResult): boolean {
  return result.code === 0 || result.code === "0";
}

function awsDetail(result: AwsCommandResult): string {
  return (result.stderr || result.stdout).trim() || `exit ${result.code}`;
}

function awsError(result: AwsCommandResult, code: string): boolean {
  return result.stderr.includes(`(${code})`);
}

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

// --- The sweep ------------------------------------------------------------

interface Target {
  readonly name: string;
  roleArn: string;
  region: string;
  cluster: string;
  trustSubjects: string[];
  // Why steps 1 to 3 keep this environment, or "" while nothing has.
  blocked: string;
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

class ReadFailure extends Error {}

async function readAws(
  ports: Pick<AwsCleanupPorts, "runAws">,
  args: string[]
): Promise<unknown> {
  const result = await ports.runAws([...args, "--output", "json"]);
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

async function waitFor(
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
async function rdsScopes(
  config: AwsCleanupConfig,
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

interface RdsFootprint {
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
async function readRdsFootprint(
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

function rdsLabels(
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
      args: ["delete-db-parameter-group", "--db-parameter-group-name"],
      notFound: "DBParameterGroupNotFound"
    })),
    ...footprint.subnetGroups.map((group) => ({
      ...group,
      kind: "subnet",
      args: ["delete-db-subnet-group", "--db-subnet-group-name"],
      notFound: "DBSubnetGroupNotFoundFault"
    }))
  ].filter((group) => sweepable(group.environment));
  for (const group of groups) {
    const [verb = "", name = ""] = group.args;
    const result = await ports.runAws([
      "rds",
      verb,
      "--region",
      region,
      name,
      group.name
    ]);
    if (succeeded(result) || awsError(result, group.notFound)) {
      report.did(
        `Deleted RDS DB ${group.kind} group ${group.name} in ${region}`
      );
    } else {
      report.fail(
        `Deleting RDS DB ${group.kind} group ${group.name} in ${region}: ${awsDetail(result)}`
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
        const listed = selectFinalSnapshots(
          await readAws(ports, [
            "rds",
            "describe-db-snapshots",
            "--region",
            region,
            "--snapshot-type",
            "manual"
          ]),
          scope
        ).tagged.find((item) => item.id === snapshot.id);
        status = listed?.status ?? "gone";
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
  if (status !== "available") {
    report.fail(
      `RDS DB snapshot ${snapshot.id} in ${region} is ${status}, and only an available snapshot can be deleted.`
    );
    return false;
  }
  const result = await ports.runAws([
    "rds",
    "delete-db-snapshot",
    "--region",
    region,
    "--db-snapshot-identifier",
    snapshot.id
  ]);
  if (succeeded(result) || awsError(result, "DBSnapshotNotFound")) {
    report.did(`Deleted RDS DB snapshot ${snapshot.id} in ${region}`);
    return true;
  }
  report.fail(
    `Deleting RDS DB snapshot ${snapshot.id} in ${region}: ${awsDetail(result)}`
  );
  return false;
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

/** What is left of each AWS test environment, by environment name. */
async function readFootprintByEnvironment(
  config: AwsCleanupConfig,
  ports: AwsCleanupPorts,
  scopes: readonly AwsRdsScope[]
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
  for (const cluster of config.clusters) {
    for (const item of await readWorkloads(config, ports, cluster, ANY_AGE))
      add(
        item.environment.toLowerCase(),
        `${item.kind} ${item.namespace}/${item.name} on cluster ${cluster.name}`
      );
  }
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
    blocked: ""
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
          blocked: `Could not read the variables of GitHub environment ${name}: ${errorMessage(error)}`
        });
      }
    }
  } catch (error) {
    report.fail(
      `Could not list the fixture's GitHub environments: ${errorMessage(error)}. No environment, RDS resource, or workload was deleted.`
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
        target.blocked = `Deleting the Radius application in ${target.name} failed: ${errorMessage(error)}`;
        report.fail(target.blocked);
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
    if (swept) {
      try {
        left = await readFootprintByEnvironment(config, ports, scopes);
      } catch (error) {
        report.fail(`Could not check what is left: ${errorMessage(error)}`);
        swept = false;
      }
    }
    for (const target of targets.filter((item) => !item.blocked)) {
      if (!swept) {
        target.blocked = `The RDS or workload sweep failed, so ${target.name} keeps its access and GitHub state for a retry.`;
      } else if (left.has(target.name.toLowerCase())) {
        target.blocked = `${target.name} still has ${left.get(target.name.toLowerCase())?.join(", ")}, so it keeps its access and GitHub state for a retry.`;
        report.fail(target.blocked);
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
  // A removal that kept something it couldn't check, such as an access entry
  // it couldn't read, is tried once more before the environment goes. After
  // that the environment goes anyway, as the product's delete does: a later
  // run could not sign in to delete the app again.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
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
          if (removal.warnings.length > 0 && attempt === 1) {
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
    if (!result.ok || !again) break;
  }
  if (!result.ok) {
    report.fail(
      `Removing ${target.name} from deploy role ${config.deployRoleName} failed, so its GitHub environment was kept: ${result.message} To finish by hand, see the AWS section of docs/eng/CLOUD_E2E_RUNBOOK.md.`
    );
    return;
  }
  if (result.lockWarning) report.warn(`${target.name}: ${result.lockWarning}`);
  for (const line of result.warnings) report.fail(`${target.name}: ${line}`);
  for (const line of result.kept) ports.log(`${target.name} kept ${line}`);
  if (result.removed.length > 0)
    report.did(
      `Removed from ${config.deployRoleName}: ${result.removed.join(", ")}`
    );
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
      if (group.desiredSize === 0 && group.minSize === 0) continue;
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
      const result = await ports.runAws([
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
  if (findings.length > 0) return { findings, warnings };
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
  return { findings, warnings };
}
