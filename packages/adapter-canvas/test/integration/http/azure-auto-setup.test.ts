import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import {
  addLegacyStep,
  canDismissOperation,
  canResumeInput,
  createOperation,
  dismissOperation,
  finish,
  fromPersistedOperation,
  INPUT_REQUIRED_STATE,
  isTerminalState,
  requireInput,
  resumeAfterInput,
  toClientView,
  toPersistedOperation
} from "../../../src/operations.js";
import { ENTRA_APP_RETENTION_NOTICE } from "../../../src/server/routes/azure-auto-setup-application.js";
import { createAzureAutoSetupRoutes } from "../../../src/server/routes/azure-auto-setup.js";
import {
  createOperationsStatusRoutes,
  type OperationActionRecord
} from "../../../src/server/routes/operations-status.js";
import { buildRadiusAppProvenanceTags } from "../../../src/azure-oidc.js";
import { deterministicProviderUuid } from "../../../src/server/services/provider-mutation-recovery.js";
import type {
  AzureAutoSetupCommandResult,
  AzureAutoSetupDependencies,
  AzureAutoSetupFailureInput,
  AzureAutoSetupOperation
} from "../../../src/server/routes/azure-auto-setup-types.js";
import type { CanvasServerContainer } from "../../../src/server/create-canvas-server.js";
import type { RouteHandlerRegistry } from "../../../src/server/route-table.js";
import {
  createAzureAutoSetupTestDependencies,
  type FakeCallerIdentity
} from "../../support/server/azure-auto-setup.js";
import { createTestRouteTable } from "../../support/server/route-table.js";

const SUBSCRIPTION = "22222222-2222-2222-2222-222222222222";
const TENANT = "11111111-1111-1111-1111-111111111111";
const APP_ID = "33333333-3333-3333-3333-333333333333";
const OBJECT_ID = "44444444-4444-4444-4444-444444444444";
const SP_APP_ID = "55555555-5555-5555-5555-555555555555";
const SP_OBJECT_ID = "66666666-6666-6666-6666-666666666666";

let container: CanvasServerContainer | undefined;

afterEach(async () => {
  await container?.stopAll();
  container = undefined;
});

function start(
  dependencies: AzureAutoSetupDependencies,
  unmatchedCalls: string[] = [],
  additionalRoutes: RouteHandlerRegistry = {}
): void {
  const routes = createTestRouteTable({
    ...createAzureAutoSetupRoutes(dependencies),
    ...additionalRoutes
  });
  container = createCanvasServer({
    createHttpServer: (handler) => createServer(handler),
    createRequestHandler: ({ instanceId, instances, markActivity }) =>
      createRequestHandler({
        instanceId,
        instances,
        routes,
        markActivity,
        validateBrowserMutation: () => true,
        handleUnmatchedRequest: (request, response) => {
          unmatchedCalls.push(request.url || "");
          response.writeHead(404);
          response.end("unmatched");
        }
      }),
    createState: () => ({}),
    defaultPage: "graph",
    now: () => Date.now(),
    preferredPort: async () => 0,
    prepareIdentity: () => {}
  });
}

async function entry(instanceId = "panel-a") {
  if (!container) throw new Error("Azure auto-setup server was not started.");
  return container.getOrCreate(instanceId);
}

function finalizer() {
  return async (
    _operation: AzureAutoSetupOperation | null,
    input: AzureAutoSetupFailureInput
  ) => ({
    status: Number(input.status),
    body: { error: String(input.error), code: String(input.code) }
  });
}

const VALID_BODY = {
  repo: "octo/app",
  environment: "dev",
  resourceGroup: "rg-radius",
  cluster: "aks-radius",
  subscriptionId: SUBSCRIPTION,
  clientId: APP_ID
};

const CREATE_BODY = {
  repo: "octo/app",
  environment: "dev",
  resourceGroup: "rg-radius",
  cluster: "aks-radius",
  subscriptionId: SUBSCRIPTION,
  appName: "radius-deploy-octo-app"
};

async function successfulSetup(
  createApp: boolean,
  caller: FakeCallerIdentity = { type: "user" },
  options: {
    requireSmrPrompt?: boolean;
    liveDrift?: "caller" | "oidc";
    publicResume?: boolean;
  } = {}
) {
  const unmatchedCalls: string[] = [];
  const azCalls: string[] = [];
  const githubCalls: string[] = [];
  const ownerObjectId =
    caller.type === "servicePrincipal" ? SP_OBJECT_ID : OBJECT_ID;
  let callerReads = 0;
  let repositoryReads = 0;
  let credentialContents = "";
  let operation: AzureAutoSetupOperation =
    options.requireSmrPrompt ?
      (createOperation({
        operationId: "op_http_smr",
        repo: "octo/app",
        environment: "dev",
        provider: "azure"
      }) as AzureAutoSetupOperation)
    : {
        operationId: createApp ? "op-http-create" : "op-http-reuse",
        repo: "octo/app",
        environment: "dev",
        provider: "azure",
        currentStage: "authorize_identity",
        steps: [] as Array<{ label: string }>
      };
  operation.currentStage = "authorize_identity";
  if (options.publicResume) {
    const request = {
      azure: {
        ...CREATE_BODY,
        serviceManagementReference: ""
      }
    };
    Object.assign(operation, {
      request,
      resumeRequest: structuredClone(request)
    });
  }
  let persistedOperation: ReturnType<typeof toPersistedOperation> | null = null;
  let scheduledPersistedOperation: ReturnType<
    typeof toPersistedOperation
  > | null = null;
  let baseUrl = "";
  let scheduledAttempt: Promise<Response> | null = null;
  const requiredTags = buildRadiusAppProvenanceTags({
    repo: "octo/app",
    environment: "dev",
    operationId: operation.operationId
  });
  const runAz = async (
    args: string[]
  ): Promise<AzureAutoSetupCommandResult> => {
    const line = args.join(" ");
    azCalls.push(line);
    if (line.startsWith("account set "))
      return { code: 0, stdout: "", stderr: "" };
    if (line === "account show --output json") {
      return {
        code: 0,
        stdout: JSON.stringify({
          id: SUBSCRIPTION,
          tenantId: TENANT,
          user: {
            type: caller.type ?? "user",
            name: caller.name ?? "dev@contoso.com"
          }
        }),
        stderr: ""
      };
    }
    if (line.startsWith(`ad app show --id ${APP_ID} --query id`)) {
      return { code: 0, stdout: "app-object", stderr: "" };
    }
    if (createApp && line.startsWith("ad app list ")) {
      return { code: 0, stdout: "[]", stderr: "" };
    }
    if (createApp && line.startsWith("ad app create ")) {
      if (
        options.requireSmrPrompt &&
        !line.includes("--service-management-reference")
      ) {
        return {
          code: 1,
          stdout: "",
          stderr: "ServiceManagementReference is required by directory policy"
        };
      }
      return { code: 0, stdout: APP_ID, stderr: "" };
    }
    if (caller.type === "user" && line.startsWith("ad signed-in-user show ")) {
      callerReads += 1;
      return {
        code: 0,
        stdout:
          options.liveDrift === "caller" && callerReads === 2 ?
            "77777777-7777-7777-7777-777777777777"
          : ownerObjectId,
        stderr: ""
      };
    }
    if (
      caller.type === "servicePrincipal" &&
      line === `ad sp show --id ${SP_APP_ID} --query id -o tsv`
    ) {
      return { code: 0, stdout: ownerObjectId, stderr: "" };
    }
    if (
      createApp &&
      line ===
        `ad app owner add --id ${APP_ID} --owner-object-id ${ownerObjectId}`
    ) {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (line.startsWith(`ad app owner list --id ${APP_ID}`)) {
      return { code: 0, stdout: ownerObjectId, stderr: "" };
    }
    if (createApp && line.startsWith("rest --method PATCH ")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (
      createApp &&
      line.startsWith(`ad app show --id ${APP_ID} --query tags`)
    ) {
      return {
        code: 0,
        stdout: JSON.stringify(requiredTags),
        stderr: ""
      };
    }
    if (line.startsWith(`ad app show --id ${APP_ID} --query tags`)) {
      // Reuse-origin classification reads the existing app's Radius provenance
      // tags. A plainly reused app carries none, so it classifies as
      // pre-existing and the success contract is unchanged.
      return { code: 0, stdout: "[]", stderr: "" };
    }
    if (line.includes("federated-credential list")) {
      return { code: 0, stdout: "[]", stderr: "" };
    }
    if (line.includes("federated-credential create")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (line.includes("federated-credential show")) {
      // The credential setup re-reads the just-created FIC to prove provenance.
      // Echo the contents that were written to the temp file so the live
      // identity (subject/issuer/audiences) matches what setup requires.
      const contents = JSON.parse(credentialContents);
      return {
        code: 0,
        stdout: JSON.stringify({ id: "fic-dev", ...contents }),
        stderr: ""
      };
    }
    if (line.startsWith("role assignment create ")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unscripted az call: ${line}`);
  };
  const dependencies = createAzureAutoSetupTestDependencies({
    isServerOwnedRequest: (_instanceId, request) =>
      request.headers["x-radius-server-owned"] === "token-a",
    operations: {
      create: () => operation,
      get: () => operation,
      persist: async () => {
        if (options.requireSmrPrompt) {
          persistedOperation = toPersistedOperation(operation);
        }
      },
      addLegacyStep,
      requireInput,
      resumeAfterInput
    },
    external: {
      getGitHubIdentity: async () => null,
      preflightRepoAdmin: async () => "",
      preflightGhcrPackageWriteAccess: async () => ({ ok: true }),
      runGitHubJson: async (path) => {
        githubCalls.push(path);
        if (path === "/repos/octo/app") {
          repositoryReads += 1;
          return {
            ok: true,
            status: 200,
            json: {
              full_name: "octo/app",
              id: options.liveDrift === "oidc" && repositoryReads === 2 ? 6 : 5,
              owner: { id: 7 }
            }
          };
        }
        if (path === "/repos/octo/app/actions/oidc/customization/sub") {
          return { ok: false, status: 404, json: null };
        }
        if (
          createApp &&
          path === "/repos/octo/app/environments/dev/variables/AZURE_CLIENT_ID"
        ) {
          return { ok: false, status: 404, json: null };
        }
        throw new Error(`unscripted GitHub call: ${path}`);
      },
      runAz
    },
    tempFile: {
      createPath: () => "C:\\temp\\fic.json",
      write: (_path, contents) => {
        credentialContents = contents;
      },
      remove: () => {}
    },
    ensureServicePrincipal: async () => ({
      ok: true,
      state: "reused",
      origin: "pre_existing",
      objectId: OBJECT_ID
    }),
    persistMutationCheckpoint: async (input) => {
      await input.persist();
      return true;
    },
    finalizeSetupFailure: async (_setup, input) => {
      throw new Error(`unexpected setup failure: ${String(input.code)}`);
    },
    sleep: async () => {}
  });
  const operationRoutes =
    options.publicResume ?
      createOperationsStatusRoutes(
        {
          latest: () => null,
          latestAny: () => null,
          get: () => operation,
          toClientView,
          productVersion: () => "test",
          now: () => Date.now()
        },
        {
          isValidRepoSlug: () => true,
          isResourceGroupName: () => true,
          isAksClusterName: () => true,
          isKubernetesNamespace: () => true,
          isUuid: () => true,
          buildStages: () => [],
          createOperation: () => ({ ...operation }),
          claimSelectionHandle: () => {
            throw new Error("operation creation is not expected");
          },
          startConflict: () => null,
          startOperation: () => {
            throw new Error("operation creation is not expected");
          },
          persistOperations: () => dependencies.operations.persist(),
          finish,
          scheduleEnvironmentOperation: () => {
            throw new Error("operation creation is not expected");
          },
          errorMessage: (error) =>
            error instanceof Error ? error.message : String(error)
        },
        {
          getOperation: () => operation as OperationActionRecord,
          canResumeInput,
          resumeAfterInput,
          requireInput,
          finish,
          isTerminalState,
          canDismissOperation,
          dismissOperation,
          persistOperations: () => dependencies.operations.persist(),
          toClientView,
          scheduleEnvironmentOperation: (_instanceId, scheduledOperation) => {
            scheduledPersistedOperation =
              toPersistedOperation(scheduledOperation);
            const request = scheduledOperation.request as {
              azure: Record<string, unknown>;
            };
            scheduledAttempt = fetch(`${baseUrl}/api/azure-auto-setup`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Radius-Server-Owned": "token-a"
              },
              body: JSON.stringify({
                ...CREATE_BODY,
                ...request.azure,
                operationId: scheduledOperation.operationId
              })
            });
            return true;
          },
          errorMessage: (error) =>
            error instanceof Error ? error.message : String(error),
          inputRequiredState: INPUT_REQUIRED_STATE
        }
      )
    : {};
  start(dependencies, unmatchedCalls, operationRoutes);
  const running = await entry();
  baseUrl = running.baseUrl;
  return {
    get operation() {
      return operation;
    },
    running,
    unmatchedCalls,
    azCalls,
    githubCalls,
    persistedOperation: () => persistedOperation,
    scheduledPersistedOperation: () => scheduledPersistedOperation,
    restorePersistedOperation: () => {
      if (!persistedOperation) {
        throw new Error("No Azure setup operation was persisted.");
      }
      operation = fromPersistedOperation(
        persistedOperation
      ) as AzureAutoSetupOperation;
      return operation;
    },
    scheduledAttempt: () => {
      if (!scheduledAttempt) {
        throw new Error("The public resume route did not schedule setup.");
      }
      return scheduledAttempt;
    }
  };
}

describe("POST /api/azure-auto-setup real-loopback HTTP contracts (RF-03)", () => {
  it("preserves method mismatch, malformed-body, refusal, and unmatched behavior", async () => {
    const tokens = new Map([
      ["panel-a", "token-a"],
      ["panel-b", "token-b"]
    ]);
    start(
      createAzureAutoSetupTestDependencies({
        isServerOwnedRequest: (instanceId, request) =>
          request.headers["x-radius-server-owned"] === tokens.get(instanceId),
        finalizeSetupFailure: finalizer()
      })
    );
    const first = await entry("panel-a");
    const second = await entry("panel-b");

    const wrongMethod = await fetch(`${first.baseUrl}/api/azure-auto-setup`);
    expect(wrongMethod.status).toBe(404);
    expect(await wrongMethod.text()).toBe("unmatched");

    const refused = await fetch(`${first.baseUrl}/api/azure-auto-setup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Radius-Server-Owned": "token-b"
      },
      body: JSON.stringify(VALID_BODY)
    });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toBe(
      '{"error":"This endpoint is reserved for server-owned operations.","code":"server-owned-operation-required"}'
    );

    const malformed = await fetch(`${second.baseUrl}/api/azure-auto-setup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Radius-Server-Owned": "token-b"
      },
      body: "{oops"
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "setup-unhandled" });
  });

  it("surfaces a selected-subscription failure with the legacy status, headers, and body", async () => {
    const operation: AzureAutoSetupOperation = {
      operationId: "op-failure",
      repo: "octo/app",
      environment: "dev",
      provider: "azure",
      currentStage: "authorize_identity"
    };
    start(
      createAzureAutoSetupTestDependencies({
        isServerOwnedRequest: (_instanceId, request) =>
          request.headers["x-radius-server-owned"] === "token-a",
        operations: { create: () => operation },
        external: {
          getGitHubIdentity: async () => null,
          preflightRepoAdmin: async () => "",
          preflightGhcrPackageWriteAccess: async () => ({ ok: true }),
          runAz: async (args) => {
            if (args.join(" ").startsWith("account set ")) {
              return {
                code: 1,
                stdout: "",
                stderr: "subscription unavailable"
              };
            }
            throw new Error(`unscripted az call: ${args.join(" ")}`);
          }
        },
        finalizeSetupFailure: finalizer()
      })
    );
    const running = await entry();
    const response = await fetch(`${running.baseUrl}/api/azure-auto-setup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Radius-Server-Owned": "token-a"
      },
      body: JSON.stringify(VALID_BODY)
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({
      error:
        'Could not select subscription 22222222-2222-2222-2222-222222222222. Ensure you are logged in ("az login") to an account with access, then try again. Azure CLI: subscription unavailable',
      code: "az-subscription-set-failed"
    });
  });

  it("preserves the reused-client-id success contract", async () => {
    const { running, unmatchedCalls, azCalls } = await successfulSetup(false);
    const response = await fetch(`${running.baseUrl}/api/azure-auto-setup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Radius-Server-Owned": "token-a"
      },
      body: JSON.stringify(VALID_BODY)
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      steps: string[];
      [key: string]: unknown;
    };
    expect(payload).toMatchObject({
      success: true,
      operationId: "op-http-reuse",
      clientId: APP_ID,
      tenantId: TENANT,
      subscriptionId: SUBSCRIPTION
    });
    expect(payload.steps.join("\n")).not.toContain(ENTRA_APP_RETENTION_NOTICE);
    expect(
      azCalls.filter(
        (line) => line === `ad app show --id ${APP_ID} --query id -o tsv`
      )
    ).toHaveLength(2);
    const resourceGroupScope = `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-radius`;
    const clusterScope = `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-radius/providers/Microsoft.ContainerService/managedClusters/aks-radius`;
    expect(
      azCalls.filter((line) => line.startsWith("role assignment create "))
    ).toEqual([
      `role assignment create --name ${deterministicProviderUuid(`op-http-reuse\0${OBJECT_ID}\0Contributor\0${resourceGroupScope}`)} --assignee-object-id ${OBJECT_ID} --assignee-principal-type ServicePrincipal --role Contributor --scope ${resourceGroupScope} --subscription ${SUBSCRIPTION} --output none`,
      `role assignment create --name ${deterministicProviderUuid(`op-http-reuse\0${OBJECT_ID}\0Azure Kubernetes Service RBAC Cluster Admin\0${clusterScope}`)} --assignee-object-id ${OBJECT_ID} --assignee-principal-type ServicePrincipal --role Azure Kubernetes Service RBAC Cluster Admin --scope ${clusterScope} --subscription ${SUBSCRIPTION} --output none`,
      `role assignment create --name ${deterministicProviderUuid(`op-http-reuse\0${OBJECT_ID}\0Locks Contributor\0${resourceGroupScope}`)} --assignee-object-id ${OBJECT_ID} --assignee-principal-type ServicePrincipal --role Locks Contributor --scope ${resourceGroupScope} --subscription ${SUBSCRIPTION} --output none`
    ]);
    expect(azCalls.join("\n")).not.toContain("User Access Administrator");
    expect(unmatchedCalls).toEqual([]);
  });

  it("records retention only after a newly created app completes setup", async () => {
    const { operation, running, unmatchedCalls } = await successfulSetup(true);
    const response = await fetch(`${running.baseUrl}/api/azure-auto-setup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Radius-Server-Owned": "token-a"
      },
      body: JSON.stringify(CREATE_BODY)
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      steps: string[];
      [key: string]: unknown;
    };
    expect(payload).toMatchObject({
      success: true,
      operationId: "op-http-create",
      clientId: APP_ID,
      tenantId: TENANT,
      subscriptionId: SUBSCRIPTION
    });
    const retentionStep = `ℹ️ Created Entra app registration "radius-deploy-octo-app". ${ENTRA_APP_RETENTION_NOTICE}`;
    expect(payload.steps).toContain(
      `✅ Entra app registration created: ${APP_ID}`
    );
    expect(payload.steps).toContain(retentionStep);
    expect((operation.steps ?? []).map((step) => step.label)).toContain(
      `Created Entra app registration "radius-deploy-octo-app". ${ENTRA_APP_RETENTION_NOTICE}`
    );
    expect(unmatchedCalls).toEqual([]);
  });

  it("restores the private SMR checkpoint and resumes at app creation", async () => {
    const setup = await successfulSetup(
      true,
      { type: "user" },
      { requireSmrPrompt: true }
    );
    const first = await fetch(`${setup.running.baseUrl}/api/azure-auto-setup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Radius-Server-Owned": "token-a"
      },
      body: JSON.stringify(CREATE_BODY)
    });

    expect(first.status).toBe(400);
    const firstPayload = await first.json();
    expect(firstPayload).toMatchObject({
      code: "service-management-reference-required",
      inputRequired: true,
      operationId: "op_http_smr"
    });
    expect(JSON.stringify(firstPayload)).not.toContain(
      "azureAppCreateContinuation"
    );
    const persisted = setup.persistedOperation();
    expect(persisted).toMatchObject({
      schemaVersion: 8,
      state: "input_required",
      azureAppCreateContinuation: {
        operationId: "op_http_smr",
        request: {
          repo: "octo/app",
          environment: "dev",
          resourceGroup: "rg-radius",
          clusterName: "aks-radius",
          requestedSubscriptionId: SUBSCRIPTION
        },
        resolved: {
          subscriptionId: SUBSCRIPTION,
          tenantId: TENANT,
          appName: "radius-deploy-octo-app",
          callerObjectId: OBJECT_ID
        }
      }
    });
    expect(JSON.stringify(persisted?.azureAppCreateContinuation)).not.toContain(
      "ServiceManagementReference is required"
    );
    setup.restorePersistedOperation();
    resumeAfterInput(setup.operation);

    const second = await fetch(
      `${setup.running.baseUrl}/api/azure-auto-setup`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Radius-Server-Owned": "token-a"
        },
        body: JSON.stringify({
          ...CREATE_BODY,
          operationId: "op_http_smr",
          serviceManagementReference: "99999999-9999-9999-9999-999999999999"
        })
      }
    );

    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      success: true,
      operationId: "op_http_smr",
      clientId: APP_ID,
      tenantId: TENANT,
      subscriptionId: SUBSCRIPTION,
      resourceGroup: "rg-radius",
      cluster: "aks-radius",
      appName: "radius-deploy-octo-app"
    });
    expect(
      setup.azCalls.filter((line) => line.startsWith("account set "))
    ).toHaveLength(1);
    expect(
      setup.azCalls.filter((line) => line === "account show --output json")
    ).toHaveLength(2);
    expect(
      setup.azCalls.filter((line) => line.startsWith("ad app list "))
    ).toHaveLength(1);
    expect(
      setup.azCalls.filter((line) => line.startsWith("ad signed-in-user show "))
    ).toHaveLength(2);
    expect(
      setup.githubCalls.filter((path) => path === "/repos/octo/app")
    ).toHaveLength(2);
    expect(setup.operation.azureAppCreateContinuation).toBeUndefined();
    expect(setup.unmatchedCalls).toEqual([]);
  });

  it.each(["caller", "oidc"] as const)(
    "falls back over real loopback HTTP when live %s context changes during the SMR prompt",
    async (liveDrift) => {
      const setup = await successfulSetup(
        true,
        { type: "user" },
        { requireSmrPrompt: true, liveDrift }
      );
      const first = await fetch(
        `${setup.running.baseUrl}/api/azure-auto-setup`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Radius-Server-Owned": "token-a"
          },
          body: JSON.stringify(CREATE_BODY)
        }
      );
      expect(first.status).toBe(400);

      setup.restorePersistedOperation();
      resumeAfterInput(setup.operation);
      const second = await fetch(
        `${setup.running.baseUrl}/api/azure-auto-setup`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Radius-Server-Owned": "token-a"
          },
          body: JSON.stringify({
            ...CREATE_BODY,
            operationId: "op_http_smr",
            serviceManagementReference: "99999999-9999-9999-9999-999999999999"
          })
        }
      );

      expect(second.status).toBe(200);
      expect(
        setup.azCalls.filter((line) => line.startsWith("account set "))
      ).toHaveLength(2);
      expect(
        setup.azCalls.filter((line) => line.startsWith("ad app list "))
      ).toHaveLength(2);
      expect(
        setup.githubCalls.filter((path) => path === "/repos/octo/app")
      ).toHaveLength(liveDrift === "oidc" ? 3 : 2);
    }
  );

  it("revalidates a service-principal caller before direct SMR resume", async () => {
    const setup = await successfulSetup(
      true,
      { type: "servicePrincipal", name: SP_APP_ID },
      { requireSmrPrompt: true }
    );
    const first = await fetch(`${setup.running.baseUrl}/api/azure-auto-setup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Radius-Server-Owned": "token-a"
      },
      body: JSON.stringify(CREATE_BODY)
    });
    expect(first.status).toBe(400);
    setup.restorePersistedOperation();
    resumeAfterInput(setup.operation);

    const second = await fetch(
      `${setup.running.baseUrl}/api/azure-auto-setup`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Radius-Server-Owned": "token-a"
        },
        body: JSON.stringify({
          ...CREATE_BODY,
          operationId: "op_http_smr",
          serviceManagementReference: "99999999-9999-9999-9999-999999999999"
        })
      }
    );

    expect(second.status).toBe(200);
    expect(
      setup.azCalls.filter(
        (line) => line === `ad sp show --id ${SP_APP_ID} --query id -o tsv`
      )
    ).toHaveLength(2);
    expect(
      setup.azCalls.filter((line) => line.startsWith("ad app list "))
    ).toHaveLength(1);
  });

  it("accepts the public SMR answer and schedules app creation with the persisted operation", async () => {
    const setup = await successfulSetup(
      true,
      { type: "user" },
      { requireSmrPrompt: true, publicResume: true }
    );
    const first = await fetch(`${setup.running.baseUrl}/api/azure-auto-setup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Radius-Server-Owned": "token-a"
      },
      body: JSON.stringify(CREATE_BODY)
    });
    expect(first.status).toBe(400);
    setup.restorePersistedOperation();

    const resumed = await fetch(
      `${setup.running.baseUrl}/api/operations/op_http_smr/resume/service-management-reference-required`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkpoint: "azure-service-management-reference",
          repo: "octo/app",
          environment: "dev",
          provider: "azure",
          serviceManagementReference: "99999999-9999-9999-9999-999999999999"
        })
      }
    );

    expect(resumed.status).toBe(202);
    expect(await resumed.json()).toEqual({
      operationId: "op_http_smr",
      statusUrl: "/api/operations/op_http_smr"
    });
    expect(setup.scheduledPersistedOperation()).toMatchObject({
      operationId: "op_http_smr",
      state: "running",
      azureAppCreateContinuation: {
        acceptedPrompt: {
          code: "service-management-reference-required",
          checkpoint: "azure-service-management-reference"
        }
      }
    });
    const scheduled = await setup.scheduledAttempt();
    expect(scheduled.status).toBe(200);
    expect(await scheduled.json()).toMatchObject({
      success: true,
      operationId: "op_http_smr",
      appName: "radius-deploy-octo-app",
      clientId: APP_ID
    });
    expect(
      setup.azCalls.filter((line) =>
        line.startsWith(`ad app create --display-name radius-deploy-octo-app`)
      )
    ).toHaveLength(2);
    expect(setup.operation.operationId).toBe("op_http_smr");
    expect(setup.operation.azureAppCreateContinuation).toBeUndefined();
  });

  it("creates and owns the app registration when the CLI is a service principal", async () => {
    const { running, unmatchedCalls, azCalls } = await successfulSetup(true, {
      type: "servicePrincipal",
      name: SP_APP_ID
    });
    const response = await fetch(`${running.baseUrl}/api/azure-auto-setup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Radius-Server-Owned": "token-a"
      },
      body: JSON.stringify(CREATE_BODY)
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      steps: string[];
      [key: string]: unknown;
    };
    expect(payload).toMatchObject({
      success: true,
      operationId: "op-http-create",
      clientId: APP_ID,
      tenantId: TENANT,
      subscriptionId: SUBSCRIPTION
    });
    expect(payload.steps).toContain(
      "✅ Azure CLI identity verified as App Registration owner"
    );
    expect(
      azCalls.filter((line) => line === "account show --output json")
    ).toHaveLength(1);
    expect(azCalls.filter((line) => line.startsWith("account show "))).toEqual([
      "account show --output json"
    ]);
    expect(unmatchedCalls).toEqual([]);
  });

  it("fails closed over HTTP when the caller identity cannot be established", async () => {
    const azCalls: string[] = [];
    const operation: AzureAutoSetupOperation = {
      operationId: "op-identity",
      repo: "octo/app",
      environment: "dev",
      provider: "azure",
      currentStage: "authorize_identity"
    };
    start(
      createAzureAutoSetupTestDependencies({
        isServerOwnedRequest: (_instanceId, request) =>
          request.headers["x-radius-server-owned"] === "token-a",
        operations: { create: () => operation },
        external: {
          getGitHubIdentity: async () => null,
          preflightRepoAdmin: async () => "",
          preflightGhcrPackageWriteAccess: async () => ({ ok: true }),
          runGitHubJson: async (path) => {
            if (path === "/repos/octo/app") {
              return {
                ok: true,
                status: 200,
                json: { full_name: "octo/app", id: 5, owner: { id: 7 } }
              };
            }
            if (path === "/repos/octo/app/actions/oidc/customization/sub") {
              return { ok: false, status: 404, json: null };
            }
            if (
              path ===
              "/repos/octo/app/environments/dev/variables/AZURE_CLIENT_ID"
            ) {
              return { ok: false, status: 404, json: null };
            }
            throw new Error(`unscripted GitHub call: ${path}`);
          },
          runAz: async (args) => {
            const line = args.join(" ");
            azCalls.push(line);
            if (line.startsWith("account set "))
              return { code: 0, stdout: "", stderr: "" };
            if (line === "account show --output json") {
              return {
                code: 0,
                stdout: JSON.stringify({
                  id: SUBSCRIPTION,
                  tenantId: TENANT,
                  user: { type: "managedIdentity", name: "contoso" }
                }),
                stderr: ""
              };
            }
            if (line.startsWith("ad app list ")) {
              return { code: 0, stdout: "[]", stderr: "" };
            }
            throw new Error(`unscripted az call: ${line}`);
          }
        },
        finalizeSetupFailure: finalizer()
      })
    );
    const running = await entry();
    const response = await fetch(`${running.baseUrl}/api/azure-auto-setup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Radius-Server-Owned": "token-a"
      },
      body: JSON.stringify(CREATE_BODY)
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      error: string;
      code: string;
    };
    expect(payload.code).toBe("app-owner-lookup-failed");
    expect(payload.error).toContain("unsupported caller identity type");
    expect(azCalls.some((line) => line.startsWith("ad app create "))).toBe(
      false
    );
  });
});
