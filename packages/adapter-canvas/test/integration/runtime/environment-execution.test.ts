import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapRadiusExtension } from "../../../src/runtime/bootstrap.js";
import { createEnvironmentExecutionOwner } from "../../../src/runtime/environment-execution-owner.js";
import { createRadiusExtension } from "../../../src/runtime/create-radius-extension.js";
import { createTestCanvasServerRuntime } from "../../support/server/production-runtime.js";
import {
  createFakeDependencies,
  createFakeSession
} from "../../support/runtime/fakes.js";
import {
  createOperation,
  finish,
  operations
} from "../../../src/operations.js";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const context = (instanceId = "panel") => ({
  extensionId: "fixture:radius",
  canvasId: "radius",
  instanceId,
  input: { page: "environment" }
});

async function composition() {
  const owner = createEnvironmentExecutionOwner();
  const gate = deferred();
  const entered = deferred();
  const server = createTestCanvasServerRuntime({
    executionOwner: owner,
    environmentOperationRunner: async () => {
      entered.resolve();
      await gate.promise;
    }
  });
  const fake = createFakeDependencies();
  const deps = {
    ...fake.deps,
    ...server,
    executionOwner: owner,
    stopServer: vi.fn(server.stopServer)
  };
  const closeSession = vi.fn(async () => {});
  const session = createFakeSession({ close: closeSession });
  const joinSession = vi.fn(async () => session);
  const extension = await bootstrapRadiusExtension(deps, {
    createCanvas: (declaration) => declaration,
    joinSession
  });
  const canvas = extension.canvases[0];
  function recoverDelete() {
    const op = createOperation({
      operationId: "op_runtime",
      repo: "fixture/app",
      kind: "delete",
      provider: "azure",
      environment: "dev"
    });
    operations.put(op);
    return op;
  }
  async function settle() {
    gate.resolve();
    await new Promise<void>((resolve) => {
      const stop = owner.onEnvironmentTasksSettled("panel", () => {
        stop();
        resolve();
      });
    });
  }
  async function cleanup() {
    await settle();
    await extension.shutdown();
    await Promise.all(
      [...server.servers.keys()].map((id) => server.stopServer(id, true))
    );
  }
  return {
    owner,
    server,
    deps,
    session,
    closeSession,
    joinSession,
    extension,
    canvas,
    entered,
    recoverDelete,
    settle,
    cleanup
  };
}

afterEach(() => {
  operations.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("real server and fake SDK runtime ownership", () => {
  it("requires an explicit owner before runtime construction", () => {
    const fake = createFakeDependencies();
    const invalid = { ...fake.deps };
    Reflect.deleteProperty(invalid, "executionOwner");
    expect(() => createRadiusExtension(invalid)).toThrow("executionOwner");
  });

  it("constructs panel-free, then retains the same owner and transport across close/reopen", async () => {
    const runtime = await composition();
    try {
      expect(runtime.joinSession).toHaveBeenCalledOnce();
      expect(runtime.server.servers.size).toBe(0);
      expect(runtime.owner.hasActiveEnvironmentTasks("panel")).toBe(false);
      runtime.recoverDelete();
      const first = await runtime.canvas.open(context());
      await runtime.entered.promise;
      await runtime.canvas.onClose(context("wrong"));
      await runtime.canvas.onClose(context());
      expect(runtime.deps.stopServer).not.toHaveBeenCalled();
      const reopened = await runtime.canvas.open(context());
      expect(reopened.url).toBe(first.url);
      await runtime.settle();
      expect(runtime.deps.stopServer).not.toHaveBeenCalled();
      await runtime.canvas.onClose(context());
      expect(runtime.deps.stopServer).toHaveBeenCalledExactlyOnceWith("panel");
      expect(runtime.server.servers.size).toBe(0);
    } finally {
      await runtime.cleanup();
    }
  });

  it("retains the existing 46-minute forced-close boundary without draining work", async () => {
    const runtime = await composition();
    try {
      runtime.recoverDelete();
      await runtime.canvas.open(context());
      await runtime.entered.promise;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await runtime.canvas.onClose(context());
      await vi.advanceTimersByTimeAsync(46 * 60 * 1000 - 1);
      expect(runtime.deps.stopServer).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(runtime.deps.stopServer).toHaveBeenCalledExactlyOnceWith("panel");
      expect(runtime.owner.isShuttingDown("panel")).toBe(true);
      expect(runtime.owner.hasActiveEnvironmentTasks("panel")).toBe(true);
      vi.useRealTimers();
      await runtime.settle();
      expect(runtime.owner.hasActiveEnvironmentTasks("panel")).toBe(false);
    } finally {
      vi.useRealTimers();
      await runtime.cleanup();
    }
  });

  it("keeps same-ID replacement active queries but fences the old deferred close", async () => {
    const runtime = await composition();
    try {
      const op = runtime.recoverDelete();
      await runtime.canvas.open(context());
      await runtime.entered.promise;
      await runtime.canvas.onClose(context());
      const old = runtime.server.servers.get("panel");
      await runtime.server.stopServer("panel", true);
      // Do not recover the record again: the old attachment's work stays live.
      op.kind = "create";
      await runtime.canvas.open(context());
      expect(runtime.server.servers.get("panel")).not.toBe(old);
      expect(runtime.owner.hasActiveEnvironmentTasks("panel")).toBe(true);
      await runtime.settle();
      expect(runtime.server.servers.has("panel")).toBe(true);
      expect(runtime.deps.stopServer).not.toHaveBeenCalled();
    } finally {
      await runtime.cleanup();
    }
  });

  it("reports a physical stop failure without losing task settlement", async () => {
    const runtime = await composition();
    try {
      runtime.recoverDelete();
      await runtime.canvas.open(context());
      await runtime.entered.promise;
      runtime.deps.stopServer.mockRejectedValueOnce(new Error("stop failed"));
      await runtime.canvas.onClose(context());
      await runtime.settle();
      await vi.waitFor(() =>
        expect(runtime.deps.logError).toHaveBeenCalledWith(
          "Could not stop Radius canvas: Error: stop failed"
        )
      );
      expect(runtime.owner.hasActiveEnvironmentTasks("panel")).toBe(false);
    } finally {
      await runtime.cleanup();
    }
  });

  it("keeps a replaced attachment's finalizer on its original transport", async () => {
    const runtime = await composition();
    const fetcher = vi.spyOn(globalThis, "fetch");
    const report = vi.spyOn(operations, "report");
    try {
      const op = runtime.recoverDelete();
      await runtime.canvas.open(context());
      await runtime.entered.promise;
      const original = runtime.server.servers.get("panel")!;
      await runtime.server.stopServer("panel", true);
      op.kind = "create";
      await runtime.canvas.open(context());
      const replacement = runtime.server.servers.get("panel")!;
      expect(replacement.baseUrl).not.toBe(original.baseUrl);
      finish(op, "failed");
      op.providerRecovery = { state: "rollback_pending", mutations: [] };
      await runtime.settle();
      await vi.waitFor(() =>
        expect(report).toHaveBeenCalledWith(
          expect.objectContaining({ scope: "provider-recovery-auto-rollback" })
        )
      );
      expect(fetcher).toHaveBeenCalledExactlyOnceWith(
        `${original.baseUrl}/api/operations/${op.operationId}/rollback`,
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-Radius-Server-Owned": expect.any(String)
          })
        })
      );
      expect(runtime.server.servers.get("panel")).toBe(replacement);
      expect(runtime.owner.isShuttingDown("panel")).toBe(false);
    } finally {
      await runtime.cleanup();
    }
  });

  it("marks before stop and keeps the two bounded shutdown phases and idempotence", async () => {
    const runtime = await composition();
    const stopped = deferred();
    const sessionClosed = deferred();
    try {
      runtime.recoverDelete();
      await runtime.canvas.open(context());
      await runtime.entered.promise;
      runtime.deps.stopServer.mockImplementation(async (id, force) => {
        expect(runtime.owner.isShuttingDown(id)).toBe(true);
        expect(force).toBe(true);
        await stopped.promise;
        await runtime.server.stopServer(id, force);
      });
      runtime.closeSession.mockImplementation(() => sessionClosed.promise);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const shutdown = runtime.extension.shutdown();
      expect(runtime.extension.shutdown()).toBe(shutdown);
      await vi.advanceTimersByTimeAsync(1999);
      expect(runtime.session.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(runtime.session.close).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(2000);
      await shutdown;
      expect(runtime.owner.hasActiveEnvironmentTasks("panel")).toBe(true);
      expect(runtime.deps.stopServer).toHaveBeenCalledOnce();
      stopped.resolve();
      sessionClosed.resolve();
      vi.useRealTimers();
      await runtime.settle();
    } finally {
      stopped.resolve();
      sessionClosed.resolve();
      vi.useRealTimers();
      await runtime.cleanup();
    }
  });
});
