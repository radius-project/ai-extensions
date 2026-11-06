import {
  buildAwsAppBoundaryPolicy,
  buildAwsAppIdentity
} from "@radius-project/core";
import type {
  AwsCommandResult,
  AwsDeployIdentityPorts
} from "./aws-deploy-identity.js";

// Each environment has one permissions boundary, a managed policy that caps
// the role the containers recipe creates for each container under the
// environment's IAM path. Setup writes the boundary, and environment deletion
// deletes the roles under the path and then the boundary.

type BoundaryPorts = Pick<AwsDeployIdentityPorts, "runAws">;

const NO_SUCH_ENTITY = /NoSuchEntity/;
const DENIED = /AccessDenied|not authorized/i;

function succeeded(result: AwsCommandResult): boolean {
  return result.code === 0 || result.code === "0";
}

function detail(result: AwsCommandResult): string {
  return result.timedOut ?
      "the AWS CLI call timed out"
    : (result.stderr || result.stdout || "no output").trim();
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

// A managed policy keeps at most five versions, so delete all but the default
// before adding one or deleting the policy. Answers an error, or null.
async function deleteOldVersions(
  policyArn: string,
  ports: BoundaryPorts
): Promise<string | null> {
  const list = await ports.runAws([
    "iam",
    "list-policy-versions",
    "--policy-arn",
    policyArn,
    "--output",
    "json"
  ]);
  const record = parseJson(list.stdout);
  if (
    !succeeded(list) ||
    !isRecord(record) ||
    !Array.isArray(record.Versions)
  ) {
    return `Could not list the versions of ${policyArn}: ${detail(list)}.`;
  }
  for (const version of record.Versions) {
    if (
      !isRecord(version) ||
      version.IsDefaultVersion !== false ||
      typeof version.VersionId !== "string"
    ) {
      continue;
    }
    const deletion = await ports.runAws([
      "iam",
      "delete-policy-version",
      "--policy-arn",
      policyArn,
      "--version-id",
      version.VersionId
    ]);
    if (!succeeded(deletion) && !NO_SUCH_ENTITY.test(deletion.stderr)) {
      return `Could not delete version ${version.VersionId} of ${policyArn}: ${detail(deletion)}.`;
    }
  }
  return null;
}

export async function ensureAppBoundary(
  input: {
    repo: string;
    environment: string;
    accountId: string;
    region: string;
    policyName: string;
  },
  ports: BoundaryPorts
): Promise<
  | { ok: true; name: string; created: boolean }
  | { ok: false; code: string; message: string }
> {
  const app = buildAwsAppIdentity(input.accountId, input.policyName);
  const document = JSON.stringify(
    buildAwsAppBoundaryPolicy(input.accountId, input.region)
  );
  const failed = (result: AwsCommandResult, message: string) => {
    const denied = DENIED.test(result.stderr);
    return {
      ok: false as const,
      code: denied ? "aws-app-boundary-denied" : "aws-app-boundary-failed",
      message:
        denied ?
          `${message} Ask an IAM administrator to allow iam:CreatePolicy, iam:CreatePolicyVersion, iam:ListPolicyVersions, and iam:DeletePolicyVersion on arn:aws:iam::${input.accountId}:policy/radius/apps/*.`
        : message
    };
  };
  const create = await ports.runAws([
    "iam",
    "create-policy",
    "--policy-name",
    app.boundaryName,
    "--path",
    app.rolePath,
    "--description",
    `Caps the roles Radius creates for apps in environment ${input.environment} of ${input.repo}`,
    "--policy-document",
    document
  ]);
  if (succeeded(create)) {
    return { ok: true, name: app.boundaryName, created: true };
  }
  if (!/EntityAlreadyExists/.test(create.stderr)) {
    return failed(
      create,
      `Could not create permissions boundary ${app.boundaryName} for the environment's app roles: ${detail(create)}.`
    );
  }
  const cleanup = await deleteOldVersions(app.boundaryArn, ports);
  if (cleanup) {
    return { ok: false, code: "aws-app-boundary-failed", message: cleanup };
  }
  const update = await ports.runAws([
    "iam",
    "create-policy-version",
    "--policy-arn",
    app.boundaryArn,
    "--policy-document",
    document,
    "--set-as-default"
  ]);
  if (!succeeded(update)) {
    return failed(
      update,
      `Could not update permissions boundary ${app.boundaryName}: ${detail(update)}.`
    );
  }
  return { ok: true, name: app.boundaryName, created: false };
}

type BoundaryRemoval =
  | { kind: "removed"; text: string }
  | { kind: "absent" }
  | { kind: "warning"; text: string }
  | { kind: "failed"; message: string };

// Delete the environment's boundary, or keep it and say why when a role still
// uses it, since IAM won't delete a boundary that is in use.
async function removeBoundary(
  app: ReturnType<typeof buildAwsAppIdentity>,
  accountId: string,
  ports: BoundaryPorts
): Promise<BoundaryRemoval> {
  const label = `permissions boundary ${app.boundaryName}`;
  const inUse = `Kept ${label}, because a role still uses it. Find the role with: aws iam list-entities-for-policy --policy-arn ${app.boundaryArn} --policy-usage-filter PermissionsBoundary`;
  const users = await ports.runAws([
    "iam",
    "list-entities-for-policy",
    "--policy-arn",
    app.boundaryArn,
    "--policy-usage-filter",
    "PermissionsBoundary",
    "--output",
    "json"
  ]);
  if (NO_SUCH_ENTITY.test(users.stderr)) return { kind: "absent" };
  // IAM checks access before existence, so a denied read can't show the
  // boundary is gone. Fail so the GitHub environment stays for a retry.
  if (DENIED.test(users.stderr)) {
    return {
      kind: "failed",
      message: `Could not check whether ${label} exists or which roles use it, because the signed-in AWS identity was denied (${detail(users)}). Allow iam:ListEntitiesForPolicy and iam:DeletePolicy on arn:aws:iam::${accountId}:policy/radius/apps/*, then retry.`
    };
  }
  if (!succeeded(users)) {
    return {
      kind: "failed",
      message: `Could not check which roles use ${label}: ${detail(users)}.`
    };
  }
  const record = parseJson(users.stdout);
  if (!isRecord(record) || !Array.isArray(record.PolicyRoles)) {
    return {
      kind: "failed",
      message: `IAM did not return the roles that use ${label}, so Radius kept it.`
    };
  }
  if (record.PolicyRoles.length > 0) return { kind: "warning", text: inUse };
  const cleanup = await deleteOldVersions(app.boundaryArn, ports);
  if (cleanup) return { kind: "failed", message: cleanup };
  const deletion = await ports.runAws([
    "iam",
    "delete-policy",
    "--policy-arn",
    app.boundaryArn
  ]);
  if (succeeded(deletion)) return { kind: "removed", text: label };
  if (NO_SUCH_ENTITY.test(deletion.stderr)) return { kind: "absent" };
  // A role created after the check above.
  if (/DeleteConflict/.test(deletion.stderr)) {
    return { kind: "warning", text: inUse };
  }
  return {
    kind: "failed",
    message: `Could not delete ${label}: ${detail(deletion)}.`
  };
}

// IAM deletes a role only after its inline policies. Answers an error, or null
// once the role is gone.
async function deleteRole(
  roleName: string,
  ports: BoundaryPorts
): Promise<string | null> {
  const list = await ports.runAws([
    "iam",
    "list-role-policies",
    "--role-name",
    roleName,
    "--output",
    "json"
  ]);
  if (NO_SUCH_ENTITY.test(list.stderr)) return null;
  const record = parseJson(list.stdout);
  if (
    !succeeded(list) ||
    !isRecord(record) ||
    !Array.isArray(record.PolicyNames)
  ) {
    return `Could not list the policies of IAM role ${roleName}: ${detail(list)}.`;
  }
  for (const policyName of record.PolicyNames) {
    if (typeof policyName !== "string") continue;
    const deletion = await ports.runAws([
      "iam",
      "delete-role-policy",
      "--role-name",
      roleName,
      "--policy-name",
      policyName
    ]);
    if (!succeeded(deletion) && !NO_SUCH_ENTITY.test(deletion.stderr)) {
      return `Could not delete policy ${policyName} from IAM role ${roleName}: ${detail(deletion)}.`;
    }
  }
  const deletion = await ports.runAws([
    "iam",
    "delete-role",
    "--role-name",
    roleName
  ]);
  if (succeeded(deletion) || NO_SUCH_ENTITY.test(deletion.stderr)) return null;
  return `Could not delete IAM role ${roleName}: ${detail(deletion)}.`;
}

export type AppRolesRemoval =
  | { ok: true; removed: string[]; warning?: string }
  | { ok: false; removed: string[]; message: string };

/**
 * Delete every role under the environment's IAM path, then its boundary. The
 * containers recipe creates these roles, and one left behind would keep
 * working after the environment is gone.
 */
export async function removeAppRoles(
  input: { accountId: string; policyName: string },
  ports: BoundaryPorts
): Promise<AppRolesRemoval> {
  const app = buildAwsAppIdentity(input.accountId, input.policyName);
  const list = await ports.runAws([
    "iam",
    "list-roles",
    "--path-prefix",
    app.rolePath,
    "--output",
    "json"
  ]);
  if (DENIED.test(list.stderr)) {
    return {
      ok: false,
      removed: [],
      message: `Could not confirm that no IAM roles remain under ${app.rolePath}, because the signed-in AWS identity can't list them (${detail(list)}). Allow iam:ListRoles and retry. To find them, run: aws iam list-roles --path-prefix ${app.rolePath}`
    };
  }
  const record = parseJson(list.stdout);
  if (!succeeded(list) || !isRecord(record) || !Array.isArray(record.Roles)) {
    return {
      ok: false,
      removed: [],
      message: `Could not list the IAM roles under ${app.rolePath}: ${detail(list)}.`
    };
  }
  const removed: string[] = [];
  for (const role of record.Roles) {
    if (!isRecord(role) || typeof role.RoleName !== "string") continue;
    const failure = await deleteRole(role.RoleName, ports);
    if (failure) return { ok: false, removed, message: failure };
    removed.push(`IAM role ${role.RoleName}`);
  }
  const boundary = await removeBoundary(app, input.accountId, ports);
  if (boundary.kind === "failed") {
    return { ok: false, removed, message: boundary.message };
  }
  if (boundary.kind === "removed") removed.push(boundary.text);
  return boundary.kind === "warning" ?
      { ok: true, removed, warning: boundary.text }
    : { ok: true, removed };
}
