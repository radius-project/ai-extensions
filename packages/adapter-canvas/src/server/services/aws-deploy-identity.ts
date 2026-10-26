import {
  AWS_EKS_CLUSTER_ADMIN_POLICY_ARN,
  AWS_MANAGED_TAG,
  AWS_REPOSITORY_TAG,
  GITHUB_OIDC_AUDIENCE,
  GITHUB_OIDC_HOST,
  GITHUB_OIDC_PROVIDER_URL,
  GITHUB_OIDC_THUMBPRINT,
  buildAwsEnvironmentPermissionPolicy,
  buildAwsEnvironmentPolicyName,
  buildGitHubTrustPolicy,
  checkAwsCliVersion,
  configMapClusterMessage,
  createGitHubOidcProviderCommand,
  isRadiusManagedRole,
  mergeGitHubTrustSubject,
  parseAwsRoleArn,
  parsePolicyDocument,
  removeGitHubTrustSubject
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
}

export interface AwsDeployIdentityPorts {
  // Run `aws <args>`. Never throws; a spawn failure is a non-zero result.
  runAws(args: string[]): Promise<AwsCommandResult>;
  // Report one progress line under `Authorize deploy identity`.
  step(text: string): void;
  sleep(milliseconds: number): Promise<void>;
}

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
  // The GitHub OIDC subject this environment's workflows present.
  subject: string;
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
  return (result.stderr || result.stdout || "").trim() || "no output";
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
  ports.step(`✅ AWS CLI ${versionCheck.version} meets the 2.15.3 minimum.`);

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
  const clusterRecord = parseJson(describe.stdout);
  const accessConfig =
    (
      isRecord(clusterRecord) &&
      isRecord(clusterRecord.cluster) &&
      isRecord(clusterRecord.cluster.accessConfig)
    ) ?
      clusterRecord.cluster.accessConfig
    : {};
  const authenticationMode =
    typeof accessConfig.authenticationMode === "string" ?
      accessConfig.authenticationMode
    : "CONFIG_MAP";
  if (authenticationMode === "CONFIG_MAP") {
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
  if (pickedArn && pickedArn.accountId !== accountId) {
    return fail(
      "aws-role-wrong-account",
      `IAM role ${picked} is in account ${pickedArn.accountId}, not ${accountId}. A deploy role cannot leave its account.`
    );
  }
  const roleName = pickedArn ? pickedArn.roleName : request.roleName.trim();
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
  const hasProvider =
    isRecord(providerList) &&
    Array.isArray(providerList.OpenIDConnectProviderList) &&
    providerList.OpenIDConnectProviderList.some(
      (entry) =>
        isRecord(entry) &&
        typeof entry.Arn === "string" &&
        entry.Arn.endsWith(`oidc-provider/${GITHUB_OIDC_HOST}`)
    );
  if (hasProvider) {
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
    ports.step(
      `✅ Created the GitHub identity provider in account ${accountId}.`
    );
  }

  ports.step(`ℹ️ Deploy identity will trust ${request.subject}`);

  let roleArn: string;
  let roleCreated = false;
  if (roleMissing) {
    const createRole = await ports.runAws([
      "iam",
      "create-role",
      "--role-name",
      roleName,
      "--description",
      `Radius deploy identity for ${request.repo}`,
      "--assume-role-policy-document",
      JSON.stringify(buildGitHubTrustPolicy(accountId, [request.subject])),
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
      : `arn:aws:iam::${accountId}:role/${roleName}`;
    roleCreated = true;
    created.push(`IAM role ${roleName}`);
    ports.step(`✅ Created IAM role ${roleName}.`);
  } else {
    roleArn =
      role && typeof role.Arn === "string" ?
        role.Arn
      : `arn:aws:iam::${accountId}:role/${roleName}`;
    ports.step(
      pickedArn ?
        `✅ Using the selected IAM role ${roleName}.`
      : `✅ Reusing the Radius-managed IAM role ${roleName}`
    );
    let trust;
    try {
      trust = mergeGitHubTrustSubject(
        parsePolicyDocument(role?.AssumeRolePolicyDocument),
        accountId,
        request.subject
      );
    } catch (error) {
      return fail(
        "aws-role-trust-unreadable",
        `Could not read the trust policy of IAM role ${roleName}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
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
        return fail(
          "aws-role-trust-denied",
          `Failed to update the role's trust policy: ${detail(updateTrust)}`
        );
      }
      created.push(`trust for ${request.subject} on ${roleName}`);
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
    return fail(
      "aws-role-policy-failed",
      `Failed to attach the deploy permission policy: ${detail(putPolicy)}`
    );
  }
  created.push(`policy ${policyName} on ${roleName}`);
  ports.step(
    `✅ Attached deploy permission policy ${policyName}, limited to ${region}.`
  );

  const createEntryArgs = [
    "eks",
    "create-access-entry",
    "--cluster-name",
    cluster,
    "--principal-arn",
    roleArn,
    "--type",
    "STANDARD",
    ...regionArgs
  ];
  let createEntry = await ports.runAws(createEntryArgs);
  for (const delay of ACCESS_ENTRY_RETRY_DELAYS_MS) {
    if (
      succeeded(createEntry) ||
      !PRINCIPAL_NOT_YET_VISIBLE.test(createEntry.stderr)
    ) {
      break;
    }
    ports.step(
      `ℹ️ EKS does not see role ${roleName} yet. Retrying in ${delay / 1000}s.`
    );
    await ports.sleep(delay);
    createEntry = await ports.runAws(createEntryArgs);
  }
  if (!succeeded(createEntry) && !RESOURCE_IN_USE.test(createEntry.stderr)) {
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

export interface AwsDeployIdentityRemovalRequest {
  roleArn: string;
  environment: string;
  subject: string;
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
 * identity provider stay, because other environments may still need them.
 */
export async function removeAwsEnvironmentFromRole(
  request: AwsDeployIdentityRemovalRequest,
  ports: Pick<AwsDeployIdentityPorts, "runAws">
): Promise<AwsDeployIdentityRemovalResult> {
  const parsed = parseAwsRoleArn(request.roleArn);
  if (!parsed) {
    return {
      ok: false,
      message: `"${request.roleArn}" is not an IAM role ARN, so Radius could not tell which role to clean up.`
    };
  }
  const { accountId, roleName } = parsed;
  const removed: string[] = [];
  const kept = [
    `IAM role ${roleName}`,
    "the account's GitHub identity provider"
  ];
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
  let trust;
  try {
    trust = removeGitHubTrustSubject(
      parsePolicyDocument(role.AssumeRolePolicyDocument),
      accountId,
      request.subject
    );
  } catch (error) {
    return {
      ok: false,
      message: `Could not read the trust policy of IAM role ${roleName}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  if (trust.removed) {
    const update = await ports.runAws([
      "iam",
      "update-assume-role-policy",
      "--role-name",
      roleName,
      "--policy-document",
      JSON.stringify(trust.policy)
    ]);
    if (!succeeded(update)) {
      return {
        ok: false,
        message: `Failed to remove ${request.subject} from the role's trust policy: ${detail(update)}`
      };
    }
    removed.push(`trust subject ${request.subject}`);
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
