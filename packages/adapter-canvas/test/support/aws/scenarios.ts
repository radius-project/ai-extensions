import {
  applySetupProviderConfiguration,
  AWS_EKS_CLUSTER_ADMIN_POLICY_ARN,
  buildAwsAppBoundaryPolicy,
  buildAwsAppRolesPolicy,
  buildAwsAppRolesPolicyName,
  buildGitHubTrustPolicy,
  isSetupExecutionInterrupted
} from "@radius-project/core";
import {
  addLegacyStep,
  buildDeleteStages,
  buildStages,
  createOperation,
  enterStage,
  finish,
  isTerminalState,
  operations,
  provenOwnedCleanupTargets,
  recordCleanupState,
  recordGitHubEnvironment,
  recordGitHubEnvironmentVariable,
  setContext,
  setStageState,
  shouldStop,
  STAGE_AUTHORIZE_IDENTITY,
  STAGE_CONFIGURE_ENVIRONMENT,
  touchOperation
} from "../../../src/operations.js";
import {
  awsAppBoundary,
  awsEnvironmentPolicyName
} from "../../../src/aws-deploy-role-name.js";
import type { SelectedGhExecutor } from "../../../src/gh.js";
import {
  createAwsEnvironmentAccess,
  type AwsEnvironmentAccess
} from "../../../src/server/services/aws-environment-access.js";
import { createAwsSetupJournal } from "../../../src/server/services/aws-setup-journal.js";
import { rollbackAwsSetupArtifacts } from "../../../src/server/services/aws-setup-rollback.js";
import { releaseRecordedAwsLock } from "../../../src/server/services/aws-recorded-lock.js";
import { removeAwsDeployIdentityLock } from "../../../src/server/services/aws-deploy-identity-lock.js";
import { runEnvironmentDeletion } from "../../../src/server/services/environment-deletion.js";
import { createAwsTrustRepairService } from "../../../src/server/services/aws-trust-repair.js";
import { honorStopBoundary } from "../../../src/server/services/operation-stop-boundary.js";
import { createEnvironmentTargetReader } from "../../../src/server/services/environment-target.js";
import type { EnvironmentOperationRecord } from "../../../src/server/services/environment-operation.js";
import { createWorkflowScopeGhRunner } from "../../../src/server/routes/create-environment-gh-runner.js";
import { successfulSelectedGhExecutor } from "../server/selected-gh.js";
import { FakeAws } from "./fake-aws.js";
import { FakeGitHub } from "./fake-github.js";
import { freshStore, MemoryDisk, OutsideWorld } from "./stop-points.js";

// The AWS operations the stop-point tests drive: setup through Configure
// environment, the AWS part of a rollback, environment delete, and Repair.
// Each runs the production services over the fake AWS and GitHub, composed as
// `createProductionCanvasServerRuntime` composes them. The HTTP stop-point
// tests run the same operations through that composition itself.

export const ACCOUNT = "123456789012";
export const REPO = "octo/shop";
export const ENVIRONMENT = "dev";
export const REGION = "us-west-2";
export const CLUSTER = "shop";
export const ROLE = "radius-deploy-octo-shop";
export const LOGIN = "saved-account";
export const ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/${ROLE}`;
export const LOCK_ARN = `arn:aws:iam::${ACCOUNT}:policy/radius-lock-${ROLE}`;
// The other environment of the repository that a reused role already serves.
export const OTHER_ENVIRONMENT = "prod";
const OTHER_SUBJECT = `repo:${REPO}:environment:${OTHER_ENVIRONMENT}`;
// How long a lock wait may poll before the test calls it stuck.
const SLEEP_LIMIT = 400;

export type SetupRole = "new" | "reused";

// An operation record, as `createOperation` makes it.
type Operation = ReturnType<typeof createOperation>;

export interface AwsScenario {
  readonly outside: OutsideWorld;
  readonly aws: FakeAws;
  readonly github: FakeGitHub;
  readonly disk: MemoryDisk;
  readonly access: AwsEnvironmentAccess<EnvironmentOperationRecord>;
  readonly journal: ReturnType<
    typeof createAwsSetupJournal<EnvironmentOperationRecord>
  >;
  readonly executor: SelectedGhExecutor;
  readonly clock: { now: number };
  // Set when the execution running a rollback has ended.
  stopped: boolean;
  // Runs on every sleep, as a person acting while a run waits.
  onSleep: (() => Promise<void>) | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unexpected(name: string): () => never {
  return () => {
    throw new Error(`Unexpected ${name}`);
  };
}

/** A new world: an EKS cluster, the repository, and its dev environment. */
export async function createAwsScenario(
  role: SetupRole = "new"
): Promise<AwsScenario> {
  const clock = { now: Date.parse("2026-11-09T12:00:00Z") };
  // AWS stamps each creation a second after the last, on the run's clock,
  // so a lock's age is measured the way a waiting run measures it.
  const aws = new FakeAws({
    accountId: ACCOUNT,
    now: () => (clock.now += 1000)
  });
  aws.addCluster(CLUSTER, REGION);
  const github = new FakeGitHub(REPO);
  github.addEnvironment(ENVIRONMENT);
  if (role === "reused") {
    // Another environment's setup made the role and the cluster's entry.
    aws.addGitHubProvider();
    aws.addRole({
      name: ROLE,
      trust: buildGitHubTrustPolicy(ACCOUNT, [OTHER_SUBJECT]),
      tags: [
        { Key: "radius-managed", Value: "true" },
        { Key: "radius-repository", Value: REPO },
        // Every Radius setup tags the role it creates with the repository's
        // GitHub ID, and setup reuses only a role tagged with its own.
        { Key: "radius-repository-id", Value: String(github.repoId) }
      ],
      inline: {
        [awsEnvironmentPolicyName(github.repoId, OTHER_ENVIRONMENT)]: {
          Version: "2012-10-17",
          Statement: []
        },
        [buildAwsAppRolesPolicyName(github.repoId)]: buildAwsAppRolesPolicy(
          ACCOUNT,
          github.repoId
        )
      }
    });
    const otherBoundary = awsAppBoundary(
      ACCOUNT,
      github.repoId,
      OTHER_ENVIRONMENT
    );
    aws.addManagedPolicy({
      path: otherBoundary.path,
      name: otherBoundary.name,
      document: buildAwsAppBoundaryPolicy(ACCOUNT, REGION),
      tags: [
        { Key: "radius-managed", Value: "true" },
        { Key: "radius-repository", Value: REPO },
        { Key: "radius-repository-id", Value: String(github.repoId) }
      ]
    });
    aws.addAccessEntry(
      REGION,
      CLUSTER,
      ROLE_ARN,
      { "radius-managed": "true", "radius-operation": "op_prod" },
      [AWS_EKS_CLUSTER_ADMIN_POLICY_ARN]
    );
    github.addEnvironment(OTHER_ENVIRONMENT, {
      AWS_ROLE_ARN: ROLE_ARN,
      AWS_REGION: REGION,
      AWS_ACCOUNT_ID: ACCOUNT,
      AWS_EKS_CLUSTER_NAME: CLUSTER,
      AWS_TRUST_SUBJECTS: JSON.stringify([OTHER_SUBJECT]),
      AWS_APP_BOUNDARY_ARN: otherBoundary.arn
    });
  }
  const disk = new MemoryDisk();
  await freshStore(disk);
  const outside = new OutsideWorld(aws, github, disk);
  let sleeps = 0;
  const scenario: AwsScenario = {
    outside,
    aws,
    github,
    disk,
    clock,
    stopped: false,
    onSleep: null,
    executor: successfulSelectedGhExecutor({
      login: LOGIN,
      requiresKeyringSwitch: false,
      run: (args) => outside.gh(args)
    }),
    journal: createAwsSetupJournal<EnvironmentOperationRecord>({
      runAws: outside.runAws,
      persist: () => operations.persist(),
      now: () => clock.now
    }),
    access: undefined as never
  };
  const access = createAwsEnvironmentAccess<EnvironmentOperationRecord>({
    runAws: outside.runAws,
    runGitHubJson: (apiPath) => outside.readGitHubJson(apiPath),
    environments: {
      listEnvironmentNames: (repo) =>
        outside.outside(`GET /repos/${repo}/environments`, false, () => ({
          ok: true as const,
          names: [...github.environments.values()].map(({ name }) => name)
        })),
      readEnvironmentVariables: (repo, name) =>
        outside.outside(
          `GET /repos/${repo}/environments/${name}/variables`,
          false,
          () => {
            const environment = github.environment(name);
            return environment ?
                {
                  ok: true as const,
                  variables: Object.fromEntries(environment.variables)
                }
              : { ok: false as const, reason: "HTTP 404" };
          }
        )
    },
    sleep: async (milliseconds) => {
      clock.now += milliseconds;
      sleeps += 1;
      if (sleeps > SLEEP_LIMIT) {
        throw new Error(
          `Waited ${SLEEP_LIMIT} times, as on a lock nobody will release.`
        );
      }
      await scenario.onSleep?.();
    },
    now: () => clock.now,
    isStopRequested: shouldStop,
    isStoppedOperation: (operationId) => {
      const holder = operations.get(operationId);
      return Boolean(holder) && isTerminalState(holder.state);
    },
    operationId: (operation) => operation.operationId,
    operations: {
      getContext: (operation) => operation.context ?? {},
      enterStage,
      setStageState,
      addLegacyStep,
      setContext,
      touch: (operation) => {
        touchOperation(operation);
      }
    },
    store: { persist: () => operations.persist() },
    journal: scenario.journal,
    stageAuthorizeIdentity: STAGE_AUTHORIZE_IDENTITY,
    errorMessage
  });
  Object.assign(scenario, { access });
  return scenario;
}

export const SETUP_INPUT = {
  repo: REPO,
  environment: ENVIRONMENT,
  accountId: ACCOUNT,
  region: REGION,
  cluster: CLUSTER,
  roleName: ROLE,
  existingRoleArn: ""
};

/** A setup that has created its GitHub environment, about to authorize AWS. */
export function createSetupOperation(
  scenario: AwsScenario,
  operationId = "op_setup"
): Operation {
  const op = createOperation({
    operationId,
    repo: REPO,
    environment: ENVIRONMENT,
    provider: "aws",
    stages: buildStages({ includeIdentity: true })
  });
  op.context.githubLogin = LOGIN;
  op.request = {
    needsAzureCredentials: false,
    environment: { ...SETUP_INPUT }
  };
  // What the server saves so a restarted setup can continue.
  op.resumeRequest = {
    needsAzureCredentials: false,
    github: { login: LOGIN, credentialSource: "keyring" },
    environment: { ...SETUP_INPUT, provider: "aws" }
  };
  const environment = scenario.github.environment(ENVIRONMENT);
  recordGitHubEnvironment(op, {
    state: "created",
    origin: "this_operation",
    repo: REPO,
    name: ENVIRONMENT,
    providerId: String(environment?.id ?? "")
  });
  operations.put(op);
  return op;
}

/**
 * Authorize deploy identity, then Configure environment's GitHub variables,
 * then release the lock: the order the setup coordinator runs them in.
 */
export async function runSetup(
  scenario: AwsScenario,
  op: Operation
): Promise<void> {
  try {
    const result = await scenario.access.setup(
      op,
      SETUP_INPUT,
      scenario.executor
    );
    if (!result.ok) {
      await honorStopBoundary({
        operation: op,
        boundary: "after-aws-deploy-identity",
        persist: () => operations.persist()
      });
      return;
    }
    enterStage(op, STAGE_CONFIGURE_ENVIRONMENT);
    const environment = scenario.github.environment(ENVIRONMENT);
    const runner = createWorkflowScopeGhRunner(
      {
        cliExec: unexpected("cliExec"),
        readProcessEnv: unexpected("readProcessEnv")
      },
      {
        isStopped: () => shouldStop(op),
        targetRepo: REPO,
        envName: ENVIRONMENT,
        environmentProviderId: String(environment?.id ?? ""),
        mutationRecovery: {
          isStopped: () => shouldStop(op),
          operation: op,
          persist: () => operations.persist(),
          recordVariable: (entry) => recordGitHubEnvironmentVariable(op, entry)
        }
      },
      scenario.executor
    );
    await applySetupProviderConfiguration(
      "aws",
      {
        roleArn: result.roleArn,
        region: REGION,
        accountId: ACCOUNT,
        cluster: CLUSTER,
        trustSubjects: result.subjects,
        appBoundaryArn: result.appBoundaryArn
      },
      {
        setEnvironmentVariable: (name, value) =>
          runner.setEnvironmentVariable(
            name,
            typeof value === "string" ? value : undefined
          ),
        report: () => {},
        azureCredential: () => ({}),
        awsCredential: () => ({}),
        optionalString: (value) => (typeof value === "string" ? value : "")
      }
    );
  } catch (error) {
    if (!isSetupExecutionInterrupted(error)) throw error;
    await honorStopBoundary({
      operation: op,
      boundary: "configure-environment",
      persist: () => operations.persist()
    });
  } finally {
    await scenario.access.release(op);
  }
}

/** A setup run to the end of Configure environment, which then failed. */
export async function completedSetup(
  scenario: AwsScenario,
  state: "failed" | "succeeded" = "failed"
): Promise<Operation> {
  const op = createSetupOperation(scenario);
  await runSetup(scenario, op);
  assertSetupFinished(scenario, op);
  finish(op, state);
  await operations.persist();
  return op;
}

/**
 * Throws unless a setup ran to the end of Configure environment. A run that
 * stops early leaves less to stop at and roll back, so a stop-point matrix
 * built on it would shrink and still pass.
 */
export function assertSetupFinished(
  scenario: AwsScenario,
  op: Operation
): void {
  const variables = scenario.github.environment(ENVIRONMENT)?.variables;
  if (op.failure || !variables?.has("AWS_TRUST_SUBJECTS")) {
    const last = op.steps.at(-1)?.label ?? "no step";
    throw new Error(
      `Setup did not finish: ${String(op.failure?.message ?? last).replace(/\.$/, "")}. Update the scenario so a clean setup succeeds.`
    );
  }
}

/**
 * The AWS part of a cleanup pass, as Delete setup, Exit setup, and Retry
 * deletion run it: the selected AWS changes under the lock, then the release
 * of a lock the setup still records.
 */
export async function runAwsRollback(
  scenario: AwsScenario,
  op: Operation,
  attempt: number
): Promise<void> {
  const steps: string[] = [];
  const pass = await rollbackAwsSetupArtifacts(op, {
    attempt,
    awsEnabled: true,
    selected: provenOwnedCleanupTargets(op),
    access: scenario.access,
    steps,
    persist: () => operations.persist(),
    isStopped: () => scenario.stopped
  });
  if (pass.attempted) {
    if (pass.interrupted && pass.results.length === 0) return;
    recordCleanupState(op, { state: "running", results: pass.results });
    await operations.persist();
    if (pass.interrupted) return;
  }
  if (scenario.stopped) return;
  await releaseRecordedAwsLock(op, {
    awsEnabled: true,
    remove: (lock) =>
      removeAwsDeployIdentityLock(lock, scenario.outside.runAws),
    errorMessage
  });
  await operations.persist();
}

/** Delete the environment a setup created, as the delete route records it. */
export function createDeleteOperation(
  scenario: AwsScenario,
  operationId = "op_delete"
): Operation {
  const variables = Object.fromEntries(
    scenario.github.environment(ENVIRONMENT)?.variables ?? []
  );
  const op = createOperation({
    operationId,
    kind: "delete",
    provider: "aws",
    repo: REPO,
    environment: ENVIRONMENT,
    stages: buildDeleteStages({
      includeAzureCleanup: false,
      includeAwsCleanup: true
    })
  });
  op.request = {
    repo: REPO,
    repoId: scenario.github.repoId,
    environment: ENVIRONMENT,
    provider: "aws",
    clientId: "",
    tenantId: "",
    roleArn: variables.AWS_ROLE_ARN ?? "",
    trustSubjects: JSON.parse(variables.AWS_TRUST_SUBJECTS ?? "[]"),
    region: variables.AWS_REGION ?? "",
    cluster: variables.AWS_EKS_CLUSTER_NAME ?? ""
  };
  operations.put(op);
  return op;
}

export async function runDelete(
  scenario: AwsScenario,
  op: Operation
): Promise<void> {
  const { outside } = scenario;
  await runEnvironmentDeletion(op as never, {
    deleteRadiusEnvironment: () =>
      outside.outside("dispatch delete-environment workflow", true, () => ({
        outcome: "deleted" as const
      })),
    runAz: unexpected("az"),
    withCredentialProvenanceLock: (work) => work(),
    deleteGitHubEnvironment: (input) =>
      outside.outside(`DELETE environment ${input.environment}`, true, () => ({
        outcome: scenario.github.deleteEnvironment(input.environment)
      })),
    deleteStatePackage: () =>
      outside.outside("DELETE state package", true, () => "deleted" as const),
    reportStatePackageDeletionFailure: unexpected("package failure report"),
    readCredentialProvenance: () => [],
    readAzureIdentity: unexpected("Azure identity read"),
    removeCredentialProvenance: unexpected("provenance removal"),
    clearEnvironmentCredentialProvenance: unexpected("provenance clear"),
    readRepositoryId: async (repo) => {
      const response = await outside.readGitHubJson(`/repos/${repo}`);
      const id = response.json?.id;
      if (!response.ok || typeof id !== "number") {
        throw new Error(
          response.stderr || `HTTP ${response.status ?? "unknown"}`
        );
      }
      return id;
    },
    removeAwsEnvironmentAccess: scenario.access.remove,
    removeAwsDeployIdentityLock: (lock) =>
      removeAwsDeployIdentityLock(lock, outside.runAws),
    persist: () => operations.persist(),
    errorMessage
  });
}

/** Repair for a deploy of the dev environment that could not sign in. */
export async function runRepair(
  scenario: AwsScenario
): Promise<{ status: number; body: Record<string, unknown> }> {
  const service = createAwsTrustRepairService({
    awsEnabled: true,
    readInstanceState: () => ({
      deployStatus: "failed",
      deployErrorKind: "cloud-auth-drift",
      deployingRepo: REPO,
      deployEnvName: ENVIRONMENT,
      deployGeneration: 1
    }),
    cloudAuthDriftKind: "cloud-auth-drift",
    readEnvironmentTarget: createEnvironmentTargetReader(async (_c, args) => {
      const path = args.find((arg) => arg.startsWith("/")) ?? "";
      // The repository ID read, `gh api /repos/<repo> --jq .id`.
      if (!path.includes("/environments/")) {
        const response = await scenario.outside.readGitHubJson(path);
        if (!response.ok) throw new Error(response.stderr);
        return String(response.json?.id);
      }
      const name = decodeURIComponent(
        /\/environments\/([^/]+)\/variables/.exec(path)?.[1] ?? ""
      );
      return scenario.outside.outside(`GET ${path}`, false, () => {
        const environment = scenario.github.environment(name);
        if (!environment) throw new Error("gh: Not Found (HTTP 404)");
        return [...environment.variables]
          .map(([key, value]) => `${key}\t${value}`)
          .join("\n");
      });
    }),
    repair: (input) => scenario.access.repair(input),
    errorMessage
  });
  return service.repair({ instanceId: "panel", generation: 1 });
}
