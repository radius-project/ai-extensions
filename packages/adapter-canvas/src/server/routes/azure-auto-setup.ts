import { buildEnvironmentSuffix } from "@radius-project/core";
import {
  isAksClusterName,
  isResourceGroupName,
  isUuid,
  isValidRepoSlug,
  resolveOidcSubject
} from "../../azure-oidc.js";
import type { ResolveOidcSubjectResult } from "../../azure-oidc.js";
import type { CanvasRequestContext } from "../request-context.js";
import type { RouteHandlerRegistry } from "../route-table.js";
import { resolveAzureAutoSetupApplication } from "./azure-auto-setup-application.js";
import { configureAzureAutoSetupCredentials } from "./azure-auto-setup-credentials.js";
import type {
  AzureAutoSetupDependencies,
  AzureAutoSetupOperation,
  AzureAutoSetupWorkflow
} from "./azure-auto-setup-types.js";

const OPERATION_FUNCTIONS = [
  "get",
  "isStale",
  "create",
  "buildStages",
  "start",
  "persist",
  "report",
  "finish",
  "enterStage",
  "setStageState",
  "hasWarnings",
  "addLegacyStep",
  "setContext",
  "setCloudContext",
  "requireInput",
  "resumeAfterInput",
  "recordAzureApp",
  "recordServicePrincipal",
  "recordCreatedFederatedCredential",
  "recordCreatedRoleAssignment"
] as const;

const EXTERNAL_FUNCTIONS = [
  "getGitHubIdentity",
  "preflightRepoAdmin",
  "preflightGhcrPackageWriteAccess",
  "runGitHubJson",
  "runAz"
] as const;

function validateDependencies(dependencies: AzureAutoSetupDependencies): void {
  for (const name of [
    "isServerOwnedRequest",
    "ensureServicePrincipal",
    "finalizeSetupFailure",
    "persistMutationCheckpoint",
    "sleep"
  ] as const) {
    if (typeof dependencies[name] !== "function") {
      throw new Error(`Missing Azure auto-setup dependency: ${name}`);
    }
  }
  for (const name of OPERATION_FUNCTIONS) {
    if (typeof dependencies.operations?.[name] !== "function") {
      throw new Error(
        `Missing Azure auto-setup dependency: operations.${name}`
      );
    }
  }
  for (const name of EXTERNAL_FUNCTIONS) {
    if (typeof dependencies.external?.[name] !== "function") {
      throw new Error(`Missing Azure auto-setup dependency: external.${name}`);
    }
  }
  for (const name of ["createPath", "write", "remove"] as const) {
    if (typeof dependencies.tempFile?.[name] !== "function") {
      throw new Error(`Missing Azure auto-setup dependency: tempFile.${name}`);
    }
  }
  if (
    typeof dependencies.stageAuthorizeIdentity !== "string" ||
    !dependencies.stageAuthorizeIdentity
  ) {
    throw new Error(
      "Missing Azure auto-setup dependency: stageAuthorizeIdentity"
    );
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value));
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown, fallback: string): string {
  const value = record(error).code;
  return typeof value === "string" && value ? value : fallback;
}

function sanitizeFailureExtra(
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  const safe = { ...extra };
  delete safe.azError;
  delete safe.ghError;
  return safe;
}

function respond(context: CanvasRequestContext, status: number, body: unknown) {
  context.response.setHeader("Content-Type", "application/json");
  context.response.writeHead(status);
  context.response.end(JSON.stringify(body));
}

export async function handleAzureAutoSetup(
  context: CanvasRequestContext,
  dependencies: AzureAutoSetupDependencies
): Promise<void> {
  const isServerOwned = dependencies.isServerOwnedRequest(
    context.instanceId,
    context.request
  );
  if (!isServerOwned) {
    respond(context, 403, {
      error: "This endpoint is reserved for server-owned operations.",
      code: "server-owned-operation-required"
    });
    return;
  }

  const body = await context.readTextBody();
  let operation: AzureAutoSetupOperation | null = null;
  let steps: string[] = [];
  let runAzReady = false;
  try {
    const data = JSON.parse(body);
    const targetRepo = data.repo || "";
    const environment = data.environment || "dev";
    const resourceGroup = data.resourceGroup || "";
    const clusterName = data.cluster || "";
    const clusterResourceGroup = (data.clusterResourceGroup || "").trim();
    const serviceManagementReference = data.serviceManagementReference || "";
    const explicitAppId = (data.appId || "").trim();
    const createNewApp = data.createNew === true;
    const appNameProvided = typeof data.appName === "string";
    const requestedAppName = appNameProvided ? data.appName : "";
    const requestedSubscriptionId = (data.subscriptionId || "").trim();

    const fail = async (
      status: number,
      error: string,
      code: string,
      extra: Record<string, unknown> = {}
    ): Promise<void> => {
      const retryablePrompt =
        code === "app-selection-required" ||
        code === "service-management-reference-required";
      if (operation && retryablePrompt) {
        dependencies.operations.requireInput(operation, {
          code,
          message: error,
          checkpoint:
            code === "app-selection-required" ?
              "azure-app-selection"
            : "azure-service-management-reference",
          metadata:
            code === "app-selection-required" ?
              {
                candidates:
                  Array.isArray(extra.candidates) ? extra.candidates : [],
                defaultAppId: extra.defaultAppId || null
              }
            : null
        });
        await dependencies.operations.persist();
        respond(context, status, {
          error,
          inputRequired: true,
          ...(code ? { code } : {}),
          operationId: operation.operationId,
          ...sanitizeFailureExtra(extra)
        });
        return;
      }
      const failure = await dependencies.finalizeSetupFailure(operation, {
        status,
        error,
        code,
        extra,
        steps,
        evidence: typeof extra.azError === "string" ? extra.azError : null,
        runAz:
          runAzReady ?
            (args: string[]) => dependencies.external.runAz(args)
          : null
      });
      respond(context, failure.status, failure.body);
    };
    const checkpoint = () =>
      dependencies.persistMutationCheckpoint({
        operation,
        persist: () => dependencies.operations.persist(),
        report: (diagnostic) => dependencies.operations.report(diagnostic),
        fail
      });

    if (!targetRepo || !resourceGroup || !clusterName) {
      await fail(
        400,
        "repo, resourceGroup, and cluster are required.",
        "missing-params"
      );
      return;
    }
    if (!isValidRepoSlug(targetRepo)) {
      await fail(
        400,
        `Invalid repository "${targetRepo}". Expected "owner/repo".`,
        "invalid-repo"
      );
      return;
    }
    if (!isResourceGroupName(resourceGroup)) {
      await fail(
        400,
        `Invalid resource group name "${resourceGroup}".`,
        "invalid-resource-group"
      );
      return;
    }
    if (!isAksClusterName(clusterName)) {
      await fail(
        400,
        `Invalid cluster name "${clusterName}".`,
        "invalid-cluster"
      );
      return;
    }
    if (clusterResourceGroup && !isResourceGroupName(clusterResourceGroup)) {
      await fail(
        400,
        `Invalid cluster resource group name "${clusterResourceGroup}".`,
        "invalid-cluster-resource-group"
      );
      return;
    }
    if (data.tenantId && !isUuid(data.tenantId)) {
      await fail(
        400,
        `Invalid tenantId "${data.tenantId}" (expected a GUID).`,
        "invalid-tenant"
      );
      return;
    }
    if (data.subscriptionId && !isUuid(data.subscriptionId)) {
      await fail(
        400,
        `Invalid subscriptionId "${data.subscriptionId}" (expected a GUID).`,
        "invalid-subscription"
      );
      return;
    }
    if (serviceManagementReference && !isUuid(serviceManagementReference)) {
      await fail(
        400,
        `Invalid Service Management Reference "${serviceManagementReference}". It must be a GUID (for Microsoft-internal tenants, your Service Tree ID).`,
        "invalid-smr"
      );
      return;
    }
    if (!requestedSubscriptionId) {
      await fail(
        400,
        "subscriptionId is required so setup targets the selected profile, not the ambient Azure CLI default.",
        "subscription-required"
      );
      return;
    }

    steps = [];
    const continuationId =
      typeof data.operationId === "string" ? data.operationId : "";
    if (continuationId) {
      const existing = dependencies.operations.get(continuationId);
      if (
        !existing ||
        dependencies.operations.isStale(existing) ||
        existing.repo !== targetRepo ||
        existing.environment !== environment ||
        existing.provider !== "azure" ||
        existing.currentStage !== dependencies.stageAuthorizeIdentity ||
        (!isServerOwned && !existing.inputRequired)
      ) {
        await fail(
          409,
          "The setup operation cannot be resumed with these inputs.",
          "operation-continuation-mismatch"
        );
        return;
      }
      operation = existing;
      if (existing.inputRequired) {
        dependencies.operations.resumeAfterInput(operation);
      }
    } else {
      operation = dependencies.operations.create({
        provider: "azure",
        repo: targetRepo,
        environment,
        stages: dependencies.operations.buildStages(),
        journey: {
          origin: data.origin || null,
          resumeTarget: data.resumeTarget || null,
          resumeBranch: data.resumeBranch || null,
          resumeReason: data.resumeReason || null
        }
      });
      dependencies.operations.setContext(operation, {
        resourceGroup,
        clusterName,
        clusterResourceGroup,
        requestedAppName: requestedAppName || null
      });
      dependencies.operations.setCloudContext(operation, "azure", {
        subscriptionId: requestedSubscriptionId,
        tenantId: (data.tenantId || "").trim(),
        resourceGroup,
        clusterName
      });
      const started = dependencies.operations.start(operation);
      if (!started.ok) {
        operation = null;
        respond(context, 409, {
          error: `Setup is already running for ${targetRepo}.`,
          code: "operation-in-progress",
          operationId: started.conflict.operationId
        });
        return;
      }
      try {
        await dependencies.operations.persist();
      } catch (error) {
        dependencies.operations.report({
          code: "operation-store-write-failed",
          message: `Could not persist setup operation ${operation.operationId}: ${errorMessage(error)}`
        });
        dependencies.operations.finish(operation, "failed", {
          failure: {
            code: "operation-persistence-failed",
            stage: operation.currentStage,
            stepSeq: null,
            message:
              "Radius changed no cloud resources because it could not save the setup recovery record.",
            classification: "unknown"
          }
        });
        respond(context, 500, {
          error:
            "Radius changed no cloud resources because it could not save the setup recovery record.",
          code: "operation-persistence-failed",
          operationId: operation.operationId
        });
        return;
      }
    }
    dependencies.operations.enterStage(
      operation,
      dependencies.stageAuthorizeIdentity
    );

    const activeOperation = operation;
    const rawPush = steps.push.bind(steps);
    steps.push = (...items) => {
      for (const item of items) {
        try {
          dependencies.operations.addLegacyStep(activeOperation, item);
        } catch {
          // Narration is advisory and must never break setup.
        }
      }
      return rawPush(...items);
    };

    try {
      const identity = await dependencies.external.getGitHubIdentity();
      if (identity?.actingLogin) {
        dependencies.operations.setContext(operation, {
          githubLogin: identity.actingLogin
        });
        steps.push(`Acting on GitHub as @${identity.actingLogin}.`);
        if (identity.mismatch && identity.displayLogin) {
          steps.push(
            `⚠️ Note: the app shows @${identity.displayLogin} but setup is acting as @${identity.actingLogin}. If setup fails with a permission error, switch accounts in the Create Environment dialog.`
          );
        }
      }
    } catch {
      // Identity narration is advisory and never blocks setup.
    }

    const accessMessage =
      await dependencies.external.preflightRepoAdmin(targetRepo);
    if (accessMessage) {
      await fail(403, accessMessage, "repo-admin-required");
      return;
    }
    const packageAccess =
      await dependencies.external.preflightGhcrPackageWriteAccess();
    if (!packageAccess.ok) {
      await fail(
        packageAccess.status,
        packageAccess.error,
        packageAccess.code,
        { steps }
      );
      return;
    }
    runAzReady = true;

    const workflow: AzureAutoSetupWorkflow = {
      operation,
      steps,
      respond: (status, payload) => respond(context, status, payload),
      runAz: (args) => dependencies.external.runAz(args),
      runGitHubJson: (apiPath) => dependencies.external.runGitHubJson(apiPath),
      fail,
      checkpoint
    };

    let tenantId = (data.tenantId || "").trim();
    let subscriptionId = requestedSubscriptionId;
    steps.push(`Selecting subscription ${subscriptionId}...`);
    const setResult = await workflow.runAz([
      "account",
      "set",
      "--subscription",
      subscriptionId
    ]);
    if (setResult.code !== 0) {
      const detail = (setResult.stderr || "").trim();
      await fail(
        400,
        `Could not select subscription ${subscriptionId}. Ensure you are logged in ("az login") to an account with access, then try again.${
          detail ? " Azure CLI: " + detail : ""
        }`,
        "az-subscription-set-failed",
        { steps }
      );
      return;
    }
    steps.push("Checking Azure CLI login...");
    const accountResult = await workflow.runAz([
      "account",
      "show",
      "--output",
      "json"
    ]);
    if (accountResult.code !== 0) {
      await fail(
        400,
        'Azure CLI not logged in. Run "az login" first.',
        "az-not-logged-in",
        { steps }
      );
      return;
    }
    let account: Record<string, unknown>;
    try {
      account = record(JSON.parse(accountResult.stdout));
    } catch {
      await fail(
        400,
        'Could not parse "az account show" output.',
        "az-account-parse",
        { steps }
      );
      return;
    }
    const activeTenantId = optionalString(account.tenantId);
    subscriptionId = optionalString(account.id) || subscriptionId;
    if (
      tenantId &&
      activeTenantId &&
      tenantId.toLowerCase() !== activeTenantId.toLowerCase()
    ) {
      await fail(
        400,
        `Azure CLI is signed in to tenant ${activeTenantId}, but tenant ${tenantId} was requested. ` +
          `Run "az login --tenant ${tenantId}" and retry.`,
        "az-tenant-mismatch",
        { steps }
      );
      return;
    }
    tenantId = tenantId || activeTenantId;
    if (!isUuid(subscriptionId)) {
      await fail(
        400,
        `Resolved subscription id "${subscriptionId}" is not a valid GUID.`,
        "invalid-subscription",
        { steps }
      );
      return;
    }
    if (!activeTenantId) {
      await fail(
        400,
        'Could not determine the active Azure tenant. Run "az login" and "az account set --subscription <id>", then try again.',
        "az-account-incomplete",
        { steps }
      );
      return;
    }
    steps.push(`✅ Using subscription=${subscriptionId}, tenant=${tenantId}`);

    steps.push("Resolving GitHub OIDC subject...");
    const oidcSuffix = buildEnvironmentSuffix(environment);
    let oidc: ResolveOidcSubjectResult;
    try {
      oidc = await resolveOidcSubject(
        {
          targetRepo,
          envName: environment,
          suffix: oidcSuffix
        },
        (apiPath) => workflow.runGitHubJson(apiPath)
      );
    } catch (error) {
      await fail(
        400,
        errorMessage(error),
        errorCode(error, "oidc-subject-failed"),
        { steps }
      );
      return;
    }
    steps.push(
      `✅ OIDC subject(s): ${oidc.federatedCredentials
        .map((credential) => credential.subject)
        .join(", ")}`
    );

    const application = await resolveAzureAutoSetupApplication({
      workflow,
      dependencies,
      oidc,
      environment,
      explicitAppId,
      createNewApp,
      appNameProvided,
      requestedAppName,
      requestedClientId: (data.clientId || "").trim(),
      serviceManagementReference
    });
    if (!application) return;

    if (
      !(await configureAzureAutoSetupCredentials({
        workflow,
        dependencies,
        oidc,
        oidcSuffix,
        clientId: application.clientId,
        appName: application.appName,
        subscriptionId,
        resourceGroup,
        clusterResourceGroup,
        clusterName
      }))
    ) {
      return;
    }

    dependencies.operations.setStageState(
      operation,
      dependencies.stageAuthorizeIdentity,
      dependencies.operations.hasWarnings(operation) ? "warning" : "succeeded"
    );
    dependencies.operations.setContext(operation, {
      clientId: application.clientId,
      appName: application.appName
    });
    dependencies.operations.setCloudContext(operation, "azure", {
      subscriptionId,
      tenantId,
      resourceGroup,
      clusterName
    });
    respond(context, 200, {
      success: true,
      operationId: operation.operationId,
      clientId: application.clientId,
      tenantId,
      subscriptionId,
      resourceGroup,
      cluster: clusterName,
      appName: application.appName,
      subjects: oidc.federatedCredentials.map(
        (credential) => credential.subject
      ),
      steps
    });
  } catch (error) {
    const failure = await dependencies.finalizeSetupFailure(operation, {
      status: 400,
      error: errorMessage(error),
      code: "setup-unhandled",
      classification: "unknown",
      evidence: error instanceof Error ? error.stack || null : null,
      steps,
      runAz:
        runAzReady ?
          (args: string[]) => dependencies.external.runAz(args)
        : null
    });
    respond(context, failure.status, failure.body);
  }
}

export function createAzureAutoSetupRoutes(
  dependencies: AzureAutoSetupDependencies
): RouteHandlerRegistry {
  validateDependencies(dependencies);
  return {
    "POST /api/azure-auto-setup": (context) =>
      handleAzureAutoSetup(context, dependencies)
  };
}
