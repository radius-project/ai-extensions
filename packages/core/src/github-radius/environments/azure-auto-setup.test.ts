import { describe, expect, it } from "vitest";
import {
  createOperation,
  operationDomain
} from "../../../test/support/environment-operation-domain.js";
import {
  parseAzureAccountIdentity,
  runAzureAutoSetup,
  validateAzureAutoSetupDependencies
} from "./azure-auto-setup.js";
import type {
  AzureAutoSetupDependencies,
  AzureAutoSetupCommandResult,
  AzureAutoSetupFailureInput,
  AzureAutoSetupOperation
} from "./azure-auto-setup-types.js";
import { buildRadiusAppProvenanceTags } from "./azure-oidc.js";
import { ProviderMutationRecoveryError } from "./provider-mutation-recovery.js";

function unexpected(): never {
  throw new Error("Unexpected external operation");
}

function harness() {
  const events: string[] = [];
  const operation: AzureAutoSetupOperation = {
    providerRecovery: createOperation().providerRecovery,
    operationId: "op-independent",
    repo: "octo/app",
    environment: "dev",
    provider: "azure",
    currentStage: "authorize"
  };
  const dependencies: AzureAutoSetupDependencies = {
    operationDomain,
    deterministicProviderUuid: unexpected,
    operations: {
      get: () => operation,
      isStale: () => false,
      create: () => operation,
      buildStages: () => [],
      start: () => ({ ok: true }),
      persist: async () => {
        events.push("persist");
      },
      report: () => {
        events.push("diagnostic");
      },
      finish: (op, state) => {
        op.state = state;
      },
      enterStage: (op, stage) => {
        op.currentStage = stage;
      },
      setStageState: unexpected,
      hasWarnings: unexpected,
      addLegacyStep: (_op, step) => {
        events.push(step);
      },
      setContext: () => {
        events.push("context");
      },
      setCloudContext: () => {
        events.push("cloud-context");
      },
      requireInput: unexpected,
      resumeAfterInput: unexpected,
      withCredentialProvenanceLock: unexpected,
      recordAzureApp: unexpected,
      recordServicePrincipal: unexpected,
      recordCreatedFederatedCredential: unexpected,
      recordFederatedCredentialProvenance: unexpected,
      recordCreatedRoleAssignment: unexpected
    },
    external: {
      getSelectedGitHubExecutor: () => ({
        login: "octocat",
        credentialSource: "keyring",
        requiresKeyringSwitch: false,
        scopes: ["repo", "workflow"],
        run: unexpected,
        runOrThrow: unexpected,
        verifyIdentity: async () => {
          events.push("identity");
        },
        packageCredentials: unexpected,
        redact: (value) => value,
        errorMessage: (error) => String(error)
      }),
      getGitHubIdentity: unexpected,
      preflightRepoAdmin: async () => {
        events.push("admin");
        return "";
      },
      preflightGhcrPackageWriteAccess: async () => ({ ok: true }),
      runGitHubJson: unexpected,
      runAz: unexpected
    },
    tempFile: { createPath: unexpected, write: unexpected, remove: unexpected },
    ensureServicePrincipal: unexpected,
    finalizeSetupFailure: async (_op, input) => ({
      status: input.status,
      body: { error: input.error, code: input.code }
    }),
    persistMutationCheckpoint: async ({ persist }) => {
      await persist();
      return true;
    },
    honorStopBoundary: async () => true,
    sleep: unexpected,
    stageAuthorizeIdentity: "authorize"
  };
  return { operation, dependencies, events };
}

const request = {
  repo: "octo/app",
  environment: "dev",
  resourceGroup: "group",
  cluster: "cluster",
  subscriptionId: "22222222-2222-2222-2222-222222222222"
};

const tenantId = "11111111-1111-1111-1111-111111111111";
const clientId = "33333333-3333-3333-3333-333333333333";
const ownerId = "44444444-4444-4444-4444-444444444444";

function command(stdout = "", code: string | number = 0, stderr = "") {
  return { stdout, code, stderr };
}

function provisionHarness() {
  const test = harness();
  const azCalls: string[][] = [];
  const failures: AzureAutoSetupFailureInput[] = [];
  const inputs: Record<string, unknown>[] = [];
  const stages: string[] = [];
  const artifacts: Record<string, unknown>[] = [];
  const contexts: Record<string, unknown>[] = [];
  const creations: Record<string, unknown>[] = [];
  const credentials = [
    "repo:octo/app:environment:dev",
    "repo:octo@7/app@5:environment:dev"
  ].map((subject, index) => ({
    id: `credential-${index}`,
    name: `dev-${index}`,
    subject,
    issuer: "https://token.actions.githubusercontent.com",
    audiences: ["api://AzureADTokenExchange"]
  }));
  const runAz = async (
    args: string[]
  ): Promise<AzureAutoSetupCommandResult> => {
    azCalls.push(args);
    const line = args.join(" ");
    if (line.startsWith("account set ")) return command();
    if (line === "account show --output json") {
      return command(
        JSON.stringify({
          id: request.subscriptionId,
          tenantId,
          user: { type: "user", name: "developer@example.test" }
        })
      );
    }
    if (line.startsWith("ad signed-in-user show ")) return command(ownerId);
    if (line.startsWith("ad app owner list ")) return command(ownerId);
    if (line.startsWith("ad app show ") && line.includes("--query tags")) {
      return command(
        JSON.stringify(
          buildRadiusAppProvenanceTags({
            repo: request.repo,
            environment: request.environment,
            operationId: test.operation.operationId
          })
        )
      );
    }
    if (line.startsWith("ad app show ")) return command("application-object");
    if (line.startsWith("ad app list ")) return command("[]");
    if (line.startsWith("ad app create ")) return command(clientId);
    if (line.startsWith("ad app owner add ")) return command();
    if (line.startsWith("rest --method PATCH ")) return command();
    if (line.includes("federated-credential list"))
      return command(JSON.stringify(credentials));
    if (line.startsWith("role assignment create "))
      return command("", 1, "already exists");
    throw new Error(`Unscripted Azure command: ${line}`);
  };
  Object.assign(test.dependencies.operations, {
    create: (input: Record<string, unknown>) => {
      creations.push(input);
      return test.operation;
    },
    setStageState: (
      _operation: AzureAutoSetupOperation,
      _stage: string,
      state: string
    ) => stages.push(state),
    hasWarnings: () => false,
    setContext: (
      _operation: AzureAutoSetupOperation,
      context: Record<string, unknown>
    ) => contexts.push(context),
    requireInput: (
      _operation: AzureAutoSetupOperation,
      input: Record<string, unknown>
    ) => inputs.push(input),
    resumeAfterInput: () => test.events.push("resume"),
    withCredentialProvenanceLock: async <T>(work: () => Promise<T>) => work(),
    recordAzureApp: (
      _operation: AzureAutoSetupOperation,
      artifact: Record<string, unknown>
    ) => artifacts.push(artifact),
    recordServicePrincipal: () => test.events.push("principal"),
    recordFederatedCredentialProvenance: async () => {
      test.events.push("provenance");
    }
  });
  test.dependencies.deterministicProviderUuid = (seed) => seed;
  test.dependencies.external.runAz = runAz;
  test.dependencies.external.runGitHubJson = async (path, executor) => {
    expect(executor?.login).toBe("octocat");
    if (path === "/repos/octo/app") {
      return {
        ok: true,
        status: 200,
        json: { full_name: request.repo, id: 5, owner: { id: 7 } }
      };
    }
    if (
      path.endsWith("/actions/oidc/customization/sub") ||
      path.endsWith("/variables/AZURE_CLIENT_ID")
    ) {
      return { ok: false, status: 404, json: null };
    }
    throw new Error(`Unscripted GitHub path: ${path}`);
  };
  test.dependencies.ensureServicePrincipal = async () => ({
    ok: true,
    state: "reused",
    origin: "pre_existing",
    objectId: ownerId
  });
  test.dependencies.finalizeSetupFailure = async (_operation, failure) => {
    failures.push(failure);
    return {
      status: failure.status,
      body: { code: failure.code, error: failure.error }
    };
  };
  return {
    ...test,
    azCalls,
    failures,
    inputs,
    stages,
    artifacts,
    contexts,
    creations,
    runAz
  };
}

describe("Azure account identity at the shared boundary", () => {
  it.each([
    "{",
    "null",
    "[]",
    "42",
    '{"id":42}',
    '{"id":"subscription","tenantId":42}'
  ])("rejects malformed Azure account output %s", (stdout) => {
    expect(parseAzureAccountIdentity(stdout)).toBeNull();
  });
  it("trims account IDs and classifies the caller from the same response", () => {
    expect(
      parseAzureAccountIdentity(
        JSON.stringify({
          id: ` ${request.subscriptionId} `,
          tenantId: ` ${tenantId} `,
          user: { type: "servicePrincipal", name: clientId }
        })
      )
    ).toEqual({
      subscriptionId: request.subscriptionId,
      tenantId,
      callerIdentity: { kind: "servicePrincipal", appId: clientId }
    });
    expect(
      parseAzureAccountIdentity(JSON.stringify({ id: request.subscriptionId }))
    ).toMatchObject({ tenantId: "", callerIdentity: { kind: "unsupported" } });
  });
});

describe("shared Azure orchestration contracts", () => {
  it.each([
    [{ repo: "invalid" }, "invalid-repo"],
    [{ resourceGroup: "-bad group" }, "invalid-resource-group"],
    [{ cluster: "-bad cluster" }, "invalid-cluster"],
    [{ clusterResourceGroup: "-bad group" }, "invalid-cluster-resource-group"],
    [{ tenantId: "tenant" }, "invalid-tenant"],
    [{ subscriptionId: "subscription" }, "invalid-subscription"],
    [{ serviceManagementReference: "reference" }, "invalid-smr"]
  ])(
    "rejects invalid setup input %j without cloud calls",
    async (patch, code) => {
      const test = provisionHarness();
      expect(
        await runAzureAutoSetup({ ...request, ...patch }, test.dependencies)
      ).toMatchObject({ status: 400, body: { code } });
      expect(test.azCalls).toEqual([]);
      expect(test.failures[0]?.runAz).toBeNull();
    }
  );

  it.each([
    ["missing", undefined],
    ["repository", { repo: "other/repo" }],
    ["environment", { environment: "other" }],
    ["provider", { provider: "aws" }],
    ["stage", { currentStage: "deploy" }],
    ["stale", {}]
  ] as const)(
    "refuses a %s continuation before external calls",
    async (reason, patch) => {
      const test = provisionHarness();
      test.dependencies.operations.get = () =>
        patch ? { ...test.operation, ...patch } : undefined;
      test.dependencies.operations.isStale = () => reason === "stale";
      expect(
        await runAzureAutoSetup(
          { ...request, operationId: "existing" },
          test.dependencies
        )
      ).toMatchObject({
        status: 409,
        body: { code: "operation-continuation-mismatch" }
      });
      expect(test.azCalls).toEqual([]);
    }
  );

  it.each([false, true])(
    "resumes a matching operation with input required=%s",
    async (inputRequired) => {
      const test = provisionHarness();
      test.operation.inputRequired = inputRequired;
      test.operation.environment = "operation-env";
      expect(
        await runAzureAutoSetup(
          {
            ...request,
            operationId: test.operation.operationId,
            operationEnvironment: "operation-env",
            appId: clientId,
            tenantId
          },
          test.dependencies
        )
      ).toMatchObject({ outcome: "completed", body: { clientId, tenantId } });
      expect(test.creations).toEqual([]);
      expect(test.events.includes("resume")).toBe(inputRequired);
    }
  );

  it("returns the active operation conflict without finalizing it", async () => {
    const test = provisionHarness();
    test.dependencies.operations.start = () => ({
      ok: false,
      conflict: { operationId: "busy-operation" }
    });
    expect(await runAzureAutoSetup(request, test.dependencies)).toMatchObject({
      status: 409
    });
    expect(test.failures).toEqual([]);
    expect(test.azCalls).toEqual([]);
  });

  it.each([new Error("disk full"), "disk unavailable"])(
    "fails closed when the initial recovery record cannot be saved: %s",
    async (error) => {
      const test = provisionHarness();
      test.dependencies.operations.persist = async () => {
        throw error;
      };
      expect(await runAzureAutoSetup(request, test.dependencies)).toMatchObject(
        { status: 500, body: { code: "operation-persistence-failed" } }
      );
      expect(test.operation.state).toBe("failed");
      expect(test.events).toContain("diagnostic");
      expect(test.azCalls).toEqual([]);
    }
  );

  it.each(["repo", "package"])(
    "refuses unavailable %s permissions before Azure selection",
    async (kind) => {
      const test = provisionHarness();
      if (kind === "repo")
        test.dependencies.external.preflightRepoAdmin = async () =>
          "Repository admin required";
      else
        test.dependencies.external.preflightGhcrPackageWriteAccess =
          async () => ({
            ok: false,
            status: 403,
            error: "Package access denied",
            code: "package-denied"
          });
      expect(await runAzureAutoSetup(request, test.dependencies)).toMatchObject(
        {
          status: 403,
          body: {
            code: kind === "repo" ? "repo-admin-required" : "package-denied"
          }
        }
      );
      expect(test.azCalls).toEqual([]);
    }
  );

  it.each([
    ["selection", command("", 1), "az-subscription-set-failed"],
    ["account", command("", 1), "az-not-logged-in"],
    ["account", command("{"), "az-account-parse"],
    [
      "account",
      command(JSON.stringify({ id: "invalid", tenantId })),
      "invalid-subscription"
    ],
    [
      "account",
      command(JSON.stringify({ id: request.subscriptionId })),
      "az-account-incomplete"
    ],
    [
      "account",
      command(
        JSON.stringify({ id: request.subscriptionId, tenantId: ownerId })
      ),
      "az-tenant-mismatch"
    ]
  ])("surfaces %s preflight failure %s", async (stage, output, code) => {
    const test = provisionHarness();
    test.dependencies.external.runAz = async (args) =>
      args[1] === (stage === "selection" ? "set" : "show") ?
        output
      : test.runAz(args);
    expect(
      await runAzureAutoSetup({ ...request, tenantId }, test.dependencies)
    ).toMatchObject({ status: 400, body: { code } });
    expect(test.artifacts).toEqual([]);
    expect(test.failures[0]?.runAz).toBeTypeOf("function");
  });

  it.each([
    new Error("GitHub unavailable"),
    Object.assign(new Error("OIDC rejected"), { code: "custom-oidc-error" }),
    Object.assign(new Error("Empty error code"), { code: "" }),
    "GitHub disconnected",
    null,
    []
  ])("preserves OIDC lookup failure %s without provisioning", async (error) => {
    const test = provisionHarness();
    test.dependencies.external.runGitHubJson = async () => {
      throw error;
    };
    const result = await runAzureAutoSetup(request, test.dependencies);
    expect(result.status).toBe(400);
    expect(result.body.error).toBe(
      error instanceof Error ? error.message : String(error)
    );
    expect(test.artifacts).toEqual([]);
  });

  it.each([false, true])(
    "completes reused setup with warnings=%s despite advisory narration failures",
    async (warnings) => {
      const test = provisionHarness();
      test.dependencies.operations.hasWarnings = () => warnings;
      test.dependencies.operations.addLegacyStep = () => {
        throw new Error("Narration unavailable");
      };
      const original = test.dependencies.operations.setContext;
      test.dependencies.operations.setContext = (operation, patch) => {
        if ("githubLogin" in patch)
          throw new Error("Identity narration unavailable");
        original(operation, patch);
      };
      expect(
        await runAzureAutoSetup(
          {
            ...request,
            appId: clientId,
            environment: "",
            origin: "graph",
            resumeTarget: "deploy",
            resumeBranch: "feature",
            resumeReason: "missing-environment"
          },
          test.dependencies
        )
      ).toMatchObject({
        outcome: "completed",
        body: { clientId, tenantId, subscriptionId: request.subscriptionId }
      });
      expect(test.stages).toEqual([warnings ? "warning" : "succeeded"]);
      expect(test.creations[0]).toMatchObject({
        environment: "dev",
        journey: {
          origin: "graph",
          resumeTarget: "deploy",
          resumeBranch: "feature",
          resumeReason: "missing-environment"
        }
      });
      expect(test.contexts).toContainEqual({
        clientId,
        appName: "radius-deploy-octo-app"
      });
    }
  );

  it("creates a fully owned app and reports retention after credentials succeed", async () => {
    const test = provisionHarness();
    const result = await runAzureAutoSetup(
      {
        ...request,
        appName: "custom-app",
        createNew: true,
        serviceManagementReference: ownerId,
        clusterResourceGroup: "aks-group"
      },
      test.dependencies
    );
    expect(result).toMatchObject({
      outcome: "completed",
      body: { appName: "custom-app", clientId }
    });
    expect(test.artifacts).toContainEqual(
      expect.objectContaining({ state: "created", origin: "this_operation" })
    );
    expect(String(result.body.steps)).toContain(
      "Created Entra app registration"
    );
  });

  it("propagates credential-stage failure and hands the Azure cleanup capability to the finalizer", async () => {
    const test = provisionHarness();
    test.dependencies.ensureServicePrincipal = async () => ({
      ok: false,
      stderr: "Denied principal creation"
    });
    const original = test.dependencies.finalizeSetupFailure;
    test.dependencies.finalizeSetupFailure = async (operation, failure) => {
      expect(failure.evidence).toBe("Denied principal creation");
      await failure.runAz?.([
        "account",
        "set",
        "--subscription",
        request.subscriptionId
      ]);
      return original(operation, failure);
    };
    expect(
      await runAzureAutoSetup(
        { ...request, appId: clientId },
        test.dependencies
      )
    ).toMatchObject({ body: { code: "sp-failed" } });
    expect(test.stages).toEqual([]);
  });

  it("passes checkpoint persistence, diagnostics, and failure callbacks to the durability port", async () => {
    const test = provisionHarness();
    test.dependencies.persistMutationCheckpoint = async ({
      persist,
      report,
      fail
    }) => {
      await persist();
      report({ code: "checkpoint-refused", message: "Disk unavailable" });
      await fail(500, "Could not save mutation", "checkpoint-refused");
      return false;
    };
    expect(
      await runAzureAutoSetup(
        { ...request, appId: clientId },
        test.dependencies
      )
    ).toMatchObject({ status: 500, body: { code: "checkpoint-refused" } });
    expect(test.events).toContain("diagnostic");
    expect(test.stages).toEqual([]);
  });

  it.each(["app-selection", "service-management"])(
    "persists and returns a retryable %s prompt",
    async (prompt) => {
      const test = provisionHarness();
      test.dependencies.external.runAz = async (args) => {
        const line = args.join(" ");
        if (prompt === "app-selection" && line.startsWith("ad app list ")) {
          return command(
            JSON.stringify([{ appId: clientId }, { appId: ownerId }])
          );
        }
        if (
          prompt === "service-management" &&
          line.startsWith("ad app create ")
        ) {
          return command("", 1, "ServiceManagementReference is required");
        }
        return test.runAz(args);
      };
      const result = await runAzureAutoSetup(request, test.dependencies);
      expect(result.body).toMatchObject({
        inputRequired: true,
        operationId: test.operation.operationId
      });
      expect(result.body).not.toHaveProperty("azError");
      expect(test.inputs).toHaveLength(1);
      expect(test.inputs[0]?.checkpoint).toBe(
        prompt === "app-selection" ?
          "azure-app-selection"
        : "azure-service-management-reference"
      );
      expect(test.failures).toEqual([]);
    }
  );

  it("honors cancellation after persisting an input prompt", async () => {
    const test = provisionHarness();
    test.dependencies.external.runAz = async (args) =>
      args.slice(0, 3).join(" ") === "ad app create" ?
        command("", 1, "ServiceManagementReference is required")
      : test.runAz(args);
    test.dependencies.honorStopBoundary = async ({ boundary }) =>
      boundary !== "input_prompt";
    expect(await runAzureAutoSetup(request, test.dependencies)).toMatchObject({
      outcome: "cancelled"
    });
    expect(test.inputs).toHaveLength(1);
  });

  it.each([false, true])(
    "handles unanticipated external failure with cancellation=%s",
    async (cancel) => {
      const test = provisionHarness();
      test.dependencies.external.runAz = async () => {
        throw new Error("CLI disappeared");
      };
      test.dependencies.honorStopBoundary = async ({ boundary }) =>
        !(cancel && boundary === "before-azure-failure-cleanup");
      const original = test.dependencies.finalizeSetupFailure;
      test.dependencies.finalizeSetupFailure = async (operation, failure) => {
        test.dependencies.external.runAz = test.runAz;
        await failure.runAz?.([
          "account",
          "set",
          "--subscription",
          request.subscriptionId
        ]);
        return original(operation, failure);
      };
      const result = await runAzureAutoSetup(request, test.dependencies);
      expect(result.outcome).toBe(cancel ? "cancelled" : "failed");
      if (!cancel)
        expect(test.failures[0]).toMatchObject({
          classification: "unknown",
          code: "setup-unhandled"
        });
    }
  );

  it.each([
    "identity unavailable",
    Object.assign(new Error("no stack"), { stack: "" })
  ])(
    "does not offer Azure cleanup before verified identity: %s",
    async (error) => {
      const test = provisionHarness();
      test.dependencies.external.getSelectedGitHubExecutor = () => {
        throw error;
      };
      expect(await runAzureAutoSetup(request, test.dependencies)).toMatchObject(
        { body: { code: "setup-unhandled" } }
      );
      expect(test.failures[0]).toMatchObject({ runAz: null, evidence: null });
    }
  );

  it("returns reconciliation without cleanup after a provider request loses its response", async () => {
    const test = provisionHarness();
    test.dependencies.external.runAz = async (args) => {
      if (args.slice(0, 3).join(" ") === "ad app create")
        return command("", 1, "connection lost");
      return test.runAz(args);
    };
    expect(await runAzureAutoSetup(request, test.dependencies)).toMatchObject({
      status: 202,
      body: { reconciling: true, code: "provider-mutation-outcome-unknown" }
    });
    expect(test.failures).toEqual([]);
    expect(
      operationDomain.unresolvedProviderMutations(test.operation)
    ).toHaveLength(1);
  });

  it("reconciles a pending write without repeating permission preflights", async () => {
    const test = provisionHarness();
    operationDomain.prepareProviderMutation(test.operation, {
      kind: "azure_application.create",
      target: "octo/app:dev:radius-deploy-octo-app"
    });
    test.dependencies.external.preflightRepoAdmin = unexpected;
    test.dependencies.external.preflightGhcrPackageWriteAccess = unexpected;
    expect(
      await runAzureAutoSetup(
        { ...request, operationId: test.operation.operationId },
        test.dependencies
      )
    ).toMatchObject({ status: 202, body: { reconciling: true } });
    expect(test.failures).toEqual([]);
  });

  it("treats unrelated recovery errors as explicit setup failure", async () => {
    const test = provisionHarness();
    test.dependencies.external.getSelectedGitHubExecutor = () => {
      throw new ProviderMutationRecoveryError(
        "Recovery failed",
        "different-code"
      );
    };
    expect(await runAzureAutoSetup(request, test.dependencies)).toMatchObject({
      body: { code: "setup-unhandled", error: "Recovery failed" }
    });
  });

  it("validates empty authorize-stage configuration", () => {
    const test = harness();
    test.dependencies.stageAuthorizeIdentity = "";
    expect(() => validateAzureAutoSetupDependencies(test.dependencies)).toThrow(
      "stageAuthorizeIdentity"
    );
  });

  it.each([
    ["root", "sleep"],
    ["operations", "persist"],
    ["external", "runAz"],
    ["tempFile", "write"]
  ])("rejects missing %s.%s capability at construction", (group, name) => {
    const test = harness();
    const target =
      group === "root" ?
        test.dependencies
      : Reflect.get(test.dependencies, group);
    Reflect.deleteProperty(target, name);
    expect(() => validateAzureAutoSetupDependencies(test.dependencies)).toThrow(
      `Missing Azure auto-setup dependency: ${group === "root" ? "" : `${group}.`}${name}`
    );
  });

  it("honors cancellation before failure cleanup without calling the finalizer", async () => {
    const test = provisionHarness();
    test.dependencies.honorStopBoundary = async () => false;
    expect(await runAzureAutoSetup({}, test.dependencies)).toMatchObject({
      outcome: "cancelled",
      body: { boundary: "before-azure-failure-cleanup" }
    });
    expect(test.failures).toEqual([]);
  });

  it("returns a helper's persistence refusal without a second failure response", async () => {
    const test = provisionHarness();
    let saves = 0;
    test.dependencies.operations.persist = async () => {
      if (++saves === 2) throw new Error("storage unavailable");
    };
    expect(
      await runAzureAutoSetup({ ...request, clientId }, test.dependencies)
    ).toMatchObject({
      status: 500,
      body: { code: "operation-persistence-failed" }
    });
    expect(test.failures).toEqual([]);
    expect(test.stages).toEqual([]);
  });
});

describe("independent Azure provisioning coordinator", () => {
  it("validates required inputs before any identity lookup or mutation", async () => {
    const test = harness();
    const result = await runAzureAutoSetup({}, test.dependencies);
    expect(result).toMatchObject({
      outcome: "failed",
      status: 400,
      body: { code: "missing-params" }
    });
    expect(test.events).toEqual([]);
  });

  it("requires the selected subscription instead of using ambient Azure state", async () => {
    const test = harness();
    const result = await runAzureAutoSetup(
      { ...request, subscriptionId: "" },
      test.dependencies
    );
    expect(result.body.code).toBe("subscription-required");
    expect(test.events).toEqual([]);
  });

  it("does not mutate Azure after a stop following identity verification", async () => {
    const test = harness();
    test.dependencies.honorStopBoundary = async ({ boundary }) =>
      boundary !== "before-azure-subscription-selection";
    const result = await runAzureAutoSetup(request, test.dependencies);
    expect(result).toMatchObject({
      outcome: "cancelled",
      body: { code: "operation-stopped" }
    });
    expect(test.events).toContain("identity");
    expect(test.events).toContain("admin");
  });

  it("fails closed on an unavailable selected GitHub identity", async () => {
    const test = harness();
    test.dependencies.external.getSelectedGitHubExecutor = () => null;
    const result = await runAzureAutoSetup(request, test.dependencies);
    expect(result.body.code).toBe("github-selection-unavailable");
    expect(test.events).not.toContain("admin");
  });

  it("preserves provider errors rather than returning successful credentials", async () => {
    const test = harness();
    test.dependencies.external.runAz = async (args) => {
      expect(args).toEqual([
        "account",
        "set",
        "--subscription",
        request.subscriptionId
      ]);
      return { code: 1, stdout: "", stderr: "Access refused" };
    };
    const result = await runAzureAutoSetup(request, test.dependencies);
    expect(result.outcome).toBe("failed");
    expect(result.body.code).toBe("az-subscription-set-failed");
    expect(result.body.error).toContain("Access refused");
  });

  it("requires all execution capabilities at construction", () => {
    const test = harness();
    expect(() =>
      validateAzureAutoSetupDependencies(test.dependencies)
    ).not.toThrow();
  });

  it("hands persistence and diagnostics to the stop boundary before starting Azure work", async () => {
    const test = harness();
    const diagnostics: object[] = [];
    test.dependencies.operations.report = (diagnostic) => {
      diagnostics.push(diagnostic);
    };
    test.dependencies.honorStopBoundary = async ({ persist, report }) => {
      await persist();
      report({ code: "stop-persisted", message: "Recorded stop safely." });
      return false;
    };
    const result = await runAzureAutoSetup(request, test.dependencies);
    expect(result.outcome).toBe("cancelled");
    expect(test.events).toContain("persist");
    expect(diagnostics).toEqual([
      { code: "stop-persisted", message: "Recorded stop safely." }
    ]);
  });
});
