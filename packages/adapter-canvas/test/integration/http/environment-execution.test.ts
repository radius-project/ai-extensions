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
  requireInput,
  finish,
  operations,
  OPERATION_SCHEMA_VERSION,
  setVerificationWorkflowState,
  STAGE_DELETE_RADIUS_ENV,
  STAGE_AUTHORIZE_IDENTITY,
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

  it("keeps recovery's server-owned transport out of webview activity and surfaces refusal", async () => {
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
      const entry = await runtime.getOrCreateServer("rollback", "environment");
      await vi.waitFor(() =>
        expect(report).toHaveBeenCalledWith(
          expect.objectContaining({
            scope: "provider-recovery-auto-rollback",
            operationId: op.operationId,
            message: expect.any(String)
          })
        )
      );
      expect(fetcher).toHaveBeenCalledWith(
        `${entry.baseUrl}/api/operations/${op.operationId}/rollback`,
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-Radius-Server-Owned": expect.any(String)
          })
        })
      );
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
