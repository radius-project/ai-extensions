import {
  announceOperationTerminal,
  shouldStop,
  stopAtBoundary,
  unresolvedProviderMutations
} from "../../operations.js";
import { honorSetupStop } from "@radius-project/core";

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
  return honorSetupStop(boundary, {
    isStopRequested: () => shouldStop(operation),
    hasUnsettledMutation: () =>
      unresolvedProviderMutations(operation).length > 0,
    beforePersist,
    transitionToStopped: (at) =>
      stopAtBoundary(operation, at, { announce: false }),
    persist,
    publishStopped: () => announceOperationTerminal(operation),
    reportPersistenceFailure: (error) => {
      report?.({
        code: "operation-store-write-failed",
        message: `Could not persist setup operation ${
          operation?.operationId || "unknown"
        }: ${errorMessage(error)}`
      });
    }
  });
}
