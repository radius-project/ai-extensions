import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapRadiusExtension } from "../../../src/runtime/bootstrap.js";
import { createEnvironmentExecutionOwner } from "../../../src/runtime/environment-execution-owner.js";
import { createEnvironmentAccountContext } from "../../../src/runtime/environment-account-context.js";
import { successfulSelectedGhExecutor } from "../../support/server/selected-gh.js";
import { createRadiusExtension } from "../../../src/runtime/create-radius-extension.js";
import { createTestCanvasServerRuntime } from "../../support/server/production-runtime.js";
import {
  newOperation,
  stoppedSetup
} from "../../support/server/operation-fixtures.js";
import {
  createFakeDependencies,
  createFakeSession
} from "../../support/runtime/fakes.js";
import {
  createOperation,
  buildDeleteStages,
  setStageState,
  finish,
  fromPersistedOperation,
  operations,
  prepareProviderMutation,
  recordGitHubEnvironment,
  requireInput,
  settleProviderMutation,
  STAGE_VERIFY,
  toPersistedOperation
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
  const unexpectedAccount = async (): Promise<never> => {
    throw new Error("Unexpected external account access");
  };
  const accountContext = createEnvironmentAccountContext("runtime", {
    createReadOnlyExecutor: unexpectedAccount,
    withSelectedAccount: unexpectedAccount
  });
  const executor = successfulSelectedGhExecutor();
  const server = createTestCanvasServerRuntime({
    executionOwner: owner,
    accountContext,
    environmentOperationRunner: async (operationId) => {
      accountContext.registerExecutor(operationId, executor);
      try {
        entered.resolve();
        await gate.promise;
      } finally {
        accountContext.unregisterExecutor(operationId);
      }
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
    accountContext,
    executor,
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
  it("does not repeat another operation's provider recovery when held admission releases", async () => {
    const runtime = await composition();
    const entered = deferred();
    const save = deferred();
    const register = vi.spyOn(runtime.accountContext, "registerExecutor");
    let writes = 0;
    vi.spyOn(operations, "persist").mockImplementation(async () => {
      if (++writes === 1) {
        entered.resolve();
        await save.promise;
      }
    });
    try {
      await runtime.canvas.open(context());
      const original = stoppedSetup();
      operations.put(original);
      const pending = runtime.server.operationControl({
        operationId: original.operationId,
        instanceId: "panel",
        command: "continue"
      });
      await entered.promise;
      const other = createOperation({
        operationId: "other-recovery",
        repo: "fixture/other",
        environment: "dev",
        provider: "azure"
      });
      other.recoveryState = "provider_reconciliation_pending";
      operations.put(other);
      await runtime.server.stopServer("panel", true);
      await runtime.canvas.open(context());
      await runtime.entered.promise;
      expect(register).toHaveBeenCalledExactlyOnceWith(
        other.operationId,
        runtime.executor
      );
      save.resolve();
      expect(await pending).toMatchObject({
        status: 409,
        body: { code: "operation-context-changed" }
      });
      await runtime.settle();
      expect(register).toHaveBeenCalledExactlyOnceWith(
        other.operationId,
        runtime.executor
      );
      expect(runtime.owner.hasActiveEnvironmentTasks("panel")).toBe(false);
    } finally {
      save.resolve();
      await runtime.cleanup();
    }
  });
  it.each(["continue", "deletion"] as const)(
    "refuses %s on coordinator replacement while recovery waits for held admission",
    async (command) => {
      const runtime = await composition();
      const entered = deferred();
      const gate = deferred();
      let writes = 0;
      vi.spyOn(operations, "persist").mockImplementation(async () => {
        if (++writes === 1) {
          entered.resolve();
          await gate.promise;
        }
      });
      try {
        await runtime.canvas.open(context());
        const op =
          command === "continue" ? stoppedSetup() : (
            createOperation({
              repo: "fixture/app",
              environment: "dev",
              provider: "azure",
              kind: "delete",
              stages: buildDeleteStages()
            })
          );
        if (command === "deletion") {
          op.stages[0].state = "succeeded";
          setStageState(op, op.stages[1].id, "failed");
          finish(op, "failed_partial", {
            failure: { code: "credential-delete-failed" }
          });
        }
        operations.put(op);
        const before = structuredClone(op);
        const input = {
          operationId: op.operationId,
          instanceId: "panel",
          command:
            command === "continue" ? ("continue" as const) : ("retry" as const),
          retryKind: command === "deletion" ? "deletion" : undefined
        };
        const pending = runtime.server.operationControl(input);
        await entered.promise;
        await runtime.server.stopServer("panel", true);
        await runtime.canvas.open(context());
        expect(runtime.owner.hasActiveEnvironmentTasks("panel")).toBe(false);
        gate.resolve();
        expect(await pending).toMatchObject({
          status: 409,
          body: { code: "operation-context-changed" }
        });
        expect(op).toMatchObject(before);
        expect(writes).toBe(2);
        expect(runtime.owner.hasActiveEnvironmentTasks("panel")).toBe(false);
        expect(
          runtime.accountContext.getExecutor(op.operationId)
        ).toBeUndefined();
        expect(await runtime.server.operationControl(input)).toMatchObject({
          status: 202
        });
        await runtime.entered.promise;
      } finally {
        gate.resolve();
        await runtime.cleanup();
      }
    }
  );
  it.each(["continue", "resume"] as const)(
    "persists direct %s before scheduling the existing attached runner without an internal POST",
    async (command) => {
      const runtime = await composition();
      const fetcher = vi.spyOn(globalThis, "fetch");
      const saved = deferred();
      const saving = deferred();
      const persist = vi
        .spyOn(operations, "persist")
        .mockImplementation(async () => {
          saving.resolve();
          await saved.promise;
        });
      try {
        await runtime.canvas.open(context());
        const op = command === "resume" ? newOperation() : stoppedSetup();
        if (command === "resume") {
          op.request = { azure: {} };
          requireInput(op, {
            code: "app-selection-required",
            checkpoint: "saved-input"
          });
        }
        operations.put(op);
        const input = { operationId: op.operationId, instanceId: "panel" };
        const submit = () =>
          command === "continue" ?
            runtime.server.operationControl({ ...input, command })
          : runtime.server.operationResume(
              { ...input, code: "app-selection-required" },
              async () => ({
                repo: String(op.repo),
                environment: String(op.environment),
                provider: String(op.provider),
                checkpoint: "saved-input",
                appId: "chosen-app"
              })
            );
        const pending = submit();
        await saving.promise;
        expect(
          runtime.accountContext.getExecutor(op.operationId)
        ).toBeUndefined();
        expect(runtime.owner.hasActiveEnvironmentTasks("panel")).toBe(false);
        saved.resolve();
        expect(await pending).toMatchObject({ status: 202 });
        await runtime.entered.promise;
        expect(persist).toHaveBeenCalledOnce();
        expect(runtime.accountContext.getExecutor(op.operationId)).toBe(
          runtime.executor
        );
        const repeated = await submit();
        expect(repeated).toMatchObject(
          command === "continue" ?
            { status: 202, body: { duplicate: true } }
          : { status: 409, body: { code: "operation-resume-mismatch" } }
        );
        expect(persist).toHaveBeenCalledOnce();
        expect(fetcher).not.toHaveBeenCalled();
      } finally {
        saved.resolve();
        await runtime.cleanup();
      }
    }
  );

  it.each(["persist", "runner", "recovery-persist"] as const)(
    "keeps direct rollback fail closed when the %s is unavailable",
    async (failure) => {
      const runtime = await composition();
      const fetcher = vi.spyOn(globalThis, "fetch");
      const report = vi
        .spyOn(operations, "report")
        .mockImplementation(() => {});
      const persist = vi
        .spyOn(operations, "persist")
        .mockImplementation(async () => {
          if (
            failure === "persist" ||
            (failure === "recovery-persist" && persist.mock.calls.length === 2)
          ) {
            throw new Error("store offline");
          }
        });
      try {
        const op = stoppedSetup();
        operations.put(op);
        const before = structuredClone(op);
        expect(
          await runtime.server.operationControl({
            operationId: op.operationId,
            command: "rollback"
          })
        ).toMatchObject({
          status: failure === "persist" ? 500 : 503,
          body: {
            code:
              failure === "persist" ?
                "operation-rollback-persist-failed"
              : "operation-command-unscheduled"
          }
        });
        expect(op).toMatchObject(before);
        expect(op.control.commands).toEqual([]);
        expect(persist).toHaveBeenCalledTimes(failure === "persist" ? 1 : 2);
        if (failure === "recovery-persist") {
          expect(report).toHaveBeenCalledExactlyOnceWith({
            operationId: op.operationId,
            code: "operation-control-recovery-persist-failed",
            message: "store offline"
          });
        } else {
          expect(report).not.toHaveBeenCalled();
        }
        expect(runtime.server.servers.size).toBe(0);
        expect(fetcher).not.toHaveBeenCalled();
        expect(runtime.owner.hasActiveEnvironmentTasks("panel")).toBe(false);
      } finally {
        await runtime.cleanup();
      }
    }
  );

  it.each(["not_applied", "manual_required"] as const)(
    "keeps remaining resources after opening and reopening a saved %s branch deletion",
    async (status) => {
      const runtime = await composition();
      const fetcher = vi.spyOn(globalThis, "fetch");
      try {
        const saved = createOperation({
          operationId: "op_branch_removal",
          repo: "fixture/app",
          provider: "azure",
          environment: "dev"
        });
        recordGitHubEnvironment(saved, {
          state: "created",
          repo: "fixture/app",
          environment: "dev"
        });
        const deletion = prepareProviderMutation(saved, {
          kind: "github_branch.delete",
          target: "fixture/app\0setup-branch\0original-head"
        });
        settleProviderMutation(saved, deletion.mutationId, status, null);
        finish(saved, "failed_partial");
        saved.providerRecovery.state = "rollback_pending";
        const op = fromPersistedOperation(toPersistedOperation(saved));
        operations.put(op);
        const ledger = structuredClone(op.setupArtifacts);
        expect(ledger.githubEnvironment.state).toBe("created");

        for (let opening = 0; opening < 2; opening++) {
          await runtime.canvas.open(context());
          expect(fetcher).not.toHaveBeenCalled();
          expect(runtime.owner.hasActiveEnvironmentTasks("panel")).toBe(false);
          expect(
            runtime.accountContext.getExecutor(op.operationId)
          ).toBeUndefined();
          expect(op.control.commands).toEqual([]);
          expect(op.setupArtifacts).toEqual(ledger);
          await runtime.canvas.onClose(context());
        }
      } finally {
        await runtime.cleanup();
      }
    }
  );

  it.each([false, true])(
    "observes a pinned verification without a panel or HTTP server (persistence failure=%s)",
    async (persistenceFailure) => {
      const owner = createEnvironmentExecutionOwner();
      const unexpected = async (): Promise<never> => {
        throw new Error("Unexpected account acquisition");
      };
      const accountContext = createEnvironmentAccountContext(
        "verification-runtime",
        {
          createReadOnlyExecutor: unexpected,
          withSelectedAccount: unexpected
        }
      );
      const run = vi.fn(async (args: string[]) => {
        const endpoint = args.find((arg) => arg.startsWith("repos/"));
        const result =
          endpoint === "repos/fixture/app/actions/runs/17" ?
            { status: "completed", conclusion: "success" }
          : (
            endpoint ===
            "repos/fixture/app/actions/runs/17/jobs?per_page=100&page=1"
          ) ?
            { jobs: [] }
          : undefined;
        if (args[0] !== "api" || result === undefined) {
          throw new Error(`Unexpected GitHub command: ${args.join(" ")}`);
        }
        expect(args).toEqual(["api", endpoint, "--include", "--method", "GET"]);
        return {
          code: 0,
          stdout:
            "HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n" +
            JSON.stringify(result),
          stderr: ""
        };
      });
      const executor = successfulSelectedGhExecutor({
        login: "saved-account",
        run
      });
      const server = createTestCanvasServerRuntime({
        executionOwner: owner,
        accountContext
      });
      const op = createOperation({
        operationId: "headless-verification",
        repo: "fixture/app",
        environment: "dev",
        provider: "azure"
      });
      op.currentStage = STAGE_VERIFY;
      op.context.githubLogin = executor.login;
      op.verification = {
        runId: "17",
        dispatchedAt: Date.now(),
        workflow: "verify.yml",
        ref: "topic",
        environment: "dev"
      };
      operations.put(op);
      accountContext.registerExecutor(op.operationId, executor);
      const persist = vi
        .spyOn(operations, "persist")
        .mockImplementation(async () => {
          if (persistenceFailure)
            throw new Error("Verification checkpoint unavailable");
        });
      const report = vi
        .spyOn(operations, "report")
        .mockImplementation(() => {});
      try {
        expect(server.servers.size).toBe(0);
        expect(run).not.toHaveBeenCalled();
        const outcome = await server.verificationStatus({
          repo: op.repo,
          environment: op.environment,
          operationId: op.operationId
        });
        expect(outcome, JSON.stringify(outcome)).toMatchObject({
          status: 200,
          body: { state: "success", runId: "17" }
        });
        expect(server.servers.size).toBe(0);
        expect(op.state).toBe("succeeded");
        expect(persist).toHaveBeenCalledOnce();
        expect(report).toHaveBeenCalledTimes(persistenceFailure ? 1 : 0);
        expect(run).toHaveBeenCalledTimes(2);
        expect(accountContext.getExecutor(op.operationId)).toBe(executor);
      } finally {
        accountContext.unregisterExecutor(op.operationId);
      }
    }
  );

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
      expect(runtime.accountContext.getExecutor("op_runtime")).toBeUndefined();
      expect(runtime.owner.hasActiveEnvironmentTasks("panel")).toBe(false);
      runtime.recoverDelete();
      const first = await runtime.canvas.open(context());
      await runtime.entered.promise;
      await runtime.canvas.onClose(context("wrong"));
      await runtime.canvas.onClose(context());
      expect(runtime.deps.stopServer).not.toHaveBeenCalled();
      expect(runtime.accountContext.getExecutor("op_runtime")).toBe(
        runtime.executor
      );
      const reopened = await runtime.canvas.open(context());
      expect(reopened.url).toBe(first.url);
      expect(runtime.accountContext.getExecutor("op_runtime")).toBe(
        runtime.executor
      );
      await runtime.settle();
      expect(runtime.accountContext.getExecutor("op_runtime")).toBeUndefined();
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

  it("refuses a replaced attachment's finalizer before direct command admission", async () => {
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
          expect.objectContaining({
            scope: "provider-recovery-auto-rollback",
            message:
              "The operation changed before the queued command was admitted."
          })
        )
      );
      expect(fetcher).not.toHaveBeenCalled();
      expect(op.control.commands).toEqual([]);
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
