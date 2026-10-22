import { afterEach, describe, expect, it, vi } from "vitest";
import { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { RADIUS_REF } from "@radius-project/core";
import { buildRadiusAppProvenanceTags } from "../../../src/azure-oidc.js";
import { generateVerifyWorkflow } from "../../../src/infra.js";
import {
  encodeWorkflowContent,
  workflowContentDigest
} from "@radius-project/adapter-shared";
import { createHarness } from "@radius-project/adapter-shared/test-support/ghcr-bootstrap";
import * as gh from "../../../src/gh.js";
import { createGitHubAccountCoordinator } from "../../../src/server/services/github-account-coordinator.js";
import { bootstrapRadiusExtension } from "../../../src/runtime/bootstrap.js";
import { createEnvironmentExecutionOwner } from "../../../src/runtime/environment-execution-owner.js";
import { createEnvironmentAccountContext } from "../../../src/runtime/environment-account-context.js";
import { createEnvironmentTools } from "../../../src/runtime/environment-tools.js";
import { createDeploymentAccountResolver } from "../../../src/runtime/deployment-account.js";
import { createGitHubAccountReadinessService } from "../../../src/server/services/github-account-readiness.js";
import { successfulSelectedGhExecutor } from "../../support/server/selected-gh.js";
import { configureEnvironmentFixture } from "../../support/server/configure-environment.js";
import { createConfigureEnvironmentService } from "../../../src/server/services/configure-environment.js";
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
  finish,
  fromPersistedOperation,
  operations,
  prepareProviderMutation,
  recordGitHubEnvironment,
  recordAzureApp,
  recordCommittedWorkflowFile,
  requestStop,
  setCommandState,
  setStageState,
  STAGE_AUTHORIZE_IDENTITY,
  STAGE_CONFIGURE_ENVIRONMENT,
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
      const releaseExecutor = accountContext.registerExecutor(
        operationId,
        executor
      );
      try {
        entered.resolve();
        await gate.promise;
      } finally {
        releaseExecutor();
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
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("real server and fake SDK runtime ownership", () => {
  it.each(["setup", "verification", "cleanup"] as const)(
    "never invokes a queued %s runner for a replacement record",
    async (kind) => {
      const runtime = await composition();
      const register = vi.spyOn(runtime.accountContext, "registerExecutor");
      const persist = vi
        .spyOn(operations, "persist")
        .mockResolvedValue(undefined);
      const op = runtime.recoverDelete();
      op.kind = "create";
      if (kind === "setup")
        runtime.server.setupExecution.scheduleEnvironmentOperation(op);
      else
        runtime.server.setupExecution.scheduleCommandTask(
          kind === "verification" ? "verification_retry" : "rollback",
          op,
          "old-command"
        );
      const replacement = runtime.recoverDelete();
      replacement.kind = "create";
      const before = structuredClone(replacement);
      const completed = new Promise<void>((resolve) => {
        const stop = runtime.owner.onEnvironmentTasksSettled(undefined, () => {
          stop();
          resolve();
        });
      });
      try {
        await runtime.settle();
        await completed;
        expect(register).not.toHaveBeenCalled();
        expect(persist).not.toHaveBeenCalled();
        expect(replacement).toEqual(before);
      } finally {
        await runtime.cleanup();
      }
    }
  );
  it("refuses a pending resume without an original attachment", async () => {
    const runtime = await composition();
    const op = newOperation();
    op.request = { azure: {} };
    requireInput(op, {
      code: "app-selection-required",
      checkpoint: "saved-input"
    });
    operations.put(op);
    const before = structuredClone(op);
    const persist = vi
      .spyOn(operations, "persist")
      .mockResolvedValue(undefined);
    try {
      expect(
        await runtime.server.operationResume(
          {
            operationId: op.operationId,
            code: "app-selection-required"
          },
          async () => ({
            repo: String(op.repo),
            environment: String(op.environment),
            provider: String(op.provider),
            checkpoint: "saved-input",
            appId: "chosen-app"
          })
        )
      ).toMatchObject({
        status: 409,
        body: { code: "operation-resume-mismatch" }
      });
      expect(op).toEqual(before);
      expect(persist).not.toHaveBeenCalled();
      expect(runtime.owner.hasActiveEnvironmentTasks("panel")).toBe(false);
    } finally {
      await runtime.cleanup();
    }
  });
  it.each(["input", "save", "save-rejection"] as const)(
    "does not transfer a pending resume to a same-ID replacement attachment during %s",
    async (phase) => {
      const runtime = await composition();
      const entered = deferred();
      const gate = deferred();
      let writes = 0;
      let saved: unknown;
      const persist = vi
        .spyOn(operations, "persist")
        .mockImplementation(async () => {
          writes++;
          const envelope = toPersistedOperation(op);
          if (writes === 1 && phase !== "input") {
            entered.resolve();
            await gate.promise;
          }
          saved = structuredClone(envelope);
          if (writes === 1 && phase === "save-rejection")
            throw new Error("write rejected");
        });
      const op = newOperation();
      op.request = { azure: {} };
      requireInput(op, {
        code: "app-selection-required",
        checkpoint: "saved-input"
      });
      const before = structuredClone(op);
      try {
        await runtime.canvas.open(context());
        operations.put(op);
        const pending = runtime.server.operationResume(
          {
            operationId: op.operationId,
            instanceId: "panel",
            code: "app-selection-required"
          },
          async () => {
            if (phase === "input") {
              entered.resolve();
              await gate.promise;
            }
            return {
              repo: String(op.repo),
              environment: String(op.environment),
              provider: String(op.provider),
              checkpoint: "saved-input",
              appId: "chosen-app"
            };
          }
        );
        await entered.promise;
        await runtime.server.stopServer("panel", true);
        await runtime.canvas.open(context());
        gate.resolve();
        expect(await pending).toMatchObject({
          status: 409,
          body: { code: "operation-resume-mismatch" }
        });
        expect(op).toEqual(before);
        expect(runtime.owner.hasActiveEnvironmentTasks("panel")).toBe(false);
        expect(
          runtime.accountContext.getExecutor(op.operationId)
        ).toBeUndefined();
        expect(persist).toHaveBeenCalledTimes(phase === "input" ? 0 : 2);
        if (phase !== "input")
          expect(saved).toMatchObject({
            state: "input_required",
            inputRequired: before.inputRequired
          });
      } finally {
        gate.resolve();
        await runtime.cleanup();
      }
    }
  );
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
      operations.delete(original.operationId);
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
    "retains runtime continue but refuses deletion on coordinator replacement: %s",
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
        if (command === "continue") {
          expect(await pending).toMatchObject({ status: 202 });
          await runtime.entered.promise;
          expect(writes).toBe(1);
          expect(runtime.accountContext.getExecutor(op.operationId)).toBe(
            runtime.executor
          );
          return;
        }
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
            instanceId: "missing-panel",
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
      const releaseExecutor = accountContext.registerExecutor(
        op.operationId,
        executor
      );
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
        releaseExecutor();
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

  it("revalidates a replaced attachment's finalizer through shared command admission", async () => {
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
              "Radius did not create any resources it can prove it owns in this attempt."
          })
        )
      );
      expect(fetcher).not.toHaveBeenCalled();
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

  it.each(["resume", "continue"] as const)(
    "retains saved %s work when runtime shutdown races admission persistence",
    async (action) => {
      const owner = createEnvironmentExecutionOwner();
      const unexpected = async (): Promise<never> => {
        throw new Error("Unexpected account acquisition");
      };
      const runner = vi.fn(unexpected);
      const accountContext = createEnvironmentAccountContext("runtime", {
        createReadOnlyExecutor: unexpected,
        withSelectedAccount: unexpected
      });
      const runtime = createTestCanvasServerRuntime({
        executionOwner: owner,
        accountContext,
        environmentOperationRunner: runner
      });
      const op =
        action === "continue" ? stoppedSetup() : (
          createOperation({
            operationId: "shutdown-resume",
            repo: "fixture/app",
            environment: "dev",
            provider: "azure"
          })
        );
      if (action === "resume") {
        op.request = { azure: {} };
        requireInput(op, {
          code: "app-selection-required",
          checkpoint: "selection"
        });
      }
      operations.put(op);
      vi.spyOn(operations, "persist").mockImplementation(async () => {
        owner.shutdown();
      });
      const result =
        action === "resume" ?
          await runtime.operationResume(
            {
              operationId: op.operationId,
              code: "app-selection-required",
              isCurrent: () => !owner.isShuttingDown(),
              schedule: runtime.setupExecution.scheduleEnvironmentOperation
            },
            async () => ({
              repo: op.repo,
              environment: op.environment,
              provider: "azure",
              checkpoint: "selection",
              appId: "chosen-app"
            })
          )
        : await runtime.operationControl({
            operationId: op.operationId,
            command: "continue"
          });
      expect(result).toMatchObject({
        status: 503,
        body: { code: "operation-shutting-down" }
      });
      expect(op.endedAt).toBeNull();
      expect(op.failure).toBeNull();
      expect(runner).not.toHaveBeenCalled();
      expect(runtime.servers.size).toBe(0);
    }
  );

  it.each([
    ["azure", "before-cleanup"],
    ["configuration", "before-cleanup"],
    ["azure", "cleanup-delete"],
    ["configuration", "cleanup-delete"]
  ] as const)(
    "stops the real %s service at %s without publishing a terminal cleanup result",
    async (stage, boundary) => {
      const externalCommand = vi.spyOn(gh, "cliExec").mockImplementation(() => {
        throw new Error("Unexpected external command during failure cleanup");
      });
      const externalFetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => {
          throw new Error("Unexpected network request during failure cleanup");
        });
      const owner = createEnvironmentExecutionOwner();
      let repositoryReads = 0;
      const run = vi.fn(async (args: string[]) => {
        const endpoint = args[1];
        if (args[0] !== "api")
          throw new Error(`Unexpected command: ${args.join(" ")}`);
        if (endpoint === "user")
          return { code: 0, stdout: '{"login":"saved-account"}', stderr: "" };
        if (
          endpoint === "repos/fixture/app" ||
          endpoint === "/repos/fixture/app"
        ) {
          repositoryReads++;
          if (repositoryReads === 2) {
            if (boundary === "before-cleanup") owner.shutdown();
            return {
              code: 0,
              stdout:
                '{"full_name":"fixture/app","permissions":{"admin":false}}',
              stderr: ""
            };
          }
          return {
            code: 0,
            stdout: '{"full_name":"fixture/app","permissions":{"admin":true}}',
            stderr: ""
          };
        }
        if (args.includes("DELETE")) {
          expect(boundary).toBe("cleanup-delete");
          owner.shutdown();
          return { code: 0, stdout: "", stderr: "" };
        }
        if (endpoint === "/repos/fixture/app/environments/dev")
          return { code: 0, stdout: '{"name":"dev","id":17}', stderr: "" };
        if (args.includes("/repos/fixture/app/environments?per_page=100"))
          return { code: 0, stdout: "", stderr: "" };
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });
      const executor = successfulSelectedGhExecutor({
        login: "saved-account",
        requiresKeyringSwitch: false,
        run
      });
      const accountContext = createEnvironmentAccountContext(
        "runtime",
        createGitHubAccountCoordinator({
          createExecutor: async () => executor,
          getActiveKeyringLogin: async () => "saved-account",
          switchKeyringAccount: async () => {
            throw new Error("Unexpected switch");
          },
          resetIdentityCache: () => {}
        })
      );
      const runtime = createTestCanvasServerRuntime({
        executionOwner: owner,
        accountContext
      });
      const op = createOperation({
        operationId: "shutdown-boundary",
        repo: "fixture/app",
        environment: "dev",
        provider: "azure"
      });
      op.context.githubLogin = "saved-account";
      if (boundary === "cleanup-delete")
        recordGitHubEnvironment(op, {
          state: "created",
          repo: op.repo,
          name: op.environment,
          providerId: "17"
        });
      op.currentStage =
        stage === "azure" ?
          STAGE_AUTHORIZE_IDENTITY
        : STAGE_CONFIGURE_ENVIRONMENT;
      op.request = {
        needsAzureCredentials: stage === "azure",
        azure: {
          repo: op.repo,
          environment: op.environment,
          resourceGroup: "fixture-group",
          cluster: "fixture-cluster",
          subscriptionId: "11111111-1111-4111-8111-111111111111"
        },
        environment: {
          repo: op.repo,
          environment: op.environment,
          provider: "azure"
        }
      };
      operations.put(op);
      vi.spyOn(operations, "persist").mockResolvedValue(undefined);
      runtime.setupExecution.scheduleEnvironmentOperation(op);
      await new Promise<void>((resolve) => {
        const stop = owner.onEnvironmentTasksSettled(undefined, () => {
          stop();
          resolve();
        });
      });
      expect(externalCommand).not.toHaveBeenCalled();
      expect(externalFetch).not.toHaveBeenCalled();
      expect(
        repositoryReads,
        JSON.stringify({ failure: op.failure, calls: run.mock.calls })
      ).toBe(2);
      expect(op.endedAt).toBeNull();
      expect(op.failure).toBeNull();
      expect(owner.hasActiveEnvironmentTasks(undefined)).toBe(false);
      expect(accountContext.getExecutor(op.operationId)).toBeUndefined();
      expect(
        run.mock.calls.filter(([args]) => args.includes("DELETE"))
      ).toHaveLength(boundary === "cleanup-delete" ? 1 : 0);
      if (boundary === "cleanup-delete")
        expect(op.setupArtifacts.githubEnvironment.state).toBe("deleted");
      expect(runtime.servers.size).toBe(0);
    }
  );

  it.each([
    ...[
      "azure",
      "environment",
      "RADIUS_MANAGED",
      "RADIUS_STATE_BACKEND",
      "AZURE_TENANT_ID"
    ].flatMap((stage) =>
      ["issued", "prepared"].flatMap((boundary) =>
        ["service", "tool"].map((entry) => [
          stage,
          boundary,
          entry,
          "shutdown"
        ])
      )
    ),
    ...["ghcr-head", "ghcr-post", "ghcr-put", "ghcr-manifest"].map((stage) => [
      stage,
      "issued",
      "service",
      "shutdown"
    ]),
    ...["azure", "environment"].flatMap((stage) =>
      ["throw", "timeout"].map((boundary) => [
        stage,
        boundary,
        "service",
        "shutdown"
      ])
    ),
    ...["azure-owner", "azure-tags"].flatMap((stage) =>
      ["issued", "prepared", "delay", "inner-delay"].map((boundary) => [
        stage,
        boundary,
        "service",
        "shutdown"
      ])
    ),
    ["azure-principal", "inner-delay", "service", "shutdown"],
    ["environment", "inner-delay", "service", "shutdown"],
    ["azure", "issued", "tool", "stop"],
    ["RADIUS_MANAGED", "issued", "tool", "stop"]
  ] as const)(
    "retains the %s %s journal and account via %s during %s",
    async (stage, boundary, entry, interruption) => {
      const owner = createEnvironmentExecutionOwner();
      const entered = deferred();
      const writeGate = deferred();
      const persisted = deferred();
      const persistGate = deferred();
      const appId = "22222222-2222-4222-8222-222222222222";
      const callerId = "44444444-4444-4444-8444-444444444444";
      const azureStage = stage.startsWith("azure");
      const ghcrStage = stage.startsWith("ghcr");
      const unknownBoundary = boundary === "throw" || boundary === "timeout";
      const azureRetry =
        stage === "azure-owner" ||
        stage === "azure-tags" ||
        stage === "azure-principal";
      const innerDelay = boundary === "inner-delay";
      const environmentDelay = stage === "environment" && innerDelay;
      const delayBoundary = boundary === "delay" || innerDelay;
      let innerReads = 0;
      const rejected = deferred();
      let azureAttempts = 0;
      let environmentAttempts = 0;
      let retryPrepared = false;
      const success = (stdout = "") => ({ code: 0, stdout, stderr: "" });
      const variableValues = new Map<string, string>();
      let acknowledged = false;
      let writeSettled = false;
      const finishWrite = (stdout = "") => {
        writeSettled = true;
        if (boundary === "throw") throw new Error("Lost write response");
        if (boundary === "timeout")
          return {
            code: 1,
            stdout: "",
            stderr: "Write timed out",
            timedOut: true
          };
        acknowledged = true;
        return success(stdout);
      };
      const run = vi.fn(async (args: string[]) => {
        if (
          stage !== "azure" &&
          args.slice(0, 3).join(" ") === `variable set ${stage}`
        ) {
          entered.resolve();
          await writeGate.promise;
          acknowledged = true;
          return success();
        }
        if (
          args[0] === "variable" &&
          args[1] === "set" &&
          [
            "RADIUS_MANAGED",
            "RADIUS_STATE_BACKEND",
            "RADIUS_STATE_REGISTRY",
            "RADIUS_STATE_ARCHIVE",
            "AZURE_CLIENT_ID"
          ].includes(args[2])
        ) {
          variableValues.set(args[2], args[4]);
          return success();
        }
        if (args[0] !== "api")
          throw new Error(`Unexpected GitHub command: ${args.join(" ")}`);
        if (stage === "environment" && args.includes("PUT")) {
          if (environmentDelay) {
            environmentAttempts++;
            rejected.resolve();
            return { code: 1, stdout: "", stderr: "ECONNRESET" };
          }
          entered.resolve();
          await writeGate.promise;
          return finishWrite('{"name":"dev","id":17}');
        }
        const endpoint = args[1]?.replace(/^\//, "");
        if (endpoint === "user") return success('{"login":"saved-account"}');
        if (endpoint === "repos/fixture/app")
          return success(
            '{"id":23,"name":"app","full_name":"fixture/app","default_branch":"main","owner":{"id":11,"login":"fixture","type":"User"},"permissions":{"admin":true}}'
          );
        if (
          endpoint === "repos/fixture/app/environments/dev" &&
          environmentDelay &&
          environmentAttempts > 0
        ) {
          innerReads++;
          return { code: 1, stdout: "", stderr: "HTTP 500" };
        }
        if (endpoint === "repos/fixture/app/environments/dev")
          return stage === "environment" && !acknowledged ?
              { code: 1, stdout: "", stderr: "HTTP 404: Not Found" }
            : success('{"name":"dev","id":17}');
        if (args.includes("/repos/fixture/app/environments?per_page=100"))
          return success();
        if (endpoint === "repos/fixture/app/actions/oidc/customization/sub")
          return success('{"use_default":true,"use_immutable_subject":false}');
        if (
          endpoint?.startsWith("repos/fixture/app/environments/dev/variables/")
        ) {
          const name = endpoint.slice(
            "repos/fixture/app/environments/dev/variables/".length
          );
          return variableValues.has(name) ?
              success(JSON.stringify({ name, value: variableValues.get(name) }))
            : { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
        }
        throw new Error(`Unexpected GitHub command: ${args.join(" ")}`);
      });
      const runAz = vi.fn(async (args: string[]) => {
        const command = args.slice(0, 3).join(" ");
        const retryTarget =
          stage === "azure-owner" ?
            args.slice(0, 4).join(" ") === "ad app owner add"
          : stage === "azure-principal" ? command === "ad sp create"
          : stage === "azure-tags" &&
            args[0] === "rest" &&
            args.includes("PATCH");
        if (retryTarget && ++azureAttempts === 1) {
          rejected.resolve();
          return {
            code: 1,
            stdout: "",
            stderr: innerDelay ? "ECONNRESET" : "Directory_ObjectNotFound"
          };
        }
        if ((stage === "azure" && command === "ad app create") || retryTarget) {
          entered.resolve();
          await writeGate.promise;
          return finishWrite(stage === "azure" ? appId : "");
        }
        if (azureRetry && command === "ad app create") return success(appId);
        if (azureRetry && args.slice(0, 4).join(" ") === "ad app owner add")
          return success();
        if (stage === "azure-principal") {
          if (args[0] === "rest" && args.includes("PATCH")) return success();
          if (command === "ad app show" && args.includes("tags"))
            return success(
              JSON.stringify(
                buildRadiusAppProvenanceTags({
                  repo: "fixture/app",
                  environment: "dev",
                  operationId: "shutdown-write"
                })
              )
            );
          if (command === "ad sp show") {
            if (azureAttempts > 0) innerReads++;
            return { code: 1, stdout: "", stderr: "Request_ResourceNotFound" };
          }
        }
        if (azureRetry && args.slice(0, 4).join(" ") === "ad app owner list") {
          if (innerDelay && stage === "azure-owner") {
            innerReads++;
            return success("[]");
          }
          return success(callerId);
        }
        if (
          innerDelay &&
          stage === "azure-tags" &&
          command === "ad app show" &&
          args.includes("tags")
        ) {
          innerReads++;
          return success("[]");
        }
        if (args.slice(0, 2).join(" ") === "account set") return success();
        if (args.slice(0, 2).join(" ") === "account show")
          return success(
            '{"id":"11111111-1111-4111-8111-111111111111","tenantId":"33333333-3333-4333-8333-333333333333","user":{"type":"user","name":"fixture@example.test"}}'
          );
        if (command === "ad signed-in-user show") return success(callerId);
        if (command === "ad app list") return success("[]");
        throw new Error(`Unexpected Azure command: ${args.join(" ")}`);
      });
      vi.spyOn(gh, "cliExec").mockImplementation(
        (command, args, _options, callback) => {
          if (command !== "az")
            throw new Error(`Unexpected executable: ${command}`);
          void runAz(args).then(
            (result) =>
              callback(
                result.code === 0 ?
                  null
                : Object.assign(new Error(result.stderr), {
                    code: result.code,
                    killed: boundary === "timeout"
                  }),
                result.stdout,
                result.stderr
              ),
            (error: unknown) =>
              callback(
                Object.assign(
                  error instanceof Error ? error : new Error(String(error)),
                  {
                    killed: unknownBoundary
                  }
                ),
                "",
                error instanceof Error ? error.message : String(error)
              )
          );
          return new ChildProcess();
        }
      );
      const ghcr = createHarness({ finalRepository: "fixture/app" });
      const fetchImpl: typeof ghcr.fetchImpl = async (input, options) => {
        const url = new URL(input);
        if (url.origin === "https://api.github.com") {
          url.host = "api.test";
          if (url.pathname === "/users/fixture") url.pathname = "/users/acme";
        } else if (url.origin === "https://ghcr.io") {
          url.host = "registry.test";
        } else {
          throw new Error(`Unexpected fetch: ${url.href}`);
        }
        const response = await ghcr.fetchImpl(url.href, options);
        if (
          (stage === "ghcr-head" &&
            options?.method === "HEAD" &&
            url.pathname.includes("/manifests/")) ||
          (stage === "ghcr-post" && options?.method === "POST") ||
          (stage === "ghcr-put" &&
            options?.method === "PUT" &&
            url.pathname.startsWith("/uploads/")) ||
          (stage === "ghcr-manifest" &&
            options?.method === "PUT" &&
            url.pathname.includes("/manifests/"))
        ) {
          entered.resolve();
          await writeGate.promise;
        }
        return {
          ok: response.ok,
          status: response.status,
          headers: {
            get: (name) =>
              response.headers
                .get(name)
                ?.replaceAll("registry.test", "ghcr.io") ?? null
          },
          text: () => response.text(),
          json: () => response.json(),
          arrayBuffer: () => response.arrayBuffer()
        };
      };
      vi.stubGlobal("fetch", fetchImpl);
      const executor = successfulSelectedGhExecutor({
        login: "saved-account",
        requiresKeyringSwitch: true,
        run
      });
      const switchAccount = vi.fn(async () => {
        throw new Error("Unexpected account switch");
      });
      const coordinator = createGitHubAccountCoordinator({
        createExecutor: async () => executor,
        getActiveKeyringLogin: async () => "saved-account",
        switchKeyringAccount: switchAccount,
        resetIdentityCache: () => {}
      });
      const readiness = createGitHubAccountReadinessService(coordinator, {
        ownerKey: "runtime",
        ports: {
          probePackageAccess: async () => ({
            ok: true,
            detail: "Fixture package access is available."
          })
        }
      });
      const checkReadiness = vi.spyOn(readiness, "check");
      const accountContext = createEnvironmentAccountContext(
        "runtime",
        coordinator
      );
      const runtime = createTestCanvasServerRuntime({
        executionOwner: owner,
        accountContext
      });
      let op = createOperation({
        operationId: "shutdown-write",
        repo: "fixture/app",
        environment: "dev",
        provider: "azure"
      });
      op.context.githubLogin = "saved-account";
      op.currentStage =
        azureStage ? STAGE_AUTHORIZE_IDENTITY : STAGE_CONFIGURE_ENVIRONMENT;
      op.request = {
        needsAzureCredentials: azureStage,
        azure: {
          repo: op.repo,
          environment: op.environment,
          resourceGroup: "fixture-group",
          cluster: "fixture-cluster",
          subscriptionId: "11111111-1111-4111-8111-111111111111"
        },
        environment: {
          repo: op.repo,
          environment: op.environment,
          provider: "azure",
          clientId: appId,
          tenantId: "33333333-3333-4333-8333-333333333333",
          subscriptionId: "11111111-1111-4111-8111-111111111111"
        }
      };
      if (entry === "service") operations.put(op);
      const fake = createFakeDependencies();
      const extension = await bootstrapRadiusExtension(
        {
          ...fake.deps,
          ...runtime,
          executionOwner: owner,
          environment: createEnvironmentTools({
            ...runtime.environmentServices,
            owner,
            session: fake.deps.session,
            account: createDeploymentAccountResolver({
              readIdentity: async () => ({
                accounts: [
                  {
                    login: executor.login,
                    active: true,
                    hasWorkflow: true,
                    hasPackages: true,
                    switchable: true,
                    acting: false
                  }
                ]
              }),
              readiness,
              createExecutor: coordinator.createReadOnlyExecutor,
              redactDiagnostic: (value) => value
            }),
            workspace: async () => ({
              repo: "fixture/app",
              branch: "feature/setup"
            }),
            validateBranch: async () => {},
            redact: (value) => value,
            reportError: (error) => {
              throw error;
            }
          })
        },
        {
          createCanvas: (declaration) => declaration,
          joinSession: async () => createFakeSession()
        }
      );
      const snapshots: (typeof op)[] = [];
      vi.spyOn(operations, "persist").mockImplementation(async () => {
        snapshots.push(structuredClone(operations.latest("fixture/app")));
        const mutation = op.providerRecovery.mutations.at(-1);
        const targetMutation =
          stage === "azure" ? mutation?.kind === "azure_application.create"
          : stage === "azure-owner" ? mutation?.kind === "azure_app_owner.add"
          : stage === "azure-tags" ? mutation?.kind === "azure_app_tags.patch"
          : stage === "azure-principal" ?
            mutation?.kind === "azure_service_principal.create"
          : stage === "environment" ?
            mutation?.kind === "github_environment.put"
          : mutation?.kind === "github_environment_variable.put" &&
            mutation.intent?.name === stage;
        if (
          boundary === "prepared" &&
          (!azureRetry || azureAttempts === 1) &&
          targetMutation &&
          mutation?.status === "prepared"
        ) {
          retryPrepared = true;
          entered.resolve();
          await writeGate.promise;
        }
        if (
          boundary === "prepared" &&
          (!azureRetry || retryPrepared) &&
          targetMutation &&
          mutation?.status === "not_applied"
        ) {
          persisted.resolve();
          await persistGate.promise;
        }
        if (acknowledged || writeSettled) {
          persisted.resolve();
          await persistGate.promise;
        }
      });
      let completed = Promise.resolve();
      try {
        if (azureRetry || environmentDelay)
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        if (entry === "service")
          runtime.setupExecution.scheduleEnvironmentOperation(op);
        else {
          const tool = extension.tools.find(
            ({ name }) => name === "radius_setup_environment"
          );
          if (!tool) throw new Error("Missing registered setup tool");
          const result = JSON.parse(
            String(
              await tool.handler({
                repo: "fixture/app",
                environment: "dev",
                provider: "azure",
                tenantId: "33333333-3333-4333-8333-333333333333",
                subscriptionId: "11111111-1111-4111-8111-111111111111",
                resourceGroup: "fixture-group",
                cluster: "fixture-cluster",
                ...(stage !== "azure" ?
                  { clientId: appId }
                : { createNew: true })
              })
            )
          );
          expect(result).toMatchObject({ kind: "accepted" });
          op = operations.get(result.operation.operationId);
        }
        completed = new Promise<void>((resolve) => {
          const stop = owner.onEnvironmentTasksSettled(undefined, () => {
            stop();
            resolve();
          });
        });
        if (azureRetry || environmentDelay) {
          await Promise.race([rejected.promise, completed]);
          await vi.advanceTimersByTimeAsync(0);
          expect(op.providerRecovery.mutations.at(-1)).toMatchObject({
            status: innerDelay ? "outcome_unknown" : "not_applied",
            evidence:
              innerDelay ?
                "The provider request ended without an answer Radius could trust."
              : "Directory_ObjectNotFound"
          });
          if (!delayBoundary) await vi.advanceTimersByTimeAsync(2000);
        }
        if (!delayBoundary) await Promise.race([entered.promise, completed]);
        const diagnostics = JSON.stringify({
          failure: op.failure,
          gh: run.mock.calls,
          az: runAz.mock.calls
        });
        expect(op.executionActive, diagnostics).toBe(true);
        expect(accountContext.getExecutor(op.operationId), diagnostics).toBe(
          executor
        );
        const unresolvedBeforeShutdown =
          innerDelay ? structuredClone(op.providerRecovery) : undefined;
        if (innerDelay) expect(innerReads).toBe(1);
        if (interruption === "shutdown") {
          await extension.shutdown();
          expect(switchAccount).not.toHaveBeenCalled();
        } else {
          const tool = extension.tools.find(
            ({ name }) => name === "radius_environment_control"
          );
          if (!tool) throw new Error("Missing registered control tool");
          const checksBeforeStop = checkReadiness.mock.calls.length;
          expect(checksBeforeStop).toBeGreaterThan(0);
          vi.useFakeTimers();
          const stopping = tool.handler({
            operationId: op.operationId,
            repo: op.repo,
            environment: op.environment,
            action: "stop"
          });
          await vi.advanceTimersByTimeAsync(3000);
          expect(JSON.parse(String(await stopping))).toMatchObject({
            kind: "accepted",
            code: "operation-stop-pending",
            operation: { operationId: op.operationId }
          });
          vi.useRealTimers();
          expect(checkReadiness).toHaveBeenCalledTimes(checksBeforeStop);
          expect(op.control.stop.requestedAt).toBeTruthy();
          expect(snapshots.at(-1)?.control.stop.requestedAt).toBeTruthy();
          expect(acknowledged).toBe(false);
          expect(switchAccount).not.toHaveBeenCalled();
        }
        expect(accountContext.getExecutor(op.operationId)).toBe(executor);
        const callsAtShutdown = {
          gh: run.mock.calls.length,
          az: runAz.mock.calls.length,
          fetch: ghcr.calls.length
        };
        writeGate.resolve();
        if (delayBoundary) await vi.advanceTimersByTimeAsync(2000);
        else await Promise.race([persisted.promise, completed]);
        expect(acknowledged).toBe(boundary === "issued" && !ghcrStage);
        if (!delayBoundary && !ghcrStage)
          expect(accountContext.getExecutor(op.operationId)).toBe(executor);
        persistGate.resolve();
        await completed;
        if (interruption === "shutdown") {
          expect(op.endedAt).toBeNull();
        } else {
          expect(op.state).toBe("cancelled");
          expect(op.endedAt).not.toBeNull();
        }
        expect(op.failure).toBeNull();
        expect(owner.hasActiveEnvironmentTasks(undefined)).toBe(false);
        expect(accountContext.getExecutor(op.operationId)).toBeUndefined();
        expect(runAz.mock.calls.slice(callsAtShutdown.az)).toEqual([]);
        expect(
          run.mock.calls
            .slice(callsAtShutdown.gh)
            .every(([args]) => args[0] === "api" && !args.includes("--method"))
        ).toBe(true);
        expect(ghcr.calls.slice(callsAtShutdown.fetch)).toEqual([]);
        if (innerDelay) {
          expect(innerReads).toBe(1);
          expect(op.providerRecovery).toEqual(unresolvedBeforeShutdown);
          expect(snapshots.at(-1)?.providerRecovery).toEqual(
            unresolvedBeforeShutdown
          );
        }
        if (!ghcrStage)
          expect(snapshots.at(-1)?.providerRecovery.mutations).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                kind:
                  stage === "azure" ? "azure_application.create"
                  : stage === "azure-owner" ? "azure_app_owner.add"
                  : stage === "azure-tags" ? "azure_app_tags.patch"
                  : stage === "azure-principal" ?
                    "azure_service_principal.create"
                  : stage === "environment" ? "github_environment.put"
                  : "github_environment_variable.put",
                status:
                  boundary === "issued" ? "confirmed"
                  : unknownBoundary || innerDelay ? "outcome_unknown"
                  : "not_applied"
              })
            ])
          );
        if (boundary === "issued" && !ghcrStage)
          expect(snapshots.at(-1)?.setupArtifacts).toMatchObject(
            azureStage ?
              {
                azureApp: { state: "created", origin: "this_operation", appId }
              }
            : stage === "environment" ?
              {
                githubEnvironment: { providerId: "17" }
              }
            : {
                githubEnvironmentVariables: expect.arrayContaining([
                  expect.objectContaining({
                    name: stage,
                    previousKnown: true,
                    previousValue: null
                  })
                ])
              }
          );
        if (azureRetry) {
          expect(azureAttempts).toBe(boundary === "issued" ? 2 : 1);
          expect(op.providerRecovery.mutations.at(-1)).toMatchObject({
            initialDiagnostic: expect.stringContaining(
              innerDelay ? "ECONNRESET" : "Directory_ObjectNotFound"
            )
          });
          expect(
            op.providerRecovery.mutations.at(-1)?.reconcileAttempts ?? 0
          ).toBe(0);
        }
        if (unknownBoundary) {
          expect(
            op.providerRecovery.mutations.at(-1)?.reconcileAttempts ?? 0
          ).toBe(0);
          expect(op.providerRecovery.mutations.at(-1)?.finalDiagnostic).toMatch(
            /Lost write response|Write timed out/
          );
        }
        expect(runtime.servers.size).toBe(0);
        const released = await coordinator.withSelectedAccount(
          executor.login,
          { ownerKey: "after-settlement" },
          async () => true
        );
        expect(released.value).toBe(true);
        expect(released.switched).toBe(false);
      } finally {
        vi.useRealTimers();
        writeGate.resolve();
        persistGate.resolve();
        await completed;
        owner.shutdown();
        await extension.shutdown();
      }
    }
  );

  it.each(
    [
      "azure",
      "github",
      "github-content",
      "github-history",
      "environment-read",
      "branch-page",
      "branch-exact"
    ].flatMap((provider) =>
      [0, 11].flatMap((attempts) =>
        ["response", "rejection"].map((outcome) => ({
          provider,
          attempts,
          outcome
        }))
      )
    )
  )(
    "preserves unresolved $provider evidence at $attempts attempts after late $outcome",
    async ({ provider, attempts, outcome }) => {
      vi.spyOn(gh, "fetchFileFromRepoResult").mockImplementation(
        async (repo, path, ref) => {
          if (
            repo !== "radius-project/ai-extensions" ||
            path !== ".github/extension/verify-azure.yml" ||
            ref !== RADIUS_REF
          )
            throw new Error(`Unexpected template read: ${repo}:${ref}:${path}`);
          return {
            content: readFileSync(
              new URL(
                "../../../../../.github/extension/verify-azure.yml",
                import.meta.url
              ),
              "utf8"
            ),
            error: null,
            status: 200
          };
        }
      );
      const owner = createEnvironmentExecutionOwner();
      const entered = deferred();
      const gate = deferred();
      const success = (stdout = "") => ({ code: 0, stdout, stderr: "" });
      const workflowPath = ".github/workflows/radius-verify-credentials.yml";
      const content =
        provider === "github-content" || provider === "github-history" ?
          encodeWorkflowContent(
            await generateVerifyWorkflow("dev", "azure", undefined, {
              setupPushOperationMarker: "resumed-shutdown"
            })
          )
        : "";
      const branch = "radius/setup-dev-workflows-resumed";
      let environmentReads = 0;
      const heldRead = async () => {
        entered.resolve();
        await gate.promise;
        if (outcome === "rejection") throw new Error("Late nested read failed");
      };
      const run = vi.fn(async (args: string[]) => {
        const endpoint = args[1]?.replace(/^\//, "");
        if (
          endpoint === "repos/fixture/app" &&
          args.includes(".default_branch")
        )
          return success("main");
        if (
          [
            workflowPath,
            ".github/workflows/run-rad-commands.yml",
            ".github/workflows/radius-deploy.yml"
          ].some(
            (path) => endpoint === `repos/fixture/app/contents/${path}?ref=main`
          ) &&
          args.includes(".content")
        )
          return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
        if (
          endpoint === "repos/fixture/app/environments/dev" &&
          provider === "environment-read"
        ) {
          if (++environmentReads === 2) await heldRead();
          return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
        }
        if (endpoint === "repos/fixture/app/environments/dev")
          return success('{"name":"dev","id":17}');
        if (args.includes("/repos/fixture/app/environments?per_page=100"))
          return success();
        if (endpoint === "repos/fixture/app")
          return success(
            '{"id":23,"full_name":"fixture/app","default_branch":"main","owner":{"id":11,"login":"fixture","type":"User"}}'
          );
        if (
          provider === "azure" &&
          endpoint === "repos/fixture/app/actions/oidc/customization/sub"
        ) {
          return success('{"use_default":true,"use_immutable_subject":false}');
        }
        if (
          (provider === "github" ||
            provider === "github-content" ||
            provider === "github-history") &&
          endpoint === `repos/fixture/app/contents/${workflowPath}`
        ) {
          if (provider !== "github" && args.includes("--jq"))
            return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
          if (provider === "github-history")
            return success(JSON.stringify({ sha: "blob-1", content }));
          entered.resolve();
          await gate.promise;
          if (outcome === "rejection")
            throw new Error("Late GitHub read failed");
          if (provider === "github-content")
            return success(JSON.stringify({ sha: "blob-1", content }));
          return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
        }
        if (provider === "github-history" && endpoint?.includes("/commits?")) {
          await heldRead();
          return success(
            JSON.stringify(
              Array.from({ length: 100 }, (_, i) => ({
                sha: String(i).padStart(40, "0"),
                commit: { message: "unrelated" }
              }))
            )
          );
        }
        if (provider.startsWith("branch-")) {
          if (
            endpoint ===
            `repos/fixture/app/git/ref/heads/${encodeURIComponent(branch)}`
          )
            return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
          if (endpoint?.includes("/git/matching-refs/")) {
            await heldRead();
            return success(
              JSON.stringify(
                provider === "branch-page" ?
                  Array.from({ length: 100 }, (_, i) => ({
                    ref: `refs/heads/${branch}-${i}`
                  }))
                : []
              )
            );
          }
        }
        throw new Error(`Unexpected GitHub read or write: ${args.join(" ")}`);
      });
      const runAz = vi.fn(async (args: string[]) => {
        if (
          provider === "azure" &&
          args.slice(0, 3).join(" ") === "ad app list"
        ) {
          entered.resolve();
          await gate.promise;
          if (outcome === "rejection")
            throw new Error("Late Azure read failed");
          return success("[]");
        }
        if (args.slice(0, 2).join(" ") === "account set") return success();
        if (args.slice(0, 2).join(" ") === "account show")
          return success(
            '{"id":"11111111-1111-4111-8111-111111111111","tenantId":"33333333-3333-4333-8333-333333333333","user":{"type":"user","name":"fixture@example.test"}}'
          );
        throw new Error(`Unexpected Azure read or write: ${args.join(" ")}`);
      });
      vi.spyOn(gh, "cliExec").mockImplementation(
        (command, args, _options, callback) => {
          if (command !== "az")
            throw new Error(`Unexpected executable: ${command}`);
          void runAz(args).then(
            (result) => callback(null, result.stdout, result.stderr),
            (error: unknown) =>
              callback(
                error instanceof Error ? error : new Error(String(error)),
                "",
                ""
              )
          );
          return new ChildProcess();
        }
      );
      const executor = successfulSelectedGhExecutor({
        login: "saved-account",
        run
      });
      const coordinator = createGitHubAccountCoordinator({
        createExecutor: async () => executor,
        getActiveKeyringLogin: async () => executor.login,
        switchKeyringAccount: async () => {
          throw new Error("Unexpected account switch");
        },
        resetIdentityCache: () => {}
      });
      const accountContext = createEnvironmentAccountContext(
        "runtime",
        coordinator
      );
      const runtime = createTestCanvasServerRuntime({
        executionOwner: owner,
        accountContext
      });
      const op = createOperation({
        operationId: "resumed-shutdown",
        repo: "fixture/app",
        environment: "dev",
        provider: "azure"
      });
      op.context.githubLogin = executor.login;
      op.currentStage =
        provider === "azure" ?
          STAGE_AUTHORIZE_IDENTITY
        : STAGE_CONFIGURE_ENVIRONMENT;
      op.request = {
        needsAzureCredentials: provider === "azure",
        azure: {
          resourceGroup: "fixture-group",
          cluster: "fixture-cluster",
          subscriptionId: "11111111-1111-4111-8111-111111111111"
        },
        environment: {
          provider: "azure",
          clientId: "22222222-2222-4222-8222-222222222222",
          tenantId: "33333333-3333-4333-8333-333333333333",
          subscriptionId: "11111111-1111-4111-8111-111111111111"
        }
      };
      if (provider !== "environment-read")
        recordGitHubEnvironment(op, {
          state: "reused",
          origin: "pre_existing",
          repo: op.repo,
          environment: op.environment,
          providerId: "17"
        });
      const mutation = prepareProviderMutation(op, {
        kind:
          provider === "azure" ? "azure_application.create"
          : provider === "environment-read" ? "github_environment.put"
          : provider.startsWith("branch-") ? "github_branch.create"
          : "github_workflow.put",
        target:
          provider === "azure" ? "fixture/app:dev:radius-deploy-fixture-app"
          : provider === "environment-read" ? "fixture/app:dev"
          : provider.startsWith("branch-") ? `fixture/app\0${branch}\0base-sha`
          : `fixture/app:<default>:${workflowPath}`,
        ...(content ?
          {
            intent: {
              branch: "<default>",
              path: workflowPath,
              previousBlobSha: null,
              previousBlobKnown: true,
              contentSha256: workflowContentDigest(content),
              operationMarker: `radius-operation:resumed-shutdown:workflow:${workflowPath}:${workflowContentDigest(content).slice(0, 16)}`
            }
          }
        : {})
      });
      settleProviderMutation(
        op,
        mutation.mutationId,
        "outcome_unknown",
        "Original provider acknowledgement was lost"
      );
      if (attempts > 0)
        op.providerRecovery.mutations[0].reconcileAttempts = attempts;
      const original = structuredClone(op.providerRecovery);
      operations.put(op);
      const snapshots: (typeof original)[] = [];
      vi.spyOn(operations, "persist").mockImplementation(async () => {
        snapshots.push(structuredClone(op.providerRecovery));
      });
      const diagnostics = vi.spyOn(operations, "report");
      const fake = createFakeDependencies();
      const extension = await bootstrapRadiusExtension(
        { ...fake.deps, ...runtime, executionOwner: owner },
        {
          createCanvas: (declaration) => declaration,
          joinSession: async () => createFakeSession()
        }
      );
      let completed = Promise.resolve();
      try {
        runtime.setupExecution.scheduleEnvironmentOperation(op);
        completed = new Promise<void>((resolve) => {
          const stop = owner.onEnvironmentTasksSettled(undefined, () => {
            stop();
            resolve();
          });
        });
        await Promise.race([entered.promise, completed]);
        expect(
          op.executionActive,
          JSON.stringify({
            calls: run.mock.calls,
            az: runAz.mock.calls,
            failure: op.failure
          })
        ).toBe(true);
        expect(accountContext.getExecutor(op.operationId)).toBe(executor);
        await extension.shutdown();
        expect(accountContext.getExecutor(op.operationId)).toBe(executor);
        const before = {
          gh: run.mock.calls.length,
          az: runAz.mock.calls.length
        };
        gate.resolve();
        await completed;
        expect(run.mock.calls.slice(before.gh)).toEqual([]);
        expect(runAz.mock.calls.slice(before.az)).toEqual([]);
        expect(op.providerRecovery).toEqual(original);
        for (const snapshot of snapshots) expect(snapshot).toEqual(original);
        expect(op.failure).toBeNull();
        expect(op.endedAt).toBeNull();
        expect(diagnostics).not.toHaveBeenCalledWith(
          expect.objectContaining({ scope: "setup-task-shutdown" })
        );
        expect(accountContext.getExecutor(op.operationId)).toBeUndefined();
        expect(owner.hasActiveEnvironmentTasks(undefined)).toBe(false);
        const released = await coordinator.withSelectedAccount(
          executor.login,
          { ownerKey: "after-shutdown" },
          async () => true
        );
        expect(released.value).toBe(true);
      } finally {
        gate.resolve();
        await completed;
        owner.shutdown();
        await extension.shutdown();
      }
    }
  );

  it.each([0, 11])(
    "fences configuration-stage environment reconciliation after SDK shutdown at %s attempts",
    async (attempts) => {
      const test = configureEnvironmentFixture();
      const owner = createEnvironmentExecutionOwner();
      const runtime = createTestCanvasServerRuntime({ executionOwner: owner });
      const fake = createFakeDependencies();
      const extension = await bootstrapRadiusExtension(
        { ...fake.deps, ...runtime, executionOwner: owner },
        {
          createCanvas: (declaration) => declaration,
          joinSession: async () => createFakeSession()
        }
      );
      const entered = deferred();
      const gate = deferred();
      const mutation = prepareProviderMutation(test.operation, {
        kind: "github_environment.put",
        target: "octo/app:dev"
      });
      settleProviderMutation(
        test.operation,
        mutation.mutationId,
        "outcome_unknown",
        "Lost acknowledgement"
      );
      if (attempts > 0)
        test.operation.providerRecovery.mutations[0].reconcileAttempts =
          attempts;
      const original = structuredClone(test.operation.providerRecovery);
      test.dependencies.isShuttingDown = owner.isShuttingDown;
      test.dependencies.now = () => 1700000000000;
      let reads = 0;
      const read = vi.fn(async (path: string) => {
        if (path === "/repos/octo/app") return { ok: true, json: {} };
        if (++reads === 2) {
          entered.resolve();
          await gate.promise;
          return { ok: true, json: { name: "dev", id: 17 } };
        }
        return { ok: false, status: 404 };
      });
      test.dependencies.readGitHubJson = read;
      const pending = createConfigureEnvironmentService(test.dependencies)({
        data: test.data
      });
      const checked = expect(pending).rejects.toMatchObject({
        code: "setup-execution-interrupted"
      });
      try {
        await Promise.race([entered.promise, pending]);
        expect(reads).toBe(2);
        await extension.shutdown();
        gate.resolve();
        await checked;
        expect(read).toHaveBeenCalledTimes(3);
        expect(test.operation.providerRecovery).toEqual(original);
        expect(test.dependencies.persistOperations).not.toHaveBeenCalled();
        expect(test.finalize).not.toHaveBeenCalled();
        expect(test.operation.failure).toBeNull();
        expect(test.operation.endedAt).toBeNull();
      } finally {
        gate.resolve();
        await checked;
        await extension.shutdown();
      }
    }
  );

  it("detaches a closed panel immediately while its setup and account remain owned", async () => {
    const runtime = await composition();
    const register = vi.spyOn(runtime.accountContext, "registerExecutor");
    const op = runtime.recoverDelete();
    op.kind = "create";
    op.recoveryState = "provider_reconciliation_pending";
    try {
      await runtime.canvas.open(context());
      await runtime.entered.promise;
      const original = runtime.server.servers.get("panel");
      await runtime.canvas.onClose(context());
      expect(runtime.server.servers.size).toBe(0);
      expect(runtime.owner.hasActiveEnvironmentTasks("panel")).toBe(true);
      expect(runtime.accountContext.getExecutor(op.operationId)).toBe(
        runtime.executor
      );
      expect(op.executionActive).toBe(true);
      await runtime.canvas.open(context());
      expect(runtime.server.servers.get("panel")).not.toBe(original);
      expect(register).toHaveBeenCalledOnce();
      await runtime.settle();
      expect(
        runtime.accountContext.getExecutor(op.operationId)
      ).toBeUndefined();
      expect(runtime.server.servers.has("panel")).toBe(true);
      expect(register).toHaveBeenCalledOnce();
    } finally {
      await runtime.cleanup();
    }
  });

  it("stops no-panel admission on SDK shutdown without releasing an in-flight task's executor", async () => {
    const runtime = await composition();
    const op = runtime.recoverDelete();
    op.kind = "create";
    runtime.server.setupExecution.scheduleEnvironmentOperation(op);
    const completed = new Promise<void>((resolve) => {
      const stop = runtime.owner.onEnvironmentTasksSettled(undefined, () => {
        stop();
        resolve();
      });
    });
    try {
      await runtime.entered.promise;
      await runtime.extension.shutdown();
      expect(runtime.session.close).toHaveBeenCalledOnce();
      expect(runtime.owner.hasActiveEnvironmentTasks(undefined)).toBe(true);
      expect(runtime.accountContext.getExecutor(op.operationId)).toBe(
        runtime.executor
      );
      expect(
        runtime.server.setupExecution.scheduleEnvironmentOperation({
          operationId: "later"
        })
      ).toBe(false);
      expect(runtime.server.servers.size).toBe(0);
    } finally {
      await runtime.settle();
      await completed;
      await runtime.cleanup();
    }
    expect(runtime.accountContext.getExecutor(op.operationId)).toBeUndefined();
    expect(op.endedAt).toBeNull();
  });

  it("resumes tied setup input through the production runtime with no presentation", async () => {
    const runtime = await composition();
    const op = runtime.recoverDelete();
    op.kind = "create";
    op.request = { azure: {} };
    requireInput(op, {
      code: "app-selection-required",
      checkpoint: "selection"
    });
    vi.spyOn(operations, "persist").mockResolvedValue(undefined);
    let completed: Promise<void> | undefined;
    try {
      const result = await runtime.server.operationResume(
        {
          operationId: op.operationId,
          code: "app-selection-required",
          isCurrent: () => !runtime.owner.isShuttingDown(),
          schedule: runtime.server.setupExecution.scheduleEnvironmentOperation
        },
        async () => ({
          repo: op.repo,
          environment: op.environment,
          provider: "azure",
          checkpoint: "selection",
          createNew: false,
          appId: "selected-app"
        })
      );
      expect(result.status).toBe(202);
      completed = new Promise<void>((resolve) => {
        const stop = runtime.owner.onEnvironmentTasksSettled(undefined, () => {
          stop();
          resolve();
        });
      });
      await runtime.entered.promise;
      expect(op.request.azure.appId).toBe("selected-app");
      expect(op.inputRequired).toBeNull();
      expect(runtime.server.servers.size).toBe(0);
    } finally {
      await runtime.settle();
      await completed;
      await runtime.cleanup();
    }
  });

  it("shares headless recovery across panel close and reopen without another executor", async () => {
    const runtime = await composition();
    const register = vi.spyOn(runtime.accountContext, "registerExecutor");
    const op = runtime.recoverDelete();
    op.kind = "create";
    op.recoveryState = "provider_reconciliation_pending";
    runtime.server.setupExecution.recoverOperation(op);
    const completed = new Promise<void>((resolve) => {
      const stop = runtime.owner.onEnvironmentTasksSettled(undefined, () => {
        stop();
        resolve();
      });
    });
    try {
      await runtime.entered.promise;
      await runtime.canvas.open(context("a"));
      expect(register).toHaveBeenCalledOnce();
      expect(runtime.owner.hasActiveEnvironmentTasks(undefined)).toBe(true);
      expect(runtime.owner.hasActiveEnvironmentTasks("a")).toBe(false);
      await runtime.canvas.onClose(context("a"));
      await vi.waitFor(() =>
        expect(runtime.server.servers.has("a")).toBe(false)
      );
      await runtime.canvas.open(context("b"));
      expect(runtime.owner.hasActiveEnvironmentTasks("b")).toBe(false);
      expect(register).toHaveBeenCalledOnce();
      expect(runtime.accountContext.getExecutor(op.operationId)).toBe(
        runtime.executor
      );
      expect(op.executionActive).toBe(true);
      await runtime.settle();
      await completed;
      expect(register).toHaveBeenCalledOnce();
      expect(
        runtime.accountContext.getExecutor(op.operationId)
      ).toBeUndefined();
      expect(op.executionActive).toBe(false);
      expect(runtime.server.servers.has("b")).toBe(true);
    } finally {
      await runtime.settle();
      await completed;
      await runtime.cleanup();
    }
  });

  it.each([
    "setup",
    "recovered-verification",
    "verification-retry",
    "verification-shutdown",
    "retry-shutdown"
  ] as const)(
    "keeps a replacement executor after the old %s finalizer settles",
    async (kind) => {
      const owner = createEnvironmentExecutionOwner();
      const entered = deferred();
      const gate = deferred();
      const unexpected = async (): Promise<never> => {
        throw new Error("Unexpected account or command access");
      };
      const executor = successfulSelectedGhExecutor({
        login: "saved-account",
        requiresKeyringSwitch: false,
        run: async (args) => {
          const endpoint = args.find((arg) => arg.startsWith("repos/"));
          let body: object;
          if (endpoint === "repos/fixture/app/actions/runs/17") {
            entered.resolve();
            await gate.promise;
            body = { status: "completed", conclusion: "success" };
          } else if (
            endpoint ===
            "repos/fixture/app/actions/runs/17/jobs?per_page=100&page=1"
          ) {
            body = { jobs: [] };
          } else {
            throw new Error(`Unexpected selected command: ${args.join(" ")}`);
          }
          expect(args).toEqual([
            "api",
            endpoint,
            "--include",
            "--method",
            "GET"
          ]);
          return {
            code: 0,
            stdout:
              "HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n" +
              JSON.stringify(body),
            stderr: ""
          };
        }
      });
      const coordinator = createGitHubAccountCoordinator({
        createExecutor: async (login) => {
          expect(login).toBe("saved-account");
          return executor;
        },
        getActiveKeyringLogin: async () => "original",
        switchKeyringAccount: unexpected,
        resetIdentityCache: () => {}
      });
      const accountContext = createEnvironmentAccountContext(
        "runtime",
        coordinator
      );
      const op = createOperation({
        operationId: "executor-replacement",
        repo: "fixture/app",
        environment: "dev",
        provider: "azure"
      });
      op.context.githubLogin = "saved-account";
      if (kind === "setup") {
        requestStop(op);
      } else {
        op.currentStage = STAGE_VERIFY;
        op.recoveryState = "verification_pending";
        op.verification = {
          dispatchedAt: Date.now(),
          workflow: "verify.yml",
          ref: "topic",
          environment: "dev",
          runId: "17",
          accountUnavailablePhase: "monitor"
        };
        if (kind === "verification-retry" || kind === "retry-shutdown") {
          recordAzureApp(op, { state: "reused", appId: "fixture-app" });
          recordCommittedWorkflowFile(op, {
            path: ".github/workflows/verify.yml",
            mode: "default_branch",
            branch: "topic"
          });
          finish(op, "failed_partial", {
            failure: { code: "verification-retry-github-account-unavailable" }
          });
        }
      }
      operations.put(op);
      vi.spyOn(operations, "persist").mockImplementation(async () => {
        if (
          kind === "setup" ||
          (kind === "retry-shutdown" &&
            accountContext.getExecutor(op.operationId))
        ) {
          entered.resolve();
          await gate.promise;
        }
      });
      const runtime = createTestCanvasServerRuntime({
        executionOwner: owner,
        accountContext
      });
      if (kind === "setup") {
        runtime.setupExecution.scheduleEnvironmentOperation(op);
      } else if (kind !== "verification-retry" && kind !== "retry-shutdown") {
        runtime.setupExecution.recoverOperation(op);
      } else {
        const accepted = await runtime.operationControl({
          operationId: op.operationId,
          command: "retry",
          retryKind: "verification"
        });
        expect(accepted.status, JSON.stringify(accepted)).toBe(202);
      }
      const completed = new Promise<void>((resolve) => {
        const stop = owner.onEnvironmentTasksSettled(undefined, () => {
          stop();
          resolve();
        });
      });
      let releaseReplacement: (() => void) | undefined;
      try {
        await Promise.race([entered.promise, completed]);
        expect(
          accountContext.getExecutor(op.operationId),
          JSON.stringify(op.failure)
        ).toBe(executor);
        const replacement = successfulSelectedGhExecutor({
          login: "saved-account"
        });
        releaseReplacement = accountContext.registerExecutor(
          op.operationId,
          replacement
        );
        if (kind === "verification-shutdown" || kind === "retry-shutdown")
          owner.shutdown();
        gate.resolve();
        await completed;
        expect(accountContext.getExecutor(op.operationId)).toBe(replacement);
        expect(op.state).toBe(
          kind === "setup" ? "cancelled"
          : kind === "verification-shutdown" || kind === "retry-shutdown" ?
            "running"
          : "succeeded"
        );
        if (kind === "verification-shutdown" || kind === "retry-shutdown")
          expect(op.endedAt).toBeNull();
        expect(runtime.servers.size).toBe(0);
      } finally {
        gate.resolve();
        await completed;
        releaseReplacement?.();
      }
      expect(accountContext.getExecutor(op.operationId)).toBeUndefined();
    }
  );

  it("constructs and executes pinned setup without a panel identity or automatic recovery", async () => {
    const owner = createEnvironmentExecutionOwner();
    const unexpected = async (): Promise<never> => {
      throw new Error("Unexpected external command");
    };
    const executor = successfulSelectedGhExecutor({
      login: "saved-account",
      requiresKeyringSwitch: false,
      run: unexpected
    });
    const coordinator = createGitHubAccountCoordinator({
      createExecutor: async (login) => {
        expect(login).toBe("saved-account");
        return executor;
      },
      getActiveKeyringLogin: async () => "original",
      switchKeyringAccount: unexpected,
      resetIdentityCache: () => {}
    });
    const lease = vi.spyOn(coordinator, "withSelectedAccount");
    const accountContext = createEnvironmentAccountContext(
      "headless-production",
      coordinator
    );
    const op = createOperation({
      operationId: "panel-free-setup",
      repo: "fixture/app",
      environment: "dev",
      provider: "azure"
    });
    op.context.githubLogin = "saved-account";
    op.request = { github: { login: "not-the-saved-account" } };
    requestStop(op);
    operations.put(op);
    const recovered = stoppedSetup();
    recovered.providerRecovery = { state: "rollback_pending" };
    operations.put(recovered);
    const before = structuredClone(recovered);
    const persist = vi
      .spyOn(operations, "persist")
      .mockResolvedValue(undefined);
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(unexpected);
    const runtime = createTestCanvasServerRuntime({
      executionOwner: owner,
      accountContext
    });
    const fake = createFakeDependencies();
    const session = createFakeSession();
    const extension = await bootstrapRadiusExtension(
      { ...fake.deps, ...runtime, executionOwner: owner },
      {
        createCanvas: (declaration) => declaration,
        joinSession: async () => session
      }
    );
    try {
      expect(runtime.servers.size).toBe(0);
      expect(persist).not.toHaveBeenCalled();
      expect(recovered).toEqual(before);
      expect(lease).not.toHaveBeenCalled();
      runtime.setupExecution.scheduleEnvironmentOperation(op);
      await new Promise<void>((resolve) => {
        const stop = owner.onEnvironmentTasksSettled(undefined, () => {
          stop();
          resolve();
        });
      });
      expect(op.state).toBe("cancelled");
      expect(lease).toHaveBeenCalledWith(
        "saved-account",
        { ownerKey: "headless-production", operationId: op.operationId },
        expect.any(Function),
        30000
      );
      expect(accountContext.getExecutor(op.operationId)).toBeUndefined();
      expect(runtime.servers.size).toBe(0);
      expect(recovered).toEqual(before);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await extension.shutdown();
    }
  });

  it("admits direct setup cleanup without a panel but leaves deletion on its server-ready path", async () => {
    const owner = createEnvironmentExecutionOwner();
    const unexpected = async (): Promise<never> => {
      throw new Error("Unexpected account or transport access");
    };
    const accountContext = createEnvironmentAccountContext("direct-runtime", {
      createReadOnlyExecutor: unexpected,
      withSelectedAccount: unexpected
    });
    const runner = vi.fn(async (operationId: string) => {
      finish(operations.get(operationId), "cancelled");
    });
    vi.spyOn(operations, "persist").mockResolvedValue(undefined);
    const runtime = createTestCanvasServerRuntime({
      executionOwner: owner,
      accountContext,
      environmentOperationRunner: runner
    });
    const op = stoppedSetup();
    operations.put(op);
    const result = await runtime.operationControl({
      operationId: op.operationId,
      command: "rollback"
    });
    expect(result.status).toBe(202);
    await new Promise<void>((resolve) => {
      const stop = owner.onEnvironmentTasksSettled(undefined, () => {
        stop();
        resolve();
      });
    });
    expect(runner).toHaveBeenCalledExactlyOnceWith(
      op.operationId,
      result.body.commandId
    );
    expect(op.state).toBe("cancelled");
    expect(runtime.servers.size).toBe(0);

    const deletion = createOperation({
      operationId: "server-only-delete",
      repo: "fixture/other-app",
      environment: "dev",
      provider: "azure",
      kind: "delete",
      stages: buildDeleteStages()
    });
    deletion.stages[0].state = "succeeded";
    setStageState(deletion, deletion.stages[1].id, "failed");
    finish(deletion, "failed_partial", {
      failure: { code: "credential-delete-failed" }
    });
    operations.put(deletion);
    runtime.setupExecution.recoverOperation(deletion);
    const retry = await runtime.operationControl({
      operationId: deletion.operationId,
      command: "retry",
      retryKind: "deletion"
    });
    expect(retry.status).toBe(202);
    expect(deletion.failure).toMatchObject({
      code: "operation-scheduling-failed",
      evidence: "No runtime setup task runner was available."
    });
    expect(runner).toHaveBeenCalledOnce();
    expect(owner.hasActiveEnvironmentTasks(undefined)).toBe(false);
    expect(runtime.servers.size).toBe(0);
  });

  it.each([false, true])(
    "admits cleanup authorized by active setup after panel detach=%s",
    async (detachPanel) => {
      const owner = createEnvironmentExecutionOwner();
      const unexpected = async (): Promise<never> => {
        throw new Error("Unexpected account or transport access");
      };
      const accountContext = createEnvironmentAccountContext(
        "recovery-runtime",
        {
          createReadOnlyExecutor: unexpected,
          withSelectedAccount: unexpected
        }
      );
      const op = createOperation({
        operationId: "active-recovery",
        repo: "fixture/app",
        environment: "dev",
        provider: "azure"
      });
      operations.put(op);
      const setupEntered = deferred();
      const setupGate = deferred();
      const cleanupEntered = deferred();
      const runner = vi.fn(async (_operationId: string, commandId?: string) => {
        if (commandId === undefined) {
          setupEntered.resolve();
          await setupGate.promise;
          recordAzureApp(op, {
            state: "created",
            appId: "fixture-app",
            displayName: "radius-deploy"
          });
          finish(op, "failed");
          op.providerRecovery = { state: "rollback_pending" };
        } else {
          setCommandState(op, commandId, "finished");
          finish(op, "cancelled");
          op.providerRecovery = { state: "complete" };
          cleanupEntered.resolve();
        }
      });
      const persist = vi
        .spyOn(operations, "persist")
        .mockResolvedValue(undefined);
      const fetcher = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(unexpected);
      const runtime = createTestCanvasServerRuntime({
        executionOwner: owner,
        accountContext,
        environmentOperationRunner: runner
      });
      expect(persist).not.toHaveBeenCalled();
      const fake = createFakeDependencies();
      const extension = await bootstrapRadiusExtension(
        { ...fake.deps, ...runtime, executionOwner: owner },
        {
          createCanvas: (declaration) => declaration,
          joinSession: async () => createFakeSession()
        }
      );
      try {
        if (detachPanel) {
          op.recoveryState = "provider_reconciliation_pending";
          await extension.canvases[0].open(context());
        } else runtime.setupExecution.scheduleEnvironmentOperation(op);
        await setupEntered.promise;
        if (detachPanel) {
          await extension.canvases[0].onClose(context());
          expect(runtime.servers.size).toBe(0);
          expect(owner.hasActiveEnvironmentTasks("panel")).toBe(true);
        }
        setupGate.resolve();
        await cleanupEntered.promise;
        await new Promise<void>((resolve) => {
          const stop = owner.onEnvironmentTasksSettled(undefined, () => {
            stop();
            resolve();
          });
        });
        expect(runner.mock.calls).toEqual([
          [op.operationId],
          [op.operationId, expect.any(String)]
        ]);
        expect(op.control.commands).toEqual([
          expect.objectContaining({ kind: "rollback" })
        ]);
        expect(persist).toHaveBeenCalled();
        expect(op.state).toBe("cancelled");
        expect(runtime.servers.size).toBe(0);
        expect(fetcher).not.toHaveBeenCalled();
      } finally {
        setupGate.resolve();
        await extension.shutdown();
      }
    }
  );

  it("binds direct controls and input continuation without starting recovery or a server", async () => {
    const unexpected = async (): Promise<never> => {
      throw new Error("Unexpected account or transport access");
    };
    const accountContext = createEnvironmentAccountContext("control-runtime", {
      createReadOnlyExecutor: unexpected,
      withSelectedAccount: unexpected
    });
    const op = stoppedSetup();
    op.providerRecovery = { state: "rollback_pending" };
    operations.put(op);
    const persist = vi
      .spyOn(operations, "persist")
      .mockResolvedValue(undefined);
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(unexpected);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = createTestCanvasServerRuntime({
      executionOwner: createEnvironmentExecutionOwner(),
      accountContext
    });
    expect(runtime.servers.size).toBe(0);
    expect(persist).not.toHaveBeenCalled();
    expect(op.control.commands).toEqual([]);
    const rollback = await runtime.operationControl({
      instanceId: "detached",
      operationId: op.operationId,
      command: "rollback"
    });
    expect(rollback).toMatchObject({
      status: 503,
      body: { code: "operation-command-unscheduled" }
    });
    expect(op.state).toBe("cancelled");
    expect(op.control.commands).toEqual([]);

    const pending = createOperation({
      operationId: "headless-input",
      repo: "fixture/app",
      environment: "dev",
      provider: "azure"
    });
    pending.request = { azure: {} };
    requireInput(pending, {
      code: "app-selection-required",
      checkpoint: "selection"
    });
    operations.put(pending);
    const resumed = await runtime.operationResume(
      {
        instanceId: "detached",
        operationId: pending.operationId,
        code: "app-selection-required"
      },
      async () => ({
        repo: "fixture/app",
        environment: "dev",
        provider: "azure",
        checkpoint: "selection",
        appId: "chosen-app"
      })
    );
    expect(resumed).toMatchObject({
      status: 409,
      body: { code: "operation-resume-mismatch" }
    });
    expect(pending.request.azure.appId).toBeUndefined();
    expect(pending.inputRequired?.code).toBe("app-selection-required");
    expect(pending.failure).toBeNull();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
    expect(runtime.servers.size).toBe(0);
  });
});
