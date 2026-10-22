import type {
  CallerIdentity,
  ResolveOidcSubjectResult
} from "./platforms/setup-azure-identity.js";
export const AZURE_APP_CREATE_CONTINUATION_SCHEMA_VERSION = 1;
export const AZURE_SERVICE_MANAGEMENT_REFERENCE_PROMPT = Object.freeze({
  code: "service-management-reference-required",
  checkpoint: "azure-service-management-reference",
  metadata: null,
  message:
    "This Entra tenant requires a Service Management Reference on new App Registrations. " +
    "Enter your Service Management Reference (for Microsoft-internal tenants, your Service Tree ID GUID) and retry."
});
export interface AzureAppCreateContinuationRequest {
  repo: string;
  environment: string;
  operationEnvironment: string;
  requestedSubscriptionId: string;
  requestedTenantId: string;
  resourceGroup: string;
  clusterResourceGroup: string;
  clusterName: string;
  explicitAppId: string;
  createNewApp: boolean;
  appNameProvided: boolean;
  requestedAppName: string;
  requestedClientId: string;
}

export interface AzureAppCreateContinuationSeed {
  operationId: string;
  request: AzureAppCreateContinuationRequest;
  githubExecutor: {
    login: string;
    credentialSource: "injected" | "keyring";
    requiresKeyringSwitch: boolean;
    scopes: readonly string[];
  };
  resolved: {
    subscriptionId: string;
    tenantId: string;
    oidcSuffix: string;
    callerIdentity: CallerIdentity;
    oidc: ResolveOidcSubjectResult;
  };
}

export interface AzureAppCreateContinuation {
  schemaVersion: typeof AZURE_APP_CREATE_CONTINUATION_SCHEMA_VERSION;
  operationId: string;
  prompt: typeof AZURE_SERVICE_MANAGEMENT_REFERENCE_PROMPT & {
    requestedAt: string;
  };
  acceptedPrompt?: typeof AZURE_SERVICE_MANAGEMENT_REFERENCE_PROMPT & {
    requestedAt: string;
  };
  request: AzureAppCreateContinuationRequest;
  githubExecutor: {
    login: string;
    credentialSource: "injected" | "keyring";
    requiresKeyringSwitch: boolean;
    scopes: string[];
  };
  resolved: {
    subscriptionId: string;
    tenantId: string;
    oidcSuffix: string;
    callerIdentity: Exclude<CallerIdentity, { kind: "unsupported" }>;
    callerObjectId: string;
    oidc: ResolveOidcSubjectResult;
    appName: string;
  };
}

export function matchesAzureAppCreateContinuation(
  continuation: AzureAppCreateContinuation,
  input: {
    operationId: string;
    request: AzureAppCreateContinuationRequest;
    githubExecutor: AzureAppCreateContinuation["githubExecutor"];
    prompt: AzureAppCreateContinuation["prompt"];
  }
): boolean {
  return (
    continuation.operationId === input.operationId &&
    JSON.stringify(continuation.prompt) === JSON.stringify(input.prompt) &&
    JSON.stringify(continuation.request) === JSON.stringify(input.request) &&
    JSON.stringify(continuation.githubExecutor) ===
      JSON.stringify(input.githubExecutor)
  );
}
