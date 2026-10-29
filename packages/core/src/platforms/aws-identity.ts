// Pure AWS deploy-identity rules for the Radius Canvas product: the IAM role
// name, the GitHub OIDC trust policy a role carries, the per-environment
// permission policy, and the AWS CLI version gate. No I/O: callers run the
// `aws` CLI and hand the parsed documents in.

export const AWS_CLI_MINIMUM_VERSION = "2.15.3";
export const AWS_CLI_INSTALL_URL =
  "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html";

export const GITHUB_OIDC_HOST = "token.actions.githubusercontent.com";
export const GITHUB_OIDC_PROVIDER_URL = `https://${GITHUB_OIDC_HOST}`;
export const GITHUB_OIDC_AUDIENCE = "sts.amazonaws.com";
// GitHub's published OIDC certificate thumbprint. AWS no longer validates it
// for this issuer, but older CLI releases still require the argument.
export const GITHUB_OIDC_THUMBPRINT =
  "6938fd4d98bab03faadb97b34396831e3780aea1";

export const AWS_EKS_CLUSTER_ADMIN_POLICY_ARN =
  "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy";

// Tags Radius writes on a role it creates. A same-named role without them is
// not Radius-managed and is never modified.
export const AWS_MANAGED_TAG = "radius-managed";
export const AWS_REPOSITORY_TAG = "radius-repository";

const ROLE_NAME_MAX = 64;
const INLINE_POLICY_NAME_MAX = 128;
const SUB_CLAIM = `${GITHUB_OIDC_HOST}:sub`;
const AUD_CLAIM = `${GITHUB_OIDC_HOST}:aud`;
const NO_SUBJECTS_SID = "RadiusNoTrustedEnvironments";

export const AWS_ACCOUNT_ID_PATTERN = /^\d{12}$/;
export const AWS_REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;

export function isAwsAccountId(value: string): boolean {
  return AWS_ACCOUNT_ID_PATTERN.test(value);
}

export function isAwsRegion(value: string): boolean {
  return AWS_REGION_PATTERN.test(value);
}

/**
 * Whether a region is in the commercial `aws` partition, the only one the
 * deploy identity's ARNs are built for. GovCloud and China regions use other
 * partitions and other account IDs.
 */
export function isAwsCommercialRegion(value: string): boolean {
  return (
    isAwsRegion(value) &&
    !value.startsWith("us-gov-") &&
    !value.startsWith("cn-")
  );
}

/** Parse `aws --version` output (`aws-cli/2.15.3 Python/...`). */
export function parseAwsCliVersion(output: string): number[] | null {
  const match = /aws-cli\/(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export type AwsCliVersionCheck =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly message: string };

/** Check `aws --version` output against the access-entry minimum. */
export function checkAwsCliVersion(output: string): AwsCliVersionCheck {
  const parsed = parseAwsCliVersion(output);
  const minimum = parseAwsCliVersion(`aws-cli/${AWS_CLI_MINIMUM_VERSION}`);
  if (!parsed || !minimum) {
    return {
      ok: false,
      message: `Could not run the AWS CLI: ${output.trim() || "no version output"}. Upgrade the AWS CLI, then retry: ${AWS_CLI_INSTALL_URL}`
    };
  }
  const version = parsed.join(".");
  if (compareVersions(parsed, minimum) < 0) {
    return {
      ok: false,
      message: `AWS CLI ${version} is installed, which cannot grant the deploy role access to an EKS cluster. Radius needs AWS CLI ${AWS_CLI_MINIMUM_VERSION} or newer, the first release with EKS access entries. Upgrade the AWS CLI, then retry: ${AWS_CLI_INSTALL_URL}`
    };
  }
  return { ok: true, version };
}

function iamSafe(value: string): string {
  return value
    .replace(/[^A-Za-z0-9+=,.@_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * The default deploy role for a repository: `radius-deploy-<owner>-<repo>`,
 * truncated to the 64-character IAM role name limit.
 */
export function buildAwsDeployRoleName(repoFullName: string): string {
  const [owner = "", repo = ""] = repoFullName.split("/");
  const name = iamSafe(`radius-deploy-${owner}-${repo}`);
  return name.slice(0, ROLE_NAME_MAX).replace(/-+$/, "");
}

/** Whether a value is a valid IAM role name. */
export function isAwsRoleName(value: string): boolean {
  return /^[A-Za-z0-9+=,.@_-]{1,64}$/.test(value);
}

/**
 * The per-environment permission policy name. It is an inline role policy, so
 * the name is unique per role rather than per account. Two repositories that
 * share a picked role and an environment name share this name.
 */
export function buildAwsEnvironmentPolicyName(environment: string): string {
  return iamSafe(`radius-deploy-${environment}`).slice(
    0,
    INLINE_POLICY_NAME_MAX
  );
}

export function githubOidcProviderArn(accountId: string): string {
  return `arn:aws:iam::${accountId}:oidc-provider/${GITHUB_OIDC_HOST}`;
}

export function awsRoleArn(accountId: string, roleName: string): string {
  return `arn:aws:iam::${accountId}:role/${roleName}`;
}

/** Split a role ARN into its partition, account, and role name. */
export function parseAwsRoleArn(
  arn: string
): { partition: string; accountId: string; roleName: string } | null {
  const match =
    /^arn:(aws[a-z-]*):iam::(\d{12}):role\/(?:[^/]+\/)*([^/]+)$/.exec(
      arn.trim()
    );
  return match ?
      { partition: match[1], accountId: match[2], roleName: match[3] }
    : null;
}

type PolicyStatement = Record<string, unknown>;

export interface PolicyDocument {
  Version: string;
  Statement: PolicyStatement[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asList(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function stringList(value: unknown): string[] {
  return asList(value).filter(
    (item): item is string => typeof item === "string"
  );
}

/**
 * Parse a policy document. The IAM CLI returns trust policies already decoded,
 * but some paths hand back the URL-encoded JSON string.
 */
export function parsePolicyDocument(value: unknown): PolicyDocument {
  let parsed = value;
  if (typeof parsed === "string") {
    let text = parsed;
    if (/^%7B/i.test(text)) text = decodeURIComponent(text);
    parsed = JSON.parse(text);
  }
  if (!isRecord(parsed)) {
    throw new Error("The IAM policy document is not a JSON object.");
  }
  return {
    Version: typeof parsed.Version === "string" ? parsed.Version : "2012-10-17",
    Statement: asList(parsed.Statement).filter(isRecord)
  };
}

function isGitHubStatement(
  statement: PolicyStatement,
  providerArn: string
): boolean {
  const principal = statement.Principal;
  if (!isRecord(principal)) return false;
  return (
    stringList(principal.Federated).includes(providerArn) &&
    stringList(statement.Action).includes("sts:AssumeRoleWithWebIdentity")
  );
}

// Whether tokens GitHub mints for AWS (`aud` = sts.amazonaws.com) satisfy every
// condition on a statement. Only `sub` and `aud` conditions are understood; a
// statement with any other condition is treated as incompatible, so Radius
// never relies on or extends trust it cannot read.
function acceptsGitHubAudience(statement: PolicyStatement): boolean {
  if (statement.Condition === undefined) return true;
  if (!isRecord(statement.Condition)) return false;
  for (const [operator, block] of Object.entries(statement.Condition)) {
    if (operator !== "StringEquals" && operator !== "StringLike") return false;
    if (!isRecord(block)) return false;
    for (const [key, value] of Object.entries(block)) {
      if (key === SUB_CLAIM) continue;
      if (key !== AUD_CLAIM) return false;
      const audiences = stringList(value);
      if (
        !audiences.includes(GITHUB_OIDC_AUDIENCE) &&
        !(operator === "StringLike" && audiences.includes("*"))
      ) {
        return false;
      }
    }
  }
  return true;
}

// IAM `StringLike`: `*` matches any run of characters and `?` exactly one,
// case-sensitively; everything else is literal.
function matchesStringLike(pattern: string, value: string): boolean {
  const source = pattern
    .split("")
    .map((character) =>
      character === "*" ? ".*"
      : character === "?" ? "."
      : character.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    )
    .join("");
  return new RegExp(`^${source}$`).test(value);
}

// The `sub` constraint each condition operator puts on a statement. AWS ANDs
// operators, so a subject is accepted only when every one of them matches it.
function subjectConstraints(
  statement: PolicyStatement
): { operator: "StringEquals" | "StringLike"; values: string[] }[] {
  const condition = isRecord(statement.Condition) ? statement.Condition : {};
  const constraints: {
    operator: "StringEquals" | "StringLike";
    values: string[];
  }[] = [];
  for (const operator of ["StringEquals", "StringLike"] as const) {
    const block = condition[operator];
    if (isRecord(block) && block[SUB_CLAIM] !== undefined) {
      constraints.push({ operator, values: stringList(block[SUB_CLAIM]) });
    }
  }
  return constraints;
}

// Whether a statement names `subject` and every `sub` constraint on it accepts
// that subject. A statement with no `sub` constraint is not counted, so Radius
// never relies on trust that is not scoped to a GitHub subject.
function acceptsSubject(statement: PolicyStatement, subject: string): boolean {
  const constraints = subjectConstraints(statement);
  return (
    constraints.length > 0 &&
    constraints.every(({ operator, values }) =>
      operator === "StringEquals" ?
        values.includes(subject)
      : values.some((pattern) => matchesStringLike(pattern, subject))
    )
  );
}

function subjectsOf(statement: PolicyStatement): string[] {
  const condition = isRecord(statement.Condition) ? statement.Condition : {};
  const subjects: string[] = [];
  for (const operator of ["StringEquals", "StringLike"]) {
    const block = condition[operator];
    if (isRecord(block)) subjects.push(...stringList(block[SUB_CLAIM]));
  }
  return subjects;
}

/** The GitHub OIDC subjects an Allow statement in this trust policy accepts. */
export function trustedGitHubSubjects(
  policy: PolicyDocument,
  accountId: string
): string[] {
  const providerArn = githubOidcProviderArn(accountId);
  return policy.Statement.filter(
    (statement) =>
      statement.Effect === "Allow" && isGitHubStatement(statement, providerArn)
  ).flatMap(subjectsOf);
}

function githubTrustStatement(
  providerArn: string,
  subjects: readonly string[]
): PolicyStatement {
  return {
    Effect: "Allow",
    Principal: { Federated: providerArn },
    Action: "sts:AssumeRoleWithWebIdentity",
    Condition: {
      StringEquals: {
        [AUD_CLAIM]: GITHUB_OIDC_AUDIENCE,
        [SUB_CLAIM]: [...subjects]
      }
    }
  };
}

function noSubjectsStatement(providerArn: string): PolicyStatement {
  return {
    Sid: NO_SUBJECTS_SID,
    Effect: "Deny",
    Principal: { Federated: providerArn },
    Action: "sts:AssumeRoleWithWebIdentity"
  };
}

/** A new role's trust policy, accepting exactly one subject. */
export function buildGitHubTrustPolicy(
  accountId: string,
  subjects: readonly string[]
): PolicyDocument {
  const providerArn = githubOidcProviderArn(accountId);
  return {
    Version: "2012-10-17",
    Statement: [githubTrustStatement(providerArn, subjects)]
  };
}

export interface TrustMergeResult {
  readonly policy: PolicyDocument;
  /** Subjects already trusted before this merge, excluding `subject`. */
  readonly kept: number;
  /** False when the subject was already trusted and nothing changed. */
  readonly changed: boolean;
}

/**
 * Add one subject to a role's trust policy without replacing what it already
 * trusts. Statements that do not name the GitHub provider are left alone, so a
 * platform-owned role keeps every other principal it trusts.
 */
export function mergeGitHubTrustSubject(
  existing: PolicyDocument,
  accountId: string,
  subject: string
): TrustMergeResult {
  const providerArn = githubOidcProviderArn(accountId);
  const trusted = trustedGitHubSubjects(existing, accountId);
  const kept = trusted.filter((value) => value !== subject).length;
  // Only a statement GitHub's AWS tokens can satisfy, and whose every `sub`
  // constraint accepts the subject, counts as already trusting it.
  const compatible = (statement: PolicyStatement): boolean =>
    statement.Effect === "Allow" &&
    isGitHubStatement(statement, providerArn) &&
    acceptsGitHubAudience(statement);
  if (
    existing.Statement.some(
      (statement) => compatible(statement) && acceptsSubject(statement, subject)
    )
  ) {
    return { policy: existing, kept, changed: false };
  }
  const statements = existing.Statement.filter(
    (statement) => statement.Sid !== NO_SUBJECTS_SID
  );
  // Only a statement whose single `sub` constraint is `StringEquals` is
  // extended, because adding to it is then enough for AWS to accept the
  // subject. Any other shape is kept as it is and a new exact statement added.
  const index = statements.findIndex((statement) => {
    if (!compatible(statement)) return false;
    const constraints = subjectConstraints(statement);
    return (
      constraints.length === 1 && constraints[0].operator === "StringEquals"
    );
  });
  if (index < 0) {
    statements.push(githubTrustStatement(providerArn, [subject]));
  } else {
    const statement = statements[index];
    const condition = statement.Condition as Record<string, unknown>;
    const equals = condition.StringEquals as Record<string, unknown>;
    statements[index] = {
      ...statement,
      Condition: {
        ...condition,
        StringEquals: {
          ...equals,
          [SUB_CLAIM]: [...stringList(equals[SUB_CLAIM]), subject]
        }
      }
    };
  }
  return {
    policy: { Version: existing.Version, Statement: statements },
    kept,
    changed: true
  };
}

export interface TrustRemovalResult {
  readonly policy: PolicyDocument;
  readonly removed: boolean;
  readonly remaining: number;
}

/**
 * Remove one subject from a role's trust policy. When no statement is left, a
 * deny statement keeps the policy valid, since IAM rejects an empty trust
 * policy and the role itself is never deleted.
 */
export function removeGitHubTrustSubject(
  existing: PolicyDocument,
  accountId: string,
  subject: string
): TrustRemovalResult {
  const providerArn = githubOidcProviderArn(accountId);
  let removed = false;
  const statements: PolicyStatement[] = [];
  for (const statement of existing.Statement) {
    if (
      statement.Effect !== "Allow" ||
      !isGitHubStatement(statement, providerArn) ||
      !subjectsOf(statement).includes(subject)
    ) {
      statements.push(statement);
      continue;
    }
    removed = true;
    const condition = statement.Condition as Record<string, unknown>;
    const next: Record<string, unknown> = { ...condition };
    for (const operator of ["StringEquals", "StringLike"]) {
      const block = condition[operator];
      if (!isRecord(block) || block[SUB_CLAIM] === undefined) continue;
      next[operator] = {
        ...block,
        [SUB_CLAIM]: stringList(block[SUB_CLAIM]).filter(
          (value) => value !== subject
        )
      };
    }
    const remainingForStatement = subjectsOf({ Condition: next });
    if (remainingForStatement.length > 0) {
      statements.push({ ...statement, Condition: next });
    }
  }
  if (statements.length === 0)
    statements.push(noSubjectsStatement(providerArn));
  const policy = { Version: existing.Version, Statement: statements };
  return {
    policy,
    removed,
    remaining: trustedGitHubSubjects(policy, accountId).length
  };
}

// Services where a region is meaningless or where denying it would lock the
// role out of its own job. These PowerUserAccess grants are not region-bounded.
const GLOBAL_POWER_USER_ACTIONS = [
  "account:GetAccountInformation",
  "account:GetPrimaryEmail",
  "account:ListRegions",
  "iam:CreateServiceLinkedRole",
  "iam:DeleteServiceLinkedRole",
  "iam:ListRoles",
  "organizations:DescribeOrganization"
];

/**
 * The environment's permission policy: the statements of AWS's
 * `PowerUserAccess` managed policy, with the broad grant limited to the
 * environment's region. It is written per environment, so a role shared by
 * environments in two regions can act in exactly those two, and deleting one
 * environment narrows the role back. It never grants `iam:*`, so the role
 * cannot make itself or anyone else an administrator.
 */
export function buildAwsEnvironmentPermissionPolicy(
  region: string
): PolicyDocument {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "RadiusPowerUserInRegion",
        Effect: "Allow",
        NotAction: ["iam:*", "organizations:*", "account:*"],
        Resource: "*",
        Condition: { StringEquals: { "aws:RequestedRegion": [region] } }
      },
      {
        Sid: "RadiusPowerUserGlobal",
        Effect: "Allow",
        Action: GLOBAL_POWER_USER_ACTIONS,
        Resource: "*"
      }
    ]
  };
}

/** Read role tags from `aws iam get-role` output. */
export function awsRoleTags(role: unknown): Record<string, string> {
  if (!isRecord(role)) return {};
  const tags: Record<string, string> = {};
  for (const tag of asList(role.Tags)) {
    if (
      isRecord(tag) &&
      typeof tag.Key === "string" &&
      typeof tag.Value === "string"
    ) {
      tags[tag.Key] = tag.Value;
    }
  }
  return tags;
}

/** Whether Radius created this role for this repository. */
export function isRadiusManagedRole(
  role: unknown,
  repoFullName: string
): boolean {
  const tags = awsRoleTags(role);
  return (
    tags[AWS_MANAGED_TAG] === "true" &&
    (tags[AWS_REPOSITORY_TAG] || "").toLowerCase() ===
      repoFullName.toLowerCase()
  );
}

/** The exact command an IAM administrator runs to add the GitHub provider. */
export function createGitHubOidcProviderCommand(): string {
  return `aws iam create-open-id-connect-provider --url ${GITHUB_OIDC_PROVIDER_URL} --client-id-list ${GITHUB_OIDC_AUDIENCE} --thumbprint-list ${GITHUB_OIDC_THUMBPRINT}`;
}

/**
 * The authentication mode in `aws eks describe-cluster` output. A cluster that
 * reports none predates access entries, so it is treated as `CONFIG_MAP`.
 */
export function eksAuthenticationMode(describeCluster: unknown): string {
  const cluster =
    (
      typeof describeCluster === "object" &&
      describeCluster !== null &&
      "cluster" in describeCluster
    ) ?
      describeCluster.cluster
    : undefined;
  const accessConfig =
    (
      typeof cluster === "object" &&
      cluster !== null &&
      "accessConfig" in cluster
    ) ?
      cluster.accessConfig
    : undefined;
  const mode =
    (
      typeof accessConfig === "object" &&
      accessConfig !== null &&
      "authenticationMode" in accessConfig
    ) ?
      accessConfig.authenticationMode
    : undefined;
  return typeof mode === "string" && mode ? mode : "CONFIG_MAP";
}

/** Whether a cluster in this authentication mode accepts access entries. */
export function eksAcceptsAccessEntries(authenticationMode: string): boolean {
  return authenticationMode !== "CONFIG_MAP";
}

/** The command that switches a cluster to accept access entries. */
export function enableAccessEntriesCommand(
  cluster: string,
  region: string
): string {
  return `aws eks update-cluster-config --name ${cluster} --region ${region} --access-config authenticationMode=API_AND_CONFIG_MAP`;
}

export function configMapClusterMessage(
  cluster: string,
  region: string
): string {
  return `Cluster ${cluster} uses CONFIG_MAP authentication, which does not support access entries. Radius grants cluster access through an access entry, so it cannot authorize the deploy role on this cluster. Run this command to enable access entries, then retry: ${enableAccessEntriesCommand(cluster, region)}`;
}
