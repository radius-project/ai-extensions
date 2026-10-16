export interface AzureFailureEvidence {
  clientId?: string;
  appName?: string;
  azError?: string;
  error?: string;
  candidates?: Array<{
    appId: string;
    displayName?: string;
    createdDateTime?: string;
    servesRepos?: string[];
  }>;
  defaultAppId?: string;
  appCreateContinuationAppName?: string;
  appCreateContinuationCallerObjectId?: string;
}
export type AzureSetupProgress =
  | { kind: "verify-existing-client"; values: [string] }
  | { kind: "reuse-existing-client"; values: [string] }
  | { kind: "select-application"; values: [string] }
  | { kind: "list-applications"; values: [string] }
  | { kind: "reuse-application"; values: [string] }
  | { kind: "create-application"; values: [string] }
  | { kind: "application-created"; values: [string] }
  | { kind: "add-application-owner"; values: [] }
  | { kind: "verify-application-owner"; values: [] }
  | { kind: "application-owner-verified"; values: [] }
  | { kind: "patch-application-tags"; values: [] }
  | { kind: "verify-application-tags"; values: [] }
  | { kind: "application-tags-verified"; values: [] }
  | { kind: "legacy-mutable-credential"; values: [string, string, string] }
  | { kind: "credentials-already-present"; values: [string] }
  | { kind: "create-federated-credential"; values: [string] }
  | { kind: "retry-federated-credential"; values: [string, number, number] }
  | { kind: "federated-credential-ready"; values: [string, boolean] }
  | { kind: "create-service-principal"; values: [] }
  | { kind: "service-principal-ready"; values: [] }
  | { kind: "service-principal-ownership-unknown"; values: [] }
  | { kind: "resolve-service-principal-id"; values: [] }
  | { kind: "assign-contributor"; values: [string] }
  | { kind: "contributor-assigned"; values: [] }
  | { kind: "assign-cluster-admin"; values: [string] }
  | { kind: "cluster-admin-assigned"; values: [] }
  | { kind: "cluster-admin-warning"; values: [string, string, string] }
  | { kind: "assign-locks-contributor"; values: [string] }
  | { kind: "locks-contributor-assigned"; values: [] }
  | { kind: "locks-contributor-warning"; values: [string, string, string] };
export type AzureSetupFailure =
  | {
      kind: "invalid-app-name";
      reason: string;
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "invalid-derived-app-name";
      reason: string;
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "existing-client-owner-lookup";
      clientId: string;
      detail: string;
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "existing-client-verification";
      clientId: string;
      detail: string;
      code: string;
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "existing-client-ownership";
      message: string;
      clientId: string;
      code: string;
      evidence: AzureFailureEvidence;
    }
  | { kind: "invalid-app-id"; evidence: AzureFailureEvidence }
  | {
      kind: "selected-application-owner-lookup";
      appId: string;
      detail: string;
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "selected-application-ownership";
      message: string;
      code: string;
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "app-lookup-failed";
      detail: string;
      evidence: AzureFailureEvidence;
    }
  | { kind: "app-lookup-parse"; evidence: AzureFailureEvidence }
  | {
      kind: "app-lookup-invalid-json";
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "candidate-owner-lookup";
      appId: string;
      detail: string;
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "application-selection";
      message: string;
      code: string;
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "app-selection-required";
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "caller-before-application-create";
      detail: string;
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "service-management-reference-required";
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "app-create-failed";
      stderr: string;
      stdout: string;
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "caller-after-application-create";
      detail: string;
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "app-owner-add-failed";
      detail: string;
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "created-application-owner-lookup";
      detail: string;
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "app-owner-verify-failed";
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "app-tag-update-failed";
      detail: string;
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "app-tag-read-failed";
      detail: string;
      evidence: AzureFailureEvidence;
    }
  | { kind: "app-tag-parse-failed"; evidence: AzureFailureEvidence }
  | {
      kind: "app-tag-verify-failed";
      missingTags: string;
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "app-object-id-failed";
      clientId: string;
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "federated-credential-list-failed";
      stderr: string;
      stdout: string;
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "federated-credential-list-malformed";
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "federated-credential-name-collision";
      credentialName: string;
      existingSubject: string;
      requiredSubject: string;
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "federated-credential-identity-incomplete";
      credentialName: string;
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "credential-provenance-write-failed";
      credentialName: string;
      created: boolean;
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "federated-credential-failed";
      credentialName: string;
      detail: string;
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "federated-credential-subject-mismatch";
      credentialName: string;
      created: boolean;
      actualSubject: string;
      requiredSubject: string;
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "created-federated-credential-identity-incomplete";
      credentialName: string;
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "provider-reconciliation-pending";
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "rollback-before-service-principal";
      evidence: AzureFailureEvidence;
    }
  | { kind: "sp-failed"; detail: string; evidence: AzureFailureEvidence }
  | {
      kind: "rollback-after-service-principal";
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "rollback-after-federated-credential";
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "sp-objectid-failed";
      detail: string;
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "role-assignment-failed";
      detail: string;
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "rollback-after-contributor";
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "rollback-after-cluster-admin";
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "rollback-after-locks-contributor";
      evidence: AzureFailureEvidence;
    };
