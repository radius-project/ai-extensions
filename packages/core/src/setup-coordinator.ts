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

export type SetupCoordinatorFailure =
  | { kind: "repository-access" | "package-access" }
  | { kind: "environment-resolution"; error: unknown };

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
  const clientId =
    setupResult && "clientId" in setupResult ? setupResult.clientId : undefined;
  const liveContext = ports.operation().context;
  const environmentResult = await invoke(() =>
    ports.configureEnvironment({
      ...environmentRequest,
      repo: target.repo,
      environment: ensured.name,
      operationEnvironment: target.environment,
      provider: target.provider,
      operationId: target.operationId,
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
}
