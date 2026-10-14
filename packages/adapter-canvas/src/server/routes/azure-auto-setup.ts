import type { CanvasRequestContext } from "../request-context.js";
import type { RouteHandlerRegistry } from "../route-table.js";
import type { AzureAutoSetupDependencies } from "./azure-auto-setup-types.js";
import {
  createAzureSetupService,
  type AzureSetupRequest
} from "../services/azure-setup.js";
import type { SetupInput } from "../services/setup-outcome.js";
import { runSetupHttpHandler } from "./setup-http-failure.js";
export { parseAzureAccountIdentity } from "@radius-project/core";

export async function handleAzureAutoSetup(
  context: CanvasRequestContext,
  dependencies: AzureAutoSetupDependencies,
  setup?: ReturnType<typeof createAzureSetupService>
): Promise<void> {
  return runSetupHttpHandler(
    context,
    async () => {
      const respond = (status: number, body: unknown) => {
        context.response.setHeader("Content-Type", "application/json");
        context.response.writeHead(status);
        context.response.end(JSON.stringify(body));
      };
      if (
        !dependencies.isServerOwnedRequest(context.instanceId, context.request)
      ) {
        respond(403, {
          error: "This endpoint is reserved for server-owned operations.",
          code: "server-owned-operation-required"
        });
        return;
      }
      const body = await context.readTextBody();
      let input: SetupInput<AzureSetupRequest>;
      try {
        input = { data: JSON.parse(body) };
      } catch (error) {
        input = { error };
      }
      const outcome = await (setup ?? createAzureSetupService(dependencies))(
        input
      );
      respond(outcome.status, outcome.body);
    },
    (diagnostic) => dependencies.operations.report(diagnostic)
  );
}

export function createAzureAutoSetupRoutes(
  dependencies: AzureAutoSetupDependencies,
  setup?: ReturnType<typeof createAzureSetupService>
): RouteHandlerRegistry {
  if (typeof dependencies.isServerOwnedRequest !== "function") {
    throw new Error(
      "Missing Azure auto-setup dependency: isServerOwnedRequest"
    );
  }
  const service = setup ?? createAzureSetupService(dependencies);
  return {
    "POST /api/azure-auto-setup": (context) =>
      handleAzureAutoSetup(context, dependencies, service)
  };
}
