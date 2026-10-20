import type { SelectedGhExecutor } from "../../gh.js";
import type { CanvasState } from "../../shared.js";
import {
  admitCreateEnvironmentRequest,
  type AdmissionPorts,
  type CreateEnvironmentRequestData
} from "../routes/create-environment-refusals.js";
import type { WorkflowScopeGhRunnerPorts } from "../routes/create-environment-gh-runner.js";
import { configureSetupEnvironment } from "@radius-project/core";
import { createSetupEnvironmentPorts } from "../routes/setup-environment-adapter.js";
import { presentSetupVerificationSkip } from "../routes/setup-environment-presentation.js";
import type { GhCommandPresentation } from "../../gh-command-display.js";
import type { GitHubEnvironmentReadResult } from "../services/github-environment.js";
import type { WorkflowTempFilePort } from "../routes/create-environment-workflow-committer.js";
import type {
  CreateEnvironmentCommandResult,
  CreateEnvironmentOperation,
  CreateEnvironmentPullRequestResult,
  CredentialVerificationPlanResult,
  GhcrPreflightResult,
  SetupFailureResponse
} from "../routes/create-environment-types.js";
import { ProviderMutationRecoveryError } from "../services/provider-mutation-recovery.js";
import { selectedEnvironmentReader } from "../services/github-environment.js";
import type { WorkflowFileReadResult } from "../../verification-plan.js";
import {
  setupHandlerFailure,
  type SetupInput,
  type SetupOutcome
} from "./setup-outcome.js";

// Core owns setup ordering. These Canvas admission and cleanup bindings retain
// the checkpoint boundaries and operation lock scope for both callers.

export interface CreateEnvironmentInstanceEntry {
  state: CanvasState;
}

export interface ConfigureEnvironmentDependencies
  extends AdmissionPorts, WorkflowScopeGhRunnerPorts {
  ghCommandPresentation?: GhCommandPresentation;
  // --- request scope ---
  getSelectedGitHubExecutor(
    operationId: string
  ): SelectedGhExecutor | null | undefined;
  readInstanceEntry(
    instanceId: string
  ): CreateEnvironmentInstanceEntry | undefined;

  // --- narration + operation finalization ---
  addLegacyStep(operation: CreateEnvironmentOperation, text: string): void;
  finalizeSetupFailure(
    operation: CreateEnvironmentOperation | null,
    input: Record<string, unknown>
  ): Promise<SetupFailureResponse>;
  persistMutationCheckpoint(input: {
    operation: CreateEnvironmentOperation | null;
    persist: () => Promise<void>;
    report: (diagnostic: { code: string; message: string }) => void;
    fail: (status: number, error: string, code: string) => Promise<void>;
  }): Promise<boolean>;
  persistBestEffort(input: {
    operation: CreateEnvironmentOperation | null;
    persist: () => Promise<void>;
    report: (diagnostic: { code: string; message: string }) => void;
  }): Promise<boolean>;
  // Honors a recorded stop between remote mutations. Returns false once it has
  // closed the operation and reported its result, so the caller must return
  // without touching Azure or GitHub again. Never called while a command is in
  // flight: Radius lets the current write finish and stops before the next one.
  guardStopBoundary(input: {
    operation: CreateEnvironmentOperation | null;
    boundary: string;
    persist: () => Promise<void>;
    report: (diagnostic: { code: string; message: string }) => void;
    respond: (status: number, body: Record<string, unknown>) => void;
  }): Promise<boolean>;
  runAzCommand(
    args: string[]
  ): Promise<Partial<CreateEnvironmentCommandResult>>;

  // --- preflight ---
  preflightRepoAdmin(
    repo: string,
    executor?: SelectedGhExecutor
  ): Promise<string>;
  preflightGhcrPackageWriteAccess(
    executor?: SelectedGhExecutor
  ): Promise<GhcrPreflightResult>;
  readGitHubJson(
    apiPath: string,
    executor?: SelectedGhExecutor
  ): Promise<GitHubEnvironmentReadResult>;
  bootstrapGHCRStatePackage(input: {
    targetRepository: string;
    registry: string;
    credentials: unknown;
  }): Promise<{ visibility: string | undefined }>;
  stateRegistryForEnvironment(repo: string, environment: string): string;

  // --- committer ports ---
  getDefaultBranch(
    repo: string,
    executor?: SelectedGhExecutor
  ): Promise<string | null | undefined>;
  fetchFileFromRepoResult(
    repo: string,
    path: string,
    branch: string,
    executor?: SelectedGhExecutor
  ): Promise<WorkflowFileReadResult>;
  getBranchHeadSha(
    repo: string,
    branch: string,
    executor?: SelectedGhExecutor
  ): Promise<string | null | undefined>;
  createBranchRef(
    repo: string,
    branch: string,
    sha: string,
    executor?: SelectedGhExecutor
  ): Promise<{ ok: boolean; stderr: string }>;
  tempFile: WorkflowTempFilePort;

  // --- GitHub environment ---
  setCanonicalEnvironment(
    operation: CreateEnvironmentOperation,
    environment: string
  ): void;
  recordGitHubEnvironment(
    operation: CreateEnvironmentOperation,
    patch: {
      state: string;
      repo: string;
      name: string;
      providerId?: string | null;
      origin?: string;
    }
  ): void;
  recordGitHubEnvironmentVariable(
    operation: CreateEnvironmentOperation,
    entry: {
      repo: string;
      environment: string;
      environmentProviderId: string;
      name: string;
      valueSha256: string;
      previousValue: string | null;
      previousKnown: boolean;
    }
  ): void;
  // Promotes the environment this request wrote from "Radius may own this" to
  // "Radius created this", and only after the identity is durably saved. It
  // answers false when the ledger cannot match the proof, which leaves the safe
  // under-claim in place.
  promoteCreatedGitHubEnvironment(
    operation: CreateEnvironmentOperation,
    identity: { repo: string; name: string }
  ): boolean;
  envListCacheDelete(repo: string): void;
  ociStateBackend: string;
  defaultStateArchive: string;

  // --- credentials ---
  azureCredential(): Record<string, unknown>;
  awsCredential(): Record<string, unknown>;
  optionalString(value: unknown): string;

  // --- workflow generation and commit ---
  generateVerifyWorkflow(
    environment: string,
    provider: string,
    setupPushOperationMarker?: string
  ): Promise<string>;
  generateDeployWorkflow(
    environment: string,
    appFile: string
  ): Promise<Record<string, string>>;
  generateDeleteWorkflow(environment: string): Promise<Record<string, string>>;
  recordCommittedWorkflowFile(
    operation: CreateEnvironmentOperation,
    entry: {
      path: string;
      branch: string | null;
      mode: string;
      commitSha: string | null;
      blobSha: string | null;
      contentSha256: string | null;
      previousBlobSha: string | null;
      previousBlobKnown: boolean;
    }
  ): void;
  deleteLegacyDeployWorkflow(
    repo: string,
    executor?: SelectedGhExecutor,
    beforeDelete?: () => Promise<boolean>,
    branch?: string
  ): Promise<boolean | "cancelled">;
  createPullRequestApi(
    repo: string,
    head: string,
    base: string,
    title: string,
    body: string,
    executor?: SelectedGhExecutor
  ): Promise<CreateEnvironmentPullRequestResult>;

  // --- verification ---
  planCredentialVerification(input: {
    targetRepo: string;
    defaultBranch: string;
    prState: { branch: string; base: string } | null;
    pullRequestUrl: string;
    fetchFile: (
      repo: string,
      path: string,
      branch: string
    ) => Promise<string | null | undefined>;
    automaticPushEnabled?: boolean;
    branchVerificationAllowed?: boolean;
  }): Promise<CredentialVerificationPlanResult>;
  fetchFileFromRepo(
    repo: string,
    path: string,
    branch: string,
    executor?: SelectedGhExecutor
  ): Promise<string | null | undefined>;
  buildVerifyWorkflowDispatchArgs(input: {
    workflowFile: string;
    targetRepo: string;
    envName: string;
    ref?: string;
    operationMarker?: string;
  }): string[];
  verifyWorkflowFile: string;
  stageVerify: string;

  // --- terminal state ---
  recordCleanupState(
    operation: CreateEnvironmentOperation,
    patch: { state: string }
  ): void;
  recordCommitState(
    operation: CreateEnvironmentOperation,
    patch: Record<string, unknown>
  ): void;
  setStageState(
    operation: CreateEnvironmentOperation,
    stage: string,
    state: string
  ): void;
  finish(
    operation: CreateEnvironmentOperation,
    state: string,
    options: Record<string, unknown>
  ): void;

  // --- clocks ---
  sleep(milliseconds: number): Promise<void>;
  now(): number;
}

const REQUIRED_BINDINGS = {
  isValidRepoSlug: "function",
  getOperation: "function",
  isStale: "function",
  isTerminalState: "function",
  createOperation: "function",
  buildStages: "function",
  startOperation: "function",
  persistOperations: "function",
  reportOperationDiagnostic: "function",
  finishFailed: "function",
  enterStage: "function",
  errorMessage: "function",
  stageAuthorizeIdentity: "string",
  stageConfigureEnvironment: "string",
  namespaceClaimsFor: "function",
  cliExec: "function",
  readProcessEnv: "function",
  getSelectedGitHubExecutor: "function",
  readInstanceEntry: "function",
  addLegacyStep: "function",
  finalizeSetupFailure: "function",
  persistMutationCheckpoint: "function",
  persistBestEffort: "function",
  guardStopBoundary: "function",
  runAzCommand: "function",
  preflightRepoAdmin: "function",
  preflightGhcrPackageWriteAccess: "function",
  readGitHubJson: "function",
  bootstrapGHCRStatePackage: "function",
  stateRegistryForEnvironment: "function",
  getDefaultBranch: "function",
  fetchFileFromRepoResult: "function",
  getBranchHeadSha: "function",
  createBranchRef: "function",
  setCanonicalEnvironment: "function",
  recordGitHubEnvironment: "function",
  recordGitHubEnvironmentVariable: "function",
  promoteCreatedGitHubEnvironment: "function",
  envListCacheDelete: "function",
  ociStateBackend: "string",
  defaultStateArchive: "string",
  azureCredential: "function",
  awsCredential: "function",
  optionalString: "function",
  generateVerifyWorkflow: "function",
  generateDeployWorkflow: "function",
  generateDeleteWorkflow: "function",
  recordCommittedWorkflowFile: "function",
  deleteLegacyDeployWorkflow: "function",
  createPullRequestApi: "function",
  planCredentialVerification: "function",
  fetchFileFromRepo: "function",
  buildVerifyWorkflowDispatchArgs: "function",
  verifyWorkflowFile: "string",
  stageVerify: "string",
  recordCleanupState: "function",
  recordCommitState: "function",
  setStageState: "function",
  finish: "function",
  sleep: "function",
  now: "function"
} satisfies Record<
  Exclude<
    keyof ConfigureEnvironmentDependencies,
    "ghCommandPresentation" | "tempFile"
  >,
  "function" | "string"
>;

function validateDependencies(
  dependencies: ConfigureEnvironmentDependencies
): void {
  for (const name of Object.keys(REQUIRED_BINDINGS) as Array<
    keyof typeof REQUIRED_BINDINGS
  >) {
    const value = dependencies[name];
    if (
      typeof value !== REQUIRED_BINDINGS[name] ||
      (typeof value === "string" && !value)
    ) {
      throw new Error(`Missing environment configuration dependency: ${name}`);
    }
  }
  for (const name of ["write", "remove"] as const) {
    if (typeof dependencies.tempFile?.[name] !== "function") {
      throw new Error(
        `Missing environment configuration dependency: tempFile.${name}`
      );
    }
  }
}

export function createConfigureEnvironmentService(
  dependencies: ConfigureEnvironmentDependencies
) {
  validateDependencies(dependencies);
  return async (
    input: SetupInput<CreateEnvironmentRequestData>,
    instanceId: string
  ): Promise<SetupOutcome> => {
    let outcome: SetupOutcome | undefined;
    const complete = (result: SetupOutcome) => {
      outcome = result;
    };
    try {
      await runConfigureEnvironmentService(
        input,
        instanceId,
        dependencies,
        complete
      );
      if (!outcome)
        throw new Error("Environment setup did not report an outcome.");
      return outcome;
    } catch (error) {
      return setupHandlerFailure(error, dependencies.reportOperationDiagnostic);
    }
  };
}

async function runConfigureEnvironmentService(
  input: SetupInput<CreateEnvironmentRequestData>,
  instanceId: string,
  dependencies: ConfigureEnvironmentDependencies,
  complete: (outcome: SetupOutcome) => void
): Promise<void> {
  const stopped = (status: number, body: Record<string, unknown>) =>
    complete({ kind: "stopped", status, body });
  // Declared out here so the generic catch below can close it rather than
  // discarding everything the service had learned.
  let op: CreateEnvironmentOperation | null = null;
  let finalizationStarted = false;
  let steps: string[] = [];
  let deleteGitHubEnvironmentRunner:
    ((args: string[]) => Promise<unknown>) | null = null;
  // The cleanup's identity gate reads the environment back before deleting it.
  // It has to read through the same account the environment was created with,
  // or an access failure reads as "gone" and the delete goes out blind.
  let readGitHubEnvironmentRunner:
    ((args: string[]) => Promise<CreateEnvironmentCommandResult>) | null = null;
  let runGitHubVariableRunner:
    ((args: string[]) => Promise<CreateEnvironmentCommandResult>) | null = null;
  try {
    if ("error" in input) throw input.error;
    const data = input.data;
    const admission = await admitCreateEnvironmentRequest(data, dependencies);
    if (admission.outcome === "refused") {
      op = admission.operation;
      complete({ kind: "refused", ...admission.refusal });
      return;
    }
    const { targetRepo, provider } = admission;
    const { envName } = admission;
    op = admission.operation;
    const operation = admission.operation;
    const selectedExecutor = dependencies.getSelectedGitHubExecutor(
      operation.operationId
    );
    if (!selectedExecutor) {
      throw new Error(
        "The selected GitHub account executor is unavailable. Re-check the account and retry."
      );
    }
    await selectedExecutor.verifyIdentity();
    deleteGitHubEnvironmentRunner = async (args) => {
      const result = await selectedExecutor.run(args);
      if (result.code !== 0 && result.code !== "0") {
        const detail = (result.stderr || result.stdout || "").trim();
        throw new Error(detail || "GitHub API request failed.");
      }
    };
    readGitHubEnvironmentRunner = selectedEnvironmentReader(selectedExecutor);
    runGitHubVariableRunner = (args) =>
      selectedExecutor.run(args, { timeout: 20000 });

    steps = [];
    const rawPush = steps.push.bind(steps);
    steps.push = (...items: string[]) => {
      for (const item of items) {
        try {
          dependencies.addLegacyStep(operation, item);
        } catch {
          /* narration must never break setup */
        }
      }
      return rawPush(...items);
    };
    const stopBoundary = (boundary: string) =>
      dependencies.guardStopBoundary({
        operation,
        boundary,
        persist: () => dependencies.persistOperations(),
        report: (diagnostic) =>
          dependencies.reportOperationDiagnostic(diagnostic),
        respond: stopped
      });
    const finalize = async (
      input: Record<string, unknown>
    ): Promise<"failed" | "stopped"> => {
      if (!(await stopBoundary("before-setup-failure-cleanup")))
        return "stopped";
      finalizationStarted = true;
      const failure = await dependencies.finalizeSetupFailure(operation, {
        ...input,
        steps,
        runGitHubVariable: runGitHubVariableRunner,
        runDeleteEnvironment: deleteGitHubEnvironmentRunner,
        readEnvironment: readGitHubEnvironmentRunner
      });
      complete({ kind: "failed", ...failure });
      return "failed";
    };
    const fail = async (
      status: number,
      error: string,
      code: string,
      extra: Record<string, unknown> = {}
    ): Promise<"failed" | "stopped"> =>
      finalize({
        status,
        error,
        code,
        extra,
        evidence:
          typeof extra.azError === "string" ? extra.azError
          : typeof extra.ghError === "string" ? extra.ghError
          : null,
        runAz:
          provider === "azure" ?
            (args: string[]) => dependencies.runAzCommand(args)
          : null
      });
    const checkpoint = async (boundary: string) => {
      const saved = await dependencies.persistMutationCheckpoint({
        operation,
        persist: () => dependencies.persistOperations(),
        report: (diagnostic) =>
          dependencies.reportOperationDiagnostic(diagnostic),
        fail: async (...args) => {
          await fail(...args);
        }
      });
      if (!saved) return false;
      return stopBoundary(boundary);
    };
    const result = await configureSetupEnvironment(
      {
        operationId: operation.operationId,
        targetRepo,
        provider,
        envName,
        data
      },
      createSetupEnvironmentPorts({
        dependencies,
        operation,
        selectedExecutor,
        instanceId,
        provider,
        steps,
        stopBoundary,
        checkpoint,
        fail,
        finalize
      })
    );
    if (result.kind !== "configured") return;
    const { kind: _kind, ...configured } = result;
    complete({
      kind: "completed",
      status: 200,
      body: {
        success: true,
        ...configured,
        verifySkipReason: presentSetupVerificationSkip(
          configured.verifySkipReason
        ),
        steps
      }
    });
  } catch (e) {
    if (finalizationStarted) throw e;
    // Reconciliation still owns this operation and it is not terminal. A stop
    // recorded now is honored by the reconciling pass at its own boundary;
    // ending the operation here would strand the journal entry unreconciled.
    if (
      e instanceof ProviderMutationRecoveryError &&
      e.code === "provider-mutation-outcome-unknown" &&
      op
    ) {
      complete({
        kind: "reconciling",
        status: 202,
        body: {
          operationId: op.operationId,
          code: e.code,
          reconciling: true,
          message: e.message
        }
      });
      return;
    }
    if (
      op &&
      !(await dependencies.guardStopBoundary({
        operation: op,
        boundary: "before-setup-failure-cleanup",
        persist: () => dependencies.persistOperations(),
        report: (diagnostic) =>
          dependencies.reportOperationDiagnostic(diagnostic),
        respond: stopped
      }))
    ) {
      return;
    }
    const failure = await dependencies.finalizeSetupFailure(op, {
      status: 400,
      error: dependencies.errorMessage(e),
      code:
        e instanceof ProviderMutationRecoveryError ?
          e.code
        : "create-environment-unhandled",
      classification: "unknown",
      evidence: e instanceof Error ? e.stack || null : null,
      steps,
      runAz:
        op && op.provider === "azure" ?
          (args: string[]) => dependencies.runAzCommand(args)
        : null,
      runGitHubVariable: runGitHubVariableRunner,
      runDeleteEnvironment: deleteGitHubEnvironmentRunner,
      readEnvironment: readGitHubEnvironmentRunner
    });
    complete({ kind: "failed", ...failure });
  }
}
