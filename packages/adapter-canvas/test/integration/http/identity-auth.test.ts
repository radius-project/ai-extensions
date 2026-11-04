import { remediationView } from "@radius-project/core";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import { createIdentityAuthRoutes } from "../../../src/server/routes/identity-auth.js";
import { createTestRouteTable } from "../../support/server/route-table.js";
import type { CanvasServerContainer } from "../../../src/server/create-canvas-server.js";

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
  commands: Record<string, string | Error>;
  promptOutcome: { status: number; error?: string };
}

function start(): Harness {
  const harness: Harness = {
    calls: [],
    commands: {
      "aws --version": "aws-cli/2.15.3 Python/3.11",
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
      }),
      "aws sts get-caller-identity --output json --region eu-west-1":
        JSON.stringify({
          Account: "000011112222",
          Arn: "arn:aws:iam::000011112222:user/fixture-user"
        }),
      "aws sts get-caller-identity --output json --region us-east-2":
        JSON.stringify({
          Account: "000011112222",
          Arn: "arn:aws:iam::000011112222:user/fixture-user"
        })
    },
    promptOutcome: { status: 200 }
  };
  const uuids = new Set([TENANT_A, TENANT_B, SUBSCRIPTION]);

  const routes = createTestRouteTable(
    createIdentityAuthRoutes({
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
        tenantId,
        remediation: remediationView("azure-cli-login", { tenantId })
      }),
      isCliCommandMissing: (detail) => String(detail).includes("ENOENT"),
      isUuid: (value) => uuids.has(String(value)),
      buildAzureCliAssistMessage: ({ action, tenantId }) => ({
        prompt: `prompt:${action}:${tenantId}`,
        displayPrompt: `display:${action}:${tenantId}`
      }),
      runSessionPrompt: (message) => {
        harness.calls.push(`prompt(${JSON.stringify(message)})`);
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
      runAws: async (args) => {
        const line = ["aws", ...args].join(" ");
        harness.calls.push(`run(${line})`);
        const scripted = harness.commands[line];
        if (scripted === undefined)
          throw new Error(`unscripted command vector: ${line}`);
        return scripted instanceof Error ?
            { code: 1, stdout: "", stderr: scripted.message }
          : { code: 0, stdout: scripted, stderr: "" };
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
        handleUnmatchedRequest: (_request, response) => {
          response.writeHead(404);
          response.end("unmatched");
        }
      }),
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
      tenantId: TENANT_B,
      remediation: remediationView("azure-cli-login", { tenantId: TENANT_B })
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
      tenantId: TENANT_A,
      remediation: remediationView("azure-cli-install", { tenantId: TENANT_A })
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
    expect(harness.calls).toContain(
      `prompt({"prompt":"prompt:install:${TENANT_A}","displayPrompt":"display:install:${TENANT_A}"})`
    );
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

  it("verifies an AWS session and offers sign-in for missing credentials", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");

    const verified = await post(
      entry.baseUrl,
      "/api/verify-aws-login",
      '{"accountId":"000011112222","region":"eu-west-1"}'
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
      "Unable to locate credentials"
    );
    const absent = await post(
      entry.baseUrl,
      "/api/verify-aws-login",
      '{"accountId":"000011112222"}'
    );
    expect(absent.status).toBe(200);
    const body = await absent.text();
    expect(body).toContain("No active AWS CLI session.");
    expect(body).not.toContain("ENOENT");
  });

  it.each([
    ["aws-cli/2.15.2 Python/3.11", "aws-cli-unsupported"],
    [new Error("spawn aws ENOENT"), "aws-cli-unsupported"]
  ])("rejects an unusable AWS CLI over HTTP: %s", async (output, code) => {
    const harness = start();
    harness.commands["aws --version"] = output;
    const entry = await container!.getOrCreate("panel-a");
    const response = await post(
      entry.baseUrl,
      "/api/verify-aws-login",
      '{"accountId":"000011112222","region":"us-east-2"}'
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toMatchObject({
      code,
      error: expect.stringContaining("2.15.3")
    });
    expect(harness.calls).toEqual(["run(aws --version)"]);
  });

  it("returns both accounts for a mismatch without changing identity", async () => {
    start();
    const entry = await container!.getOrCreate("panel-a");
    const response = await post(
      entry.baseUrl,
      "/api/verify-aws-login",
      '{"accountId":"999988887777","region":"us-east-2"}'
    );
    expect(await response.json()).toMatchObject({
      code: "aws-account-mismatch",
      accountId: "999988887777",
      sessionAccountId: "000011112222"
    });
  });

  it.each(["not json", "null", '{"accountId":123}'])(
    "rejects malformed AWS requests over HTTP before executing commands",
    async (body) => {
      const harness = start();
      const entry = await container!.getOrCreate("panel-a");
      const response = await post(entry.baseUrl, "/api/verify-aws-login", body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "aws-input-invalid"
      });
      expect(harness.calls).toEqual([]);
    }
  );
});
