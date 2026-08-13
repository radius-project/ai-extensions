import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createRequestContext } from "../request-context.js";
import {
  createIdentityAuthRoutes,
  handleAzureCliAssist,
  handleOidc,
  handleVerifyAwsLogin,
  handleVerifyAzureLogin,
  type IdentityAuthDependencies
} from "./identity-auth.js";
import type { CanvasState } from "../../shared.js";
import type { CanvasServerEntry } from "../types.js";

interface Recording {
  headers: Record<string, string>;
  // Header placement is observable here too: every branch sets `Content-Type`
  // immediately before its own `writeHead`, and `/api/azure-cli-assist` writes a
  // *dynamic* status. `headerSteps` records when each set happened relative to
  // the write, which `headers` alone cannot express.
  headerOrder: string[];
  headerSteps: string[];
  status: number;
  body: string;
}

function recorder() {
  const recording: Recording = {
    headers: {},
    headerOrder: [],
    headerSteps: [],
    status: 0,
    body: ""
  };
  const target = {
    setHeader(name: string, value: string) {
      // Mirrors Node: re-setting a header overwrites it and keeps its position.
      if (!(name in recording.headers)) recording.headerOrder.push(name);
      recording.headers[name] = value;
      recording.headerSteps.push(`set:${name}=${value}`);
      return this;
    },
    writeHead(status: number) {
      recording.status = status;
      recording.headerSteps.push(`writeHead:${status}`);
      return this;
    },
    end(value = "") {
      recording.body += value;
      recording.headerSteps.push("end");
      return this;
    }
  };
  return {
    recording,
    response: target as unknown as ServerResponse<IncomingMessage>
  };
}

function request(method: string, url: string, body = ""): IncomingMessage {
  return Object.assign(Readable.from(body ? [body] : []), {
    url,
    method,
    headers: {}
  }) as unknown as IncomingMessage;
}

// ── Fixtures ────────────────────────────────────────────────────────────────
// Named so the differential cases and the precondition guard below reference
// the same values rather than repeating literals that could drift apart.

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const SUBSCRIPTION = "33333333-3333-3333-3333-333333333333";
const NOT_A_GUID = "x&calc";

const AZ_ACCOUNT = {
  tenantId: TENANT_A,
  id: SUBSCRIPTION,
  name: "Fixture Subscription",
  user: { name: "fixture-user@example.com" }
};

const AWS_IDENTITY = {
  Account: "000011112222",
  Arn: "arn:aws:iam::000011112222:user/fixture-user"
};

// Every fake is keyed on the exact argument vector and throws on one it was not
// scripted for, so calling the wrong port — or the right port with the wrong
// arguments — fails loudly instead of silently matching.
interface Calls {
  log: string[];
}

interface FakeOptions {
  azureValidation?: {
    success: boolean;
    error?: string;
    tenantId?: string;
    subscriptionId?: string;
    subscriptionName?: string;
    userName?: string;
  };
  azureValidationThrows?: Error;
  generateAzureThrows?: Error;
  generateAwsThrows?: Error;
  saveThrows?: Error;
  missingEntry?: boolean;
  state?: CanvasState;
  // Keyed by the exact joined command line, e.g. "az account show -o json".
  commands?: Record<string, string | Error>;
  promptOutcome?: { status: number; error?: string };
  promptThrows?: Error;
  uuids?: string[];
}

function commandLine(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

const DEFAULT_COMMANDS: Record<string, string | Error> = {
  [`az account set --subscription ${SUBSCRIPTION}`]: "",
  "az account show -o json": JSON.stringify(AZ_ACCOUNT),
  "aws sts get-caller-identity --output json": JSON.stringify(AWS_IDENTITY)
};

// One independent set of fakes plus the mutable state they read and write.
// Each side of a differential case builds its own, so a mutation on one side
// can never be masked by state shared with the other.
function fakes(
  calls: Calls,
  options: FakeOptions = {}
): { deps: IdentityAuthDependencies; state: CanvasState | undefined } {
  const state =
    options.missingEntry ? undefined : structuredClone(options.state ?? {});
  const commands = { ...DEFAULT_COMMANDS, ...(options.commands ?? {}) };
  const uuids = new Set(options.uuids ?? [TENANT_A, TENANT_B, SUBSCRIPTION]);
  const deps: IdentityAuthDependencies = {
    validateAzureCredentials: (data) => {
      calls.log.push(`validateAzureCredentials(${JSON.stringify(data)})`);
      if (options.azureValidationThrows) {
        return Promise.reject(options.azureValidationThrows);
      }
      return Promise.resolve(
        options.azureValidation ?? {
          success: true,
          tenantId: TENANT_A,
          subscriptionId: SUBSCRIPTION,
          subscriptionName: "Fixture Subscription",
          userName: "fixture-user@example.com"
        }
      );
    },
    generateAzureOIDC: (data) => {
      calls.log.push(`generateAzureOIDC(${JSON.stringify(data)})`);
      if (options.generateAzureThrows) throw options.generateAzureThrows;
      return { message: "azure-oidc-message", output: "azure-oidc-output" };
    },
    generateAWSOIDC: (data) => {
      calls.log.push(`generateAWSOIDC(${JSON.stringify(data)})`);
      if (options.generateAwsThrows) throw options.generateAwsThrows;
      return { message: "aws-oidc-message", output: "aws-oidc-output" };
    },
    readInstanceState: (instanceId) => {
      calls.log.push(`readInstanceState(${instanceId})`);
      return state;
    },
    setSharedAzureCredentials: (credentials) => {
      calls.log.push(
        `setSharedAzureCredentials(${JSON.stringify(credentials)})`
      );
    },
    saveCredentials: () => {
      calls.log.push("saveCredentials");
      if (options.saveThrows) throw options.saveThrows;
    },
    azureCredentialIdValidationError: ({ tenantId, subscriptionId }) => {
      calls.log.push(
        `azureCredentialIdValidationError(${tenantId}|${subscriptionId})`
      );
      if (tenantId && !uuids.has(tenantId)) {
        return `invalid-tenant:${tenantId}`;
      }
      if (subscriptionId && !uuids.has(subscriptionId)) {
        return `invalid-subscription:${subscriptionId}`;
      }
      return "";
    },
    azureLoginRequiredResponse: ({ tenantId, activeTenantId }) => {
      calls.log.push(
        `azureLoginRequiredResponse(${tenantId}|${activeTenantId ?? ""})`
      );
      return {
        error: `login-required(${tenantId}|${activeTenantId ?? ""})`,
        code: "az-login-required",
        tenantId
      };
    },
    isCliCommandMissing: (detail) => {
      calls.log.push(`isCliCommandMissing(${String(detail)})`);
      return String(detail).includes("ENOENT");
    },
    isUuid: (value) => {
      calls.log.push(`isUuid(${String(value)})`);
      return uuids.has(String(value));
    },
    buildAzureCliAssistPrompt: ({ action, tenantId }) => {
      calls.log.push(`buildAzureCliAssistPrompt(${action}|${tenantId})`);
      return `prompt:${action}:${tenantId}`;
    },
    runSessionPrompt: (prompt) => {
      calls.log.push(`runSessionPrompt(${prompt})`);
      if (options.promptThrows) return Promise.reject(options.promptThrows);
      return Promise.resolve(options.promptOutcome ?? { status: 200 });
    },
    runCommand: (command, args, commandOptions) => {
      const line = commandLine(command, args);
      calls.log.push(`runCommand(${line}|${commandOptions.timeout})`);
      const scripted = commands[line];
      if (scripted === undefined) {
        throw new Error(`unscripted command vector: ${line}`);
      }
      if (scripted instanceof Error) return Promise.reject(scripted);
      return Promise.resolve(scripted);
    },
    // Deliberately distinct from the inline `e instanceof Error ? e.message :
    // String(e || "")` the legacy branches use in three places, so a handler
    // that swaps one formatter for the other is detectable.
    errorMessage: (error) =>
      `formatted:${error instanceof Error ? error.message : String(error)}`
  };
  return { deps, state };
}

function dependencies(
  overrides: Partial<IdentityAuthDependencies> = {}
): IdentityAuthDependencies {
  const calls: Calls = { log: [] };
  return { ...fakes(calls).deps, ...overrides };
}

type Handler = (
  context: ReturnType<typeof createRequestContext>,
  deps: IdentityAuthDependencies
) => void | Promise<void>;

async function run(
  path: string,
  body: string,
  handler: Handler,
  deps: IdentityAuthDependencies
): Promise<Recording> {
  const { recording, response } = recorder();
  const context = createRequestContext(
    request("POST", path, body),
    response,
    "panel-a",
    new Map<string, CanvasServerEntry>()
  );
  await handler(context, deps);
  return recording;
}

const JSON_ONLY = ["Content-Type"];
const SET_THEN_WRITE = (status: number) => [
  "set:Content-Type=application/json",
  `writeHead:${status}`,
  "end"
];

describe("identity-auth routes (SU-08)", () => {
  it("declares exactly the four routes it owns", () => {
    const routes = createIdentityAuthRoutes(dependencies());
    expect(Object.keys(routes)).toEqual([
      "POST /api/oidc",
      "POST /api/verify-azure-login",
      "POST /api/azure-cli-assist",
      "POST /api/verify-aws-login"
    ]);
  });

  // ── POST /api/oidc ────────────────────────────────────────────────────────

  it("validates azure credentials, caches them, and persists them in order", async () => {
    const calls: Calls = { log: [] };
    const { deps, state } = fakes(calls);
    const recording = await run(
      "/api/oidc",
      '{"provider":"azure","clientId":"client-1"}',
      handleOidc,
      deps
    );
    expect(recording.status).toBe(200);
    expect(recording.headerOrder).toEqual(JSON_ONLY);
    expect(recording.headerSteps).toEqual(SET_THEN_WRITE(200));
    // Validation precedes generation, the entry is cached before the shared
    // credential is written, and the save follows the write.
    expect(calls.log).toEqual([
      'validateAzureCredentials({"provider":"azure","clientId":"client-1"})',
      "readInstanceState(panel-a)",
      'generateAzureOIDC({"provider":"azure","clientId":"client-1"})',
      `setSharedAzureCredentials({"tenantId":"${TENANT_A}","subscriptionId":"${SUBSCRIPTION}","subscriptionName":"Fixture Subscription","userName":"fixture-user@example.com","clientId":"client-1"})`,
      "saveCredentials"
    ]);
    expect(state?.oidcAzure).toEqual({
      message: `\u2705 Azure authentication confirmed \u2014 logged in as fixture-user@example.com`,
      validated: true,
      tenantId: TENANT_A,
      subscriptionId: SUBSCRIPTION,
      subscriptionName: "Fixture Subscription",
      userName: "fixture-user@example.com",
      output: "azure-oidc-output",
      clientId: "client-1",
      tenantName: "",
      clientName: ""
    });
  });

  // The success and failure payloads are the only non-ASCII response bytes in
  // this family. They are asserted by code point, not by pasted glyph, so a
  // re-encoding of this file (or of the handler) fails here instead of shipping
  // a corrupted check mark to the canvas.
  it("emits U+2705 and U+2014 in the azure success message", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls);
    const recording = await run(
      "/api/oidc",
      '{"provider":"azure"}',
      handleOidc,
      deps
    );
    const message = String(
      (JSON.parse(recording.body) as { message: unknown }).message
    );
    expect(message.codePointAt(0)).toBe(0x2705);
    expect([...message].map((c) => c.codePointAt(0))).toContain(0x2014);
    expect(message).toBe(
      "\u2705 Azure authentication confirmed \u2014 logged in as fixture-user@example.com"
    );
    // No stray replacement characters or mojibake anywhere in the payload.
    expect(recording.body).not.toContain("\ufffd");
  });

  it("emits U+274C on a failed azure validation and still answers 200", async () => {
    const calls: Calls = { log: [] };
    const { deps, state } = fakes(calls, {
      azureValidation: { success: false, error: "no session" }
    });
    const recording = await run(
      "/api/oidc",
      '{"provider":"azure"}',
      handleOidc,
      deps
    );
    // A validation failure is a 200, not a 400. Only a throw reaches the 400.
    expect(recording.status).toBe(200);
    expect(recording.headerSteps).toEqual(SET_THEN_WRITE(200));
    const message = String(
      (JSON.parse(recording.body) as { message: unknown }).message
    );
    expect(message.codePointAt(0)).toBe(0x274c);
    expect(message).toBe("\u274c no session");
    expect(recording.body).toBe(
      '{"message":"\u274c no session","validated":false,"output":""}'
    );
    // Nothing is generated, cached or persisted on the failure path.
    expect(state?.oidcAzure).toBeUndefined();
    expect(calls.log).toEqual([
      'validateAzureCredentials({"provider":"azure"})',
      "readInstanceState(panel-a)"
    ]);
  });

  it("generates AWS instructions for any non-azure provider", async () => {
    const calls: Calls = { log: [] };
    const { deps, state } = fakes(calls);
    const recording = await run(
      "/api/oidc",
      '{"provider":"aws","accountId":"acct-1","accountName":"Acct","region":"us-east-1"}',
      handleOidc,
      deps
    );
    expect(recording.status).toBe(200);
    expect(recording.body).toBe(
      '{"message":"aws-oidc-message","output":"aws-oidc-output"}'
    );
    // Generation precedes the entry read on this branch, unlike the azure one.
    expect(calls.log).toEqual([
      'generateAWSOIDC({"provider":"aws","accountId":"acct-1","accountName":"Acct","region":"us-east-1"})',
      "readInstanceState(panel-a)"
    ]);
    expect(state?.oidcAws).toEqual({
      message: "aws-oidc-message",
      output: "aws-oidc-output",
      accountId: "acct-1",
      accountName: "Acct",
      region: "us-east-1"
    });
  });

  it("answers a missing instance entry without caching anything", async () => {
    const calls: Calls = { log: [] };
    const { deps, state } = fakes(calls, { missingEntry: true });
    const recording = await run("/api/oidc", "{}", handleOidc, deps);
    expect(recording.status).toBe(200);
    expect(state).toBeUndefined();
    expect(recording.body).toBe(
      '{"message":"aws-oidc-message","output":"aws-oidc-output"}'
    );
  });

  it("400s an empty body because the parse is unguarded", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls);
    const recording = await run("/api/oidc", "", handleOidc, deps);
    // Unlike the other three routes there is no `|| "{}"` fallback, so an empty
    // body throws into the catch rather than being treated as `{}`.
    expect(recording.status).toBe(400);
    expect(recording.headerSteps).toEqual(SET_THEN_WRITE(400));
    expect(JSON.parse(recording.body)).toHaveProperty("error");
    expect(calls.log).toEqual([]);
  });

  it("400s a null body rather than routing it to the aws branch", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls);
    const recording = await run("/api/oidc", "null", handleOidc, deps);
    // `JSON.parse("null").provider` throws. A guard would silently send this to
    // the AWS branch instead, which is why the bare read is preserved.
    expect(recording.status).toBe(400);
    expect(calls.log).toEqual([]);
  });

  it("400s a throwing azure validation with the inline detail, not the injected formatter", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      azureValidationThrows: new Error("az exploded")
    });
    const recording = await run(
      "/api/oidc",
      '{"provider":"azure"}',
      handleOidc,
      deps
    );
    expect(recording.status).toBe(400);
    // The `formatted:` prefix would appear if the handler used `errorMessage`.
    expect(recording.body).toBe('{"error":"az exploded"}');
  });

  it("400s when persisting the shared credential throws", async () => {
    const calls: Calls = { log: [] };
    const { deps, state } = fakes(calls, {
      saveThrows: new Error("disk full")
    });
    const recording = await run(
      "/api/oidc",
      '{"provider":"azure"}',
      handleOidc,
      deps
    );
    expect(recording.status).toBe(400);
    expect(recording.body).toBe('{"error":"disk full"}');
    // The entry cache was already written before the save failed.
    expect(state?.oidcAzure).toBeDefined();
  });

  // ── POST /api/verify-azure-login ──────────────────────────────────────────

  it("verifies an existing azure session and reports the account", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls);
    const recording = await run(
      "/api/verify-azure-login",
      `{"tenantId":"${TENANT_A}","subscriptionId":"${SUBSCRIPTION}"}`,
      handleVerifyAzureLogin,
      deps
    );
    expect(recording.status).toBe(200);
    expect(recording.headerSteps).toEqual(SET_THEN_WRITE(200));
    expect(JSON.parse(recording.body)).toEqual({
      success: true,
      user: "fixture-user@example.com",
      tenantId: TENANT_A,
      subscriptionId: SUBSCRIPTION,
      subscriptionName: "Fixture Subscription"
    });
    // The subscription switch precedes the account read, and both use the
    // 10s timeout the legacy branch passed.
    expect(calls.log).toEqual([
      `azureCredentialIdValidationError(${TENANT_A}|${SUBSCRIPTION})`,
      `runCommand(az account set --subscription ${SUBSCRIPTION}|10000)`,
      "runCommand(az account show -o json|10000)"
    ]);
  });

  it("never runs az login", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls);
    await run(
      "/api/verify-azure-login",
      `{"tenantId":"${TENANT_A}"}`,
      handleVerifyAzureLogin,
      deps
    );
    // An interactive login would block this server indefinitely. The fake
    // throws on any unscripted vector, so a login attempt would already fail;
    // this asserts the intent explicitly.
    expect(calls.log.some((c) => c.includes("az login"))).toBe(false);
  });

  it("rejects a non-GUID identifier before running anything", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls);
    const recording = await run(
      "/api/verify-azure-login",
      `{"tenantId":"${NOT_A_GUID}"}`,
      handleVerifyAzureLogin,
      deps
    );
    // A 200 with an error payload, not a 400.
    expect(recording.status).toBe(200);
    expect(recording.body).toBe(`{"error":"invalid-tenant:${NOT_A_GUID}"}`);
    expect(calls.log).toEqual([
      `azureCredentialIdValidationError(${NOT_A_GUID}|)`
    ]);
  });

  it("continues when the subscription switch fails", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      commands: {
        [`az account set --subscription ${SUBSCRIPTION}`]: new Error(
          "no such subscription"
        )
      }
    });
    const recording = await run(
      "/api/verify-azure-login",
      `{"subscriptionId":"${SUBSCRIPTION}"}`,
      handleVerifyAzureLogin,
      deps
    );
    expect(recording.status).toBe(200);
    expect(JSON.parse(recording.body)).toHaveProperty("success", true);
  });

  it("reports a missing Azure CLI with its own code", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      commands: {
        "az account show -o json": new Error("spawn az ENOENT")
      }
    });
    const recording = await run(
      "/api/verify-azure-login",
      `{"tenantId":"${TENANT_A}"}`,
      handleVerifyAzureLogin,
      deps
    );
    expect(recording.status).toBe(200);
    expect(JSON.parse(recording.body)).toEqual({
      error: "Azure CLI is not installed.",
      code: "az-cli-missing",
      tenantId: TENANT_A
    });
    // The missing-CLI probe reads the raw error message, not the injected
    // formatter, so no `formatted:` prefix reaches it.
    expect(calls.log).toContain("isCliCommandMissing(spawn az ENOENT)");
  });

  it("asks for a login when the CLI is present but has no session", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      commands: { "az account show -o json": new Error("Please run az login") }
    });
    const recording = await run(
      "/api/verify-azure-login",
      `{"tenantId":"${TENANT_A}"}`,
      handleVerifyAzureLogin,
      deps
    );
    expect(recording.status).toBe(200);
    expect(JSON.parse(recording.body)).toEqual({
      error: `login-required(${TENANT_A}|)`,
      code: "az-login-required",
      tenantId: TENANT_A
    });
  });

  it("reports a tenant mismatch against the active session", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls);
    const recording = await run(
      "/api/verify-azure-login",
      `{"tenantId":"${TENANT_B}"}`,
      handleVerifyAzureLogin,
      deps
    );
    expect(recording.status).toBe(200);
    expect(JSON.parse(recording.body)).toEqual({
      error: `login-required(${TENANT_B}|${TENANT_A})`,
      code: "az-login-required",
      tenantId: TENANT_B
    });
  });

  it("compares tenants case-insensitively", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      commands: {
        "az account show -o json": JSON.stringify({
          ...AZ_ACCOUNT,
          tenantId: TENANT_A.toUpperCase()
        })
      },
      uuids: [TENANT_A, TENANT_A.toUpperCase(), TENANT_B, SUBSCRIPTION]
    });
    const recording = await run(
      "/api/verify-azure-login",
      `{"tenantId":"${TENANT_A}"}`,
      handleVerifyAzureLogin,
      deps
    );
    expect(JSON.parse(recording.body)).toHaveProperty("success", true);
  });

  it("answers a malformed body with 200 and the injected formatter", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls);
    const recording = await run(
      "/api/verify-azure-login",
      "not json",
      handleVerifyAzureLogin,
      deps
    );
    // 200, not 400 — and the outer catch *does* use `errorMessage` here, unlike
    // the /api/oidc catch, so the `formatted:` prefix must be present.
    expect(recording.status).toBe(200);
    expect(recording.headerSteps).toEqual(SET_THEN_WRITE(200));
    expect(
      String((JSON.parse(recording.body) as { error: string }).error)
    ).toContain("Azure CLI verification failed: formatted:");
  });

  // ── POST /api/azure-cli-assist ────────────────────────────────────────────

  it("asks the session to start a login and answers 200", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls);
    const recording = await run(
      "/api/azure-cli-assist",
      `{"tenantId":"${TENANT_A}"}`,
      handleAzureCliAssist,
      deps
    );
    expect(recording.status).toBe(200);
    expect(recording.headerSteps).toEqual(SET_THEN_WRITE(200));
    expect(JSON.parse(recording.body)).toEqual({
      success: true,
      message:
        "Asked Copilot to start Azure login. Complete the sign-in flow it opens, then click Verify Credentials again."
    });
    expect(calls.log).toEqual([
      `isUuid(${TENANT_A})`,
      `buildAzureCliAssistPrompt(login|${TENANT_A})`,
      `runSessionPrompt(prompt:login:${TENANT_A})`
    ]);
  });

  it("uses the install wording only for the literal install action", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls);
    const install = await run(
      "/api/azure-cli-assist",
      '{"action":"install"}',
      handleAzureCliAssist,
      deps
    );
    expect(JSON.parse(install.body)).toEqual({
      success: true,
      message:
        "Asked Copilot to help install Azure CLI and start Azure login. Complete the steps it opens, then click Verify Credentials again."
    });

    const other: Calls = { log: [] };
    const otherDeps = fakes(other).deps;
    const fallback = await run(
      "/api/azure-cli-assist",
      '{"action":"INSTALL"}',
      handleAzureCliAssist,
      otherDeps
    );
    expect(other.log[1]).toBe("buildAzureCliAssistPrompt(login|)");
    expect(
      String((JSON.parse(fallback.body) as { message: string }).message)
    ).toContain("Asked Copilot to start Azure login.");
  });

  it("drops a tenant the GUID guard rejects", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls);
    const recording = await run(
      "/api/azure-cli-assist",
      `{"tenantId":"  ${NOT_A_GUID}  "}`,
      handleAzureCliAssist,
      deps
    );
    expect(recording.status).toBe(200);
    // Trimmed first, then rejected, so the prompt carries an empty tenant.
    expect(calls.log).toEqual([
      `isUuid(${NOT_A_GUID})`,
      "buildAzureCliAssistPrompt(login|)",
      "runSessionPrompt(prompt:login:)"
    ]);
  });

  it("ignores a non-string tenant without trimming it", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls);
    await run(
      "/api/azure-cli-assist",
      '{"tenantId":42}',
      handleAzureCliAssist,
      deps
    );
    expect(calls.log[0]).toBe("isUuid()");
  });

  it("writes the prompt failure status dynamically", async () => {
    // 503 (no session hook) and 502 (session rejected) are distinct
    // client-visible outcomes. Pinning either to a constant collapses them.
    for (const status of [503, 502]) {
      const calls: Calls = { log: [] };
      const { deps } = fakes(calls, {
        promptOutcome: { status, error: `prompt failed ${status}` }
      });
      const recording = await run(
        "/api/azure-cli-assist",
        "{}",
        handleAzureCliAssist,
        deps
      );
      expect(recording.status).toBe(status);
      expect(recording.headerSteps).toEqual(SET_THEN_WRITE(status));
      expect(recording.body).toBe(`{"error":"prompt failed ${status}"}`);
    }
  });

  it("treats an empty body as an empty object", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls);
    const recording = await run(
      "/api/azure-cli-assist",
      "",
      handleAzureCliAssist,
      deps
    );
    expect(recording.status).toBe(200);
    expect(calls.log[1]).toBe("buildAzureCliAssistPrompt(login|)");
  });

  it("400s a malformed body with the inline detail", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls);
    const recording = await run(
      "/api/azure-cli-assist",
      "not json",
      handleAzureCliAssist,
      deps
    );
    expect(recording.status).toBe(400);
    expect(recording.headerSteps).toEqual(SET_THEN_WRITE(400));
    expect(recording.body).not.toContain("formatted:");
  });

  it("400s a throwing session prompt", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      promptThrows: new Error("session gone")
    });
    const recording = await run(
      "/api/azure-cli-assist",
      "{}",
      handleAzureCliAssist,
      deps
    );
    expect(recording.status).toBe(400);
    expect(recording.body).toBe('{"error":"session gone"}');
  });

  // ── POST /api/verify-aws-login ────────────────────────────────────────────

  it("reports the caller identity from an existing aws session", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls);
    const recording = await run(
      "/api/verify-aws-login",
      '{"accountId":"ignored","region":"eu-west-1"}',
      handleVerifyAwsLogin,
      deps
    );
    expect(recording.status).toBe(200);
    expect(recording.headerSteps).toEqual(SET_THEN_WRITE(200));
    expect(JSON.parse(recording.body)).toEqual({
      success: true,
      // The live account wins over the submitted one.
      accountId: AWS_IDENTITY.Account,
      arn: AWS_IDENTITY.Arn,
      user: "fixture-user",
      region: "eu-west-1"
    });
    expect(calls.log).toEqual([
      "runCommand(aws sts get-caller-identity --output json|15000)"
    ]);
  });

  it("falls back to the submitted account when the identity has none", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      commands: {
        "aws sts get-caller-identity --output json": JSON.stringify({})
      }
    });
    const recording = await run(
      "/api/verify-aws-login",
      '{"accountId":"submitted-account"}',
      handleVerifyAwsLogin,
      deps
    );
    expect(JSON.parse(recording.body)).toEqual({
      success: true,
      accountId: "submitted-account",
      arn: "",
      user: "",
      region: ""
    });
  });

  it("reports a missing aws session with the fixed message", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      commands: {
        "aws sts get-caller-identity --output json": new Error(
          "spawn aws ENOENT"
        )
      }
    });
    const recording = await run(
      "/api/verify-aws-login",
      "{}",
      handleVerifyAwsLogin,
      deps
    );
    // The underlying CLI error is deliberately swallowed here.
    expect(recording.status).toBe(200);
    expect(recording.body).toBe(
      '{"error":"No active AWS CLI session. Run \\"aws configure\\" (or \\"aws sso login\\") in your terminal, then click Verify again."}'
    );
    expect(recording.body).not.toContain("ENOENT");
  });

  it("answers a malformed body with 200 and the injected formatter", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls);
    const recording = await run(
      "/api/verify-aws-login",
      "not json",
      handleVerifyAwsLogin,
      deps
    );
    expect(recording.status).toBe(200);
    expect(
      String((JSON.parse(recording.body) as { error: string }).error)
    ).toContain("AWS CLI verification failed: formatted:");
  });
});

// ── Differential oracle ─────────────────────────────────────────────────────
// Verbatim transcriptions of the four branches deleted from the legacy if-chain
// in `server.ts`, kept only so the migrated handlers can be proven identical
// while the fallback still exists. Each side is driven separately against its
// own fakes and its own cloned state, and the two recordings are compared
// afterwards — never through a single shared runner, because several of these
// paths throw or return early and a shared runner can pass while only
// exercising one side.

interface LegacyPorts {
  validateAzureCredentials: IdentityAuthDependencies["validateAzureCredentials"];
  generateAzureOIDC: IdentityAuthDependencies["generateAzureOIDC"];
  generateAWSOIDC: IdentityAuthDependencies["generateAWSOIDC"];
  readInstanceState: IdentityAuthDependencies["readInstanceState"];
  setSharedAzureCredentials: IdentityAuthDependencies["setSharedAzureCredentials"];
  saveCredentials: IdentityAuthDependencies["saveCredentials"];
  azureCredentialIdValidationError: IdentityAuthDependencies["azureCredentialIdValidationError"];
  azureLoginRequiredResponse: IdentityAuthDependencies["azureLoginRequiredResponse"];
  isCliCommandMissing: IdentityAuthDependencies["isCliCommandMissing"];
  isUuid: IdentityAuthDependencies["isUuid"];
  buildAzureCliAssistPrompt: IdentityAuthDependencies["buildAzureCliAssistPrompt"];
  runSessionPrompt: IdentityAuthDependencies["runSessionPrompt"];
  runCommand: IdentityAuthDependencies["runCommand"];
  errorMessage: IdentityAuthDependencies["errorMessage"];
}

function legacyErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function legacyOidc(
  body: string,
  res: ServerResponse<IncomingMessage>,
  ports: LegacyPorts
): Promise<void> {
  try {
    const data = JSON.parse(body);
    if (data.provider === "azure") {
      const validation = await ports.validateAzureCredentials(data);
      const entry = ports.readInstanceState("panel-a");
      if (validation.success) {
        const result = {
          message: `✅ Azure authentication confirmed — logged in as ${
            validation.userName || "user"
          }`,
          validated: true,
          tenantId: validation.tenantId,
          subscriptionId: validation.subscriptionId,
          subscriptionName: validation.subscriptionName,
          userName: validation.userName,
          output: ports.generateAzureOIDC(data).output
        };
        if (entry) {
          entry.oidcAzure = {
            ...result,
            clientId: data.clientId || "",
            tenantName: "",
            clientName: ""
          };
        }
        ports.setSharedAzureCredentials({
          tenantId: validation.tenantId,
          subscriptionId: validation.subscriptionId,
          subscriptionName: validation.subscriptionName,
          userName: validation.userName,
          clientId: data.clientId || ""
        });
        ports.saveCredentials();
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify(result));
      } else {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(
          JSON.stringify({
            message: `❌ ${validation.error}`,
            validated: false,
            output: ""
          })
        );
      }
    } else {
      const result = ports.generateAWSOIDC(data);
      const entry = ports.readInstanceState("panel-a");
      if (entry) {
        entry.oidcAws = {
          ...result,
          accountId: data.accountId || "",
          accountName: data.accountName || "",
          region: data.region || ""
        };
      }
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify(result));
    }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e || "");
    res.setHeader("Content-Type", "application/json");
    res.writeHead(400);
    res.end(JSON.stringify({ error: detail || "Bad request." }));
  }
}

async function legacyVerifyAzureLogin(
  body: string,
  res: ServerResponse<IncomingMessage>,
  ports: LegacyPorts
): Promise<void> {
  try {
    const data = JSON.parse(body);
    const tenantId = (data.tenantId || "").trim();
    const subscriptionId = (data.subscriptionId || "").trim();

    const validationError = ports.azureCredentialIdValidationError({
      tenantId,
      subscriptionId
    });
    if (validationError) {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify({ error: validationError }));
      return;
    }

    if (subscriptionId) {
      try {
        await ports.runCommand(
          "az",
          ["account", "set", "--subscription", subscriptionId],
          { timeout: 10000 }
        );
      } catch (e) {}
    }

    let acct;
    try {
      const acctJson = await ports.runCommand(
        "az",
        ["account", "show", "-o", "json"],
        { timeout: 10000 }
      );
      acct = JSON.parse(acctJson);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e || "");
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      if (ports.isCliCommandMissing(detail)) {
        res.end(
          JSON.stringify({
            error: "Azure CLI is not installed.",
            code: "az-cli-missing",
            tenantId
          })
        );
      } else {
        res.end(JSON.stringify(ports.azureLoginRequiredResponse({ tenantId })));
      }
      return;
    }

    if (
      tenantId &&
      acct.tenantId &&
      acct.tenantId.toLowerCase() !== tenantId.toLowerCase()
    ) {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(
        JSON.stringify(
          ports.azureLoginRequiredResponse({
            tenantId,
            activeTenantId: acct.tenantId
          })
        )
      );
      return;
    }

    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(
      JSON.stringify({
        success: true,
        user: acct.user?.name || "",
        tenantId: acct.tenantId,
        subscriptionId: acct.id,
        subscriptionName: acct.name
      })
    );
  } catch (e) {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(
      JSON.stringify({
        error: "Azure CLI verification failed: " + ports.errorMessage(e)
      })
    );
  }
}

async function legacyAzureCliAssist(
  body: string,
  res: ServerResponse<IncomingMessage>,
  ports: LegacyPorts
): Promise<void> {
  try {
    const data = JSON.parse(body || "{}");
    const action = data.action === "install" ? "install" : "login";
    const requestedTenantId =
      typeof data.tenantId === "string" ? data.tenantId.trim() : "";
    const tenantId = ports.isUuid(requestedTenantId) ? requestedTenantId : "";
    const prompt = ports.buildAzureCliAssistPrompt({ action, tenantId });
    const promptResult = await ports.runSessionPrompt(prompt);
    if (promptResult.error) {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(promptResult.status);
      res.end(JSON.stringify({ error: promptResult.error }));
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(
      JSON.stringify({
        success: true,
        message:
          action === "install" ?
            "Asked Copilot to help install Azure CLI and start Azure login. Complete the steps it opens, then click Verify Credentials again."
          : "Asked Copilot to start Azure login. Complete the sign-in flow it opens, then click Verify Credentials again."
      })
    );
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e || "");
    res.setHeader("Content-Type", "application/json");
    res.writeHead(400);
    res.end(JSON.stringify({ error: detail || "Bad request." }));
  }
}

async function legacyVerifyAwsLogin(
  body: string,
  res: ServerResponse<IncomingMessage>,
  ports: LegacyPorts
): Promise<void> {
  try {
    const data = JSON.parse(body || "{}");
    let ident;
    try {
      const out = await ports.runCommand(
        "aws",
        ["sts", "get-caller-identity", "--output", "json"],
        { timeout: 15000 }
      );
      ident = JSON.parse(out);
    } catch (e) {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(
        JSON.stringify({
          error:
            'No active AWS CLI session. Run "aws configure" (or "aws sso login") in your terminal, then click Verify again.'
        })
      );
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(
      JSON.stringify({
        success: true,
        accountId: ident.Account || data.accountId || "",
        arn: ident.Arn || "",
        user:
          ident.Arn ? String(ident.Arn).split("/").pop() : ident.Account || "",
        region: data.region || ""
      })
    );
  } catch (e) {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(
      JSON.stringify({
        error: "AWS CLI verification failed: " + ports.errorMessage(e)
      })
    );
  }
}

type Route =
  "oidc" | "verify-azure-login" | "azure-cli-assist" | "verify-aws-login";

interface DifferentialCase {
  route: Route;
  body?: string;
  options?: FakeOptions;
}

interface Side {
  recording: Recording;
  calls: string[];
  state: CanvasState | undefined;
  thrown: string | null;
  // Recorded rather than inferred. A side that never ran leaves this false, and
  // `compare` asserts it on BOTH sides — that is what stops a case from
  // silently degenerating into a one-sided test when one implementation throws
  // or short-circuits before the other is reached.
  ran: boolean;
}

function compare(legacy: Side, migrated: Side): void {
  expect(legacy.ran, "legacy side was not driven").toBe(true);
  expect(migrated.ran, "migrated side was not driven").toBe(true);
  expect(migrated.thrown).toEqual(legacy.thrown);
  expect(migrated.recording).toEqual(legacy.recording);
  expect(migrated.calls).toEqual(legacy.calls);
  expect(migrated.state).toEqual(legacy.state);
}

function legacyPortsFrom(deps: IdentityAuthDependencies): LegacyPorts {
  return {
    validateAzureCredentials: deps.validateAzureCredentials,
    generateAzureOIDC: deps.generateAzureOIDC,
    generateAWSOIDC: deps.generateAWSOIDC,
    readInstanceState: deps.readInstanceState,
    setSharedAzureCredentials: deps.setSharedAzureCredentials,
    saveCredentials: deps.saveCredentials,
    azureCredentialIdValidationError: deps.azureCredentialIdValidationError,
    azureLoginRequiredResponse: deps.azureLoginRequiredResponse,
    isCliCommandMissing: deps.isCliCommandMissing,
    isUuid: deps.isUuid,
    buildAzureCliAssistPrompt: deps.buildAzureCliAssistPrompt,
    runSessionPrompt: deps.runSessionPrompt,
    runCommand: deps.runCommand,
    errorMessage: deps.errorMessage
  };
}

const LEGACY_TRANSCRIPTIONS: Record<
  Route,
  (
    body: string,
    res: ServerResponse<IncomingMessage>,
    ports: LegacyPorts
  ) => void | Promise<void>
> = {
  oidc: legacyOidc,
  "verify-azure-login": legacyVerifyAzureLogin,
  "azure-cli-assist": legacyAzureCliAssist,
  "verify-aws-login": legacyVerifyAwsLogin
};

async function recordLegacy(input: DifferentialCase): Promise<Side> {
  const calls: Calls = { log: [] };
  const { deps, state } = fakes(calls, input.options ?? {});
  const { recording, response } = recorder();
  // Looked up rather than branched, so an unmapped route leaves `ran` false
  // instead of falling through to some other transcription.
  const transcription = LEGACY_TRANSCRIPTIONS[input.route];
  if (!transcription) {
    return { recording, calls: calls.log, state, thrown: null, ran: false };
  }
  let ran = false;
  try {
    ran = true;
    await transcription(input.body ?? "", response, legacyPortsFrom(deps));
  } catch (e) {
    return {
      recording,
      calls: calls.log,
      state,
      thrown: legacyErrorMessage(e),
      ran
    };
  }
  return { recording, calls: calls.log, state, thrown: null, ran };
}

const HANDLERS: Record<Route, Handler> = {
  oidc: handleOidc,
  "verify-azure-login": handleVerifyAzureLogin,
  "azure-cli-assist": handleAzureCliAssist,
  "verify-aws-login": handleVerifyAwsLogin
};

async function recordMigrated(input: DifferentialCase): Promise<Side> {
  const calls: Calls = { log: [] };
  const { deps, state } = fakes(calls, input.options ?? {});
  const { recording, response } = recorder();
  // Resolved from a registry rather than branched, so a route this harness
  // forgot to wire leaves `ran` false rather than quietly comparing two empty
  // recordings.
  const handler = HANDLERS[input.route];
  if (!handler) {
    return { recording, calls: calls.log, state, thrown: null, ran: false };
  }
  const context = createRequestContext(
    request("POST", `/api/${input.route}`, input.body ?? ""),
    response,
    "panel-a",
    new Map<string, CanvasServerEntry>()
  );
  let ran = false;
  try {
    ran = true;
    await handler(context, deps);
  } catch (e) {
    return {
      recording,
      calls: calls.log,
      state,
      thrown: legacyErrorMessage(e),
      ran
    };
  }
  return { recording, calls: calls.log, state, thrown: null, ran };
}

describe("identity-auth legacy/migrated differential contract", () => {
  // Fixture-precondition guard. The tenant-mismatch and CLI-missing cases below
  // only discriminate while these preconditions hold: if TENANT_B were edited
  // to equal the active session tenant, or the ENOENT marker were removed, the
  // corresponding differential cases would still pass while silently testing
  // the success path instead. Asserting the preconditions makes such an edit
  // fail loudly here.
  it("holds the fixture preconditions the differential cases depend on", () => {
    expect(AZ_ACCOUNT.tenantId).toBe(TENANT_A);
    expect(TENANT_A.toLowerCase()).not.toBe(TENANT_B.toLowerCase());
    // Both tenants must pass the GUID guard, or the mismatch case would be
    // rejected before the account is ever read.
    expect([TENANT_A, TENANT_B, SUBSCRIPTION]).not.toContain(NOT_A_GUID);
    // The default command map must answer every vector these routes issue, so
    // an "unscripted command vector" throw means a wrong-port call, never a
    // missing fixture.
    expect(Object.keys(DEFAULT_COMMANDS).sort()).toEqual([
      "aws sts get-caller-identity --output json",
      `az account set --subscription ${SUBSCRIPTION}`,
      "az account show -o json"
    ]);
    // The AWS user is derived from the ARN's last segment; a fixture without a
    // "/" would make the ARN and account fallbacks indistinguishable.
    expect(AWS_IDENTITY.Arn).toContain("/");
    expect(AWS_IDENTITY.Arn.split("/").pop()).not.toBe(AWS_IDENTITY.Account);
  });

  it.each<[string, DifferentialCase]>([
    [
      "successful azure validation",
      { route: "oidc", body: '{"provider":"azure","clientId":"client-1"}' }
    ],
    [
      "azure validation without a user name",
      {
        route: "oidc",
        body: '{"provider":"azure"}',
        options: {
          azureValidation: { success: true, tenantId: TENANT_A }
        }
      }
    ],
    [
      "failed azure validation",
      {
        route: "oidc",
        body: '{"provider":"azure"}',
        options: { azureValidation: { success: false, error: "no session" } }
      }
    ],
    [
      "azure validation with a missing instance entry",
      {
        route: "oidc",
        body: '{"provider":"azure"}',
        options: { missingEntry: true }
      }
    ],
    [
      "azure validation over pre-existing state",
      {
        route: "oidc",
        body: '{"provider":"azure"}',
        options: { state: { oidcAzure: { message: "stale" } } }
      }
    ],
    [
      "aws generation",
      {
        route: "oidc",
        body: '{"provider":"aws","accountId":"a","accountName":"n","region":"r"}'
      }
    ],
    ["absent provider", { route: "oidc", body: "{}" }],
    [
      "aws generation with a missing instance entry",
      { route: "oidc", body: "{}", options: { missingEntry: true } }
    ],
    ["empty body", { route: "oidc", body: "" }],
    ["null body", { route: "oidc", body: "null" }],
    ["scalar body", { route: "oidc", body: "42" }],
    ["malformed body", { route: "oidc", body: "not json" }],
    [
      "throwing azure validation",
      {
        route: "oidc",
        body: '{"provider":"azure"}',
        options: { azureValidationThrows: new Error("az exploded") }
      }
    ],
    [
      "throwing azure generation",
      {
        route: "oidc",
        body: '{"provider":"azure"}',
        options: { generateAzureThrows: new Error("no azure platform") }
      }
    ],
    [
      "throwing aws generation",
      {
        route: "oidc",
        body: "{}",
        options: { generateAwsThrows: new Error("no aws platform") }
      }
    ],
    [
      "throwing credential save",
      {
        route: "oidc",
        body: '{"provider":"azure"}',
        options: { saveThrows: new Error("disk full") }
      }
    ]
  ])("matches /api/oidc for a %s", async (_label, input) => {
    const legacy = await recordLegacy(input);
    const migrated = await recordMigrated(input);
    compare(legacy, migrated);
  });

  it.each<[string, DifferentialCase]>([
    [
      "verified session",
      {
        route: "verify-azure-login",
        body: `{"tenantId":"${TENANT_A}","subscriptionId":"${SUBSCRIPTION}"}`
      }
    ],
    ["ambient session", { route: "verify-azure-login", body: "{}" }],
    [
      "untrimmed identifiers",
      {
        route: "verify-azure-login",
        body: `{"tenantId":"  ${TENANT_A}  ","subscriptionId":"  ${SUBSCRIPTION}  "}`
      }
    ],
    [
      "non-GUID tenant",
      { route: "verify-azure-login", body: `{"tenantId":"${NOT_A_GUID}"}` }
    ],
    [
      "non-GUID subscription",
      {
        route: "verify-azure-login",
        body: `{"subscriptionId":"${NOT_A_GUID}"}`
      }
    ],
    [
      "failing subscription switch",
      {
        route: "verify-azure-login",
        body: `{"subscriptionId":"${SUBSCRIPTION}"}`,
        options: {
          commands: {
            [`az account set --subscription ${SUBSCRIPTION}`]: new Error(
              "no such subscription"
            )
          }
        }
      }
    ],
    [
      "missing azure CLI",
      {
        route: "verify-azure-login",
        body: `{"tenantId":"${TENANT_A}"}`,
        options: {
          commands: {
            "az account show -o json": new Error("spawn az ENOENT")
          }
        }
      }
    ],
    [
      "absent azure session",
      {
        route: "verify-azure-login",
        body: `{"tenantId":"${TENANT_A}"}`,
        options: {
          commands: {
            "az account show -o json": new Error("Please run az login")
          }
        }
      }
    ],
    [
      "unparseable account json",
      {
        route: "verify-azure-login",
        body: "{}",
        options: { commands: { "az account show -o json": "not json" } }
      }
    ],
    [
      "tenant mismatch",
      { route: "verify-azure-login", body: `{"tenantId":"${TENANT_B}"}` }
    ],
    [
      "case-insensitive tenant match",
      {
        route: "verify-azure-login",
        body: `{"tenantId":"${TENANT_A}"}`,
        options: {
          commands: {
            "az account show -o json": JSON.stringify({
              ...AZ_ACCOUNT,
              tenantId: TENANT_A.toUpperCase()
            })
          },
          uuids: [TENANT_A, TENANT_A.toUpperCase(), TENANT_B, SUBSCRIPTION]
        }
      }
    ],
    [
      "account without a user",
      {
        route: "verify-azure-login",
        body: "{}",
        options: {
          commands: {
            "az account show -o json": JSON.stringify({ tenantId: TENANT_A })
          }
        }
      }
    ],
    ["empty body", { route: "verify-azure-login", body: "" }],
    ["null body", { route: "verify-azure-login", body: "null" }],
    ["malformed body", { route: "verify-azure-login", body: "not json" }]
  ])("matches /api/verify-azure-login for a %s", async (_label, input) => {
    const legacy = await recordLegacy(input);
    const migrated = await recordMigrated(input);
    compare(legacy, migrated);
  });

  it.each<[string, DifferentialCase]>([
    [
      "login with a valid tenant",
      { route: "azure-cli-assist", body: `{"tenantId":"${TENANT_A}"}` }
    ],
    [
      "install action",
      { route: "azure-cli-assist", body: '{"action":"install"}' }
    ],
    [
      "non-literal install action",
      { route: "azure-cli-assist", body: '{"action":"INSTALL"}' }
    ],
    [
      "untrimmed valid tenant",
      { route: "azure-cli-assist", body: `{"tenantId":"  ${TENANT_A}  "}` }
    ],
    [
      "rejected tenant",
      { route: "azure-cli-assist", body: `{"tenantId":"${NOT_A_GUID}"}` }
    ],
    [
      "non-string tenant",
      { route: "azure-cli-assist", body: '{"tenantId":42}' }
    ],
    ["empty body", { route: "azure-cli-assist", body: "" }],
    ["null body", { route: "azure-cli-assist", body: "null" }],
    ["malformed body", { route: "azure-cli-assist", body: "not json" }],
    [
      "unreachable session",
      {
        route: "azure-cli-assist",
        body: "{}",
        options: {
          promptOutcome: { status: 503, error: "could not reach the session" }
        }
      }
    ],
    [
      "rejecting session",
      {
        route: "azure-cli-assist",
        body: "{}",
        options: {
          promptOutcome: { status: 502, error: "session could not start help" }
        }
      }
    ],
    [
      "throwing session prompt",
      {
        route: "azure-cli-assist",
        body: "{}",
        options: { promptThrows: new Error("session gone") }
      }
    ]
  ])("matches /api/azure-cli-assist for a %s", async (_label, input) => {
    const legacy = await recordLegacy(input);
    const migrated = await recordMigrated(input);
    compare(legacy, migrated);
  });

  it.each<[string, DifferentialCase]>([
    [
      "verified session",
      { route: "verify-aws-login", body: '{"region":"eu-west-1"}' }
    ],
    [
      "submitted account fallback",
      {
        route: "verify-aws-login",
        body: '{"accountId":"submitted-account"}',
        options: {
          commands: {
            "aws sts get-caller-identity --output json": JSON.stringify({})
          }
        }
      }
    ],
    [
      "identity without an arn",
      {
        route: "verify-aws-login",
        body: "{}",
        options: {
          commands: {
            "aws sts get-caller-identity --output json": JSON.stringify({
              Account: "000011112222"
            })
          }
        }
      }
    ],
    [
      "absent aws session",
      {
        route: "verify-aws-login",
        body: "{}",
        options: {
          commands: {
            "aws sts get-caller-identity --output json": new Error(
              "spawn aws ENOENT"
            )
          }
        }
      }
    ],
    [
      "unparseable identity json",
      {
        route: "verify-aws-login",
        body: "{}",
        options: {
          commands: { "aws sts get-caller-identity --output json": "not json" }
        }
      }
    ],
    ["empty body", { route: "verify-aws-login", body: "" }],
    ["null body", { route: "verify-aws-login", body: "null" }],
    ["malformed body", { route: "verify-aws-login", body: "not json" }]
  ])("matches /api/verify-aws-login for a %s", async (_label, input) => {
    const legacy = await recordLegacy(input);
    const migrated = await recordMigrated(input);
    compare(legacy, migrated);
  });
});
