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
// Named so related cases share stable values rather than repeating literals that
// could drift apart.

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const SUBSCRIPTION = "33333333-3333-3333-3333-333333333333";
const NOT_A_GUID = "x&calc";

// Load-bearing fixture values used by the route behavior cases.
const USER_NAME = "fixture-user@example.com";
const SUBSCRIPTION_NAME = "Fixture Subscription";
const SWITCH_KEY = `az account set --subscription ${SUBSCRIPTION}`;
const ACCOUNT_SHOW_KEY = "az account show -o json";
const AWS_IDENTITY_KEY = "aws sts get-caller-identity --output json";
const SWITCH_FAILURE = "no such subscription";
const NO_SESSION_ERROR = "Please run az login";
const CLI_MISSING_ERROR = "spawn az ENOENT";
const AWS_CLI_MISSING_ERROR = "spawn aws ENOENT";

const DEFAULT_AZURE_VALIDATION = {
  success: true,
  tenantId: TENANT_A,
  subscriptionId: SUBSCRIPTION,
  subscriptionName: SUBSCRIPTION_NAME,
  userName: USER_NAME
};

const AZ_ACCOUNT = {
  tenantId: TENANT_A,
  id: SUBSCRIPTION,
  name: SUBSCRIPTION_NAME,
  user: { name: USER_NAME }
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
  [SWITCH_KEY]: "",
  [ACCOUNT_SHOW_KEY]: JSON.stringify(AZ_ACCOUNT),
  [AWS_IDENTITY_KEY]: JSON.stringify(AWS_IDENTITY)
};

// One independent set of fakes plus the mutable state they read and write.
function fakes(
  calls: Calls,
  options: FakeOptions = {}
): { deps: IdentityAuthDependencies; state: CanvasState | undefined } {
  const state =
    options.missingEntry ? undefined : structuredClone(options.state ?? {});
  // A case's scripted command must *override* a default vector, never add a
  // new one. A key that drifts out of sync with DEFAULT_COMMANDS is otherwise
  // completely silent: the real vector still succeeds, the case collapses into
  // the plain success case, and it keeps asserting the same outcome while no
  // longer covering the branch it was written for. Verified, not theorized -
  // pointing the failing-switch case at a stale key left all 83 tests green.
  // This turns that drift into a loud throw at the point of use, which covers
  // every present and future case rather than one guarded fixture.
  for (const key of Object.keys(options.commands ?? {})) {
    if (!(key in DEFAULT_COMMANDS)) {
      throw new Error(
        `scripted command "${key}" overrides nothing; expected one of ${Object.keys(
          DEFAULT_COMMANDS
        ).join(", ")}`
      );
    }
  }
  const commands = { ...DEFAULT_COMMANDS, ...(options.commands ?? {}) };
  const uuids = new Set(options.uuids ?? [TENANT_A, TENANT_B, SUBSCRIPTION]);
  const deps: IdentityAuthDependencies = {
    validateAzureCredentials: (data) => {
      calls.log.push(`validateAzureCredentials(${JSON.stringify(data)})`);
      if (options.azureValidationThrows) {
        return Promise.reject(options.azureValidationThrows);
      }
      return Promise.resolve(
        options.azureValidation ?? DEFAULT_AZURE_VALIDATION
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
    buildAzureCliAssistMessage: ({ action, tenantId }) => {
      calls.log.push(`buildAzureCliAssistMessage(${action}|${tenantId})`);
      return {
        prompt: `prompt:${action}:${tenantId}`,
        displayPrompt: `display:${action}:${tenantId}`
      };
    },
    runSessionPrompt: (message) => {
      calls.log.push(`runSessionPrompt(${JSON.stringify(message)})`);
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
        [SWITCH_KEY]: new Error(SWITCH_FAILURE)
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
        [ACCOUNT_SHOW_KEY]: new Error(CLI_MISSING_ERROR)
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
      commands: { [ACCOUNT_SHOW_KEY]: new Error(NO_SESSION_ERROR) }
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
      `buildAzureCliAssistMessage(login|${TENANT_A})`,
      `runSessionPrompt({"prompt":"prompt:login:${TENANT_A}","displayPrompt":"display:login:${TENANT_A}"})`
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
    expect(other.log[1]).toBe("buildAzureCliAssistMessage(login|)");
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
      "buildAzureCliAssistMessage(login|)",
      'runSessionPrompt({"prompt":"prompt:login:","displayPrompt":"display:login:"})'
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
    expect(calls.log[1]).toBe("buildAzureCliAssistMessage(login|)");
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
        [AWS_IDENTITY_KEY]: new Error(AWS_CLI_MISSING_ERROR)
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
