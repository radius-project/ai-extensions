import type { AwsCommandResult } from "../../../src/server/services/aws-cli-session.js";

// A stateful stand-in for the AWS CLI. It keeps the IAM, STS, and EKS state
// Radius reads and writes, and answers each `aws <args>` the way the CLI v2
// does: JSON on stdout, the service's error on stderr with exit code 254.
// Unlike scripted answers, a write changes what later reads see, so a test can
// stop a run anywhere and compare what AWS holds with what Radius saved.

export interface FakeIamRole {
  RoleName: string;
  RoleId: string;
  Arn: string;
  CreateDate: string;
  Description: string;
  Tags: Array<{ Key: string; Value: string }>;
  AssumeRolePolicyDocument: unknown;
  inline: Map<string, unknown>;
  attached: string[];
}

export interface FakeManagedPolicy {
  PolicyName: string;
  PolicyId: string;
  Arn: string;
  Path: string;
  CreateDate: string;
  Description: string;
  Tags: Array<{ Key: string; Value: string }>;
  // Oldest first. IAM numbers versions v1, v2, ... and never reuses a number.
  versions: Array<{ VersionId: string; document: unknown; CreateDate: string }>;
  DefaultVersionId: string;
  // IAM roles outside this fake that use the policy as their permissions
  // boundary, such as app roles a Recipe created through Cloud Control.
  boundaryUses: number;
}

export interface FakeAccessEntry {
  principalArn: string;
  createdAt: string;
  type: string;
  tags: Record<string, string>;
  policies: string[];
}

export interface FakeEksCluster {
  name: string;
  region: string;
  status: string;
  authenticationMode: string;
  // The eks-pod-identity-agent add-on's status, or null when not installed.
  podIdentityAgent: string | null;
  entries: Map<string, FakeAccessEntry>;
}

// What a test compares: everything that exists, in a stable order.
export interface FakeAwsSnapshot {
  roles: Array<{
    RoleName: string;
    RoleId: string;
    Tags: Array<{ Key: string; Value: string }>;
    trust: unknown;
    inline: string[];
    attached: string[];
  }>;
  policies: Array<{ Arn: string; PolicyId: string; Description: string }>;
  oidcProviders: string[];
  entries: Array<{
    cluster: string;
    principalArn: string;
    tags: Record<string, string>;
    policies: string[];
  }>;
}

const GITHUB_PROVIDER_HOST = "token.actions.githubusercontent.com";

// The AWS CLI's own words for each refusal Radius reads.
function serviceError(
  code: string,
  operation: string,
  message: string
): AwsCommandResult {
  return {
    code: 254,
    stdout: "",
    stderr: `\nAn error occurred (${code}) when calling the ${operation} operation: ${message}\n`
  };
}

function ok(value?: unknown): AwsCommandResult {
  return {
    code: 0,
    stdout: value === undefined ? "" : `${JSON.stringify(value, null, 4)}\n`,
    stderr: ""
  };
}

// The value after `--flag`, or "" when the flag is absent.
function flag(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? "") : "";
}

// Every value after `--flag` up to the next flag, as `--tags` takes them.
function flagValues(args: readonly string[], name: string): string[] {
  const index = args.indexOf(name);
  if (index < 0) return [];
  const values: string[] = [];
  for (const value of args.slice(index + 1)) {
    if (value.startsWith("--")) break;
    values.push(value);
  }
  return values;
}

// The commands that change IAM or EKS, named here rather than borrowed from
// production, so a test of "no write after a stop" does not share the code's
// own idea of a write.
const WRITES: ReadonlySet<string> = new Set([
  "iam create-policy",
  "iam delete-policy",
  "iam create-policy-version",
  "iam delete-policy-version",
  "iam create-role",
  "iam update-assume-role-policy",
  "iam delete-role",
  "iam put-role-policy",
  "iam delete-role-policy",
  "iam create-open-id-connect-provider",
  "eks create-access-entry",
  "eks delete-access-entry",
  "eks associate-access-policy"
]);

// `--tags Key=k,Value=v ...`, as create-role and create-policy take them.
function parseTags(
  args: readonly string[]
): Array<{ Key: string; Value: string }> {
  return flagValues(args, "--tags").map((pair) => {
    const match = /^Key=([^,]*),Value=(.*)$/.exec(pair);
    if (!match) throw new Error(`fake aws: unreadable tag ${pair}`);
    return { Key: match[1] ?? "", Value: match[2] ?? "" };
  });
}

export function awsCommand(args: readonly string[]): string {
  return args[0] === "--version" ? "--version" : args.slice(0, 2).join(" ");
}

export function isFakeAwsWrite(args: readonly string[]): boolean {
  return WRITES.has(awsCommand(args));
}

export interface FakeAwsOptions {
  accountId?: string;
  // Milliseconds since the epoch, read for every creation time.
  now?: () => number;
}

export class FakeAws {
  readonly accountId: string;
  readonly roles = new Map<string, FakeIamRole>();
  readonly policies = new Map<string, FakeManagedPolicy>();
  readonly oidcProviders = new Map<string, { clientIds: string[] }>();
  readonly clusters = new Map<string, FakeEksCluster>();
  // Set to make every call fail the way an expired sign-in does.
  sessionExpired = false;
  // Commands refused once each, as AWS refuses a call it throttles.
  private readonly refusals = new Map<
    string,
    { code: string; only: (args: readonly string[]) => boolean }
  >();
  private readonly now: () => number;
  private ids = 0;

  constructor(options: FakeAwsOptions = {}) {
    this.accountId = options.accountId ?? "123456789012";
    let tick = Date.parse("2026-11-01T00:00:00Z");
    // Each creation is a second after the last, so ages always order.
    this.now = options.now ?? (() => (tick += 1000));
  }

  addCluster(
    name: string,
    region: string,
    authenticationMode = "API_AND_CONFIG_MAP"
  ): void {
    this.clusters.set(`${region}:${name}`, {
      name,
      region,
      status: "ACTIVE",
      authenticationMode,
      podIdentityAgent: "ACTIVE",
      entries: new Map()
    });
  }

  addGitHubProvider(): void {
    this.oidcProviders.set(this.providerArn(), {
      clientIds: ["sts.amazonaws.com"]
    });
  }

  // A role that exists before the test starts, such as one another setup made.
  addRole(input: {
    name: string;
    trust: unknown;
    tags?: Array<{ Key: string; Value: string }>;
    inline?: Record<string, unknown>;
    attached?: string[];
  }): FakeIamRole {
    const role: FakeIamRole = {
      RoleName: input.name,
      RoleId: this.nextId("AROA"),
      Arn: this.roleArn(input.name),
      CreateDate: this.time(),
      Description: "",
      Tags: [...(input.tags ?? [])],
      AssumeRolePolicyDocument: input.trust,
      inline: new Map(Object.entries(input.inline ?? {})),
      attached: [...(input.attached ?? [])]
    };
    this.roles.set(input.name.toLowerCase(), role);
    return role;
  }

  // A managed policy that exists before the test starts, such as another
  // environment's permissions boundary.
  addManagedPolicy(input: {
    path: string;
    name: string;
    document: unknown;
    tags?: Array<{ Key: string; Value: string }>;
  }): FakeManagedPolicy {
    const created = this.time();
    const policy: FakeManagedPolicy = {
      PolicyName: input.name,
      PolicyId: this.nextId("ANPA"),
      Arn: `arn:aws:iam::${this.accountId}:policy${input.path}${input.name}`,
      Path: input.path,
      CreateDate: created,
      Description: "",
      Tags: [...(input.tags ?? [])],
      versions: [
        { VersionId: "v1", document: input.document, CreateDate: created }
      ],
      DefaultVersionId: "v1",
      boundaryUses: 0
    };
    this.policies.set(policy.Arn, policy);
    return policy;
  }

  addAccessEntry(
    region: string,
    cluster: string,
    principalArn: string,
    tags: Record<string, string> = {},
    policies: string[] = []
  ): void {
    const target = this.clusters.get(`${region}:${cluster}`);
    if (!target) throw new Error(`fake aws: no cluster ${region}:${cluster}`);
    target.entries.set(principalArn, {
      principalArn,
      createdAt: this.time(),
      type: "STANDARD",
      tags: { ...tags },
      policies: [...policies]
    });
  }

  /**
   * Refuse the next `command` once with `code`, changing nothing. With
   * `only`, refuse the next one whose arguments it accepts.
   */
  refuseOnce(
    command: string,
    code: string,
    only: (args: readonly string[]) => boolean = () => true
  ): void {
    this.refusals.set(command, { code, only });
  }

  roleArn(name: string): string {
    return `arn:aws:iam::${this.accountId}:role/${name}`;
  }

  providerArn(): string {
    return `arn:aws:iam::${this.accountId}:oidc-provider/${GITHUB_PROVIDER_HOST}`;
  }

  role(name: string): FakeIamRole | undefined {
    return this.roles.get(name.toLowerCase());
  }

  // The lock policies that exist, as Radius names them.
  locks(): FakeManagedPolicy[] {
    return [...this.policies.values()].filter((policy) =>
      policy.PolicyName.startsWith("radius-lock-")
    );
  }

  snapshot(): FakeAwsSnapshot {
    return {
      roles: [...this.roles.values()]
        .map((role) => ({
          RoleName: role.RoleName,
          RoleId: role.RoleId,
          Tags: [...role.Tags],
          trust: role.AssumeRolePolicyDocument,
          inline: [...role.inline.keys()].sort(),
          attached: [...role.attached].sort()
        }))
        .sort((a, b) => a.RoleName.localeCompare(b.RoleName)),
      policies: [...this.policies.values()]
        .map((policy) => ({
          Arn: policy.Arn,
          PolicyId: policy.PolicyId,
          Description: policy.Description
        }))
        .sort((a, b) => a.Arn.localeCompare(b.Arn)),
      oidcProviders: [...this.oidcProviders.keys()].sort(),
      entries: [...this.clusters.values()]
        .flatMap((cluster) =>
          [...cluster.entries.values()].map((entry) => ({
            cluster: `${cluster.region}:${cluster.name}`,
            principalArn: entry.principalArn,
            tags: { ...entry.tags },
            policies: [...entry.policies].sort()
          }))
        )
        .sort((a, b) =>
          `${a.cluster}|${a.principalArn}`.localeCompare(
            `${b.cluster}|${b.principalArn}`
          )
        )
    };
  }

  /** Answer one `aws <args>` call, changing state for a write that succeeds. */
  run(args: readonly string[]): AwsCommandResult {
    const command = awsCommand(args);
    if (command === "--version") {
      return {
        code: 0,
        stdout: "aws-cli/2.17.0 Python/3.11 Linux/6\n",
        stderr: ""
      };
    }
    const refusal = this.refusals.get(command);
    if (refusal?.only(args)) {
      this.refusals.delete(command);
      return serviceError(refusal.code, command, "Refused by the test.");
    }
    if (this.sessionExpired) {
      return serviceError(
        "ExpiredToken",
        "GetCallerIdentity",
        "The security token included in the request is expired"
      );
    }
    switch (command) {
      case "sts get-caller-identity":
        return ok({
          UserId: "AIDAFAKE",
          Account: this.accountId,
          Arn: `arn:aws:iam::${this.accountId}:user/radius-test`
        });
      case "eks describe-cluster":
        return this.describeCluster(args);
      case "eks describe-addon":
        return this.describeAddon(args);
      case "iam create-policy":
        return this.createPolicy(args);
      case "iam get-policy":
        return this.withPolicy(args, "GetPolicy", (policy) =>
          ok({ Policy: this.policyView(policy) })
        );
      case "iam delete-policy":
        return this.deletePolicy(args);
      case "iam list-policy-versions":
        return this.withPolicy(args, "ListPolicyVersions", (policy) =>
          ok({
            Versions: [...policy.versions].reverse().map((version) => ({
              VersionId: version.VersionId,
              IsDefaultVersion: version.VersionId === policy.DefaultVersionId,
              CreateDate: version.CreateDate
            })),
            IsTruncated: false
          })
        );
      case "iam get-policy-version":
        return this.withPolicy(args, "GetPolicyVersion", (policy) => {
          const version = policy.versions.find(
            (candidate) => candidate.VersionId === flag(args, "--version-id")
          );
          if (!version) {
            return serviceError(
              "NoSuchEntity",
              "GetPolicyVersion",
              `Policy ${policy.Arn} version ${flag(args, "--version-id")} does not exist or is not attachable.`
            );
          }
          return ok({
            PolicyVersion: {
              Document: version.document,
              VersionId: version.VersionId,
              IsDefaultVersion: version.VersionId === policy.DefaultVersionId,
              CreateDate: version.CreateDate
            }
          });
        });
      case "iam create-policy-version":
        return this.withPolicy(args, "CreatePolicyVersion", (policy) => {
          if (policy.versions.length >= 5) {
            return serviceError(
              "LimitExceeded",
              "CreatePolicyVersion",
              `A managed policy can have up to 5 versions. Before you create a new version, you must delete an existing version.`
            );
          }
          const last = policy.versions.at(-1)?.VersionId ?? "v0";
          const version = {
            VersionId: `v${Number(last.slice(1)) + 1}`,
            document: JSON.parse(flag(args, "--policy-document")),
            CreateDate: this.time()
          };
          policy.versions.push(version);
          if (args.includes("--set-as-default")) {
            policy.DefaultVersionId = version.VersionId;
          }
          return ok({
            PolicyVersion: {
              VersionId: version.VersionId,
              IsDefaultVersion: version.VersionId === policy.DefaultVersionId,
              CreateDate: version.CreateDate
            }
          });
        });
      case "iam delete-policy-version":
        return this.withPolicy(args, "DeletePolicyVersion", (policy) => {
          const id = flag(args, "--version-id");
          if (id === policy.DefaultVersionId) {
            return serviceError(
              "DeleteConflict",
              "DeletePolicyVersion",
              "Cannot delete the default version of a policy."
            );
          }
          const index = policy.versions.findIndex(
            (version) => version.VersionId === id
          );
          if (index < 0) {
            return serviceError(
              "NoSuchEntity",
              "DeletePolicyVersion",
              `Policy ${policy.Arn} version ${id} does not exist or is not deletable.`
            );
          }
          policy.versions.splice(index, 1);
          return ok();
        });
      case "iam get-role":
        return this.getRole(args);
      case "iam create-role":
        return this.createRole(args);
      case "iam update-assume-role-policy":
        return this.withRole(args, "UpdateAssumeRolePolicy", (role) => {
          role.AssumeRolePolicyDocument = JSON.parse(
            flag(args, "--policy-document")
          );
          return ok();
        });
      case "iam delete-role":
        return this.withRole(args, "DeleteRole", (role) => {
          if (role.inline.size > 0 || role.attached.length > 0) {
            return serviceError(
              "DeleteConflict",
              "DeleteRole",
              "Cannot delete entity, must delete policies first."
            );
          }
          this.roles.delete(role.RoleName.toLowerCase());
          return ok();
        });
      case "iam list-role-policies":
        return this.withRole(args, "ListRolePolicies", (role) =>
          ok({ PolicyNames: [...role.inline.keys()], IsTruncated: false })
        );
      case "iam list-attached-role-policies":
        return this.withRole(args, "ListAttachedRolePolicies", (role) =>
          ok({
            AttachedPolicies: role.attached.map((arn) => ({
              PolicyName: arn.split("/").pop(),
              PolicyArn: arn
            })),
            IsTruncated: false
          })
        );
      case "iam get-role-policy":
        return this.withRole(args, "GetRolePolicy", (role) => {
          const name = flag(args, "--policy-name");
          if (!role.inline.has(name)) {
            return serviceError(
              "NoSuchEntity",
              "GetRolePolicy",
              `The role policy with name ${name} cannot be found.`
            );
          }
          return ok({
            RoleName: role.RoleName,
            PolicyName: name,
            PolicyDocument: role.inline.get(name)
          });
        });
      case "iam put-role-policy":
        return this.withRole(args, "PutRolePolicy", (role) => {
          role.inline.set(
            flag(args, "--policy-name"),
            JSON.parse(flag(args, "--policy-document"))
          );
          return ok();
        });
      case "iam delete-role-policy":
        return this.withRole(args, "DeleteRolePolicy", (role) => {
          const name = flag(args, "--policy-name");
          if (!role.inline.delete(name)) {
            return serviceError(
              "NoSuchEntity",
              "DeleteRolePolicy",
              `The role policy with name ${name} cannot be found.`
            );
          }
          return ok();
        });
      case "iam list-open-id-connect-providers":
        return ok({
          OpenIDConnectProviderList: [...this.oidcProviders.keys()].map(
            (Arn) => ({ Arn })
          )
        });
      case "iam get-open-id-connect-provider": {
        const provider = this.oidcProviders.get(
          flag(args, "--open-id-connect-provider-arn")
        );
        if (!provider) {
          return serviceError(
            "NoSuchEntity",
            "GetOpenIDConnectProvider",
            "OpenIDConnect Provider not found"
          );
        }
        return ok({
          Url: GITHUB_PROVIDER_HOST,
          ClientIDList: [...provider.clientIds],
          ThumbprintList: []
        });
      }
      case "iam create-open-id-connect-provider": {
        const arn = this.providerArn();
        if (this.oidcProviders.has(arn)) {
          return serviceError(
            "EntityAlreadyExists",
            "CreateOpenIDConnectProvider",
            "Provider with url already exists."
          );
        }
        this.oidcProviders.set(arn, {
          clientIds: flagValues(args, "--client-id-list")
        });
        return ok({ OpenIDConnectProviderArn: arn });
      }
      case "eks create-access-entry":
        return this.createAccessEntry(args);
      case "eks describe-access-entry":
        return this.withEntry(args, "DescribeAccessEntry", (cluster, entry) =>
          ok({
            accessEntry: {
              clusterName: cluster.name,
              principalArn: entry.principalArn,
              createdAt: entry.createdAt,
              type: entry.type,
              tags: { ...entry.tags }
            }
          })
        );
      case "eks delete-access-entry":
        return this.withEntry(args, "DeleteAccessEntry", (cluster, entry) => {
          cluster.entries.delete(entry.principalArn);
          return ok();
        });
      case "eks associate-access-policy":
        return this.withEntry(args, "AssociateAccessPolicy", (_c, entry) => {
          const policy = flag(args, "--policy-arn");
          if (!entry.policies.includes(policy)) entry.policies.push(policy);
          return ok({ associatedAccessPolicy: { policyArn: policy } });
        });
    }
    throw new Error(`fake aws: no answer for aws ${args.join(" ")}`);
  }

  private nextId(prefix: string): string {
    this.ids += 1;
    return `${prefix}FAKE${String(this.ids).padStart(6, "0")}`;
  }

  private time(): string {
    return new Date(this.now()).toISOString();
  }

  private describeCluster(args: readonly string[]): AwsCommandResult {
    const cluster = this.clusters.get(
      `${flag(args, "--region")}:${flag(args, "--name")}`
    );
    if (!cluster) {
      return serviceError(
        "ResourceNotFoundException",
        "DescribeCluster",
        `No cluster found for name: ${flag(args, "--name")}.`
      );
    }
    return ok({
      cluster: {
        name: cluster.name,
        status: cluster.status,
        accessConfig: { authenticationMode: cluster.authenticationMode }
      }
    });
  }

  private describeAddon(args: readonly string[]): AwsCommandResult {
    const cluster = this.cluster(args);
    const name = flag(args, "--addon-name");
    const status =
      name === "eks-pod-identity-agent" ? cluster?.podIdentityAgent : null;
    if (!cluster || !status) {
      return serviceError(
        "ResourceNotFoundException",
        "DescribeAddon",
        `No addon: ${name} found in cluster: ${flag(args, "--cluster-name")}`
      );
    }
    return ok({
      addon: { addonName: name, clusterName: cluster.name, status }
    });
  }

  private policyView(policy: FakeManagedPolicy) {
    return {
      PolicyName: policy.PolicyName,
      PolicyId: policy.PolicyId,
      Arn: policy.Arn,
      Path: policy.Path,
      DefaultVersionId: policy.DefaultVersionId,
      AttachmentCount: this.attachments(policy.Arn),
      PermissionsBoundaryUsageCount: policy.boundaryUses,
      CreateDate: policy.CreateDate,
      Description: policy.Description,
      Tags: policy.Tags.map((tag) => ({ ...tag }))
    };
  }

  private attachments(arn: string): number {
    return [...this.roles.values()].filter((role) =>
      role.attached.includes(arn)
    ).length;
  }

  private withPolicy(
    args: readonly string[],
    operation: string,
    work: (policy: FakeManagedPolicy) => AwsCommandResult
  ): AwsCommandResult {
    const arn = flag(args, "--policy-arn");
    const policy = this.policies.get(arn);
    if (!policy) {
      return serviceError(
        "NoSuchEntity",
        operation,
        `Policy ${arn} was not found.`
      );
    }
    return work(policy);
  }

  private createPolicy(args: readonly string[]): AwsCommandResult {
    const name = flag(args, "--policy-name");
    // IAM names ignore case and must be unique in the account, whatever the
    // path, so one role always has one lock.
    const taken = [...this.policies.values()].some(
      (policy) => policy.PolicyName.toLowerCase() === name.toLowerCase()
    );
    if (taken) {
      return serviceError(
        "EntityAlreadyExists",
        "CreatePolicy",
        `A policy called ${name} already exists. Duplicate names are not allowed.`
      );
    }
    const path = flag(args, "--path") || "/";
    const created = this.time();
    const policy: FakeManagedPolicy = {
      PolicyName: name,
      PolicyId: this.nextId("ANPA"),
      Arn: `arn:aws:iam::${this.accountId}:policy${path}${name}`,
      Path: path,
      CreateDate: created,
      Description: flag(args, "--description"),
      Tags: parseTags(args),
      versions: [
        {
          VersionId: "v1",
          document: JSON.parse(flag(args, "--policy-document")),
          CreateDate: created
        }
      ],
      DefaultVersionId: "v1",
      boundaryUses: 0
    };
    this.policies.set(policy.Arn, policy);
    return ok({ Policy: this.policyView(policy) });
  }

  private deletePolicy(args: readonly string[]): AwsCommandResult {
    return this.withPolicy(args, "DeletePolicy", (policy) => {
      if (
        policy.versions.length > 1 ||
        policy.boundaryUses > 0 ||
        this.attachments(policy.Arn) > 0
      ) {
        return serviceError(
          "DeleteConflict",
          "DeletePolicy",
          "Cannot delete a policy attached to entities or with non-default versions."
        );
      }
      this.policies.delete(policy.Arn);
      return ok();
    });
  }

  private getRole(args: readonly string[]): AwsCommandResult {
    return this.withRole(args, "GetRole", (role) =>
      ok({
        Role: {
          Path: "/",
          RoleName: role.RoleName,
          RoleId: role.RoleId,
          Arn: role.Arn,
          CreateDate: role.CreateDate,
          Description: role.Description,
          AssumeRolePolicyDocument: role.AssumeRolePolicyDocument,
          Tags: role.Tags.map((tag) => ({ ...tag }))
        }
      })
    );
  }

  private createRole(args: readonly string[]): AwsCommandResult {
    const name = flag(args, "--role-name");
    if (this.role(name)) {
      return serviceError(
        "EntityAlreadyExists",
        "CreateRole",
        `Role with name ${name} already exists.`
      );
    }
    const tags = parseTags(args);
    const role: FakeIamRole = {
      RoleName: name,
      RoleId: this.nextId("AROA"),
      Arn: this.roleArn(name),
      CreateDate: this.time(),
      Description: flag(args, "--description"),
      Tags: tags,
      AssumeRolePolicyDocument: JSON.parse(
        flag(args, "--assume-role-policy-document")
      ),
      inline: new Map(),
      attached: []
    };
    this.roles.set(name.toLowerCase(), role);
    return ok({
      Role: {
        Path: "/",
        RoleName: role.RoleName,
        RoleId: role.RoleId,
        Arn: role.Arn,
        CreateDate: role.CreateDate,
        AssumeRolePolicyDocument: role.AssumeRolePolicyDocument,
        Tags: role.Tags
      }
    });
  }

  private withRole(
    args: readonly string[],
    operation: string,
    work: (role: FakeIamRole) => AwsCommandResult
  ): AwsCommandResult {
    const name = flag(args, "--role-name");
    const role = this.role(name);
    if (!role) {
      return serviceError(
        "NoSuchEntity",
        operation,
        `The role with name ${name} cannot be found.`
      );
    }
    return work(role);
  }

  private cluster(args: readonly string[]): FakeEksCluster | undefined {
    return this.clusters.get(
      `${flag(args, "--region")}:${flag(args, "--cluster-name")}`
    );
  }

  private createAccessEntry(args: readonly string[]): AwsCommandResult {
    const cluster = this.cluster(args);
    const principalArn = flag(args, "--principal-arn");
    if (!cluster) {
      return serviceError(
        "ResourceNotFoundException",
        "CreateAccessEntry",
        "No cluster found."
      );
    }
    if (cluster.entries.has(principalArn)) {
      return serviceError(
        "ResourceInUseException",
        "CreateAccessEntry",
        "The specified access entry resource is already in use on this cluster."
      );
    }
    if (!this.role(principalArn.split("/").pop() ?? "")) {
      return serviceError(
        "InvalidParameterException",
        "CreateAccessEntry",
        `The specified principalArn is invalid: invalid principal ${principalArn}`
      );
    }
    const tags: Record<string, string> = {};
    for (const pair of flag(args, "--tags").split(",").filter(Boolean)) {
      const [key = "", ...value] = pair.split("=");
      tags[key] = value.join("=");
    }
    const entry: FakeAccessEntry = {
      principalArn,
      createdAt: this.time(),
      type: flag(args, "--type") || "STANDARD",
      tags,
      policies: []
    };
    cluster.entries.set(principalArn, entry);
    return ok({
      accessEntry: {
        clusterName: cluster.name,
        principalArn,
        createdAt: entry.createdAt,
        type: entry.type,
        tags: { ...tags }
      }
    });
  }

  private withEntry(
    args: readonly string[],
    operation: string,
    work: (cluster: FakeEksCluster, entry: FakeAccessEntry) => AwsCommandResult
  ): AwsCommandResult {
    const cluster = this.cluster(args);
    const entry = cluster?.entries.get(flag(args, "--principal-arn"));
    if (!cluster || !entry) {
      return serviceError(
        "ResourceNotFoundException",
        operation,
        "The specified access entry resource could not be found."
      );
    }
    return work(cluster, entry);
  }
}
