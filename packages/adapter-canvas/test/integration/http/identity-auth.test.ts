import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import { createIdentityAuthRoutes } from "../../../src/server/routes/identity-auth.js";
import { createTestRouteTable } from "../../support/server/route-table.js";
import type { CanvasServerContainer } from "../../../src/server/create-canvas-server.js";
import type { CanvasState } from "../../../src/shared.js";

let container: CanvasServerContainer | undefined;

afterEach(async () => {
  await container?.stopAll();
  container = undefined;
});

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const SUBSCRIPTION = "33333333-3333-3333-3333-333333333333";

interface Harness {
  calls: string[];
  azureValidation: {
    success: boolean;
    error?: string;
    tenantId?: string;
    subscriptionId?: string;
    subscriptionName?: string;
    userName?: string;
  };
  commands: Record<string, string | Error>;
  promptOutcome: { status: number; error?: string };
  savedAzure: Record<string, unknown> | null;
  saves: number;
  states: Map<string, CanvasState>;
}

function start(): Harness {
  const harness: Harness = {
    calls: [],
    azureValidation: {
      success: true,
      tenantId: TENANT_A,
      subscriptionId: SUBSCRIPTION,
      subscriptionName: "Fixture Subscription",
      userName: "fixture-user@example.com"
    },
    commands: {
      [`az account set --subscription ${SUBSCRIPTION}`]: "",
      "az account show -o json": JSON.stringify({
        tenantId: TENANT_A,
        id: SUBSCRIPTION,
        name: "Fixture Subscription",
        user: { name: "fixture-user@example.com" }
      }),
      "aws sts get-caller-identity --output json": JSON.stringify({
        Account: "000011112222",
        Arn: "arn:aws:iam::000011112222:user/fixture-user"
      })
    },
    promptOutcome: { status: 200 },
    savedAzure: null,
    saves: 0,
    states: new Map()
  };
  const uuids = new Set([TENANT_A, TENANT_B, SUBSCRIPTION]);

  const routes = createTestRouteTable(
    createIdentityAuthRoutes({
      validateAzureCredentials: (data) => {
        harness.calls.push(`validate(${JSON.stringify(data)})`);
        return Promise.resolve(harness.azureValidation);
      },
      generateAzureOIDC: () => {
        harness.calls.push("generateAzure");
        return { message: "azure-oidc-message", output: "azure-oidc-output" };
      },
      generateAWSOIDC: () => {
        harness.calls.push("generateAws");
        return { message: "aws-oidc-message", output: "aws-oidc-output" };
      },
      readInstanceState: (instanceId) => {
        harness.calls.push(`state(${instanceId})`);
        return harness.states.get(instanceId);
      },
      setSharedAzureCredentials: (credentials) => {
        harness.savedAzure = credentials;
      },
      saveCredentials: () => {
        harness.saves += 1;
      },
      azureCredentialIdValidationError: ({ tenantId, subscriptionId }) => {
        if (tenantId && !uuids.has(tenantId)) {
          return `Invalid tenantId "${tenantId}" (expected a GUID).`;
        }
        if (subscriptionId && !uuids.has(subscriptionId)) {
          return `Invalid subscriptionId "${subscriptionId}" (expected a GUID).`;
        }
        return "";
      },
      azureLoginRequiredResponse: ({ tenantId, activeTenantId }) => ({
        error: `login-required(${tenantId}|${activeTenantId ?? ""})`,
        code: "az-login-required",
        tenantId
      }),
      isCliCommandMissing: (detail) => String(detail).includes("ENOENT"),
      isUuid: (value) => uuids.has(String(value)),
      buildAzureCliAssistPrompt: ({ action, tenantId }) =>
        `prompt:${action}:${tenantId}`,
      runSessionPrompt: (prompt) => {
        harness.calls.push(`prompt(${prompt})`);
        return Promise.resolve(harness.promptOutcome);
      },
      runCommand: (command, args) => {
        const line = [command, ...args].join(" ");
        harness.calls.push(`run(${line})`);
        const scripted = harness.commands[line];
        if (scripted === undefined) {
          throw new Error(`unscripted command vector: ${line}`);
        }
        if (scripted instanceof Error) return Promise.reject(scripted);
        return Promise.resolve(scripted);
      },
      errorMessage: (error) =>
        error instanceof Error ? error.message : String(error)
    })
  );

  container = createCanvasServer({
    createHttpServer: (handler) => createServer(handler),
    createRequestHandler: ({ instanceId, instances, markActivity }) =>
      createRequestHandler({
        instanceId,
        instances,
        routes,
        markActivity,
        legacyFallback: (_request, response) => {
          response.writeHead(418);
          response.end("legacy");
        }
      }),
    // The instance state the container hands out is the same object the
    // `readInstanceState` seam above returns, so the OIDC cache written over a
    // real socket is observable from the test.
    createState: () => ({}),
    defaultPage: "graph",
    now: () => Date.now(),
    // 0 means the OS assigns a free 127.0.0.1 port for this run.
    preferredPort: async () => 0,
    prepareIdentity: () => {}
  });

  return harness;
}

function post(baseUrl: string, path: string, body: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: "POST", body });
}

describe("identity-auth real-loopback HIT (RF-02)", () => {
  it("returns the azure check mark and em dash as UTF-8 over the wire", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");
    harness.states.set("panel-a", entry.state);

    const response = await post(
      entry.baseUrl,
      "/api/oidc",
      '{"provider":"azure","clientId":"client-1"}'
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");

    // Decoded from the raw response bytes, so a server-side encoding slip shows
    // up here as a replacement character rather than a matching string.
    const raw = new Uint8Array(await response.arrayBuffer());
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    const payload = JSON.parse(text) as { message: string; output: string };
    expect(payload.message).toBe(
      "\u2705 Azure authentication confirmed \u2014 logged in as fixture-user@example.com"
    );
    expect(payload.message.codePointAt(0)).toBe(0x2705);
    expect(text).not.toContain("\ufffd");
    expect(payload.output).toBe("azure-oidc-output");

    // The credential cache and the shared credential were both written.
    expect(entry.state.oidcAzure).toMatchObject({
      validated: true,
      clientId: "client-1",
      tenantName: "",
      clientName: ""
    });
    expect(harness.savedAzure).toEqual({
      tenantId: TENANT_A,
      subscriptionId: SUBSCRIPTION,
      subscriptionName: "Fixture Subscription",
      userName: "fixture-user@example.com",
      clientId: "client-1"
    });
    expect(harness.saves).toBe(1);
  });

  it("answers a failed azure validation with 200 and the cross mark", async () => {
    const harness = start();
    harness.azureValidation = { success: false, error: "no session" };
    const entry = await container!.getOrCreate("panel-a");
    harness.states.set("panel-a", entry.state);

    const response = await post(
      entry.baseUrl,
      "/api/oidc",
      '{"provider":"azure"}'
    );
    // A validation failure is a 200 on the wire, not a 4xx.
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { message: string };
    expect(payload.message.codePointAt(0)).toBe(0x274c);
    expect(payload.message).toBe("\u274c no session");
    expect(entry.state.oidcAzure).toBeUndefined();
    expect(harness.saves).toBe(0);
  });

  it("caches the aws instructions and 400s an empty body", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");
    harness.states.set("panel-a", entry.state);

    const aws = await post(
      entry.baseUrl,
      "/api/oidc",
      '{"provider":"aws","accountId":"acct-1","region":"us-east-1"}'
    );
    expect(aws.status).toBe(200);
    expect(await aws.text()).toBe(
      '{"message":"aws-oidc-message","output":"aws-oidc-output"}'
    );
    expect(entry.state.oidcAws).toMatchObject({
      accountId: "acct-1",
      accountName: "",
      region: "us-east-1"
    });

    // The parse is unguarded, so an empty body is a 400 rather than an AWS
    // generation over `{}`.
    const empty = await post(entry.baseUrl, "/api/oidc", "");
    expect(empty.status).toBe(400);
    expect(empty.headers.get("content-type")).toBe("application/json");

    // GET is not declared for this path, so it still reaches the fallback.
    const wrongMethod = await fetch(`${entry.baseUrl}/api/oidc`);
    expect(wrongMethod.status).toBe(418);
  });

  it("verifies an azure session and reports mismatches and missing CLIs as 200", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");

    const verified = await post(
      entry.baseUrl,
      "/api/verify-azure-login",
      `{"tenantId":"${TENANT_A}","subscriptionId":"${SUBSCRIPTION}"}`
    );
    expect(verified.status).toBe(200);
    expect(await verified.json()).toEqual({
      success: true,
      user: "fixture-user@example.com",
      tenantId: TENANT_A,
      subscriptionId: SUBSCRIPTION,
      subscriptionName: "Fixture Subscription"
    });
    expect(harness.calls).toEqual([
      `run(az account set --subscription ${SUBSCRIPTION})`,
      "run(az account show -o json)"
    ]);

    const mismatch = await post(
      entry.baseUrl,
      "/api/verify-azure-login",
      `{"tenantId":"${TENANT_B}"}`
    );
    expect(mismatch.status).toBe(200);
    expect(await mismatch.json()).toEqual({
      error: `login-required(${TENANT_B}|${TENANT_A})`,
      code: "az-login-required",
      tenantId: TENANT_B
    });

    harness.commands["az account show -o json"] = new Error("spawn az ENOENT");
    const missing = await post(
      entry.baseUrl,
      "/api/verify-azure-login",
      `{"tenantId":"${TENANT_A}"}`
    );
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({
      error: "Azure CLI is not installed.",
      code: "az-cli-missing",
      tenantId: TENANT_A
    });

    // A rejected GUID never reaches the CLI, and a malformed body is still 200.
    harness.calls.length = 0;
    const rejected = await post(
      entry.baseUrl,
      "/api/verify-azure-login",
      '{"tenantId":"x&calc"}'
    );
    expect(rejected.status).toBe(200);
    expect(await rejected.text()).toBe(
      '{"error":"Invalid tenantId \\"x&calc\\" (expected a GUID)."}'
    );
    expect(harness.calls).toEqual([]);

    const malformed = await post(
      entry.baseUrl,
      "/api/verify-azure-login",
      "not json"
    );
    expect(malformed.status).toBe(200);
    expect(
      String(((await malformed.json()) as { error: string }).error)
    ).toContain("Azure CLI verification failed:");
  });

  it("propagates the session-prompt status verbatim", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");

    const ok = await post(
      entry.baseUrl,
      "/api/azure-cli-assist",
      `{"action":"install","tenantId":"${TENANT_A}"}`
    );
    expect(ok.status).toBe(200);
    expect(harness.calls).toContain(`prompt(prompt:install:${TENANT_A})`);
    expect(
      String(((await ok.json()) as { message: string }).message)
    ).toContain("Asked Copilot to help install Azure CLI");

    // 503 and 502 are distinct client-visible outcomes and must both survive
    // the trip over a real socket.
    for (const status of [503, 502]) {
      harness.promptOutcome = { status, error: `prompt failed ${status}` };
      const failed = await post(entry.baseUrl, "/api/azure-cli-assist", "{}");
      expect(failed.status).toBe(status);
      expect(failed.headers.get("content-type")).toBe("application/json");
      expect(await failed.text()).toBe(`{"error":"prompt failed ${status}"}`);
    }
  });

  it("verifies an aws session and hides the CLI error when there is none", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");

    const verified = await post(
      entry.baseUrl,
      "/api/verify-aws-login",
      '{"region":"eu-west-1"}'
    );
    expect(verified.status).toBe(200);
    expect(await verified.json()).toEqual({
      success: true,
      accountId: "000011112222",
      arn: "arn:aws:iam::000011112222:user/fixture-user",
      user: "fixture-user",
      region: "eu-west-1"
    });

    harness.commands["aws sts get-caller-identity --output json"] = new Error(
      "spawn aws ENOENT"
    );
    const absent = await post(entry.baseUrl, "/api/verify-aws-login", "{}");
    expect(absent.status).toBe(200);
    const body = await absent.text();
    expect(body).toContain("No active AWS CLI session.");
    expect(body).not.toContain("ENOENT");

    // Unmigrated routes still reach the fallback.
    const residual = await fetch(`${entry.baseUrl}/api/list-environments`);
    expect(residual.status).toBe(418);
    const deferred = await post(entry.baseUrl, "/api/delete-environment", "{}");
    expect(deferred.status).toBe(418);
  });
});
