// Canvas adapter — durable federated-credential provenance (issue #331).
//
// When Radius sets up an environment it creates Azure Entra federated identity
// credentials (FICs) on an app registration. When that environment is later
// deleted, Radius must remove the credentials it created — but ONLY those. A
// setup run can reuse a pre-existing credential (matched by subject) that a user
// or another tool created, so a live credential whose name/subject merely
// matches what Radius would mint does NOT prove Radius created it. Deleting on
// that heuristic can strip a shared or user-owned credential.
//
// This module records, at create time, durable proof of the credentials Radius
// actually created, keyed by repository + environment so the record survives
// operation-record pruning and a process restart (the operation ledger does
// not). At delete time the reclamation plan removes only credentials whose exact
// live identity matches a "created" provenance record, and retains everything
// else with manual-cleanup guidance. The store is therefore fail-safe: a missing
// or drifted record makes Radius under-delete (retain + warn), never over-delete.
//
// The record schema and the planning function are pure. Durable persistence is
// injected through a small store port (see credential-provenance-store.ts) so
// the module has no direct filesystem dependency and the registry can be
// disabled when no verified session directory is available.

import type { AzureFederatedCredential } from "./azure-oidc.js";
import type {
  CredentialProvenanceStore,
  CredentialProvenanceStoreReporter
} from "./credential-provenance-store.js";

export const CREDENTIAL_PROVENANCE_SCHEMA_VERSION = 1;

// The issuer and audience Radius always writes when creating a GitHub Actions
// federated credential. Stored on each record so a future issuer/audience change
// does not silently reclassify an old credential as "still ours".
export const GITHUB_ACTIONS_OIDC_ISSUER =
  "https://token.actions.githubusercontent.com";
export const AZURE_AD_TOKEN_EXCHANGE_AUDIENCE = "api://AzureADTokenExchange";

// How a credential came to exist during a Radius setup run. Only "created"
// credentials are eligible for automatic reclamation on delete; "reused" records
// a pre-existing credential Radius adopted and must never delete.
export type CredentialOrigin = "created" | "reused";

export interface CredentialProvenanceRecord {
  schemaVersion: typeof CREDENTIAL_PROVENANCE_SCHEMA_VERSION;
  repo: string;
  environment: string;
  clientId: string;
  name: string;
  subject: string;
  issuer: string;
  audiences: string[];
  origin: CredentialOrigin;
  recordedAt: string;
  repoId?: number;
  operationId?: string;
}

export interface RecordCredentialProvenanceInput {
  repo: string;
  environment: string;
  clientId: string;
  name: string;
  subject: string;
  origin: CredentialOrigin;
  issuer?: string;
  audiences?: string[];
  repoId?: number;
  operationId?: string;
  recordedAt?: string;
}

// Why a live credential that matched the environment was NOT auto-deleted.
export type CredentialRetentionReason =
  "reused" | "no-provenance" | "evidence-changed";

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

function normalizeRepo(repo: unknown): string {
  return typeof repo === "string" ? repo.trim().toLowerCase() : "";
}

function normalizeClientId(clientId: unknown): string {
  return typeof clientId === "string" ? clientId.trim().toLowerCase() : "";
}

/**
 * Validate one untrusted persisted value into a provenance record, or null when
 * it is not a usable record. Applied to every entry loaded from disk so a
 * corrupt or partially written store degrades to "no provenance" (fail-safe
 * retain) rather than throwing or, worse, yielding a malformed record that could
 * mis-authorize a delete.
 */
export function sanitizeCredentialProvenanceRecord(
  value: unknown
): CredentialProvenanceRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== CREDENTIAL_PROVENANCE_SCHEMA_VERSION)
    return null;
  const repo = typeof record.repo === "string" ? record.repo : "";
  const environment =
    typeof record.environment === "string" ? record.environment : "";
  const clientId = typeof record.clientId === "string" ? record.clientId : "";
  const name = typeof record.name === "string" ? record.name : "";
  const subject = typeof record.subject === "string" ? record.subject : "";
  const origin = record.origin === "reused" ? "reused" : "created";
  if (record.origin !== "reused" && record.origin !== "created") return null;
  if (!repo || !environment || !clientId || !name || !subject) return null;
  const audiences =
    Array.isArray(record.audiences) ?
      record.audiences.filter((a): a is string => typeof a === "string")
    : [];
  const out: CredentialProvenanceRecord = {
    schemaVersion: CREDENTIAL_PROVENANCE_SCHEMA_VERSION,
    repo,
    environment,
    clientId,
    name,
    subject,
    issuer:
      typeof record.issuer === "string" && record.issuer ?
        record.issuer
      : GITHUB_ACTIONS_OIDC_ISSUER,
    audiences:
      audiences.length > 0 ? audiences : [AZURE_AD_TOKEN_EXCHANGE_AUDIENCE],
    origin,
    recordedAt:
      typeof record.recordedAt === "string" && record.recordedAt ?
        record.recordedAt
      : new Date(0).toISOString()
  };
  if (typeof record.repoId === "number" && Number.isFinite(record.repoId)) {
    out.repoId = record.repoId;
  }
  if (typeof record.operationId === "string" && record.operationId) {
    out.operationId = record.operationId;
  }
  return out;
}

function buildRecord(
  input: RecordCredentialProvenanceInput
): CredentialProvenanceRecord | null {
  const repo = typeof input.repo === "string" ? input.repo.trim() : "";
  const environment =
    typeof input.environment === "string" ? input.environment.trim() : "";
  const clientId =
    typeof input.clientId === "string" ? input.clientId.trim() : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const subject = typeof input.subject === "string" ? input.subject : "";
  if (!repo || !environment || !clientId || !name || !subject) return null;
  const record: CredentialProvenanceRecord = {
    schemaVersion: CREDENTIAL_PROVENANCE_SCHEMA_VERSION,
    repo,
    environment,
    clientId,
    name,
    subject,
    issuer: input.issuer || GITHUB_ACTIONS_OIDC_ISSUER,
    audiences:
      Array.isArray(input.audiences) && input.audiences.length > 0 ?
        [...input.audiences]
      : [AZURE_AD_TOKEN_EXCHANGE_AUDIENCE],
    origin: input.origin === "reused" ? "reused" : "created",
    recordedAt: input.recordedAt || new Date().toISOString()
  };
  if (typeof input.repoId === "number" && Number.isFinite(input.repoId)) {
    record.repoId = input.repoId;
  }
  if (typeof input.operationId === "string" && input.operationId) {
    record.operationId = input.operationId;
  }
  return record;
}

// Two records describe the same credential when they share app registration
// (client id, case-insensitive) and credential name. Name is unique per app
// registration, so it is the stable per-credential identity.
function sameCredentialIdentity(
  a: CredentialProvenanceRecord,
  b: CredentialProvenanceRecord
): boolean {
  return (
    normalizeClientId(a.clientId) === normalizeClientId(b.clientId) &&
    a.name === b.name
  );
}

function belongsToEnvironment(
  record: CredentialProvenanceRecord,
  repo: string,
  environment: string
): boolean {
  return (
    normalizeRepo(record.repo) === normalizeRepo(repo) &&
    record.environment === environment
  );
}

/**
 * Decide which live federated credentials may be auto-deleted for an
 * environment and which must be retained, given the durable provenance records.
 *
 * `candidates` are the live credentials already scoped to this environment by
 * the name/subject heuristic (see selectEnvironmentFederatedCredentials); this
 * function is the provenance gate that decides, per candidate:
 *
 * - delete — a "created" record matches the candidate's exact live identity
 *   (same client id + name + subject). Radius created it and it is unchanged.
 * - retain "reused" — a "reused" record matches: Radius adopted a pre-existing
 *   credential, so it is not ours to delete.
 * - retain "evidence-changed" — a "created" record matches by name but the live
 *   subject differs from what Radius recorded: the credential drifted, so a
 *   human should decide.
 * - retain "no-provenance" — no record matches at all: Radius cannot prove it
 *   created this credential, so it is left in place.
 *
 * A "reused" record wins over a "created" one for the same identity so the plan
 * always errs toward retain.
 */
export function planCredentialReclamation(
  candidates: readonly AzureFederatedCredential[],
  records: readonly CredentialProvenanceRecord[],
  clientId: string
): CredentialReclamationPlan {
  const plan: CredentialReclamationPlan = { delete: [], retain: [] };
  const normalizedClient = normalizeClientId(clientId);
  for (const credential of candidates) {
    const matches = records.filter(
      (record) =>
        normalizeClientId(record.clientId) === normalizedClient &&
        record.name === credential.name
    );
    const reused = matches.find((record) => record.origin === "reused");
    if (reused) {
      plan.retain.push({ credential, reason: "reused" });
      continue;
    }
    const created = matches.find((record) => record.origin === "created");
    if (!created) {
      plan.retain.push({ credential, reason: "no-provenance" });
      continue;
    }
    if (created.subject !== credential.subject) {
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
  ): CredentialProvenanceRecord | null;
  list(repo: string, environment: string): CredentialProvenanceRecord[];
  clear(repo: string, environment: string): Promise<void>;
  all(): CredentialProvenanceRecord[];
  persist(): Promise<void>;
}

function createRegistry(): CredentialProvenanceRegistry {
  let entries: CredentialProvenanceRecord[] = [];
  let store: CredentialProvenanceStore | null = null;
  let report: CredentialProvenanceStoreReporter = () => {};
  // Serializes background saves so a burst of records cannot interleave writes;
  // failures are reported, not thrown, because losing a provenance record only
  // makes delete under-reclaim (retain + warn), never over-delete.
  let pending: Promise<void> = Promise.resolve();

  function schedulePersist(): Promise<void> {
    pending = pending
      .catch(() => {})
      .then(async () => {
        if (!store) return;
        try {
          await store.save({
            schemaVersion: CREDENTIAL_PROVENANCE_SCHEMA_VERSION,
            credentials: entries.map((entry) => ({ ...entry }))
          });
        } catch (error) {
          report({
            code: "credential-provenance-write-failed",
            message: `Could not persist credential provenance: ${String(error)}`
          });
        }
      });
    return pending;
  }

  return {
    async configure(next) {
      store = next;
      report = next?.report ?? (() => {});
      entries = [];
      if (!store) return;
      const envelope = await store.load();
      if (!envelope) return;
      for (const value of envelope.credentials) {
        const record = sanitizeCredentialProvenanceRecord(value);
        if (record) entries.push(record);
      }
    },
    record(input) {
      const record = buildRecord(input);
      if (!record) return null;
      const index = entries.findIndex((entry) =>
        sameCredentialIdentity(entry, record)
      );
      if (index >= 0) entries[index] = record;
      else entries.push(record);
      void schedulePersist();
      return record;
    },
    list(repo, environment) {
      return entries
        .filter((entry) => belongsToEnvironment(entry, repo, environment))
        .map((entry) => ({ ...entry }));
    },
    async clear(repo, environment) {
      const before = entries.length;
      entries = entries.filter(
        (entry) => !belongsToEnvironment(entry, repo, environment)
      );
      if (entries.length !== before) await schedulePersist();
    },
    all() {
      return entries.map((entry) => ({ ...entry }));
    },
    async persist() {
      await schedulePersist();
    }
  };
}

let registry = createRegistry();

/** Point the provenance registry at a durable store (or null to disable it). */
export async function configureCredentialProvenanceStore(
  store: CredentialProvenanceStore | null
): Promise<void> {
  await registry.configure(store);
}

/** Record (or replace) the provenance of one federated credential. */
export function recordCredentialProvenance(
  input: RecordCredentialProvenanceInput
): CredentialProvenanceRecord | null {
  return registry.record(input);
}

/** The provenance records for one repository + environment. */
export function listCredentialProvenance(
  repo: string,
  environment: string
): CredentialProvenanceRecord[] {
  return registry.list(repo, environment);
}

/** Forget the provenance records for one repository + environment. */
export async function clearCredentialProvenance(
  repo: string,
  environment: string
): Promise<void> {
  await registry.clear(repo, environment);
}

/** Every provenance record currently held (primarily for tests/diagnostics). */
export function allCredentialProvenance(): CredentialProvenanceRecord[] {
  return registry.all();
}

/** Flush any pending durable writes. */
export async function persistCredentialProvenance(): Promise<void> {
  await registry.persist();
}

/** Reset the registry to an empty, storeless state (tests only). */
export function resetCredentialProvenanceForTest(): void {
  registry = createRegistry();
}
