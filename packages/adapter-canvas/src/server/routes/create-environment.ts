import type { IncomingMessage } from "node:http";
import type { CanvasRequestContext } from "../request-context.js";
import type { RouteHandlerRegistry } from "../route-table.js";
import {
  createConfigureEnvironmentService,
  type ConfigureEnvironmentDependencies
} from "../services/configure-environment.js";
import {
  refuseUnlessServerOwned,
  type CreateEnvironmentRequestData
} from "./create-environment-refusals.js";
import type { SetupInput } from "../services/setup-outcome.js";
import { runSetupHttpHandler } from "./setup-http-failure.js";

export type { CreateEnvironmentInstanceEntry } from "../services/configure-environment.js";
export interface CreateEnvironmentDependencies extends ConfigureEnvironmentDependencies {
  isServerOwnedRequest(instanceId: string, request: IncomingMessage): boolean;
}

export async function handleCreateEnvironment(
  context: CanvasRequestContext,
  dependencies: CreateEnvironmentDependencies,
  setup?: ReturnType<typeof createConfigureEnvironmentService>
): Promise<void> {
  return runSetupHttpHandler(
    context,
    async () => {
      const respond = (status: number, body: unknown) => {
        context.response.setHeader("Content-Type", "application/json");
        context.response.writeHead(status);
        context.response.end(JSON.stringify(body));
      };
      const refusal = refuseUnlessServerOwned(
        dependencies.isServerOwnedRequest(context.instanceId, context.request)
      );
      if (refusal) {
        respond(refusal.status, refusal.body);
        return;
      }
      const body = await context.readTextBody();
      let input: SetupInput<CreateEnvironmentRequestData>;
      try {
        input = { data: JSON.parse(body) };
      } catch (error) {
        input = { error };
      }
      const outcome = await (
        setup ?? createConfigureEnvironmentService(dependencies)
      )(input, context.instanceId);
      respond(outcome.status, outcome.body);
    },
    dependencies.reportOperationDiagnostic
  );
}

export function createCreateEnvironmentRoutes(
  dependencies: CreateEnvironmentDependencies,
  setup?: ReturnType<typeof createConfigureEnvironmentService>
): RouteHandlerRegistry {
  if (typeof dependencies.isServerOwnedRequest !== "function") {
    throw new Error(
      "Missing environment configuration dependency: isServerOwnedRequest"
    );
  }
  const service = setup ?? createConfigureEnvironmentService(dependencies);
  return {
    "POST /api/create-environment": (context) =>
      handleCreateEnvironment(context, dependencies, service)
  };
}
