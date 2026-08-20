import type { OidcSubjectConfig } from "@radius-project/core";
import type { AzureFederatedCredential } from "./azure-oidc.js";
import type { CredentialProvenanceStore } from "./credential-provenance-store.js";

export const CREDENTIAL_PROVENANCE_SCHEMA_VERSION = 2;
export const GITHUB_ACTIONS_OIDC_ISSUER =
  "https://token.actions.githubusercontent.com";
export const AZURE_AD_TOKEN_EXCHANGE_AUDIENCE = "api://AzureADTokenExchange";

export type CredentialOrigin = "created" | "reused";

export interface CredentialProvenanceRecord {
  schemaVersion: typeof CREDENTIAL_PROVENANCE_SCHEMA_VERSION;
  repo: string;
  repoId: number;
  environment: string;
  tenantId: string;
  clientId: string;
  applicationObjectId: string;
  credentialId: string;
  name: string;
  subject: string;
  issuer: string;
  audiences: string[];
  subjectConfig: OidcSubjectConfig;
  origin: CredentialOrigin;
  operationId: string;
  recordedAt: string;
}

export interface RecordCredentialProvenanceInput extends Omit<
  CredentialProvenanceRecord,
  "schemaVersion" | "recordedAt"
> {
  recordedAt?: string;
}

export interface CredentialReclamationContext {
  tenantId: string;
  clientId: string;
  applicationObjectId: string;
  repoId: number;
  environment: string;
}

export type CredentialRetentionReason =
  | "reused"
  | "shared-consumer"
  | "shared-custom-subject"
  | "no-provenance"
  | "evidence-changed";

export interface CredentialReclamationTarget {
  credential: AzureFederatedCredential;
  record: CredentialProvenanceRecord;
}

export interface CredentialRetentionEntry {
  credential: AzureFederatedCredential;
  reason: CredentialRetentionReason;
}

export interface CredentialReclamationPlan {
  delete: CredentialReclamationTarget[];
  retain: CredentialRetentionEntry[];
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function stringArray(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    return null;
  }
  return value;
}

function subjectConfig(value: unknown): OidcSubjectConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.useDefault !== "boolean") return null;
  const config: OidcSubjectConfig = { useDefault: record.useDefault };
  if (record.includeClaimKeys !== undefined) {
    const keys = stringArray(record.includeClaimKeys);
    if (!keys) return null;
    config.includeClaimKeys = keys;
  }
  if (typeof record.useImmutableSubject === "boolean") {
    config.useImmutableSubject = record.useImmutableSubject;
  }
  if (typeof record.subClaimPrefix === "string" && record.subClaimPrefix) {
    config.subClaimPrefix = record.subClaimPrefix;
  }
  return config;
}

export function sanitizeCredentialProvenanceRecord(
  value: unknown
): CredentialProvenanceRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== CREDENTIAL_PROVENANCE_SCHEMA_VERSION)
    return null;
  const requiredStrings = [
    "repo",
    "environment",
    "tenantId",
    "clientId",
    "applicationObjectId",
    "credentialId",
    "name",
    "subject",
    "issuer",
    "operationId",
    "recordedAt"
  ] as const;
  if (
    requiredStrings.some(
      (key) => typeof record[key] !== "string" || !record[key]
    ) ||
    typeof record.repoId !== "number" ||
    !Number.isFinite(record.repoId) ||
    record.repoId <= 0 ||
    (record.origin !== "created" && record.origin !== "reused")
  ) {
    return null;
  }
  const audiences = stringArray(record.audiences);
  const config = subjectConfig(record.subjectConfig);
  if (!audiences?.length || !config) return null;
  return {
    schemaVersion: CREDENTIAL_PROVENANCE_SCHEMA_VERSION,
    repo: record.repo as string,
    repoId: record.repoId,
    environment: record.environment as string,
    tenantId: record.tenantId as string,
    clientId: record.clientId as string,
    applicationObjectId: record.applicationObjectId as string,
    credentialId: record.credentialId as string,
    name: record.name as string,
    subject: record.subject as string,
    issuer: record.issuer as string,
    audiences: [...audiences],
    subjectConfig: { ...config },
    origin: record.origin,
    operationId: record.operationId as string,
    recordedAt: record.recordedAt as string
  };
}

function requireCredentialProvenanceRecord(
  value: unknown
): CredentialProvenanceRecord {
  const record = sanitizeCredentialProvenanceRecord(value);
  if (!record) {
    throw new Error(
      "Credential provenance is incomplete because a stored record is invalid."
    );
  }
  return record;
}

function requireCredentialProvenanceRecords(
  values: unknown[]
): CredentialProvenanceRecord[] {
  return values.map(requireCredentialProvenanceRecord);
}

function buildRecord(
  input: RecordCredentialProvenanceInput
): CredentialProvenanceRecord | null {
  return sanitizeCredentialProvenanceRecord({
    ...input,
    schemaVersion: CREDENTIAL_PROVENANCE_SCHEMA_VERSION,
    recordedAt: input.recordedAt || new Date().toISOString()
  });
}

function sameConsumerCredential(
  a: CredentialProvenanceRecord,
  b: CredentialProvenanceRecord
): boolean {
  return recordKey(a) === recordKey(b);
}

function sameConsumer(
  a: CredentialProvenanceRecord,
  b: CredentialProvenanceRecord
): boolean {
  return (
    normalized(a.tenantId) === normalized(b.tenantId) &&
    normalized(a.clientId) === normalized(b.clientId) &&
    a.applicationObjectId === b.applicationObjectId &&
    a.credentialId === b.credentialId &&
    a.repoId === b.repoId &&
    a.environment === b.environment
  );
}

function recordKey(record: CredentialProvenanceRecord): string {
  return JSON.stringify([
    normalized(record.tenantId),
    normalized(record.clientId),
    record.applicationObjectId,
    record.credentialId,
    record.repoId,
    record.environment,
    record.origin
  ]);
}

function sameCredential(
  record: CredentialProvenanceRecord,
  context: CredentialReclamationContext,
  credential: AzureFederatedCredential
): boolean {
  return (
    normalized(record.tenantId) === normalized(context.tenantId) &&
    normalized(record.clientId) === normalized(context.clientId) &&
    record.applicationObjectId === context.applicationObjectId &&
    record.credentialId === credential.id
  );
}

function isTargetConsumer(
  record: CredentialProvenanceRecord,
  context: CredentialReclamationContext
): boolean {
  return (
    record.repoId === context.repoId &&
    record.environment === context.environment
  );
}

function equalAudiences(a: readonly string[], b: readonly string[]): boolean {
  return (
    a.length === b.length &&
    [...a].sort().every((entry, index) => entry === [...b].sort()[index])
  );
}

function provesExclusiveSubject(config: OidcSubjectConfig): boolean {
  if (config.useDefault) return true;
  const keys = config.includeClaimKeys ?? [];
  const environmentScoped =
    keys.includes("environment") || keys.includes("context");
  const stableRepositoryScoped =
    keys.includes("repository_id") ||
    (config.useImmutableSubject === true &&
      (keys.includes("repository") || keys.includes("repo")));
  return environmentScoped && stableRepositoryScoped;
}

export function planCredentialReclamation(
  candidates: readonly AzureFederatedCredential[],
  records: readonly CredentialProvenanceRecord[],
  context: CredentialReclamationContext
): CredentialReclamationPlan {
  const plan: CredentialReclamationPlan = { delete: [], retain: [] };
  for (const credential of candidates) {
    const matches = records.filter((record) =>
      sameCredential(record, context, credential)
    );
    const targetRecords = matches.filter((record) =>
      isTargetConsumer(record, context)
    );
    const created = targetRecords.find((record) => record.origin === "created");
    if (!created) {
      plan.retain.push({
        credential,
        reason:
          targetRecords.some((record) => record.origin === "reused") ? "reused"
          : "no-provenance"
      });
      continue;
    }
    if (matches.some((record) => !isTargetConsumer(record, context))) {
      plan.retain.push({ credential, reason: "shared-consumer" });
      continue;
    }
    if (!provesExclusiveSubject(created.subjectConfig)) {
      plan.retain.push({ credential, reason: "shared-custom-subject" });
      continue;
    }
    if (
      created.name !== credential.name ||
      created.subject !== credential.subject ||
      created.issuer !== credential.issuer ||
      !equalAudiences(created.audiences, credential.audiences)
    ) {
      plan.retain.push({ credential, reason: "evidence-changed" });
      continue;
    }
    plan.delete.push({ credential, record: created });
  }
  return plan;
}

interface CredentialProvenanceRegistry {
  configure(store: CredentialProvenanceStore | null): Promise<void>;
  record(
    input: RecordCredentialProvenanceInput
  ): Promise<CredentialProvenanceRecord | null>;
  listForClient(clientId: string): Promise<CredentialProvenanceRecord[]>;
  listForEnvironment(
    repoId: number,
    environment: string
  ): Promise<CredentialProvenanceRecord[]>;
  removeCredential(clientId: string, credentialId: string): Promise<void>;
  clearEnvironment(repoId: number, environment: string): Promise<void>;
  withLock<T>(work: () => Promise<T>): Promise<T>;
  all(): CredentialProvenanceRecord[];
}

function createRegistry(): CredentialProvenanceRegistry {
  let entries: CredentialProvenanceRecord[] = [];
  let store: CredentialProvenanceStore | null = null;
  let pending: Promise<void> = Promise.resolve();

  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = pending.then(work, work);
    pending = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  return {
    async configure(next) {
      await pending;
      store = next;
      entries = [];
      if (!store) return;
      entries = requireCredentialProvenanceRecords(await store.load());
    },
    async record(input) {
      const candidate = buildRecord(input);
      if (!candidate) return null;
      return serialize(async () => {
        if (store) {
          entries = requireCredentialProvenanceRecords(await store.load());
        }
        const key = recordKey(candidate);
        const createdConsumer = entries.find(
          (entry) =>
            entry.origin === "created" && sameConsumer(entry, candidate)
        );
        if (candidate.origin === "reused" && createdConsumer) {
          return { ...createdConsumer };
        }
        const next = candidate;
        if (store) await store.write(key, next);
        const index = entries.findIndex((entry) =>
          sameConsumerCredential(entry, next)
        );
        if (index >= 0) entries[index] = next;
        else entries.push(next);
        return { ...next };
      });
    },
    async listForClient(clientId) {
      return serialize(async () => {
        if (store) {
          entries = requireCredentialProvenanceRecords(await store.load());
        }
        const normalizedClientId = normalized(clientId);
        return entries
          .filter((entry) => normalized(entry.clientId) === normalizedClientId)
          .map((entry) => ({ ...entry }));
      });
    },
    async listForEnvironment(repoId, environment) {
      return serialize(async () => {
        if (store) {
          entries = requireCredentialProvenanceRecords(await store.load());
        }
        return entries
          .filter(
            (entry) =>
              entry.repoId === repoId && entry.environment === environment
          )
          .map((entry) => ({ ...entry }));
      });
    },
    async removeCredential(clientId, credentialId) {
      await serialize(async () => {
        const matches = entries.filter(
          (entry) =>
            normalized(entry.clientId) === normalized(clientId) &&
            entry.credentialId === credentialId
        );
        if (store) await store.remove(matches.map(recordKey));
        entries = entries.filter((entry) => !matches.includes(entry));
      });
    },
    async clearEnvironment(repoId, environment) {
      await serialize(async () => {
        const matches = entries.filter(
          (entry) =>
            entry.repoId === repoId && entry.environment === environment
        );
        if (store) await store.remove(matches.map(recordKey));
        entries = entries.filter((entry) => !matches.includes(entry));
      });
    },
    async withLock<T>(work: () => Promise<T>): Promise<T> {
      if (!store) {
        throw new Error("Durable credential provenance is unavailable.");
      }
      return store.withLock(work);
    },
    all() {
      return entries.map((entry) => ({ ...entry }));
    }
  };
}

let registry = createRegistry();

export async function configureCredentialProvenanceStore(
  store: CredentialProvenanceStore | null
): Promise<void> {
  await registry.configure(store);
}

export async function recordCredentialProvenance(
  input: RecordCredentialProvenanceInput
): Promise<CredentialProvenanceRecord | null> {
  return registry.record(input);
}

export function listCredentialProvenanceForClient(
  clientId: string
): Promise<CredentialProvenanceRecord[]> {
  return registry.listForClient(clientId);
}

export function listCredentialProvenanceForEnvironment(
  repoId: number,
  environment: string
): Promise<CredentialProvenanceRecord[]> {
  return registry.listForEnvironment(repoId, environment);
}

export async function removeCredentialProvenance(
  clientId: string,
  credentialId: string
): Promise<void> {
  await registry.removeCredential(clientId, credentialId);
}

export async function clearEnvironmentCredentialProvenance(
  repoId: number,
  environment: string
): Promise<void> {
  await registry.clearEnvironment(repoId, environment);
}

export function withCredentialProvenanceLock<T>(
  work: () => Promise<T>
): Promise<T> {
  return registry.withLock(work);
}

export function allCredentialProvenance(): CredentialProvenanceRecord[] {
  return registry.all();
}

export function resetCredentialProvenanceForTest(): void {
  registry = createRegistry();
}
