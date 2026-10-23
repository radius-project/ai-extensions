import { afterEach, describe, expect, it, vi } from "vitest";
import { createEnvironmentExecutionOwner } from "../../../src/runtime/environment-execution-owner.js";
import { createProductionGitHubAccountContext } from "../../../src/runtime/production-github-account-context.js";
import { createEnvironmentAccountContext } from "../../../src/runtime/environment-account-context.js";
import { createGitHubAccountCoordinator } from "../../../src/server/services/github-account-coordinator.js";
import { successfulSelectedGhExecutor } from "../../support/server/selected-gh.js";
import { createProductionCanvasServerRuntime } from "../../../src/server.js";
import { createTestCanvasServerRuntime } from "../../support/server/production-runtime.js";
import {
  configureOperationStore,
  createOperation,
  recordGitHubEnvironment,
  requireInput,
  finish,
  operations,
  OPERATION_SCHEMA_VERSION,
  setVerificationWorkflowState,
  STAGE_DELETE_RADIUS_ENV,
  STAGE_AUTHORIZE_IDENTITY,
  STAGE_VERIFY,
  STAGE_DELETE_STATE_PACKAGE
} from "../../../src/operations.js";
import {
  disabledOperationStore,
  parseOperationsEnvelope,
  type PersistedOperationsEnvelope
} from "../../../src/operation-store.js";

afterEach(async () => {
  vi.restoreAllMocks();
  operations.clear();
  await configureOperationStore(disabledOperationStore());
});

describe("production environment owner HTTP binding", () => {
  it("projects the latest saved operation without repository context through the production status route", async () => {
    const owner = createEnvironmentExecutionOwner();
    const unavailable = async (): Promise<never> => {
      throw new Error("Unexpected account lookup");
    };
    const runtime = createTestCanvasServerRuntime({
      executionOwner: owner,
      accountContext: createEnvironmentAccountContext("latest-status", {
        createReadOnlyExecutor: unavailable,
        withSelectedAccount: unavailable
      })
    });
    const entry = await runtime.getOrCreateServer(
      "latest-status",
      "environment"
    );
    try {
      const empty = await fetch(`${entry.baseUrl}/api/operations`);
      expect(empty.status).toBe(200);
      expect(await empty.json()).toEqual({ operation: null });
      const op = createOperation({
        repo: "fixture/app",
        environment: "dev",
        provider: "azure"
      });
      finish(op, "failed");
      op.request = { private: "never-return-this" };
      operations.put(op);
      const response = await fetch(`${entry.baseUrl}/api/operations`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const result = await response.json();
      expect(result).toMatchObject({
        operation: {
          operationId: op.operationId,
          repo: op.repo,
          environment: op.environment,
          state: "failed"
        }
      });
      expect(JSON.stringify(result)).not.toContain("never-return-this");
      const beforeExport = Date.now();
      const diagnostic = await fetch(
        `${entry.baseUrl}/api/operations/${op.operationId}/diagnostics`
      );
      expect(diagnostic.status).toBe(200);
      expect(diagnostic.headers.get("content-disposition")).toContain(
        "attachment;"
      );
      expect(diagnostic.headers.get("cache-control")).toBe("no-store");
      const exported = await diagnostic.json();
      expect(Date.parse(exported.generatedAt)).toBeGreaterThanOrEqual(
        beforeExport
      );
      expect(Date.parse(exported.generatedAt)).toBeLessThanOrEqual(Date.now());
      expect(JSON.stringify(exported)).not.toContain("never-return-this");
      expect(owner.hasActiveEnvironmentTasks(undefined)).toBe(false);
    } finally {
      owner.shutdown();
      await runtime.stopServer("latest-status", true);
    }
  });

  it("keeps an HTTP-admitted rollback recoverable when shutdown wins account acquisition", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = () => {};
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const owner = createEnvironmentExecutionOwner();
    const run = vi.fn(async (): Promise<never> => {
      throw new Error("Unexpected cleanup command after shutdown");
    });
    const executor = successfulSelectedGhExecutor({
      login: "saved-account",
      run
    });
    const account = createEnvironmentAccountContext(
      "http-cleanup",
      createGitHubAccountCoordinator({
        createExecutor: async () => {
          entered();
          await gate;
          return executor;
        },
        getActiveKeyringLogin: async () => executor.login,
        switchKeyringAccount: async () => {
          throw new Error("Unexpected keyring switch");
        },
        resetIdentityCache: () => {}
      })
    );
    const runtime = createTestCanvasServerRuntime({
      executionOwner: owner,
      accountContext: account
    });
    const entry = await runtime.getOrCreateServer("cleanup", "environment");
    const op = createOperation({
      operationId: "http-cleanup",
      repo: "fixture/app",
      environment: "dev",
      provider: "azure"
    });
    op.context.githubLogin = executor.login;
    recordGitHubEnvironment(op, {
      state: "created",
      origin: "this_operation",
      repo: op.repo,
      name: op.environment,
      providerId: "17"
    });
    finish(op, "failed");
    operations.put(op);
    vi.spyOn(operations, "persist").mockResolvedValue(undefined);
    let done = Promise.resolve();
    try {
      const response = await fetch(
        `${entry.baseUrl}/api/operations/${op.operationId}/rollback`,
        {
          method: "POST",
          headers: {
            origin: entry.baseUrl,
            "sec-fetch-site": "same-origin",
            "x-radius-mutation-nonce": String(entry.state.browserMutationNonce)
          }
        }
      );
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({
        operationId: op.operationId
      });
      done = new Promise<void>((resolve) => {
        const stop = owner.onEnvironmentTasksSettled("cleanup", () => {
          stop();
          resolve();
        });
      });
      await waiting;
      owner.shutdown();
      release();
      await done;
      expect(run).not.toHaveBeenCalled();
      expect(op.endedAt).toBeNull();
      expect(op.control.commands.at(-1)?.state).toBe("running");
      expect(op.setupArtifacts.githubEnvironment.state).toBe("created");
      expect(account.getExecutor(op.operationId)).toBeUndefined();
    } finally {
      release();
      await done;
      owner.shutdown();
      await runtime.stopServer("cleanup", true);
    }
  });

  it.each(["open", "closed-before-account", "closed-during-read"] as const)(
    "keeps shared verification observation alive across panel closure (%s)",
    async (lifetime) => {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered = () => {};
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const run = vi.fn(async (args: string[]) => {
        const endpoint = args[1];
        if (endpoint === "repos/fixture/app/actions/runs/17") {
          entered();
          await gate;
        } else if (
          endpoint !==
          "repos/fixture/app/actions/runs/17/jobs?per_page=100&page=1"
        ) {
          throw new Error(`Unexpected selected command: ${args.join(" ")}`);
        }
        expect(args).toEqual(["api", endpoint, "--include", "--method", "GET"]);
        return {
          code: 0,
          stdout:
            "HTTP/2 200\n\n" +
            JSON.stringify(
              endpoint.endsWith("/17") ?
                { status: "completed", conclusion: "success" }
              : { jobs: [] }
            ),
          stderr: ""
        };
      });
      const executor = successfulSelectedGhExecutor({
        login: "saved-account",
        run
      });
      const account = createEnvironmentAccountContext("panel-observation", {
        createReadOnlyExecutor: async () => {
          if (lifetime === "closed-before-account") {
            entered();
            await gate;
          }
          return executor;
        },
        withSelectedAccount: async () => {
          throw new Error("Unexpected write lease");
        }
      });
      const owner = createEnvironmentExecutionOwner();
      const runtime = createTestCanvasServerRuntime({
        executionOwner: owner,
        accountContext: account
      });
      const op = createOperation({
        operationId: "op_direct_monitor",
        repo: "fixture/app",
        environment: "dev",
        provider: "azure"
      });
      op.currentStage = STAGE_VERIFY;
      op.recoveryState = "verification_pending";
      op.context.githubLogin = "saved-account";
      op.verification = {
        runId: "17",
        workflow: "verify.yml",
        ref: "topic",
        environment: "dev",
        dispatchedAt: Date.now()
      };
      operations.put(op);
      const persist = vi
        .spyOn(operations, "persist")
        .mockResolvedValue(undefined);
      const fetcher = vi.spyOn(globalThis, "fetch");
      const entry = await runtime.getOrCreateServer("monitor", "environment");
      const done = new Promise<void>((resolve) => {
        const unsubscribe = owner.onEnvironmentTasksSettled("monitor", () => {
          unsubscribe();
          resolve();
        });
      });
      try {
        await Promise.race([waiting, done]);
        expect(op.failure).toBeNull();
        if (lifetime !== "open") await runtime.stopServer("monitor", true);
        release();
        await done;
        expect(fetcher).not.toHaveBeenCalled();
        expect(persist).toHaveBeenCalledOnce();
        expect(account.getExecutor(op.operationId)).toBeUndefined();
        expect(entry.observation?.stopped).toBe(lifetime !== "open");
        expect(op.state).toBe("succeeded");
        expect(op.failure).toBeNull();
        expect(run).toHaveBeenCalledTimes(2);
        expect(runtime.getLastWebviewActivityAt()).toBe(0);
      } finally {
        release();
        await done;
        await runtime.stopServer("monitor", true);
      }
    }
  );

  it.each(["azure", "environment", "repository-refusal"] as const)(
    "enforces the real %s admission or setup outcome without the former setup POST",
    async (stage) => {
      const run = vi.fn(async (args: string[]) => {
        const command = args.join(" ");
        if (command === "api user") {
          return { code: 0, stdout: '{"login":"saved-account"}', stderr: "" };
        }
        if (
          command === "api /repos/fixture/app" ||
          command === "api repos/fixture/app"
        ) {
          return {
            code: 0,
            stdout: JSON.stringify({
              full_name: "fixture/app",
              permissions: { admin: stage !== "repository-refusal" }
            }),
            stderr: ""
          };
        }
        if (command === "api /repos/fixture/app/environments/dev") {
          return { code: 0, stdout: '{"name":"dev","id":17}', stderr: "" };
        }
        if (
          command.startsWith("api --paginate /repos/fixture/app/environments")
        ) {
          return { code: 1, stdout: "", stderr: "namespace fixture refusal" };
        }
        throw new Error(`Unexpected selected command: ${command}`);
      });
      const executor = successfulSelectedGhExecutor({
        login: "saved-account",
        requiresKeyringSwitch: false,
        run
      });
      const accountContext = createEnvironmentAccountContext(
        "runtime-service-wiring",
        createGitHubAccountCoordinator({
          createExecutor: async () => executor,
          getActiveKeyringLogin: async () => "original",
          switchKeyringAccount: async () => {
            throw new Error("Unexpected switch");
          },
          resetIdentityCache: () => {}
        })
      );
      const owner = createEnvironmentExecutionOwner();
      const runtime = createTestCanvasServerRuntime({
        executionOwner: owner,
        accountContext
      });
      const originalFetch = globalThis.fetch;
      const forbidden: string[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (
          url.endsWith("/api/azure-auto-setup") ||
          url.endsWith("/api/create-environment")
        ) {
          forbidden.push(url);
          throw new Error("Setup HTTP transport must not be used");
        }
        return originalFetch(input, init);
      });
      try {
        const entry = await runtime.getOrCreateServer(
          "setup-panel",
          "environment"
        );
        const op = createOperation({
          operationId: `op_direct_${stage}`,
          repo: "fixture/app",
          environment: "dev",
          provider: "azure"
        });
        op.context.githubLogin = "saved-account";
        op.currentStage = STAGE_AUTHORIZE_IDENTITY;
        op.request = {
          needsAzureCredentials: stage === "azure",
          azure: {},
          environment: {}
        };
        requireInput(op, {
          code: "app-selection-required",
          message: "Choose an app.",
          checkpoint: "azure-app-selection"
        });
        operations.put(op);
        const settled = new Promise<void>((resolve) => {
          const stop = owner.onEnvironmentTasksSettled("setup-panel", () => {
            stop();
            resolve();
          });
        });
        const response = await fetch(
          `${entry.baseUrl}/api/operations/${op.operationId}/resume/app-selection-required`,
          {
            method: "POST",
            headers: {
              origin: entry.baseUrl,
              "sec-fetch-site": "same-origin",
              "x-radius-mutation-nonce": String(
                entry.state.browserMutationNonce
              ),
              "content-type": "application/json"
            },
            body: JSON.stringify({
              repo: op.repo,
              environment: op.environment,
              provider: op.provider,
              checkpoint: "azure-app-selection",
              createNew: true
            })
          }
        );
        expect(response.status).toBe(202);
        await settled;
        expect(forbidden).toEqual([]);
        if (stage === "repository-refusal") {
          expect(op.failure.code).toBe("repo-admin-required");
          expect(op.failure.message).toContain("saved-account");
          expect(
            run.mock.calls.some(([args]) =>
              args.some((arg) => arg.includes("/environments"))
            )
          ).toBe(false);
        } else {
          expect(op.failure.message).toContain(
            stage === "azure" ?
              "repo, resourceGroup, and cluster are required."
            : "namespace fixture refusal"
          );
        }
        expect(op.state).toBe("failed");
        expect(accountContext.getExecutor(op.operationId)).toBeUndefined();
        expect(
          run.mock.calls.every(
            ([args]) => args[0] === "api" && !args.includes("--method")
          )
        ).toBe(true);
      } finally {
        await runtime.stopServer("setup-panel", true);
      }
    }
  );

  it.each([false, true])(
    "uses saved operation ownership for workflow controls (account unavailable=%s)",
    async (unavailable) => {
      const run = vi.fn(async (args: string[]) => {
        if (args[0] === "run" && args[1] === "view")
          return { code: 0, stdout: '{"status":"in_progress"}', stderr: "" };
        if (args[0] === "api" && args[1] === "--method")
          return { code: 0, stdout: "", stderr: "" };
        throw new Error(`Unexpected command: ${JSON.stringify(args)}`);
      });
      const executor = successfulSelectedGhExecutor({
        login: "saved-account",
        requiresKeyringSwitch: false,
        run
      });
      const accountCoordinator = createGitHubAccountCoordinator({
        createExecutor: async (login) => {
          expect(login).toBe("saved-account");
          if (unavailable) throw new Error("Saved account unavailable");
          return executor;
        },
        getActiveKeyringLogin: async () => "original",
        switchKeyringAccount: async () => {
          throw new Error("Unexpected account switch");
        },
        resetIdentityCache: () => {}
      });
      const lease = vi.spyOn(accountCoordinator, "withSelectedAccount");
      const accountContext = createEnvironmentAccountContext(
        "runtime-account-owner",
        accountCoordinator
      );
      const runtime = createTestCanvasServerRuntime({
        executionOwner: createEnvironmentExecutionOwner(),
        accountContext
      });
      try {
        const entry = await runtime.getOrCreateServer(
          "control-panel",
          "environment"
        );
        const op = createOperation({
          operationId: "op_control_account",
          repo: "fixture/app",
          environment: "dev",
          provider: "azure"
        });
        op.context.githubLogin = "saved-account";
        op.verification = { runId: "42" };
        finish(op, "cancelled");
        setVerificationWorkflowState(op, "unknown");
        operations.put(op);
        const post = () =>
          fetch(
            `${entry.baseUrl}/api/operations/${op.operationId}/cancel-workflow`,
            {
              method: "POST",
              headers: {
                origin: entry.baseUrl,
                "sec-fetch-site": "same-origin",
                "x-radius-mutation-nonce": String(
                  entry.state.browserMutationNonce
                )
              }
            }
          );
        const inspected = await post();
        expect(inspected.status).toBe(unavailable ? 502 : 200);
        if (unavailable) {
          expect(await inspected.json()).toMatchObject({
            code: "workflow-status-read-failed",
            detail: "Saved account unavailable"
          });
          expect(run).not.toHaveBeenCalled();
        } else {
          expect(await inspected.json()).toMatchObject({
            code: "workflow-status-checked"
          });
          const cancelled = await post();
          expect(cancelled.status).toBe(202);
          expect(await cancelled.json()).toMatchObject({
            code: "workflow-cancellation-pending"
          });
          expect(run.mock.calls.map(([args]) => args)).toEqual([
            ["run", "view", "42", "--json", "status", "--repo", "fixture/app"],
            ["run", "view", "42", "--json", "status", "--repo", "fixture/app"],
            [
              "api",
              "--method",
              "POST",
              "repos/fixture/app/actions/runs/42/cancel"
            ]
          ]);
        }
        expect(lease).toHaveBeenCalledTimes(unavailable ? 1 : 2);
        for (const call of lease.mock.calls) {
          expect(call).toEqual([
            "saved-account",
            { ownerKey: "runtime-account-owner", operationId: op.operationId },
            expect.any(Function),
            30000
          ]);
        }
      } finally {
        await runtime.stopServer("control-panel", true);
      }
    }
  );

  it("keeps direct recovery out of webview activity and surfaces admission refusal", async () => {
    const op = createOperation({
      operationId: "op_rollback_transport",
      repo: "fixture/rollback",
      environment: "dev",
      provider: "azure"
    });
    finish(op, "failed");
    op.providerRecovery = { state: "rollback_pending", mutations: [] };
    operations.put(op);
    const report = vi.spyOn(operations, "report");
    const fetcher = vi.spyOn(globalThis, "fetch");
    const runtime = createTestCanvasServerRuntime({
      executionOwner: createEnvironmentExecutionOwner()
    });
    try {
      await runtime.getOrCreateServer("rollback", "environment");
      await vi.waitFor(() =>
        expect(report).toHaveBeenCalledWith(
          expect.objectContaining({
            scope: "provider-recovery-auto-rollback",
            operationId: op.operationId,
            message: expect.any(String)
          })
        )
      );
      expect(fetcher).not.toHaveBeenCalled();
      expect(op.control.commands).toEqual([]);
      expect(runtime.getLastWebviewActivityAt()).toBe(0);
      expect(op.state).toBe("failed");
    } finally {
      await runtime.stopServer("rollback", true);
    }
  });

  it("refuses construction without the shared owner", () => {
    const options = {
      executionOwner: createEnvironmentExecutionOwner(),
      accountContext: createProductionGitHubAccountContext()
    };
    Reflect.deleteProperty(options, "executionOwner");
    expect(() => createProductionCanvasServerRuntime(options)).toThrow(
      "Missing canvas server dependency: executionOwner"
    );
  });

  it("refuses construction without the shared account context", () => {
    const options = {
      executionOwner: createEnvironmentExecutionOwner(),
      accountContext: createProductionGitHubAccountContext()
    };
    Reflect.deleteProperty(options, "accountContext");
    expect(() => createProductionCanvasServerRuntime(options)).toThrow(
      "Missing canvas server dependency: accountContext"
    );
  });

  it("decodes and reconciles legacy records before server-ready recovery without changing identity", async () => {
    const legacyEnvelope = {
      schemaVersion: 1,
      operations: [
        {
          schemaVersion: 1,
          operationId: "op_legacy_setup",
          kind: "create",
          provider: "azure",
          repo: "fixture/legacy",
          environment: "dev",
          state: "running",
          startedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          endedAt: null,
          stages: [],
          steps: []
        },
        {
          schemaVersion: 6,
          operationId: "op_legacy_delete",
          kind: "delete",
          provider: "azure",
          repo: "fixture/delete",
          environment: "dev",
          state: "running",
          startedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          endedAt: null,
          currentStage: STAGE_DELETE_RADIUS_ENV,
          stages: [
            {
              id: STAGE_DELETE_RADIUS_ENV,
              state: "running",
              label: "Delete Radius environment"
            }
          ],
          steps: [],
          deleteRecovery: {
            repo: "fixture/delete",
            environment: "dev",
            provider: "azure",
            clientId: "fixture-app",
            tenantId: "fixture-tenant",
            repoId: 42
          }
        },
        {
          schemaVersion: 5,
          operationId: "op_restart_decision",
          kind: "create",
          provider: "azure",
          repo: "fixture/restart",
          environment: "dev",
          state: "running",
          startedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          endedAt: null,
          stages: [],
          steps: []
        }
      ]
    };
    const saved: PersistedOperationsEnvelope[] = [];
    await configureOperationStore({
      load: async () =>
        parseOperationsEnvelope(JSON.parse(JSON.stringify(legacyEnvelope))),
      save: async (envelope) => {
        saved.push(structuredClone(envelope));
      }
    });
    const quarantined = operations.get("op_legacy_setup");
    const deletion = operations.get("op_legacy_delete");
    expect(operations.get("op_restart_decision")).toMatchObject({
      operationId: "op_restart_decision",
      state: "action_required",
      terminal: { reason: "provider-restart-decision" },
      recoveryState: "interrupted"
    });
    expect(quarantined).toMatchObject({
      operationId: "op_legacy_setup",
      state: "failed_partial",
      providerRecovery: { state: "unrecoverable_legacy" },
      failure: { code: "operation-legacy-unrecoverable" }
    });
    expect(deletion).toMatchObject({
      operationId: "op_legacy_delete",
      schemaVersion: OPERATION_SCHEMA_VERSION,
      request: legacyEnvelope.operations[1].deleteRecovery,
      stages: expect.arrayContaining([
        expect.objectContaining({
          id: STAGE_DELETE_STATE_PACKAGE,
          state: "pending"
        })
      ])
    });
    const owner = createEnvironmentExecutionOwner();
    const runner = vi.fn(async () => {});
    const runtime = createTestCanvasServerRuntime({
      executionOwner: owner,
      environmentOperationRunner: runner
    });
    expect(runner).not.toHaveBeenCalled();
    try {
      const entry = await runtime.getOrCreateServer("legacy", "environment");
      await new Promise<void>((resolve) => {
        const stop = owner.onEnvironmentTasksSettled("legacy", () => {
          stop();
          resolve();
        });
      });
      expect(runner).toHaveBeenCalledExactlyOnceWith("op_legacy_delete");
      const response = await fetch(
        `${entry.baseUrl}/api/operations/op_legacy_setup`
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        operation: { operationId: "op_legacy_setup", state: "failed_partial" }
      });
      expect(saved.length).toBeGreaterThan(0);
      expect(JSON.stringify(saved)).not.toMatch(
        /attachmentGeneration|executionOwner|runtimeKey/
      );
    } finally {
      await runtime.stopServer("legacy", true);
    }
  });

  it("treats removed setup endpoints as unmatched without setup side effects or forged-header authority", async () => {
    const owner = createEnvironmentExecutionOwner();
    const runtime = createTestCanvasServerRuntime({ executionOwner: owner });
    const entry = await runtime.getOrCreateServer("auth", "environment");
    try {
      const unknown = await fetch(entry.baseUrl + "/api/unknown-setup-route");
      const unknownBody = await unknown.text();
      for (const path of ["/api/azure-auto-setup", "/api/create-environment"]) {
        for (const forgedHeader of [false, true]) {
          const response = await fetch(entry.baseUrl + path, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: entry.baseUrl,
              "Sec-Fetch-Site": "same-origin",
              "X-Radius-Mutation-Nonce": String(
                entry.state.browserMutationNonce
              ),
              ...(forgedHeader ?
                { "X-Radius-Server-Owned": "forged-token" }
              : {})
            },
            body: "{"
          });
          expect(response.status).toBe(unknown.status);
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toBe(
            "text/html; charset=utf-8"
          );
          expect(await response.text()).toBe(unknownBody);
        }
      }
      const crossSite = await fetch(entry.baseUrl + "/api/operations", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "cross-site" },
        body: "{"
      });
      expect(crossSite.status).toBe(403);
      expect(await crossSite.json()).toMatchObject({
        code: "cross-site-forbidden"
      });
      expect(owner.hasActiveEnvironmentTasks("auth")).toBe(false);
      expect(operations.all()).toEqual([]);
    } finally {
      await runtime.stopServer("auth", true);
    }
  });
});
