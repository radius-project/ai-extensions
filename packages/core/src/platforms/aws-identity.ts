// Pure AWS deploy-identity rules for the Radius Canvas product: the IAM role
// name, the GitHub OIDC trust policy a role carries, the per-environment
// permission policy, and the AWS CLI version gate. No I/O: callers run the
// `aws` CLI and hand the parsed documents in.

import {
  buildEnvironmentSuffix,
  type OidcSubjectConfig
} from "./oidc-subject.js";

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
const ROLE_NAME_HASH_LENGTH = 6;
const INLINE_POLICY_NAME_MAX = 128;
const INLINE_POLICY_HASH_LENGTH = 16;
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

export type AwsCliFailure =
  | "missing-cli"
  | "timeout"
  | "login-required"
  | "credentials-expired"
  | "credentials-invalid"
  | "access-denied"
  | "provider-failed"
  | "command-failed";

/** Classify diagnostics without exposing credential-provider output. */
export function classifyAwsCliFailure(input: {
  output: string;
  timedOut?: boolean;
}): AwsCliFailure {
  const { output } = input;
  if (input.timedOut || /timed out|timeout|ETIMEDOUT/i.test(output))
    return "timeout";
  if (
    /credential_process|credential process|retrieving credentials/i.test(output)
  )
    return "provider-failed";
  if (/ENOENT|command not found|not recognized as .*command/i.test(output))
    return "missing-cli";
  if (
    /Unable to locate credentials|NoCredentialsError|SSOTokenLoadError|Error loading SSO Token|SSO session .*expired|Error when retrieving token from sso:.*(?:expired|refresh failed)/i.test(
      output
    )
  )
    return "login-required";
  if (/ExpiredToken|Token has expired|security token .*expired/i.test(output))
    return "credentials-expired";
  if (/InvalidClientTokenId|security token .*invalid/i.test(output))
    return "credentials-invalid";
  if (/AccessDenied|UnauthorizedOperation|not authorized/i.test(output))
    return "access-denied";
  // After the AWS error codes: ARNs such as role/MFA-admin can contain "MFA".
  if (/MFA|multi-factor/i.test(output)) return "provider-failed";
  return "command-failed";
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
      message: `Could not read the AWS CLI version. Radius needs AWS CLI ${AWS_CLI_MINIMUM_VERSION} or newer. Install or upgrade the AWS CLI, then retry: ${AWS_CLI_INSTALL_URL}`
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
 * The default deploy role for a repository: `radius-deploy-<owner>-<repo>`.
 * IAM role names allow 64 characters, so a longer name keeps its first 57,
 * then `-` and the first 6 hex characters of the SHA-256 of `owner/repo`.
 * Truncating alone would give two long repositories the same role. The hash
 * makes that unlikely, not impossible. On a clash, setup finds the other
 * repository's tags on the role and stops without changing it.
 *
 * `sha256Hex` is injected because this package cannot import `node:crypto`
 * (see app-origin.ts). The repository is hashed in lowercase because GitHub
 * repository names and IAM role names both ignore case.
 */
export function buildAwsDeployRoleName(
  repoFullName: string,
  sha256Hex: (text: string) => string
): string {
  const [owner = "", repo = ""] = repoFullName.split("/");
  const name = iamSafe(`radius-deploy-${owner}-${repo}`);
  if (name.length <= ROLE_NAME_MAX) return name;
  const suffix = sha256Hex(`${owner}/${repo}`.toLowerCase()).slice(
    0,
    ROLE_NAME_HASH_LENGTH
  );
  return `${name.slice(0, ROLE_NAME_MAX - ROLE_NAME_HASH_LENGTH - 1)}-${suffix}`;
}

/** Whether a value is a valid IAM role name. */
export function isAwsRoleName(value: string): boolean {
  return /^[A-Za-z0-9+=,.@_-]{1,64}$/.test(value);
}

/**
 * The permission policy one environment adds to a deploy role. The hash is of
 * the repository's ID, which a rename keeps and a new repository at the old
 * name doesn't get, so only this repository's setup computes this name.
 */
export function buildAwsEnvironmentPolicyName(
  repoId: number,
  environment: string,
  sha256Hex: (text: string) => string
): string {
  const prefix = iamSafe(`radius-deploy-${environment.toLowerCase()}`).slice(
    0,
    INLINE_POLICY_NAME_MAX - INLINE_POLICY_HASH_LENGTH - 1
  );
  const suffix = sha256Hex(
    JSON.stringify([repoId, environment.toLowerCase()])
  ).slice(0, INLINE_POLICY_HASH_LENGTH);
  return `${prefix}-${suffix}`;
}

/**
 * Whether `name` is a permission policy an earlier Radius build added for
 * `environment`: `radius-deploy-<environment>`, or that name followed by a
 * 12-character hash of the repository's name. Neither ties the policy to a
 * repository ID, so Radius can't tell whose it is and no longer manages them.
 */
export function isEarlierAwsEnvironmentPolicyName(
  name: string,
  environment: string
): boolean {
  const lower = name.toLowerCase();
  const unhashed = iamSafe(`radius-deploy-${environment}`)
    .slice(0, INLINE_POLICY_NAME_MAX)
    .toLowerCase();
  const prefix = `${iamSafe(`radius-deploy-${environment.toLowerCase()}`).slice(
    0,
    INLINE_POLICY_NAME_MAX - 13
  )}-`;
  return (
    lower === unhashed ||
    (lower.startsWith(prefix) &&
      /^[a-f0-9]{12}$/.test(lower.slice(prefix.length)))
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

/**
 * The exact GitHub OIDC subjects this trust policy lets GitHub's AWS tokens
 * sign in with. Unlike `trustedGitHubSubjects`, a subject counts only when its
 * statement accepts GitHub's audience, has no condition Radius cannot read, and
 * every `sub` constraint on it accepts the subject. Patterns are left out.
 */
export function acceptedGitHubSubjects(
  policy: PolicyDocument,
  accountId: string
): string[] {
  const providerArn = githubOidcProviderArn(accountId);
  return policy.Statement.filter(
    (statement) =>
      statement.Effect === "Allow" &&
      isGitHubStatement(statement, providerArn) &&
      acceptsGitHubAudience(statement)
  ).flatMap((statement) =>
    subjectsOf(statement).filter(
      (subject) => !/[*?]/.test(subject) && acceptsSubject(statement, subject)
    )
  );
}

/**
 * The subjects in `subjects` that a GitHub Allow statement in this trust
 * policy already covers in a way adding a plain statement would widen: one
 * that names the subject but excludes it with another `sub` constraint, or
 * one whose `sub` constraints accept it, patterns included, under conditions
 * Radius cannot read or for another audience.
 */
export function restrictedGitHubSubjects(
  policy: PolicyDocument,
  accountId: string,
  subjects: readonly string[]
): string[] {
  const providerArn = githubOidcProviderArn(accountId);
  const statements = policy.Statement.filter(
    (statement) =>
      statement.Effect === "Allow" && isGitHubStatement(statement, providerArn)
  );
  return subjects.filter((subject) =>
    statements.some(
      (statement) =>
        subjectsOf(statement).includes(subject) ||
        (!acceptsGitHubAudience(statement) &&
          acceptsSubject(statement, subject))
    )
  );
}

// A subject is `claim:value` pairs joined by colons. GitHub's values have no
// colon in them (an environment name is %3A-encoded), so a subject that does
// not split into pairs is not one Radius can read.
function subjectClaims(subject: string): [string, string][] | null {
  const parts = subject.split(":");
  if (parts.length < 2 || parts.length % 2 !== 0) return null;
  const claims: [string, string][] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const key = parts[index];
    const value = parts[index + 1];
    if (!key || !value) return null;
    claims.push([key, value]);
  }
  return claims;
}

const REPOSITORY_CLAIMS: ReadonlySet<string> = new Set([
  "repo",
  "repository",
  "repository_id"
]);

/**
 * Whether a GitHub OIDC subject names one repository, by name or ID. A subject
 * customized to, say, `repository_owner` and `context` does not, so every
 * repository of that owner can present it.
 */
export function subjectNamesRepository(subject: string): boolean {
  return (
    subjectClaims(subject)?.some(([key]) => REPOSITORY_CLAIMS.has(key)) ?? false
  );
}

/**
 * Why setup and Repair refuse `subjects`, which fail `subjectNamesRepository`,
 * and how to fix the customization that produced them. Only a customized
 * subject can leave the repository out, so the fix is always to the claim keys.
 */
export function repositoryLessSubjectMessage(
  subjects: readonly string[],
  repository: string,
  subjectConfig: OidcSubjectConfig
): string {
  const keys = subjectConfig.includeClaimKeys ?? [];
  const claims =
    keys.length > 0 ? `, includes only the claims ${keys.join(", ")}` : "";
  return `GitHub's OIDC subject for this environment, ${subjects.join(", ")}, does not name the repository, because the OIDC subject customization for ${repository}, set on the repository or its organization${claims}. Other repositories with the same claim values present the same subject, so trusting it would let their workflows sign in to the deploy role. This attempt changed nothing in AWS. Add repo or repository_id to the customization's include_claim_keys, then retry.`;
}

/**
 * Whether any statement in this trust policy names the account's GitHub
 * provider. Unlike `trustedGitHubSubjects`, this also finds a Radius role
 * whose last environment was removed, which keeps only a Deny statement.
 */
export function namesGitHubProvider(
  policy: PolicyDocument,
  accountId: string
): boolean {
  const providerArn = githubOidcProviderArn(accountId);
  return policy.Statement.some((statement) =>
    isGitHubStatement(statement, providerArn)
  );
}

/**
 * Whether the only principals this trust policy lets in are GitHub workflows
 * presenting one of `subjects`. Deny statements grant nothing and are skipped.
 * Another principal, a GitHub statement with no `sub` constraint, a wildcard
 * pattern, or any subject not in `subjects` makes it false. A pattern admits
 * subjects it doesn't spell out, so it never counts as listed.
 */
export function trustAllowsOnlySubjects(
  policy: PolicyDocument,
  accountId: string,
  subjects: readonly string[]
): boolean {
  const providerArn = githubOidcProviderArn(accountId);
  return policy.Statement.every((statement) => {
    if (statement.Effect === "Deny") return true;
    const principal = statement.Principal;
    return (
      statement.Effect === "Allow" &&
      isRecord(principal) &&
      Object.keys(principal).every((key) => key === "Federated") &&
      stringList(principal.Federated).every((arn) => arn === providerArn) &&
      isGitHubStatement(statement, providerArn) &&
      subjectConstraints(statement).length > 0 &&
      subjectConstraints(statement).every(
        ({ operator, values }) =>
          operator === "StringEquals" ||
          values.every((value) => !/[*?]/.test(value))
      ) &&
      subjectsOf(statement).every((subject) => subjects.includes(subject))
    );
  });
}

export interface GitHubRepositoryIdentity {
  /** The repository's current `owner/name`. */
  readonly fullName: string;
  readonly ownerId: number;
  readonly repoId: number;
}

// `owner/name`, each part optionally followed by its immutable `@id`.
const REPOSITORY_SLUG =
  /^([a-z0-9_.-]+)(?:@[1-9]\d*)?\/([a-z0-9_.-]+)(?:@([1-9]\d*))?$/i;

/**
 * The `owner/name` that a subject's one `repo` or `repository` claim names,
 * without `@id` suffixes. Returns null when the subject has no such claim,
 * more than one, or a malformed one.
 */
export function subjectRepositoryName(subject: string): string | null {
  const repositories = (subjectClaims(subject) ?? []).filter(
    ([key]) => key === "repo" || key === "repository"
  );
  const match =
    repositories.length === 1 ? REPOSITORY_SLUG.exec(repositories[0][1]) : null;
  return match ? `${match[1]}/${match[2]}` : null;
}

// Unlike repository names, IDs still distinguish owners after a rename.
export function immutableEnvironmentRepository(
  subject: string,
  environment: string
): { repo: string; repoId: number } | null {
  const claims = subjectClaims(subject);
  if (!claims || !namesOneEnvironment(subject, environment)) return null;
  const repositories = claims.filter(
    ([key]) => key === "repo" || key === "repository"
  );
  if (repositories.length !== 1) return null;
  const match = REPOSITORY_SLUG.exec(repositories[0][1]);
  if (!match) return null;
  const ids = claims
    .filter(([key]) => key === "repository_id")
    .map(([, value]) => value);
  if (match[3]) ids.push(match[3]);
  if (
    !ids.length ||
    !/^[1-9]\d*$/.test(ids[0]) ||
    ids.some((id) => id !== ids[0])
  )
    return null;
  const repoId = Number(ids[0]);
  return Number.isSafeInteger(repoId) && repoId > 0 ?
      { repo: `${match[1]}/${match[2]}`, repoId }
    : null;
}

// A subject's claims when none is a wildcard. A wildcard admits workflows the
// subject doesn't spell out, so it can't be tied to one environment.
function exactClaims(subject: string): [string, string][] | null {
  const claims = subjectClaims(subject);
  return claims && claims.every(([, value]) => !/[*?]/.test(value)) ?
      claims
    : null;
}

/**
 * Whether a GitHub OIDC subject names this repository and an environment, so
 * no other repository or a workflow outside an environment presents it. The
 * repository counts when the subject has its `owner/name`, its immutable
 * `owner@id/name@id`, or its `repository_id`. Anything else, including an
 * owner-wide subject, an older name from before a rename, or a wildcard, is
 * not proven to be this repository's.
 */
export function namesRepositoryEnvironment(
  subject: string,
  repository: GitHubRepositoryIdentity
): boolean {
  const claims = exactClaims(subject);
  if (!claims) return false;
  const [owner = "", name = ""] = repository.fullName.toLowerCase().split("/");
  const slugs = [
    `${owner}/${name}`,
    `${owner}@${repository.ownerId}/${name}@${repository.repoId}`
  ];
  return (
    claims.some(([key]) => key === "environment") &&
    claims.some(
      ([key, value]) =>
        ((key === "repo" || key === "repository") &&
          slugs.includes(value.toLowerCase())) ||
        (key === "repository_id" && value === String(repository.repoId))
    )
  );
}

/**
 * Whether a GitHub OIDC subject names a repository and exactly the environment
 * `environment`, so only that one environment presents it. GitHub environment
 * names are unique in a repository regardless of case. The repository may be
 * named by an older name from before a rename. A subject with no repository,
 * such as an owner-wide one, or with no environment is presented by other
 * repositories or environments too.
 */
export function namesOneEnvironment(
  subject: string,
  environment: string
): boolean {
  const claims = exactClaims(subject);
  if (!claims) return false;
  const encoded = buildEnvironmentSuffix(environment)
    .slice("environment:".length)
    .toLowerCase();
  const environments = claims.filter(([key]) => key === "environment");
  return (
    environments.length === 1 &&
    environments[0][1].toLowerCase() === encoded &&
    claims.some(([key]) => REPOSITORY_CLAIMS.has(key))
  );
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
  "account:ListRegions",
  "iam:ListRoles",
  "organizations:DescribeOrganization"
];

/**
 * The environment's permission policy: the statements of AWS's
 * `PowerUserAccess` managed policy, with the broad grant limited to the
 * environment's region. It is written per environment, so a role shared by
 * environments in two regions can act in exactly those two, and deleting one
 * environment removes only that environment's grant. Other policies on a
 * picked role can grant additional access; this policy must not deny them.
 */
export function buildAwsEnvironmentPermissionPolicy(
  region: string
): PolicyDocument {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        NotAction: [
          "iam:*",
          "organizations:*",
          "account:*",
          // Exclude the five access-administration actions, not the read APIs.
          "eks:*teAccessEntry",
          "eks:*AccessPolicy"
        ],
        Resource: "*",
        Condition: { StringEquals: { "aws:RequestedRegion": region } }
      },
      {
        Effect: "Allow",
        Action: [...GLOBAL_POWER_USER_ACTIONS],
        Resource: "*"
      },
      {
        Effect: "Allow",
        Action: "iam:CreateServiceLinkedRole",
        Resource: "*",
        Condition: {
          StringEquals: {
            "iam:AWSServiceName": [
              "rds.amazonaws.com",
              "elasticache.amazonaws.com",
              "opensearchservice.amazonaws.com"
            ]
          }
        }
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

// IAM role tag keys ignore case and preserve it, so `Radius-Managed` is the
// same tag as `radius-managed`.
function roleTag(role: unknown, key: string): string {
  const tags = awsRoleTags(role);
  const match = Object.keys(tags).find((name) => name.toLowerCase() === key);
  return match === undefined ? "" : tags[match];
}

/**
 * The repository Radius created this role for, or null when Radius did not
 * tag it as one of its own.
 */
export function radiusRoleRepository(role: unknown): string | null {
  if (roleTag(role, AWS_MANAGED_TAG) !== "true") return null;
  return roleTag(role, AWS_REPOSITORY_TAG) || null;
}

/** Whether Radius created this role for this repository. */
export function isRadiusManagedRole(
  role: unknown,
  repoFullName: string
): boolean {
  return (
    radiusRoleRepository(role)?.toLowerCase() === repoFullName.toLowerCase()
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

/**
 * Why setup cannot use a cluster. When more than one applies, the first in
 * this order wins: the cluster could not be described, its status is not
 * ACTIVE or UPDATING, or its CONFIG_MAP authentication cannot take an access
 * entry.
 */
export type AwsClusterUnusableReason =
  "not-described" | "status" | "config-map";

const EKS_CLUSTER_NAME_PATTERN = /^[0-9A-Za-z][A-Za-z0-9_-]{0,99}$/;

/** Whether a value has the form of an EKS cluster name. */
export function isEksClusterName(value: string): boolean {
  return EKS_CLUSTER_NAME_PATTERN.test(value);
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

// The deploy identity lock. IAM has no conditional write for a trust policy,
// but `CreatePolicy` refuses a name that already exists in the account, so
// creating this policy is a test-and-set: one caller wins and the rest wait.
// IAM names ignore case, as role names do, so one role always maps to one lock.

const LOCK_POLICY_PREFIX = "radius-lock-";
const LOCK_DESCRIPTION_MAX = 1000;

/** How long a lock is held before a waiting run offers to remove it. */
export const AWS_LOCK_REMOVABLE_AFTER_MS = 10 * 60 * 1000;

export type AwsLockAction = "setup" | "delete" | "repair" | "rollback";

const LOCK_ACTIONS: readonly AwsLockAction[] = [
  "setup",
  "delete",
  "repair",
  "rollback"
];

/** The Radius run that holds a deploy identity lock. */
export interface AwsLockHolder {
  readonly repo: string;
  readonly environment: string;
  readonly action: AwsLockAction;
  readonly operationId: string;
}

/** The lock policy's name: `radius-lock-<role>`, at most 76 characters. */
export function buildAwsLockPolicyName(roleName: string): string {
  return `${LOCK_POLICY_PREFIX}${roleName}`;
}

export function awsLockPolicyArn(accountId: string, roleName: string): string {
  return `arn:aws:iam::${accountId}:policy/${buildAwsLockPolicyName(roleName)}`;
}

/** A lock an operation recorded when it took it. */
export interface RecordedAwsLock {
  readonly policyArn: string;
  readonly policyId: string;
  // The role the lock protects, read from the lock's name.
  readonly roleName: string;
}

const LOCK_POLICY_ARN = /^arn:aws:iam::\d{12}:policy\/radius-lock-(.+)$/;

/**
 * The lock an operation's context records in `awsDeployIdentityLock`, or null
 * when it records none or the record is not a lock policy and its ID.
 */
export function readRecordedAwsLock(context: unknown): RecordedAwsLock | null {
  if (typeof context !== "object" || context === null) return null;
  const lock =
    "awsDeployIdentityLock" in context ?
      context.awsDeployIdentityLock
    : undefined;
  if (
    typeof lock !== "object" ||
    lock === null ||
    !("policyArn" in lock) ||
    typeof lock.policyArn !== "string" ||
    !("policyId" in lock) ||
    typeof lock.policyId !== "string" ||
    !lock.policyId
  ) {
    return null;
  }
  const match = LOCK_POLICY_ARN.exec(lock.policyArn);
  if (!match?.[1]) return null;
  return {
    policyArn: lock.policyArn,
    policyId: lock.policyId,
    roleName: match[1]
  };
}

/**
 * The lock policy's document. It is never attached, and even if it were, it
 * only denies passing the lock policy itself as a role, which matches nothing.
 */
export function buildAwsLockPolicyDocument(
  accountId: string,
  roleName: string
): PolicyDocument {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "RadiusDeployIdentityLock",
        Effect: "Deny",
        Action: "iam:PassRole",
        Resource: awsLockPolicyArn(accountId, roleName)
      }
    ]
  };
}

/**
 * The lock policy's description, naming the holder. IAM descriptions accept
 * only Latin-1 characters, so anything else is written as a JSON escape.
 */
export function describeAwsLockHolder(holder: AwsLockHolder): string {
  const text = JSON.stringify({
    repo: holder.repo,
    environment: holder.environment,
    action: holder.action,
    operationId: holder.operationId
  }).replace(
    /[^\x20-\x7e]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
  return text.length <= LOCK_DESCRIPTION_MAX ?
      text
    : JSON.stringify({
        action: holder.action,
        operationId: holder.operationId
      });
}

/** The holder a lock description names, or null when it names none. */
export function parseAwsLockHolder(description: unknown): AwsLockHolder | null {
  if (typeof description !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(description);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const action = LOCK_ACTIONS.find((value) => value === parsed.action);
  if (!action) return null;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    repo: text(parsed.repo),
    environment: text(parsed.environment),
    action,
    operationId: text(parsed.operationId)
  };
}

/** How a waiting run names the lock's holder. */
export function awsLockHolderLabel(holder: AwsLockHolder | null): string {
  if (!holder) return "Another run";
  const target =
    holder.environment && holder.repo ?
      `environment ${holder.environment} in ${holder.repo}`
    : holder.repo || "an unnamed environment";
  return `The ${holder.action} of ${target}`;
}

/** When IAM created a lock, for a person: `2026-10-30 11:58 UTC`. */
export function formatAwsLockTime(since: string): string {
  const time = Date.parse(since);
  return isNaN(time) ? "an unknown time" : (
      `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC`
    );
}
