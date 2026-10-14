import {
  continuationMatchesLiveContext,
  runAzureSetup
} from "@radius-project/core";
export { parseAzureAccountIdentity } from "@radius-project/core";
import {
  createAzureApplicationPorts,
  createAzureCredentialPorts
} from "./azure-setup-adapter.js";
import { createAzureIdentityPresentation } from "./azure-setup-identity-presentation.js";
import { setupIdentityEqual } from "@radius-project/adapter-shared";
import {
  isAksClusterName,
  isResourceGroupName,
  isUuid,
  isValidRepoSlug
} from "../../azure-oidc.js";
import {
  createAzureAppCreateContinuation,
  matchAzureAppCreateContinuation,
  type AzureAppCreateContinuation,
  type AzureAppCreateContinuationSeed
} from "../../azure-app-create-continuation.js";
import type { CanvasRequestContext } from "../request-context.js";
import type { RouteHandlerRegistry } from "../route-table.js";
import { unresolvedProviderMutations } from "../../operations.js";
import type {
  AzureAutoSetupDependencies,
  AzureAutoSetupFailureInput,
  AzureAutoSetupOperation,
  AzureAutoSetupWorkflow
} from "./azure-auto-setup-types.js";
import { ProviderMutationRecoveryError } from "../services/provider-mutation-recovery.js";
import { setupStartConflictResponse } from "./operation-start-conflict.js";
import { selectedEnvironmentReader } from "../services/github-environment.js";

const OPERATION_FUNCTIONS = [
  "get",
  "isStale",
  "create",
  "buildStages",
  "start",
  "persist",
  "report",
  "finish",
  "getAzureAppCreateContinuation",
  "setAzureAppCreateContinuation",
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
  "recordFederatedCredentialProvenance",
  "withCredentialProvenanceLock",
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
    "honorStopBoundary",
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeFailureExtra(
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  const safe = { ...extra };
  delete safe.azError;
  delete safe.ghError;
  delete safe.appCreateContinuation;
  delete safe.appCreateContinuationAppName;
  delete safe.appCreateContinuationCallerObjectId;
  return safe;
}

function respond(context: CanvasRequestContext, status: number, body: unknown) {
  context.response.setHeader("Content-Type", "application/json");
  context.response.writeHead(status);
  context.response.end(JSON.stringify(body));
}

import { runSetupHttpHandler } from "./setup-http-failure.js";

export async function handleAzureAutoSetup(
  context: CanvasRequestContext,
  dependencies: AzureAutoSetupDependencies
): Promise<void> {
  await runSetupHttpHandler(
    context,
    () => runAzureAutoSetupRoute(context, dependencies),
    (diagnostic) => dependencies.operations.report(diagnostic)
  );
}

async function runAzureAutoSetupRoute(
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
  let finalizationStarted = false;
  let steps: string[] = [];
  let runAzReady = false;
  const githubCleanup: Pick<
    AzureAutoSetupFailureInput,
    "runGitHubVariable" | "runDeleteEnvironment" | "readEnvironment"
  > = {};
  const stopBoundary = async (boundary: string) => {
    const proceed = await dependencies.honorStopBoundary({
      operation,
      boundary,
      persist: () => dependencies.operations.persist(),
      report: (diagnostic) => dependencies.operations.report(diagnostic)
    });
    if (proceed) return true;
    respond(context, 200, {
      cancelled: true,
      code: "operation-stopped",
      boundary,
      operationId: operation?.operationId
    });
    return false;
  };
  try {
    const data = JSON.parse(body);
    const targetRepo = data.repo || "";
    const environment = data.environment || "dev";
    const operationEnvironment =
      typeof data.operationEnvironment === "string" ?
        data.operationEnvironment
      : environment;
    const resourceGroup = data.resourceGroup || "";
    const clusterName = data.cluster || "";
    const clusterResourceGroup = (data.clusterResourceGroup || "").trim();
    const serviceManagementReference = data.serviceManagementReference || "";
    const explicitAppId = (data.appId || "").trim();
    const createNewApp = data.createNew === true;
    const appNameProvided = typeof data.appName === "string";
    const requestedAppName = appNameProvided ? data.appName : "";
    const requestedSubscriptionId = (data.subscriptionId || "").trim();
    const requestedTenantId = (data.tenantId || "").trim();
    const requestedClientId = (data.clientId || "").trim();
    const continuationRequest = {
      repo: targetRepo,
      environment,
      operationEnvironment,
      requestedSubscriptionId,
      requestedTenantId,
      resourceGroup,
      clusterResourceGroup,
      clusterName,
      explicitAppId,
      createNewApp,
      appNameProvided,
      requestedAppName,
      requestedClientId
    };
    let appCreateContinuationSeed: AzureAppCreateContinuationSeed | null = null;
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
        if (code === "service-management-reference-required") {
          const inputRequired = record(operation.inputRequired);
          const appName = extra.appCreateContinuationAppName;
          const callerObjectId = extra.appCreateContinuationCallerObjectId;
          dependencies.operations.setAzureAppCreateContinuation(
            operation,
            (
              appCreateContinuationSeed &&
                typeof appName === "string" &&
                typeof callerObjectId === "string" &&
                typeof inputRequired.requestedAt === "string"
            ) ?
              createAzureAppCreateContinuation(
                appCreateContinuationSeed,
                appName,
                callerObjectId,
                inputRequired.requestedAt
              )
            : null
          );
        }
        await dependencies.operations.persist();
        if (!(await stopBoundary("input_prompt"))) return;
        respond(context, status, {
          error,
          inputRequired: true,
          ...(code ? { code } : {}),
          operationId: operation.operationId,
          ...sanitizeFailureExtra(extra)
        });
        return;
      }
      if (!(await stopBoundary("before-azure-failure-cleanup"))) return;
      finalizationStarted = true;
      const failure = await dependencies.finalizeSetupFailure(operation, {
        ...githubCleanup,
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
    const checkpoint = async (boundary: string) => {
      const saved = await dependencies.persistMutationCheckpoint({
        operation,
        persist: () => dependencies.operations.persist(),
        report: (diagnostic) => dependencies.operations.report(diagnostic),
        fail
      });
      if (!saved) return false;
      return stopBoundary(boundary);
    };

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
    let appCreateContinuation: AzureAppCreateContinuation | null = null;
    const continuationId =
      typeof data.operationId === "string" ? data.operationId : "";
    if (continuationId) {
      const existing = dependencies.operations.get(continuationId);
      if (
        !existing ||
        dependencies.operations.isStale(existing) ||
        existing.repo !== targetRepo ||
        existing.environment !== operationEnvironment ||
        existing.provider !== "azure" ||
        existing.currentStage !== dependencies.stageAuthorizeIdentity
      ) {
        await fail(
          409,
          "The setup operation cannot be resumed with these inputs.",
          "operation-continuation-mismatch"
        );
        return;
      }
      operation = existing;
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
        respond(context, 409, setupStartConflictResponse(targetRepo, started));
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
    const continuationInputRequired = operation.inputRequired;
    const continuationOperationState = operation.state;
    if (operation.inputRequired) {
      dependencies.operations.resumeAfterInput(operation);
    }
    dependencies.operations.enterStage(
      operation,
      dependencies.stageAuthorizeIdentity
    );
    const selectedExecutor = dependencies.external.getSelectedGitHubExecutor(
      operation.operationId
    );
    if (!selectedExecutor) {
      await fail(
        409,
        "The selected GitHub account executor is unavailable. Re-check the account and retry.",
        "github-selection-unavailable"
      );
      return;
    }
    githubCleanup.runDeleteEnvironment = async (args) => {
      const result = await selectedExecutor.run(args, { timeout: 20000 });
      if (result.timedOut) {
        throw new Error(
          "Outcome unknown after provider timeout; Radius must confirm whether the GitHub environment was removed."
        );
      }
      if (result.code !== 0 && result.code !== "0") {
        throw new Error(
          (result.stderr || result.stdout).trim() ||
            "Could not delete the GitHub environment."
        );
      }
    };
    githubCleanup.readEnvironment = selectedEnvironmentReader(selectedExecutor);
    githubCleanup.runGitHubVariable = (args) =>
      selectedExecutor.run(args, { timeout: 20000 });
    const savedAppCreateContinuation =
      dependencies.operations.getAzureAppCreateContinuation(operation);
    if (continuationInputRequired || savedAppCreateContinuation) {
      appCreateContinuation = matchAzureAppCreateContinuation(
        savedAppCreateContinuation,
        {
          operationId: operation.operationId,
          operationState: continuationOperationState,
          inputRequired: continuationInputRequired,
          request: continuationRequest,
          serviceManagementReference,
          githubExecutor: selectedExecutor
        }
      );
      dependencies.operations.setAzureAppCreateContinuation(operation, null);
    }
    await selectedExecutor.verifyIdentity();
    if (
      appCreateContinuation &&
      !(await continuationMatchesLiveContext(
        appCreateContinuation,
        targetRepo,
        environment,
        {
          runAz: dependencies.external.runAz,
          runGitHubJson: (path) =>
            dependencies.external.runGitHubJson(path, selectedExecutor),
          deepEqual: setupIdentityEqual
        }
      ))
    ) {
      appCreateContinuation = null;
    }

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
      dependencies.operations.setContext(operation, {
        githubLogin: selectedExecutor.login,
        githubCredentialSource: selectedExecutor.credentialSource
      });
      steps.push(`Acting on GitHub as @${selectedExecutor.login}.`);
    } catch {
      // Identity narration is advisory and never blocks setup.
    }

    const reconcilingProviderMutation =
      unresolvedProviderMutations(operation).length > 0;
    if (!reconcilingProviderMutation && !appCreateContinuation) {
      const accessMessage = await dependencies.external.preflightRepoAdmin(
        targetRepo,
        selectedExecutor
      );
      if (accessMessage) {
        await fail(403, accessMessage, "repo-admin-required");
        return;
      }
      const packageAccess =
        await dependencies.external.preflightGhcrPackageWriteAccess(
          selectedExecutor
        );
      if (!packageAccess.ok) {
        await fail(
          packageAccess.status,
          packageAccess.error,
          packageAccess.code,
          { steps }
        );
        return;
      }
    }
    runAzReady = true;

    const workflow: AzureAutoSetupWorkflow = {
      operation,
      steps,
      respond: (status, payload) => respond(context, status, payload),
      runAz: (args) => dependencies.external.runAz(args),
      runGitHubJson: (apiPath) =>
        dependencies.external.runGitHubJson(apiPath, selectedExecutor),
      fail,
      stopBoundary,
      checkpoint
    };

    const result = await runAzureSetup(
      {
        request: continuationRequest,
        serviceManagementReference,
        continuation: appCreateContinuation
      },
      {
        application: createAzureApplicationPorts(workflow, dependencies),
        credentials: createAzureCredentialPorts(workflow, dependencies),
        ...createAzureIdentityPresentation(workflow),
        prepareContinuation(resolved) {
          appCreateContinuationSeed = {
            operationId: workflow.operation.operationId,
            request: continuationRequest,
            githubExecutor: {
              login: selectedExecutor.login,
              credentialSource: selectedExecutor.credentialSource,
              requiresKeyringSwitch: selectedExecutor.requiresKeyringSwitch,
              scopes: selectedExecutor.scopes
            },
            resolved
          };
        }
      }
    );
    if (result.kind !== "completed") return;
    const { application, subscriptionId, tenantId } = result;

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
      subjects: result.subjects,
      steps
    });
  } catch (error) {
    if (finalizationStarted) throw error;
    if (
      error instanceof ProviderMutationRecoveryError &&
      error.code === "provider-mutation-outcome-unknown" &&
      operation
    ) {
      respond(context, 202, {
        operationId: operation.operationId,
        code: error.code,
        reconciling: true,
        message: error.message
      });
      return;
    }
    if (!(await stopBoundary("before-azure-failure-cleanup"))) return;
    const failure = await dependencies.finalizeSetupFailure(operation, {
      ...githubCleanup,
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
