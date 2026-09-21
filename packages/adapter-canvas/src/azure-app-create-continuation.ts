import {
  buildEnvironmentSuffix,
  type OidcSubjectConfig
} from "@radius-project/core/platforms";
import type { CallerIdentity, ResolveOidcSubjectResult } from "./azure-oidc.js";
import {
  isAksClusterName,
  isResourceGroupName,
  isUuid,
  isValidRepoSlug,
  validateAppRegistrationName
} from "./azure-oidc.js";
import type { SelectedGhCredentialSource, SelectedGhExecutor } from "./gh.js";

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
    credentialSource: SelectedGhCredentialSource;
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
    credentialSource: SelectedGhCredentialSource;
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

interface AzureAppCreateContinuationMatchInput {
  operationId: string;
  operationState: string | undefined;
  inputRequired: unknown;
  request: AzureAppCreateContinuationRequest;
  serviceManagementReference: string;
  githubExecutor: SelectedGhExecutor;
}

function object(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, maximumLength = 512): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximumLength ? normalized : null;
}

function optionalString(value: unknown, maximumLength = 512): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length <= maximumLength ? normalized : null;
}

function uuid(value: unknown, allowEmpty = false): string | null {
  const normalized = optionalString(value, 36);
  if (normalized === null) return null;
  if (!normalized) return allowEmpty ? "" : null;
  return isUuid(normalized) ? normalized.toLowerCase() : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ?
      value
    : null;
}

function normalizePrompt(
  value: unknown
): AzureAppCreateContinuation["prompt"] | null {
  const prompt = object(value);
  const requestedAt =
    (
      typeof prompt?.requestedAt === "string" &&
      !Number.isNaN(Date.parse(prompt.requestedAt))
    ) ?
      new Date(prompt.requestedAt).toISOString()
    : null;
  if (
    !requestedAt ||
    prompt?.code !== AZURE_SERVICE_MANAGEMENT_REFERENCE_PROMPT.code ||
    prompt.checkpoint !==
      AZURE_SERVICE_MANAGEMENT_REFERENCE_PROMPT.checkpoint ||
    prompt.message !== AZURE_SERVICE_MANAGEMENT_REFERENCE_PROMPT.message ||
    prompt.metadata !== null ||
    requestedAt !== prompt.requestedAt
  ) {
    return null;
  }
  return {
    ...AZURE_SERVICE_MANAGEMENT_REFERENCE_PROMPT,
    requestedAt
  };
}

function normalizeRequest(
  value: unknown
): AzureAppCreateContinuationRequest | null {
  const request = object(value);
  if (!request) return null;
  const repo = requiredString(request.repo, 140);
  const environment = requiredString(request.environment, 255);
  const operationEnvironment = requiredString(
    request.operationEnvironment,
    255
  );
  const requestedSubscriptionId = uuid(request.requestedSubscriptionId);
  const requestedTenantId = uuid(request.requestedTenantId, true);
  const resourceGroup = requiredString(request.resourceGroup, 90);
  const clusterResourceGroup = optionalString(request.clusterResourceGroup, 90);
  const clusterName = requiredString(request.clusterName, 63);
  const explicitAppId = uuid(request.explicitAppId, true);
  const requestedAppName = optionalString(request.requestedAppName, 120);
  const requestedClientId = uuid(request.requestedClientId, true);
  if (
    !repo ||
    !isValidRepoSlug(repo) ||
    !environment ||
    !operationEnvironment ||
    !requestedSubscriptionId ||
    requestedTenantId === null ||
    !resourceGroup ||
    !isResourceGroupName(resourceGroup) ||
    clusterResourceGroup === null ||
    (clusterResourceGroup !== "" &&
      !isResourceGroupName(clusterResourceGroup)) ||
    !clusterName ||
    !isAksClusterName(clusterName) ||
    explicitAppId === null ||
    typeof request.createNewApp !== "boolean" ||
    typeof request.appNameProvided !== "boolean" ||
    requestedAppName === null ||
    requestedClientId === null
  ) {
    return null;
  }
  return {
    repo,
    environment,
    operationEnvironment,
    requestedSubscriptionId,
    requestedTenantId,
    resourceGroup,
    clusterResourceGroup,
    clusterName,
    explicitAppId,
    createNewApp: request.createNewApp,
    appNameProvided: request.appNameProvided,
    requestedAppName,
    requestedClientId
  };
}

function normalizeExecutor(
  value: unknown
): AzureAppCreateContinuation["githubExecutor"] | null {
  const executor = object(value);
  const login = requiredString(executor?.login, 255);
  const credentialSource = executor?.credentialSource;
  if (
    !login ||
    (credentialSource !== "injected" && credentialSource !== "keyring") ||
    typeof executor?.requiresKeyringSwitch !== "boolean" ||
    !Array.isArray(executor.scopes)
  ) {
    return null;
  }
  const scopes = executor.scopes.map((scope) => requiredString(scope, 255));
  if (scopes.some((scope) => scope === null)) return null;
  return {
    login,
    credentialSource,
    requiresKeyringSwitch: executor.requiresKeyringSwitch,
    scopes: scopes as string[]
  };
}

function normalizeCallerIdentity(
  value: unknown
): Exclude<CallerIdentity, { kind: "unsupported" }> | null {
  const identity = object(value);
  if (identity?.kind === "user") return { kind: "user" };
  const appId = uuid(identity?.appId);
  return identity?.kind === "servicePrincipal" && appId ?
      { kind: "servicePrincipal", appId }
    : null;
}

function normalizeSubjectConfig(value: unknown): OidcSubjectConfig | null {
  const config = object(value);
  if (!config || typeof config.useDefault !== "boolean") return null;
  const includeClaimKeys =
    config.includeClaimKeys === undefined ? undefined
    : Array.isArray(config.includeClaimKeys) ?
      config.includeClaimKeys.map((key) => requiredString(key, 128))
    : null;
  if (
    includeClaimKeys === null ||
    includeClaimKeys?.some((key) => key === null) ||
    (config.useImmutableSubject !== undefined &&
      typeof config.useImmutableSubject !== "boolean") ||
    (config.subClaimPrefix !== undefined &&
      requiredString(config.subClaimPrefix, 512) === null)
  ) {
    return null;
  }
  return {
    useDefault: config.useDefault,
    ...(includeClaimKeys ?
      { includeClaimKeys: includeClaimKeys as string[] }
    : {}),
    ...(typeof config.useImmutableSubject === "boolean" ?
      { useImmutableSubject: config.useImmutableSubject }
    : {}),
    ...(typeof config.subClaimPrefix === "string" ?
      { subClaimPrefix: config.subClaimPrefix.trim() }
    : {})
  };
}

function normalizeOidc(value: unknown): ResolveOidcSubjectResult | null {
  const oidc = object(value);
  const fullName = requiredString(oidc?.fullName, 140);
  const ownerId = positiveInteger(oidc?.ownerId);
  const repoId = positiveInteger(oidc?.repoId);
  const subjectConfig = normalizeSubjectConfig(oidc?.subjectConfig);
  if (
    !fullName ||
    !isValidRepoSlug(fullName) ||
    !ownerId ||
    !repoId ||
    !subjectConfig ||
    !Array.isArray(oidc?.federatedCredentials) ||
    oidc.federatedCredentials.length === 0
  ) {
    return null;
  }
  const federatedCredentials = oidc.federatedCredentials.map((value) => {
    const credential = object(value);
    const name = requiredString(credential?.name, 120);
    const subject = requiredString(credential?.subject, 1024);
    return name && subject ? { name, subject } : null;
  });
  if (federatedCredentials.some((credential) => credential === null)) {
    return null;
  }
  return {
    fullName,
    ownerId,
    repoId,
    subjectConfig,
    federatedCredentials: federatedCredentials as Array<{
      name: string;
      subject: string;
    }>
  };
}

function normalizeResolved(
  value: unknown
): AzureAppCreateContinuation["resolved"] | null {
  const resolved = object(value);
  const subscriptionId = uuid(resolved?.subscriptionId);
  const tenantId = uuid(resolved?.tenantId);
  const oidcSuffix = requiredString(resolved?.oidcSuffix, 512);
  const callerIdentity = normalizeCallerIdentity(resolved?.callerIdentity);
  const callerObjectId = uuid(resolved?.callerObjectId);
  const oidc = normalizeOidc(resolved?.oidc);
  const appNameValue = requiredString(resolved?.appName, 120);
  const appNameCheck =
    appNameValue ? validateAppRegistrationName(appNameValue) : null;
  if (
    !subscriptionId ||
    !tenantId ||
    !oidcSuffix ||
    !callerIdentity ||
    !callerObjectId ||
    !oidc ||
    !appNameCheck?.ok
  ) {
    return null;
  }
  return {
    subscriptionId,
    tenantId,
    oidcSuffix,
    callerIdentity,
    callerObjectId,
    oidc,
    appName: appNameCheck.name
  };
}

export function normalizeAzureAppCreateContinuation(
  value: unknown
): AzureAppCreateContinuation | null {
  const continuation = object(value);
  if (
    continuation?.schemaVersion !== AZURE_APP_CREATE_CONTINUATION_SCHEMA_VERSION
  ) {
    return null;
  }
  const operationId = requiredString(continuation.operationId, 255);
  const prompt = normalizePrompt(continuation.prompt);
  const acceptedPrompt =
    continuation.acceptedPrompt === undefined ?
      undefined
    : normalizePrompt(continuation.acceptedPrompt);
  const request = normalizeRequest(continuation.request);
  const githubExecutor = normalizeExecutor(continuation.githubExecutor);
  const resolved = normalizeResolved(continuation.resolved);
  if (
    !operationId ||
    !prompt ||
    acceptedPrompt === null ||
    !request ||
    !githubExecutor ||
    !resolved ||
    request.explicitAppId ||
    request.requestedSubscriptionId !== resolved.subscriptionId ||
    (request.requestedTenantId &&
      request.requestedTenantId !== resolved.tenantId) ||
    request.repo.toLowerCase() !== resolved.oidc.fullName.toLowerCase() ||
    resolved.oidcSuffix !== buildEnvironmentSuffix(request.environment)
  ) {
    return null;
  }
  if (
    acceptedPrompt &&
    JSON.stringify(acceptedPrompt) !== JSON.stringify(prompt)
  ) {
    return null;
  }
  const expectedAppName = validateAppRegistrationName(
    request.appNameProvided ?
      request.requestedAppName
    : `radius-deploy-${resolved.oidc.fullName.replace("/", "-")}`
  );
  if (!expectedAppName.ok || expectedAppName.name !== resolved.appName) {
    return null;
  }
  return {
    schemaVersion: AZURE_APP_CREATE_CONTINUATION_SCHEMA_VERSION,
    operationId,
    prompt,
    ...(acceptedPrompt ? { acceptedPrompt } : {}),
    request,
    githubExecutor,
    resolved
  };
}

export function createAzureAppCreateContinuation(
  seed: AzureAppCreateContinuationSeed,
  appName: string,
  callerObjectId: string,
  requestedAt: string
): AzureAppCreateContinuation | null {
  return normalizeAzureAppCreateContinuation({
    schemaVersion: AZURE_APP_CREATE_CONTINUATION_SCHEMA_VERSION,
    operationId: seed.operationId,
    prompt: {
      ...AZURE_SERVICE_MANAGEMENT_REFERENCE_PROMPT,
      requestedAt
    },
    request: seed.request,
    githubExecutor: seed.githubExecutor,
    resolved: {
      ...seed.resolved,
      appName,
      callerObjectId
    }
  });
}

export function acceptAzureAppCreateContinuationPrompt(
  value: unknown,
  inputRequired: unknown
): AzureAppCreateContinuation | null {
  const continuation = normalizeAzureAppCreateContinuation(value);
  const prompt = normalizePrompt(inputRequired);
  if (
    !continuation ||
    !prompt ||
    JSON.stringify(continuation.prompt) !== JSON.stringify(prompt)
  ) {
    return null;
  }
  return {
    ...continuation,
    acceptedPrompt: prompt
  };
}

export function matchAzureAppCreateContinuation(
  value: unknown,
  input: AzureAppCreateContinuationMatchInput
): AzureAppCreateContinuation | null {
  const continuation = normalizeAzureAppCreateContinuation(value);
  const request = normalizeRequest(input.request);
  const executor = normalizeExecutor(input.githubExecutor);
  const prompt =
    input.operationState === "input_required" ?
      normalizePrompt(input.inputRequired)
    : input.operationState === "running" && input.inputRequired == null ?
      (continuation?.acceptedPrompt ?? null)
    : null;
  if (
    !continuation ||
    !request ||
    !executor ||
    !prompt ||
    continuation.operationId !== input.operationId ||
    JSON.stringify(continuation.prompt) !== JSON.stringify(prompt) ||
    !isUuid(input.serviceManagementReference) ||
    JSON.stringify(continuation.request) !== JSON.stringify(request) ||
    JSON.stringify(continuation.githubExecutor) !== JSON.stringify(executor)
  ) {
    return null;
  }
  return continuation;
}
