import {
  buildAwsEnvironmentPermissionPolicy,
  buildLegacyAwsEnvironmentPolicyName,
  isAwsEnvironmentPolicyName,
  namesOneEnvironment,
  immutableEnvironmentRepository,
  legacyAwsPolicyOwnershipError,
  parsePolicyDocument,
  type PolicyDocument
} from "@radius-project/core";
import { parseServedReposFromSubjects } from "../../azure-oidc.js";
import { awsEnvironmentPolicyName } from "../../aws-deploy-role-name.js";
import type {
  AwsCommandResult,
  AwsDeployIdentityPorts,
  AwsDeployIdentitySetupPorts
} from "./aws-deploy-identity.js";

type PolicyPorts = Pick<AwsDeployIdentityPorts, "runAws">;
type LegacyPolicy =
  | { ok: true; name: string; document: PolicyDocument }
  | { ok: true; name: null; document: null };
type Failure = { ok: false; message: string };

function succeeded(result: AwsCommandResult): boolean {
  return result.code === 0 || result.code === "0";
}

function detail(result: AwsCommandResult): string {
  return result.timedOut ?
      "the AWS CLI call timed out"
    : (result.stderr || result.stdout || "no output").trim();
}

export async function readLegacyEnvironmentPolicy(
  request: {
    repo: string;
    environment: string;
    roleName: string;
    accountId: string;
    subjects: readonly string[];
  },
  role: unknown,
  ports: PolicyPorts
): Promise<LegacyPolicy | Failure> {
  const name = buildLegacyAwsEnvironmentPolicyName(request.environment);
  const result = await ports.runAws([
    "iam",
    "get-role-policy",
    "--role-name",
    request.roleName,
    "--policy-name",
    name,
    "--output",
    "json"
  ]);
  if (!succeeded(result)) {
    return /NoSuchEntity/.test(result.stderr) ?
        { ok: true, name: null, document: null }
      : {
          ok: false,
          message: `Could not check legacy policy ${name} on IAM role ${request.roleName}: ${detail(result)}`
        };
  }
  try {
    const record: unknown = JSON.parse(result.stdout);
    if (
      typeof record !== "object" ||
      record === null ||
      !("PolicyName" in record) ||
      record.PolicyName !== name ||
      !("PolicyDocument" in record)
    ) {
      return {
        ok: false,
        message: `IAM did not return the requested legacy policy ${name}, so Radius stopped without changing the role.`
      };
    }
    const error = legacyAwsPolicyOwnershipError({ ...request, role });
    if (error) {
      return {
        ok: false,
        message: `Cannot establish ownership of legacy policy ${name} on IAM role ${request.roleName}. ${error} Nothing was changed. Ask the role owner to separate the legacy environments' permissions before retrying.`
      };
    }
    return {
      ok: true,
      name,
      document: parsePolicyDocument(record.PolicyDocument)
    };
  } catch {
    return {
      ok: false,
      message: `Could not read legacy policy ${name} or the role's trust policy. Nothing was changed.`
    };
  }
}

export async function attachEnvironmentPolicy(
  input: {
    repo: string;
    environment: string;
    roleName: string;
    region: string;
    policyName?: string;
    legacy: LegacyPolicy;
  },
  ports: PolicyPorts
): Promise<
  | { ok: true; policyName: string }
  | { ok: false; code: string; message: string; policyWritten: boolean }
> {
  const { roleName, legacy } = input;
  const policyName =
    input.policyName ?? awsEnvironmentPolicyName(input.repo, input.environment);
  const put = (name: string, document: PolicyDocument) =>
    ports.runAws([
      "iam",
      "put-role-policy",
      "--role-name",
      roleName,
      "--policy-name",
      name,
      "--policy-document",
      JSON.stringify(document)
    ]);
  const removeLegacy = (name: string) =>
    ports.runAws([
      "iam",
      "delete-role-policy",
      "--role-name",
      roleName,
      "--policy-name",
      name
    ]);
  const document = buildAwsEnvironmentPermissionPolicy(input.region);
  let written = await put(policyName, document);
  let legacyRemoved = false;
  // At the aggregate quota, two copies cannot coexist. Remove only the proven
  // owner's legacy policy, then restore it if the replacement fails.
  if (
    !succeeded(written) &&
    /LimitExceeded/.test(written.stderr) &&
    legacy.name
  ) {
    const removed = await removeLegacy(legacy.name);
    if (!succeeded(removed) && !/NoSuchEntity/.test(removed.stderr)) {
      return {
        ok: false,
        code: "aws-legacy-policy-removal-failed",
        policyWritten: false,
        message: `Migration needs the space held by ${legacy.name}, but IAM could not remove it: ${detail(removed)}. No replacement was attached.`
      };
    }
    legacyRemoved = true;
    written = await put(policyName, document);
    if (!succeeded(written)) {
      const restored = await put(legacy.name, legacy.document);
      return {
        ok: false,
        code: "aws-role-policy-failed",
        policyWritten: false,
        message: `Could not replace legacy policy ${legacy.name}: ${detail(written)}. ${
          succeeded(restored) ?
            "The original legacy policy was restored; its old permissions remain. Choose another role or free inline-policy space before retrying."
          : `Restoring the original policy also failed: ${detail(restored)}. This environment's grant may be missing. Repair IAM permissions and rerun setup.`
        }`
      };
    }
  }
  if (!succeeded(written)) {
    return {
      ok: false,
      policyWritten: false,
      code:
        /LimitExceeded/.test(written.stderr) ?
          "aws-role-limit-exceeded"
        : "aws-role-policy-failed",
      message:
        /LimitExceeded/.test(written.stderr) ?
          `IAM role ${roleName} has reached the 10,240-character inline-policy limit, which cannot be raised. These policies fit about 17 environments when no other inline policies use the space. Delete an unused environment or choose another role. AWS reported: ${detail(written)}`
        : `Failed to attach the deploy permission policy: ${detail(written)}`
    };
  }
  if (legacy.name && !legacyRemoved) {
    const removed = await removeLegacy(legacy.name);
    if (!succeeded(removed) && !/NoSuchEntity/.test(removed.stderr)) {
      return {
        ok: false,
        code: "aws-legacy-policy-removal-failed",
        policyWritten: true,
        message: `The new policy was written, but legacy policy ${legacy.name} could not be removed: ${detail(removed)}. The legacy permissions may still be active. Setup stopped.`
      };
    }
  }
  return { ok: true, policyName };
}

export async function resolveEnvironmentPolicyForRemoval(
  input: {
    repo: string;
    environment: string;
    roleName: string;
    policyName?: string;
  },
  ports: PolicyPorts
): Promise<{ ok: true; policyName: string | null } | Failure> {
  if (input.policyName !== undefined) {
    return isAwsEnvironmentPolicyName(input.policyName, input.environment) ?
        { ok: true, policyName: input.policyName }
      : {
          ok: false,
          message:
            "The recorded AWS permission policy name is invalid for this environment. Review its saved AWS configuration before deletion."
        };
  }
  const inventory = await readPolicyNames(input.roleName, ports);
  if (!inventory.ok) return inventory;
  const expected = awsEnvironmentPolicyName(input.repo, input.environment);
  if (inventory.names.includes(expected))
    return { ok: true, policyName: expected };
  if (
    inventory.names.some((name) =>
      isAwsEnvironmentPolicyName(name, input.environment)
    )
  ) {
    return {
      ok: false,
      message:
        "The environment has no recorded AWS permission policy name, and the role has a matching environment policy under another repository hash. Radius did not guess or report it removed. Repair the saved AWS configuration before deletion."
    };
  }
  return { ok: true, policyName: null };
}

export async function resolveEnvironmentPolicyForSetup(
  input: {
    repo: string;
    environment: string;
    roleName: string;
    roleArn: string;
    subjects: readonly string[];
  },
  ports: PolicyPorts &
    Pick<AwsDeployIdentitySetupPorts, "isRecordedForeignPolicy">
): Promise<{ ok: true; policyName: string } | Failure> {
  const inventory = await readPolicyNames(input.roleName, ports);
  if (!inventory.ok) return inventory;
  const expected = awsEnvironmentPolicyName(input.repo, input.environment);
  const legacy = buildLegacyAwsEnvironmentPolicyName(input.environment);
  const repositories = parseServedReposFromSubjects(
    input.subjects.filter((subject) =>
      namesOneEnvironment(subject, input.environment)
    )
  );
  const unresolved: Failure = {
    ok: false,
    message:
      "An existing AWS environment policy cannot be reconciled with this repository. No new policy was attached. Recover the exact saved policy identity or ask the role owner to reconcile the grants before retrying."
  };
  for (const name of inventory.names) {
    if (
      name === expected ||
      name === legacy ||
      !isAwsEnvironmentPolicyName(name, input.environment)
    )
      continue;
    const repo = repositories.find(
      (candidate) =>
        awsEnvironmentPolicyName(candidate, input.environment) === name
    );
    if (!repo) return unresolved;
    const ids = new Set(
      input.subjects.flatMap((subject) => {
        const identity = immutableEnvironmentRepository(
          subject,
          input.environment
        );
        return identity?.repo.toLowerCase() === repo.toLowerCase() ?
            [identity.repoId]
          : [];
      })
    );
    if (ids.size > 1) return unresolved;
    const repoId = [...ids][0];
    try {
      if (
        !(await ports.isRecordedForeignPolicy({
          repo,
          ...(repoId !== undefined ? { repoId } : {}),
          environment: input.environment,
          roleArn: input.roleArn,
          policyName: name
        }))
      )
        return unresolved;
    } catch {
      return unresolved;
    }
  }
  return { ok: true, policyName: expected };
}

async function readPolicyNames(
  roleName: string,
  ports: PolicyPorts
): Promise<{ ok: true; names: string[] } | Failure> {
  const result = await ports.runAws([
    "iam",
    "list-role-policies",
    "--role-name",
    roleName,
    "--output",
    "json"
  ]);
  if (!succeeded(result))
    return {
      ok: false,
      message: `Could not identify the environment's permission policy: ${detail(result)}`
    };
  try {
    const data: unknown = JSON.parse(result.stdout);
    if (
      typeof data !== "object" ||
      data === null ||
      !("PolicyNames" in data) ||
      !Array.isArray(data.PolicyNames) ||
      !data.PolicyNames.every(
        (name): name is string => typeof name === "string"
      )
    ) {
      throw new Error("IAM returned an invalid policy inventory");
    }
    return { ok: true, names: data.PolicyNames };
  } catch {
    return {
      ok: false,
      message:
        "IAM did not return a readable policy inventory. Radius stopped before changing the role."
    };
  }
}
