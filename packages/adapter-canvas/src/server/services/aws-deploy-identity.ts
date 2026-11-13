import { isDeepStrictEqual } from "node:util";
import {
  AWS_EKS_CLUSTER_ADMIN_POLICY_ARN,
  AWS_MANAGED_TAG,
  AWS_REPOSITORY_ID_TAG,
  AWS_REPOSITORY_TAG,
  GITHUB_OIDC_AUDIENCE,
  GITHUB_OIDC_PROVIDER_URL,
  GITHUB_OIDC_THUMBPRINT,
  buildAwsAppBoundaryPolicy,
  buildAwsAppRolesPolicy,
  buildAwsAppRolesPolicyName,
  buildAwsEnvironmentPermissionPolicy,
  buildGitHubTrustPolicy,
  AWS_CLI_MINIMUM_VERSION,
  awsRoleArn,
  configMapClusterMessage,
  eksAcceptsAccessEntries,
  eksAuthenticationMode,
  createGitHubOidcProviderCommand,
  describeRadiusRoleOwner,
  githubOidcProviderArn,
  isAwsCommercialRegion,
  isAwsEnvironmentPolicyName,
  acceptedGitHubSubjects,
  isRadiusManagedRole,
  mergeGitHubTrustSubject,
  parseAwsRoleArn,
  parsePolicyDocument,
  radiusRoleRepositoryId,
  removeGitHubTrustSubject,
  namesOneEnvironment,
  trustAllowsOnlySubjects,
  restrictedGitHubSubjects,
  repositoryLessSubjectMessage,
  subjectNamesRepository,
  trustedGitHubSubjects,
  type AwsAppBoundary,
  type OidcSubjectConfig,
  type PolicyDocument
} from "@radius-project/core";
import {
  awsAppBoundary,
  awsEnvironmentPolicyName
} from "../../aws-deploy-role-name.js";
import {
  verifyAwsCliSession,
  type AwsCommandResult
} from "./aws-cli-session.js";
export type { AwsCommandResult } from "./aws-cli-session.js";

// Sets up the AWS deploy identity for one environment: the account's GitHub
// identity provider, the repository's IAM role and its trust in this
// environment's GitHub subject, the environment's permission policy, the
// permissions boundary for the environment's app roles and the role's
// permission to manage them, and cluster-admin on the target EKS cluster
// through an access entry.
//
// Every check that cannot change anything runs first. Nothing is written to
// AWS until the CLI version, the signed-in account, the cluster's auth mode,
// and its EKS Pod Identity Agent are known to be usable.

export interface AwsDeployIdentityPorts {
  // Run `aws <args>`. Never throws; a spawn failure is a non-zero result.
  runAws(args: string[]): Promise<AwsCommandResult>;
  // Report one progress line under `Authorize deploy identity`.
  step(text: string): void;
  sleep(milliseconds: number): Promise<void>;
  // Take the deploy identity lock for this role, waiting while another run
  // holds it. The caller releases it, since setup holds it past this function.
  acquireLock(role: {
    accountId: string;
    roleName: string;
  }): Promise<AwsLockResult>;
}

export type AwsLockResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

// A role IAM just created takes a few seconds to become visible to EKS, which
// rejects it meanwhile as an invalid principal. Retry that one answer only.
export const ACCESS_ENTRY_RETRY_DELAYS_MS = [2000, 4000, 8000, 15000, 30000];
const PRINCIPAL_NOT_YET_VISIBLE = /InvalidParameterException/;
// EKS can reject an access entry until a cluster is ACTIVE, for example while it
// switches to access entries. Setup waits up to 10 minutes for an UPDATING
// cluster before it writes anything.
export const CLUSTER_ACTIVE_WAIT_DELAYS_MS: readonly number[] = Array.from(
  { length: 40 },
  () => 15000
);

// Names the setup operation whose request created a role or access entry. A
// restarted setup that never saw the answer claims only a resource carrying
// its own ID: creation time cannot tell it from one made later.
export const AWS_OPERATION_TAG = "radius-operation";

export interface AwsDeployIdentityRequest {
  repo: string;
  // GitHub's ID for the repository. It names the environment's policy and
  // proves a role Radius created is this repository's.
  repoId: number;
  // The setup operation, tagged on the role and access entry it creates.
  operationId?: string;
  environment: string;
  accountId: string;
  region: string;
  cluster: string;
  // A new or Radius-managed role, by name. Ignored when `existingRoleArn` is set.
  roleName: string;
  // A role the developer picked deliberately. Radius adds to it but never owns it.
  existingRoleArn: string;
  // Every GitHub OIDC subject this environment's workflows may present: one for
  // a repository that uses immutable subjects, otherwise the name-based and
  // the ID-based form. At least one.
  subjects: readonly string[];
}

// One AWS change setup makes and records, so a failed or interrupted setup
// can list it and a rollback can undo exactly it.
export type AwsSetupChange =
  | {
      readonly kind: "aws_role.create";
      readonly accountId: string;
      readonly roleArn: string;
      readonly roleName: string;
      // The subjects the new role trusts from the start.
      readonly subjects: readonly string[];
    }
  | {
      readonly kind: "aws_trust.add";
      readonly accountId: string;
      readonly roleArn: string;
      readonly roleName: string;
      // IAM's id for the role the change is made on, or null when IAM did
      // not say. A rollback changes only a role that still has this id.
      readonly roleId: string | null;
      // Only the subjects the role did not trust before this write.
      readonly subjects: readonly string[];
    }
  | {
      readonly kind: "aws_role_policy.put";
      readonly accountId: string;
      readonly roleArn: string;
      readonly roleName: string;
      readonly roleId: string | null;
      readonly policyName: string;
    }
  | {
      // The managed policy the environment's app roles must carry as their
      // permissions boundary. The role fields name the deploy role whose setup
      // creates it.
      readonly kind: "aws_app_boundary.create";
      readonly accountId: string;
      readonly roleArn: string;
      readonly roleName: string;
      readonly roleId: string | null;
      readonly policyArn: string;
    }
  | {
      readonly kind: "aws_access_entry.create";
      readonly accountId: string;
      readonly roleArn: string;
      readonly roleName: string;
      readonly roleId: string | null;
      readonly cluster: string;
      readonly region: string;
    };

export interface AwsDeployIdentitySetupPorts extends AwsDeployIdentityPorts {
  // Run one AWS write that creates something this setup owns. Without it the
  // write runs through `runAws` and nothing is recorded.
  write?(change: AwsSetupChange, args: string[]): Promise<AwsCommandResult>;
}

export type AwsDeployIdentityResult =
  | {
      readonly ok: true;
      readonly roleArn: string;
      readonly roleCreated: boolean;
      // The permissions boundary every app role in the environment must carry.
      readonly appBoundaryArn: string;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      // What this attempt created before it stopped, so the failure card can
      // name it.
      readonly created: readonly string[];
    };

function succeeded(result: AwsCommandResult): boolean {
  return result.code === 0 || result.code === "0";
}

function detail(result: AwsCommandResult): string {
  const output = (result.stderr || result.stdout || "").trim();
  if (result.timedOut) {
    return output ?
        `the AWS CLI call timed out (${output})`
      : "the AWS CLI call timed out";
  }
  return output || "no output";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text || "null");
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The status in `aws eks describe-cluster` output, or empty when it has none. */
function clusterStatus(stdout: string): string {
  const output = parseJson(stdout);
  const status =
    isRecord(output) && isRecord(output.cluster) ? output.cluster.status : "";
  return typeof status === "string" ? status : "";
}

const ACCESS_DENIED = /AccessDenied|UnauthorizedOperation|not authorized/i;
const NO_SUCH_ENTITY = /NoSuchEntity/;
const RESOURCE_IN_USE = /ResourceInUseException/;
const RESOURCE_NOT_FOUND = /ResourceNotFoundException/;
const ENTITY_EXISTS = /EntityAlreadyExists/;
const DELETE_CONFLICT = /DeleteConflict/;
const LIMIT_EXCEEDED = /LimitExceeded/;

// App roles reach pods through EKS Pod Identity, which needs the agent on
// every node. A cluster without EKS Auto Mode gets it from the
// eks-pod-identity-agent add-on. UPDATING keeps the running agent until its
// replacement is ready.
async function podIdentityAgentReady(
  ports: Pick<AwsDeployIdentityPorts, "runAws">,
  cluster: string,
  region: string
): Promise<boolean> {
  const addon = await ports.runAws([
    "eks",
    "describe-addon",
    "--cluster-name",
    cluster,
    "--addon-name",
    "eks-pod-identity-agent",
    "--region",
    region,
    "--output",
    "json"
  ]);
  const output = succeeded(addon) ? parseJson(addon.stdout) : null;
  const status =
    isRecord(output) && isRecord(output.addon) ? output.addon.status : "";
  return status === "ACTIVE" || status === "UPDATING";
}

// IAM is eventually consistent. A run that releases the lock right after
// writing the trust policy could let the next holder read the policy from
// before that write and overwrite it. So the writer waits until its own read
// shows the write before it goes on, and stops when it never does. That makes
// a stale read less likely, but IAM does not promise the next holder's read
// is as current, so it cannot rule one out.
export const TRUST_VISIBLE_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

function sameSubjects(a: readonly string[], b: readonly string[]): boolean {
  const left = [...a].sort();
  const right = [...b].sort();
  return (
    left.length === right.length &&
    left.every((subject, index) => subject === right[index])
  );
}

async function awaitTrustVisible(
  ports: Pick<AwsDeployIdentityPorts, "runAws" | "sleep">,
  roleName: string,
  accountId: string,
  written: PolicyDocument
): Promise<string | null> {
  const expected = trustedGitHubSubjects(written, accountId);
  for (let attempt = 0; ; attempt++) {
    const getRole = await ports.runAws([
      "iam",
      "get-role",
      "--role-name",
      roleName,
      "--output",
      "json"
    ]);
    const record = parseJson(getRole.stdout);
    let shown: string[] | null = null;
    if (succeeded(getRole) && isRecord(record) && isRecord(record.Role)) {
      try {
        shown = trustedGitHubSubjects(
          parsePolicyDocument(record.Role.AssumeRolePolicyDocument),
          accountId
        );
      } catch {
        shown = null;
      }
    }
    if (shown && sameSubjects(shown, expected)) return null;
    const delay = TRUST_VISIBLE_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) {
      return `IAM did not show the updated trust policy of IAM role ${roleName} after the update, so Radius stopped.`;
    }
    await ports.sleep(delay);
  }
}

// Whether an existing access entry was created for the current role, judged
// by whether it is newer than the role.
async function accessEntryOwner(
  ports: AwsDeployIdentityPorts,
  entryArgs: readonly string[],
  roleCreatedAt: unknown
): Promise<"current role" | "earlier role" | "unknown"> {
  const describeEntry = await ports.runAws([
    "eks",
    "describe-access-entry",
    ...entryArgs,
    "--output",
    "json"
  ]);
  const entry = parseJson(describeEntry.stdout);
  const entryCreatedAt = Date.parse(
    (
      isRecord(entry) &&
        isRecord(entry.accessEntry) &&
        typeof entry.accessEntry.createdAt === "string"
    ) ?
      entry.accessEntry.createdAt
    : ""
  );
  const roleTime = Date.parse(
    typeof roleCreatedAt === "string" ? roleCreatedAt : ""
  );
  if (!succeeded(describeEntry) || isNaN(entryCreatedAt) || isNaN(roleTime)) {
    return "unknown";
  }
  return entryCreatedAt >= roleTime ? "current role" : "earlier role";
}

// Add each subject in turn. `kept` counts the subjects the role trusted before
// that are not among the ones being added.
function mergeGitHubTrustSubjects(
  existing: PolicyDocument,
  accountId: string,
  subjects: readonly string[]
): { policy: PolicyDocument; kept: number; changed: boolean } {
  let policy = existing;
  let changed = false;
  for (const subject of subjects) {
    const merge = mergeGitHubTrustSubject(policy, accountId, subject);
    policy = merge.policy;
    changed ||= merge.changed;
  }
  const kept = trustedGitHubSubjects(existing, accountId).filter(
    (subject) => !subjects.includes(subject)
  ).length;
  return { policy, kept, changed };
}

export async function setupAwsDeployIdentity(
  request: AwsDeployIdentityRequest,
  ports: AwsDeployIdentitySetupPorts
): Promise<AwsDeployIdentityResult> {
  const created: string[] = [];
  const write = (
    change: AwsSetupChange,
    args: string[]
  ): Promise<AwsCommandResult> =>
    ports.write ? ports.write(change, args) : ports.runAws(args);
  const fail = (code: string, message: string): AwsDeployIdentityResult => ({
    ok: false,
    code,
    message,
    created: [...created]
  });
  const { accountId, region, cluster } = request;
  const policyName = awsEnvironmentPolicyName(
    request.repoId,
    request.environment
  );
  const regionArgs = ["--region", region];
  // The ARNs below are built for the commercial partition, so a GovCloud or
  // China region would fail part way through, after the first write.
  if (!isAwsCommercialRegion(region)) {
    return fail(
      "aws-partition-unsupported",
      `Radius sets up AWS environments in commercial AWS regions only, and ${region} is not one. Nothing was changed.`
    );
  }

  const session = await verifyAwsCliSession(
    { accountId, region },
    ports.runAws
  );
  if (!session.ok) return fail(session.code, session.message);
  ports.step(
    `✅ AWS CLI ${session.version} meets the ${AWS_CLI_MINIMUM_VERSION} minimum.`
  );

  const describeCluster = (): Promise<AwsCommandResult> =>
    ports.runAws([
      "eks",
      "describe-cluster",
      "--name",
      cluster,
      ...regionArgs,
      "--output",
      "json"
    ]);
  let describe = await describeCluster();
  let status = succeeded(describe) ? clusterStatus(describe.stdout) : "";
  if (status === "UPDATING") {
    ports.step(
      `ℹ️ Cluster ${cluster} is UPDATING. Setup waits for it to be ACTIVE before it changes anything.`
    );
    for (const delay of CLUSTER_ACTIVE_WAIT_DELAYS_MS) {
      await ports.sleep(delay);
      describe = await describeCluster();
      if (!succeeded(describe)) break;
      status = clusterStatus(describe.stdout);
      if (status !== "UPDATING") break;
    }
  }
  if (!succeeded(describe)) {
    return fail(
      "aws-cluster-unreadable",
      `Could not read EKS cluster ${cluster} in ${region}: ${detail(describe)}`
    );
  }
  if (status !== "ACTIVE") {
    return fail(
      "aws-cluster-not-active",
      `Cluster ${cluster} in ${region} is ${status || "in an unknown state"}. Setup needs an ACTIVE cluster, so nothing was changed. Retry when the cluster is ACTIVE.`
    );
  }
  const described = parseJson(describe.stdout);
  const authenticationMode = eksAuthenticationMode(described);
  if (!eksAcceptsAccessEntries(authenticationMode)) {
    return fail(
      "aws-cluster-config-map",
      configMapClusterMessage(cluster, region)
    );
  }
  ports.step(
    `✅ Cluster ${cluster} accepts access entries (${authenticationMode}).`
  );
  const computeConfig =
    isRecord(described) && isRecord(described.cluster) ?
      described.cluster.computeConfig
    : undefined;
  const autoMode = isRecord(computeConfig) && computeConfig.enabled === true;
  if (!autoMode && !(await podIdentityAgentReady(ports, cluster, region))) {
    return fail(
      "aws-pod-identity-agent-missing",
      `Radius could not confirm that cluster ${cluster} has an ACTIVE EKS Pod Identity Agent add-on, which gives app containers their AWS permissions. Nothing was changed. Install the add-on or fix it in the EKS console, then retry. To install it, run: aws eks create-addon --cluster-name ${cluster} --addon-name eks-pod-identity-agent --region ${region}`
    );
  }
  ports.step(`✅ Cluster ${cluster} runs the EKS Pod Identity Agent.`);

  // Resolve which role this is before writing anything, so a same-named role
  // Radius does not own stops setup with nothing created.
  const picked = request.existingRoleArn.trim();
  const pickedArn = picked ? parseAwsRoleArn(picked) : null;
  if (picked && !pickedArn) {
    return fail("aws-role-invalid", `"${picked}" is not an IAM role ARN.`);
  }
  if (pickedArn && pickedArn.partition !== "aws") {
    return fail(
      "aws-partition-unsupported",
      `IAM role ${picked} is in the ${pickedArn.partition} partition. Radius sets up AWS environments in commercial AWS regions only. Nothing was changed.`
    );
  }
  if (pickedArn && pickedArn.accountId !== accountId) {
    return fail(
      "aws-role-wrong-account",
      `IAM role ${picked} is in account ${pickedArn.accountId}, not ${accountId}. A deploy role cannot leave its account.`
    );
  }
  const roleName = pickedArn ? pickedArn.roleName : request.roleName.trim();
  // The lock is the first write, so a missing iam:CreatePolicy stops setup
  // with nothing created, and it is held before the trust policy is read.
  const locked = await ports.acquireLock({ accountId, roleName });
  if (!locked.ok) return fail(locked.code, locked.message);
  const getRole = await ports.runAws([
    "iam",
    "get-role",
    "--role-name",
    roleName,
    "--output",
    "json"
  ]);
  const roleMissing =
    !succeeded(getRole) && NO_SUCH_ENTITY.test(getRole.stderr);
  if (!succeeded(getRole) && !roleMissing) {
    return fail(
      "aws-role-unreadable",
      `Could not read IAM role ${roleName}: ${detail(getRole)}`
    );
  }
  if (pickedArn && roleMissing) {
    return fail(
      "aws-role-missing",
      `IAM role ${picked} does not exist. Pick another role or let Radius create one.`
    );
  }
  const roleRecord = parseJson(getRole.stdout);
  const role =
    isRecord(roleRecord) && isRecord(roleRecord.Role) ? roleRecord.Role : null;
  if (!pickedArn && role && !isRadiusManagedRole(role, request.repoId)) {
    // A role Radius created for another repository can't be picked either.
    const createdFor = describeRadiusRoleOwner(role);
    return fail(
      "aws-role-not-radius-managed",
      createdFor ?
        `An IAM role named ${roleName} already exists, but Radius created it for ${createdFor}, not for ${request.repo} (repository ID ${request.repoId}). That can be a repository that used this name before. No change was made. Choose a different name.`
      : `An IAM role named ${roleName} already exists, but Radius did not create it for ${request.repo}. No change was made. Either select that role deliberately with "use an existing role…", or choose a different name.`
    );
  }
  // A role Radius created belongs to the repository whose ID is in its tags,
  // and that repository's own setup and cleanup assume no other repository
  // uses it. A name tag doesn't count: another repository can take the name.
  const owner = pickedArn ? radiusRoleRepositoryId(role) : null;
  if (owner !== null && owner !== request.repoId) {
    return fail(
      "aws-role-other-repository",
      `Radius created IAM role ${roleName} for ${describeRadiusRoleOwner(role)}, so it cannot be used for ${request.repo} (repository ID ${request.repoId}). Nothing was changed. Pick another role or let Radius create one.`
    );
  }

  // Read the existing role's trust before anything is written, so a policy
  // Radius cannot read stops setup with nothing created.
  let trust: ReturnType<typeof mergeGitHubTrustSubjects> | null = null;
  // The subjects the role trusted before this setup, which a rollback keeps.
  let trustedBefore: string[] = [];
  if (!roleMissing) {
    try {
      const existingTrust = parsePolicyDocument(role?.AssumeRolePolicyDocument);
      trustedBefore = acceptedGitHubSubjects(existingTrust, accountId);
      trust = mergeGitHubTrustSubjects(
        existingTrust,
        accountId,
        request.subjects
      );
    } catch (error) {
      return fail(
        "aws-role-trust-unreadable",
        `Could not read the trust policy of IAM role ${roleName}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  // Read the environment's app boundary before anything is written too, so a
  // boundary at its path that another repository owns stops setup here.
  const appBoundaryTarget = awsAppBoundary(
    accountId,
    request.repoId,
    request.environment
  );
  const appBoundaryArn = appBoundaryTarget.arn;
  const boundaryRead = await readAppBoundary(ports, appBoundaryArn);
  if (!boundaryRead.ok) return fail(boundaryRead.code, boundaryRead.message);
  const boundaryProblem = appBoundaryOwnerProblem(
    boundaryRead.policy,
    appBoundaryArn,
    request
  );
  if (boundaryProblem)
    return fail(boundaryProblem.code, boundaryProblem.message);
  // The account-wide GitHub identity provider. Created once, never removed.
  const providers = await ports.runAws([
    "iam",
    "list-open-id-connect-providers",
    "--output",
    "json"
  ]);
  if (!succeeded(providers)) {
    return fail(
      "aws-oidc-provider-unreadable",
      `Could not list the account's OIDC identity providers: ${detail(providers)}`
    );
  }
  const providerList = parseJson(providers.stdout);
  if (
    !isRecord(providerList) ||
    !Array.isArray(providerList.OpenIDConnectProviderList)
  ) {
    return fail(
      "aws-oidc-provider-unreadable",
      `Could not read the account's OIDC identity providers: ${detail(providers)}`
    );
  }
  const providerArn = githubOidcProviderArn(accountId);
  const hasProvider = providerList.OpenIDConnectProviderList.some(
    (entry) => isRecord(entry) && entry.Arn === providerArn
  );
  if (hasProvider) {
    // A provider made for another purpose may not accept the audience GitHub
    // uses for AWS, and every token would then be refused at deploy time.
    const provider = await ports.runAws([
      "iam",
      "get-open-id-connect-provider",
      "--open-id-connect-provider-arn",
      providerArn,
      "--output",
      "json"
    ]);
    const providerRecord = parseJson(provider.stdout);
    if (
      !succeeded(provider) ||
      !isRecord(providerRecord) ||
      !Array.isArray(providerRecord.ClientIDList)
    ) {
      return fail(
        "aws-oidc-provider-unreadable",
        `Could not read the account's GitHub identity provider: ${detail(provider)}`
      );
    }
    if (!providerRecord.ClientIDList.includes(GITHUB_OIDC_AUDIENCE)) {
      return fail(
        "aws-oidc-provider-audience",
        `The GitHub identity provider in account ${accountId} does not accept the ${GITHUB_OIDC_AUDIENCE} audience, so GitHub workflows could not assume the deploy role. Nothing was changed. Ask an IAM administrator to run: aws iam add-client-id-to-open-id-connect-provider --open-id-connect-provider-arn ${providerArn} --client-id ${GITHUB_OIDC_AUDIENCE}`
      );
    }
    ports.step(`✅ GitHub identity provider found in account ${accountId}.`);
  } else {
    const createProvider = await ports.runAws([
      "iam",
      "create-open-id-connect-provider",
      "--url",
      GITHUB_OIDC_PROVIDER_URL,
      "--client-id-list",
      GITHUB_OIDC_AUDIENCE,
      "--thumbprint-list",
      GITHUB_OIDC_THUMBPRINT
    ]);
    if (
      !succeeded(createProvider) &&
      !ENTITY_EXISTS.test(createProvider.stderr)
    ) {
      return fail(
        ACCESS_DENIED.test(createProvider.stderr) ?
          "aws-oidc-provider-denied"
        : "aws-oidc-provider-failed",
        `Account ${accountId} has no GitHub identity provider, and the signed-in identity could not create one (${detail(createProvider)}). Ask an IAM administrator to run: ${createGitHubOidcProviderCommand()}`
      );
    }
    if (succeeded(createProvider)) {
      created.push(`the GitHub identity provider in account ${accountId}`);
    }
    ports.step(
      `✅ Created the GitHub identity provider in account ${accountId}.`
    );
  }

  const subjectList = request.subjects.join(", ");
  ports.step(`ℹ️ Deploy identity will trust ${subjectList}`);

  let roleArn: string;
  let roleCreated = false;
  let roleCreatedAt: unknown = role?.CreateDate;
  // IAM's id for the role every later change is made on.
  let roleId: string | null =
    role && typeof role.RoleId === "string" && role.RoleId ? role.RoleId : null;
  if (!trust) {
    const createRole = await write(
      {
        kind: "aws_role.create",
        accountId,
        roleArn: awsRoleArn(accountId, roleName),
        roleName,
        subjects: request.subjects
      },
      [
        "iam",
        "create-role",
        "--role-name",
        roleName,
        "--description",
        `Radius deploy identity for ${request.repo}`,
        "--assume-role-policy-document",
        JSON.stringify(buildGitHubTrustPolicy(accountId, request.subjects)),
        "--tags",
        `Key=${AWS_MANAGED_TAG},Value=true`,
        `Key=${AWS_REPOSITORY_TAG},Value=${request.repo}`,
        `Key=${AWS_REPOSITORY_ID_TAG},Value=${request.repoId}`,
        ...(request.operationId ?
          [`Key=${AWS_OPERATION_TAG},Value=${request.operationId}`]
        : []),
        "--output",
        "json"
      ]
    );
    if (!succeeded(createRole)) {
      return fail(
        ACCESS_DENIED.test(createRole.stderr) ?
          "aws-role-create-denied"
        : "aws-role-create-failed",
        ACCESS_DENIED.test(createRole.stderr) ?
          `The signed-in AWS identity is not permitted to create IAM roles. Go back and select an existing role, or ask an IAM administrator to allow iam:CreateRole. ${detail(createRole)}`
        : `Failed to create IAM role ${roleName}: ${detail(createRole)}`
      );
    }
    const createdRole = parseJson(createRole.stdout);
    roleArn =
      (
        isRecord(createdRole) &&
        isRecord(createdRole.Role) &&
        typeof createdRole.Role.Arn === "string"
      ) ?
        createdRole.Role.Arn
      : awsRoleArn(accountId, roleName);
    roleCreated = true;
    roleCreatedAt =
      isRecord(createdRole) && isRecord(createdRole.Role) ?
        createdRole.Role.CreateDate
      : undefined;
    roleId =
      (
        isRecord(createdRole) &&
        isRecord(createdRole.Role) &&
        typeof createdRole.Role.RoleId === "string" &&
        createdRole.Role.RoleId
      ) ?
        createdRole.Role.RoleId
      : null;
    created.push(`IAM role ${roleName}`);
    ports.step(`✅ Created IAM role ${roleName}.`);
  } else {
    roleArn =
      role && typeof role.Arn === "string" ?
        role.Arn
      : awsRoleArn(accountId, roleName);
    ports.step(
      pickedArn ?
        `✅ Using the selected IAM role ${roleName}.`
      : `✅ Reusing the Radius-managed IAM role ${roleName}`
    );
    if (trust.kept > 0) {
      ports.step(
        `ℹ️ Keeping ${trust.kept} subject(s) already trusted by this role`
      );
    }
    if (trust.changed) {
      const updateTrust = await write(
        {
          kind: "aws_trust.add",
          accountId,
          roleArn,
          roleName,
          roleId,
          subjects: request.subjects.filter(
            (subject) => !trustedBefore.includes(subject)
          )
        },
        [
          "iam",
          "update-assume-role-policy",
          "--role-name",
          roleName,
          "--policy-document",
          JSON.stringify(trust.policy)
        ]
      );
      if (!succeeded(updateTrust)) {
        return LIMIT_EXCEEDED.test(updateTrust.stderr) ?
            fail(
              "aws-role-limit-exceeded",
              `IAM role ${roleName} cannot trust another environment: its trust policy is at IAM's size limit (${detail(updateTrust)}). Nothing was changed on the role. Delete an environment that no longer uses this role, choose another role, or ask an AWS administrator to raise the "Role trust policy length" quota (up to 8,192 characters).`
            )
          : fail(
              "aws-role-trust-denied",
              `Failed to update the role's trust policy: ${detail(updateTrust)}`
            );
      }
      created.push(`trust for ${subjectList} on ${roleName}`);
      const unconfirmed = await awaitTrustVisible(
        ports,
        roleName,
        accountId,
        trust.policy
      );
      if (unconfirmed) {
        return fail(
          "aws-role-trust-unconfirmed",
          `${unconfirmed} Retry setup.`
        );
      }
    }
  }

  const putPolicy = (
    name: string,
    document: PolicyDocument
  ): Promise<AwsCommandResult> =>
    write(
      {
        kind: "aws_role_policy.put",
        accountId,
        roleArn,
        roleName,
        roleId,
        policyName: name
      },
      [
        "iam",
        "put-role-policy",
        "--role-name",
        roleName,
        "--policy-name",
        name,
        "--policy-document",
        JSON.stringify(document)
      ]
    );
  const putFailure = (
    name: string,
    result: AwsCommandResult
  ): AwsDeployIdentityResult =>
    LIMIT_EXCEEDED.test(result.stderr) ?
      fail(
        "aws-role-limit-exceeded",
        `IAM role ${roleName} has reached the 10,240-character inline-policy limit, which cannot be raised. Radius's policies fit about 15 environments when no other inline policies use the space. Delete an unused environment or choose another role. AWS reported: ${detail(result)}`
      )
    : fail(
        "aws-role-policy-failed",
        `Failed to put policy ${name} on IAM role ${roleName}: ${detail(result)}`
      );

  // The containers Recipe creates each app's IAM role through Cloud Control
  // as this role. One policy covers every environment of the repository.
  const appRolesPolicyName = buildAwsAppRolesPolicyName(request.repoId);
  const appRoles = await putPolicy(
    appRolesPolicyName,
    buildAwsAppRolesPolicy(accountId, request.repoId)
  );
  if (!succeeded(appRoles)) return putFailure(appRolesPolicyName, appRoles);
  created.push(`policy ${appRolesPolicyName} on ${roleName}`);
  ports.step(
    `✅ Attached policy ${appRolesPolicyName}, which lets the role create app roles only under a permissions boundary.`
  );

  const attached = await putPolicy(
    policyName,
    buildAwsEnvironmentPermissionPolicy(region)
  );
  if (!succeeded(attached)) return putFailure(policyName, attached);
  created.push(`policy ${policyName} on ${roleName}`);
  ports.step(
    `✅ Attached deploy permission policy ${policyName}, limited to ${region}.`
  );

  const boundary = await ensureAppBoundary(ports, write, {
    accountId,
    region,
    request,
    roleArn,
    roleName,
    roleId,
    boundary: appBoundaryTarget,
    existing: boundaryRead.policy
  });
  if (!boundary.ok) return fail(boundary.code, boundary.message);
  if (boundary.change === "created") {
    created.push(`permissions boundary ${appBoundaryArn}`);
  }
  ports.step(
    boundary.change === "created" ?
      `✅ Created permissions boundary ${appBoundaryArn} for the environment's app roles.`
    : `✅ Permissions boundary ${appBoundaryArn} is up to date.`
  );

  const entryArgs = [
    "--cluster-name",
    cluster,
    "--principal-arn",
    roleArn,
    ...regionArgs
  ];
  const entryChange: AwsSetupChange = {
    kind: "aws_access_entry.create",
    accountId,
    roleArn,
    roleName,
    roleId,
    cluster,
    region
  };
  const createAccessEntry = async (): Promise<AwsCommandResult> => {
    const args = [
      "eks",
      "create-access-entry",
      ...entryArgs,
      "--type",
      "STANDARD",
      // Delete removes only an entry carrying this tag, so it never removes
      // one an administrator made for the same role.
      "--tags",
      [
        `${AWS_MANAGED_TAG}=true`,
        ...(request.operationId ?
          [`${AWS_OPERATION_TAG}=${request.operationId}`]
        : [])
      ].join(",")
    ];
    let result = await write(entryChange, args);
    for (const delay of ACCESS_ENTRY_RETRY_DELAYS_MS) {
      if (succeeded(result) || !PRINCIPAL_NOT_YET_VISIBLE.test(result.stderr)) {
        break;
      }
      ports.step(
        `ℹ️ EKS does not see role ${roleName} yet. Retrying in ${delay / 1000}s.`
      );
      await ports.sleep(delay);
      result = await write(entryChange, args);
    }
    return result;
  };
  let createEntry = await createAccessEntry();
  let replacedEntry = false;
  if (!succeeded(createEntry) && RESOURCE_IN_USE.test(createEntry.stderr)) {
    // EKS ties an access entry to the role's unique ID, not its ARN. An entry
    // left by an earlier role with this name grants the current role nothing,
    // so it is only kept when it was created after the current role.
    const owner =
      roleCreated ? "earlier role" : (
        await accessEntryOwner(ports, entryArgs, roleCreatedAt)
      );
    if (owner === "unknown") {
      return fail(
        "aws-access-entry-unverified",
        `Cluster ${cluster} already has an access entry for ${roleArn}, and Radius could not confirm it was created for the current role ${roleName}. An entry left by an earlier role with this name does not grant access. Delete it, then retry: aws eks delete-access-entry --cluster-name ${cluster} --principal-arn ${roleArn} --region ${region}`
      );
    }
    if (owner === "earlier role") {
      const deleteEntry = await ports.runAws([
        "eks",
        "delete-access-entry",
        ...entryArgs
      ]);
      if (!succeeded(deleteEntry)) {
        return fail(
          "aws-access-entry-failed",
          `Cluster ${cluster} has an access entry left by an earlier IAM role named ${roleName}, and Radius could not delete it: ${detail(deleteEntry)}`
        );
      }
      ports.step(
        `ℹ️ Deleted the access entry on ${cluster} left by an earlier IAM role named ${roleName}.`
      );
      replacedEntry = true;
      createEntry = await createAccessEntry();
    }
  }
  if (
    !succeeded(createEntry) &&
    (replacedEntry || !RESOURCE_IN_USE.test(createEntry.stderr))
  ) {
    return fail(
      "aws-access-entry-failed",
      `Failed to create the cluster access entry: ${detail(createEntry)}`
    );
  }
  if (succeeded(createEntry)) {
    created.push(`access entry for ${roleName} on ${cluster}`);
  }
  const associate = await ports.runAws([
    "eks",
    "associate-access-policy",
    "--cluster-name",
    cluster,
    "--principal-arn",
    roleArn,
    "--policy-arn",
    AWS_EKS_CLUSTER_ADMIN_POLICY_ARN,
    "--access-scope",
    "type=cluster",
    ...regionArgs
  ]);
  if (!succeeded(associate) && !RESOURCE_IN_USE.test(associate.stderr)) {
    return fail(
      "aws-access-entry-failed",
      `Failed to grant cluster-admin on ${cluster}: ${detail(associate)}`
    );
  }
  ports.step(`✅ Granted the role cluster-admin on ${cluster}.`);
  return { ok: true, roleArn, roleCreated, appBoundaryArn };
}

type AppBoundaryRead =
  | { readonly ok: true; readonly policy: Record<string, unknown> | null }
  | { readonly ok: false; readonly code: string; readonly message: string };

function appBoundaryPermissions(accountId: string): string {
  return `Ask an IAM administrator to allow iam:GetPolicy, iam:CreatePolicy, iam:TagPolicy, iam:GetPolicyVersion, and iam:DeletePolicy on arn:aws:iam::${accountId}:policy/radius/apps/*.`;
}

// The boundary as `aws iam get-policy` describes it, with its tags, or a null
// policy when IAM has none at the ARN.
async function readAppBoundary(
  ports: Pick<AwsDeployIdentityPorts, "runAws">,
  arn: string
): Promise<AppBoundaryRead> {
  const read = await ports.runAws([
    "iam",
    "get-policy",
    "--policy-arn",
    arn,
    "--output",
    "json"
  ]);
  if (!succeeded(read)) {
    if (NO_SUCH_ENTITY.test(read.stderr)) return { ok: true, policy: null };
    const denied = ACCESS_DENIED.test(read.stderr);
    return {
      ok: false,
      code: denied ? "aws-app-boundary-denied" : "aws-app-boundary-unreadable",
      message: `Could not read permissions boundary ${arn}: ${detail(read)}.${
        denied ? ` ${appBoundaryPermissions(arn.split(":")[4] ?? "")}` : ""
      }`
    };
  }
  const output = parseJson(read.stdout);
  if (!isRecord(output) || !isRecord(output.Policy)) {
    return {
      ok: false,
      code: "aws-app-boundary-unreadable",
      message: `IAM did not describe permissions boundary ${arn}.`
    };
  }
  return { ok: true, policy: output.Policy };
}

// A boundary at the environment's path is this repository's only when Radius
// tagged it with the repository's ID. Policies share the role tag shape.
function appBoundaryOwnerProblem(
  policy: Record<string, unknown> | null,
  arn: string,
  request: Pick<AwsDeployIdentityRequest, "repo" | "repoId">
): { code: string; message: string } | null {
  if (policy === null || radiusRoleRepositoryId(policy) === request.repoId) {
    return null;
  }
  return {
    code: "aws-app-boundary-not-owned",
    message: `IAM policy ${arn} already exists, but Radius did not create it for ${request.repo} (repository ID ${request.repoId}). Nothing was changed. It sits at the path of this environment's app roles, so delete or move it if nothing uses it, then retry.`
  };
}

// The policy document in `aws iam get-policy-version` output, or null when IAM
// returned something that is not one.
function policyVersionDocument(stdout: string): PolicyDocument | null {
  const output = parseJson(stdout);
  if (!isRecord(output) || !isRecord(output.PolicyVersion)) return null;
  try {
    return parsePolicyDocument(output.PolicyVersion.Document);
  } catch {
    return null;
  }
}

// Create the environment's app boundary, or check that the one there matches
// the environment's region. The Recipe passes its ARN to every app role.
async function ensureAppBoundary(
  ports: Pick<AwsDeployIdentityPorts, "runAws">,
  write: (change: AwsSetupChange, args: string[]) => Promise<AwsCommandResult>,
  context: {
    accountId: string;
    region: string;
    request: AwsDeployIdentityRequest;
    roleArn: string;
    roleName: string;
    roleId: string | null;
    boundary: AwsAppBoundary;
    existing: Record<string, unknown> | null;
  }
): Promise<
  | { readonly ok: true; readonly change: "created" | "none" }
  | { readonly ok: false; readonly code: string; readonly message: string }
> {
  const { accountId, region, request } = context;
  const { arn } = context.boundary;
  const document = buildAwsAppBoundaryPolicy(accountId, region);
  const failed = (result: AwsCommandResult, action: string) => {
    const denied = ACCESS_DENIED.test(result.stderr);
    return {
      ok: false as const,
      code: denied ? "aws-app-boundary-denied" : "aws-app-boundary-failed",
      message: `Could not ${action} permissions boundary ${arn}: ${detail(result)}.${
        denied ? ` ${appBoundaryPermissions(accountId)}` : ""
      }`
    };
  };
  const policy = context.existing;
  if (policy === null) {
    const creation = await write(
      {
        kind: "aws_app_boundary.create",
        accountId,
        roleArn: context.roleArn,
        roleName: context.roleName,
        roleId: context.roleId,
        policyArn: arn
      },
      [
        "iam",
        "create-policy",
        "--path",
        context.boundary.path,
        "--policy-name",
        context.boundary.name,
        "--description",
        `Limits the IAM roles Radius creates for apps in environment ${request.environment} of ${request.repo}.`,
        "--policy-document",
        JSON.stringify(document),
        "--tags",
        `Key=${AWS_MANAGED_TAG},Value=true`,
        `Key=${AWS_REPOSITORY_TAG},Value=${request.repo}`,
        `Key=${AWS_REPOSITORY_ID_TAG},Value=${request.repoId}`,
        ...(request.operationId ?
          [`Key=${AWS_OPERATION_TAG},Value=${request.operationId}`]
        : []),
        "--output",
        "json"
      ]
    );
    if (succeeded(creation)) return { ok: true, change: "created" };
    if (ENTITY_EXISTS.test(creation.stderr)) {
      return {
        ok: false,
        code: "aws-app-boundary-failed",
        message: `Permissions boundary ${arn} was created by another run while this setup ran. Retry setup.`
      };
    }
    return failed(creation, "create");
  }

  const versionId = policy.DefaultVersionId;
  if (typeof versionId !== "string" || !versionId) {
    return {
      ok: false,
      code: "aws-app-boundary-unreadable",
      message: `IAM did not name the default version of permissions boundary ${arn}, so nothing was changed on it.`
    };
  }
  const version = await ports.runAws([
    "iam",
    "get-policy-version",
    "--policy-arn",
    arn,
    "--version-id",
    versionId,
    "--output",
    "json"
  ]);
  if (!succeeded(version)) return failed(version, "read");
  const current = policyVersionDocument(version.stdout);
  if (current && isDeepStrictEqual(current, parsePolicyDocument(document))) {
    return { ok: true, change: "none" };
  }
  return {
    ok: false,
    code: "aws-app-boundary-failed",
    message: `Permissions boundary ${arn} differs from the one setup writes for region ${region}, so nothing was changed on it. To change the environment's region, delete the environment and create it again.`
  };
}

// One of the repository's other AWS environments, as its GitHub variables
// describe it.
export interface AwsEnvironmentUsage {
  readonly name: string;
  readonly accountId: string;
  readonly region: string;
  readonly cluster: string;
  // The subjects its setup recorded; empty when it recorded none.
  readonly trustSubjects: readonly string[];
}

export type AwsEnvironmentListing =
  | { readonly ok: true; readonly environments: readonly AwsEnvironmentUsage[] }
  | { readonly ok: false; readonly reason: string };

// IAM addresses a role by name in whichever account the CLI is signed in to, so
// a run that changes a role by its ARN first confirms it is in the role's
// account. Null when it is.
async function signedInAccountProblem(
  ports: Pick<AwsDeployIdentityPorts, "runAws">,
  accountId: string,
  roleName: string,
  purpose: string
): Promise<{ code: string; message: string } | null> {
  const identity = await ports.runAws([
    "sts",
    "get-caller-identity",
    "--output",
    "json"
  ]);
  const caller = parseJson(identity.stdout);
  const sessionAccount =
    isRecord(caller) && typeof caller.Account === "string" ?
      caller.Account
    : "";
  if (!succeeded(identity)) {
    return {
      code: "aws-cli-login-required",
      message: `No active AWS CLI session, so Radius could not ${purpose} IAM role ${roleName}. Run "aws sso login" (or "aws configure"), then retry. ${detail(identity)}`
    };
  }
  if (sessionAccount !== accountId) {
    return {
      code: "aws-account-mismatch",
      message: `Your AWS CLI session is signed in to account ${sessionAccount || "(unknown)"}, but IAM role ${roleName} is in account ${accountId}. Nothing was changed. Sign in to account ${accountId}, then retry.`
    };
  }
  return null;
}

export interface AwsDeployIdentityRemovalRequest {
  repo: string;
  // GitHub's ID for the repository. It names the environment's policy and
  // proves a role Radius created is this repository's.
  repoId: number;
  roleArn: string;
  environment: string;
  subjects: readonly string[];
  // The environment's EKS cluster. Empty for an environment that did not
  // record it, whose access entry is then kept.
  region: string;
  cluster: string;
}

export interface AwsDeployIdentityRemovalPorts extends Pick<
  AwsDeployIdentityPorts,
  "runAws" | "acquireLock" | "sleep"
> {
  // The repository's other AWS environments, without the one being deleted.
  listOtherEnvironments(): Promise<AwsEnvironmentListing>;
}

export type AwsDeployIdentityRemovalResult =
  | {
      readonly ok: true;
      readonly removed: readonly string[];
      readonly kept: readonly string[];
      // Sentences about something Radius could not confirm, for the developer
      // to check.
      readonly warnings: readonly string[];
    }
  | { readonly ok: false; readonly message: string };

function sameText(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

// A scope the other environment did not record counts as the same, so an
// unknown never leads to removing an entry that environment uses.
function usesCluster(
  environment: AwsEnvironmentUsage,
  scope: { accountId: string; region: string; cluster: string }
): boolean {
  const matches = (value: string, expected: string) =>
    !value.trim() || sameText(value, expected);
  return (
    matches(environment.cluster, scope.cluster) &&
    matches(environment.accountId, scope.accountId) &&
    matches(environment.region, scope.region)
  );
}

function namesList(names: readonly string[]): string {
  return names.length === 1 ?
      `environment ${names[0]} still uses`
    : `environments ${names.join(", ")} still use`;
}

type AccessEntryOutcome =
  | { readonly kind: "removed" | "kept" | "warning"; readonly text: string }
  | { readonly kind: "absent" }
  | { readonly kind: "failed"; readonly message: string };

// The role's access entry on the environment's cluster.
interface AccessEntryTarget {
  roleArn: string;
  roleName: string;
  region: string;
  cluster: string;
}

function entryLabel({ roleName, cluster }: AccessEntryTarget): string {
  return `the access entry for ${roleName} on ${cluster}`;
}

function deleteEntryCommand({
  roleArn,
  region,
  cluster
}: AccessEntryTarget): string {
  return `aws eks delete-access-entry --cluster-name ${cluster} --principal-arn ${roleArn} --region ${region}`;
}

function entryArgs({ roleArn, region, cluster }: AccessEntryTarget): string[] {
  return [
    "--cluster-name",
    cluster,
    "--principal-arn",
    roleArn,
    "--region",
    region
  ];
}

// Whether the entry exists, and whether setup tagged it as its own.
async function readAccessEntry(
  target: AccessEntryTarget,
  ports: Pick<AwsDeployIdentityRemovalPorts, "runAws">
): Promise<
  | { kind: "absent" }
  | { kind: "unreadable"; detail: string }
  | { kind: "present"; tagged: boolean; createdAt: unknown }
> {
  const describe = await ports.runAws([
    "eks",
    "describe-access-entry",
    ...entryArgs(target),
    "--output",
    "json"
  ]);
  if (!succeeded(describe)) {
    return RESOURCE_NOT_FOUND.test(describe.stderr) ?
        { kind: "absent" }
      : { kind: "unreadable", detail: detail(describe) };
  }
  const described = parseJson(describe.stdout);
  const tags =
    (
      isRecord(described) &&
      isRecord(described.accessEntry) &&
      isRecord(described.accessEntry.tags)
    ) ?
      described.accessEntry.tags
    : {};
  return {
    kind: "present",
    tagged: tags[AWS_MANAGED_TAG] === "true",
    createdAt:
      isRecord(described) && isRecord(described.accessEntry) ?
        described.accessEntry.createdAt
      : undefined
  };
}

async function deleteAccessEntry(
  target: AccessEntryTarget,
  ports: Pick<AwsDeployIdentityRemovalPorts, "runAws">
): Promise<AccessEntryOutcome> {
  const deleteEntry = await ports.runAws([
    "eks",
    "delete-access-entry",
    ...entryArgs(target)
  ]);
  if (succeeded(deleteEntry)) {
    return {
      kind: "removed",
      text: `access entry for ${target.roleName} on ${target.cluster}`
    };
  }
  if (RESOURCE_NOT_FOUND.test(deleteEntry.stderr)) return { kind: "absent" };
  return {
    kind: "failed",
    message: `Could not delete ${entryLabel(target)} (${detail(deleteEntry)}).`
  };
}

// GitHub's ID for the repository, or why Radius couldn't read it.
export type AwsRepositoryIdLookup =
  | { readonly ok: true; readonly repoId: number }
  | { readonly ok: false; readonly reason: string };

interface AccessEntryRequest extends AccessEntryTarget {
  repo: string;
  repository: AwsRepositoryIdLookup;
  role: Record<string, unknown>;
  accountId: string;
  // The role's trust after this environment's subjects are removed.
  remainingTrust: PolicyDocument;
}

// Remove the deploy identity's access entry on the environment's cluster when
// nothing else can use it. EKS grants the entry to whoever assumes the role,
// so it stays while another environment of the repository is on the cluster,
// or while the role's trust lets in anyone those environments did not record.
// A picked role is never cleaned up, because another repository may use it on
// the same cluster and Radius cannot see that repository's environments. Only
// an entry setup tagged is removed, so one an administrator made stays.
async function removeUnusedAccessEntry(
  request: AccessEntryRequest,
  ports: AwsDeployIdentityRemovalPorts
): Promise<AccessEntryOutcome> {
  const { roleName, accountId, region, cluster, repository } = request;
  const onCluster = cluster ? ` on ${cluster}` : "";
  // The repository's ID only matters for a role tagged with one. A role
  // without the tag is never this repository's, so a retry can't change it.
  const owner = radiusRoleRepositoryId(request.role);
  if (owner !== null && !repository.ok) {
    return {
      kind: "warning",
      text: `Kept any access entry for ${roleName}${onCluster}, because Radius couldn't read ${request.repo}'s repository ID from GitHub (${repository.reason}), so it can't tell whether Radius created this role for it. Retry deletion to try again.`
    };
  }
  if (!repository.ok || owner !== repository.repoId) {
    return {
      kind: "kept",
      text: `any access entry for ${roleName}${onCluster}, because Radius didn't create this role for ${request.repo}, and other repositories may use it`
    };
  }
  if (!cluster || !region) {
    return {
      kind: "warning",
      text: `Kept any access entry for ${roleName}, because this environment doesn't record its cluster. Remove it in the EKS console if nothing else uses it.`
    };
  }
  const entry = entryLabel(request);
  const byHand = `If nothing else uses it, run: ${deleteEntryCommand(request)}`;
  const found = await readAccessEntry(request, ports);
  if (found.kind === "absent") return found;
  if (found.kind === "unreadable") {
    return {
      kind: "warning",
      text: `Kept ${entry}, because Radius couldn't read it (${found.detail}). ${byHand}`
    };
  }
  if (!found.tagged) {
    return {
      kind: "kept",
      text: `${entry}, because it doesn't have the Radius tag. Entries created before Radius tagged them are kept too. ${byHand}`
    };
  }
  const listing = await ports.listOtherEnvironments();
  if (!listing.ok) {
    return {
      kind: "warning",
      text: `Kept ${entry}, because Radius couldn't read this repository's environments (${listing.reason}). ${byHand}`
    };
  }
  const sharing = listing.environments
    .filter((environment) =>
      usesCluster(environment, { accountId, region, cluster })
    )
    .map((environment) => environment.name);
  if (sharing.length > 0) {
    return {
      kind: "kept",
      text: `${entry}, because ${namesList(sharing)} that cluster`
    };
  }
  const recorded = listing.environments.flatMap(
    (environment) => environment.trustSubjects
  );
  if (!trustAllowsOnlySubjects(request.remainingTrust, accountId, recorded)) {
    return {
      kind: "kept",
      text: `${entry}, because the role's trust policy lets in more than this repository's other environments. ${byHand}`
    };
  }
  return deleteAccessEntry(request, ports);
}

// An access entry whose role is gone grants nothing: EKS ties an entry to the
// role's unique ID, and a role created later with the same name is a different
// principal. EKS doesn't remove it with the role, so remove the one setup
// tagged, and name any other. When a role was created again under the name,
// `replacedAt` is its creation time: only an entry older than that role is
// the old role's, since a newer one may be the new role's working entry.
async function removeOrphanedAccessEntry(
  target: AccessEntryTarget,
  ports: Pick<AwsDeployIdentityRemovalPorts, "runAws">,
  replacedAt?: unknown
): Promise<AccessEntryOutcome> {
  if (!target.cluster || !target.region) return { kind: "absent" };
  const found = await readAccessEntry(target, ports);
  if (found.kind === "absent") return found;
  if (replacedAt !== undefined && found.kind === "present") {
    const entryMs = Date.parse(String(found.createdAt ?? ""));
    const roleMs = Date.parse(String(replacedAt ?? ""));
    if (!(entryMs < roleMs)) {
      return {
        kind: "kept",
        text: `${entryLabel(target)}, because IAM role ${target.roleName} was created again and Radius can't show this entry is older than it, so it may be the new role's. If nothing uses it, run: ${deleteEntryCommand(target)}`
      };
    }
  }
  const remove = `It grants nothing now that the role is gone. To remove it, run: ${deleteEntryCommand(target)}`;
  if (found.kind === "unreadable") {
    return {
      kind: "warning",
      text: `Kept ${entryLabel(target)}, because Radius couldn't read it (${found.detail}). ${remove}`
    };
  }
  if (!found.tagged) {
    return {
      kind: "warning",
      text: `Kept ${entryLabel(target)}, because it doesn't have the Radius tag. ${remove}`
    };
  }
  return deleteAccessEntry(target, ports);
}

// The repository's app-roles policy serves all its environments on the role,
// so it goes with the last environment policy. The listing leaves out
// `deletedPolicy`, which IAM may still show just after the delete.
async function removeUnusedAppRolesPolicy(
  roleName: string,
  repoId: number,
  deletedPolicy: string,
  ports: Pick<AwsDeployIdentityRemovalPorts, "runAws">
): Promise<AccessEntryOutcome> {
  const policyName = buildAwsAppRolesPolicyName(repoId);
  const label = `policy ${policyName}`;
  const deleteCommand = `aws iam delete-role-policy --role-name ${roleName} --policy-name ${policyName}`;
  const listed = await ports.runAws([
    "iam",
    "list-role-policies",
    "--role-name",
    roleName,
    "--output",
    "json"
  ]);
  const output = succeeded(listed) ? parseJson(listed.stdout) : null;
  const names =
    isRecord(output) && Array.isArray(output.PolicyNames) ?
      output.PolicyNames.filter(
        (name): name is string => typeof name === "string"
      )
    : null;
  if (names === null) {
    return {
      kind: "warning",
      text: `Kept ${label} on ${roleName}, because Radius couldn't list the role's policies (${succeeded(listed) ? "IAM returned no policy names" : detail(listed)}). If no environment of this repository uses the role, run: ${deleteCommand}`
    };
  }
  if (!names.includes(policyName)) return { kind: "absent" };
  if (
    names.some(
      (name) =>
        name !== deletedPolicy && isAwsEnvironmentPolicyName(name, repoId)
    )
  ) {
    return {
      kind: "kept",
      text: `${label} on ${roleName}, because other environments of this repository still use the role`
    };
  }
  const deletion = await ports.runAws([
    "iam",
    "delete-role-policy",
    "--role-name",
    roleName,
    "--policy-name",
    policyName
  ]);
  if (succeeded(deletion)) return { kind: "removed", text: label };
  if (NO_SUCH_ENTITY.test(deletion.stderr)) return { kind: "absent" };
  return {
    kind: "failed",
    message: `Failed to delete ${label} from ${roleName}: ${detail(deletion)}.`
  };
}

// Delete the environment's app boundary unless another repository owns the
// policy at its ARN. IAM refuses to delete one an app role still uses.
async function removeAppBoundary(
  arn: string,
  request: Pick<
    AwsDeployIdentityRemovalRequest,
    "repo" | "repoId" | "environment"
  >,
  ports: Pick<AwsDeployIdentityRemovalPorts, "runAws">
): Promise<AccessEntryOutcome> {
  const label = `permissions boundary ${arn}`;
  const deleteCommand = `aws iam delete-policy --policy-arn ${arn}`;
  const read = await readAppBoundary(ports, arn);
  if (!read.ok) {
    return {
      kind: "warning",
      text: `Kept ${label}. ${read.message} If no app role in environment ${request.environment} uses it, run: ${deleteCommand}`
    };
  }
  if (read.policy === null) return { kind: "absent" };
  if (radiusRoleRepositoryId(read.policy) !== request.repoId) {
    return {
      kind: "kept",
      text: `${label}, because Radius did not create it for ${request.repo}`
    };
  }
  const deletion = await ports.runAws([
    "iam",
    "delete-policy",
    "--policy-arn",
    arn
  ]);
  if (succeeded(deletion)) return { kind: "removed", text: label };
  if (NO_SUCH_ENTITY.test(deletion.stderr)) return { kind: "absent" };
  if (DELETE_CONFLICT.test(deletion.stderr)) {
    return {
      kind: "warning",
      text: `Kept ${label}, because IAM reported it is still in use (${detail(deletion)}). Delete the environment's apps, then run: ${deleteCommand}`
    };
  }
  return {
    kind: "failed",
    message: `Failed to delete ${label}: ${detail(deletion)}.`
  };
}

function stoppedPartWay(
  failure: string,
  removed: readonly string[],
  remaining: readonly string[]
): AwsDeployIdentityRemovalResult {
  const done =
    removed.length > 0 ?
      `Removed ${removed.join(", ")}.`
    : "Nothing was removed.";
  return {
    ok: false,
    message: `${failure} ${done} Still there: ${remaining.join(", ")}. Retry removes what's still there.`
  };
}

/**
 * Remove what one environment added to the shared role: its trust subjects,
 * its permission policy, its app permissions boundary when no app role uses
 * it, and its cluster's access entry when nothing else uses it. The
 * repository's app-roles policy goes with its last environment. The role and
 * the account's GitHub identity provider always stay, because other
 * environments, repositories, or services may use them. The lock is taken
 * after the account check and released by the caller.
 */
export async function removeAwsEnvironmentFromRole(
  request: AwsDeployIdentityRemovalRequest,
  ports: AwsDeployIdentityRemovalPorts
): Promise<AwsDeployIdentityRemovalResult> {
  const parsed = parseAwsRoleArn(request.roleArn);
  if (!parsed) {
    return {
      ok: false,
      message: `"${request.roleArn}" is not an IAM role ARN, so Radius could not tell which role to clean up.`
    };
  }
  const { accountId, roleName } = parsed;
  if (parsed.partition !== "aws") {
    return {
      ok: false,
      message: `IAM role ${request.roleArn} is outside the commercial AWS partition, so Radius did not change it.`
    };
  }
  // IAM addresses the role by name in whichever account the CLI is signed in
  // to, so confirm that is the role's account before reading or writing.
  const session = await verifyAwsCliSession({ accountId }, ports.runAws);
  if (!session.ok) return { ok: false, message: session.message };
  const locked = await ports.acquireLock({ accountId, roleName });
  if (!locked.ok) return { ok: false, message: locked.message };
  const getRole = await ports.runAws([
    "iam",
    "get-role",
    "--role-name",
    roleName,
    "--output",
    "json"
  ]);
  const entryTarget = {
    roleArn: request.roleArn.trim(),
    roleName,
    region: request.region.trim(),
    cluster: request.cluster.trim()
  };
  const boundaryArn = awsAppBoundary(
    accountId,
    request.repoId,
    request.environment
  ).arn;
  const boundaryLabel = `permissions boundary ${boundaryArn}`;
  if (!succeeded(getRole)) {
    if (NO_SUCH_ENTITY.test(getRole.stderr)) {
      const boundary = await removeAppBoundary(boundaryArn, request, ports);
      if (boundary.kind === "failed") {
        return stoppedPartWay(
          boundary.message,
          [],
          [boundaryLabel, entryLabel(entryTarget)]
        );
      }
      const orphan = await removeOrphanedAccessEntry(entryTarget, ports);
      const removed = boundary.kind === "removed" ? [boundary.text] : [];
      if (orphan.kind === "failed") {
        return stoppedPartWay(orphan.message, removed, [
          entryLabel(entryTarget)
        ]);
      }
      return {
        ok: true,
        removed:
          orphan.kind === "removed" ? [...removed, orphan.text] : removed,
        kept: boundary.kind === "kept" ? [boundary.text] : [],
        warnings: [
          `IAM role ${roleName} was already gone, so there was nothing to remove from it.`,
          ...[boundary, orphan].flatMap((outcome) =>
            outcome.kind === "warning" ? [outcome.text] : []
          )
        ]
      };
    }
    return {
      ok: false,
      message: `Could not read IAM role ${roleName} (${detail(getRole)}). Nothing was changed.`
    };
  }
  const roleRecord = parseJson(getRole.stdout);
  const role =
    isRecord(roleRecord) && isRecord(roleRecord.Role) ? roleRecord.Role : {};
  const fetched =
    typeof role.Arn === "string" ? parseAwsRoleArn(role.Arn) : null;
  if (
    typeof role.Arn !== "string" ||
    !fetched ||
    fetched.partition !== parsed.partition ||
    fetched.accountId !== accountId ||
    fetched.roleName.toLowerCase() !== roleName.toLowerCase()
  ) {
    return {
      ok: false,
      message: `IAM returned ${typeof role.Arn === "string" ? role.Arn : "no role ARN"} for ${request.roleArn}, so Radius did not change it.`
    };
  }
  const policyName = awsEnvironmentPolicyName(
    request.repoId,
    request.environment
  );
  const policyLabel = `policy ${policyName}`;
  // Only a subject that names a repository and this environment is this
  // environment's alone. Any other, such as `repository_id:<id>` from a custom
  // OIDC template, is presented by other environments or repositories too.
  const owned = request.subjects.filter((subject) =>
    namesOneEnvironment(subject, request.environment)
  );
  let policy: PolicyDocument;
  let trusted: string[];
  const removedSubjects: string[] = [];
  try {
    policy = parsePolicyDocument(role.AssumeRolePolicyDocument);
    trusted = trustedGitHubSubjects(policy, accountId);
    for (const subject of owned) {
      const removal = removeGitHubTrustSubject(policy, accountId, subject);
      policy = removal.policy;
      if (removal.removed) removedSubjects.push(subject);
    }
  } catch (error) {
    return {
      ok: false,
      message: `Could not read the trust policy of IAM role ${roleName} (${error instanceof Error ? error.message : String(error)}). Nothing was changed. Fix the policy or your access and retry, or by hand ${owned.length > 0 ? `remove ${owned.join(", ")} from its trust policy and ` : ""}delete its ${policyLabel}.`
    };
  }
  const shared = request.subjects
    .filter((subject) => !owned.includes(subject) && trusted.includes(subject))
    .map(
      (subject) =>
        `Kept trust subject ${subject}, because it doesn't name one repository and the environment ${request.environment}, so other environments or repositories may present it too. If nothing else needs it, remove it from the role's trust policy by hand.`
    );
  const subjectLabels = removedSubjects.map(
    (subject) => `trust subject ${subject}`
  );
  const removed: string[] = [];
  const deletion = await ports.runAws([
    "iam",
    "delete-role-policy",
    "--role-name",
    roleName,
    "--policy-name",
    policyName
  ]);
  const policyRemoved = succeeded(deletion);
  if (!policyRemoved && !NO_SUCH_ENTITY.test(deletion.stderr)) {
    return {
      ok: false,
      message: `Failed to delete ${policyLabel} from ${roleName}: ${detail(deletion)}. Trust subjects were retained so deletion can be retried.`
    };
  }
  const failed = (message: string): AwsDeployIdentityRemovalResult => ({
    ok: false,
    message: policyRemoved ? `Removed ${policyLabel}. ${message}` : message
  });
  if (removedSubjects.length > 0) {
    const update = await ports.runAws([
      "iam",
      "update-assume-role-policy",
      "--role-name",
      roleName,
      "--policy-document",
      JSON.stringify(policy)
    ]);
    if (!succeeded(update)) {
      return failed(
        `Could not update the trust policy of IAM role ${roleName} (${detail(update)}). Trust subjects were retained so deletion can be retried.`
      );
    }
    removed.push(...subjectLabels);
    const unconfirmed = await awaitTrustVisible(
      ports,
      roleName,
      accountId,
      policy
    );
    if (unconfirmed) {
      return failed(`${unconfirmed} Retry the deletion.`);
    }
  }
  if (policyRemoved) removed.push(policyLabel);
  const kept = [
    `IAM role ${roleName}`,
    "the account's GitHub identity provider"
  ];
  const warnings = [...shared];
  const settle = (outcome: AccessEntryOutcome) => {
    if (outcome.kind === "removed") removed.push(outcome.text);
    if (outcome.kind === "kept") kept.push(outcome.text);
    if (outcome.kind === "warning") warnings.push(outcome.text);
  };
  const appRoles = await removeUnusedAppRolesPolicy(
    roleName,
    request.repoId,
    policyName,
    ports
  );
  if (appRoles.kind === "failed") {
    return stoppedPartWay(appRoles.message, removed, [
      `policy ${buildAwsAppRolesPolicyName(request.repoId)}`,
      boundaryLabel,
      entryLabel(entryTarget)
    ]);
  }
  settle(appRoles);
  const boundary = await removeAppBoundary(boundaryArn, request, ports);
  if (boundary.kind === "failed") {
    return stoppedPartWay(boundary.message, removed, [
      boundaryLabel,
      entryLabel(entryTarget)
    ]);
  }
  settle(boundary);
  const entry = await removeUnusedAccessEntry(
    {
      ...entryTarget,
      repo: request.repo,
      repository: { ok: true, repoId: request.repoId },
      role,
      roleArn: role.Arn,
      accountId,
      remainingTrust: policy
    },
    ports
  );
  if (entry.kind === "failed") {
    return stoppedPartWay(entry.message, removed, [entryLabel(entryTarget)]);
  }
  settle(entry);
  return { ok: true, removed, kept, warnings };
}

// One AWS change a setup recorded, as Roll back sees it.
// Every target names IAM's id for the role it was made on. A role with
// another id under the same name was deleted and created again since, so it
// is not the role this setup changed.
export type AwsSetupRollbackTarget =
  | {
      readonly key: string;
      readonly artifactType: "aws_role";
      readonly roleArn: string;
      readonly roleName: string;
      readonly roleId: string | null;
    }
  | {
      readonly key: string;
      readonly artifactType: "aws_trust_subject";
      readonly roleArn: string;
      readonly roleName: string;
      readonly roleId: string | null;
      readonly subject: string;
    }
  | {
      readonly key: string;
      readonly artifactType: "aws_role_policy";
      readonly roleArn: string;
      readonly roleName: string;
      readonly roleId: string | null;
      readonly policyName: string;
    }
  | {
      readonly key: string;
      readonly artifactType: "aws_app_boundary";
      readonly roleArn: string;
      readonly roleName: string;
      readonly roleId: string | null;
      readonly policyArn: string;
      readonly policyId: string;
    }
  | {
      readonly key: string;
      readonly artifactType: "aws_access_entry";
      readonly roleArn: string;
      readonly roleName: string;
      readonly roleId: string | null;
      readonly cluster: string;
      readonly region: string;
    };

// A change Radius kept or could not remove always says why.
export type AwsSetupRollbackOutcome =
  | {
      readonly key: string;
      readonly outcome: "deleted" | "not_found";
      readonly detail: null;
    }
  | {
      readonly key: string;
      readonly outcome: "skipped" | "warning";
      readonly detail: string;
    };

function rollbackOutcome(
  key: string,
  outcome: "deleted" | "not_found"
): AwsSetupRollbackOutcome;
function rollbackOutcome(
  key: string,
  outcome: "skipped" | "warning",
  detail: string
): AwsSetupRollbackOutcome;
function rollbackOutcome(
  key: string,
  outcome: AwsSetupRollbackOutcome["outcome"],
  detail: string | null = null
): AwsSetupRollbackOutcome {
  return { key, outcome, detail } as AwsSetupRollbackOutcome;
}

function entryOutcome(
  key: string,
  entry: AccessEntryOutcome
): AwsSetupRollbackOutcome {
  switch (entry.kind) {
    case "removed":
      return rollbackOutcome(key, "deleted");
    case "absent":
      return rollbackOutcome(key, "not_found");
    case "kept":
      return rollbackOutcome(key, "skipped", `Kept ${entry.text}.`);
    case "warning":
      return rollbackOutcome(key, "warning", entry.text);
    case "failed":
      return rollbackOutcome(key, "warning", entry.message);
  }
}

/**
 * Undo the AWS changes one setup recorded on one role, in reverse order: the
 * access entry (by the same rule as environment delete), the permission
 * policies, the trust subjects, the permissions boundary, then the role. The
 * role goes only when setup created it, it is still that role, and nothing
 * else trusts or is attached to it. The account's GitHub identity provider
 * always stays. The lock is taken after the account check and released by the
 * caller.
 */
export async function rollbackAwsSetupChanges(
  request: {
    repo: string;
    // Proves a role Radius created is this repository's. Only the access
    // entry needs it, so a failed read keeps just that entry.
    repository: AwsRepositoryIdLookup;
    // The environment setup was for. Only a subject naming it is its own.
    environment: string;
    roleArn: string;
    targets: readonly AwsSetupRollbackTarget[];
  },
  ports: AwsDeployIdentityRemovalPorts,
  // Each outcome is added as soon as AWS answers, so a caller whose run is
  // cut short still holds every change that finished.
  outcomes: AwsSetupRollbackOutcome[] = [],
  // Awaited after each outcome AWS answered, before the next command, so the
  // caller can save it. A crash then loses no change AWS confirmed.
  onOutcome?: (outcome: AwsSetupRollbackOutcome) => Promise<void>
): Promise<AwsSetupRollbackOutcome[]> {
  const { targets } = request;
  const add = async (outcome: AwsSetupRollbackOutcome): Promise<void> => {
    outcomes.push(outcome);
    await onOutcome?.(outcome);
  };
  const everyTarget = (outcome: "skipped" | "warning", detail: string) => {
    for (const target of targets) {
      outcomes.push(rollbackOutcome(target.key, outcome, detail));
    }
    return outcomes;
  };
  const parsed = parseAwsRoleArn(request.roleArn);
  if (!parsed || parsed.partition !== "aws") {
    return everyTarget(
      "warning",
      `"${request.roleArn}" is not a commercial AWS IAM role ARN, so Radius did not change it.`
    );
  }
  const { accountId, roleName } = parsed;
  const roleTarget = targets.find(
    (target) => target.artifactType === "aws_role"
  );
  // Without IAM's ID, a role created again under the name looks the same as
  // the one setup changed, and its policies and trust would go with it.
  if (targets.some((target) => !target.roleId)) {
    return everyTarget(
      "skipped",
      `Radius didn't record IAM's ID for role ${roleName}, so it can't tell whether the role there now is the one this setup created. Nothing was changed. Check the role in the IAM console and remove what this setup added by hand.`
    );
  }
  const session = await verifyAwsCliSession({ accountId }, ports.runAws);
  if (!session.ok) return everyTarget("warning", session.message);
  const locked = await ports.acquireLock({ accountId, roleName });
  if (!locked.ok) return everyTarget("warning", locked.message);

  const entries = targets.filter(
    (target) => target.artifactType === "aws_access_entry"
  );
  const getRole = await ports.runAws([
    "iam",
    "get-role",
    "--role-name",
    roleName,
    "--output",
    "json"
  ]);
  // An entry whose role is gone grants nothing to anyone. When the role was
  // replaced, only an entry older than the new role is the old role's.
  const removeOrphanedEntries = async (replacedAt?: unknown) => {
    for (const entry of entries) {
      await add(
        entryOutcome(
          entry.key,
          await removeOrphanedAccessEntry(
            { ...entry, roleName },
            ports,
            replacedAt
          )
        )
      );
    }
  };
  // A boundary is separate from the role, and its policy ID shows whether it
  // is still the one this setup created, so it is undone whatever happened to
  // the role.
  const rollbackAppBoundaries = async () => {
    for (const target of targets) {
      if (target.artifactType === "aws_app_boundary") {
        await add(await rollbackAppBoundary(target, ports));
      }
    }
  };
  if (!succeeded(getRole)) {
    if (!NO_SUCH_ENTITY.test(getRole.stderr)) {
      return everyTarget(
        "warning",
        `Could not read IAM role ${roleName} (${detail(getRole)}). Nothing was changed.`
      );
    }
    await removeOrphanedEntries();
    await rollbackAppBoundaries();
    for (const target of targets) {
      if (
        target.artifactType !== "aws_access_entry" &&
        target.artifactType !== "aws_app_boundary"
      ) {
        await add(rollbackOutcome(target.key, "not_found"));
      }
    }
    return outcomes;
  }
  const roleRecord = parseJson(getRole.stdout);
  if (!isRecord(roleRecord) || !isRecord(roleRecord.Role)) {
    return everyTarget(
      "warning",
      `IAM did not describe role ${roleName}, so Radius changed nothing.`
    );
  }
  const role = roleRecord.Role;
  // Every target, not only the role, so a reused role created again keeps
  // its same-named policy and trust too.
  if (targets.some((target) => target.roleId !== role.RoleId)) {
    await removeOrphanedEntries(role.CreateDate ?? null);
    await rollbackAppBoundaries();
    const replaced = `IAM role ${roleName} was deleted and created again after this setup, so Radius left the new role and its policies as they are.`;
    for (const target of targets) {
      if (
        target.artifactType !== "aws_access_entry" &&
        target.artifactType !== "aws_app_boundary"
      ) {
        await add(rollbackOutcome(target.key, "skipped", replaced));
      }
    }
    return outcomes;
  }

  let policy: PolicyDocument;
  try {
    policy = parsePolicyDocument(role.AssumeRolePolicyDocument);
  } catch (error) {
    return everyTarget(
      "warning",
      `Could not read the trust policy of IAM role ${roleName} (${String(error)}). Nothing was changed.`
    );
  }
  const subjects = targets.flatMap((target) =>
    target.artifactType === "aws_trust_subject" ? [target] : []
  );
  const removedSubjects: typeof subjects = [];
  for (const target of subjects) {
    // The same rule as environment delete: a subject such as
    // `repository_id:<id>` from a custom OIDC template is presented by other
    // environments too, and a later setup may rely on it.
    if (!namesOneEnvironment(target.subject, request.environment)) {
      await add(
        rollbackOutcome(
          target.key,
          "skipped",
          `Kept trust subject ${target.subject}, because it doesn't name one repository and the environment ${request.environment}, so other environments or repositories may present it too. If nothing else needs it, remove it from the role's trust policy by hand.`
        )
      );
      continue;
    }
    const removal = removeGitHubTrustSubject(policy, accountId, target.subject);
    policy = removal.policy;
    if (removal.removed) removedSubjects.push(target);
    else await add(rollbackOutcome(target.key, "not_found"));
  }

  for (const entry of entries) {
    await add(
      entryOutcome(
        entry.key,
        await removeUnusedAccessEntry(
          {
            ...entry,
            roleName,
            repo: request.repo,
            repository: request.repository,
            role,
            accountId,
            remainingTrust: policy
          },
          ports
        )
      )
    );
  }

  let policiesKept = false;
  for (const target of targets) {
    if (target.artifactType !== "aws_role_policy") continue;
    const deletion = await ports.runAws([
      "iam",
      "delete-role-policy",
      "--role-name",
      roleName,
      "--policy-name",
      target.policyName
    ]);
    if (succeeded(deletion)) {
      await add(rollbackOutcome(target.key, "deleted"));
    } else if (NO_SUCH_ENTITY.test(deletion.stderr)) {
      await add(rollbackOutcome(target.key, "not_found"));
    } else {
      policiesKept = true;
      await add(
        rollbackOutcome(
          target.key,
          "warning",
          `Could not delete policy ${target.policyName} from IAM role ${roleName} (${detail(deletion)}).`
        )
      );
    }
  }

  let trustUpdated = removedSubjects.length === 0;
  if (removedSubjects.length > 0) {
    const update = await ports.runAws([
      "iam",
      "update-assume-role-policy",
      "--role-name",
      roleName,
      "--policy-document",
      JSON.stringify(policy)
    ]);
    const failure =
      succeeded(update) ?
        await awaitTrustVisible(ports, roleName, accountId, policy)
      : `Could not update the trust policy of IAM role ${roleName} (${detail(update)}).`;
    trustUpdated = !failure;
    for (const target of removedSubjects) {
      await add(
        failure ?
          rollbackOutcome(target.key, "warning", failure)
        : rollbackOutcome(target.key, "deleted")
      );
    }
  }

  await rollbackAppBoundaries();

  if (roleTarget) {
    await add(
      await deleteCreatedRole(roleTarget.key, roleName, policy, {
        ...ports,
        accountId,
        changesKept: policiesKept || !trustUpdated
      })
    );
  }
  return outcomes;
}

// Delete the permissions boundary setup created, unless IAM's policy there is
// another one now. IAM refuses to delete one an app role still uses.
async function rollbackAppBoundary(
  target: Extract<AwsSetupRollbackTarget, { artifactType: "aws_app_boundary" }>,
  ports: Pick<AwsDeployIdentityRemovalPorts, "runAws">
): Promise<AwsSetupRollbackOutcome> {
  const arn = target.policyArn;
  const label = `permissions boundary ${arn}`;
  const read = await readAppBoundary(ports, arn);
  if (!read.ok) return rollbackOutcome(target.key, "warning", read.message);
  if (read.policy === null) return rollbackOutcome(target.key, "not_found");
  if (read.policy.PolicyId !== target.policyId) {
    return rollbackOutcome(
      target.key,
      "skipped",
      `Kept ${label}, because it was deleted and created again after this setup.`
    );
  }
  const deletion = await ports.runAws([
    "iam",
    "delete-policy",
    "--policy-arn",
    arn
  ]);
  if (succeeded(deletion)) return rollbackOutcome(target.key, "deleted");
  if (NO_SUCH_ENTITY.test(deletion.stderr)) {
    return rollbackOutcome(target.key, "not_found");
  }
  return rollbackOutcome(
    target.key,
    "warning",
    `Could not delete ${label} (${detail(deletion)}).`
  );
}

// Delete the role setup created, unless anything else still depends on it.
async function deleteCreatedRole(
  key: string,
  roleName: string,
  trust: PolicyDocument,
  ports: Pick<AwsDeployIdentityRemovalPorts, "runAws"> & {
    accountId: string;
    changesKept: boolean;
  }
): Promise<AwsSetupRollbackOutcome> {
  // A role kept until a failed step succeeds is a warning, so Retry deletion
  // tries it again. One kept because something else uses it is skipped.
  const keep = (reason: string, outcome: "skipped" | "warning" = "skipped") =>
    rollbackOutcome(
      key,
      outcome,
      `Kept IAM role ${roleName}, because ${reason}. ${
        outcome === "warning" ?
          "Retry deletion to try again."
        : "Delete it in the IAM console if nothing needs it."
      }`
    );
  if (ports.changesKept) {
    return keep(
      "Radius could not remove everything this setup added to it",
      "warning"
    );
  }
  // Fail closed, as delete does: any principal the trust policy still lets
  // in, a GitHub subject or not, may be using the role.
  if (!trustAllowsOnlySubjects(trust, ports.accountId, [])) {
    return keep("its trust policy still lets other principals assume it");
  }
  for (const [command, field, noun] of [
    ["list-role-policies", "PolicyNames", "inline"],
    ["list-attached-role-policies", "AttachedPolicies", "attached"]
  ] as const) {
    const listed = await ports.runAws([
      "iam",
      command,
      "--role-name",
      roleName,
      "--output",
      "json"
    ]);
    const record = parseJson(listed.stdout);
    const items =
      succeeded(listed) && isRecord(record) && Array.isArray(record[field]) ?
        record[field]
      : null;
    if (items === null) {
      return keep(
        `Radius could not list its ${noun} policies (${detail(listed)})`,
        "warning"
      );
    }
    if (items.length > 0) return keep(`it has other ${noun} policies`);
  }
  const deletion = await ports.runAws([
    "iam",
    "delete-role",
    "--role-name",
    roleName
  ]);
  if (succeeded(deletion)) return rollbackOutcome(key, "deleted");
  if (NO_SUCH_ENTITY.test(deletion.stderr)) {
    return rollbackOutcome(key, "not_found");
  }
  return rollbackOutcome(
    key,
    "warning",
    `Could not delete IAM role ${roleName} (${detail(deletion)}).`
  );
}

export interface AwsTrustRepairRequest {
  // The repository whose deploy failed.
  repo: string;
  // GitHub's ID for the repository. It names the environment's policy and
  // proves a role Radius created is this repository's.
  repoId: number;
  // The environment whose deploy failed, as GitHub stores its name.
  environment: string;
  // AWS_ROLE_ARN as the GitHub environment states it. Untrusted: anyone who
  // can edit the environment's variables can point it at any role.
  roleArn: string;
  // Every subject the environment's workflows may present, worked out from
  // GitHub for this repository and environment, never read from a variable.
  subjects: readonly string[];
  // The repository's OIDC subject customization the subjects were built from.
  subjectConfig: OidcSubjectConfig;
}

// Why Repair may not add this environment's trust back, or null when the role
// shows that setup ran for this environment of this repository. Repair only
// restores trust: a GitHub variable names the role, and anyone who can edit
// it could otherwise give a new environment, without the reviewers or branch
// rules of the one it copies, a way into that role.
async function repairEvidenceProblem(
  ports: Pick<AwsDeployIdentityPorts, "runAws">,
  role: Record<string, unknown>,
  trust: PolicyDocument,
  accountId: string,
  roleName: string,
  request: AwsTrustRepairRequest
): Promise<{ code: string; message: string } | null> {
  const owner = radiusRoleRepositoryId(role);
  const setUpHint = `If environment ${request.environment} should deploy with this role, set it up on the Environments page, which adds its trust and permissions.`;
  if (owner !== null && owner !== request.repoId) {
    return {
      code: "aws-role-not-this-repository",
      message: `Radius created IAM role ${roleName} for ${describeRadiusRoleOwner(role)}, not ${request.repo} (repository ID ${request.repoId}), so Repair will not add trust to it. Nothing was changed. Check that the environment's AWS_ROLE_ARN names the right role.`
    };
  }
  // Setup refuses a role Radius created for another repository, so on one
  // created for this repository, only this repository's setup wrote the
  // environment's policy. On any other role the policy's name does not say
  // which repository wrote it, so this environment must still be trusted in
  // some form.
  if (owner === null) {
    const accepted = acceptedGitHubSubjects(trust, accountId);
    if (!request.subjects.some((subject) => accepted.includes(subject))) {
      return {
        code: "aws-role-not-this-repository",
        message: `IAM role ${roleName} was not created by Radius for ${request.repo}, and it no longer trusts environment ${request.environment} in any form, so Radius cannot tell that this repository set the environment up on it. Nothing was changed. ${setUpHint}`
      };
    }
  }
  const policyName = awsEnvironmentPolicyName(
    request.repoId,
    request.environment
  );
  const policy = await ports.runAws([
    "iam",
    "get-role-policy",
    "--role-name",
    roleName,
    "--policy-name",
    policyName,
    "--output",
    "json"
  ]);
  if (succeeded(policy)) return null;
  return NO_SUCH_ENTITY.test(policy.stderr) ?
      {
        code: "aws-environment-not-set-up",
        message: `IAM role ${roleName} has no permission policy ${policyName} for environment ${request.environment}, so setup never ran for it on this role, and Repair only restores trust that setup added. Nothing was changed. ${setUpHint}`
      }
    : {
        code: "aws-role-policy-unreadable",
        message: `Could not read permission policy ${policyName} on IAM role ${roleName}, so Radius cannot tell that setup ran for environment ${request.environment} on it: ${detail(policy)}. Nothing was changed.`
      };
}

export type AwsTrustRepairResult =
  | {
      readonly ok: true;
      readonly roleName: string;
      // The subjects that were missing and are now trusted again. Empty when
      // the role already trusted every subject.
      readonly added: readonly string[];
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Add back the subjects an environment's deploys present but the role no
 * longer trusts, for example after someone edited the trust policy by hand.
 * Nothing else on the role changes. Only adds; a subject is never removed.
 */
export async function repairAwsEnvironmentTrust(
  request: AwsTrustRepairRequest,
  ports: Pick<AwsDeployIdentityPorts, "runAws" | "acquireLock" | "sleep">
): Promise<AwsTrustRepairResult> {
  const parsed = parseAwsRoleArn(request.roleArn);
  if (!parsed) {
    return {
      ok: false,
      code: "aws-role-invalid",
      message: `This environment's AWS_ROLE_ARN, "${request.roleArn}", is not an IAM role ARN, so Radius cannot tell which role to repair.`
    };
  }
  const { accountId, roleName } = parsed;
  if (parsed.partition !== "aws") {
    return {
      ok: false,
      code: "aws-partition-unsupported",
      message: `IAM role ${request.roleArn} is outside the commercial AWS partition, so Radius did not change it.`
    };
  }
  const session = await signedInAccountProblem(
    ports,
    accountId,
    roleName,
    "repair"
  );
  if (session) return { ok: false, ...session };

  // Restoring trust does nothing if the account no longer has the GitHub
  // identity provider the trust names, so check that first.
  const providerArn = githubOidcProviderArn(accountId);
  const provider = await ports.runAws([
    "iam",
    "get-open-id-connect-provider",
    "--open-id-connect-provider-arn",
    providerArn,
    "--output",
    "json"
  ]);
  if (!succeeded(provider)) {
    return NO_SUCH_ENTITY.test(provider.stderr) ?
        {
          ok: false,
          code: "aws-oidc-provider-missing",
          message: `Account ${accountId} no longer has the GitHub identity provider, so GitHub workflows cannot sign in to any role. Nothing was changed. Ask an IAM administrator to run: ${createGitHubOidcProviderCommand()}`
        }
      : {
          ok: false,
          code: "aws-oidc-provider-unreadable",
          message: `Could not read the account's GitHub identity provider: ${detail(provider)}`
        };
  }
  const providerRecord = parseJson(provider.stdout);
  if (
    !isRecord(providerRecord) ||
    !Array.isArray(providerRecord.ClientIDList) ||
    !providerRecord.ClientIDList.includes(GITHUB_OIDC_AUDIENCE)
  ) {
    return {
      ok: false,
      code: "aws-oidc-provider-audience",
      message: `The GitHub identity provider in account ${accountId} does not accept the ${GITHUB_OIDC_AUDIENCE} audience, so GitHub workflows cannot sign in. Nothing was changed. Ask an IAM administrator to run: aws iam add-client-id-to-open-id-connect-provider --open-id-connect-provider-arn ${providerArn} --client-id ${GITHUB_OIDC_AUDIENCE}`
    };
  }

  const locked = await ports.acquireLock({ accountId, roleName });
  if (!locked.ok) return locked;
  const getRole = await ports.runAws([
    "iam",
    "get-role",
    "--role-name",
    roleName,
    "--output",
    "json"
  ]);
  if (!succeeded(getRole)) {
    return NO_SUCH_ENTITY.test(getRole.stderr) ?
        {
          ok: false,
          code: "aws-role-missing",
          message: `IAM role ${roleName} no longer exists, so there is no trust to repair. Delete this environment and create it again to get a new deploy role.`
        }
      : {
          ok: false,
          code: "aws-role-unreadable",
          message: `Could not read IAM role ${roleName}: ${detail(getRole)}`
        };
  }
  const roleRecord = parseJson(getRole.stdout);
  const role =
    isRecord(roleRecord) && isRecord(roleRecord.Role) ? roleRecord.Role : {};
  // IAM finds a role by name alone, but a deploy signs in with the full ARN,
  // path included. A different path means deploys name a role that does not
  // exist, and trust added here would not help them.
  const actualArn = typeof role.Arn === "string" ? role.Arn : "";
  if (actualArn !== request.roleArn.trim()) {
    return {
      ok: false,
      code: "aws-role-arn-mismatch",
      message: `This environment's AWS_ROLE_ARN is ${request.roleArn.trim()}, but the IAM role named ${roleName} is ${actualArn || "(no ARN reported)"}, so deploys cannot sign in to it whatever it trusts. Nothing was changed. Set AWS_ROLE_ARN to the role's ARN.`
    };
  }
  let existing: PolicyDocument;
  try {
    existing = parsePolicyDocument(role.AssumeRolePolicyDocument);
  } catch (error) {
    return {
      ok: false,
      code: "aws-role-trust-unreadable",
      message: `Could not read the trust policy of IAM role ${roleName}, so Radius did not change it: ${String(error)}`
    };
  }
  const added = request.subjects.filter(
    (subject) => mergeGitHubTrustSubject(existing, accountId, subject).changed
  );
  if (added.length === 0) return { ok: true, roleName, added };
  // A subject without the repository in it is one every repository with the
  // same claims can present, so trusting it would let them sign in too.
  const shared = added.filter((subject) => !subjectNamesRepository(subject));
  if (shared.length > 0) {
    return {
      ok: false,
      code: "aws-subject-not-repository-specific",
      message: repositoryLessSubjectMessage(
        shared,
        request.repo,
        request.subjectConfig
      )
    };
  }
  // A subject the role still covers, by name or pattern, under conditions
  // Radius cannot read, such as a source IP, was not removed. A new statement
  // without those conditions would widen access.
  const restricted = restrictedGitHubSubjects(existing, accountId, added);
  if (restricted.length > 0) {
    return {
      ok: false,
      code: "aws-role-trust-restricted",
      message: `IAM role ${roleName} still covers ${restricted.join(", ")} in its trust policy, under conditions Radius cannot check, so Repair would widen access rather than restore it. Nothing was changed. Check those conditions in the role's trust policy.`
    };
  }
  const unproven = await repairEvidenceProblem(
    ports,
    role,
    existing,
    accountId,
    roleName,
    request
  );
  if (unproven) return { ok: false, ...unproven };
  const trust = mergeGitHubTrustSubjects(existing, accountId, added);
  const update = await ports.runAws([
    "iam",
    "update-assume-role-policy",
    "--role-name",
    roleName,
    "--policy-document",
    JSON.stringify(trust.policy)
  ]);
  if (!succeeded(update)) {
    return LIMIT_EXCEEDED.test(update.stderr) ?
        {
          ok: false,
          code: "aws-role-limit-exceeded",
          message: `IAM role ${roleName} cannot trust this environment again: its trust policy is at IAM's size limit (${detail(update)}). Nothing was changed. Delete an environment that no longer uses this role, or ask an AWS administrator to raise the "Role trust policy length" quota (up to 8,192 characters).`
        }
      : {
          ok: false,
          code: "aws-role-trust-denied",
          message: `Failed to update the trust policy of IAM role ${roleName}: ${detail(update)}`
        };
  }
  const unconfirmed = await awaitTrustVisible(
    ports,
    roleName,
    accountId,
    trust.policy
  );
  if (unconfirmed) {
    return {
      ok: false,
      code: "aws-role-trust-unconfirmed",
      message: `${unconfirmed} Run Repair again.`
    };
  }
  return { ok: true, roleName, added };
}
