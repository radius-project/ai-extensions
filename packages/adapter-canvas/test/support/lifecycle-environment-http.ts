import { createServer } from "node:http";
import type { LifecycleBinding } from "../../src/runtime/create-lifecycle-binding.js";
import { createOperationsStatusRoutes } from "../../src/server/routes/operations-status.js";
import { createOperationsControlRoutes } from "../../src/server/routes/operations-control.js";
import { createCanvasServer } from "../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../src/server/create-request-handler.js";
import { validateBrowserMutationRequest } from "../../src/server/browser-mutation.js";
import { createTestRouteTable } from "./server/route-table.js";
import { createEnvironmentFixture } from "./lifecycle-environments.js";

export function createLifecycleSetupRoutes(
  binding: LifecycleBinding | undefined
) {
  const unexpected = (): never => {
    throw new Error("Canonical setup attempted legacy scheduling or mutation.");
  };
  const lifecycle = () => binding;
  return {
    ...createOperationsStatusRoutes(
      {
        lifecycle,
        latest: () => null,
        latestAny: () => null,
        get: () => null,
        toClientView: unexpected,
        productVersion: () => "fixture",
        now: () => 0
      },
      {
        lifecycle,
        isValidRepoSlug: unexpected,
        isResourceGroupName: unexpected,
        isAksClusterName: unexpected,
        isKubernetesNamespace: unexpected,
        isUuid: unexpected,
        buildStages: unexpected,
        createOperation: unexpected,
        claimSelectionHandle: unexpected,
        startConflict: unexpected,
        startOperation: unexpected,
        persistOperations: unexpected,
        finish: unexpected,
        scheduleEnvironmentOperation: unexpected,
        errorMessage: unexpected
      },
      {
        getOperation: () => null,
        canResumeInput: unexpected,
        resumeAfterInput: unexpected,
        requireInput: unexpected,
        finish: unexpected,
        isTerminalState: unexpected,
        canDismissOperation: unexpected,
        dismissOperation: unexpected,
        persistOperations: unexpected,
        toClientView: unexpected,
        scheduleEnvironmentOperation: unexpected,
        errorMessage: unexpected,
        inputRequiredState: "input_required"
      }
    ),
    ...createOperationsControlRoutes({
      lifecycle,
      get: () => null,
      acquireForRetry: unexpected,
      persistOperations: unexpected,
      checkPullRequestMerge: unexpected,
      schedule: unexpected,
      invalidateEnvironmentListing: unexpected,
      inspectVerificationWorkflow: unexpected,
      cancelVerificationWorkflow: unexpected
    })
  };
}

export async function createEnvironmentHttpFixture(
  provider: "azure" | "aws" = "azure",
  options: { lifecycleAvailable?: boolean } = {}
) {
  const fixture = await createEnvironmentFixture(provider);
  const routes = createTestRouteTable(
    createLifecycleSetupRoutes(
      options.lifecycleAvailable === false ? undefined : fixture.binding
    )
  );
  const nonce = "fixture-browser-nonce";
  const container = createCanvasServer({
    createHttpServer: (handler) => createServer(handler),
    createRequestHandler: ({ instanceId, instances, markActivity }) =>
      createRequestHandler({
        instanceId,
        instances,
        routes,
        markActivity,
        validateBrowserMutation: (context) =>
          validateBrowserMutationRequest({
            request: context.request,
            baseUrl: instances.get(instanceId)?.baseUrl ?? "",
            nonce
          }),
        handleUnmatchedRequest: (_request, response) => {
          response.writeHead(404);
          response.end("unmatched");
        }
      }),
    createState: () => ({ browserMutationNonce: nonce }),
    defaultPage: "environment",
    now: () => 0,
    preferredPort: async () => 0,
    prepareIdentity: () => {}
  });
  const entry = await container.getOrCreate("setup-panel");
  const headers = {
    "Content-Type": "application/json",
    Origin: entry.baseUrl,
    "Sec-Fetch-Site": "same-origin",
    "X-Radius-Mutation-Nonce": nonce
  };
  return {
    ...fixture,
    url: entry.baseUrl,
    headers,
    post: (path: string, value: unknown) =>
      fetch(`${entry.baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(value)
      }),
    close: async () => {
      await container.stopAll();
      await fixture.close();
    }
  };
}
