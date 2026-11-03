import {
  AWS_EKS_CLUSTER_ADMIN_POLICY_ARN,
  AWS_MANAGED_TAG,
  AWS_REPOSITORY_TAG,
  GITHUB_OIDC_AUDIENCE,
  GITHUB_OIDC_PROVIDER_URL,
  GITHUB_OIDC_THUMBPRINT,
  buildAwsEnvironmentPermissionPolicy,
  buildAwsEnvironmentPolicyName,
  buildGitHubTrustPolicy,
  AWS_CLI_MINIMUM_VERSION,
  awsRoleArn,
  checkAwsCliVersion,
  configMapClusterMessage,
  eksAcceptsAccessEntries,
  eksAuthenticationMode,
  createGitHubOidcProviderCommand,
  githubOidcProviderArn,
  isAwsCommercialRegion,
  acceptedGitHubSubjects,
  isRadiusManagedRole,
  mergeGitHubTrustSubject,
  parseAwsRoleArn,
  parsePolicyDocument,
  radiusRoleRepository,
  removeGitHubTrustSubject,
  restrictedGitHubSubjects,
  sameRepositorySubjects,
  subjectNamesRepository,
  trustedGitHubSubjects,
  type PolicyDocument
} from "@radius-project/core";

// Sets up the AWS deploy identity for one environment: the account's GitHub
// identity provider, the repository's IAM role and its trust in this
// environment's GitHub subject, the environment's permission policy, and
// cluster-admin on the target EKS cluster through an access entry.
//
// Every check that cannot change anything runs first. Nothing is written to
// AWS until the CLI version, the signed-in account, and the cluster's auth
// mode are known to be usable.

export interface AwsCommandResult {
  code: number | string;
  stdout: string;
  stderr: string;
  // The CLI ran past its time limit and was stopped, so its output is empty.
  timedOut?: boolean;
}

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

export interface AwsDeployIdentityRequest {
  repo: string;
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

export type AwsDeployIdentityResult =
  | {
      readonly ok: true;
      readonly roleArn: string;
      readonly roleCreated: boolean;
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

const ACCESS_DENIED = /AccessDenied|UnauthorizedOperation|not authorized/i;
const NO_SUCH_ENTITY = /NoSuchEntity/;
const RESOURCE_IN_USE = /ResourceInUseException/;

const LIMIT_EXCEEDED = /LimitExceeded/;

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
  ports: AwsDeployIdentityPorts
): Promise<AwsDeployIdentityResult> {
  const created: string[] = [];
  const fail = (code: string, message: string): AwsDeployIdentityResult => ({
    ok: false,
    code,
    message,
    created: [...created]
  });
  const { accountId, region, cluster } = request;
  const regionArgs = ["--region", region];
  // The ARNs below are built for the commercial partition, so a GovCloud or
  // China region would fail part way through, after the first write.
  if (!isAwsCommercialRegion(region)) {
    return fail(
      "aws-partition-unsupported",
      `Radius sets up AWS environments in commercial AWS regions only, and ${region} is not one. Nothing was changed.`
    );
  }

  const version = await ports.runAws(["--version"]);
  const versionCheck = checkAwsCliVersion(
    `${version.stdout} ${version.stderr}`.trim()
  );
  if (!succeeded(version) || !versionCheck.ok) {
    return fail(
      "aws-cli-unsupported",
      versionCheck.ok ?
        `Could not run the AWS CLI: ${detail(version)}`
      : versionCheck.message
    );
  }
  ports.step(
    `✅ AWS CLI ${versionCheck.version} meets the ${AWS_CLI_MINIMUM_VERSION} minimum.`
  );

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
    return fail(
      "aws-cli-login-required",
      `No active AWS CLI session. Run "aws sso login" (or "aws configure"), then retry. ${detail(identity)}`
    );
  }
  if (sessionAccount !== accountId) {
    return fail(
      "aws-account-mismatch",
      `Your AWS CLI session is signed in to account ${sessionAccount || "(unknown)"}, but this environment's profile is for account ${accountId}. Nothing was changed.`
    );
  }

  const describe = await ports.runAws([
    "eks",
    "describe-cluster",
    "--name",
    cluster,
    ...regionArgs,
    "--output",
    "json"
  ]);
  if (!succeeded(describe)) {
    return fail(
      "aws-cluster-unreadable",
      `Could not read EKS cluster ${cluster} in ${region}: ${detail(describe)}`
    );
  }
  const authenticationMode = eksAuthenticationMode(parseJson(describe.stdout));
  if (!eksAcceptsAccessEntries(authenticationMode)) {
    return fail(
      "aws-cluster-config-map",
      configMapClusterMessage(cluster, region)
    );
  }
  ports.step(
    `✅ Cluster ${cluster} accepts access entries (${authenticationMode}).`
  );

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
  if (!pickedArn && role && !isRadiusManagedRole(role, request.repo)) {
    return fail(
      "aws-role-not-radius-managed",
      `An IAM role named ${roleName} already exists, but Radius did not create it for ${request.repo}. No change was made. Either select that role deliberately with "use an existing role…", or choose a different name.`
    );
  }
  // A role Radius created belongs to the repository in its tags, and that
  // repository's own setup and cleanup assume no other repository uses it.
  const owner = pickedArn ? radiusRoleRepository(role) : null;
  if (owner !== null && owner.toLowerCase() !== request.repo.toLowerCase()) {
    return fail(
      "aws-role-other-repository",
      `Radius created IAM role ${roleName} for ${owner}, so it cannot be used for ${request.repo}. Nothing was changed. Pick another role or let Radius create one.`
    );
  }

  // Read the existing role's trust before anything is written, so a policy
  // Radius cannot read stops setup with nothing created.
  let trust: ReturnType<typeof mergeGitHubTrustSubjects> | null = null;
  if (!roleMissing) {
    try {
      trust = mergeGitHubTrustSubjects(
        parsePolicyDocument(role?.AssumeRolePolicyDocument),
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
      !/EntityAlreadyExists/.test(createProvider.stderr)
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
  if (!trust) {
    const createRole = await ports.runAws([
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
      "--output",
      "json"
    ]);
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
      const updateTrust = await ports.runAws([
        "iam",
        "update-assume-role-policy",
        "--role-name",
        roleName,
        "--policy-document",
        JSON.stringify(trust.policy)
      ]);
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

  const policyName = buildAwsEnvironmentPolicyName(request.environment);
  const putPolicy = await ports.runAws([
    "iam",
    "put-role-policy",
    "--role-name",
    roleName,
    "--policy-name",
    policyName,
    "--policy-document",
    JSON.stringify(buildAwsEnvironmentPermissionPolicy(region))
  ]);
  if (!succeeded(putPolicy)) {
    return LIMIT_EXCEEDED.test(putPolicy.stderr) ?
        fail(
          "aws-role-limit-exceeded",
          `IAM role ${roleName} cannot hold another environment's permission policy: its inline policies are at IAM's 10,240-character limit, which cannot be raised (${detail(putPolicy)}). Delete an environment that no longer uses this role, or choose another role.`
        )
      : fail(
          "aws-role-policy-failed",
          `Failed to attach the deploy permission policy: ${detail(putPolicy)}`
        );
  }
  created.push(`policy ${policyName} on ${roleName}`);
  ports.step(
    `✅ Attached deploy permission policy ${policyName}, limited to ${region}.`
  );

  const entryArgs = [
    "--cluster-name",
    cluster,
    "--principal-arn",
    roleArn,
    ...regionArgs
  ];
  const createAccessEntry = async (): Promise<AwsCommandResult> => {
    const args = [
      "eks",
      "create-access-entry",
      ...entryArgs,
      "--type",
      "STANDARD"
    ];
    let result = await ports.runAws(args);
    for (const delay of ACCESS_ENTRY_RETRY_DELAYS_MS) {
      if (succeeded(result) || !PRINCIPAL_NOT_YET_VISIBLE.test(result.stderr)) {
        break;
      }
      ports.step(
        `ℹ️ EKS does not see role ${roleName} yet. Retrying in ${delay / 1000}s.`
      );
      await ports.sleep(delay);
      result = await ports.runAws(args);
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
  return { ok: true, roleArn, roleCreated };
}

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
  roleArn: string;
  environment: string;
  subjects: readonly string[];
}

export type AwsDeployIdentityRemovalResult =
  | {
      readonly ok: true;
      readonly removed: readonly string[];
      readonly kept: readonly string[];
    }
  | { readonly ok: false; readonly message: string };

/**
 * Remove what one environment added to the shared role: its trust subject and
 * its permission policy. The role, its access entry, and the account's GitHub
 * identity provider stay, because other environments may still need them. The
 * lock is taken after the account check and released by the caller.
 */
export async function removeAwsEnvironmentFromRole(
  request: AwsDeployIdentityRemovalRequest,
  ports: Pick<AwsDeployIdentityPorts, "runAws" | "acquireLock" | "sleep">
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
  const session = await signedInAccountProblem(
    ports,
    accountId,
    roleName,
    "clean up"
  );
  if (session) return { ok: false, message: session.message };
  const removed: string[] = [];
  const kept = [
    `IAM role ${roleName}`,
    "the account's GitHub identity provider"
  ];
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
  if (!succeeded(getRole)) {
    if (NO_SUCH_ENTITY.test(getRole.stderr)) {
      return {
        ok: true,
        removed: [],
        kept: [`IAM role ${roleName} was already gone`]
      };
    }
    return {
      ok: false,
      message: `Could not read IAM role ${roleName}: ${detail(getRole)}`
    };
  }
  const roleRecord = parseJson(getRole.stdout);
  const role =
    isRecord(roleRecord) && isRecord(roleRecord.Role) ? roleRecord.Role : {};
  const fetched =
    typeof role.Arn === "string" ? parseAwsRoleArn(role.Arn) : null;
  if (
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
  let policy: PolicyDocument;
  const removedSubjects: string[] = [];
  try {
    policy = parsePolicyDocument(role.AssumeRolePolicyDocument);
    for (const subject of request.subjects) {
      const removal = removeGitHubTrustSubject(policy, accountId, subject);
      policy = removal.policy;
      if (removal.removed) removedSubjects.push(subject);
    }
  } catch (error) {
    return {
      ok: false,
      message: `Could not read the trust policy of IAM role ${roleName}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
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
      return {
        ok: false,
        message: `Failed to remove ${removedSubjects.join(", ")} from the role's trust policy: ${detail(update)}`
      };
    }
    removed.push(
      ...removedSubjects.map((subject) => `trust subject ${subject}`)
    );
    const unconfirmed = await awaitTrustVisible(
      ports,
      roleName,
      accountId,
      policy
    );
    if (unconfirmed) {
      return { ok: false, message: `${unconfirmed} Retry the deletion.` };
    }
  }
  const policyName = buildAwsEnvironmentPolicyName(request.environment);
  const deletePolicy = await ports.runAws([
    "iam",
    "delete-role-policy",
    "--role-name",
    roleName,
    "--policy-name",
    policyName
  ]);
  if (succeeded(deletePolicy)) {
    removed.push(`policy ${policyName}`);
  } else if (!NO_SUCH_ENTITY.test(deletePolicy.stderr)) {
    return {
      ok: false,
      message: `Failed to delete policy ${policyName} from ${roleName}: ${detail(deletePolicy)}`
    };
  }
  return { ok: true, removed, kept };
}

export interface AwsTrustRepairRequest {
  // The repository whose deploy failed.
  repo: string;
  // AWS_ROLE_ARN as the GitHub environment states it. Untrusted: anyone who
  // can edit the environment's variables can point it at any role.
  roleArn: string;
  // Every subject the environment's workflows may present, worked out from
  // GitHub for this repository and environment, never read from a variable.
  subjects: readonly string[];
}

// Whether Repair may add this repository's subjects to the role. The role
// named by a GitHub variable could be any role in the account, so Repair only
// changes one that Radius tagged for this repository, or one that already
// lets another environment of it sign in, with the same subject claims.
function repairMayChangeRole(
  role: Record<string, unknown>,
  trust: PolicyDocument,
  accountId: string,
  request: AwsTrustRepairRequest
): boolean {
  if (isRadiusManagedRole(role, request.repo)) return true;
  return acceptedGitHubSubjects(trust, accountId).some((trusted) =>
    request.subjects.some((subject) => sameRepositorySubjects(subject, trusted))
  );
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
      message: `GitHub's OIDC subject for this environment, ${shared.join(", ")}, does not name the repository, so trusting it would let other repositories' workflows sign in to IAM role ${roleName}. Nothing was changed. Customize the repository's OIDC subject to include the repository, or add the subject to the role's trust policy yourself if that is intended.`
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
  if (!repairMayChangeRole(role, existing, accountId, request)) {
    return {
      ok: false,
      code: "aws-role-not-this-repository",
      message: `IAM role ${roleName} was not created by Radius for ${request.repo} and trusts no other environment of it, so Radius will not add trust to it. Nothing was changed. Check that the environment's AWS_ROLE_ARN names the right role; if it does, add ${added.join(", ")} to its trust policy yourself.`
    };
  }
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
