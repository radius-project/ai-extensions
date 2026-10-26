import type { EnsuredGitHubEnvironment } from "./setup-github-environment.js";
import type { SetupWorkflowCommandResult } from "./setup-workflow-contracts.js";
import type { WorkflowFileCommitterPorts } from "./setup-workflow-committer.js";
import type { SetupWorkflowRecoveryPort } from "./setup-workflow-recovery.js";
import type {
  SetupProviderConfigurationInput,
  SetupProviderCredentialPorts,
  SetupProviderConfigurationEvent
} from "./setup-provider-configuration.js";
import type {
  SetupWorkflowPublicationEvent,
  SetupWorkflowCommitRecord
} from "./setup-workflow-publication.js";

export interface SetupEnvironmentInput {
  operationId: string;
  targetRepo: string;
  envName: string;
  provider: string;
  data: SetupProviderConfigurationInput & { profileName?: string };
}

export type SetupPullRequestNextStep =
  | "awaiting-merge-and-credentials"
  | "awaiting-merge"
  | "awaiting-credentials"
  | "verification-running";

export interface SetupPullRequestResult {
  ok: boolean;
  url?: string;
  number?: number;
  stderr?: string;
  timedOut?: boolean;
}

export type SetupVerificationSkipReason =
  | { kind: "merge"; reason: string }
  | { kind: "credentials"; provider: "azure" | "aws" };

export type SetupEnvironmentFailure =
  | { kind: "repository-access" }
  | { kind: "package-access" }
  | { kind: "workflow-reconciliation-pending" }
  | { kind: "default-branch-unavailable"; targetRepo: string }
  | {
      kind: "workflow-commit";
      targetRepo: string;
      publication: {
        workflow: "verify" | "deploy";
        path: string;
        stderr: string;
      };
    }
  | { kind: "verification-baseline"; unreadable: boolean; detail: string }
  | {
      kind: "verification-dispatch";
      detail: string;
      environment: string;
      operationMarker: string | null;
      provider: string;
      repo: string;
      stateRegistry: string;
    };

export type SetupAutomaticVerificationPolicy =
  | { state: "enabled" }
  | {
      state: "disabled";
      reason:
        | "verify-present"
        | "verify-unreadable"
        | "dispatcher-legacy-chain"
        | "dispatcher-unreadable"
        | "legacy-deploy-present"
        | "legacy-deploy-unreadable";
    };

export type SetupEnvironmentEvent =
  | { kind: "environment-owned" | "environment-resolved"; envName: string }
  | { kind: "environment-unowned"; envName: string; detail: string }
  | {
      kind: "environment-canonicalized";
      envName: string;
      requestedEnvName: string;
    }
  | { kind: "package-creating" | "package-configuring"; stateRegistry: string }
  | {
      kind: "package-created";
      visibility: string | undefined;
      targetRepo: string;
    }
  | { kind: "package-configured"; archive: string }
  | { kind: "provider-configuration"; event: SetupProviderConfigurationEvent }
  | { kind: "workflow-publication"; event: SetupWorkflowPublicationEvent }
  | {
      kind: "automatic-policy-disabled";
      policy: SetupAutomaticVerificationPolicy;
    }
  | { kind: "pull-request-opened"; number?: number; url?: string }
  | {
      kind: "pull-request-failed";
      branch: string;
      base: string;
      detail: string;
    }
  | { kind: "verification-merge-skip"; reason: string }
  | { kind: "verification-credentials-skip"; provider: "azure" | "aws" }
  | { kind: "verification-discovering"; ref: string }
  | {
      kind:
        | "verification-automatic"
        | "verification-dispatching"
        | "verification-dispatched";
    }
  | { kind: "verification-run"; url: string }
  | {
      kind: "verification-dispatch-identity";
      targetRepo: string;
      envName: string;
      ref: string;
    }
  | { kind: "verification-dispatch-failed"; detail: string }
  | {
      kind: "pull-request-next-step";
      outcome: SetupPullRequestNextStep;
      baseBranch: string;
      ref: string;
    };

export interface SetupVerificationIdentity {
  dispatchedAt: number;
  baselineRunId: number | null;
  ref: string;
  environment: string;
  operationMarker: string | null;
}

export type SetupVerificationDispatchOutcome =
  | { state: "accepted"; runId: string; runUrl: string; recovered: boolean }
  | { state: "manual_required"; guidance: string }
  | { state: "rejected"; detail: string; result: SetupWorkflowCommandResult }
  | {
      state: "baseline_failed";
      detail: string;
      unreadable: boolean;
      result: SetupWorkflowCommandResult | null;
    }
  | { state: "cancelled" };

export interface SetupVerificationDispatchInput {
  kind: "github_workflow.dispatch";
  target: string;
  repo: string;
  workflowPath: string;
  workflowFile: string;
  environment: string;
  ref: string;
  operationMarker: string;
  allowRegistrationRetry: boolean;
  ports: {
    isStopped?(): boolean;
    runGh(args: string[]): Promise<SetupWorkflowCommandResult>;
    sendDispatch(): Promise<SetupWorkflowCommandResult>;
    persist(): Promise<void>;
    stopBoundary(boundary: string): Promise<boolean>;
    applyIdentity(
      identity: SetupVerificationIdentity,
      run: { runId: string; runUrl: string } | null
    ): void;
    terminalizeManualRequired(guidance: string): void;
    now(): number;
    sleep(milliseconds: number): Promise<void>;
  };
}

export interface SetupWorkflowRead {
  content: string | null;
  error: string | null;
  status: number | null;
}

export interface SetupVerificationPlan {
  shouldDispatch: boolean;
  trigger: "workflow_dispatch" | "push" | "none";
  ref: string;
  defaultBranch: string;
  pullRequestUrl: string;
  skipReason: string;
  supportsOperationMarker?: boolean;
}

export interface SetupEnvironmentPorts extends SetupProviderCredentialPorts {
  recovery: SetupWorkflowRecoveryPort;
  // Runtime shutdown is immediate; the user's Stop retains its batch boundaries.
  isExecutionStopped(): boolean;
  stopRequested(): boolean;
  stopBoundary(boundary: string): Promise<boolean>;
  checkpoint(boundary: string): Promise<boolean>;
  finalizeFailure(
    failure: SetupEnvironmentFailure
  ): Promise<"failed" | "stopped">;
  preflightRepository(repo: string): Promise<boolean>;
  preflightPackages(): Promise<symbol | null>;
  readEnsuredEnvironment(
    repo: string,
    name: string
  ): EnsuredGitHubEnvironment | null;
  ensureEnvironment(
    repo: string,
    name: string,
    beforeCreate: () => Promise<boolean>
  ): Promise<EnsuredGitHubEnvironment>;
  setCanonicalEnvironment(name: string): void;
  recordEnvironment(patch: {
    state: string;
    repo: string;
    name: string;
    providerId?: string | null;
    origin?: string;
  }): void;
  promoteCreatedEnvironment(identity: { repo: string; name: string }): boolean;
  bindEnvironment(input: {
    targetRepo: string;
    envName: string;
    environmentProviderId: string | null;
    journalVariables: boolean;
  }): {
    runGh(args: string[]): Promise<SetupWorkflowCommandResult>;
    runGhWorkflow(args: string[]): Promise<SetupWorkflowCommandResult>;
    setEnvironmentVariable(
      name: string,
      value: string | undefined
    ): Promise<boolean>;
  };
  getDefaultBranch(repo: string): Promise<string | null | undefined>;
  stateRegistryForEnvironment(repo: string, environment: string): string;
  bootstrapStatePackage(input: {
    targetRepository: string;
    registry: string;
    credentials: symbol | undefined;
  }): Promise<{ visibility: string | undefined }>;
  workflowFiles(input: {
    targetRepo: string;
    envName: string;
    runGh(args: string[]): Promise<SetupWorkflowCommandResult>;
    runGhWorkflow(args: string[]): Promise<SetupWorkflowCommandResult>;
  }): WorkflowFileCommitterPorts;
  envListCacheDelete(repo: string): void;
  ociStateBackend: string;
  defaultStateArchive: string;
  verifyWorkflowFile: string;
  legacyDeployWorkflowFile: string;
  fetchFileFromRepoResult(
    repo: string,
    path: string,
    branch: string
  ): Promise<SetupWorkflowRead>;
  parseWorkflow(content: string): unknown;
  verification(): unknown;
  setVerification(value: Record<string, unknown>): void;
  generateVerifyWorkflow(
    environment: string,
    provider: string,
    marker?: string
  ): Promise<string>;
  generateDeployWorkflow(
    environment: string,
    appFile: string
  ): Promise<Record<string, string>>;
  generateDeleteWorkflow(environment: string): Promise<Record<string, string>>;
  recordCommittedWorkflowFile(entry: SetupWorkflowCommitRecord): void;
  deleteLegacyDeployWorkflow(
    repo: string,
    beforeDelete: () => Promise<boolean>,
    branch?: string
  ): Promise<boolean | "cancelled">;
  encode(content: string): string;
  createPullRequest(
    repo: string,
    head: string,
    base: string,
    envName: string
  ): Promise<SetupPullRequestResult>;
  recordCommitState(patch: {
    mode: string;
    branch: string;
    baseBranch: string;
    pullRequestUrl: string | null;
  }): void;
  planCredentialVerification(input: {
    targetRepo: string;
    defaultBranch: string;
    prState: { branch: string; base: string } | null;
    pullRequestUrl: string;
    automaticPushEnabled: boolean;
    branchVerificationAllowed: boolean;
    fetchFile(
      repo: string,
      path: string,
      branch: string
    ): Promise<string | null | undefined>;
  }): Promise<SetupVerificationPlan>;
  fetchFileFromRepo(
    repo: string,
    path: string,
    branch: string
  ): Promise<string | null | undefined>;
  discoverAutomaticVerificationRun(input: {
    isStopped?(): boolean;
    identity: {
      repo: string;
      workflow: string;
      ref: string;
      environment: string;
      operationMarker: string;
      startedAt: number;
    };
    listRuns(): Promise<SetupWorkflowCommandResult>;
    stopBoundary(boundary: string): Promise<boolean>;
    sleep(milliseconds: number): Promise<void>;
  }): Promise<
    | { state: "discovered"; runId: string; runUrl: string }
    | { state: "manual_required"; guidance: string }
    | { state: "cancelled" }
  >;
  terminalizeManualRequired(guidance: string): void;
  runVerificationDispatch(
    input: SetupVerificationDispatchInput
  ): Promise<SetupVerificationDispatchOutcome>;
  buildVerifyWorkflowDispatchArgs(input: {
    workflowFile: string;
    targetRepo: string;
    envName: string;
    ref?: string;
    operationMarker?: string;
  }): string[];
  enterVerifyStage(): void;
  projectVerification(input: {
    dispatchedAt: number;
    verifyRunId: string | number | null;
    verifyRunUrl: string;
  }): void;
  recordCleanupNotNeeded(): void;
  skipVerifyStage(): void;
  finishMergeRequired(input: {
    outcome: SetupPullRequestNextStep;
    pullRequestUrl: string | null;
    branch: string | null;
    baseBranch: string | null;
  }): void;
  finishCredentialsIncomplete(input: {
    provider: "azure" | "aws";
    pullRequestUrl: string | null;
  }): void;
  persistBestEffort(): Promise<unknown>;
  report(event: SetupEnvironmentEvent): void;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export type SetupEnvironmentResult =
  | { kind: "stopped" | "failed" }
  | {
      kind: "configured";
      operationId: string;
      environment: string;
      provider: string;
      repo: string;
      stateBackend: string;
      stateRegistry: string;
      stateArchive: string;
      verifyRunUrl: string;
      actionRequired: boolean;
      pullRequestUrl: string;
      pullRequestBranch: string | null;
      pullRequestBaseBranch: string | null;
      verifySkipped: boolean;
      verifySkipReason: SetupVerificationSkipReason | null;
    };
