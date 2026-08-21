import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import { addLegacyStep } from "../../../src/operations.js";
import { ENTRA_APP_RETENTION_NOTICE } from "../../../src/server/routes/azure-auto-setup-application.js";
import { createAzureAutoSetupRoutes } from "../../../src/server/routes/azure-auto-setup.js";
import { buildRadiusAppProvenanceTags } from "../../../src/azure-oidc.js";
import type {
  AzureAutoSetupCommandResult,
  AzureAutoSetupDependencies,
  AzureAutoSetupFailureInput,
  AzureAutoSetupOperation
} from "../../../src/server/routes/azure-auto-setup-types.js";
import type { CanvasServerContainer } from "../../../src/server/create-canvas-server.js";
import { createAzureAutoSetupTestDependencies } from "../../support/server/azure-auto-setup.js";
import { createTestRouteTable } from "../../support/server/route-table.js";

const SUBSCRIPTION = "22222222-2222-2222-2222-222222222222";
const TENANT = "11111111-1111-1111-1111-111111111111";
const APP_ID = "33333333-3333-3333-3333-333333333333";
const OBJECT_ID = "44444444-4444-4444-4444-444444444444";

let container: CanvasServerContainer | undefined;

afterEach(async () => {
  await container?.stopAll();
  container = undefined;
});

function start(
  dependencies: AzureAutoSetupDependencies,
  unmatchedCalls: string[] = []
): void {
  const routes = createTestRouteTable(createAzureAutoSetupRoutes(dependencies));
  container = createCanvasServer({
    createHttpServer: (handler) => createServer(handler),
    createRequestHandler: ({ instanceId, instances, markActivity }) =>
      createRequestHandler({
        instanceId,
        instances,
        routes,
        markActivity,
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

async function successfulSetup(createApp: boolean) {
  const unmatchedCalls: string[] = [];
  const operation = {
    operationId: createApp ? "op-http-create" : "op-http-reuse",
    repo: "octo/app",
    environment: "dev",
    provider: "azure",
    currentStage: "authorize_identity",
    steps: [] as Array<{ label: string }>
  };
  const requiredTags = buildRadiusAppProvenanceTags({
    repo: "octo/app",
    environment: "dev",
    operationId: operation.operationId
  });
  const runAz = async (
    args: string[]
  ): Promise<AzureAutoSetupCommandResult> => {
    const line = args.join(" ");
    if (line.startsWith("account set "))
      return { code: 0, stdout: "", stderr: "" };
    if (line === "account show --output json") {
      return {
        code: 0,
        stdout: JSON.stringify({ id: SUBSCRIPTION, tenantId: TENANT }),
        stderr: ""
      };
    }
    if (!createApp && line.startsWith(`ad app show --id ${APP_ID} `)) {
      return { code: 0, stdout: "app-object", stderr: "" };
    }
    if (createApp && line.startsWith("ad app list ")) {
      return { code: 0, stdout: "[]", stderr: "" };
    }
    if (createApp && line.startsWith("ad app create ")) {
      return { code: 0, stdout: APP_ID, stderr: "" };
    }
    if (line.startsWith("ad signed-in-user show ")) {
      return { code: 0, stdout: OBJECT_ID, stderr: "" };
    }
    if (createApp && line.startsWith(`ad app owner add --id ${APP_ID}`)) {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (line.startsWith(`ad app owner list --id ${APP_ID}`)) {
      return { code: 0, stdout: OBJECT_ID, stderr: "" };
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
    if (line.includes("federated-credential list")) {
      return { code: 0, stdout: "[]", stderr: "" };
    }
    if (line.includes("federated-credential create")) {
      return { code: 0, stdout: "", stderr: "" };
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
      addLegacyStep
    },
    external: {
      getGitHubIdentity: async () => null,
      preflightRepoAdmin: async () => "",
      preflightGhcrPackageWriteAccess: async () => ({ ok: true }),
      runGitHubJson: async (path) => {
        if (path === "/repos/octo/app") {
          return {
            ok: true,
            status: 200,
            json: {
              full_name: "octo/app",
              id: 5,
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
      write: () => {},
      remove: () => {}
    },
    ensureServicePrincipal: async () => ({
      ok: true,
      state: "reused",
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
  start(dependencies, unmatchedCalls);
  return { operation, running: await entry(), unmatchedCalls };
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
    const { running, unmatchedCalls } = await successfulSetup(false);
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
    expect(operation.steps.map((step) => step.label)).toContain(
      `Created Entra app registration "radius-deploy-octo-app". ${ENTRA_APP_RETENTION_NOTICE}`
    );
    expect(unmatchedCalls).toEqual([]);
  });
});
