import type { OidcSubjectConfig } from "../platforms/oidc-subject.js";
import type { AzureFederatedCredential } from "../platforms/setup-azure-identity.js";

export type CredentialOrigin = "created" | "reused";

export interface CredentialProvenanceRecord {
  schemaVersion: 2;
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
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((entry, index) => entry === sortedB[index]);
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
