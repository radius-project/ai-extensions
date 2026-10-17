import { buildEnvironmentSuffix } from "./platforms/oidc-subject.js";
import {
  isUuid,
  resolveOidcSubject
} from "./platforms/setup-azure-identity.js";
import { parseAzureAccountIdentity } from "./setup-azure-account.js";
import type {
  AzureApplication,
  AzureApplicationPorts,
  AzureCredentialPorts
} from "./setup-azure-contracts.js";
import type {
  AzureAppCreateContinuation,
  AzureAppCreateContinuationRequest,
  AzureAppCreateContinuationSeed
} from "./setup-azure-continuation.js";
import { resolveAzureAutoSetupApplication } from "./setup-azure-application.js";
import { configureAzureAutoSetupCredentials } from "./setup-azure-credentials.js";

export type AzureIdentityProgress =
  | { kind: "select-subscription"; subscriptionId: string }
  | { kind: "check-login" }
  | { kind: "account-ready"; subscriptionId: string; tenantId: string }
  | { kind: "resolve-oidc" }
  | { kind: "oidc-ready"; subjects: string[] }
  | { kind: "application-retained"; appName: string };

export type AzureIdentityFailure =
  | { kind: "subscription-selection"; subscriptionId: string; detail: string }
  | { kind: "not-logged-in" }
  | { kind: "account-parse" }
  | { kind: "tenant-mismatch"; activeTenantId: string; tenantId: string }
  | { kind: "invalid-subscription"; subscriptionId: string }
  | { kind: "account-incomplete" }
  | { kind: "oidc"; message: string; code: string };

export interface AzureSetupPorts {
  application: AzureApplicationPorts;
  credentials: AzureCredentialPorts;
  identityProgress(event: AzureIdentityProgress): void;
  finalizeIdentityFailure(event: AzureIdentityFailure): Promise<void>;
  prepareContinuation(
    resolved: AzureAppCreateContinuationSeed["resolved"]
  ): void;
}

export type AzureSetupResult =
  | {
      kind: "completed";
      application: AzureApplication;
      tenantId: string;
      subscriptionId: string;
      subjects: string[];
    }
  | { kind: "failed" | "stopped" | "input-required" };

export async function runAzureSetup(
  input: {
    request: AzureAppCreateContinuationRequest;
    serviceManagementReference: string;
    continuation: AzureAppCreateContinuation | null;
  },
  ports: AzureSetupPorts
): Promise<AzureSetupResult> {
  const { request, continuation } = input;
  const { runAz, runGitHubJson } = ports.application;
  let terminal: AzureSetupResult = { kind: "failed" };
  function observe<T extends AzureApplicationPorts | AzureCredentialPorts>(
    original: T
  ): T {
    return {
      ...original,
      get environment() {
        return original.environment;
      },
      async finalizeFailure(event) {
        terminal = {
          kind:
            (
              event.kind === "app-selection-required" ||
              event.kind === "service-management-reference-required"
            ) ?
              "input-required"
            : "failed"
        };
        await original.finalizeFailure(event);
      },
      async stopBoundary(boundary) {
        const proceed = await original.stopBoundary(boundary);
        if (!proceed) terminal = { kind: "stopped" };
        return proceed;
      },
      async checkpoint(boundary) {
        const proceed = await original.checkpoint(boundary);
        if (!proceed) terminal = { kind: original.haltKind() };
        return proceed;
      }
    };
  }
  let resolved: AzureAppCreateContinuationSeed["resolved"];
  if (continuation) {
    resolved = continuation.resolved;
  } else {
    let tenantId = request.requestedTenantId;
    let subscriptionId = request.requestedSubscriptionId;
    ports.identityProgress({ kind: "select-subscription", subscriptionId });
    if (
      !(await ports.application.stopBoundary(
        "before-azure-subscription-selection"
      ))
    )
      return { kind: "stopped" };
    const setResult = await runAz([
      "account",
      "set",
      "--subscription",
      subscriptionId
    ]);
    if (setResult.code !== 0) {
      await ports.finalizeIdentityFailure({
        kind: "subscription-selection",
        subscriptionId,
        detail: (setResult.stderr || "").trim()
      });
      return { kind: "failed" };
    }
    ports.identityProgress({ kind: "check-login" });
    const accountResult = await runAz(["account", "show", "--output", "json"]);
    if (accountResult.code !== 0) {
      await ports.finalizeIdentityFailure({ kind: "not-logged-in" });
      return { kind: "failed" };
    }
    const account = parseAzureAccountIdentity(accountResult.stdout);
    if (!account) {
      await ports.finalizeIdentityFailure({ kind: "account-parse" });
      return { kind: "failed" };
    }
    const activeTenantId = account.tenantId;
    subscriptionId = account.subscriptionId;
    if (
      tenantId &&
      activeTenantId &&
      tenantId.toLowerCase() !== activeTenantId.toLowerCase()
    ) {
      await ports.finalizeIdentityFailure({
        kind: "tenant-mismatch",
        activeTenantId,
        tenantId
      });
      return { kind: "failed" };
    }
    tenantId = tenantId || activeTenantId;
    if (!isUuid(subscriptionId)) {
      await ports.finalizeIdentityFailure({
        kind: "invalid-subscription",
        subscriptionId
      });
      return { kind: "failed" };
    }
    if (!isUuid(activeTenantId)) {
      await ports.finalizeIdentityFailure({ kind: "account-incomplete" });
      return { kind: "failed" };
    }
    const callerIdentity = account.callerIdentity;
    ports.identityProgress({ kind: "account-ready", subscriptionId, tenantId });
    ports.identityProgress({ kind: "resolve-oidc" });
    const oidcSuffix = buildEnvironmentSuffix(request.environment);
    let oidc;
    try {
      oidc = await resolveOidcSubject(
        {
          targetRepo: request.repo,
          envName: request.environment,
          suffix: oidcSuffix
        },
        runGitHubJson
      );
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ?
          error.code
        : undefined;
      await ports.finalizeIdentityFailure({
        kind: "oidc",
        message: error instanceof Error ? error.message : String(error),
        code: typeof code === "string" && code ? code : "oidc-subject-failed"
      });
      return { kind: "failed" };
    }
    ports.identityProgress({
      kind: "oidc-ready",
      subjects: oidc.federatedCredentials.map(
        (credential) => credential.subject
      )
    });
    resolved = { subscriptionId, tenantId, oidcSuffix, callerIdentity, oidc };
  }
  ports.prepareContinuation(resolved);
  const application = await resolveAzureAutoSetupApplication({
    ports: observe(ports.application),
    oidc: resolved.oidc,
    environment: request.environment,
    explicitAppId: request.explicitAppId,
    createNewApp: request.createNewApp,
    appNameProvided: request.appNameProvided,
    requestedAppName: request.requestedAppName,
    requestedClientId: request.requestedClientId,
    serviceManagementReference: input.serviceManagementReference,
    callerIdentity: resolved.callerIdentity,
    ...(continuation ?
      {
        resumeAtCreate: {
          appName: continuation.resolved.appName,
          callerObjectId: continuation.resolved.callerObjectId
        }
      }
    : {})
  });
  if (!application) return terminal;
  if (
    !(await configureAzureAutoSetupCredentials({
      ports: observe(ports.credentials),
      ...resolved,
      clientId: application.clientId,
      appName: application.appName,
      resourceGroup: request.resourceGroup,
      clusterResourceGroup: request.clusterResourceGroup,
      clusterName: request.clusterName
    }))
  )
    return terminal;
  if (application.state === "created") {
    ports.identityProgress({
      kind: "application-retained",
      appName: application.appName
    });
  }
  return {
    kind: "completed",
    application,
    tenantId: resolved.tenantId,
    subscriptionId: resolved.subscriptionId,
    subjects: resolved.oidc.federatedCredentials.map(
      (credential) => credential.subject
    )
  };
}
