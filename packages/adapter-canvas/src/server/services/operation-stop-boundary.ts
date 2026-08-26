import {
  announceOperationTerminal,
  shouldStop,
  stopAtBoundary,
  unresolvedProviderMutations
} from "../../operations.js";

export interface StopBoundaryDiagnostic {
  code: string;
  message: string;
}

export interface StopBoundaryOperation {
  operationId?: string;
}

export interface StopBoundaryInput {
  operation: StopBoundaryOperation | null;
  boundary: string;
  persist(): Promise<void>;
  report?(diagnostic: StopBoundaryDiagnostic): void;
  beforePersist?(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Honor a persisted Stop without assuming who owns the current response.
 *
 * Callers invoke this only between external mutations. A false result means the
 * operation is terminal and the caller must not start another mutation.
 */
export async function honorStopBoundary({
  operation,
  boundary,
  persist,
  report,
  beforePersist
}: StopBoundaryInput): Promise<boolean> {
  if (!shouldStop(operation)) return true;
  // A Stop may not strand a mutation whose provider outcome is still unknown.
  // Reconciliation is read-only and must finish (or hand the ambiguity to the
  // customer) before cancellation can become terminal.
  if (unresolvedProviderMutations(operation).length > 0) return true;

  beforePersist?.();
  stopAtBoundary(operation, boundary, { announce: false });
  try {
    await persist();
    announceOperationTerminal(operation);
  } catch (error) {
    report?.({
      code: "operation-store-write-failed",
      message: `Could not persist setup operation ${
        operation?.operationId || "unknown"
      }: ${errorMessage(error)}`
    });
  }
  return false;
}
