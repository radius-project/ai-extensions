import {
  awsLockHolderLabel,
  awsLockPolicyArn,
  awsRoleArn,
  awsRoleTags,
  buildGitHubTrustPolicy,
  parseAwsLockHolder,
  parseAwsRoleArn,
  parsePolicyDocument,
  removeGitHubTrustSubject,
  stateRegistryForEnvironment,
  trustedGitHubSubjects
} from "@radius-project/core";
import { defaultAwsDeployRoleName } from "../../../src/aws-deploy-role-name.js";
import {
  appRoleLeftovers,
  associationLeftovers,
  AWS_MAIN_NODE_GROUPS,
  awsDetail,
  awsError,
  RADIUS_TEST_REGION,
  rdsLabels,
  rdsScopes,
  readAws,
  readRdsFootprint,
  succeeded,
  type AwsCleanupCluster,
  type AwsCleanupKubernetes
} from "./aws-cloud-cleanup.js";
import { checkAwsFootprint } from "./aws-footprint.js";
import {
  asRecord,
  clusterLabel,
  list,
  text,
  type AwsJourneyPorts
} from "./aws-journey-support.js";
import {
  NODE_POOL_LABEL,
  readAwsCluster,
  readAwsNodeGroup,
  createAwsNodeGroupRun,
  type AwsNodeGroupPorts
} from "./aws-node-groups.js";
import { selectLeakedClusterWorkloads } from "./cloud-cleanup.js";
import {
  describeError,
  expectSuccess,
  type CloudFixturePorts
} from "./cloud-command-port.js";
import {
  AWS_ENVIRONMENT_NAME_PREFIX,
  FIXTURE_APPLICATION_NAME,
  FIXTURE_AWS_BASELINE_SHA,
  FIXTURE_BASELINE_SHA,
  FIXTURE_RADIUS_ENVIRONMENT_NAMESPACE,
  FIXTURE_REPO_DEFAULT_BRANCH,
  FIXTURE_REPOSITORY,
  shortenUniqueId
} from "./fixture-repository.js";
import {
  acquireFixtureLease,
  cloneFixtureAtBaseline,
  collectGitHubLeakedState,
  fixtureLeaseOwner,
  moveDefaultBranchToBaseline,
  unwindAll,
  type GitHubFixtureRepository,
  type UnwindStep
} from "./github-fixture.js";

// The AWS Cloud E2E run's fixture. Its GitHub side is the shared fixture
// repository's (github-fixture.ts): the lease, the clone at the AWS baseline,
// the clean-slate check, and teardown. Its AWS side is the preflight the
// design's first stage runs before any write: the account, both clusters,
// the isolated node group, the deploy role setup reuses, and nothing left
// from an earlier run. Only when all of it passes does the run move the
// default branch to its baseline and start the node groups.

/** The permissions boundary an administrator puts on the deploy role. */
export const AWS_DEPLOY_ROLE_BOUNDARY_NAME =
  "ai-extensions-cloud-e2e-deploy-boundary";
export const POD_IDENTITY_AGENT_ADDON = "eks-pod-identity-agent";
export const ISOLATED_TAINT = {
  key: "radius-e2e/isolated",
  value: "true",
  effect: "NO_SCHEDULE"
} as const;

const RUNBOOK = "the AWS one-time setup in docs/eng/CLOUD_E2E_RUNBOOK.md";
const CLEANUP =
  "Run the Cloud E2E cleanup workflow (cloud-e2e-cleanup.yml), which removes what an earlier run left.";
// A cutoff in the future selects every workload, whatever its age.
const ANY_AGE = "9999-12-31T23:59:59Z";

export interface AwsPreflightConfig {
  readonly accountId: string;
  readonly repository: string;
  readonly repositoryId: number;
  readonly deployRoleName: string;
  // The main cluster first: it has the node groups.
  readonly clusters: readonly [AwsCleanupCluster, AwsCleanupCluster];
  readonly application: string;
  readonly namespace: string;
  readonly environmentPrefix: string;
}

export interface AwsPreflightPorts extends Pick<
  AwsJourneyPorts,
  "runAws" | "sleep" | "now"
> {
  readonly kubernetes: Pick<
    AwsCleanupKubernetes,
    "listWorkloads" | "namespaceExists"
  >;
}

// A JSON value with its object keys sorted, so two policies compare by content.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonical(record[key])])
  );
}

function tagValue(tags: Record<string, string>, key: string): string {
  const match = Object.keys(tags).find((name) => name.toLowerCase() === key);
  return match === undefined ? "" : tags[match];
}

async function clusterFindings(
  ports: AwsPreflightPorts,
  cluster: AwsCleanupCluster
): Promise<string[]> {
  const name = clusterLabel(cluster);
  const update = `aws eks update-cluster-config --name ${cluster.name} --region ${cluster.region}`;
  const state = await readAwsCluster(ports, cluster);
  const findings: string[] = [];
  if (state.status !== "ACTIVE")
    findings.push(
      `Cluster ${name} is ${state.status || "in an unknown state"}, not ACTIVE. Retry when it is ACTIVE.`
    );
  if (state.authenticationMode !== "API")
    findings.push(
      `Cluster ${name} uses authentication mode ${state.authenticationMode}, not API. Switch it: ${update} --access-config authenticationMode=API`
    );
  if (!state.endpointPublicAccess)
    findings.push(
      `Cluster ${name} has no public API endpoint, so GitHub-hosted runners can't reach it. Turn it on: ${update} --resources-vpc-config endpointPublicAccess=true`
    );
  if (state.supportType !== "STANDARD")
    findings.push(
      `Cluster ${name} has upgrade policy ${state.supportType || "(none)"}, not STANDARD, so it would move to extended support, which costs six times as much. Set it: ${update} --upgrade-policy supportType=STANDARD`
    );
  // The product's rule: UPDATING keeps the running agent until its
  // replacement is ready.
  const addon = await ports.runAws([
    "eks",
    "describe-addon",
    "--cluster-name",
    cluster.name,
    "--addon-name",
    POD_IDENTITY_AGENT_ADDON,
    "--region",
    cluster.region,
    "--output",
    "json"
  ]);
  if (awsError(addon, "ResourceNotFoundException"))
    findings.push(
      `Cluster ${name} doesn't have the ${POD_IDENTITY_AGENT_ADDON} add-on, which gives app containers their AWS permissions. Install it: aws eks create-addon --cluster-name ${cluster.name} --addon-name ${POD_IDENTITY_AGENT_ADDON} --region ${cluster.region}`
    );
  else if (!succeeded(addon))
    throw new Error(`aws eks describe-addon: ${awsDetail(addon)}`);
  else {
    const status = text(
      asRecord(asRecord(JSON.parse(addon.stdout))?.addon)?.status
    );
    if (status !== "ACTIVE" && status !== "UPDATING")
      findings.push(
        `The ${POD_IDENTITY_AGENT_ADDON} add-on on cluster ${name} is ${status || "in an unknown state"}, not ACTIVE or UPDATING. Fix it in the EKS console, then retry.`
      );
  }
  return findings;
}

async function secondClusterFindings(
  ports: AwsPreflightPorts,
  cluster: AwsCleanupCluster
): Promise<string[]> {
  const groups = list(
    asRecord(
      await readAws(ports, [
        "eks",
        "list-nodegroups",
        "--region",
        cluster.region,
        "--cluster-name",
        cluster.name
      ])
    )?.nodegroups
  ).map(text);
  return groups.length === 0 ?
      []
    : [
        `Cluster ${clusterLabel(cluster)} has node groups ${groups.join(", ")}, but the second cluster must have none: its deploy fails before any pod is scheduled. Delete them; see ${RUNBOOK}.`
      ];
}

async function nodeGroupFindings(
  ports: AwsPreflightPorts,
  cluster: AwsCleanupCluster
): Promise<string[]> {
  const where = `on cluster ${clusterLabel(cluster)}`;
  const findings: string[] = [];
  for (const name of AWS_MAIN_NODE_GROUPS) {
    const group = await readAwsNodeGroup(ports, cluster, name);
    if (group.desiredSize > 0 || group.minSize > 0)
      findings.push(
        `Node group ${name} ${where} is at ${group.desiredSize} nodes (minimum ${group.minSize}), left from an earlier run. Run the Cloud E2E cleanup workflow, which scales it to zero.`
      );
    if (group.labels[NODE_POOL_LABEL] !== name)
      findings.push(
        `Node group ${name} ${where} has label ${NODE_POOL_LABEL}=${group.labels[NODE_POOL_LABEL] ?? "(none)"}, not ${name}, so the connection probe can't select its nodes. Fix it: aws eks update-nodegroup-config --cluster-name ${cluster.name} --nodegroup-name ${name} --region ${cluster.region} --labels 'addOrUpdateLabels={${NODE_POOL_LABEL}=${name}}'`
      );
    if (name !== "isolated") continue;
    if (
      !group.taints.some(
        (taint) =>
          taint.key === ISOLATED_TAINT.key &&
          taint.value === ISOLATED_TAINT.value &&
          taint.effect === ISOLATED_TAINT.effect
      )
    )
      findings.push(
        `Node group ${name} ${where} has no ${ISOLATED_TAINT.key}=${ISOLATED_TAINT.value}:NoSchedule taint, so app pods could run on the isolated node. Add it: aws eks update-nodegroup-config --cluster-name ${cluster.name} --nodegroup-name ${name} --region ${cluster.region} --taints 'addOrUpdateTaints=[{key=${ISOLATED_TAINT.key},value=${ISOLATED_TAINT.value},effect=${ISOLATED_TAINT.effect}}]'`
      );
    findings.push(...(await isolationFindings(ports, cluster, group)));
  }
  return findings;
}

// The isolated node must not be in the cluster security group, or nothing
// stops it reaching the database and the isolated probe proves nothing.
async function isolationFindings(
  ports: AwsPreflightPorts,
  cluster: AwsCleanupCluster,
  group: Awaited<ReturnType<typeof readAwsNodeGroup>>
): Promise<string[]> {
  const where = `node group ${group.name} on cluster ${clusterLabel(cluster)}`;
  const fix = `Recreate it with its own security group (step 2 of ${RUNBOOK}).`;
  if (!group.launchTemplate)
    return [
      `${where} has no launch template, so EKS puts its node in the cluster security group and the isolated probe would connect. ${fix}`
    ];
  const { clusterSecurityGroupId } = await readAwsCluster(ports, cluster);
  const template = `Launch template ${group.launchTemplate.id} version ${group.launchTemplate.version} of ${where}`;
  const [version] = list(
    asRecord(
      await readAws(ports, [
        "ec2",
        "describe-launch-template-versions",
        "--region",
        cluster.region,
        "--launch-template-id",
        group.launchTemplate.id,
        "--versions",
        group.launchTemplate.version
      ])
    )?.LaunchTemplateVersions
  ).map((item) => asRecord(asRecord(item)?.LaunchTemplateData));
  const groups = [
    ...list(version?.SecurityGroupIds),
    ...list(version?.NetworkInterfaces).flatMap((item) =>
      list(asRecord(item)?.Groups)
    )
  ].map(text);
  if (groups.length === 0)
    return [
      `${template} sets no security group, so EKS puts the node in the cluster security group and the isolated probe would connect. ${fix}`
    ];
  if (!clusterSecurityGroupId)
    throw new Error(
      `EKS reported no cluster security group for cluster ${clusterLabel(cluster)}.`
    );
  return groups.includes(clusterSecurityGroupId) ?
      [
        `${template} puts the node in the cluster security group ${clusterSecurityGroupId}, so the isolated probe would connect. ${fix}`
      ]
    : [];
}

async function deployRoleFindings(
  config: AwsPreflightConfig,
  ports: AwsPreflightPorts
): Promise<string[]> {
  const roleName = config.deployRoleName;
  const role = `Deploy role ${roleName}`;
  const read = await ports.runAws([
    "iam",
    "get-role",
    "--role-name",
    roleName,
    "--output",
    "json"
  ]);
  if (awsError(read, "NoSuchEntity"))
    return [
      `${role} doesn't exist in account ${config.accountId}. An administrator creates it once (step 4 of ${RUNBOOK}); the test role can't.`
    ];
  if (!succeeded(read)) throw new Error(`aws iam get-role: ${awsDetail(read)}`);
  const record = asRecord(asRecord(JSON.parse(read.stdout))?.Role);
  const findings: string[] = [];
  const tags = awsRoleTags(record);
  for (const [key, expected] of [
    ["radius-managed", "true"],
    ["radius-repository", config.repository],
    ["radius-repository-id", String(config.repositoryId)]
  ] as const) {
    const actual = tagValue(tags, key);
    if (actual !== expected)
      findings.push(
        `${role} has tag ${key}=${actual || "(none)"}, not ${expected}, so setup won't reuse it. Fix it: aws iam tag-role --role-name ${roleName} --tags Key=${key},Value=${expected}`
      );
  }
  const boundary = `arn:aws:iam::${config.accountId}:policy/${AWS_DEPLOY_ROLE_BOUNDARY_NAME}`;
  const actualBoundary = text(
    asRecord(record?.PermissionsBoundary)?.PermissionsBoundaryArn
  );
  if (actualBoundary !== boundary)
    findings.push(
      `${role} has permissions boundary ${actualBoundary || "(none)"}, not ${boundary}, so nothing caps what setup lets it do. Set it: aws iam put-role-permissions-boundary --role-name ${roleName} --permissions-boundary ${boundary}`
    );
  // Trusted subjects are named by the footprint check, so this only catches
  // a trust policy that is wrong in some other way.
  const trust = parsePolicyDocument(record?.AssumeRolePolicyDocument);
  const placeholder = `repo:${config.repository}:environment:preflight`;
  const denyOnly = removeGitHubTrustSubject(
    buildGitHubTrustPolicy(config.accountId, [placeholder]),
    config.accountId,
    placeholder
  ).policy;
  if (
    trustedGitHubSubjects(trust, config.accountId).length === 0 &&
    JSON.stringify(canonical(trust.Statement)) !==
      JSON.stringify(canonical(denyOnly.Statement))
  )
    findings.push(
      `${role}'s trust policy isn't the single RadiusNoTrustedEnvironments deny statement setup leaves when no environment uses the role. Restore build/cloud-e2e/aws/deploy-role-trust.json (step 4 of ${RUNBOOK}).`
    );
  const lock = await ports.runAws([
    "iam",
    "get-policy",
    "--policy-arn",
    awsLockPolicyArn(config.accountId, roleName),
    "--output",
    "json"
  ]);
  if (succeeded(lock)) {
    const policy = asRecord(asRecord(JSON.parse(lock.stdout))?.Policy);
    findings.push(
      `${role} is locked: ${awsLockHolderLabel(parseAwsLockHolder(policy?.Description))} has held it since ${text(policy?.CreateDate) || "an unknown time"}. A run or cleanup is still using it, or one stopped; the cleanup workflow removes a lock 10 or more minutes old.`
    );
  } else if (!awsError(lock, "NoSuchEntity"))
    throw new Error(`aws iam get-policy: ${awsDetail(lock)}`);
  return findings;
}

async function leftoverFindings(
  config: AwsPreflightConfig,
  ports: AwsPreflightPorts
): Promise<string[]> {
  const findings: string[] = [];
  for (const scope of await rdsScopes(config, ports))
    for (const item of rdsLabels(
      scope.region,
      await readRdsFootprint(ports, scope)
    ))
      findings.push(`${item.label} is left from an earlier run. ${CLEANUP}`);
  for (const cluster of config.clusters) {
    const where = `on cluster ${clusterLabel(cluster)}`;
    for (const item of selectLeakedClusterWorkloads(
      await ports.kubernetes.listWorkloads(cluster),
      config.environmentPrefix,
      config.application,
      ANY_AGE
    ))
      findings.push(
        `${item.kind} ${item.namespace}/${item.name} ${where} is left from an earlier run. ${CLEANUP}`
      );
    if (await ports.kubernetes.namespaceExists(cluster, config.namespace))
      findings.push(
        `Namespace ${config.namespace} ${where} is left from an earlier run. ${CLEANUP}`
      );
  }
  // The cleanup's own readers, so preflight refuses what the leftover check
  // would report. App boundaries are in the footprint check.
  const scope = {
    accountId: config.accountId,
    repositoryId: config.repositoryId,
    prefix: config.environmentPrefix
  };
  const left = await appRoleLeftovers(ports, scope);
  for (const cluster of config.clusters)
    left.push(...(await associationLeftovers(ports, scope, cluster)));
  for (const item of left)
    findings.push(
      `${item[0]!.toUpperCase()}${item.slice(1)} is left from an earlier run. ${CLEANUP}`
    );
  return findings;
}

/**
 * Everything wrong before a run starts, each naming what is wrong and what to
 * do. Reads only. A read that fails is itself a finding, so the run never
 * starts on what preflight couldn't see.
 */
export async function collectAwsPreflightFindings(
  config: AwsPreflightConfig,
  ports: AwsPreflightPorts
): Promise<string[]> {
  const findings: string[] = [];
  const check = async (what: string, work: () => Promise<string[]>) => {
    try {
      findings.push(...(await work()));
    } catch (error) {
      findings.push(`Could not check ${what}: ${describeError(error)}`);
    }
  };
  await check("the AWS account", async () => {
    const account = text(
      asRecord(await readAws(ports, ["sts", "get-caller-identity"]))?.Account
    );
    return account === config.accountId ?
        []
      : [
          `AWS is signed in to account ${account || "(unknown)"}, not ${config.accountId}, the test role's account. Sign in to the role AIEXT_CLOUD_E2E_AWS_ROLE_ARN names.`
        ];
  });
  if (findings.length > 0) return findings;
  const [main, second] = config.clusters;
  for (const cluster of config.clusters)
    await check(`cluster ${clusterLabel(cluster)}`, () =>
      clusterFindings(ports, cluster)
    );
  await check(`the node groups of cluster ${clusterLabel(second)}`, () =>
    secondClusterFindings(ports, second)
  );
  await check(`the node groups of cluster ${clusterLabel(main)}`, () =>
    nodeGroupFindings(ports, main)
  );
  await check(`deploy role ${config.deployRoleName}`, () =>
    deployRoleFindings(config, ports)
  );
  await check("what earlier runs left", () => leftoverFindings(config, ports));
  await check(`deploy role ${config.deployRoleName}'s environments`, async () =>
    (
      await checkAwsFootprint(
        {
          accountId: config.accountId,
          repositoryId: config.repositoryId,
          deployRoleName: config.deployRoleName,
          clusters: config.clusters
        },
        [],
        ports
      )
    ).map((difference) => `${difference} ${CLEANUP}`)
  );
  return findings;
}

export interface AwsCloudFixtureOptions {
  readonly ports: CloudFixturePorts;
  readonly aws: AwsPreflightPorts & AwsNodeGroupPorts;
  // The role the job signs in to. Its account is the account under test.
  readonly testRoleArn: string;
  // The main cluster first: it has the node groups.
  readonly clusters: readonly [AwsCleanupCluster, AwsCleanupCluster];
  readonly repository?: string;
  readonly defaultBranch?: string;
  readonly baselineSha?: string;
  // The other clouds' baselines the default branch may be at when a run starts.
  readonly otherBaselineShas?: readonly string[];
  readonly githubRunId?: string;
}

export interface AwsCloudFixture {
  readonly uniqueId: string;
  readonly repository: string;
  readonly repositoryId: number;
  readonly defaultBranch: string;
  readonly baselineSha: string;
  readonly workspacePath: string;
  readonly accountId: string;
  readonly deployRoleName: string;
  readonly deployRoleArn: string;
  readonly clusters: readonly [AwsCleanupCluster, AwsCleanupCluster];
  // One environment per cluster, in the same order.
  readonly environmentNames: readonly [string, string];
  /**
   * Runs the GitHub and AWS preflight, writing nothing, and fails naming
   * every problem. Only when all of it passes, moves the default branch to
   * the AWS baseline.
   */
  prepareCleanSlate(): Promise<void>;
  /** Updates and scales up the node groups. Only after prepareCleanSlate(). */
  startNodeGroups(): Promise<void>;
  /** Scales the node groups to zero if this run started them, then unwinds. */
  dispose(): Promise<void>;
}

async function readRepositoryId(
  fixture: GitHubFixtureRepository
): Promise<number> {
  const context = `gh api repos/${fixture.repository}`;
  const value = expectSuccess(
    await fixture.commands.runGh([
      "api",
      `repos/${fixture.repository}`,
      "--jq",
      ".id"
    ]),
    context
  ).stdout.trim();
  const id = /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(id))
    throw new Error(`${context} returned no repository ID: "${value}".`);
  return id;
}

export async function createAwsCloudFixture(
  options: AwsCloudFixtureOptions
): Promise<AwsCloudFixture> {
  const role = parseAwsRoleArn(options.testRoleArn);
  if (!role || role.partition !== "aws")
    throw new Error(
      `The AWS test role must be an IAM role ARN in the aws partition; got "${options.testRoleArn}".`
    );
  const { clusters } = options;
  if (clusters.some((cluster) => cluster.region === RADIUS_TEST_REGION))
    throw new Error(
      `The AWS Cloud E2E clusters can't be in ${RADIUS_TEST_REGION}, which Radius's own tests use.`
    );
  const repository = options.repository ?? FIXTURE_REPOSITORY;
  const githubFixture: GitHubFixtureRepository = {
    commands: options.ports.commands,
    repository,
    defaultBranch: options.defaultBranch ?? FIXTURE_REPO_DEFAULT_BRANCH,
    baselineSha: options.baselineSha ?? FIXTURE_AWS_BASELINE_SHA,
    otherBaselineShas: options.otherBaselineShas ?? [FIXTURE_BASELINE_SHA]
  };
  const uniqueId = shortenUniqueId(options.ports.newUniqueId());
  const environmentNames = [
    `${AWS_ENVIRONMENT_NAME_PREFIX}${uniqueId}-main`,
    `${AWS_ENVIRONMENT_NAME_PREFIX}${uniqueId}-second`
  ] as const;
  const deployRoleName = defaultAwsDeployRoleName(repository);

  const unwind: UnwindStep[] = [];
  let repositoryId: number;
  let workspacePath: string;
  try {
    await acquireFixtureLease(
      githubFixture,
      fixtureLeaseOwner(options.githubRunId),
      unwind
    );
    repositoryId = await readRepositoryId(githubFixture);
    workspacePath = await cloneFixtureAtBaseline(
      options.ports,
      githubFixture,
      `radtest-aws-${uniqueId}`,
      unwind
    );
  } catch (error) {
    const failures = await unwindAll(unwind);
    if (failures.length > 0)
      throw new Error(
        `AWS cloud fixture construction failed: ${describeError(error)}\n` +
          "Cleanup after the construction failure also failed:\n" +
          failures.map((failure) => `  - ${failure}`).join("\n"),
        { cause: error }
      );
    throw error;
  }

  const config: AwsPreflightConfig = {
    accountId: role.accountId,
    repository,
    repositoryId,
    deployRoleName,
    clusters,
    application: FIXTURE_APPLICATION_NAME,
    namespace: FIXTURE_RADIUS_ENVIRONMENT_NAMESPACE,
    environmentPrefix: AWS_ENVIRONMENT_NAME_PREFIX
  };
  let clean = false;
  // The teardown can run while the start does, as after a stage timeout, so
  // it stops the start and waits for it before it scales down.
  const nodeGroups = createAwsNodeGroupRun(options.aws, clusters[0]);
  let disposed = false;

  return {
    uniqueId,
    repository,
    repositoryId,
    defaultBranch: githubFixture.defaultBranch,
    baselineSha: githubFixture.baselineSha,
    workspacePath,
    accountId: role.accountId,
    deployRoleName,
    deployRoleArn: awsRoleArn(role.accountId, deployRoleName),
    clusters,
    environmentNames,

    async prepareCleanSlate() {
      const github = new Set<string>();
      for (const environmentName of environmentNames)
        for (const finding of await collectGitHubLeakedState(githubFixture, {
          environmentName,
          statePackage: stateRegistryForEnvironment(repository, environmentName)
        }))
          github.add(finding);
      const findings = [
        ...(await collectAwsPreflightFindings(config, options.aws)),
        ...github
      ];
      if (findings.length > 0)
        throw new Error(
          "The AWS Cloud E2E preflight failed, so nothing was changed. This is an infrastructure failure or something an earlier run left, not a product regression:\n" +
            findings.map((finding) => `  - ${finding}`).join("\n")
        );
      await moveDefaultBranchToBaseline(githubFixture);
      clean = true;
    },

    async startNodeGroups() {
      if (!clean)
        throw new Error(
          "The node groups start only after prepareCleanSlate() passes."
        );
      await nodeGroups.start();
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      const failures: string[] = [];
      try {
        await nodeGroups.stop();
      } catch (error) {
        failures.push(describeError(error));
      }
      // Only now, with nothing more going to AWS, is the lease released.
      failures.push(...(await unwindAll(unwind)));
      if (failures.length > 0)
        throw new Error(
          "AWS cloud fixture teardown failed:\n" +
            failures.map((failure) => `  - ${failure}`).join("\n")
        );
    }
  };
}
