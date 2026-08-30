// The cloud run's external world.
//
// The one rule that gives this layer its value: **the fixture never creates
// anything the product creates.** It provisions a per-run resource group, a
// per-run AKS cluster for the product to discover, and a clone of the fixture
// repository at the pinned baseline. It does not create the app registration,
// the service principal, the federated credential, the role assignments, the
// GitHub Environment, or any workflow file. If it did, asserting those exist
// would prove nothing, and later asserting they are gone would prove only that
// the fixture cleaned up after itself.
//
// `assertCleanSlate()` is what enforces the rule at run time. It asserts every
// product-created artifact is absent before the journey starts, which turns the
// later assertions from observations into proofs and catches a previous run's
// leaked state before that state silently turns a red test green.
//
// Every external call goes through an injected port, so each branch below is
// provable without an Azure or GitHub credential.
import {
  describeError,
  expectSuccess,
  parseJsonArray,
  type CloudCommandPort,
  type CloudCommandResult,
  type CloudFixturePorts
} from "./cloud-command-port.js";
import {
  appRegistrationName,
  clusterName as buildClusterName,
  environmentName as buildEnvironmentName,
  FIXTURE_BASELINE_SHA,
  FIXTURE_REPO_DEFAULT_BRANCH,
  FIXTURE_REPOSITORY,
  resourceGroupName,
  resourceGroupScope,
  shortenUniqueId,
  WORKFLOW_FALLBACK_BRANCH_PREFIX
} from "./fixture-repository.js";

/** The Entra application the product creates, as the fixture observed it. */
export interface AppRegistrationRecord {
  /** The client id workflows authenticate with. */
  readonly appId: string;
  /** The directory object id `az ad app federated-credential` addresses. */
  readonly objectId: string;
  readonly displayName: string;
}

export interface CloudFixture {
  readonly uniqueId: string;
  readonly resourceGroup: string;
  readonly clusterName: string;
  readonly environmentName: string;
  readonly workspacePath: string;
  readonly subscriptionId: string;
  readonly location: string;
  readonly repository: string;
  readonly defaultBranch: string;
  readonly baselineSha: string;

  /** Fails when any product-created artifact is already present. */
  assertCleanSlate(): Promise<void>;
  assertAppRegistrationExists(): Promise<AppRegistrationRecord>;
  assertFederatedCredentialExists(subject: string): Promise<void>;
  assertRoleAssignmentExists(principalId: string): Promise<void>;
  assertGitHubEnvironmentExists(): Promise<void>;
  /**
   * Best-effort removal of product-created state left behind by this run.
   *
   * Deliberately separate from `dispose()`, and named so a reviewer can see it
   * only ever runs after the journey's assertions. Without it every run would
   * leak an Entra application that fails the next run's clean slate; with it
   * inside `dispose()`, teardown would be able to launder a product failure.
   * The returned list makes a leak visible instead of silent.
   */
  reclaimLeakedProductArtifacts(): Promise<readonly string[]>;
  /** Removes only what the fixture created. Idempotent. */
  dispose(): Promise<void>;
}

export interface CloudFixtureOptions {
  readonly subscriptionId: string;
  readonly ports: CloudFixturePorts;
  readonly location?: string;
  readonly repository?: string;
  readonly defaultBranch?: string;
  readonly baselineSha?: string;
  /** Node count for the discovery-target cluster. One is enough. */
  readonly nodeCount?: number;
}

const DEFAULT_LOCATION = "westus3";
const DEFAULT_NODE_COUNT = 1;
const CLUSTER_NODE_SIZE = "Standard_B2s";

interface UnwindStep {
  readonly describe: string;
  readonly run: () => Promise<void>;
}

export async function createCloudFixture(
  options: CloudFixtureOptions
): Promise<CloudFixture> {
  const subscriptionId = requireValue(
    options.subscriptionId,
    "A subscription id is required to provision the cloud fixture."
  );
  const ports = options.ports;
  const commands = ports.commands;
  const location = options.location ?? DEFAULT_LOCATION;
  const repository = options.repository ?? FIXTURE_REPOSITORY;
  const defaultBranch = options.defaultBranch ?? FIXTURE_REPO_DEFAULT_BRANCH;
  const baselineSha = options.baselineSha ?? FIXTURE_BASELINE_SHA;
  const nodeCount = options.nodeCount ?? DEFAULT_NODE_COUNT;

  const uniqueId = shortenUniqueId(ports.newUniqueId());
  const resourceGroup = resourceGroupName(uniqueId);
  const clusterName = buildClusterName(uniqueId);
  const environmentName = buildEnvironmentName(uniqueId);
  const scope = resourceGroupScope(subscriptionId, resourceGroup);
  const expectedAppName = appRegistrationName(repository);

  const unwind: UnwindStep[] = [];
  let workspacePath = "";

  try {
    // `creationTime` plus the `radtest-` prefix is what lets the Radius purge
    // job in this subscription reclaim the group if the runner dies outright.
    expectSuccess(
      await commands.runAz([
        "group",
        "create",
        "--name",
        resourceGroup,
        "--location",
        location,
        "--subscription",
        subscriptionId,
        "--tags",
        `creationTime=${ports.now().toISOString()}`,
        "radius-canvas-e2e=true",
        "--output",
        "none"
      ]),
      `az group create ${resourceGroup}`
    );
    unwind.push({
      describe: `delete resource group ${resourceGroup}`,
      run: async () => {
        expectSuccess(
          await commands.runAz([
            "group",
            "delete",
            "--name",
            resourceGroup,
            "--subscription",
            subscriptionId,
            "--yes",
            "--no-wait",
            "--output",
            "none"
          ]),
          `az group delete ${resourceGroup}`
        );
      }
    });

    // Purely a discovery target: the product runs `az aks list` and must find a
    // real cluster. Deleting the resource group removes it, so the cluster gets
    // no unwind step of its own.
    expectSuccess(
      await commands.runAz([
        "aks",
        "create",
        "--resource-group",
        resourceGroup,
        "--name",
        clusterName,
        "--subscription",
        subscriptionId,
        "--node-count",
        String(nodeCount),
        "--node-vm-size",
        CLUSTER_NODE_SIZE,
        "--generate-ssh-keys",
        "--output",
        "none"
      ]),
      `az aks create ${clusterName}`
    );

    workspacePath = await ports.makeWorkspaceDir(`radtest-canvas-${uniqueId}`);
    unwind.push({
      describe: `remove workspace ${workspacePath}`,
      run: () => ports.removeDir(workspacePath)
    });

    expectSuccess(
      await commands.runGh(["repo", "clone", repository, workspacePath]),
      `gh repo clone ${repository}`
    );
    // Pin the clone to the reviewed baseline rather than trusting the branch
    // head, so a run that starts against a repository someone left dirty fails
    // at the clean-slate check instead of quietly testing a different app.
    expectSuccess(
      await commands.runGit(["reset", "--hard", baselineSha], workspacePath),
      `git reset --hard ${baselineSha}`
    );
  } catch (error) {
    await unwindAll(unwind);
    throw error;
  }

  let disposed = false;

  const fixture: CloudFixture = {
    uniqueId,
    resourceGroup,
    clusterName,
    environmentName,
    workspacePath,
    subscriptionId,
    location,
    repository,
    defaultBranch,
    baselineSha,

    async assertCleanSlate() {
      const findings = await collectLeakedState({
        commands,
        repository,
        defaultBranch,
        baselineSha,
        environmentName,
        expectedAppName,
        scope
      });
      if (findings.length === 0) return;
      throw new Error(
        "Leaked state from a previous run, not a product regression: " +
          `the create-environment journey for ${repository} must start with none of the ` +
          "artifacts the product is responsible for creating, but found:\n" +
          findings.map((finding) => `  - ${finding}`).join("\n") +
          "\nReclaim it before re-running; see the cloud E2E runbook."
      );
    },

    async assertAppRegistrationExists() {
      const apps = await listAppRegistrations(commands, expectedAppName);
      if (apps.length === 0)
        throw new Error(
          `Expected the product to have created an app registration named "${expectedAppName}", but none exists.`
        );
      if (apps.length > 1)
        throw new Error(
          `Expected exactly one app registration named "${expectedAppName}", but found ${apps.length} ` +
            `(${apps.map((app) => app.appId).join(", ")}). The product does not scope this name per run, ` +
            "so a concurrent run against the same fixture repository is the likely cause."
        );
      return apps[0];
    },

    async assertFederatedCredentialExists(subject) {
      const app = await fixture.assertAppRegistrationExists();
      const credentials = await listFederatedCredentials(
        commands,
        app.objectId
      );
      if (credentials.some((credential) => credential.subject === subject))
        return;
      // Entra compares subjects case-sensitively, so a case-only difference is
      // a real product defect and not a near miss worth passing.
      const caseOnly = credentials.filter(
        (credential) =>
          credential.subject.toLowerCase() === subject.toLowerCase()
      );
      const detail =
        caseOnly.length > 0 ?
          ` A credential differing only by letter casing exists (${caseOnly
            .map((credential) => `"${credential.subject}"`)
            .join(
              ", "
            )}); Entra would reject a token presenting the expected subject.`
        : credentials.length === 0 ?
          " The app registration carries no federated credentials at all."
        : ` Existing subjects: ${credentials
            .map((credential) => `"${credential.subject}"`)
            .join(", ")}.`;
      throw new Error(
        `Expected app registration ${app.appId} to carry a federated credential for subject "${subject}".${detail}`
      );
    },

    async assertRoleAssignmentExists(principalId) {
      const assignments = await listRoleAssignments(commands, scope);
      const matching = assignments.filter(
        (assignment) =>
          assignment.principalId.toLowerCase() === principalId.toLowerCase()
      );
      if (matching.length > 0) return;
      throw new Error(
        `Expected a role assignment for principal ${principalId} at or below ${scope}, but found ` +
          (assignments.length === 0 ?
            "no role assignments at all."
          : `only assignments for ${[
              ...new Set(
                assignments.map((assignment) => assignment.principalId)
              )
            ].join(", ")}.`)
      );
    },

    async assertGitHubEnvironmentExists() {
      const probe = await commands.runGh([
        "api",
        `repos/${repository}/environments/${environmentName}`
      ]);
      if (probe.code === 0) return;
      if (isNotFound(probe))
        throw new Error(
          `Expected the product to have created GitHub Environment "${environmentName}" in ${repository}, but it does not exist.`
        );
      throw new Error(
        `Could not determine whether GitHub Environment "${environmentName}" exists in ${repository}: ` +
          `gh exited ${probe.code}: ${(probe.stderr || probe.stdout).trim()}`
      );
    },

    async reclaimLeakedProductArtifacts() {
      const reclaimed: string[] = [];
      const failures: string[] = [];

      const attempt = async (
        label: string,
        run: () => Promise<void>
      ): Promise<void> => {
        try {
          await run();
          reclaimed.push(label);
        } catch (error) {
          failures.push(`${label}: ${describeError(error)}`);
        }
      };

      // Deleting the application removes its service principal and federated
      // credentials with it, so they need no separate step.
      const apps = await listAppRegistrations(commands, expectedAppName).catch(
        (error: unknown) => {
          failures.push(`list app registrations: ${describeError(error)}`);
          return [] as AppRegistrationRecord[];
        }
      );
      for (const app of apps)
        await attempt(`app registration ${app.appId}`, async () => {
          expectSuccess(
            await commands.runAz([
              "ad",
              "app",
              "delete",
              "--id",
              app.objectId,
              "--output",
              "none"
            ]),
            `az ad app delete ${app.objectId}`
          );
        });

      const environment = await commands.runGh([
        "api",
        `repos/${repository}/environments/${environmentName}`
      ]);
      if (environment.code === 0)
        await attempt(`GitHub environment ${environmentName}`, async () => {
          expectSuccess(
            await commands.runGh([
              "api",
              "--method",
              "DELETE",
              `repos/${repository}/environments/${environmentName}`
            ]),
            `gh api DELETE environments/${environmentName}`
          );
        });
      else if (!isNotFound(environment))
        failures.push(
          `probe GitHub environment ${environmentName}: gh exited ${environment.code}: ${(
            environment.stderr || environment.stdout
          ).trim()}`
        );

      // A leaked `radius/setup-*` branch poisons the next run's clean slate the
      // same way a leaked Entra application does. Deleting the ref also closes
      // any pull request opened from it.
      const branches = await listWorkflowFallbackBranches(
        commands,
        repository
      ).catch((error: unknown) => {
        failures.push(
          `list workflow fallback branches: ${describeError(error)}`
        );
        return [] as string[];
      });
      for (const branch of branches)
        await attempt(`branch ${branch}`, async () => {
          expectSuccess(
            await commands.runGh([
              "api",
              "--method",
              "DELETE",
              `repos/${repository}/git/refs/heads/${branch}`
            ]),
            `gh api DELETE refs/heads/${branch}`
          );
        });

      const head = await readDefaultBranchSha(
        commands,
        repository,
        defaultBranch
      ).catch((error: unknown) => {
        failures.push(`read ${defaultBranch} head: ${describeError(error)}`);
        return null;
      });
      if (head !== null && !sameSha(head, baselineSha))
        await attempt(`${defaultBranch} reset to ${baselineSha}`, async () => {
          expectSuccess(
            await commands.runGh([
              "api",
              "--method",
              "PATCH",
              `repos/${repository}/git/refs/heads/${defaultBranch}`,
              "-f",
              `sha=${baselineSha}`,
              "-F",
              "force=true"
            ]),
            `gh api PATCH refs/heads/${defaultBranch}`
          );
        });

      if (failures.length > 0)
        throw new Error(
          `Could not fully reclaim leaked product state for ${repository}:\n` +
            failures.map((failure) => `  - ${failure}`).join("\n") +
            (reclaimed.length > 0 ?
              `\nReclaimed before failing: ${reclaimed.join(", ")}.`
            : "")
        );
      return reclaimed;
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      const failures = await unwindAll(unwind);
      if (failures.length > 0)
        throw new Error(
          `Cloud fixture teardown for ${resourceGroup} did not complete:\n` +
            failures.map((failure) => `  - ${failure}`).join("\n")
        );
    }
  };

  return fixture;
}

async function unwindAll(steps: UnwindStep[]): Promise<string[]> {
  const failures: string[] = [];
  // Reverse order, and every step is attempted even after one fails: stopping
  // at the first failure is how a subscription accumulates orphaned clusters.
  for (let step = steps.pop(); step !== undefined; step = steps.pop()) {
    try {
      await step.run();
    } catch (error) {
      failures.push(`${step.describe}: ${describeError(error)}`);
    }
  }
  return failures;
}

interface LeakProbeInput {
  readonly commands: CloudCommandPort;
  readonly repository: string;
  readonly defaultBranch: string;
  readonly baselineSha: string;
  readonly environmentName: string;
  readonly expectedAppName: string;
  readonly scope: string;
}

async function collectLeakedState(input: LeakProbeInput): Promise<string[]> {
  const { commands, repository } = input;
  const findings: string[] = [];

  const apps = await listAppRegistrations(commands, input.expectedAppName);
  for (const app of apps)
    findings.push(
      `app registration "${app.displayName}" (appId ${app.appId}, object ${app.objectId})`
    );

  const principals = await listServicePrincipals(
    commands,
    input.expectedAppName
  );
  for (const principal of principals)
    findings.push(
      `service principal ${principal.objectId} for "${input.expectedAppName}"`
    );

  // Only reachable when an application survived, since a federated credential
  // cannot outlive the app it hangs off.
  for (const app of apps) {
    const credentials = await listFederatedCredentials(commands, app.objectId);
    for (const credential of credentials)
      findings.push(
        `federated credential "${credential.name}" (subject "${credential.subject}") on app ${app.appId}`
      );
  }

  // The resource group is created fresh moments earlier, but `az group create`
  // succeeds against an existing group, so this probe is what catches a run id
  // colliding with a group a crashed run left behind. Listing at the group
  // scope also returns assignments on the cluster inside it, which is the other
  // scope the product writes to.
  const assignments = await listRoleAssignments(commands, input.scope);
  for (const assignment of assignments)
    findings.push(
      `role assignment "${assignment.roleDefinitionName}" for principal ${assignment.principalId} at ${input.scope}`
    );

  const environment = await commands.runGh([
    "api",
    `repos/${repository}/environments/${input.environmentName}`
  ]);
  if (environment.code === 0)
    findings.push(
      `GitHub environment "${input.environmentName}" in ${repository}`
    );
  else if (!isNotFound(environment))
    throw new Error(
      `Could not probe GitHub environment "${input.environmentName}" in ${repository}: ` +
        `gh exited ${environment.code}: ${(environment.stderr || environment.stdout).trim()}`
    );

  const head = await readDefaultBranchSha(
    commands,
    repository,
    input.defaultBranch
  );
  if (!sameSha(head, input.baselineSha))
    findings.push(
      `${repository}@${input.defaultBranch} is at ${head}, not the pinned baseline ${input.baselineSha} ` +
        "(a previous run committed workflow files to the default branch)"
    );

  // The product only commits to the default branch when its token carries
  // `workflow` scope. Without it, it opens a pull request from a
  // `radius/setup-*` branch instead, which leaves the default branch pristine —
  // so the branch and pull request probes below are the only thing standing
  // between that path and a silently green clean slate.
  for (const branch of await listWorkflowFallbackBranches(commands, repository))
    findings.push(`workflow fallback branch "${branch}" in ${repository}`);

  for (const pull of await listOpenPullRequests(commands, repository))
    findings.push(
      `open pull request #${pull.number} ("${pull.title}", head "${pull.headRef}") in ${repository}`
    );

  return findings;
}

async function listAppRegistrations(
  commands: CloudCommandPort,
  displayName: string
): Promise<AppRegistrationRecord[]> {
  const context = `az ad app list --display-name ${displayName}`;
  const entries = parseJsonArray(
    await commands.runAz([
      "ad",
      "app",
      "list",
      "--display-name",
      displayName,
      "--query",
      "[].{appId:appId,id:id,displayName:displayName}",
      "-o",
      "json"
    ]),
    context
  );
  return entries.map((entry, index) => {
    const record = asRecord(entry, context, index);
    return {
      appId: requireString(record.appId, "appId", context, index),
      objectId: requireString(record.id, "id", context, index),
      displayName: requireString(
        record.displayName,
        "displayName",
        context,
        index
      )
    };
  });
}

async function listServicePrincipals(
  commands: CloudCommandPort,
  displayName: string
): Promise<Array<{ objectId: string }>> {
  const context = `az ad sp list --display-name ${displayName}`;
  const entries = parseJsonArray(
    await commands.runAz([
      "ad",
      "sp",
      "list",
      "--display-name",
      displayName,
      "--query",
      "[].{id:id}",
      "-o",
      "json"
    ]),
    context
  );
  return entries.map((entry, index) => ({
    objectId: requireString(
      asRecord(entry, context, index).id,
      "id",
      context,
      index
    )
  }));
}

async function listFederatedCredentials(
  commands: CloudCommandPort,
  appObjectId: string
): Promise<Array<{ name: string; subject: string }>> {
  const context = `az ad app federated-credential list --id ${appObjectId}`;
  const entries = parseJsonArray(
    await commands.runAz([
      "ad",
      "app",
      "federated-credential",
      "list",
      "--id",
      appObjectId,
      "--query",
      "[].{name:name,subject:subject}",
      "-o",
      "json"
    ]),
    context
  );
  return entries.map((entry, index) => {
    const record = asRecord(entry, context, index);
    return {
      name: requireString(record.name, "name", context, index),
      // A flexible federated credential legitimately reports no subject, so an
      // absent one is skipped rather than rejected.
      subject: typeof record.subject === "string" ? record.subject : ""
    };
  });
}

async function listRoleAssignments(
  commands: CloudCommandPort,
  scope: string
): Promise<Array<{ principalId: string; roleDefinitionName: string }>> {
  const context = `az role assignment list --scope ${scope}`;
  const entries = parseJsonArray(
    await commands.runAz([
      "role",
      "assignment",
      "list",
      "--scope",
      scope,
      "--query",
      "[].{principalId:principalId,roleDefinitionName:roleDefinitionName}",
      "-o",
      "json"
    ]),
    context
  );
  return entries.map((entry, index) => {
    const record = asRecord(entry, context, index);
    return {
      principalId: requireString(
        record.principalId,
        "principalId",
        context,
        index
      ),
      roleDefinitionName:
        typeof record.roleDefinitionName === "string" ?
          record.roleDefinitionName
        : "(unnamed role)"
    };
  });
}

async function listWorkflowFallbackBranches(
  commands: CloudCommandPort,
  repository: string
): Promise<string[]> {
  const context = `gh api matching-refs ${WORKFLOW_FALLBACK_BRANCH_PREFIX} in ${repository}`;
  // `matching-refs` answers 200 with an empty array when nothing matches, so
  // there is no not-found case to disambiguate here.
  const entries = parseJsonArray(
    await commands.runGh([
      "api",
      `repos/${repository}/git/matching-refs/heads/${WORKFLOW_FALLBACK_BRANCH_PREFIX}`
    ]),
    context
  );
  return entries.map((entry, index) =>
    requireString(
      asRecord(entry, context, index).ref,
      "ref",
      context,
      index
    ).replace(/^refs\/heads\//, "")
  );
}

async function listOpenPullRequests(
  commands: CloudCommandPort,
  repository: string
): Promise<Array<{ number: number; title: string; headRef: string }>> {
  const context = `gh api open pull requests in ${repository}`;
  const entries = parseJsonArray(
    await commands.runGh([
      "api",
      `repos/${repository}/pulls?state=open&per_page=100`
    ]),
    context
  );
  return entries.map((entry, index) => {
    const record = asRecord(entry, context, index);
    const head = asRecord(record.head ?? {}, context, index);
    return {
      number: typeof record.number === "number" ? record.number : index,
      title: typeof record.title === "string" ? record.title : "(untitled)",
      headRef: typeof head.ref === "string" ? head.ref : "(unknown)"
    };
  });
}

async function readDefaultBranchSha(
  commands: CloudCommandPort,
  repository: string,
  branch: string
): Promise<string> {
  const result = expectSuccess(
    await commands.runGh([
      "api",
      `repos/${repository}/commits/${branch}`,
      "--jq",
      ".sha"
    ]),
    `gh api commits/${branch} in ${repository}`
  );
  const sha = result.stdout.trim();
  if (!sha)
    throw new Error(
      `gh api commits/${branch} in ${repository} returned no commit SHA.`
    );
  return sha;
}

/**
 * Whether a `gh api` failure means the resource is absent.
 *
 * Anything else — an expired token, a rate limit, a network failure — must not
 * be read as absence, because "absent" is the answer that lets a run proceed.
 */
function isNotFound(result: CloudCommandResult): boolean {
  return /HTTP 404|Not Found/i.test(`${result.stderr}\n${result.stdout}`);
}

function sameSha(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function asRecord(
  value: unknown,
  context: string,
  index: number
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      `${context} returned a non-object entry at index ${index}; cannot read the result.`
    );
  return value as Record<string, unknown>;
}

function requireString(
  value: unknown,
  field: string,
  context: string,
  index: number
): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(
      `${context} returned an entry at index ${index} with no usable "${field}".`
    );
  return value;
}

function requireValue(value: string, message: string): string {
  if (!value || !value.trim()) throw new Error(message);
  return value;
}
