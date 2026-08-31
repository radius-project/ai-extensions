import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRadiusAppProvenanceTags } from "../../azure-oidc.js";
import { createOperation, prepareProviderMutation } from "../../operations.js";
import { createRequestContext } from "../request-context.js";
import { ENTRA_APP_RETENTION_NOTICE } from "./azure-auto-setup-application.js";
import {
  createAzureAutoSetupRoutes,
  handleAzureAutoSetup,
  parseAzureAccountIdentity
} from "./azure-auto-setup.js";
import type {
  AzureAutoSetupCommandResult,
  AzureAutoSetupDependencies,
  AzureAutoSetupFailureInput,
  AzureAutoSetupOperation
} from "./azure-auto-setup-types.js";
import {
  CALLER_IDENTITY_COMMAND_PREFIX,
  callerIdentityResult,
  createAzureAutoSetupTestDependencies
} from "../../../test/support/server/azure-auto-setup.js";

const SUBSCRIPTION = "22222222-2222-2222-2222-222222222222";
const TENANT = "11111111-1111-1111-1111-111111111111";
const APP_ID = "33333333-3333-3333-3333-333333333333";
const USER_ID = "44444444-4444-4444-4444-444444444444";

describe("Azure account identity parsing", () => {
  it("accepts the subscription and tenant GUIDs Azure reports", () => {
    expect(
      parseAzureAccountIdentity(
        JSON.stringify({ id: SUBSCRIPTION, tenantId: TENANT })
      )
    ).toEqual({ subscriptionId: SUBSCRIPTION, tenantId: TENANT });
  });

  it.each([
    ["invalid JSON", "{"],
    ["a non-object", "[]"],
    ["a non-string tenant", JSON.stringify({ id: SUBSCRIPTION, tenantId: 42 })],
    ["a non-string subscription", JSON.stringify({ id: 42, tenantId: TENANT })]
  ])("rejects %s", (_label, stdout) => {
    expect(parseAzureAccountIdentity(stdout)).toBeNull();
  });
});

const servers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
  servers.clear();
});

async function invoke(
  body: string,
  dependencies: AzureAutoSetupDependencies,
  headers: Record<string, string> = {
    "X-Radius-Server-Owned": "test-token"
  }
) {
  const server = createServer(async (request, response) => {
    const context = createRequestContext(
      request,
      response,
      "panel-a",
      new Map()
    );
    await handleAzureAutoSetup(context, dependencies);
  });
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Azure auto-setup test server did not bind.");
  }
  return fetch(`http://127.0.0.1:${address.port}/api/azure-auto-setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body
  });
}

function finalizingDependencies() {
  const calls: AzureAutoSetupFailureInput[] = [];
  return {
    calls,
    dependencies: createAzureAutoSetupTestDependencies({
      finalizeSetupFailure: async (_operation, input) => {
        calls.push(input);
        return {
          status: Number(input.status),
          body: {
            error: String(input.error),
            code: String(input.code)
          }
        };
      }
    })
  };
}

const VALID_SETUP = {
  repo: "octo/app",
  environment: "dev",
  resourceGroup: "rg-radius",
  cluster: "aks-radius",
  subscriptionId: SUBSCRIPTION
};

function orchestrationHarness(
  options: {
    operation?: AzureAutoSetupOperation;
    getOperation?: (operationId: string) => AzureAutoSetupOperation | undefined;
    isStale?: (operation: AzureAutoSetupOperation) => boolean;
    identity?: AzureAutoSetupDependencies["external"]["getGitHubIdentity"];
    repoAccess?: string;
    preflightRepoAdmin?: AzureAutoSetupDependencies["external"]["preflightRepoAdmin"];
    packageAccess?: Awaited<
      ReturnType<
        AzureAutoSetupDependencies["external"]["preflightGhcrPackageWriteAccess"]
      >
    >;
    preflightGhcrPackageWriteAccess?: AzureAutoSetupDependencies["external"]["preflightGhcrPackageWriteAccess"];
    runGitHubJson?: AzureAutoSetupDependencies["external"]["runGitHubJson"];
    runAz?: AzureAutoSetupDependencies["external"]["runAz"];
    ensureServicePrincipal?: AzureAutoSetupDependencies["ensureServicePrincipal"];
    honorStopBoundary?: AzureAutoSetupDependencies["honorStopBoundary"];
    hasWarnings?: boolean;
    persist?: () => Promise<void>;
    addLegacyStep?: AzureAutoSetupDependencies["operations"]["addLegacyStep"];
  } = {}
) {
  const operation = options.operation ?? {
    operationId: "op-route",
    repo: "octo/app",
    environment: "dev",
    provider: "azure",
    currentStage: "authorize_identity"
  };
  const events: string[] = [];
  const failures: AzureAutoSetupFailureInput[] = [];
  const writtenCredentialFiles: string[] = [];
  const runAz =
    options.runAz ??
    (async (args: string[]): Promise<AzureAutoSetupCommandResult> => {
      const line = args.join(" ");
      events.push(`az:${line}`);
      if (line.startsWith("account set ")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (line === "account show --output json") {
        return {
          code: 0,
          stdout: JSON.stringify({ id: SUBSCRIPTION, tenantId: TENANT }),
          stderr: ""
        };
      }
      if (line.startsWith(`ad app show --id ${APP_ID} `)) {
        return { code: 0, stdout: "app-object", stderr: "" };
      }
      if (line.startsWith(CALLER_IDENTITY_COMMAND_PREFIX)) {
        return callerIdentityResult();
      }
      if (line.startsWith("ad signed-in-user show ")) {
        return { code: 0, stdout: USER_ID, stderr: "" };
      }
      if (line.startsWith(`ad app owner list --id ${APP_ID}`)) {
        return { code: 0, stdout: USER_ID, stderr: "" };
      }
      if (line.includes("federated-credential list")) {
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              id: "fic-dev",
              name: "dev",
              subject: "repo:octo/app:environment:dev",
              issuer: "https://token.actions.githubusercontent.com",
              audiences: ["api://AzureADTokenExchange"]
            },
            {
              id: "fic-dev-immutable",
              name: "dev-immutable",
              subject: "repo:octo@7/app@5:environment:dev",
              issuer: "https://token.actions.githubusercontent.com",
              audiences: ["api://AzureADTokenExchange"]
            }
          ]),
          stderr: ""
        };
      }
      if (line.includes("federated-credential create")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      // Our credential setup re-reads the just-created federated credential to
      // verify and record its provenance. Echo the written credential document
      // so the live identity matches the required subject/issuer/audiences.
      if (line.includes("federated-credential show")) {
        const contents = JSON.parse(writtenCredentialFiles.at(-1) || "{}");
        return {
          code: 0,
          stdout: JSON.stringify({ id: "fic-created", ...contents }),
          stderr: ""
        };
      }
      if (line.startsWith("role assignment create ")) {
        return { code: 1, stdout: "", stderr: "already exists" };
      }
      throw new Error(`unscripted az call: ${line}`);
    });
  const dependencies = createAzureAutoSetupTestDependencies({
    operations: {
      get: options.getOperation ?? (() => undefined),
      isStale: options.isStale ?? (() => false),
      create: () => operation,
      persist:
        options.persist ??
        (async () => {
          events.push("persist");
        }),
      report: (diagnostic) => events.push(`report:${diagnostic.code}`),
      enterStage: () => events.push("enter-stage"),
      setStageState: (_operation, _stage, state) =>
        events.push(`stage:${state}`),
      hasWarnings: () => options.hasWarnings ?? false,
      addLegacyStep:
        options.addLegacyStep ??
        ((_operation, text) => {
          events.push(`step:${text}`);
        }),
      resumeAfterInput: () => events.push("resume"),
      requireInput: () => events.push("require-input")
    },
    external: {
      getGitHubIdentity:
        options.identity ??
        (async () => {
          return null;
        }),
      preflightRepoAdmin:
        options.preflightRepoAdmin ?? (async () => options.repoAccess ?? ""),
      preflightGhcrPackageWriteAccess:
        options.preflightGhcrPackageWriteAccess ??
        (async () => options.packageAccess ?? { ok: true }),
      runGitHubJson:
        options.runGitHubJson ??
        (async (path) => {
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
          if (path.includes("/variables/AZURE_CLIENT_ID")) {
            return { ok: false, status: 404, json: null };
          }
          throw new Error(`unscripted GitHub call: ${path}`);
        }),
      runAz
    },
    tempFile: {
      createPath: () => "C:\\temp\\fic.json",
      write: (_path: string, contents: string) => {
        writtenCredentialFiles.push(contents);
      },
      remove: () => {}
    },
    ensureServicePrincipal:
      options.ensureServicePrincipal ??
      (async () => ({
        ok: true,
        state: "reused",
        origin: "pre_existing",
        objectId: USER_ID
      })),
    persistMutationCheckpoint: async (input) => {
      await input.persist();
      return true;
    },
    honorStopBoundary:
      options.honorStopBoundary ??
      (async ({ boundary }) => {
        events.push(`stop:${boundary}`);
        return true;
      }),
    finalizeSetupFailure: async (_operation, input) => {
      failures.push(input);
      return {
        status: input.status,
        body: {
          error: input.error,
          code: input.code,
          ...(input.extra ?? {})
        }
      };
    },
    sleep: async () => {}
  });
  return { dependencies, events, failures, operation };
}

describe("POST /api/azure-auto-setup construction (SU-01)", () => {
  it("declares exactly its one route", () => {
    expect(
      Object.keys(
        createAzureAutoSetupRoutes(createAzureAutoSetupTestDependencies())
      )
    ).toEqual(["POST /api/azure-auto-setup"]);
  });

  it.each([
    ["isServerOwnedRequest"],
    ["ensureServicePrincipal"],
    ["finalizeSetupFailure"],
    ["persistMutationCheckpoint"],
    ["sleep"]
  ])("rejects a missing %s dependency during construction", (name) => {
    const dependencies = createAzureAutoSetupTestDependencies();
    Reflect.set(dependencies, name, undefined);
    expect(() => createAzureAutoSetupRoutes(dependencies)).toThrow(
      `Missing Azure auto-setup dependency: ${name}`
    );
  });

  it.each([
    ["operations", "persist"],
    ["external", "runAz"],
    ["tempFile", "createPath"],
    ["tempFile", "write"],
    ["tempFile", "remove"]
  ])(
    "rejects a missing %s.%s dependency during construction",
    (group, name) => {
      const dependencies = createAzureAutoSetupTestDependencies();
      const target = Reflect.get(dependencies, group);
      Reflect.set(target, name, undefined);
      expect(() => createAzureAutoSetupRoutes(dependencies)).toThrow(
        `Missing Azure auto-setup dependency: ${group}.${name}`
      );
    }
  );

  it("rejects an empty stage id during construction", () => {
    const dependencies = createAzureAutoSetupTestDependencies({
      stageAuthorizeIdentity: ""
    });
    expect(() => createAzureAutoSetupRoutes(dependencies)).toThrow(
      "Missing Azure auto-setup dependency: stageAuthorizeIdentity"
    );
  });
});

describe("POST /api/azure-auto-setup admission and validation (SU-08)", () => {
  it("refuses a browser-owned request before reading or finalizing its body", async () => {
    const response = await invoke(
      "{not-json",
      createAzureAutoSetupTestDependencies({
        isServerOwnedRequest: () => false
      }),
      {}
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe(
      '{"error":"This endpoint is reserved for server-owned operations.","code":"server-owned-operation-required"}'
    );
  });

  it.each([
    ["missing parameters", {}, "missing-params"],
    [
      "invalid repository",
      { ...VALID_SETUP, repo: "not a repo" },
      "invalid-repo"
    ],
    [
      "invalid resource group",
      { ...VALID_SETUP, resourceGroup: "-bad rg" },
      "invalid-resource-group"
    ],
    [
      "invalid cluster",
      { ...VALID_SETUP, cluster: "-bad cluster" },
      "invalid-cluster"
    ],
    [
      "invalid cluster resource group",
      { ...VALID_SETUP, clusterResourceGroup: "-bad rg" },
      "invalid-cluster-resource-group"
    ],
    [
      "invalid tenant",
      { ...VALID_SETUP, tenantId: "tenant" },
      "invalid-tenant"
    ],
    [
      "invalid subscription",
      { ...VALID_SETUP, subscriptionId: "subscription" },
      "invalid-subscription"
    ],
    [
      "invalid service management reference",
      { ...VALID_SETUP, serviceManagementReference: "tree" },
      "invalid-smr"
    ],
    [
      "missing subscription",
      { ...VALID_SETUP, subscriptionId: "" },
      "subscription-required"
    ]
  ])("reports %s before any external call", async (_label, body, code) => {
    const harness = finalizingDependencies();
    const response = await invoke(JSON.stringify(body), harness.dependencies);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code });
    expect(harness.calls).toHaveLength(1);
  });

  it("routes malformed JSON through the legacy unhandled failure contract", async () => {
    const harness = finalizingDependencies();
    const response = await invoke("{oops", harness.dependencies);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "setup-unhandled" });
    expect(harness.calls[0]).toMatchObject({
      status: 400,
      code: "setup-unhandled",
      classification: "unknown",
      steps: []
    });
  });

  it("rejects an unknown continuation before preflights", async () => {
    const harness = finalizingDependencies();
    const response = await invoke(
      JSON.stringify({ ...VALID_SETUP, operationId: "op-missing" }),
      harness.dependencies
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "operation-continuation-mismatch"
    });
  });

  it("skips unrelated write preflights while reconciling a provider mutation", async () => {
    const operation = createOperation({
      operationId: "op-reconcile",
      provider: "azure",
      repo: "octo/app",
      environment: "dev"
    }) as AzureAutoSetupOperation;
    operation.currentStage = "authorize_identity";
    prepareProviderMutation(operation, {
      kind: "azure_application.create",
      target: "octo/app:dev"
    });
    const preflightRepoAdmin = vi.fn(async () => {
      throw new Error("repository preflight must not run");
    });
    const preflightGhcrPackageWriteAccess = vi.fn(async () => {
      throw new Error("GHCR preflight must not run");
    });
    const harness = orchestrationHarness({
      operation,
      getOperation: () => operation,
      preflightRepoAdmin,
      preflightGhcrPackageWriteAccess,
      runAz: async () => {
        throw new Error("recovery path reached");
      }
    });

    const response = await invoke(
      JSON.stringify({ ...VALID_SETUP, operationId: operation.operationId }),
      harness.dependencies
    );

    expect(response.status).toBe(400);
    expect(preflightRepoAdmin).not.toHaveBeenCalled();
    expect(preflightGhcrPackageWriteAccess).not.toHaveBeenCalled();
  });

  it("reports the conflicting operation without persisting a new record", async () => {
    const operation: AzureAutoSetupOperation = {
      operationId: "op-new",
      repo: "octo/app",
      environment: "dev",
      provider: "azure",
      currentStage: "authorize_identity"
    };
    const response = await invoke(
      JSON.stringify(VALID_SETUP),
      createAzureAutoSetupTestDependencies({
        operations: {
          create: () => operation,
          start: () => ({
            ok: false,
            conflict: { operationId: "op-running" }
          })
        }
      })
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Setup is already running for octo/app.",
      code: "operation-in-progress",
      operationId: "op-running"
    });
  });

  it("distinguishes an earlier operation that must finish rollback", async () => {
    const operation: AzureAutoSetupOperation = {
      operationId: "op-new",
      repo: "octo/app",
      environment: "dev",
      provider: "azure",
      currentStage: "authorize_identity"
    };
    const response = await invoke(
      JSON.stringify(VALID_SETUP),
      createAzureAutoSetupTestDependencies({
        operations: {
          create: () => operation,
          start: () => ({
            ok: false,
            reason: "previous-cleanup-required",
            conflict: { operationId: "op-cleanup" }
          })
        }
      })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        "An earlier setup for octo/app must finish rollback before a new setup can start.",
      code: "previous-cleanup-required",
      operationId: "op-cleanup"
    });
  });

  it("fails closed when the initial operation record cannot be persisted", async () => {
    const journal: string[] = [];
    const operation: AzureAutoSetupOperation = {
      operationId: "op-write",
      repo: "octo/app",
      environment: "dev",
      provider: "azure",
      currentStage: "authorize_identity"
    };
    const response = await invoke(
      JSON.stringify(VALID_SETUP),
      createAzureAutoSetupTestDependencies({
        operations: {
          create: () => operation,
          persist: async () => {
            throw new Error("read-only store");
          },
          report: (diagnostic) => journal.push(`report:${diagnostic.code}`),
          finish: (_operation, state) => journal.push(`finish:${state}`)
        }
      })
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error:
        "Radius changed no cloud resources because it could not save the setup recovery record.",
      code: "operation-persistence-failed",
      operationId: "op-write"
    });
    expect(journal).toEqual([
      "report:operation-store-write-failed",
      "finish:failed"
    ]);
  });
});

describe("POST /api/azure-auto-setup orchestration (SU-08)", () => {
  it.each([
    [
      "repository admin preflight",
      { repoAccess: "Admin permission required." },
      403,
      "repo-admin-required"
    ],
    [
      "GHCR package preflight",
      {
        packageAccess: {
          ok: false as const,
          status: 403,
          error: "Package write permission required.",
          code: "package-write-required"
        }
      },
      403,
      "package-write-required"
    ]
  ])(
    "stops before Azure when %s fails",
    async (_label, options, status, code) => {
      const test = orchestrationHarness(options);
      const response = await invoke(
        JSON.stringify({ ...VALID_SETUP, clientId: APP_ID }),
        test.dependencies
      );

      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code });
      expect(test.events.some((event) => event.startsWith("az:"))).toBe(false);
    }
  );

  it("keeps GitHub identity narration advisory, including a failing step recorder", async () => {
    const test = orchestrationHarness({
      identity: async () => ({
        actingLogin: "automation",
        displayLogin: "human",
        mismatch: true
      }),
      addLegacyStep: () => {
        throw new Error("narration unavailable");
      }
    });
    const response = await invoke(
      JSON.stringify({ ...VALID_SETUP, clientId: APP_ID }),
      test.dependencies
    );

    const body = await response.clone().json();
    expect(response.status, JSON.stringify(body)).toBe(200);
  });

  it("ignores a GitHub identity lookup failure before enforcing repository access", async () => {
    const test = orchestrationHarness({
      identity: async () => {
        throw new Error("identity unavailable");
      },
      repoAccess: "Admin permission required."
    });
    const response = await invoke(
      JSON.stringify({ ...VALID_SETUP, clientId: APP_ID }),
      test.dependencies
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "repo-admin-required"
    });
  });

  it.each([
    [
      "subscription selection with details",
      {
        set: { code: 1, stdout: "", stderr: "subscription denied" },
        show: null
      },
      {},
      "az-subscription-set-failed"
    ],
    [
      "subscription selection without details",
      { set: { code: 1, stdout: "", stderr: "" }, show: null },
      {},
      "az-subscription-set-failed"
    ],
    [
      "Azure login",
      {
        set: { code: 0, stdout: "", stderr: "" },
        show: { code: 1, stdout: "", stderr: "not logged in" }
      },
      {},
      "az-not-logged-in"
    ],
    [
      "Azure account JSON parsing",
      {
        set: { code: 0, stdout: "", stderr: "" },
        show: { code: 0, stdout: "{oops", stderr: "" }
      },
      {},
      "az-account-parse"
    ],
    [
      "the requested tenant differs from the active tenant",
      {
        set: { code: 0, stdout: "", stderr: "" },
        show: {
          code: 0,
          stdout: JSON.stringify({ id: SUBSCRIPTION, tenantId: TENANT }),
          stderr: ""
        }
      },
      { tenantId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
      "az-tenant-mismatch"
    ],
    [
      "the resolved subscription is invalid",
      {
        set: { code: 0, stdout: "", stderr: "" },
        show: {
          code: 0,
          stdout: JSON.stringify({ id: "not-a-guid", tenantId: TENANT }),
          stderr: ""
        }
      },
      {},
      "invalid-subscription"
    ],
    [
      "the active tenant is missing",
      {
        set: { code: 0, stdout: "", stderr: "" },
        show: { code: 0, stdout: "null", stderr: "" }
      },
      {},
      "az-account-parse"
    ]
  ])(
    "reports %s before OIDC resolution",
    async (_label, results, patch, code) => {
      const test = orchestrationHarness({
        runAz: async (args) => {
          const line = args.join(" ");
          if (line.startsWith("account set ")) return results.set;
          if (line === "account show --output json" && results.show) {
            return results.show;
          }
          throw new Error(`unscripted az call: ${line}`);
        }
      });
      const response = await invoke(
        JSON.stringify({ ...VALID_SETUP, ...patch, clientId: APP_ID }),
        test.dependencies
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code });
    }
  );

  it("resumes an input-required operation before continuing setup", async () => {
    const existing: AzureAutoSetupOperation = {
      operationId: "op-resume",
      repo: "octo/app",
      environment: "production",
      provider: "azure",
      currentStage: "authorize_identity",
      inputRequired: { code: "app-selection-required" }
    };
    const test = orchestrationHarness({
      operation: existing,
      getOperation: () => existing
    });
    const response = await invoke(
      JSON.stringify({
        ...VALID_SETUP,
        environment: "Production",
        operationEnvironment: "production",
        operationId: existing.operationId,
        clientId: APP_ID
      }),
      test.dependencies
    );

    expect(response.status).toBe(200);
    expect(test.events).toContain("resume");
  });

  it("adopts the scheduler's existing operation before input is required", async () => {
    const existing: AzureAutoSetupOperation = {
      operationId: "op-scheduled",
      repo: "octo/app",
      environment: "dev",
      provider: "azure",
      currentStage: "authorize_identity"
    };
    const test = orchestrationHarness({
      operation: existing,
      getOperation: () => existing
    });
    const response = await invoke(
      JSON.stringify({
        ...VALID_SETUP,
        operationId: existing.operationId,
        clientId: APP_ID
      }),
      test.dependencies
    );

    expect(response.status).toBe(200);
    expect(test.events).not.toContain("resume");
  });

  it.each([
    ["stale", { state: "running" }, true],
    ["repository", { repo: "octo/other" }, false],
    ["environment", { environment: "prod" }, false],
    ["provider", { provider: "aws" }, false],
    ["stage", { currentStage: "configure_environment" }, false]
  ])(
    "rejects a continuation with mismatched %s state",
    async (_label, patch, stale) => {
      const existing: AzureAutoSetupOperation = {
        operationId: "op-resume",
        repo: "octo/app",
        environment: "dev",
        provider: "azure",
        currentStage: "authorize_identity",
        ...patch
      };
      const test = orchestrationHarness({
        operation: existing,
        getOperation: () => existing,
        isStale: () => stale
      });
      const response = await invoke(
        JSON.stringify({
          ...VALID_SETUP,
          operationId: existing.operationId,
          clientId: APP_ID
        }),
        test.dependencies
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "operation-continuation-mismatch"
      });
    }
  );

  it("marks a successful setup warning when credential work recorded warnings", async () => {
    const test = orchestrationHarness({ hasWarnings: true });
    const response = await invoke(
      JSON.stringify({ ...VALID_SETUP, clientId: APP_ID }),
      test.dependencies
    );

    expect(response.status).toBe(200);
    expect(test.events).toContain("stage:warning");
  });

  it("does not announce retention when credential setup fails for a newly created app", async () => {
    const requiredTags = buildRadiusAppProvenanceTags({
      repo: "octo/app",
      environment: "dev",
      operationId: "op-orchestration"
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
      if (line.startsWith("ad app list "))
        return { code: 0, stdout: "[]", stderr: "" };
      if (line.startsWith("ad app create "))
        return { code: 0, stdout: APP_ID, stderr: "" };
      if (line.startsWith(CALLER_IDENTITY_COMMAND_PREFIX)) {
        return callerIdentityResult();
      }
      if (line.startsWith("ad signed-in-user show "))
        return { code: 0, stdout: USER_ID, stderr: "" };
      if (line.startsWith(`ad app owner add --id ${APP_ID}`))
        return { code: 0, stdout: "", stderr: "" };
      if (line.startsWith(`ad app owner list --id ${APP_ID}`))
        return { code: 0, stdout: USER_ID, stderr: "" };
      if (line.startsWith("rest --method PATCH "))
        return { code: 0, stdout: "", stderr: "" };
      if (line.startsWith(`ad app show --id ${APP_ID} --query tags`)) {
        return {
          code: 0,
          stdout: JSON.stringify(requiredTags),
          stderr: ""
        };
      }
      throw new Error(`unscripted az call: ${line}`);
    };
    const test = orchestrationHarness({
      runAz,
      ensureServicePrincipal: async () => ({
        ok: false,
        stderr: "service principal denied"
      })
    });
    const response = await invoke(
      JSON.stringify({
        repo: "octo/app",
        environment: "dev",
        resourceGroup: "rg-radius",
        cluster: "aks-radius",
        subscriptionId: SUBSCRIPTION,
        appName: "radius-deploy-octo-app"
      }),
      test.dependencies
    );

    expect(response.status).toBe(400);
    expect(test.events.join("\n")).not.toContain(ENTRA_APP_RETENTION_NOTICE);
  });

  it("returns the credential failure without completing the operation stage", async () => {
    const test = orchestrationHarness({
      ensureServicePrincipal: async () => ({
        ok: false,
        stderr: "service principal denied"
      })
    });
    const response = await invoke(
      JSON.stringify({ ...VALID_SETUP, clientId: APP_ID }),
      test.dependencies
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "sp-failed" });
    expect(test.events.some((event) => event.startsWith("stage:"))).toBe(false);
  });

  it("passes a ready Azure runner into the generic failure finalizer", async () => {
    const test = orchestrationHarness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.startsWith("account set ")) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (line === "account show --output json") {
          return {
            code: 0,
            stdout: JSON.stringify({ id: SUBSCRIPTION, tenantId: TENANT }),
            stderr: ""
          };
        }
        throw new Error("Azure directory unavailable");
      }
    });
    const response = await invoke(
      JSON.stringify({ ...VALID_SETUP, clientId: APP_ID }),
      test.dependencies
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "setup-unhandled" });
    expect(test.failures[0]?.runAz).toEqual(expect.any(Function));
    await expect(
      test.failures[0]?.runAz?.(["account", "show", "--output", "json"])
    ).resolves.toMatchObject({ code: 0 });
  });

  it("preserves a structured OIDC failure code from the GitHub resolver", async () => {
    const oidcError = Object.assign(new Error("OIDC metadata unavailable"), {
      code: "oidc-metadata-unavailable"
    });
    const test = orchestrationHarness({
      runGitHubJson: async () => {
        throw oidcError;
      }
    });
    const response = await invoke(
      JSON.stringify({ ...VALID_SETUP, clientId: APP_ID }),
      test.dependencies
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "oidc-metadata-unavailable",
      error: "OIDC metadata unavailable"
    });
  });

  it("wires checkpoint diagnostics and failure handling back to the operation ports", async () => {
    const test = orchestrationHarness();
    test.dependencies.persistMutationCheckpoint = async (input) => {
      input.report({ code: "checkpoint-report", message: "store unavailable" });
      await input.fail(
        500,
        "Could not persist the mutation checkpoint.",
        "checkpoint-failed"
      );
      return false;
    };
    const response = await invoke(
      JSON.stringify({ ...VALID_SETUP, clientId: APP_ID }),
      test.dependencies
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "checkpoint-failed" });
    expect(test.events).toContain("report:checkpoint-report");
    expect(test.failures[0]?.runAz).toEqual(expect.any(Function));
    await expect(
      test.failures[0]?.runAz?.(["account", "show", "--output", "json"])
    ).resolves.toMatchObject({ code: 0 });
  });

  it("uses the workflow responder when reuse persistence fails after initial admission", async () => {
    let writes = 0;
    const test = orchestrationHarness({
      persist: async () => {
        writes += 1;
        if (writes > 1) throw new Error("read-only store");
      }
    });
    const response = await invoke(
      JSON.stringify({ ...VALID_SETUP, clientId: APP_ID }),
      test.dependencies
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "operation-persistence-failed",
      operationId: "op-route"
    });
  });

  it("turns application selection into resumable input without finalizing failure", async () => {
    const candidates = [
      { appId: APP_ID, displayName: "Radius One", createdDateTime: "one" },
      {
        appId: "55555555-5555-5555-5555-555555555555",
        displayName: "Radius Two",
        createdDateTime: "two"
      }
    ];
    const test = orchestrationHarness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.startsWith("account set ")) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (line === "account show --output json") {
          return {
            code: 0,
            stdout: JSON.stringify({ id: SUBSCRIPTION, tenantId: TENANT }),
            stderr: ""
          };
        }
        if (line.startsWith("ad app list ")) {
          return {
            code: 0,
            stdout: JSON.stringify(candidates),
            stderr: ""
          };
        }
        if (line.startsWith(CALLER_IDENTITY_COMMAND_PREFIX)) {
          return callerIdentityResult();
        }
        if (line.startsWith("ad signed-in-user show ")) {
          return { code: 0, stdout: USER_ID, stderr: "" };
        }
        if (line.startsWith("ad app owner list ")) {
          return { code: 0, stdout: USER_ID, stderr: "" };
        }
        if (line.includes("federated-credential list")) {
          return { code: 1, stdout: "", stderr: "unavailable" };
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });

    const response = await invoke(
      JSON.stringify(VALID_SETUP),
      test.dependencies
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "app-selection-required",
      inputRequired: true,
      operationId: "op-route"
    });
    expect(test.events).toContain("require-input");
    expect(test.failures).toEqual([]);
  });

  it("honors a pending Stop after persisting input instead of showing a prompt", async () => {
    const boundaries: string[] = [];
    const test = orchestrationHarness({
      honorStopBoundary: async ({ boundary }) => {
        boundaries.push(boundary);
        return boundary !== "input_prompt";
      },
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.startsWith("account set ")) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (line === "account show --output json") {
          return {
            code: 0,
            stdout: JSON.stringify({ id: SUBSCRIPTION, tenantId: TENANT }),
            stderr: ""
          };
        }
        if (line.startsWith("ad app list ")) {
          return {
            code: 0,
            stdout: JSON.stringify([
              { appId: APP_ID, displayName: "One" },
              {
                appId: "55555555-5555-5555-5555-555555555555",
                displayName: "Two"
              }
            ]),
            stderr: ""
          };
        }
        if (line.startsWith(CALLER_IDENTITY_COMMAND_PREFIX)) {
          return callerIdentityResult();
        }
        if (line.startsWith("ad signed-in-user show ")) {
          return { code: 0, stdout: USER_ID, stderr: "" };
        }
        if (line.startsWith("ad app owner list ")) {
          return { code: 0, stdout: USER_ID, stderr: "" };
        }
        if (line.includes("federated-credential list")) {
          return { code: 1, stdout: "", stderr: "unavailable" };
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });

    const response = await invoke(
      JSON.stringify(VALID_SETUP),
      test.dependencies
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      cancelled: true,
      code: "operation-stopped",
      boundary: "input_prompt",
      operationId: "op-route"
    });
    expect(test.events).toContain("require-input");
    expect(test.events).toContain("persist");
    expect(boundaries).toContain("input_prompt");
    expect(test.failures).toEqual([]);
  });

  it("honors Stop before changing the process-wide Azure subscription", async () => {
    const test = orchestrationHarness({
      honorStopBoundary: async ({ boundary }) =>
        boundary !== "before-azure-subscription-selection",
      runAz: async (args) => {
        throw new Error(`unexpected az call: ${args.join(" ")}`);
      }
    });

    const response = await invoke(
      JSON.stringify({ ...VALID_SETUP, clientId: APP_ID }),
      test.dependencies
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      code: "operation-stopped",
      boundary: "before-azure-subscription-selection"
    });
  });

  it("answers the internal request when Stop wins after an Azure mutation", async () => {
    const boundaries: string[] = [];
    const test = orchestrationHarness({
      honorStopBoundary: async ({ boundary }) => {
        boundaries.push(boundary);
        return boundary !== "after-app-registration-create";
      },
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.startsWith("account set ")) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (line === "account show --output json") {
          return {
            code: 0,
            stdout: JSON.stringify({ id: SUBSCRIPTION, tenantId: TENANT }),
            stderr: ""
          };
        }
        if (line.startsWith("ad app list ")) {
          return { code: 0, stdout: "[]", stderr: "" };
        }
        if (line.startsWith(CALLER_IDENTITY_COMMAND_PREFIX)) {
          return callerIdentityResult();
        }
        if (line.startsWith("ad signed-in-user show ")) {
          return { code: 0, stdout: USER_ID, stderr: "" };
        }
        if (line.startsWith("ad app create ")) {
          return { code: 0, stdout: APP_ID, stderr: "" };
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });

    const response = await invoke(
      JSON.stringify({ ...VALID_SETUP, createNew: true, clientId: "" }),
      test.dependencies
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      cancelled: true,
      code: "operation-stopped",
      boundary: "after-app-registration-create",
      operationId: "op-route"
    });
    expect(boundaries).toContain("after-app-registration-create");
    expect(
      test.events.some((event) => event.startsWith("az:ad app owner add "))
    ).toBe(false);
  });

  it("preserves side-effect order and returns the credential result", async () => {
    const journal: string[] = [];
    const written: string[] = [];
    const removed: string[] = [];
    const operation: AzureAutoSetupOperation = {
      operationId: "op-success",
      repo: "octo/app",
      environment: "dev",
      provider: "azure",
      currentStage: "authorize_identity"
    };
    let persistenceCount = 0;
    const runAz = async (
      args: string[]
    ): Promise<AzureAutoSetupCommandResult> => {
      const command = args.join(" ");
      journal.push(`az:${command}`);
      if (command.startsWith("account set ")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "account show --output json") {
        return {
          code: 0,
          stdout: JSON.stringify({ id: SUBSCRIPTION, tenantId: TENANT }),
          stderr: ""
        };
      }
      if (command.startsWith(`ad app show --id ${APP_ID} `)) {
        return { code: 0, stdout: "app-object", stderr: "" };
      }
      if (command.startsWith(CALLER_IDENTITY_COMMAND_PREFIX)) {
        return callerIdentityResult();
      }
      if (command.startsWith("ad signed-in-user show ")) {
        return { code: 0, stdout: USER_ID, stderr: "" };
      }
      if (command.startsWith(`ad app owner list --id ${APP_ID}`)) {
        return { code: 0, stdout: USER_ID, stderr: "" };
      }
      if (command.includes("federated-credential list")) {
        return { code: 0, stdout: "[]", stderr: "" };
      }
      if (command.includes("federated-credential create")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command.includes("federated-credential show")) {
        const contents = JSON.parse(written.at(-1) || "{}");
        return {
          code: 0,
          stdout: JSON.stringify({
            id: "fic-dev",
            ...contents
          }),
          stderr: ""
        };
      }
      if (command.startsWith("role assignment create ")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unscripted az call: ${command}`);
    };

    const response = await invoke(
      JSON.stringify({ ...VALID_SETUP, clientId: APP_ID }),
      createAzureAutoSetupTestDependencies({
        operations: {
          create: () => operation,
          persist: async () => {
            persistenceCount += 1;
            journal.push(`persist:${persistenceCount}`);
          },
          addLegacyStep: (_operation, text) => journal.push(`step:${text}`),
          recordAzureApp: () => journal.push("record:app"),
          recordServicePrincipal: () => journal.push("record:sp"),
          recordCreatedFederatedCredential: () => journal.push("record:fic"),
          recordCreatedRoleAssignment: (_operation, entry) =>
            journal.push(`record:role:${entry.role}`),
          setStageState: (_operation, _stage, state) =>
            journal.push(`stage:${state}`)
        },
        external: {
          getGitHubIdentity: async () => ({
            actingLogin: "octo",
            displayLogin: "octo",
            mismatch: false
          }),
          preflightRepoAdmin: async () => {
            journal.push("preflight:repo");
            return "";
          },
          preflightGhcrPackageWriteAccess: async () => {
            journal.push("preflight:ghcr");
            return { ok: true };
          },
          runGitHubJson: async (path) => {
            journal.push(`github:${path}`);
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
            throw new Error(`unscripted GitHub call: ${path}`);
          },
          runAz
        },
        tempFile: {
          createPath: () => "C:\\temp\\fic.json",
          write: (_path, contents) => {
            written.push(contents);
          },
          remove: (path) => {
            removed.push(path);
          }
        },
        ensureServicePrincipal: async () => ({
          ok: true,
          state: "reused",
          origin: "pre_existing",
          objectId: USER_ID
        }),
        persistMutationCheckpoint: async (input) => {
          journal.push("checkpoint");
          await input.persist();
          return true;
        },
        finalizeSetupFailure: async (_operation, input) => {
          throw new Error(`unexpected setup failure: ${String(input.code)}`);
        },
        sleep: async () => {}
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    const payload = await response.json();
    expect(payload).toMatchObject({
      success: true,
      operationId: "op-success",
      clientId: APP_ID,
      tenantId: TENANT,
      subscriptionId: SUBSCRIPTION,
      resourceGroup: "rg-radius",
      cluster: "aks-radius"
    });
    expect(written.length).toBeGreaterThan(0);
    expect(removed).toEqual(written.map(() => "C:\\temp\\fic.json"));
    expect(journal.indexOf("preflight:ghcr")).toBeLessThan(
      journal.findIndex((entry) => entry.startsWith("az:account set "))
    );
    expect(journal.indexOf("record:app")).toBeLessThan(
      journal.indexOf("record:sp")
    );
    expect(journal.at(-1)).not.toBe("checkpoint");
    expect(journal).toContain("stage:succeeded");
  });
});
