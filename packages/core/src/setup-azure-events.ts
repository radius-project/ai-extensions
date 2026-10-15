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
      values: [string];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "invalid-derived-app-name";
      values: [string];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "existing-client-owner-lookup";
      values: [string, string];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "existing-client-verification";
      values: [string, string, string];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "existing-client-ownership";
      values: [string, string, string];
      evidence: AzureFailureEvidence;
    }
  | { kind: "invalid-app-id"; values: []; evidence: AzureFailureEvidence }
  | {
      kind: "selected-application-owner-lookup";
      values: [string, string];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "selected-application-ownership";
      values: [string, string];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "app-lookup-failed";
      values: [string];
      evidence: AzureFailureEvidence;
    }
  | { kind: "app-lookup-parse"; values: []; evidence: AzureFailureEvidence }
  | {
      kind: "app-lookup-invalid-json";
      values: [];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "candidate-owner-lookup";
      values: [string, string];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "application-selection";
      values: [string, string];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "app-selection-required";
      values: [];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "caller-before-application-create";
      values: [string];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "service-management-reference-required";
      values: [];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "app-create-failed";
      values: [string, string];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "caller-after-application-create";
      values: [string];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "app-owner-add-failed";
      values: [string];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "created-application-owner-lookup";
      values: [string];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "app-owner-verify-failed";
      values: [];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "app-tag-update-failed";
      values: [string];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "app-tag-read-failed";
      values: [string];
      evidence: AzureFailureEvidence;
    }
  | { kind: "app-tag-parse-failed"; values: []; evidence: AzureFailureEvidence }
  | {
      kind: "app-tag-verify-failed";
      values: [string];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "app-object-id-failed";
      values: [string];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "federated-credential-list-failed";
      values: [string, string];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "federated-credential-list-malformed";
      values: [];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "federated-credential-name-collision";
      values: [string, string, string];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "federated-credential-identity-incomplete";
      values: [string];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "credential-provenance-write-failed";
      values: [string, boolean];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "federated-credential-failed";
      values: [string, string];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "federated-credential-subject-mismatch";
      values: [string, boolean, string, string];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "created-federated-credential-identity-incomplete";
      values: [string];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "provider-reconciliation-pending";
      values: [];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "rollback-before-service-principal";
      values: [];
      evidence: AzureFailureEvidence;
    }
  | { kind: "sp-failed"; values: [string]; evidence: AzureFailureEvidence }
  | {
      kind: "rollback-after-service-principal";
      values: [];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "rollback-after-federated-credential";
      values: [];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "sp-objectid-failed";
      values: [string];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "role-assignment-failed";
      values: [string];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "rollback-after-contributor";
      values: [];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "rollback-after-cluster-admin";
      values: [];
      evidence: AzureFailureEvidence;
    }
  | {
      kind: "rollback-after-locks-contributor";
      values: [];
      evidence: AzureFailureEvidence;
    };
