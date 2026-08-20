// Canvas adapter — durable credential-provenance store (issue #331).
//
// A tiny JSON-file persistence port for CredentialProvenanceRecord values,
// modeled on operation-store.ts: atomic temp-file write, 0600 permissions, and
// tolerant loads that degrade to "no provenance" rather than throwing. The store
// lives beside operations.json in the verified session directory so the
// provenance survives operation-record pruning and a process restart, both of
// which the in-operation ledger does not.

import { promises as fs } from "node:fs";
import path from "node:path";

export const PERSISTED_CREDENTIAL_PROVENANCE_VERSION = 1;

export interface PersistedCredentialProvenanceEnvelope {
  schemaVersion: typeof PERSISTED_CREDENTIAL_PROVENANCE_VERSION;
  credentials: unknown[];
}

export interface CredentialProvenanceStoreDiagnostic {
  code:
    | "credential-provenance-corrupt"
    | "credential-provenance-write-failed"
    | "credential-provenance-unavailable";
  message: string;
}

export type CredentialProvenanceStoreReporter = (
  diagnostic: CredentialProvenanceStoreDiagnostic
) => void;

export interface CredentialProvenanceStore {
  load(): Promise<PersistedCredentialProvenanceEnvelope | null>;
  save(envelope: PersistedCredentialProvenanceEnvelope): Promise<void>;
  report?: CredentialProvenanceStoreReporter;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseCredentialProvenanceEnvelope(
  value: unknown
): PersistedCredentialProvenanceEnvelope {
  if (
    !isRecord(value) ||
    value.schemaVersion !== PERSISTED_CREDENTIAL_PROVENANCE_VERSION ||
    !Array.isArray(value.credentials)
  ) {
    throw new Error(
      "Unsupported or invalid persisted credential-provenance schema."
    );
  }
  return {
    schemaVersion: PERSISTED_CREDENTIAL_PROVENANCE_VERSION,
    credentials: value.credentials
  };
}

export function createFileCredentialProvenanceStore({
  filePath,
  report = () => {}
}: {
  filePath: string;
  report?: CredentialProvenanceStoreReporter;
}): CredentialProvenanceStore {
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
          code: "credential-provenance-unavailable",
          message: `Could not read credential provenance: ${String(error)}`
        });
        return null;
      }
      try {
        return parseCredentialProvenanceEnvelope(JSON.parse(raw));
      } catch (error) {
        report({
          code: "credential-provenance-corrupt",
          message: `Ignored invalid credential provenance: ${String(error)}`
        });
        return null;
      }
    },

    async save(envelope) {
      const validated = parseCredentialProvenanceEnvelope(envelope);
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

export function disabledCredentialProvenanceStore(): CredentialProvenanceStore {
  return {
    async load() {
      return null;
    },
    async save() {}
  };
}
