import {
  AWS_EKS_CLUSTER_ADMIN_POLICY_ARN,
  AWS_MANAGED_TAG,
  AWS_REPOSITORY_ID_TAG,
  AWS_REPOSITORY_TAG,
  buildAwsAppBoundaryPolicy,
  buildAwsAppRolesPolicy,
  buildAwsAppRolesPolicyName,
  buildEnvironmentSuffix,
  buildGitHubTrustPolicy,
  removeGitHubTrustSubject
} from "@radius-project/core";
import {
  awsAppBoundary,
  awsEnvironmentPolicyName,
  defaultAwsDeployRoleName
} from "../../../src/aws-deploy-role-name.js";
import { resolveOidcSubject } from "../../../src/azure-oidc.js";
import {
  ApplicationDeleteFailed,
  sweepAwsCloudE2E,
  findAwsLeftovers,
  statePackageName,
  type AwsCleanupConfig,
  type AwsCleanupGitHub,
  type AwsCleanupKubernetes,
  type AwsCleanupPorts,
  type AwsCleanupReport
} from "../../e2e-cloud/support/aws-cloud-cleanup.js";
import {
  createAwsCleanupAccessRemoval,
  readRepositoryId
} from "../../e2e-cloud/support/aws-cloud-cleanup-ports.js";
import {
  FakeAws,
  type FakeIamRole,
  type FakeManagedPolicy
} from "./fake-aws.js";
import { FakeGitHub } from "./fake-github.js";
import { FakeKubernetes } from "./fake-kubernetes.js";
import { MemoryDisk, OutsideWorld } from "./stop-points.js";

// The world the AWS Cloud E2E cleanup sweep runs against: the two test
// clusters, the fixture's deploy role, the fixture repository's environments,
// deployment records, and state packages, each environment's app boundary,
// app roles, and Pod Identity associations, and each cluster's workloads. The
// sweep's deploy-role removal is the product's own, composed as the workflow
// composes it, over the same fake AWS and GitHub. Every outside call goes
// through one OutsideWorld, so a test can stop the sweep at any of them.

export const ACCOUNT = "123456789012";
export const REPO = "radius-project/ai-extensions-fixture";
export const REPO_ID = 1361595003;
export const APPLICATION = "cloud-e2e";
export const NAMESPACE = "default-cloud-e2e";
export const PREFIX = "radtest-aws-";
export const MAIN = { region: "us-east-2", name: "ai-extensions-e2e-use2" };
export const SECOND = { region: "us-west-1", name: "ai-extensions-e2e-usw1" };
export const MAIN_VPC = "vpc-main";
export const SECOND_VPC = "vpc-second";
export const ROLE = defaultAwsDeployRoleName(REPO);
export const ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/${ROLE}`;
export const APP_ROLES_POLICY = buildAwsAppRolesPolicyName(REPO_ID);
// The fixture app's one container.
export const CONTAINER = "web";
const START = Date.parse("2026-11-14T02:23:00Z");
const DAY = 24 * 3600 * 1000;

export interface FakeDeploymentRecord {
  id: number;
  environment: string;
  created_at: string;
}

export interface FakePackage {
  name: string;
  visibility: string;
  repository: string;
  updated_at: string;
}

export interface CleanupScenario {
  readonly outside: OutsideWorld;
  readonly aws: FakeAws;
  readonly github: FakeGitHub;
  readonly kube: FakeKubernetes;
  readonly deployments: FakeDeploymentRecord[];
  readonly packages: Map<string, FakePackage>;
  readonly clock: { now: number };
  ports: AwsCleanupPorts;
  // How delete-application.yml behaves for each environment: "fail" ends
  // failed, "leave" succeeds but leaves the database, the app role, and its
  // Pod Identity association, as when Radius loses track, and `unfinished`
  // throws that error while its run keeps going until the next day.
  readonly appDelete: Map<string, AppDeleteBehavior>;
  // Runs still going, by environment, and the ones that then couldn't sign
  // in because the sweep had removed the access they needed.
  readonly runningDeletes: string[];
  readonly strandedDeletes: string[];
  readonly log: string[];
  // Each environment's trust subjects and cluster, as setup added them.
  readonly subjects: Map<string, string[]>;
  readonly clusters: Map<string, { region: string; name: string }>;
}

export type AppDeleteBehavior = "fail" | "leave" | { unfinished: string };

export function cleanupConfig(
  scenario: Pick<CleanupScenario, "clock">,
  maxAgeHours = 6
): AwsCleanupConfig {
  return {
    repository: REPO,
    application: APPLICATION,
    namespace: NAMESPACE,
    environmentPrefix: PREFIX,
    accountId: ACCOUNT,
    clusters: [MAIN, SECOND],
    deployRoleName: ROLE,
    cutoff: new Date(
      scenario.clock.now - maxAgeHours * 3600 * 1000
    ).toISOString(),
    operationId: "cloud-e2e-cleanup-77"
  };
}

function clusterKey(cluster: { region: string; name: string }): string {
  return `${cluster.region}/${cluster.name}`;
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

export function environmentId(name: string): string {
  return `/planes/radius/local/resourcegroups/default/providers/Radius.Core/environments/${name}`;
}

export function recipeTags(environment: string) {
  return [
    {
      Key: "radapp.io/application",
      Value: `/planes/radius/local/resourcegroups/default/providers/Radius.Core/applications/${APPLICATION}`
    },
    { Key: "radapp.io/environment", Value: environmentId(environment) },
    {
      Key: "radapp.io/resource",
      Value: `/planes/radius/local/resourcegroups/default/providers/Radius.Data/mySqlDatabases/db`
    }
  ];
}

export function databaseName(environment: string): string {
  return `mysql-${environment.slice(PREFIX.length).replace(/[^a-z0-9]/g, "")}`;
}

/** The containers Recipe's tags on a container's app role and association. */
export function containerTags(environment: string): Record<string, string> {
  return {
    "radapp.io/application": `/planes/radius/local/resourcegroups/default/providers/Radius.Core/applications/${APPLICATION}`,
    "radapp.io/environment": environmentId(environment),
    "radapp.io/resource": `/planes/radius/local/resourcegroups/default/providers/Radius.Compute/containers/${CONTAINER}`
  };
}

export function tagList(tags: Record<string, string>) {
  return Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
}

/**
 * The containers Recipe's role name: `take('radius-app-<name>', 50)`, a dash,
 * and a 13-character uniqueString, here made from the environment's name.
 */
export function appRoleName(environment: string): string {
  const unique = environment
    .slice(PREFIX.length)
    .replace(/[^a-z0-9]/g, "")
    .padEnd(13, "0")
    .slice(0, 13);
  return `radius-app-${CONTAINER}-${unique}`;
}

/** The environment's app boundary, as setup names it. */
export function appBoundary(environment: string) {
  return awsAppBoundary(ACCOUNT, REPO_ID, environment);
}

/**
 * The deploy role's trust policy for `subjects`, as setup and delete leave it.
 * With none, it is the single deny statement the product writes when the
 * last environment goes.
 */
export function deployRoleTrust(subjects: readonly string[]): unknown {
  if (subjects.length > 0) return buildGitHubTrustPolicy(ACCOUNT, subjects);
  const last = `repo:${REPO}:environment:last`;
  return removeGitHubTrustSubject(
    buildGitHubTrustPolicy(ACCOUNT, [last]),
    ACCOUNT,
    last
  ).policy;
}

function rebuildTrust(scenario: CleanupScenario): void {
  const role = scenario.aws.role(ROLE);
  if (!role) throw new Error("The scenario's deploy role is missing.");
  role.AssumeRolePolicyDocument = deployRoleTrust(
    [...scenario.subjects.values()].flat()
  );
}

function githubPort(scenario: CleanupScenario): AwsCleanupGitHub {
  const { outside, github } = scenario;
  return {
    // As the workflow's port reads it: `gh api repos/<repo>`.
    readRepositoryId: () => readRepositoryId(outside.readGitHubJson, REPO),
    listEnvironments: () =>
      outside.outside("GET environments", false, () => [
        {
          total_count: github.environments.size,
          environments: [...github.environments.values()].map((item) => ({
            name: item.name,
            id: item.id,
            created_at: item.createdAt
          }))
        }
      ]),
    readEnvironmentVariables: (environment) =>
      outside.outside(`GET ${environment} variables`, false, () => {
        const found = github.environment(environment);
        if (!found) throw new Error(`HTTP 404 for ${environment}`);
        return Object.fromEntries(found.variables);
      }),
    deleteApplication: (environment, application) =>
      outside.outside(
        `dispatch delete-application ${environment}`,
        true,
        () => {
          if (application !== APPLICATION)
            throw new Error(`Unexpected application ${application}`);
          const behavior = scenario.appDelete.get(environment);
          // As the port does, a run that ended, failed or not, while an
          // earlier one for the environment is still going doesn't count.
          if (
            typeof behavior !== "object" &&
            scenario.runningDeletes.includes(environment)
          )
            throw new Error(
              `delete-application.yml run 9 ${behavior === "fail" ? "ended failure" : "succeeded"}. Run 8 for ${environment} is still going.`
            );
          if (behavior === "fail")
            throw new ApplicationDeleteFailed(
              "delete-application.yml run 9 ended failure."
            );
          if (typeof behavior === "object") {
            scenario.runningDeletes.push(environment);
            throw new Error(behavior.unfinished);
          }
          // The delete workflow signs in as the deploy role through the
          // environment's trust subject and acts with its inline policy.
          if (!canSignIn(scenario, environment))
            throw new ApplicationDeleteFailed(
              "delete-application.yml run 9 ended failure: Could not assume the deploy role."
            );
          // Cloud Control deletes the app role with the deploy role's
          // app-roles policy.
          if (
            scenario.aws.role(appRoleName(environment)) &&
            !scenario.aws.role(ROLE)?.inline.has(APP_ROLES_POLICY)
          )
            throw new ApplicationDeleteFailed(
              "delete-application.yml run 9 ended failure: AccessDenied for iam:DeleteRole."
            );
          deleteApplication(scenario, environment, behavior === "leave");
        }
      ),
    listDeployments: () =>
      outside.outside("GET deployments", false, () => [
        scenario.deployments.map((item) => ({ ...item }))
      ]),
    deleteDeployment: (id) =>
      outside.outside(`DELETE deployment ${id}`, true, () => {
        const index = scenario.deployments.findIndex((item) => item.id === id);
        if (index >= 0) scenario.deployments.splice(index, 1);
      }),
    listPackages: () =>
      outside.outside("GET packages", false, () => [
        [...scenario.packages.values()].map((item) => ({ ...item }))
      ]),
    deletePackage: (name) =>
      outside.outside(`DELETE package ${name}`, true, () =>
        scenario.packages.delete(name) ? "deleted" : "absent"
      ),
    deleteEnvironment: (environment) =>
      outside.outside(`DELETE environment ${environment}`, true, () => {
        github.deleteEnvironment(environment);
      })
  };
}

function kubernetesPort(scenario: CleanupScenario): AwsCleanupKubernetes {
  const { outside, kube } = scenario;
  return {
    listWorkloads: (cluster) =>
      outside.outside(`kubectl get workloads ${cluster.name}`, false, () =>
        kube.list(clusterKey(cluster))
      ),
    deleteWorkload: (cluster, workload) =>
      outside.outside(
        `kubectl delete ${workload.kind} ${workload.name} ${cluster.name}`,
        true,
        () =>
          kube.delete(
            clusterKey(cluster),
            workload.kind,
            workload.name,
            workload.namespace
          )
      ),
    namespaceExists: (cluster, namespace) =>
      outside.outside(`kubectl get namespace ${cluster.name}`, false, () =>
        kube.namespaceExists(clusterKey(cluster), namespace)
      ),
    deleteNamespace: (cluster, namespace) =>
      outside.outside(`kubectl delete namespace ${cluster.name}`, true, () =>
        kube.deleteNamespace(clusterKey(cluster), namespace)
      )
  };
}

/**
 * What delete-application.yml does for an environment: Cloud Control deletes
 * the database with a final snapshot that carries its tags, and the
 * container's Pod Identity association and app role, and Radius deletes the
 * workloads it rendered.
 */
function deleteApplication(
  scenario: CleanupScenario,
  environment: string,
  leave: boolean
): void {
  const variables = scenario.github.environment(environment)?.variables;
  const region = variables?.get("AWS_REGION") ?? "";
  const cluster = variables?.get("AWS_EKS_CLUSTER_NAME") ?? "";
  const name = databaseName(environment);
  const rds = scenario.aws.rds;
  const instance = rds.instances.get(`${region}:${name}`);
  if (instance && !leave) {
    rds.addSnapshot({
      id: `rds-snapshot-${name}`,
      region,
      instanceId: name,
      vpcId: instance.vpcId,
      tags: instance.tags
    });
    rds.instances.delete(`${region}:${name}`);
    rds.subnetGroups.delete(`${region}:${name}`);
    rds.parameterGroups.delete(`${region}:${name}`);
  }
  const appRole = scenario.aws.role(appRoleName(environment));
  if (appRole && !leave) {
    const podIdentity = scenario.aws.clusters.get(
      `${region}:${cluster}`
    )?.podIdentity;
    for (const [id, item] of podIdentity ?? [])
      if (item.roleArn === appRole.Arn) podIdentity?.delete(id);
    scenario.aws.roles.delete(appRole.RoleName.toLowerCase());
  }
  for (const item of JSON.parse(
    JSON.stringify(scenario.kube.list(`${region}/${cluster}`))
  ).items as Array<{ kind: string; metadata: Record<string, any> }>) {
    if (item.metadata.labels["radapp.io/environment"] === environment)
      scenario.kube.delete(
        `${region}/${cluster}`,
        item.kind,
        item.metadata.name,
        item.metadata.namespace
      );
  }
}

// A new process's ports: nothing a crashed run cached carries over.
function createPorts(scenario: CleanupScenario): AwsCleanupPorts {
  const { outside, github, clock, log } = scenario;
  const sleep = async (milliseconds: number) => {
    clock.now += milliseconds;
  };
  return {
    runAws: outside.runAws,
    github: githubPort(scenario),
    kubernetes: kubernetesPort(scenario),
    removeAccess: createAwsCleanupAccessRemoval({
      repository: REPO,
      runAws: outside.runAws,
      runGitHubJson: outside.readGitHubJson,
      // The production ports answer a failed read with ok: false.
      environments: {
        listEnvironmentNames: (repo) =>
          outside
            .outside(`GET /repos/${repo}/environments`, false, () => ({
              ok: true as const,
              names: [...github.environments.values()].map(({ name }) => name)
            }))
            .catch((error: Error) => ({
              ok: false as const,
              reason: error.message
            })),
        readEnvironmentVariables: (repo, name) =>
          outside
            .outside(
              `GET /repos/${repo}/environments/${name}/variables`,
              false,
              () => {
                const found = github.environment(name);
                return found ?
                    {
                      ok: true as const,
                      variables: Object.fromEntries(found.variables)
                    }
                  : { ok: false as const, reason: "HTTP 404" };
              }
            )
            .catch((error: Error) => ({
              ok: false as const,
              reason: error.message
            }))
      },
      sleep,
      now: () => clock.now
    }),
    sleep,
    now: () => clock.now,
    log: (line: string) => log.push(line)
  };
}

/** The two clusters, the deploy role with no environment, and nothing else. */
export function createCleanupScenario(): CleanupScenario {
  const clock = { now: START };
  const aws = new FakeAws({
    accountId: ACCOUNT,
    now: () => (clock.now += 1000)
  });
  aws.iamSettleMs = 10_000;
  aws.addCluster(MAIN.name, MAIN.region, "API", MAIN_VPC);
  aws.addCluster(SECOND.name, SECOND.region, "API", SECOND_VPC);
  aws.addNodegroup(MAIN.region, MAIN.name, "default", {
    minSize: 0,
    maxSize: 2,
    desiredSize: 0
  });
  aws.addNodegroup(MAIN.region, MAIN.name, "isolated", {
    minSize: 0,
    maxSize: 1,
    desiredSize: 0
  });
  aws.addGitHubProvider();
  aws.addRole({
    name: ROLE,
    trust: deployRoleTrust([]),
    tags: [
      { Key: "radius-managed", Value: "true" },
      { Key: "radius-repository", Value: REPO },
      { Key: "radius-repository-id", Value: String(REPO_ID) }
    ]
  });
  const github = new FakeGitHub(REPO, REPO_ID, 7);
  const kube = new FakeKubernetes();
  for (const cluster of [MAIN, SECOND]) kube.addCluster(clusterKey(cluster));
  const outside = new OutsideWorld(aws, github, new MemoryDisk());
  const log: string[] = [];
  const scenario = {
    outside,
    aws,
    github,
    kube,
    deployments: [],
    packages: new Map(),
    clock,
    appDelete: new Map(),
    runningDeletes: [],
    strandedDeletes: [],
    log,
    subjects: new Map(),
    clusters: new Map(),
    ports: undefined as never
  } as CleanupScenario;
  scenario.ports = createPorts(scenario);
  return scenario;
}

export interface AwsEnvironmentOptions {
  readonly cluster?: "main" | "second";
  // Hours before the sweep starts.
  readonly ageHours?: number;
  // Deployed: a database, its workloads, a deployment record, and state.
  readonly deployed?: boolean;
  // A role outside the app path that still uses the environment's app
  // boundary. The sweep doesn't own it, so IAM keeps refusing to delete the
  // boundary.
  readonly appRoleKeepsBoundary?: boolean;
}

/**
 * An AWS environment as setup and a deploy leave it: the GitHub environment
 * and its variables, the role's trust subjects, inline policy, and the
 * repository's app-roles policy, the environment's app boundary, and the
 * cluster's access entry, and, once deployed, the recipe's database, the
 * container's app role and Pod Identity association, the app's workloads, a
 * deployment record, and the state package.
 */
export async function addAwsEnvironment(
  scenario: CleanupScenario,
  name: string,
  options: AwsEnvironmentOptions = {}
): Promise<void> {
  const cluster = options.cluster === "second" ? SECOND : MAIN;
  const vpc = options.cluster === "second" ? SECOND_VPC : MAIN_VPC;
  const created = iso(
    scenario.clock.now - (options.ageHours ?? 30) * 3600 * 1000
  );
  const oidc = await resolveOidcSubject(
    {
      targetRepo: REPO,
      envName: name,
      suffix: buildEnvironmentSuffix(name)
    },
    async (apiPath) => scenario.github.readJson(apiPath)
  );
  const subjects = oidc.federatedCredentials.map((item) => item.subject);
  scenario.subjects.set(name, subjects);
  scenario.clusters.set(name, cluster);
  rebuildTrust(scenario);
  scenario.aws.role(ROLE)?.inline.set(awsEnvironmentPolicyName(REPO_ID, name), {
    Version: "2012-10-17",
    Statement: []
  });
  scenario.aws
    .role(ROLE)
    ?.inline.set(APP_ROLES_POLICY, buildAwsAppRolesPolicy(ACCOUNT, REPO_ID));
  if (!scenario.aws.policies.has(appBoundary(name).arn))
    addAppBoundary(scenario, name, cluster.region);
  if (options.appRoleKeepsBoundary)
    scenario.aws.addRole({
      name: `radius-app-web-${name}`,
      trust: { Version: "2012-10-17", Statement: [] },
      boundary: appBoundary(name).arn
    });
  const entries = scenario.aws.clusters.get(
    `${cluster.region}:${cluster.name}`
  )?.entries;
  if (!entries?.has(ROLE_ARN))
    scenario.aws.addAccessEntry(
      cluster.region,
      cluster.name,
      ROLE_ARN,
      { "radius-managed": "true", "radius-operation": `op-${name}` },
      [AWS_EKS_CLUSTER_ADMIN_POLICY_ARN]
    );
  const environment = scenario.github.addEnvironment(name, {
    AWS_ROLE_ARN: ROLE_ARN,
    AWS_REGION: cluster.region,
    AWS_ACCOUNT_ID: ACCOUNT,
    AWS_EKS_CLUSTER_NAME: cluster.name,
    AWS_TRUST_SUBJECTS: JSON.stringify(subjects),
    RADIUS_MANAGED: "true",
    KUBERNETES_NAMESPACE: "default"
  });
  environment.createdAt = created;
  scenario.kube.addNamespace(clusterKey(cluster), NAMESPACE);
  if (!options.deployed) return;
  scenario.aws.rds.addRecipeDatabase({
    name: databaseName(name),
    region: cluster.region,
    vpcId: vpc,
    tags: recipeTags(name)
  });
  const appRole = addAppRole(scenario, name);
  scenario.aws.addPodIdentityAssociation(cluster.region, cluster.name, {
    namespace: NAMESPACE,
    serviceAccount: `radius-app-${CONTAINER}`,
    roleArn: appRole.Arn,
    tags: containerTags(name)
  });
  scenario.kube.addWorkload(clusterKey(cluster), {
    kind: "Deployment",
    name: "web",
    namespace: NAMESPACE,
    labels: {
      "radapp.io/environment": name,
      "radapp.io/application": APPLICATION
    },
    creationTimestamp: created
  });
  scenario.deployments.push({
    id: 1000 + scenario.deployments.length,
    environment: name,
    created_at: created
  });
  const statePackage = statePackageName(REPO, name);
  scenario.packages.set(statePackage, {
    name: statePackage,
    visibility: "private",
    repository: REPO,
    updated_at: created
  });
}

// The environment's app boundary, as setup creates it.
function addAppBoundary(
  scenario: CleanupScenario,
  environment: string,
  region: string
): FakeManagedPolicy {
  const boundary = appBoundary(environment);
  return scenario.aws.addManagedPolicy({
    path: boundary.path,
    name: boundary.name,
    document: buildAwsAppBoundaryPolicy(ACCOUNT, region),
    tags: [
      { Key: AWS_MANAGED_TAG, Value: "true" },
      { Key: AWS_REPOSITORY_TAG, Value: REPO },
      { Key: AWS_REPOSITORY_ID_TAG, Value: String(REPO_ID) }
    ]
  });
}

export const POD_IDENTITY_TRUST = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "pods.eks.amazonaws.com" },
      Action: ["sts:AssumeRole", "sts:TagSession"]
    }
  ]
};

// The container's app role, as the containers Recipe creates it.
function addAppRole(
  scenario: CleanupScenario,
  environment: string
): FakeIamRole {
  const boundary = appBoundary(environment);
  return scenario.aws.addRole({
    name: appRoleName(environment),
    trust: POD_IDENTITY_TRUST,
    path: boundary.path,
    boundary: boundary.arn,
    tags: tagList(containerTags(environment)),
    inline: { connections: { Version: "2012-10-17", Statement: [] } }
  });
}

/**
 * What an environment deleted a week ago left when its app delete lost track
 * of its app role: the role, and the app boundary it still uses.
 */
export function addOrphanedAppRole(
  scenario: CleanupScenario,
  environment: string
): FakeIamRole {
  addAppBoundary(scenario, environment, MAIN.region).CreateDate = iso(
    scenario.clock.now - 7 * DAY
  );
  return addAppRole(scenario, environment);
}

/**
 * An app role in the environment's folder without the Recipe's environment
 * tag, as when Cloud Control made the role but its tags didn't apply. The
 * sweep can't tie it to the environment, so it keeps it, and the environment
 * keeps everything step 4 removes while it is there.
 */
export function addUntaggedAppRole(
  scenario: CleanupScenario,
  environment: string
): FakeIamRole {
  return scenario.aws.addRole({
    name: `radius-app-untagged-${environment.slice(PREFIX.length)}`,
    trust: POD_IDENTITY_TRUST,
    path: appBoundary(environment).path
  });
}

/** Run the sweep once, as one scheduled cleanup run does. */
export function runSweep(
  scenario: CleanupScenario,
  maxAgeHours = 6
): Promise<AwsCleanupReport> {
  return sweepAwsCloudE2E(cleanupConfig(scenario, maxAgeHours), scenario.ports);
}

/** The leftover check, as the job's last step runs it. */
export function runVerify(scenario: CleanupScenario) {
  return findAwsLeftovers(cleanupConfig(scenario), scenario.ports);
}

// The delete workflow signs in as the deploy role through the environment's
// trust subject and acts with its inline policy.
function canSignIn(scenario: CleanupScenario, environment: string): boolean {
  const access = retryInputs(scenario, environment);
  return (
    access.includes("policy") &&
    access.some((item) => item.startsWith("trust "))
  );
}

/**
 * The next day's run: a new process, a day later. Each delete run still going
 * has ended by then, and records whether it could still sign in.
 */
export function nextDay(scenario: CleanupScenario): void {
  for (const environment of scenario.runningDeletes.splice(0))
    if (!canSignIn(scenario, environment))
      scenario.strandedDeletes.push(environment);
  scenario.outside.startProcess();
  scenario.ports = createPorts(scenario);
  scenario.clock.now += DAY;
  scenario.aws.settle();
  scenario.kube.settle();
}

/** What one environment still has that a retry of its cleanup needs. */
export function retryInputs(scenario: CleanupScenario, name: string): string[] {
  const role = scenario.aws.role(ROLE);
  const trust = JSON.stringify(role?.AssumeRolePolicyDocument ?? {});
  const cluster = scenario.clusters.get(name);
  return [
    scenario.github.environment(name) ? "GitHub environment" : "",
    ...(scenario.subjects.get(name) ?? []).map((subject) =>
      trust.includes(subject) ? `trust ${subject}` : ""
    ),
    role?.inline.has(awsEnvironmentPolicyName(REPO_ID, name)) ? "policy" : "",
    scenario.aws.policies.has(appBoundary(name).arn) ? "boundary" : "",
    (
      scenario.aws.clusters
        .get(`${cluster?.region}:${cluster?.name}`)
        ?.entries.has(ROLE_ARN)
    ) ?
      "access entry"
    : "",
    scenario.packages.has(statePackageName(REPO, name)) ? "state" : ""
  ].filter(Boolean);
}

/** The app resources one environment still has in AWS and Kubernetes. */
export function appResources(
  scenario: CleanupScenario,
  name: string
): string[] {
  const tag = environmentId(name);
  const rds = scenario.aws.rds;
  // A resource with Radius's cleanup tag is Radius's, whatever else it says.
  const tagged = (tags: Array<{ Key: string; Value: string }>) =>
    tags.some((item) => item.Value === tag) &&
    !tags.some((item) => item.Key === "RadiusCreationTimestamp");
  // App roles are the environment's only in its folder of the fixture
  // repository's app path.
  const folder = `arn:aws:iam::${ACCOUNT}:role${appBoundary(name).path}`;
  return [
    ...[...rds.instances.values()]
      .filter((item) => tagged(item.tags))
      .map((item) => `instance ${item.id}`),
    ...[...rds.subnetGroups.values()]
      .filter((item) => tagged(item.tags))
      .map((item) => `subnet group ${item.name}`),
    ...[...rds.parameterGroups.values()]
      .filter((item) => tagged(item.tags))
      .map((item) => `parameter group ${item.name}`),
    ...[...rds.snapshots.values()]
      .filter((item) => tagged(item.tags))
      .map((item) => `snapshot ${item.id}`),
    ...[...scenario.aws.roles.values()]
      .filter((item) => item.Arn.startsWith(folder) && tagged(item.Tags))
      .map((item) => `app role ${item.RoleName}`),
    ...[...scenario.aws.clusters.values()].flatMap((cluster) =>
      [...cluster.podIdentity.values()]
        .filter(
          (item) =>
            item.roleArn.startsWith(folder) && tagged(tagList(item.tags))
        )
        .map(
          (item) =>
            `${cluster.name} association ${item.namespace}/${item.serviceAccount}`
        )
    ),
    ...[...scenario.kube.clusters].flatMap(([key, cluster]) =>
      cluster.workloads
        .filter((item) => item.labels["radapp.io/environment"] === name)
        .map((item) => `${key} ${item.kind} ${item.namespace}/${item.name}`)
    )
  ];
}
