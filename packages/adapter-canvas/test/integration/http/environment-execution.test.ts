import { afterEach, describe, expect, it, vi } from "vitest";
import { createEnvironmentExecutionOwner } from "../../../src/runtime/environment-execution-owner.js";
import { createProductionCanvasServerRuntime } from "../../../src/server.js";
import { createTestCanvasServerRuntime } from "../../support/server/production-runtime.js";
import {
  configureOperationStore,
  createOperation,
  finish,
  operations,
  OPERATION_SCHEMA_VERSION,
  STAGE_DELETE_RADIUS_ENV,
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
    const options = { executionOwner: createEnvironmentExecutionOwner() };
    Reflect.deleteProperty(options, "executionOwner");
    expect(() => createProductionCanvasServerRuntime(options)).toThrow(
      "Missing canvas server dependency: executionOwner"
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

  it("preserves transport authorization before malformed setup bodies and browser mutation gates", async () => {
    const owner = createEnvironmentExecutionOwner();
    const runtime = createTestCanvasServerRuntime({ executionOwner: owner });
    const entry = await runtime.getOrCreateServer("auth", "environment");
    try {
      for (const path of ["/api/azure-auto-setup", "/api/create-environment"]) {
        const response = await fetch(entry.baseUrl + path, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: entry.baseUrl,
            "Sec-Fetch-Site": "same-origin",
            "X-Radius-Mutation-Nonce": String(entry.state.browserMutationNonce)
          },
          body: "{"
        });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
          code: "server-owned-operation-required"
        });
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
