import type { IncomingMessage } from "node:http";
import type { SelectedGhExecutor } from "../../gh.js";
import type { CanvasState } from "../../shared.js";
import type { CanvasRequestContext } from "../request-context.js";
import type { RouteHandlerRegistry } from "../route-table.js";
import {
  admitCreateEnvironmentRequest,
  refuseUnlessServerOwned,
  type AdmissionPorts,
  type CreateEnvironmentRequestData
} from "./create-environment-refusals.js";
import type { WorkflowScopeGhRunnerPorts } from "./create-environment-gh-runner.js";
import { configureSetupEnvironment } from "@radius-project/core";
import { createSetupEnvironmentPorts } from "./setup-environment-adapter.js";
import { presentSetupVerificationSkip } from "./setup-environment-presentation.js";
import type { GhCommandPresentation } from "../../gh-command-display.js";
import type { GitHubEnvironmentReadResult } from "../services/github-environment.js";
import type { WorkflowTempFilePort } from "./create-environment-workflow-committer.js";
import type {
  CreateEnvironmentCommandResult,
  CreateEnvironmentOperation,
  CreateEnvironmentPullRequestResult,
  CredentialVerificationPlanResult,
  GhcrPreflightResult,
  SetupFailureResponse
} from "./create-environment-types.js";
import { ProviderMutationRecoveryError } from "../services/provider-mutation-recovery.js";
import { selectedEnvironmentReader } from "../services/github-environment.js";
import type { WorkflowFileReadResult } from "../../verification-plan.js";

// The core use case owns setup ordering. Canvas retains admission, synchronous
// HTTP completion, and failure cleanup; its awaited checkpoint/finalization
// ports preserve the original cancellation boundaries and operation lock scope.

export interface CreateEnvironmentInstanceEntry {
  state: CanvasState;
}

export interface CreateEnvironmentDependencies
  extends AdmissionPorts, WorkflowScopeGhRunnerPorts {
  ghCommandPresentation?: GhCommandPresentation;
  // --- request scope ---
  // Evaluated per request against this instance's server-owned token. Never a
  // construction-time value: the token is a per-instance randomUUID().
  isServerOwnedRequest(instanceId: string, request: IncomingMessage): boolean;
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
  // closed the operation and answered the request, so the caller must return
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

export async function handleCreateEnvironment(
  context: CanvasRequestContext,
  dependencies: CreateEnvironmentDependencies
): Promise<void> {
  const { response } = context;
  const respond = (status: number, payload: unknown): void => {
    // Header order is observable: Content-Type is set before the status line.
    response.setHeader("Content-Type", "application/json");
    response.writeHead(status);
    response.end(JSON.stringify(payload));
  };

  // Rung 1, decided before the body is read.
  const serverOwnedRefusal = refuseUnlessServerOwned(
    dependencies.isServerOwnedRequest(context.instanceId, context.request)
  );
  if (serverOwnedRefusal) {
    respond(serverOwnedRefusal.status, serverOwnedRefusal.body);
    return;
  }

  const body = await context.readTextBody();
  // Declared out here so the generic catch below can close it rather than
  // discarding everything the route had learned.
  let op: CreateEnvironmentOperation | null = null;
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
    const data: CreateEnvironmentRequestData = JSON.parse(body);
    const admission = await admitCreateEnvironmentRequest(data, dependencies);
    if (admission.outcome === "refused") {
      op = admission.operation;
      respond(admission.refusal.status, admission.refusal.body);
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
        respond
      });
    const finalize = async (
      input: Record<string, unknown>
    ): Promise<"failed" | "stopped"> => {
      if (!(await stopBoundary("before-setup-failure-cleanup")))
        return "stopped";
      const failure = await dependencies.finalizeSetupFailure(operation, {
        ...input,
        steps,
        runGitHubVariable: runGitHubVariableRunner,
        runDeleteEnvironment: deleteGitHubEnvironmentRunner,
        readEnvironment: readGitHubEnvironmentRunner
      });
      respond(failure.status, failure.body);
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
        instanceId: context.instanceId,
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
    respond(200, {
      success: true,
      ...configured,
      verifySkipReason: presentSetupVerificationSkip(
        configured.verifySkipReason
      ),
      steps
    });
  } catch (e) {
    // Reconciliation still owns this operation and it is not terminal. A stop
    // recorded now is honored by the reconciling pass at its own boundary;
    // ending the operation here would strand the journal entry unreconciled.
    if (
      e instanceof ProviderMutationRecoveryError &&
      e.code === "provider-mutation-outcome-unknown" &&
      op
    ) {
      respond(202, {
        operationId: op.operationId,
        code: e.code,
        reconciling: true,
        message: e.message
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
        respond
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
    respond(failure.status, failure.body);
  }
}

export function createCreateEnvironmentRoutes(
  dependencies: CreateEnvironmentDependencies
): RouteHandlerRegistry {
  return {
    "POST /api/create-environment": (context) =>
      handleCreateEnvironment(context, dependencies)
  };
}
