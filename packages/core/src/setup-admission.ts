export interface SetupOperationSnapshot {
  operationId: string;
  repo?: string;
  environment?: string;
  provider?: string;
  currentStage?: string;
  state?: unknown;
  inputRequired?: unknown;
}

export interface SetupAdmissionInput {
  repo?: string;
  environment?: string;
  provider?: string;
  operationId?: unknown;
  operationEnvironment?: string;
  origin?: string | null;
  resumeTarget?: string | null;
  resumeBranch?: string | null;
  branch?: string | null;
  resumeReason?: string | null;
}

export interface SetupTarget {
  repo: string;
  environment: string;
  provider: string;
}

export type SetupStartResult =
  | { ok: true }
  | {
      ok: false;
      reason?: "operation-in-progress" | "previous-cleanup-required";
      conflict: { operationId: string };
    };

export type SetupNamespaceIssue =
  | { code: "namespace-claims-unavailable"; detail: string }
  | {
      code: "namespace-already-claimed";
      namespace: string;
      cluster: string;
      environment: string;
    };

export type SetupAdmissionIssue =
  | { code: "target-missing" }
  | { code: "invalid-repo" }
  | { code: "operation-continuation-mismatch"; operationId: string }
  | {
      code: "operation-start-conflict";
      conflict: Extract<SetupStartResult, { ok: false }>;
    }
  | { code: "operation-persistence-failed"; operationId: string }
  | SetupNamespaceIssue;

export interface SetupAdmissionPorts<Operation extends SetupOperationSnapshot> {
  isValidRepo(repo: string): boolean;
  getOperation(operationId: string): Operation | null;
  isStale(operation: Operation): boolean;
  isTerminal(state: unknown): boolean;
  continuationStages: readonly [string, string];
  createOperation(
    input: SetupTarget & {
      journey: {
        origin: string | null;
        resumeTarget: string | null;
        resumeBranch: string | null;
        resumeReason: string | null;
      };
    }
  ): Operation;
  startOperation(operation: Operation): SetupStartResult;
  persist(): Promise<void>;
  recordPersistenceFailure(operation: Operation, error: unknown): void;
  checkNamespace(
    operation: Operation,
    target: SetupTarget
  ): Promise<SetupNamespaceIssue | null>;
  enterConfiguration(operation: Operation): void;
}

export type SetupAdmissionResult<Operation extends SetupOperationSnapshot> =
  | { outcome: "admitted"; operation: Operation; target: SetupTarget }
  | {
      outcome: "refused";
      operation: Operation | null;
      target: SetupTarget;
      issue: SetupAdmissionIssue;
    };

export async function admitSetupOperation<
  Operation extends SetupOperationSnapshot
>(
  input: SetupAdmissionInput,
  ports: SetupAdmissionPorts<Operation>
): Promise<SetupAdmissionResult<Operation>> {
  const target = {
    repo: input.repo || "",
    environment: input.environment || "dev",
    provider: input.provider || "azure"
  };
  const refuse = (
    issue: SetupAdmissionIssue,
    operation: Operation | null = null
  ): SetupAdmissionResult<Operation> => ({
    outcome: "refused",
    operation,
    target,
    issue
  });
  if (!target.repo) return refuse({ code: "target-missing" });
  if (!ports.isValidRepo(target.repo)) return refuse({ code: "invalid-repo" });

  const continuationId =
    typeof input.operationId === "string" ? input.operationId : "";
  let operation: Operation;
  if (continuationId) {
    const existing = ports.getOperation(continuationId);
    const operationEnvironment =
      typeof input.operationEnvironment === "string" ?
        input.operationEnvironment
      : target.environment;
    if (
      !existing ||
      ports.isStale(existing) ||
      ports.isTerminal(existing.state) ||
      existing.repo !== target.repo ||
      existing.environment !== operationEnvironment ||
      existing.provider !== target.provider ||
      (existing.currentStage !== ports.continuationStages[0] &&
        existing.currentStage !== ports.continuationStages[1]) ||
      existing.inputRequired
    ) {
      return refuse({
        code: "operation-continuation-mismatch",
        operationId: continuationId
      });
    }
    operation = existing;
  } else {
    operation = ports.createOperation({
      ...target,
      journey: {
        origin: input.origin || null,
        resumeTarget: input.resumeTarget || null,
        resumeBranch: input.resumeBranch || input.branch || null,
        resumeReason: input.resumeReason || null
      }
    });
    const started = ports.startOperation(operation);
    if (!started.ok)
      return refuse({ code: "operation-start-conflict", conflict: started });
    try {
      await ports.persist();
    } catch (error) {
      ports.recordPersistenceFailure(operation, error);
      return refuse(
        {
          code: "operation-persistence-failed",
          operationId: operation.operationId
        },
        operation
      );
    }
  }

  const namespaceIssue = await ports.checkNamespace(operation, target);
  if (namespaceIssue)
    return refuse(namespaceIssue, continuationId ? null : operation);
  ports.enterConfiguration(operation);
  return { outcome: "admitted", operation, target };
}
