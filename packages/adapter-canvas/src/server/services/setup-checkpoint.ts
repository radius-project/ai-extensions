import {
  saveSetupCheckpoint,
  saveSetupOperation,
  type SetupCheckpointOperation
} from "@radius-project/core";

interface SetupSaveInput {
  operation: SetupCheckpointOperation | null;
  persist(): Promise<void>;
  report?(diagnostic: { code: string; message: string }): void;
}

function reportSaveFailure(input: SetupSaveInput, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  input.report?.({
    code: "operation-store-write-failed",
    message: `Could not persist setup operation ${input.operation?.operationId || "unknown"}: ${detail}`
  });
}

export async function persistMutationCheckpoint(
  input: SetupSaveInput & {
    fail(status: number, error: string, code: string): Promise<void>;
  }
): Promise<boolean> {
  const result = await saveSetupCheckpoint(input);
  if (result.outcome === "persistence-failed") {
    reportSaveFailure(input, result.error);
    await input.fail(
      500,
      "Radius changed no further cloud resources because it could not save the setup recovery record.",
      "operation-persistence-failed"
    );
    return false;
  }
  if (result.outcome === "rollback-pending") {
    await input.fail(
      409,
      "Radius reconciled the interrupted provider request and must delete the setup resources before making any further provider changes.",
      "provider-rollback-pending"
    );
    return false;
  }
  return true;
}

export async function persistBestEffort(
  input: SetupSaveInput
): Promise<boolean> {
  const result = await saveSetupOperation(input.persist);
  if (result.outcome === "saved") return true;
  reportSaveFailure(input, result.error);
  return false;
}
