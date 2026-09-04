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
  readonly githubRunId?: string;
  readonly assertionTimeoutMs?: number;
  readonly assertionPollIntervalMs?: number;
}

const DEFAULT_LOCATION = "westus3";
const DEFAULT_NODE_COUNT = 1;
const CLUSTER_NODE_SIZE = "Standard_B2s";
const DEFAULT_ASSERTION_TIMEOUT_MS = 30_000;
const DEFAULT_ASSERTION_POLL_INTERVAL_MS = 1_000;
// The product derives several artifact names from the repository, not the run.
// Holding one external ref prevents separate invocations from sharing them.
const REPOSITORY_LEASE_REF = "refs/heads/radius/cloud-e2e-lease";

export function radiusPurgeCreationTime(value: Date): string {
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds))
    throw new Error("The cloud fixture creation time must be a valid date.");
  return String(Math.floor(milliseconds / 1_000));
}

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
  const tags = [
    `creationTime=${radiusPurgeCreationTime(ports.now())}`,
    "radius-canvas-e2e=true",
    ...(options.githubRunId ? [`github-run-id=${options.githubRunId}`] : [])
  ];
  const assertionTimeoutMs = requirePositiveNumber(
    options.assertionTimeoutMs ?? DEFAULT_ASSERTION_TIMEOUT_MS,
    "Assertion timeout"
  );
  const assertionPollIntervalMs = requirePositiveNumber(
    options.assertionPollIntervalMs ?? DEFAULT_ASSERTION_POLL_INTERVAL_MS,
    "Assertion poll interval"
  );

  const uniqueId = shortenUniqueId(ports.newUniqueId());
  const resourceGroup = resourceGroupName(uniqueId);
  const clusterName = buildClusterName(uniqueId);
  const environmentName = buildEnvironmentName(uniqueId);
  const scope = resourceGroupScope(subscriptionId, resourceGroup);
  const expectedAppName = appRegistrationName(repository);

  const unwind: UnwindStep[] = [];
  let workspacePath = "";

  try {
    expectSuccess(
      await commands.runGh([
        "api",
        "--method",
        "POST",
        `repos/${repository}/git/refs`,
        "-f",
        `ref=${REPOSITORY_LEASE_REF}`,
        "-f",
        `sha=${baselineSha}`
      ]),
      `gh api create ${REPOSITORY_LEASE_REF}`
    );
    unwind.push({
      describe: `release repository lease ${REPOSITORY_LEASE_REF}`,
      run: async () => {
        expectSuccess(
          await commands.runGh([
            "api",
            "--method",
            "DELETE",
            `repos/${repository}/git/${REPOSITORY_LEASE_REF}`
          ]),
          `gh api delete ${REPOSITORY_LEASE_REF}`
        );
      }
    });

    // The fixture tag proves the group is ours; github-run-id limits immediate
    // scheduled cleanup to CI-created groups. The creationTime/radtest pair
    // leaves Radius purge as the fallback safety net if this cleanup cannot run.
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
        ...tags,
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
    const cleanupFailures = await unwindAll(unwind);
    if (cleanupFailures.length > 0)
      throw new Error(
        `Cloud fixture construction failed: ${describeError(error)}\n` +
          "Cleanup after the construction failure also failed:\n" +
          cleanupFailures.map((failure) => `  - ${failure}`).join("\n"),
        { cause: error }
      );
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
      return pollForValue({
        ports,
        timeoutMs: assertionTimeoutMs,
        intervalMs: assertionPollIntervalMs,
        probe: async () => {
          const apps = await listAppRegistrations(commands, expectedAppName);
          if (apps.length > 1)
            throw new Error(
              `Expected exactly one app registration named "${expectedAppName}", but found ${apps.length} ` +
                `(${apps.map((app) => app.appId).join(", ")}). The product does not scope this name per run, ` +
                "so a concurrent run against the same fixture repository is the likely cause."
            );
          return apps[0];
        },
        timeoutMessage: () =>
          `Timed out after ${assertionTimeoutMs}ms waiting for the product to create an app registration named "${expectedAppName}".`
      });
    },

    async assertFederatedCredentialExists(subject) {
      const app = await fixture.assertAppRegistrationExists();
      let credentials: Array<{ name: string; subject: string }> = [];
      await pollForValue({
        ports,
        timeoutMs: assertionTimeoutMs,
        intervalMs: assertionPollIntervalMs,
        probe: async () => {
          credentials = await listFederatedCredentials(commands, app.objectId);
          return (
              credentials.some((credential) => credential.subject === subject)
            ) ?
              true
            : undefined;
        },
        timeoutMessage: () => {
          // Entra compares subjects case-sensitively, so a case-only difference
          // remains a real product defect when the bounded wait expires.
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
          return (
            `Timed out after ${assertionTimeoutMs}ms waiting for app registration ${app.appId} ` +
            `to carry a federated credential for subject "${subject}".${detail}`
          );
        }
      });
    },

    async assertRoleAssignmentExists(principalId) {
      let assignments: Array<{
        principalId: string;
        roleDefinitionName: string;
      }> = [];
      await pollForValue({
        ports,
        timeoutMs: assertionTimeoutMs,
        intervalMs: assertionPollIntervalMs,
        probe: async () => {
          assignments = await listRoleAssignments(commands, scope);
          return (
              assignments.some(
                (assignment) =>
                  assignment.principalId.toLowerCase() ===
                  principalId.toLowerCase()
              )
            ) ?
              true
            : undefined;
        },
        timeoutMessage: () =>
          `Timed out after ${assertionTimeoutMs}ms waiting for a role assignment for principal ` +
          `${principalId} at or below ${scope}; found ` +
          (assignments.length === 0 ?
            "no role assignments at all."
          : `only assignments for ${[
              ...new Set(
                assignments.map((assignment) => assignment.principalId)
              )
            ].join(", ")}.`)
      });
    },

    async assertGitHubEnvironmentExists() {
      await pollForValue({
        ports,
        timeoutMs: assertionTimeoutMs,
        intervalMs: assertionPollIntervalMs,
        probe: async () => {
          const probe = await commands.runGh([
            "api",
            `repos/${repository}/environments/${environmentName}`
          ]);
          if (probe.code === 0) return true;
          if (isNotFound(probe)) return undefined;
          throw new Error(
            `Could not determine whether GitHub Environment "${environmentName}" exists in ${repository}: ` +
              `gh exited ${probe.code}: ${(probe.stderr || probe.stdout).trim()}`
          );
        },
        timeoutMessage: () =>
          `Timed out after ${assertionTimeoutMs}ms waiting for the product to create ` +
          `GitHub Environment "${environmentName}" in ${repository}.`
      });
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

      // Delete service principals explicitly before applications. Application
      // deletion normally cascades, but an orphaned principal can survive after
      // its application is already gone and would otherwise wedge every later
      // clean-slate check.
      const principals = await listServicePrincipals(
        commands,
        expectedAppName
      ).catch((error: unknown) => {
        failures.push(`list service principals: ${describeError(error)}`);
        return [] as Array<{ objectId: string }>;
      });
      for (const principal of principals)
        await attempt(`service principal ${principal.objectId}`, async () => {
          expectSuccess(
            await commands.runAz([
              "ad",
              "sp",
              "delete",
              "--id",
              principal.objectId,
              "--output",
              "none"
            ]),
            `az ad sp delete ${principal.objectId}`
          );
        });

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

      // Close pull requests before removing their head branches so cleanup does
      // not rely on GitHub implicitly changing pull-request state.
      const pulls = await listOpenPullRequests(commands, repository).catch(
        (error: unknown) => {
          failures.push(`list open pull requests: ${describeError(error)}`);
          return [] as OpenPullRequest[];
        }
      );
      for (const pull of pulls.filter((candidate) =>
        candidate.headRef.startsWith(WORKFLOW_FALLBACK_BRANCH_PREFIX)
      ))
        await attempt(`pull request #${pull.number}`, async () => {
          expectSuccess(
            await commands.runGh([
              "api",
              "--method",
              "PATCH",
              `repos/${repository}/pulls/${pull.number}`,
              "-f",
              "state=closed"
            ]),
            `gh api PATCH pulls/${pull.number}`
          );
        });

      // A leaked `radius/setup-*` branch poisons the next run's clean slate the
      // same way a leaked Entra application does.
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

interface PollForValueOptions<T> {
  readonly ports: Pick<CloudFixturePorts, "now" | "wait">;
  readonly timeoutMs: number;
  readonly intervalMs: number;
  readonly probe: () => Promise<T | undefined>;
  readonly timeoutMessage: () => string;
}

async function pollForValue<T>(options: PollForValueOptions<T>): Promise<T> {
  const deadline = options.ports.now().getTime() + options.timeoutMs;
  while (true) {
    const value = await options.probe();
    if (value !== undefined) return value;
    const remaining = deadline - options.ports.now().getTime();
    if (remaining <= 0) throw new Error(options.timeoutMessage());
    await options.ports.wait(Math.min(options.intervalMs, remaining));
  }
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
  const context = `az ad app list --filter displayName eq '${displayName}'`;
  const entries = parseJsonArray(
    await commands.runAz([
      "ad",
      "app",
      "list",
      "--filter",
      `displayName eq '${displayName}'`,
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
  const context = `az ad sp list --filter displayName eq '${displayName}'`;
  const entries = parseJsonArray(
    await commands.runAz([
      "ad",
      "sp",
      "list",
      "--filter",
      `displayName eq '${displayName}'`,
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

interface OpenPullRequest {
  readonly number: number;
  readonly title: string;
  readonly headRef: string;
}

async function listOpenPullRequests(
  commands: CloudCommandPort,
  repository: string
): Promise<OpenPullRequest[]> {
  const context = `gh api open pull requests in ${repository}`;
  const result = await commands.runGh([
    "api",
    "--paginate",
    "--slurp",
    `repos/${repository}/pulls?state=open&per_page=100`
  ]);
  expectSuccess(result, context);
  if (!result.stdout.trim())
    throw new Error(`${context} returned an empty response instead of JSON.`);
  const pages = parseJsonArray(result, context);
  const entries = pages.flatMap((page, index) => {
    if (!Array.isArray(page))
      throw new Error(
        `${context} returned page ${index} with JSON type "${typeof page}" where an array was expected.`
      );
    return page;
  });
  return entries.map((entry, index) => {
    const record = asRecord(entry, context, index);
    const head = asRecord(record.head ?? {}, context, index);
    return {
      number: requirePositiveInteger(record.number, "number", context, index),
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

function requirePositiveInteger(
  value: unknown,
  field: string,
  context: string,
  index: number
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
    throw new Error(
      `${context} returned an entry at index ${index} with no usable "${field}".`
    );
  return value;
}

function requirePositiveNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${label} must be a positive finite number.`);
  return value;
}
