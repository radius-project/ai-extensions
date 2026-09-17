import { describe, expect, it } from "vitest";
import {
  createOperation,
  createRegistry,
  applyStopRequest,
  finish,
  toPersistedOperation
} from "../operations.js";
import type {
  OperationStore,
  PersistedOperationsEnvelope
} from "../operation-store.js";
import { createLifecycleSetupStore } from "./lifecycle-setup-store.js";

describe("legacy setup persistence bridge", () => {
  it("preserves persisted identities and existing pause controls without starting another operation", async () => {
    let persisted: PersistedOperationsEnvelope | null = null;
    const store: OperationStore = {
      load: async () => persisted,
      save: async (envelope) => {
        persisted = structuredClone(envelope);
      }
    };
    const operation = createOperation({
      operationId: "op_legacy",
      repo: "owner/repo",
      environment: "dev",
      provider: "azure",
      startedAt: "2026-09-15T00:00:00Z",
      journey: {
        resumeTarget: { page: "graph", repo: "owner/repo", branch: "feature" }
      }
    });
    const registry = createRegistry({
      store,
      clock: () => Date.parse("2026-09-15T00:00:00Z")
    });
    registry.put(operation);
    const bridge = createLifecycleSetupStore({ registry: () => registry });
    expect(bridge.read("op_legacy", "OWNER/REPO")).toMatchObject({
      operationId: "op_legacy",
      kind: "create",
      controls: [
        expect.objectContaining({
          kind: "stop",
          path: "/api/operations/op_legacy/stop"
        })
      ]
    });
    expect(bridge.control("op_legacy", "owner/repo", "stop").method).toBe(
      "POST"
    );
    expect(() =>
      bridge.control("op_legacy", "owner/repo", "cancel_workflow")
    ).toThrow("not currently");
    await bridge.persist();
    expect(persisted).toMatchObject({
      schemaVersion: 1,
      operations: [{ operationId: "op_legacy" }]
    });
    const restored = createRegistry({
      store,
      clock: () => Date.parse("2026-09-15T00:00:00Z")
    });
    await restored.hydrate();
    const resumed = createLifecycleSetupStore({ registry: () => restored });
    expect(resumed.knownOperations()).toEqual([
      {
        operationId: "op_legacy",
        family: "environment",
        owner: "legacy",
        needsControl: true
      }
    ]);
    expect(restored.size()).toBe(1);
  });
  it("does not offer setup pause or rollback for live deletion", () => {
    const registry = createRegistry();
    registry.put(
      createOperation({
        operationId: "delete",
        kind: "delete",
        repo: "owner/repo",
        provider: "azure"
      })
    );
    const bridge = createLifecycleSetupStore({ registry: () => registry });
    expect(bridge.read("delete", "owner/repo")?.controls).toEqual([]);
    expect(() => bridge.control("delete", "owner/repo", "stop")).toThrow(
      "not currently"
    );
    expect(() => bridge.control("delete", "owner/repo", "rollback")).toThrow(
      "not currently"
    );
  });
  it("retains original stop versus workflow-cancel and rollback semantics", () => {
    const registry = createRegistry();
    const operation = createOperation({
      operationId: "op_setup",
      repo: "owner/repo",
      provider: "azure"
    });
    registry.put(operation);
    const before: unknown = toPersistedOperation(operation);
    const bridge = createLifecycleSetupStore({ registry: () => registry });
    bridge.control("op_setup", "owner/repo", "stop");
    expect(toPersistedOperation(operation)).toEqual(before);
    applyStopRequest(operation);
    expect(operation.state).not.toBe("cancelled");
    finish(operation, "cancelled");
    expect(bridge.read("op_setup", "owner/repo")?.state).toBe("cancelled");
  });
  it("fails closed on invalid records, wrong repositories and persistence errors", async () => {
    expect(() =>
      Reflect.apply(createLifecycleSetupStore, undefined, [{}])
    ).toThrow("existing registry");
    const registry = createRegistry({
      store: {
        load: async () => null,
        save: async () => {
          throw new Error("storage unavailable");
        }
      }
    });
    const bridge = createLifecycleSetupStore({ registry: () => registry });
    expect(bridge.read("missing", "owner/repo")).toBeUndefined();
    registry.put(
      createOperation({
        operationId: "op_setup",
        repo: "owner/repo",
        provider: "azure"
      })
    );
    expect(() => bridge.read("op_setup", "other/repo")).toThrow(
      "authorized selection"
    );
    await expect(bridge.persist()).rejects.toThrow("storage unavailable");
    registry.put({ operationId: "invalid" });
    expect(() => bridge.knownOperations()).toThrow("identity");
  });
});
