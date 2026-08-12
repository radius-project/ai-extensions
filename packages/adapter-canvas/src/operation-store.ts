import { promises as fs } from "node:fs";
import path from "node:path";

export const PERSISTED_OPERATIONS_VERSION = 1;

export interface PersistedOperationsEnvelope {
  schemaVersion: typeof PERSISTED_OPERATIONS_VERSION;
  operations: unknown[];
}

export interface OperationStore {
  load(): Promise<PersistedOperationsEnvelope | null>;
  save(envelope: PersistedOperationsEnvelope): Promise<void>;
  report?(diagnostic: OperationStoreDiagnostic): void;
}

export interface OperationStoreDiagnostic {
  code:
    | "operation-store-corrupt"
    | "operation-store-invalid-record"
    | "operation-store-unavailable";
  message: string;
}

export type OperationStoreReporter = (
  diagnostic: OperationStoreDiagnostic
) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseOperationsEnvelope(
  value: unknown
): PersistedOperationsEnvelope {
  if (
    !isRecord(value) ||
    value.schemaVersion !== PERSISTED_OPERATIONS_VERSION ||
    !Array.isArray(value.operations)
  ) {
    throw new Error("Unsupported or invalid persisted operation schema.");
  }
  return {
    schemaVersion: PERSISTED_OPERATIONS_VERSION,
    operations: value.operations
  };
}

export function createFileOperationStore({
  filePath,
  report = () => {}
}: {
  filePath: string;
  report?: OperationStoreReporter;
}): OperationStore {
  return {
    report,
    async load() {
      let raw: string;
      try {
        raw = await fs.readFile(filePath, "utf8");
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return null;
        }
        report({
          code: "operation-store-unavailable",
          message: `Could not read persisted operations: ${String(error)}`
        });
        return null;
      }

      try {
        return parseOperationsEnvelope(JSON.parse(raw));
      } catch (error) {
        report({
          code: "operation-store-corrupt",
          message: `Ignored invalid persisted operations: ${String(error)}`
        });
        return null;
      }
    },

    async save(envelope) {
      const validated = parseOperationsEnvelope(envelope);
      const directory = path.dirname(filePath);
      const temporary = path.join(
        directory,
        `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
      );
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        await fs.writeFile(
          temporary,
          `${JSON.stringify(validated, null, 2)}\n`,
          { encoding: "utf8", mode: 0o600 }
        );
        await fs.rename(temporary, filePath);
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    }
  };
}

export function disabledOperationStore(): OperationStore {
  return {
    async load() {
      return null;
    },
    async save() {}
  };
}
