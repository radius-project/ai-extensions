import {
  runAzureAutoSetup,
  validateAzureAutoSetupDependencies,
  type AzureAutoSetupRequest
} from "@radius-project/core/github-radius/environments/azure-auto-setup";
import { deterministicProviderUuid } from "@radius-project/adapter-shared/github-radius/environments/provider-uuid";
import type { CanvasRequestContext } from "../request-context.js";
import type { RouteHandlerRegistry } from "../route-table.js";
import type { AzureAutoSetupDependencies } from "./azure-auto-setup-types.js";
import * as operationDomain from "../../operations.js";

export { parseAzureAccountIdentity } from "@radius-project/core/github-radius/environments/azure-auto-setup";

export function azureAutoSetupDependencies(
  dependencies: AzureAutoSetupDependencies
) {
  return { ...dependencies, deterministicProviderUuid, operationDomain };
}

export async function handleAzureAutoSetup(
  context: CanvasRequestContext,
  dependencies: AzureAutoSetupDependencies
): Promise<void> {
  const respond = (status: number, body: Record<string, unknown>) => {
    context.response.setHeader("Content-Type", "application/json");
    context.response.writeHead(status);
    context.response.end(JSON.stringify(body));
  };
  if (!dependencies.isServerOwnedRequest(context.instanceId, context.request)) {
    respond(403, {
      error: "This endpoint is reserved for server-owned operations.",
      code: "server-owned-operation-required"
    });
    return;
  }
  const body = await context.readTextBody();
  let data: AzureAutoSetupRequest;
  try {
    data = JSON.parse(body);
  } catch (error) {
    const proceed = await dependencies.honorStopBoundary({
      operation: null,
      boundary: "before-azure-failure-cleanup",
      persist: () => dependencies.operations.persist(),
      report: (diagnostic) => dependencies.operations.report(diagnostic)
    });
    if (!proceed) {
      respond(200, {
        cancelled: true,
        code: "operation-stopped",
        boundary: "before-azure-failure-cleanup"
      });
      return;
    }
    const failure = await dependencies.finalizeSetupFailure(null, {
      status: 400,
      error: error instanceof Error ? error.message : String(error),
      code: "setup-unhandled",
      classification: "unknown",
      evidence: error instanceof Error ? error.stack || null : null,
      steps: [],
      runAz: null
    });
    respond(failure.status, failure.body);
    return;
  }
  const result = await runAzureAutoSetup(
    data,
    azureAutoSetupDependencies(dependencies)
  );
  respond(result.status, result.body);
}

export function createAzureAutoSetupRoutes(
  dependencies: AzureAutoSetupDependencies
): RouteHandlerRegistry {
  if (typeof dependencies.isServerOwnedRequest !== "function") {
    throw new Error(
      "Missing Azure auto-setup dependency: isServerOwnedRequest"
    );
  }
  validateAzureAutoSetupDependencies(azureAutoSetupDependencies(dependencies));
  return {
    "POST /api/azure-auto-setup": (context) =>
      handleAzureAutoSetup(context, dependencies)
  };
}
