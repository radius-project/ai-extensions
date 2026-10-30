import {
  GitHubEnvironmentEnsureCancelled,
  GitHubEnvironmentEnsureError,
  type EnsuredGitHubEnvironment
} from "./setup-github-environment.js";
import { ProviderMutationRecoveryError } from "./setup-recovery-error.js";

export interface SetupCoordinatorTarget {
  operationId: string;
  repo: string;
  environment: string;
  provider: string;
}

export interface SetupCoordinatorOperation {
  state?: string;
  endedAt?: unknown;
  context?: Record<string, unknown>;
  request?: unknown;
  resumeRequest?: unknown;
}

export type SetupCoordinatorStageResult =
  | { kind: "completed" | "input-required"; clientId?: unknown }
  | { kind: "reconciling"; message?: unknown };

export type SetupCoordinatorAwsResult =
  | { kind: "completed"; roleArn: string; trustSubjects: readonly string[] }
  | { kind: "failed"; error: unknown }
  // A pause arrived during AWS setup, which recorded what it changed and ran
  // nothing after the pause.
  | { kind: "stopped" };

export type SetupCoordinatorFailure =
  | { kind: "repository-access" | "package-access" }
  | { kind: "environment-resolution" | "aws-authorization"; error: unknown };

export type SetupCoordinatorEvent =
  | { kind: "environment-owned" | "environment-resolved"; name: string }
  | { kind: "environment-unowned"; name: string; detail: string }
  | {
      kind: "environment-canonicalized";
      name: string;
      requestedName: string;
    };

export interface SetupCoordinatorPorts {
  operation(): SetupCoordinatorOperation;
  currentOperation(): SetupCoordinatorOperation | undefined;
  unresolved(): readonly { mutationId: string; kind: string }[];
  preflightRepository(): Promise<boolean>;
  preflightPackages(): Promise<boolean>;
  stopBoundary(boundary: string): Promise<boolean>;
  readEnsuredEnvironment(name: string): EnsuredGitHubEnvironment | null;
  ensureEnvironment(
    beforeCreate: () => Promise<boolean>
  ): Promise<EnsuredGitHubEnvironment>;
  setCanonicalEnvironment(name: string): void;
  recordEnvironment(patch: {
    state: string;
    origin: string;
    repo: string;
    name: string;
    providerId?: string | null;
  }): void;
  promoteCreatedEnvironment(identity: { repo: string; name: string }): boolean;
  report(event: SetupCoordinatorEvent): void;
  checkpoint(): Promise<boolean>;
  finalizeFailure(failure: SetupCoordinatorFailure): Promise<void>;
  reconcileFailure(mutationId: string, error: unknown): Promise<never>;
  authorizeAzure(
    request: Record<string, unknown> & {
      repo: string;
      environment: string;
      operationEnvironment: string;
      operationId: string;
    }
  ): Promise<SetupCoordinatorStageResult>;
  authorizeAws(
    request: Record<string, unknown> & {
      repo: string;
      environment: string;
      reused: boolean;
    }
  ): Promise<SetupCoordinatorAwsResult>;
  // Release the deploy identity lock `authorizeAws` took. Called once after
  // Configure environment, or as soon as setup stops early. Never throws.
  releaseAws(): Promise<void>;
  configureEnvironment(
    request: Record<string, unknown> &
      SetupCoordinatorTarget & {
        operationEnvironment: string;
        clientId: string;
      }
  ): Promise<SetupCoordinatorStageResult>;
  raiseReconciling(stage: "azure" | "environment", message: unknown): never;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value));
}

export async function runSetupCoordinator(
  target: SetupCoordinatorTarget,
  ports: SetupCoordinatorPorts
): Promise<{ shouldMonitor: boolean }> {
  const outstanding = ports.unresolved()[0] ?? null;
  if (!outstanding) {
    if (!(await ports.stopBoundary("before-github-environment"))) {
      return { shouldMonitor: false };
    }
    if (!(await ports.preflightRepository())) {
      if (!(await ports.stopBoundary("before-setup-failure-cleanup"))) {
        return { shouldMonitor: false };
      }
      await ports.finalizeFailure({ kind: "repository-access" });
      return { shouldMonitor: false };
    }
    if (!(await ports.preflightPackages())) {
      if (!(await ports.stopBoundary("before-setup-failure-cleanup"))) {
        return { shouldMonitor: false };
      }
      await ports.finalizeFailure({ kind: "package-access" });
      return { shouldMonitor: false };
    }
  }

  const context = ports.operation().context;
  const recordedName =
    typeof context?.canonicalEnvironment === "string" ?
      context.canonicalEnvironment
    : target.environment;
  let ensured = outstanding ? ports.readEnsuredEnvironment(recordedName) : null;
  if (!ensured) {
    try {
      ensured = await ports.ensureEnvironment(() =>
        ports.stopBoundary("before-github-environment-create")
      );
    } catch (error) {
      if (error instanceof GitHubEnvironmentEnsureCancelled) {
        return { shouldMonitor: false };
      }
      if (error instanceof ProviderMutationRecoveryError) throw error;
      if (
        error instanceof GitHubEnvironmentEnsureError &&
        error.createdCandidate
      ) {
        ports.recordEnvironment({
          state: "created_candidate",
          origin: "unknown",
          repo: error.createdCandidate.repo,
          name: error.createdCandidate.name
        });
      }
      if (!(await ports.stopBoundary("after-github-environment-attempt"))) {
        return { shouldMonitor: false };
      }
      await ports.finalizeFailure({ kind: "environment-resolution", error });
      return { shouldMonitor: false };
    }
  }
  ports.setCanonicalEnvironment(ensured.name);
  ports.recordEnvironment({
    state: ensured.state,
    origin: ensured.state === "reused" ? "pre_existing" : "unknown",
    repo: target.repo,
    name: ensured.name,
    providerId: ensured.providerId
  });
  if (
    ensured.creationProof?.proven &&
    ports.promoteCreatedEnvironment({ repo: target.repo, name: ensured.name })
  ) {
    ports.report({ kind: "environment-owned", name: ensured.name });
  } else if (
    ensured.state === "created_candidate" &&
    ensured.creationProof &&
    !ensured.creationProof.proven
  ) {
    ports.report({
      kind: "environment-unowned",
      name: ensured.name,
      detail: ensured.creationProof.detail
    });
  }
  ports.report(
    target.environment === ensured.name ?
      { kind: "environment-resolved", name: ensured.name }
    : {
        kind: "environment-canonicalized",
        name: ensured.name,
        requestedName: target.environment
      }
  );
  if (!(await ports.checkpoint())) return { shouldMonitor: false };
  if (!(await ports.stopBoundary("after-github-environment"))) {
    return { shouldMonitor: false };
  }

  const operation = ports.operation();
  const request = record(
    operation.request === undefined ?
      operation.resumeRequest
    : operation.request
  );
  const invoke = async (
    action: () => Promise<SetupCoordinatorStageResult>
  ): Promise<SetupCoordinatorStageResult> => {
    try {
      return await action();
    } catch (error) {
      if (
        outstanding &&
        ports
          .unresolved()
          .some((mutation) => mutation.mutationId === outstanding.mutationId)
      ) {
        return ports.reconcileFailure(outstanding.mutationId, error);
      }
      throw error;
    }
  };
  let setupResult: SetupCoordinatorStageResult | null = null;
  if (
    target.provider === "azure" &&
    request.needsAzureCredentials &&
    (!outstanding || outstanding.kind.startsWith("azure_"))
  ) {
    setupResult = await invoke(() =>
      ports.authorizeAzure({
        ...record(request.azure),
        repo: target.repo,
        environment: ensured.name,
        operationEnvironment: target.environment,
        operationId: target.operationId
      })
    );
    if (setupResult.kind === "reconciling") {
      ports.raiseReconciling("azure", setupResult.message);
    }
    if (
      setupResult.kind === "input-required" ||
      ports.operation().state === "input_required"
    ) {
      return { shouldMonitor: false };
    }
  }
  const current = ports.currentOperation();
  if (!current || current.state === "input_required" || current.endedAt) {
    return { shouldMonitor: false };
  }
  const environmentRequest = record(request.environment);
  let awsRoleArn = "";
  let awsTrustSubjects: readonly string[] = [];
  // AWS setup takes the deploy identity lock and keeps it until Configure
  // environment has written the GitHub environment. Until then a delete that
  // checks which environments use a cluster could not see this one, and could
  // remove the cluster access this setup just granted.
  const awsLocked = target.provider === "aws" && !outstanding;
  try {
    if (awsLocked) {
      const aws = await ports.authorizeAws({
        ...environmentRequest,
        repo: target.repo,
        environment: ensured.name,
        reused: ensured.state === "reused"
      });
      if (aws.kind === "stopped") {
        // The pause is still requested, so this boundary stops the operation.
        // Should it not, finish as a failure rather than configure the
        // environment without a deploy identity.
        if (await ports.stopBoundary("after-aws-deploy-identity")) {
          await ports.finalizeFailure({
            kind: "aws-authorization",
            error: {
              status: 409,
              message:
                "AWS setup stopped for a pause before the deploy identity was ready.",
              code: "aws-setup-interrupted"
            }
          });
        }
        return { shouldMonitor: false };
      }
      if (aws.kind === "failed") {
        if (!(await ports.stopBoundary("before-setup-failure-cleanup"))) {
          return { shouldMonitor: false };
        }
        await ports.finalizeFailure({
          kind: "aws-authorization",
          error: aws.error
        });
        return { shouldMonitor: false };
      }
      awsRoleArn = aws.roleArn;
      awsTrustSubjects = aws.trustSubjects;
    }
    const clientId =
      setupResult && "clientId" in setupResult ?
        setupResult.clientId
      : undefined;
    const liveContext = ports.operation().context;
    if (!awsRoleArn && typeof liveContext?.awsRoleArn === "string") {
      awsRoleArn = liveContext.awsRoleArn;
    }
    if (
      awsTrustSubjects.length === 0 &&
      Array.isArray(liveContext?.awsTrustSubjects)
    ) {
      awsTrustSubjects = liveContext.awsTrustSubjects.filter(
        (subject): subject is string => typeof subject === "string"
      );
    }
    const environmentResult = await invoke(() =>
      ports.configureEnvironment({
        ...environmentRequest,
        repo: target.repo,
        environment: ensured.name,
        operationEnvironment: target.environment,
        provider: target.provider,
        operationId: target.operationId,
        ...(awsRoleArn ? { roleArn: awsRoleArn } : {}),
        ...(awsTrustSubjects.length > 0 ?
          { trustSubjects: awsTrustSubjects }
        : {}),
        clientId:
          (typeof clientId === "string" && clientId) ||
          (typeof liveContext?.clientId === "string" && liveContext.clientId) ||
          (typeof environmentRequest.clientId === "string" &&
            environmentRequest.clientId) ||
          ""
      })
    );
    if (environmentResult.kind === "reconciling") {
      ports.raiseReconciling("environment", environmentResult.message);
    }
    return { shouldMonitor: true };
  } finally {
    if (awsLocked) await ports.releaseAws();
  }
}
