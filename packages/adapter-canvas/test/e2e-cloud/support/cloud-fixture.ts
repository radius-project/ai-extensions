// The cloud run's external world.
//
// The one rule that gives this layer its value: **the fixture never creates
// anything the product creates.** In CI it borrows a precreated AKS cluster;
// local runs may provision a disposable resource group and cluster. It always
// creates a clone of the fixture repository at the pinned baseline. It does not create the app registration,
// the service principal, the federated credential, the role assignments, the
// GitHub Environment, or any workflow file. If it did, asserting those exist
// would prove nothing, and later asserting they are gone would prove only that
// the fixture cleaned up after itself.
//
// `prepareCleanSlate()` is what enforces the rule at run time. It asserts every
// product-created artifact is absent before the journey starts, which turns the
// later assertions from observations into proofs and catches a previous run's
// leaked state before that state silently turns a red test green.
//
// Every external call goes through an injected port, so each branch below is
// provable without an Azure or GitHub credential.
import {
  DELETE_APP_DISPATCHER_FILE,
  stateRegistryForEnvironment
} from "@radius-project/core";
import {
  asRecord,
  CloudCommandError,
  describeError,
  expectSuccess,
  isGitHubApiNotFound,
  parseJsonArray,
  parseJsonObject,
  requireString,
  type CloudCommandPort,
  type CloudCommandResult,
  type CloudFixturePorts
} from "./cloud-command-port.js";
import {
  appRegistrationName,
  clusterName as buildClusterName,
  environmentName as buildEnvironmentName,
  FIXTURE_AWS_BASELINE_SHA,
  FIXTURE_BASELINE_SHA,
  FIXTURE_RADIUS_ENVIRONMENT_NAMESPACE,
  FIXTURE_REPO_DEFAULT_BRANCH,
  FIXTURE_REPOSITORY,
  resourceGroupName,
  resourceGroupScope,
  shortenUniqueId
} from "./fixture-repository.js";
import {
  acquireFixtureLease,
  attemptReclaim,
  cloneFixtureAtBaseline,
  collectGitHubLeakedState,
  fixtureLeaseOwner,
  moveDefaultBranchToBaseline,
  reclaimGitHubEnvironment,
  reclaimGitHubRunState,
  requireProbeEnvironmentAbsent,
  unwindAll,
  type GitHubFixtureRepository,
  type GitHubRunState,
  type ReclaimLedger,
  type UnwindStep
} from "./github-fixture.js";
import {
  radiusApplicationSelector,
  RADIUS_WORKLOAD_RESOURCES,
  RADIUS_RENDERED_RESOURCES,
  readKubernetesWorkloads,
  readKubernetesResourceNames,
  isKubernetesWorkloadReady,
  type KubernetesWorkload
} from "./deploy-journey.js";
import { DELETE_OPERATION_TIMEOUT_MS } from "./cloud-timeout-budget.js";
import {
  findNewWorkflowRunId,
  readWorkflowRunIds
} from "./workflow-run-discovery.js";

/** The Entra application the product creates, as the fixture observed it. */
export interface AppRegistrationRecord {
  /** The client id workflows authenticate with. */
  readonly appId: string;
  /** The directory object id `az ad app federated-credential` addresses. */
  readonly objectId: string;
  readonly displayName: string;
}

function isAzureResourceNotFound(result: CloudCommandResult): boolean {
  return /Request_ResourceNotFound|Directory_ObjectNotFound|Resource '.*' does not exist|does not exist or one of its queried reference-property objects are not present/i.test(
    result.stderr || result.stdout
  );
}

/**
 * Extracts a Microsoft Graph error's `error.code`, `az rest`'s only stable,
 * machine-readable signal for *why* a call failed. Graph wraps failures as
 * `ERROR: {"error":{"code":"...","message":"..."}}`; everything after the
 * last `}` (if anything) is discarded so trailing CLI diagnostics can't break
 * the parse. Returns `undefined` when no such envelope is present, which
 * callers must treat as "unclassifiable" rather than "not found".
 */
function parseGraphErrorCode(result: CloudCommandResult): string | undefined {
  for (const text of [result.stderr, result.stdout]) {
    if (!text) continue;
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) continue;
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1));
      const code =
        (
          parsed &&
          typeof parsed === "object" &&
          "error" in parsed &&
          parsed.error &&
          typeof parsed.error === "object" &&
          "code" in parsed.error
        ) ?
          (parsed.error as { code: unknown }).code
        : undefined;
      if (typeof code === "string") return code;
    } catch {
      // Not a JSON envelope; try the other stream before giving up.
    }
  }
  return undefined;
}

/**
 * Whether a failed `az rest` call against an exact Graph object URL proves
 * that object is gone.
 *
 * Message text such as "does not exist" is not proof: Microsoft documents
 * `error.code` as the stable contract and explicitly warns that message text
 * can change, and — worse — that same phrase appears in errors about a
 * *referenced* object, which is exactly the false "it's gone" this exact-object
 * GET exists to rule out. So this accepts only a recognized not-found
 * `error.code`, never prose. `az rest` doesn't surface the HTTP status
 * separately from the Graph body, so the parsed envelope is the only
 * structured signal available; a response with no parseable code is kept as
 * an explicit cleanup error rather than assumed to be a deletion proof.
 */
function isExactGraphObjectNotFound(result: CloudCommandResult): boolean {
  if (result.code === 0) return false;
  const code = parseGraphErrorCode(result);
  if (code !== undefined) return code === "Request_ResourceNotFound";
  // No JSON envelope: accept only a bare, exact error code, never a code or
  // phrase embedded in surrounding prose.
  return (result.stderr || result.stdout).trim() === "Request_ResourceNotFound";
}

export interface RoleAssignmentRecord {
  readonly id: string;
  readonly principalId: string;
  readonly roleDefinitionName: string;
  readonly scope: string;
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

  /**
   * Starts the run from a clean slate. Fails, changing nothing, when any
   * product-created artifact is already present or the default branch is not
   * at a pinned baseline. Only then moves the default branch to this run's
   * baseline.
   */
  prepareCleanSlate(): Promise<void>;
  assertAppRegistrationExists(): Promise<AppRegistrationRecord>;
  assertFederatedCredentialExists(subject: string): Promise<void>;
  assertRoleAssignmentExists(
    principalId: string
  ): Promise<readonly RoleAssignmentRecord[]>;
  assertRoleAssignmentsExist(
    expected: readonly RoleAssignmentRecord[]
  ): Promise<void>;
  assertGitHubEnvironmentExists(): Promise<void>;
  /**
   * Waits until the GitHub Environment is gone.
   *
   * The mirror of `assertGitHubEnvironmentExists`, and the pair is the point:
   * stage one proves the product creates the Environment, the final stage proves
   * it removes it. Absence on its own would prove nothing, so this refuses to
   * answer until presence was established first.
   */
  assertGitHubEnvironmentAbsent(): Promise<void>;
  /**
   * Waits until no app registration with the product's name remains.
   *
   * Product environment deletion intentionally retains the repository-scoped
   * app registration because other environments or callers can share it. This
   * guarded mirror is therefore a fixture-cleanup assertion, not proof of the
   * product's environment-deletion contract.
   */
  assertAppRegistrationAbsent(): Promise<void>;
  /**
   * Waits until the app registration carries no credential for the subject.
   *
   * Unlike app-registration and role-assignment absence, this mirror validates
   * product deletion of the environment-specific credential. When the parent
   * registration is expected to survive, its exact object id remains required
   * throughout the wait so a transient missing read cannot prove absence.
   */
  assertFederatedCredentialAbsent(
    subject: string,
    expectedAppRegistration?: AppRegistrationRecord
  ): Promise<void>;
  /**
   * Waits until no role assignment for the principal remains in scope.
   *
   * Product environment deletion intentionally retains this shared assignment,
   * so this guarded mirror is used only to verify fixture cleanup.
   */
  assertRoleAssignmentAbsent(principalId: string): Promise<void>;
  /** Waits until Radius has rendered a ready workload on the target cluster. */
  assertApplicationWorkloadsPresent(
    application: string,
    namespace: string
  ): Promise<readonly KubernetesWorkload[]>;
  /** Waits until no workload for the application remains on the target cluster. */
  assertApplicationWorkloadsAbsent(
    application: string,
    namespace: string
  ): Promise<void>;
  /** Reads application workloads once without polling. */
  readApplicationWorkloads(
    application: string,
    namespace: string
  ): Promise<readonly KubernetesWorkload[]>;
  /** Reports whether the application namespace exists on the target cluster. */
  namespaceExists(namespace: string): Promise<boolean>;
  /** Registers the exact application target that fixture reclamation may remove. */
  registerApplicationCleanupTarget(
    application: string,
    namespace: string
  ): void;
  /** Registers a fixture-owned namespace that reclamation may remove. */
  registerNamespaceCleanupTarget(namespace: string): void;
  /** Registers only an environment verified absent before a refusal probe submits. */
  registerProbeEnvironmentCleanupTarget(name: string): Promise<void>;
  /** Records that the journey verified Radius removed the application. */
  recordApplicationDeletionSucceeded(
    application: string,
    namespace: string
  ): void;
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
  /**
   * Other clouds' baselines the default branch may be at when the run starts.
   * Defaults to the pinned AWS baseline.
   */
  readonly otherBaselineShas?: readonly string[];
  /** Existing CI resource group. Must be supplied with `clusterName`. */
  readonly resourceGroup?: string;
  /** Existing CI AKS cluster. Must be supplied with `resourceGroup`. */
  readonly clusterName?: string;
  /** Node count for the discovery-target cluster. One is enough. */
  readonly nodeCount?: number;
  readonly githubRunId?: string;
  readonly assertionTimeoutMs?: number;
  readonly assertionPollIntervalMs?: number;
  readonly entraAppDeletionTimeoutMs?: number;
}

const DEFAULT_LOCATION = "westus3";
const DEFAULT_NODE_COUNT = 1;
const CLUSTER_NODE_SIZE = "Standard_B2s";
const DEFAULT_ASSERTION_TIMEOUT_MS = 30_000;
const DEFAULT_ASSERTION_POLL_INTERVAL_MS = 1_000;
const DEFAULT_ENTRA_APP_DELETION_TIMEOUT_MS = 120_000;
const FIXTURE_NAMESPACE_DELETION_TIMEOUT_MS = 5 * 60_000;

export function radiusPurgeCreationTime(value: Date): string {
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds))
    throw new Error("The cloud fixture creation time must be a valid date.");
  return String(Math.floor(milliseconds / 1_000));
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
  let location = options.location ?? DEFAULT_LOCATION;
  const repository = options.repository ?? FIXTURE_REPOSITORY;
  const defaultBranch = options.defaultBranch ?? FIXTURE_REPO_DEFAULT_BRANCH;
  const baselineSha = options.baselineSha ?? FIXTURE_BASELINE_SHA;
  const nodeCount = options.nodeCount ?? DEFAULT_NODE_COUNT;
  const leaseOwner = fixtureLeaseOwner(options.githubRunId);
  const githubRunId = leaseOwner?.runId;
  const tags = [
    `creationTime=${radiusPurgeCreationTime(ports.now())}`,
    "radius-canvas-e2e=true",
    ...(githubRunId ? [`github-run-id=${githubRunId}`] : [])
  ];
  const assertionTimeoutMs = requirePositiveNumber(
    options.assertionTimeoutMs ?? DEFAULT_ASSERTION_TIMEOUT_MS,
    "Assertion timeout"
  );
  const assertionPollIntervalMs = requirePositiveNumber(
    options.assertionPollIntervalMs ?? DEFAULT_ASSERTION_POLL_INTERVAL_MS,
    "Assertion poll interval"
  );
  const entraAppDeletionTimeoutMs = requirePositiveNumber(
    options.entraAppDeletionTimeoutMs ?? DEFAULT_ENTRA_APP_DELETION_TIMEOUT_MS,
    "Entra app deletion timeout"
  );
  const uniqueId = shortenUniqueId(ports.newUniqueId());
  const configuredResourceGroup = options.resourceGroup?.trim() || undefined;
  const configuredClusterName = options.clusterName?.trim() || undefined;
  if (
    (configuredResourceGroup === undefined) !==
    (configuredClusterName === undefined)
  )
    throw new Error(
      "An existing cloud fixture resource group and AKS cluster name must be supplied together."
    );
  const ownsInfrastructure = configuredResourceGroup === undefined;
  const resourceGroup = configuredResourceGroup ?? resourceGroupName(uniqueId);
  const clusterName = configuredClusterName ?? buildClusterName(uniqueId);
  const environmentName = buildEnvironmentName(uniqueId);
  const scope = resourceGroupScope(subscriptionId, resourceGroup);
  const clusterScope = `${scope}/providers/Microsoft.ContainerService/managedClusters/${clusterName}`;
  const roleAssignmentScopes = [scope, clusterScope] as const;
  const requiredRoleAssignments = [
    { scope, roleDefinitionName: "Contributor" },
    { scope, roleDefinitionName: "Locks Contributor" },
    {
      scope: clusterScope,
      roleDefinitionName: "Azure Kubernetes Service RBAC Cluster Admin"
    }
  ] as const;
  const expectedAppName = appRegistrationName(repository);
  const statePackage = stateRegistryForEnvironment(repository, environmentName);
  const githubFixture: GitHubFixtureRepository = {
    commands,
    repository,
    defaultBranch,
    baselineSha,
    otherBaselineShas: options.otherBaselineShas ?? [FIXTURE_AWS_BASELINE_SHA]
  };
  const githubRunState: GitHubRunState = { environmentName, statePackage };

  const unwind: UnwindStep[] = [];
  const probeEnvironmentCleanupTargets = new Set<string>();
  let workspacePath: string;

  try {
    await acquireFixtureLease(githubFixture, leaseOwner, unwind);

    if (ownsInfrastructure) {
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

      // Purely a discovery target: the product runs `az aks list` and must find
      // a real cluster. Deleting the group removes it, so it needs no unwind step.
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
    } else {
      const context = `az aks show ${clusterName}`;
      const cluster = parseJsonObject(
        expectSuccess(
          await commands.runAz([
            "aks",
            "show",
            "--resource-group",
            resourceGroup,
            "--name",
            clusterName,
            "--subscription",
            subscriptionId,
            "--query",
            "{location:location,provisioningState:provisioningState,powerState:powerState.code}",
            "--output",
            "json"
          ]),
          context
        ),
        context
      );
      const actualLocation =
        typeof cluster.location === "string" ?
          cluster.location.trim().toLowerCase()
        : "";
      const provisioningState =
        typeof cluster.provisioningState === "string" ?
          cluster.provisioningState.trim()
        : "";
      const powerState =
        typeof cluster.powerState === "string" ? cluster.powerState.trim() : "";
      if (!actualLocation)
        throw new Error(
          `The precreated AKS cluster ${resourceGroup}/${clusterName} did not report a location.`
        );
      if (provisioningState !== "Succeeded")
        throw new Error(
          `The precreated AKS cluster ${resourceGroup}/${clusterName} is not ready: ` +
            `provisioning state is "${provisioningState || "(missing)"}", expected "Succeeded".`
        );
      if (powerState !== "Running")
        throw new Error(
          `The precreated AKS cluster ${resourceGroup}/${clusterName} is not runnable: ` +
            `power state is "${powerState || "(missing)"}", expected "Running".`
        );
      if (options.location !== undefined && actualLocation !== location)
        throw new Error(
          `The precreated AKS cluster ${resourceGroup}/${clusterName} is in "${actualLocation}", ` +
            `but AIEXT_CLOUD_E2E_AZURE_LOCATION is "${location}".`
        );
      location = actualLocation;
    }

    workspacePath = await cloneFixtureAtBaseline(
      ports,
      githubFixture,
      `radtest-canvas-${uniqueId}`,
      unwind
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
  let kubeconfigPath = "";

  const clusterKubeconfig = async (timeoutMs?: number): Promise<string> => {
    if (kubeconfigPath) return kubeconfigPath;
    const directory = await ports.makeWorkspaceDir(
      `radtest-canvas-kube-${uniqueId}`
    );
    unwind.push({
      describe: `remove kubeconfig directory ${directory}`,
      run: () => ports.removeDir(directory)
    });
    const candidate = `${directory}/kubeconfig`;
    expectSuccess(
      await commands.runAz(
        [
          "aks",
          "get-credentials",
          "--resource-group",
          resourceGroup,
          "--name",
          clusterName,
          "--subscription",
          subscriptionId,
          "--file",
          candidate,
          "--overwrite-existing",
          "--only-show-errors"
        ],
        timeoutMs
      ),
      `az aks get-credentials ${clusterName}`
    );
    kubeconfigPath = candidate;
    return kubeconfigPath;
  };

  const listWorkloads = async (
    application: string,
    namespace: string,
    timeoutMs?: number
  ): Promise<readonly KubernetesWorkload[] | "no-namespace"> => {
    const context = `kubectl get ${RADIUS_WORKLOAD_RESOURCES} -n ${namespace}`;
    const deadline =
      timeoutMs === undefined ? undefined : ports.now().getTime() + timeoutMs;
    const kubeconfig = await clusterKubeconfig(timeoutMs);
    const commandTimeoutMs =
      deadline === undefined ? undefined : (
        remainingCommandTimeout(deadline, ports.now, context)
      );
    const result = await commands.runKubectl(
      [
        "--kubeconfig",
        kubeconfig,
        "get",
        RADIUS_WORKLOAD_RESOURCES,
        "--namespace",
        namespace,
        "--selector",
        radiusApplicationSelector(application),
        "--output",
        "json"
      ],
      commandTimeoutMs
    );
    if (result.code !== 0) {
      if (isMissingNamespace(result)) return "no-namespace";
      throw new CloudCommandError(context, result);
    }
    return readKubernetesWorkloads(parseJsonObject(result, context));
  };

  const listApplicationResources = async (
    application: string,
    namespace: string,
    timeoutMs: number
  ): Promise<readonly string[] | "no-namespace"> => {
    const context = `kubectl get ${RADIUS_RENDERED_RESOURCES} -n ${namespace}`;
    const deadline = ports.now().getTime() + timeoutMs;
    const kubeconfig = await clusterKubeconfig(timeoutMs);
    const commandTimeoutMs = remainingCommandTimeout(
      deadline,
      ports.now,
      context
    );
    const result = await commands.runKubectl(
      [
        "--kubeconfig",
        kubeconfig,
        "get",
        RADIUS_RENDERED_RESOURCES,
        "--namespace",
        namespace,
        "--selector",
        radiusApplicationSelector(application),
        "--output",
        "json"
      ],
      commandTimeoutMs
    );
    if (result.code !== 0) {
      if (isMissingNamespace(result)) return "no-namespace";
      throw new CloudCommandError(context, result);
    }
    return readKubernetesResourceNames(parseJsonObject(result, context));
  };

  const listDeleteWorkflowRunIds = async (): Promise<ReadonlySet<string>> =>
    readWorkflowRunIds(
      parseJsonArray(
        await commands.runGh([
          "run",
          "list",
          "--repo",
          repository,
          "--workflow",
          DELETE_APP_DISPATCHER_FILE,
          "--event",
          "workflow_dispatch",
          "--limit",
          "100",
          "--json",
          "databaseId"
        ]),
        `gh run list ${DELETE_APP_DISPATCHER_FILE}`
      )
    );

  const deleteApplicationResources = async (
    application: string
  ): Promise<void> => {
    const before = await listDeleteWorkflowRunIds();
    expectSuccess(
      await commands.runGh([
        "workflow",
        "run",
        DELETE_APP_DISPATCHER_FILE,
        "--repo",
        repository,
        "--ref",
        defaultBranch,
        "-f",
        `environment=${environmentName}`,
        "-f",
        `application=${application}`
      ]),
      `gh workflow run ${DELETE_APP_DISPATCHER_FILE}`
    );
    const runId = await pollForValue({
      ports,
      timeoutMs: DELETE_OPERATION_TIMEOUT_MS,
      intervalMs: assertionPollIntervalMs,
      probe: async () =>
        findNewWorkflowRunId(before, await listDeleteWorkflowRunIds()),
      timeoutMessage: () =>
        `Timed out after ${DELETE_OPERATION_TIMEOUT_MS}ms waiting to identify the cleanup workflow run for ` +
        `application "${application}" in environment "${environmentName}".`
    });
    let conclusion = "";
    await pollForValue({
      ports,
      timeoutMs: DELETE_OPERATION_TIMEOUT_MS,
      intervalMs: assertionPollIntervalMs,
      probe: async () => {
        const context = `gh run view ${runId}`;
        const result = parseJsonObject(
          await commands.runGh([
            "run",
            "view",
            runId,
            "--repo",
            repository,
            "--json",
            "status,conclusion"
          ]),
          context
        );
        const status =
          typeof result.status === "string" ? result.status.trim() : "";
        conclusion =
          typeof result.conclusion === "string" ? result.conclusion.trim() : "";
        if (!status)
          throw new Error(`${context} returned no usable workflow status.`);
        if (status !== "completed") return undefined;
        if (conclusion !== "success")
          throw new Error(
            `${context} completed with conclusion "${conclusion || "(missing)"}".`
          );
        return true;
      },
      timeoutMessage: () =>
        `Timed out after ${DELETE_OPERATION_TIMEOUT_MS}ms waiting for cleanup workflow run ${runId} to complete; ` +
        `last conclusion was "${conclusion || "(not completed)"}".`
    });
  };

  /**
   * Artifacts this run has independently observed in place.
   *
   * An absence assertion is vacuous unless presence came first. A helper that
   * merely fails to find something cannot tell "the product deleted it" from
   * "the product never created it", and read the second way a broken create
   * silently becomes a passing delete. The mirrors below refuse to answer at
   * all until this run has seen the artifact for itself.
   */
  const observedPresent = new Set<string>();
  const observedCredentialApps = new Map<string, AppRegistrationRecord>();
  const applicationCleanupTargets = new Map<
    string,
    { application: string; namespace: string; deletionVerified: boolean }
  >();
  const namespaceCleanupTargets = new Set<string>();
  const APP_REGISTRATION_KEY = "app-registration";
  const GITHUB_ENVIRONMENT_KEY = "github-environment";
  const roleAssignmentKey = (principalId: string) =>
    `role-assignment:${principalId.toLowerCase()}`;

  const requireObservedPresent = (key: string, description: string): void => {
    if (observedPresent.has(key)) return;
    throw new Error(
      `Refusing to assert that ${description} is absent: this run never observed it present, so its absence ` +
        "would prove nothing about the operation under test — a product that never created it would pass " +
        "just as readily as one that correctly deleted it. Assert presence first."
    );
  };

  const requireObservedCredentialApp = (
    subject: string
  ): AppRegistrationRecord => {
    const app = observedCredentialApps.get(subject);
    if (app) return app;
    throw new Error(
      `Refusing to assert that the federated credential for subject "${subject}" is absent: this run never ` +
        "observed it present, so its absence would prove nothing about the operation under test — a product " +
        "that never created it would pass just as readily as one that correctly deleted it. Assert presence first."
    );
  };

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

    async prepareCleanSlate() {
      const findings = [
        ...(await collectAzureLeakedState({
          commands,
          expectedAppName,
          roleAssignmentScopes:
            ownsInfrastructure ? roleAssignmentScopes : undefined
        })),
        ...(await collectGitHubLeakedState(githubFixture, githubRunState))
      ];
      if (findings.length > 0)
        throw new Error(
          "Leaked state from a previous run, not a product regression: " +
            `the create-environment journey for ${repository} must start with none of the ` +
            "artifacts the product is responsible for creating, but found:\n" +
            findings.map((finding) => `  - ${finding}`).join("\n") +
            "\nReclaim it before re-running; see the cloud E2E runbook."
        );
      await moveDefaultBranchToBaseline(githubFixture);
    },

    async assertAppRegistrationExists() {
      const app = await pollForValue({
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
      observedPresent.add(APP_REGISTRATION_KEY);
      return app;
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
      observedCredentialApps.set(subject, app);
    },

    async assertRoleAssignmentExists(principalId) {
      let assignments: RoleAssignmentRecord[] = [];
      let missingRequirements = [...requiredRoleAssignments];
      const observed = await pollForValue({
        ports,
        timeoutMs: assertionTimeoutMs,
        intervalMs: assertionPollIntervalMs,
        probe: async (remainingMs) => {
          assignments = await listRoleAssignmentsAtScopes(
            commands,
            roleAssignmentScopes,
            remainingMs,
            ports.now
          );
          const matching = assignments.filter(
            (assignment) =>
              assignment.principalId.toLowerCase() === principalId.toLowerCase()
          );
          missingRequirements = requiredRoleAssignments.filter(
            (expected) =>
              !matching.some(
                (assignment) =>
                  assignment.scope.toLowerCase() ===
                    expected.scope.toLowerCase() &&
                  assignment.roleDefinitionName.toLowerCase() ===
                    expected.roleDefinitionName.toLowerCase()
              )
          );
          return missingRequirements.length === 0 ? matching : undefined;
        },
        timeoutMessage: () =>
          `Timed out after ${assertionTimeoutMs}ms waiting for role assignments for principal ` +
          `${principalId}; missing ${missingRequirements
            .map(
              (expected) =>
                `"${expected.roleDefinitionName}" at ${expected.scope}`
            )
            .join(", ")}; found ` +
          (assignments.length === 0 ?
            "no role assignments at all."
          : `only assignments for ${[
              ...new Set(
                assignments.map((assignment) => assignment.principalId)
              )
            ].join(", ")}.`)
      });
      observedPresent.add(roleAssignmentKey(principalId));
      return observed;
    },

    async assertRoleAssignmentsExist(expected) {
      if (expected.length === 0)
        throw new Error(
          "Refusing to assert an empty role-assignment inventory."
        );
      let missing = [...expected];
      let observedInventory = false;
      await pollForValue({
        ports,
        timeoutMs: assertionTimeoutMs,
        intervalMs: assertionPollIntervalMs,
        probe: async (remainingMs) => {
          const current = await listRoleAssignmentsAtScopes(
            commands,
            [...new Set(expected.map((assignment) => assignment.scope))],
            remainingMs,
            ports.now
          );
          observedInventory = true;
          missing = expected.filter(
            (wanted) =>
              !current.some(
                (actual) =>
                  actual.id.toLowerCase() === wanted.id.toLowerCase() &&
                  actual.principalId.toLowerCase() ===
                    wanted.principalId.toLowerCase() &&
                  actual.roleDefinitionName === wanted.roleDefinitionName &&
                  actual.scope.toLowerCase() === wanted.scope.toLowerCase()
              )
          );
          return missing.length === 0 ? true : undefined;
        },
        timeoutMessage: () =>
          `Timed out after ${assertionTimeoutMs}ms waiting for the exact role assignments observed during creation to survive; ` +
          (observedInventory ?
            `missing ${missing.map((assignment) => assignment.id).join(", ")} in the last completed scope inventory.`
          : `no complete scope inventory was returned; unconfirmed ${missing.map((assignment) => assignment.id).join(", ")}.`)
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
          if (isGitHubApiNotFound(probe)) return undefined;
          throw new Error(
            `Could not determine whether GitHub Environment "${environmentName}" exists in ${repository}: ` +
              `gh exited ${probe.code}: ${(probe.stderr || probe.stdout).trim()}`
          );
        },
        timeoutMessage: () =>
          `Timed out after ${assertionTimeoutMs}ms waiting for the product to create ` +
          `GitHub Environment "${environmentName}" in ${repository}.`
      });
      observedPresent.add(GITHUB_ENVIRONMENT_KEY);
    },

    async assertGitHubEnvironmentAbsent() {
      requireObservedPresent(
        GITHUB_ENVIRONMENT_KEY,
        `GitHub Environment "${environmentName}" in ${repository}`
      );
      await pollForValue({
        ports,
        timeoutMs: assertionTimeoutMs,
        intervalMs: assertionPollIntervalMs,
        probe: async () => {
          const probe = await commands.runGh([
            "api",
            `repos/${repository}/environments/${environmentName}`
          ]);
          if (isGitHubApiNotFound(probe)) return true;
          if (probe.code === 0) return undefined;
          throw new Error(
            `Could not determine whether GitHub Environment "${environmentName}" still exists in ${repository}: ` +
              `gh exited ${probe.code}: ${(probe.stderr || probe.stdout).trim()}`
          );
        },
        timeoutMessage: () =>
          `Timed out after ${assertionTimeoutMs}ms waiting for the product to delete ` +
          `GitHub Environment "${environmentName}" from ${repository}; it still exists.`
      });
    },

    async assertAppRegistrationAbsent() {
      requireObservedPresent(
        APP_REGISTRATION_KEY,
        `app registration "${expectedAppName}"`
      );
      let found: AppRegistrationRecord[] = [];
      await pollForValue({
        ports,
        timeoutMs: entraAppDeletionTimeoutMs,
        intervalMs: assertionPollIntervalMs,
        probe: async () => {
          found = [...(await listAppRegistrations(commands, expectedAppName))];
          return found.length === 0 ? true : undefined;
        },
        timeoutMessage: () =>
          `Timed out after ${entraAppDeletionTimeoutMs}ms waiting for app registration "${expectedAppName}" to be ` +
          `deleted; ${found.length} still exist(s) (${found
            .map((app) => app.appId)
            .join(", ")}).`
      });
    },

    async assertFederatedCredentialAbsent(subject, expectedAppRegistration) {
      const observedApp = requireObservedCredentialApp(subject);
      if (
        expectedAppRegistration &&
        (expectedAppRegistration.appId !== observedApp.appId ||
          expectedAppRegistration.objectId !== observedApp.objectId)
      )
        throw new Error(
          `Refusing to check federated credential subject "${subject}" on retained app ` +
            `${expectedAppRegistration.appId} (${expectedAppRegistration.objectId}): this run observed it on ` +
            `${observedApp.appId} (${observedApp.objectId}).`
        );
      const requiredApp = expectedAppRegistration ?? observedApp;
      let app: AppRegistrationRecord | undefined;
      let remaining: Array<{ name: string; subject: string }> = [];
      await pollForValue({
        ports,
        timeoutMs: assertionTimeoutMs,
        intervalMs: assertionPollIntervalMs,
        probe: async () => {
          if (expectedAppRegistration) {
            const apps = await listAppRegistrations(commands, expectedAppName);
            app = apps.find(
              (candidate) => candidate.objectId === requiredApp.objectId
            );
            // The environment journey requires its retained parent to remain
            // observable while proving the child credential was deleted.
            if (!app) return undefined;
          } else {
            app = requiredApp;
          }
          remaining = await listFederatedCredentials(commands, app.objectId);
          return (
              remaining.some((credential) => credential.subject === subject)
            ) ?
              undefined
            : true;
        },
        timeoutMessage: () => {
          if (expectedAppRegistration && !app)
            return (
              `Timed out after ${assertionTimeoutMs}ms waiting for retained app registration ` +
              `${expectedAppRegistration.appId} (${expectedAppRegistration.objectId}) to remain observable ` +
              `while checking federated credential subject "${subject}".`
            );
          return (
            `Timed out after ${assertionTimeoutMs}ms waiting for app registration ` +
            `${requiredApp.appId} to drop its ` +
            `federated credential for subject "${subject}"; it still carries ${remaining.length} credential(s).`
          );
        }
      });
    },

    async assertRoleAssignmentAbsent(principalId) {
      requireObservedPresent(
        roleAssignmentKey(principalId),
        `the role assignment inventory for principal ${principalId} at the resource-group and AKS scopes`
      );
      let remaining: RoleAssignment[] = [];
      await pollForValue({
        ports,
        timeoutMs: assertionTimeoutMs,
        intervalMs: assertionPollIntervalMs,
        probe: async () => {
          remaining = (
            await listRoleAssignments(commands, roleAssignmentScopes)
          ).filter(
            (assignment) =>
              assignment.principalId.toLowerCase() === principalId.toLowerCase()
          );
          return remaining.length === 0 ? true : undefined;
        },
        timeoutMessage: () =>
          `Timed out after ${assertionTimeoutMs}ms waiting for the role assignment(s) for principal ` +
          `${principalId} at the resource-group and AKS scopes to be removed; ${remaining.length} remain(s).`
      });
    },

    async namespaceExists(namespace) {
      const kubeconfig = await clusterKubeconfig();
      const context = `kubectl get namespace ${namespace}`;
      const result = await commands.runKubectl([
        "--kubeconfig",
        kubeconfig,
        "get",
        "namespace",
        namespace,
        "--output",
        "name"
      ]);
      if (result.code === 0) return true;
      if (isMissingNamespace(result)) return false;
      throw new CloudCommandError(context, result);
    },

    registerApplicationCleanupTarget(application, namespace) {
      const requiredApplication = requireValue(
        application,
        "An application name is required to register Kubernetes cleanup."
      );
      const requiredNamespace = requireValue(
        namespace,
        "A namespace is required to register Kubernetes cleanup."
      );
      applicationCleanupTargets.set(
        `${requiredNamespace}\n${requiredApplication}`,
        {
          application: requiredApplication,
          namespace: requiredNamespace,
          deletionVerified:
            applicationCleanupTargets.get(
              `${requiredNamespace}\n${requiredApplication}`
            )?.deletionVerified ?? false
        }
      );
    },

    registerNamespaceCleanupTarget(namespace) {
      const target = requireValue(
        namespace,
        "A namespace is required to register namespace cleanup."
      );
      if (target !== FIXTURE_RADIUS_ENVIRONMENT_NAMESPACE)
        throw new Error(
          `Namespace cleanup is restricted to the fixture-owned namespace ${FIXTURE_RADIUS_ENVIRONMENT_NAMESPACE}.`
        );
      namespaceCleanupTargets.add(target);
    },

    recordApplicationDeletionSucceeded(application, namespace) {
      fixture.registerApplicationCleanupTarget(application, namespace);
      const target = applicationCleanupTargets.get(
        `${namespace}\n${application}`
      );
      if (!target)
        throw new Error("The application cleanup target was not registered.");
      target.deletionVerified = true;
    },

    async readApplicationWorkloads(application, namespace) {
      const workloads = await listWorkloads(application, namespace);
      return workloads === "no-namespace" ? [] : workloads;
    },

    async assertApplicationWorkloadsPresent(application, namespace) {
      fixture.registerApplicationCleanupTarget(application, namespace);
      let lastSeen: readonly KubernetesWorkload[] | "no-namespace" = [];
      return pollForValue({
        ports,
        timeoutMs: assertionTimeoutMs,
        intervalMs: assertionPollIntervalMs,
        probe: async (remainingMs) => {
          lastSeen = await listWorkloads(application, namespace, remainingMs);
          if (lastSeen === "no-namespace" || lastSeen.length === 0)
            return undefined;
          if (lastSeen.some((workload) => !isKubernetesWorkloadReady(workload)))
            return undefined;
          return lastSeen;
        },
        timeoutMessage: () =>
          `Timed out after ${assertionTimeoutMs}ms waiting for Radius to render application "${application}" ` +
          `into namespace "${namespace}" on cluster ${clusterName}. ` +
          (lastSeen === "no-namespace" ?
            "The namespace does not exist, so the deploy never reached this cluster."
          : lastSeen.length === 0 ?
            "The namespace exists but carries no workload labelled for the application."
          : `The application workloads exist but are not ready: ${lastSeen
              .filter((workload) => !isKubernetesWorkloadReady(workload))
              .map(
                (workload) =>
                  `"${workload.name}" has ${workload.availableReplicas} available replica(s) of ${workload.desiredReplicas} desired`
              )
              .join(", ")}.`)
      });
    },

    async assertApplicationWorkloadsAbsent(application, namespace) {
      let lastSeen: readonly string[] = [];
      await pollForValue({
        ports,
        timeoutMs: assertionTimeoutMs,
        intervalMs: assertionPollIntervalMs,
        probe: async (remainingMs) => {
          const resources = await listApplicationResources(
            application,
            namespace,
            remainingMs
          );
          if (resources === "no-namespace") return true;
          lastSeen = resources;
          return resources.length === 0 ? true : undefined;
        },
        timeoutMessage: () =>
          `Timed out after ${assertionTimeoutMs}ms waiting for the delete to remove application ` +
          `"${application}" from namespace "${namespace}" on cluster ${clusterName}; ` +
          `${lastSeen.length} workload resource(s) remain: ${lastSeen
            .map((resource) => `"${resource}"`)
            .join(", ")}.`
      });
    },

    async registerProbeEnvironmentCleanupTarget(name) {
      await requireProbeEnvironmentAbsent(githubFixture, githubRunState, name);
      probeEnvironmentCleanupTargets.add(name);
    },

    async reclaimLeakedProductArtifacts() {
      const ledger: ReclaimLedger = { reclaimed: [], failures: [] };
      const { reclaimed, failures } = ledger;
      const attempt = (label: string, run: () => Promise<void>) =>
        attemptReclaim(ledger, label, run);

      for (const name of probeEnvironmentCleanupTargets)
        await reclaimGitHubEnvironment(
          ledger,
          githubFixture,
          name,
          `probe GitHub environment ${name}`
        );

      const applicationFailureStart = failures.length;
      for (const target of applicationCleanupTargets.values()) {
        if (target.deletionVerified) continue;
        await attempt(
          `Radius application ${target.application} in ${environmentName}`,
          () => deleteApplicationResources(target.application)
        );
      }
      const applicationDeletionFailed =
        failures.length > applicationFailureStart;

      for (const target of applicationCleanupTargets.values())
        await attempt(
          `Kubernetes workloads for ${target.application} in ${target.namespace}`,
          async () => {
            const kubeconfig = await clusterKubeconfig(assertionTimeoutMs);
            const result = await commands.runKubectl(
              [
                "--kubeconfig",
                kubeconfig,
                "delete",
                RADIUS_WORKLOAD_RESOURCES,
                "--namespace",
                target.namespace,
                "--selector",
                radiusApplicationSelector(target.application),
                "--ignore-not-found=true",
                "--wait=true"
              ],
              assertionTimeoutMs
            );
            if (isMissingNamespace(result)) return;
            // `kubectl delete --wait=true` prints its "deleted" lines and then
            // blocks until every object is finalized, so a delete that removed
            // everything can still be killed by this step's own budget.
            // Deciding on the exit code alone failed a whole run for a reclaim
            // that had in fact succeeded. Kubernetes also keeps finalizing
            // after the client exits, so a single re-list can still see
            // terminating objects; poll for their absence the same way the
            // delete assertion does and report the delete only if something
            // outlives the deadline.
            const failure =
              result.code === 0 ?
                undefined
              : new CloudCommandError(
                  `kubectl delete ${RADIUS_WORKLOAD_RESOURCES} -n ${target.namespace}`,
                  result
                );
            let lastSeen: readonly string[] = [];
            await pollForValue({
              ports,
              timeoutMs: assertionTimeoutMs,
              intervalMs: assertionPollIntervalMs,
              probe: async (remainingMs) => {
                let survivors: readonly string[] | "no-namespace";
                try {
                  survivors = await listApplicationResources(
                    target.application,
                    target.namespace,
                    remainingMs
                  );
                } catch (listFailure) {
                  // A listing killed by the poll's own budget is left for
                  // `pollForValue` to translate, because the timeout message
                  // below already carries the delete failure. Anything else is
                  // a second diagnostic, and both are worth keeping: the
                  // delete said why it failed, and the listing says why that
                  // could not be checked.
                  if (
                    listFailure instanceof CloudCommandError &&
                    listFailure.timedOut
                  )
                    throw listFailure;
                  throw new Error(
                    `${failure ? `${failure.message}\n  The follow-up listing also failed` : "The follow-up listing failed"}: ${describeError(listFailure)}`,
                    { cause: listFailure }
                  );
                }
                if (survivors === "no-namespace") return true;
                lastSeen = survivors;
                return survivors.length === 0 ? true : undefined;
              },
              timeoutMessage: () =>
                `${failure ? `${failure.message}\n  ` : ""}Still present after ${assertionTimeoutMs}ms: ` +
                lastSeen.join(", ")
            });
          }
        );

      for (const namespace of namespaceCleanupTargets)
        await attempt(`Kubernetes namespace ${namespace}`, async () => {
          const kubeconfig = await clusterKubeconfig(assertionTimeoutMs);
          const deleteResult = await commands.runKubectl(
            [
              "--kubeconfig",
              kubeconfig,
              "delete",
              "namespace",
              namespace,
              "--ignore-not-found=true",
              "--wait=false"
            ],
            assertionTimeoutMs
          );
          expectSuccess(deleteResult, `kubectl delete namespace ${namespace}`);
          await pollForValue({
            ports,
            timeoutMs: FIXTURE_NAMESPACE_DELETION_TIMEOUT_MS,
            intervalMs: assertionPollIntervalMs,
            probe: async (remainingMs) => {
              const context = `kubectl get namespace ${namespace}`;
              const result = await commands.runKubectl(
                [
                  "--kubeconfig",
                  kubeconfig,
                  "get",
                  "namespace",
                  namespace,
                  "--output",
                  "name"
                ],
                remainingMs
              );
              if (result.code === 0) return undefined;
              if (isMissingNamespace(result)) return true;
              throw new CloudCommandError(context, result);
            },
            timeoutMessage: () =>
              `Timed out after ${FIXTURE_NAMESPACE_DELETION_TIMEOUT_MS}ms waiting for Kubernetes namespace ${namespace} to be removed.`
          });
        });

      if (applicationDeletionFailed)
        throw new Error(
          `Could not reclaim the deployed Radius application for ${repository}; preserving its identity, ` +
            "GitHub Environment, state package, and repository workflows for recovery:\n" +
            failures.map((failure) => `  - ${failure}`).join("\n") +
            (reclaimed.length > 0 ?
              `\nReclaimed before failing: ${reclaimed.join(", ")}`
            : "")
        );

      // Delete service principals explicitly before applications. Application
      // deletion normally cascades, but an orphaned principal can survive after
      // its application is already gone and would otherwise wedge every later
      // clean-slate check.
      const principals = await listServicePrincipals(
        commands,
        expectedAppName
      ).catch((error: unknown) => {
        failures.push(`list service principals: ${describeError(error)}`);
        return [] as Array<{ objectId: string; appId?: string }>;
      });
      const blockedApplicationIds = new Set<string>();
      let preserveAllApplications = false;
      for (const principal of principals) {
        let assignments: RoleAssignmentRecord[];
        try {
          assignments = await listRoleAssignmentsAtScopes(
            commands,
            roleAssignmentScopes,
            assertionTimeoutMs,
            ports.now
          );
        } catch (error) {
          if (principal.appId) blockedApplicationIds.add(principal.appId);
          else preserveAllApplications = true;
          failures.push(
            `list role assignments for service principal ${principal.objectId}: ${describeError(error)}`
          );
          continue;
        }
        const principalAssignments = assignments.filter(
          (assignment) =>
            assignment.principalId.toLowerCase() ===
            principal.objectId.toLowerCase()
        );
        const unexpected = principalAssignments.filter(
          (assignment) =>
            !requiredRoleAssignments.some(
              (expected) =>
                assignment.scope.toLowerCase() ===
                  expected.scope.toLowerCase() &&
                assignment.roleDefinitionName.toLowerCase() ===
                  expected.roleDefinitionName.toLowerCase()
            )
        );
        if (unexpected.length > 0) {
          if (principal.appId) blockedApplicationIds.add(principal.appId);
          else preserveAllApplications = true;
          failures.push(
            `refuse service principal ${principal.objectId}: unexpected role assignment(s): ${unexpected
              .map(
                (assignment) =>
                  `"${assignment.roleDefinitionName}" at ${assignment.scope}`
              )
              .join(", ")}`
          );
          continue;
        }
        let assignmentDeletionFailed = false;
        for (const assignment of principalAssignments) {
          try {
            expectSuccess(
              await commands.runAz([
                "role",
                "assignment",
                "delete",
                "--ids",
                assignment.id,
                "--output",
                "none"
              ]),
              `az role assignment delete ${assignment.id}`
            );
            reclaimed.push(`role assignment ${assignment.id}`);
          } catch (error) {
            assignmentDeletionFailed = true;
            failures.push(
              `role assignment ${assignment.id}: ${describeError(error)}`
            );
          }
        }
        if (assignmentDeletionFailed) {
          if (principal.appId) blockedApplicationIds.add(principal.appId);
          else preserveAllApplications = true;
          continue;
        }
        try {
          const deletion = await commands.runAz([
            "ad",
            "sp",
            "delete",
            "--id",
            principal.objectId,
            "--output",
            "none"
          ]);
          if (!isAzureResourceNotFound(deletion))
            expectSuccess(deletion, `az ad sp delete ${principal.objectId}`);
          reclaimed.push(`service principal ${principal.objectId}`);
        } catch (error) {
          if (principal.appId) blockedApplicationIds.add(principal.appId);
          else preserveAllApplications = true;
          failures.push(
            `service principal ${principal.objectId}: ${describeError(error)}`
          );
        }
      }

      const apps = await listAppRegistrations(commands, expectedAppName).catch(
        (error: unknown) => {
          failures.push(`list app registrations: ${describeError(error)}`);
          return [] as AppRegistrationRecord[];
        }
      );
      for (const app of apps) {
        if (preserveAllApplications || blockedApplicationIds.has(app.appId)) {
          failures.push(
            `preserve app registration ${app.appId}: its service principal or role assignments were not safely removed`
          );
          continue;
        }
        await attempt(`app registration ${app.appId}`, async () => {
          const applicationUrl =
            `https://graph.microsoft.com/v1.0/applications/` +
            encodeURIComponent(app.objectId);
          // Once Graph accepts a DELETE, only poll. Under
          // Application.ReadWrite.OwnedBy, a repeat DELETE that reaches the
          // soft-deleted object answers 403 Authorization_RequestDenied,
          // because ownership can no longer be proven (#974).
          let deletionAccepted = false;
          await pollForValue({
            ports,
            timeoutMs: entraAppDeletionTimeoutMs,
            intervalMs: assertionPollIntervalMs,
            probe: async (remainingMs) => {
              const deadline = ports.now().getTime() + remainingMs;
              if (!deletionAccepted) {
                const deletion = await commands.runAz(
                  [
                    "rest",
                    "--method",
                    "DELETE",
                    "--url",
                    applicationUrl,
                    "--output",
                    "none"
                  ],
                  remainingCommandTimeout(
                    deadline,
                    ports.now,
                    `DELETE application ${app.objectId}`
                  )
                );
                if (!isAzureResourceNotFound(deletion)) {
                  expectSuccess(
                    deletion,
                    `az rest DELETE application ${app.objectId}`
                  );
                  deletionAccepted = true;
                }
              }

              const lookup = await commands.runAz(
                [
                  "rest",
                  "--method",
                  "GET",
                  "--url",
                  applicationUrl,
                  "--output",
                  "none"
                ],
                remainingCommandTimeout(
                  deadline,
                  ports.now,
                  `GET application ${app.objectId}`
                )
              );
              if (isExactGraphObjectNotFound(lookup)) return true;
              expectSuccess(lookup, `az rest GET application ${app.objectId}`);
              return undefined;
            },
            timeoutMessage: () =>
              `App registration ${app.appId} (object ${app.objectId}) remained directly queryable through ` +
              `Microsoft Graph after ${entraAppDeletionTimeoutMs}ms of exact-object deletion attempts.`
          });
        });
      }

      // Verified only after the app registrations are gone: deleting an
      // application cascade-deletes its principal, so probing immediately
      // after `az ad sp delete` would race that cascade and fail a reclaim
      // that was about to succeed. An orphaned principal wedges every later
      // clean-slate check, and `az ad sp delete` reports success without
      // proving the object is gone, so confirm the end state here. Deliberate
      // preservation is not a leak, so skip the check when anything was held
      // back for recovery.
      if (!preserveAllApplications && blockedApplicationIds.size === 0) {
        let survivingPrincipals: readonly string[] = [];
        await pollForValue({
          ports,
          timeoutMs: assertionTimeoutMs,
          intervalMs: assertionPollIntervalMs,
          probe: async () => {
            survivingPrincipals = (
              await listServicePrincipals(commands, expectedAppName)
            ).map((principal) => principal.objectId);
            return survivingPrincipals.length === 0 ? true : undefined;
          },
          timeoutMessage: () =>
            `service principal(s) ${survivingPrincipals.join(", ")} for ${expectedAppName} ` +
            `were still listed ${assertionTimeoutMs}ms after their application was deleted.`
        }).catch((error: unknown) => {
          failures.push(
            `verify no service principal for ${expectedAppName} survives: ${describeError(error)}`
          );
        });
      }

      await reclaimGitHubRunState(ledger, githubFixture, githubRunState);

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

interface LeakProbeInput {
  readonly commands: CloudCommandPort;
  readonly expectedAppName: string;
  readonly roleAssignmentScopes?: readonly string[];
}

interface RoleAssignment {
  readonly principalId: string;
  readonly roleDefinitionName: string;
  readonly scope: string;
}

interface PollForValueOptions<T> {
  readonly ports: Pick<CloudFixturePorts, "now" | "wait">;
  readonly timeoutMs: number;
  readonly intervalMs: number;
  readonly probe: (remainingMs: number) => Promise<T | undefined>;
  readonly timeoutMessage: () => string;
}

async function pollForValue<T>(options: PollForValueOptions<T>): Promise<T> {
  const deadline = options.ports.now().getTime() + options.timeoutMs;
  const expired = (): boolean => deadline - options.ports.now().getTime() <= 0;
  while (true) {
    const remainingBeforeProbe = deadline - options.ports.now().getTime();
    if (remainingBeforeProbe <= 0) throw new Error(options.timeoutMessage());
    let value: T | undefined;
    try {
      value = await options.probe(remainingBeforeProbe);
    } catch (error) {
      // The probe runs its command with whatever budget is left, so the last
      // attempt before the deadline is killed mid-flight and reports an exit
      // code with no output at all. Raising that as a probe failure would
      // replace the timeout diagnostic — which names the workloads and their
      // replica counts — with a bare "failed with exit code 1".
      //
      // Only a command the port saw killed by its own timeout is translated,
      // and only once the deadline has already passed. Every other failure
      // raises verbatim however late it arrives: a probe that genuinely found
      // something wrong — a duplicate app registration, a rejected credential
      // — must keep saying so rather than be reported as "timed out waiting",
      // which would describe a state nothing observed.
      if (!expired() || !(error instanceof CloudCommandError && error.timedOut))
        throw error;
      throw new Error(options.timeoutMessage(), { cause: error });
    }
    if (value !== undefined) return value;
    const remaining = deadline - options.ports.now().getTime();
    if (remaining <= 0) throw new Error(options.timeoutMessage());
    await options.ports.wait(Math.min(options.intervalMs, remaining));
  }
}

function remainingCommandTimeout(
  deadline: number,
  now: () => Date,
  context: string
): number {
  const remaining = deadline - now().getTime();
  if (remaining <= 0)
    throw new Error(`${context} exhausted its assertion deadline.`);
  return remaining;
}

async function collectAzureLeakedState(
  input: LeakProbeInput
): Promise<string[]> {
  const { commands } = input;
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

  // Azure's --scope filter applies atScope(), so query both exact scopes the
  // product writes instead of assuming the resource-group query includes AKS.
  if (input.roleAssignmentScopes) {
    const assignments = await listRoleAssignments(
      commands,
      input.roleAssignmentScopes
    );
    for (const assignment of assignments)
      findings.push(
        `role assignment "${assignment.roleDefinitionName}" for principal ${assignment.principalId} at ${assignment.scope}`
      );
  }

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
): Promise<Array<{ objectId: string; appId?: string }>> {
  const context = `az ad sp list --filter displayName eq '${displayName}'`;
  const entries = parseJsonArray(
    await commands.runAz([
      "ad",
      "sp",
      "list",
      "--filter",
      `displayName eq '${displayName}'`,
      "--query",
      "[].{id:id,appId:appId}",
      "-o",
      "json"
    ]),
    context
  );
  return entries.map((entry, index) => {
    const record = asRecord(entry, context, index);
    return {
      objectId: requireString(record.id, "id", context, index),
      ...(typeof record.appId === "string" && record.appId.trim() ?
        { appId: record.appId.trim() }
      : {})
    };
  });
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

async function listRoleAssignmentRecords(
  commands: CloudCommandPort,
  scope: string,
  timeoutMs: number
): Promise<RoleAssignmentRecord[]> {
  const context = `az role assignment list --scope ${scope}`;
  const entries = parseJsonArray(
    await commands.runAz(
      [
        "role",
        "assignment",
        "list",
        "--scope",
        scope,
        // Only principal IDs are used; name resolution adds an unrelated Graph read.
        "--fill-principal-name",
        "false",
        "--query",
        "[].{id:id,principalId:principalId,roleDefinitionName:roleDefinitionName,scope:scope}",
        "-o",
        "json"
      ],
      timeoutMs
    ),
    context
  );
  return entries.map((entry, index) => {
    const record = asRecord(entry, context, index);
    return {
      id: requireString(record.id, "id", context, index),
      principalId: requireString(
        record.principalId,
        "principalId",
        context,
        index
      ),
      roleDefinitionName:
        typeof record.roleDefinitionName === "string" ?
          record.roleDefinitionName
        : "(unnamed role)",
      scope: requireString(record.scope, "scope", context, index)
    };
  });
}

async function listRoleAssignments(
  commands: CloudCommandPort,
  scopes: readonly string[]
): Promise<RoleAssignment[]> {
  const assignments: RoleAssignment[] = [];
  for (const scope of scopes) {
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
    assignments.push(
      ...entries.map((entry, index) => {
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
            : "(unnamed role)",
          scope
        };
      })
    );
  }
  return assignments;
}

async function listRoleAssignmentsAtScopes(
  commands: CloudCommandPort,
  scopes: readonly string[],
  timeoutMs: number,
  now: () => Date
): Promise<RoleAssignmentRecord[]> {
  const deadline = now().getTime() + timeoutMs;
  const byId = new Map<string, RoleAssignmentRecord>();
  for (const scope of scopes)
    for (const assignment of await listRoleAssignmentRecords(
      commands,
      scope,
      remainingCommandTimeout(
        deadline,
        now,
        `Role-assignment lookup at ${scope}`
      )
    ))
      byId.set(assignment.id.toLowerCase(), assignment);
  return [...byId.values()];
}

function isMissingNamespace(result: CloudCommandResult): boolean {
  return /namespaces? "[^"]*" not found/i.test(
    `${result.stderr}\n${result.stdout}`
  );
}

function requireValue(value: string, message: string): string {
  if (!value || !value.trim()) throw new Error(message);
  return value;
}

function requirePositiveNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${label} must be a positive finite number.`);
  return value;
}
