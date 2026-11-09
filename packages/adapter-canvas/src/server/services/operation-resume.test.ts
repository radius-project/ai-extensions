import { afterEach, describe, expect, it, vi } from "vitest";
import { createEnvironmentExecutionOwner } from "../../runtime/environment-execution-owner.js";
import { createDeferred } from "../../../test/support/browser/fakes.js";
import {
  canResumeInput,
  createOperation,
  createRegistry,
  finish,
  requireInput,
  resumeAfterInput,
  requestStop,
  toClientView
} from "../../operations.js";
import type { OperationActionRecord } from "../routes/operations-status.js";
import {
  createOperationResumeService,
  type OperationResumeDependencies
} from "./operation-resume.js";
import { createOperationsControlService } from "./operation-control.js";

afterEach(() => vi.restoreAllMocks());

function fixture(overrides: Partial<OperationResumeDependencies> = {}) {
  const operation: OperationActionRecord = createOperation({
    operationId: "resume-fixture",
    provider: "azure",
    repo: "fixture/app",
    environment: "dev"
  });
  operation.request = { azure: {} };
  const input = {
    operationId: operation.operationId,
    instanceId: "runtime-adapter",
    code: "app-selection-required"
  };
  requireInput(operation, { code: input.code, checkpoint: "saved-prompt" });
  const dependencies: OperationResumeDependencies = {
    claimAdmission: createEnvironmentExecutionOwner().claimAdmission,
    getOperation: vi.fn((id) =>
      id === operation.operationId ? operation : null
    ),
    canResumeInput,
    resumeAfterInput,
    requireInput,
    finish,
    toClientView,
    persistOperations: vi.fn(async () => {}),
    scheduleEnvironmentOperation: vi.fn(() => true),
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error),
    ...overrides
  };
  const readInput = vi.fn(async () => ({
    repo: "fixture/app",
    environment: "dev",
    provider: "azure",
    checkpoint: "saved-prompt",
    appId: "chosen-app",
    createNew: false
  }));
  return { operation, dependencies, input, readInput };
}

function composeControls(
  dependencies: OperationResumeDependencies,
  resume = createOperationResumeService(dependencies)
) {
  const control = createOperationsControlService({
    stopPendingResume: resume.stopPendingResume,
    claimAdmission: dependencies.claimAdmission,
    get: (id) => dependencies.getOperation(id) ?? null,
    acquireForRetry: () => {
      throw new Error("Stop must not reacquire ownership");
    },
    persistOperations: dependencies.persistOperations,
    reportOperationDiagnostic: vi.fn(),
    checkPullRequestMerge: async () => {
      throw new Error("Unexpected merge read");
    },
    inspectVerificationWorkflow: async () => {
      throw new Error("Unexpected workflow read");
    },
    cancelVerificationWorkflow: async () => {
      throw new Error("Unexpected workflow cancellation");
    },
    schedule: () => {
      throw new Error("Stop must not schedule work");
    },
    invalidateEnvironmentListing: () => {},
    awsEnabled: true,
    removeAwsDeployIdentityLock: async () => {
      throw new Error("Unexpected AWS lock removal");
    }
  });
  return { resume, control };
}

describe("direct operation input continuation", () => {
  it("uses normal prompt Stop while correcting a rejected resume save", async () => {
    const entered = createDeferred<void>();
    const held = createDeferred<void>();
    let writes = 0;
    let saved: unknown;
    const f = fixture();
    f.operation.operationId = f.input.operationId =
      "op_11111111-1111-4111-8111-111111111111";
    const registry = createRegistry({
      store: {
        load: async () => null,
        save: async (envelope) => {
          const write = ++writes;
          if (write === 1) throw new Error("initial save failed");
          if (write === 2) {
            entered.resolve();
            await held.promise;
          }
          saved = structuredClone(envelope);
        }
      }
    });
    registry.put(f.operation);
    f.dependencies.persistOperations = () => registry.persist();
    const services = composeControls(f.dependencies);
    const pending = services.resume(f.input, f.readInput);
    await entered.promise;
    const stop = services.control({
      operationId: f.input.operationId,
      command: "stop"
    });
    await vi.waitFor(() => expect(f.operation.state).toBe("cancelled"));
    held.resolve();
    expect(await stop).toMatchObject({
      status: 200,
      body: { code: "operation-stopped" }
    });
    expect(await pending).toMatchObject({
      status: 500,
      body: { code: "operation-resume-persist-failed" }
    });
    expect(f.operation.state).toBe("cancelled");
    expect(f.dependencies.scheduleEnvironmentOperation).not.toHaveBeenCalled();
    expect(saved).toMatchObject({ operations: [{ state: "cancelled" }] });
  });

  it("durably stops an unstarted resume when the real control accepts Stop during its save", async () => {
    const owner = createEnvironmentExecutionOwner();
    const entered = createDeferred<void>();
    const held = createDeferred<void>();
    let writes = 0;
    let saved: unknown;
    const { operation, dependencies, input, readInput } = fixture({
      claimAdmission: owner.claimAdmission,
      persistOperations: vi.fn(async () => {
        const snapshot = structuredClone(operation);
        if (++writes === 1) {
          entered.resolve();
          await held.promise;
        }
        saved = snapshot;
      })
    });
    const services = composeControls(dependencies);
    const resume = services.resume(input, readInput);
    await entered.promise;
    const stop = services.control({
      operationId: input.operationId,
      command: "stop"
    });
    await vi.waitFor(() => expect(operation.stopRequested).toBe(true));
    held.resolve();
    expect(await stop).toMatchObject({
      status: 200,
      body: { code: "operation-stopped" }
    });
    expect(await resume).toMatchObject({
      status: 200,
      body: { code: "operation-stopped" }
    });
    expect(operation).toMatchObject({
      state: "cancelled",
      inputRequired: null,
      control: { stop: { boundary: "input_resume" } }
    });
    expect(saved).toEqual(operation);
    expect(dependencies.scheduleEnvironmentOperation).not.toHaveBeenCalled();
    const next = owner.claimAdmission(input.operationId);
    expect(next).not.toBeNull();
    next?.release();
  });

  it.each([
    { initialFails: false, correctionFails: false },
    { initialFails: true, correctionFails: false },
    { initialFails: false, correctionFails: true },
    { initialFails: true, correctionFails: true }
  ])(
    "shares durable Stop outcome without restoring a prompt (initialFails=$initialFails, correctionFails=$correctionFails)",
    async ({ initialFails, correctionFails }) => {
      const owner = createEnvironmentExecutionOwner();
      const f = fixture({ claimAdmission: owner.claimAdmission });
      f.operation.operationId = f.input.operationId =
        "op_11111111-1111-4111-8111-111111111111";
      f.operation.context = { githubLogin: "selected-account" };
      const entered = createDeferred<void>();
      const held = createDeferred<void>();
      const correcting = createDeferred<void>();
      const correction = createDeferred<void>();
      let writes = 0;
      let bytes = "";
      const registry = createRegistry({
        store: {
          load: async () => null,
          save: async (envelope) => {
            writes++;
            if (writes === 1) {
              entered.resolve();
              await held.promise;
            } else {
              correcting.resolve();
              await correction.promise;
              if (correctionFails) throw new Error("stop settlement offline");
            }
            bytes = JSON.stringify(envelope);
            if (writes === 1 && initialFails)
              throw new Error("initial save rejected after writing");
          }
        }
      });
      registry.put(f.operation);
      f.dependencies.getOperation = (id) => registry.get(id);
      f.dependencies.persistOperations = () => registry.persist();
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const services = composeControls(f.dependencies);
      const pending = services.resume(f.input, f.readInput);
      await entered.promise;
      const stop = services.control({
        operationId: f.input.operationId,
        command: "stop"
      });
      await vi.waitFor(() => expect(f.operation.stopRequested).toBe(true));
      const duplicate = composeControls(
        f.dependencies,
        services.resume
      ).control({
        operationId: f.input.operationId,
        command: "stop"
      });
      let stopResponded = false;
      void stop.then(() => {
        stopResponded = true;
      });
      held.resolve();
      await correcting.promise;
      expect(stopResponded).toBe(false);
      expect(f.operation.state).toBe("cancelled");
      correction.resolve();
      const result = await pending;
      expect(result).toMatchObject({
        status: correctionFails ? 500 : 200,
        body: {
          code:
            correctionFails ?
              "operation-resume-stop-persist-failed"
            : "operation-stopped"
        }
      });
      expect(await stop).toEqual(result);
      expect(await duplicate).toMatchObject({
        status: result.status,
        body: { code: result.body.code }
      });
      expect(f.operation.context).toEqual({ githubLogin: "selected-account" });
      expect(f.operation.inputRequired).toBeNull();
      expect(
        f.dependencies.scheduleEnvironmentOperation
      ).not.toHaveBeenCalled();
      expect(writes).toBe(2);
      if (correctionFails) {
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining("operation-resume-stop-persist-failed")
        );
        expect(owner.claimAdmission(f.input.operationId)).toBeNull();
        expect(JSON.parse(bytes).operations[0].state).toBe("running");
        expect(
          await services.control({
            operationId: f.input.operationId,
            command: "stop"
          })
        ).toMatchObject({
          status: 500,
          body: { code: "operation-resume-stop-persist-failed" }
        });
      } else {
        expect(log).not.toHaveBeenCalled();
        expect(JSON.parse(bytes).operations[0]).toMatchObject({
          state: "cancelled",
          control: { stop: { boundary: "input_resume" } }
        });
        const admission = owner.claimAdmission(f.input.operationId);
        expect(admission).not.toBeNull();
        admission?.release();
      }
    }
  );

  it.each([
    "replacement",
    "repository",
    "account",
    "prompt",
    "task",
    "shutdown"
  ] as const)(
    "does not overwrite %s while an unstarted Stop awaits resume persistence",
    async (change) => {
      const owner = createEnvironmentExecutionOwner();
      const entered = createDeferred<void>();
      const held = createDeferred<void>();
      const task = createDeferred<void>();
      const settled = createDeferred<void>();
      let shutdown = false;
      const f = fixture({
        claimAdmission: owner.claimAdmission,
        isShuttingDown: () => shutdown,
        persistOperations: vi.fn(async () => {
          entered.resolve();
          await held.promise;
        })
      });
      let current = f.operation;
      f.dependencies.getOperation = () => current;
      const services = composeControls(f.dependencies);
      const pending = services.resume(f.input, f.readInput);
      await entered.promise;
      const stop = services.control({
        operationId: f.input.operationId,
        command: "stop"
      });
      await vi.waitFor(() => expect(f.operation.stopRequested).toBe(true));
      if (change === "replacement") current = structuredClone(f.operation);
      if (change === "repository") f.operation.repo = "other/app";
      if (change === "account")
        f.operation.context = { githubLogin: "replacement" };
      if (change === "prompt")
        requireInput(f.operation, {
          code: "app-selection-required",
          checkpoint: "new"
        });
      if (change === "task")
        owner.attach("competing").schedule(f.input.operationId, {
          run: () => task.promise,
          failed: async () => {
            throw new Error("Unexpected task failure");
          },
          settling: () => {},
          settled: () => settled.resolve()
        });
      if (change === "shutdown") shutdown = true;
      const before = structuredClone(current);
      held.resolve();
      try {
        const result = await pending;
        expect(result).toMatchObject({
          status: change === "shutdown" ? 200 : 409,
          body: {
            code:
              change === "shutdown" ? "operation-stopped" : (
                "operation-resume-mismatch"
              )
          }
        });
        expect(await stop).toEqual(result);
        if (change === "shutdown") expect(current.state).toBe("cancelled");
        else expect(current).toEqual(before);
        expect(
          f.dependencies.scheduleEnvironmentOperation
        ).not.toHaveBeenCalled();
        expect(f.dependencies.persistOperations).toHaveBeenCalledTimes(
          change === "shutdown" ? 2 : 1
        );
      } finally {
        task.resolve();
        if (change === "task") await settled.promise;
      }
    }
  );

  it.each(["input", "after-save", "scheduled"] as const)(
    "preserves cooperative Stop at the %s boundary",
    async (phase) => {
      const entered = createDeferred<void>();
      const held = createDeferred<void>();
      const f = fixture();
      const read = f.readInput;
      const readInput = async () => {
        if (phase === "input") {
          entered.resolve();
          await held.promise;
        }
        return read();
      };
      f.dependencies.persistOperations = vi.fn(async () => {
        if (phase === "after-save") {
          entered.resolve();
          await held.promise;
        }
      });
      const services = composeControls(f.dependencies);
      const pending = services.resume(f.input, readInput);
      if (phase === "scheduled") await pending;
      else await entered.promise;
      const stop = services.control({
        operationId: f.input.operationId,
        command: "stop"
      });
      await vi.waitFor(() => expect(f.operation.stopRequested).toBe(true));
      held.resolve();
      const result = await stop;
      expect(result.status).toBe(phase === "scheduled" ? 202 : 200);
      expect((await pending).status).toBe(
        phase === "input" ? 409
        : phase === "after-save" ? 200
        : 202
      );
      expect(f.dependencies.scheduleEnvironmentOperation).toHaveBeenCalledTimes(
        phase === "scheduled" ? 1 : 0
      );
    }
  );

  it.each(["account", "task"] as const)(
    "does not claim the pending resume's Stop after a competing %s changes ownership",
    async (change) => {
      const owner = createEnvironmentExecutionOwner();
      const entered = createDeferred<void>();
      const held = createDeferred<void>();
      const task = createDeferred<void>();
      const settled = createDeferred<void>();
      const f = fixture({
        claimAdmission: owner.claimAdmission,
        persistOperations: vi.fn(async () => {
          entered.resolve();
          await held.promise;
        })
      });
      const services = composeControls(f.dependencies);
      const pending = services.resume(f.input, f.readInput);
      await entered.promise;
      if (change === "account")
        f.operation.context = { githubLogin: "new-account" };
      else
        owner.attach("competing").schedule(f.input.operationId, {
          run: () => task.promise,
          failed: async () => {
            throw new Error("Unexpected task failure");
          },
          settling: () => {},
          settled: () => settled.resolve()
        });
      const stop = services.control({
        operationId: f.input.operationId,
        command: "stop"
      });
      if (change === "account") {
        expect(await stop).toMatchObject({ status: 409 });
        expect(f.operation.stopRequested).toBe(false);
      } else {
        await vi.waitFor(() => expect(f.operation.stopRequested).toBe(true));
      }
      held.resolve();
      try {
        expect((await stop).status).toBe(change === "account" ? 409 : 202);
        expect(await pending).toMatchObject({ status: 409 });
        expect(
          f.dependencies.scheduleEnvironmentOperation
        ).not.toHaveBeenCalled();
        expect(f.operation.state).toBe("running");
      } finally {
        task.resolve();
        if (change === "task") await settled.promise;
      }
    }
  );

  it.each(["replacement", "task", "response", "projection"] as const)(
    "preserves the saved Stop through a late %s change during settlement",
    async (change) => {
      const owner = createEnvironmentExecutionOwner();
      const entered = createDeferred<void>();
      const held = createDeferred<void>();
      const correcting = createDeferred<void>();
      const correction = createDeferred<void>();
      const task = createDeferred<void>();
      const settled = createDeferred<void>();
      let writes = 0;
      let saved: unknown;
      const f = fixture({
        claimAdmission: owner.claimAdmission,
        persistOperations: vi.fn(async () => {
          if (++writes === 1) {
            entered.resolve();
            await held.promise;
          } else {
            saved = structuredClone(f.operation);
            correcting.resolve();
            await correction.promise;
          }
        })
      });
      let current = f.operation;
      f.dependencies.getOperation = () => current;
      if (change === "projection")
        f.dependencies.toClientView = () => {
          throw new Error("projection failed");
        };
      const services = composeControls(f.dependencies);
      const pending = services.resume(f.input, f.readInput, () => {
        if (change === "response") throw new Error("client disconnected");
      });
      const outcome = pending.then(
        (value) => value,
        (error: unknown) => error
      );
      await entered.promise;
      const stop = services.control({
        operationId: f.input.operationId,
        command: "stop"
      });
      const stopOutcome = stop.then(
        (value) => value,
        (error: unknown) => error
      );
      await vi.waitFor(() => expect(f.operation.stopRequested).toBe(true));
      held.resolve();
      await correcting.promise;
      if (change === "replacement")
        current = { ...structuredClone(f.operation), repo: "other/app" };
      if (change === "task")
        owner.attach("competing").schedule(f.input.operationId, {
          run: () => task.promise,
          failed: async () => {
            throw new Error("Unexpected task failure");
          },
          settling: () => {},
          settled: () => settled.resolve()
        });
      const before = structuredClone(current);
      correction.resolve();
      try {
        if (change === "response")
          expect(await outcome).toEqual(new Error("client disconnected"));
        else if (change === "projection")
          expect(await outcome).toEqual(new Error("projection failed"));
        else expect(await outcome).toMatchObject({ status: 409 });
        if (change === "projection")
          expect(await stopOutcome).toEqual(new Error("projection failed"));
        else
          expect(await stopOutcome).toMatchObject({
            status: change === "response" ? 200 : 409
          });
        expect(current).toEqual(before);
        expect(saved).toMatchObject({ state: "cancelled" });
        expect(
          f.dependencies.scheduleEnvironmentOperation
        ).not.toHaveBeenCalled();
      } finally {
        task.resolve();
        if (change === "task") await settled.promise;
      }
    }
  );

  it.each([false, true])(
    "refuses competing admission and unsettled tasks before reading an answer (publish=%s)",
    async (publishing) => {
      const owner = createEnvironmentExecutionOwner();
      const { operation, dependencies, input, readInput } = fixture({
        claimAdmission: owner.claimAdmission
      });
      const service = createOperationResumeService(dependencies);
      const publish = publishing ? vi.fn() : undefined;
      const claim = owner.claimAdmission(operation.operationId);
      expect(await service(input, readInput, publish)).toMatchObject({
        status: 409,
        body: { code: "operation-resume-mismatch" }
      });
      claim?.release();
      const gate = createDeferred<void>();
      const settled = createDeferred<void>();
      owner.attach("panel").schedule(operation.operationId, {
        run: () => gate.promise,
        failed: async () => {
          throw new Error("Unexpected task failure");
        },
        settling: () => {},
        settled: () => settled.resolve()
      });
      try {
        expect(await service(input, readInput, publish)).toMatchObject({
          status: 409,
          body: { code: "operation-task-busy" }
        });
        expect(readInput).not.toHaveBeenCalled();
        expect(dependencies.persistOperations).not.toHaveBeenCalled();
        if (publish) expect(publish).toHaveBeenCalledTimes(2);
      } finally {
        gate.resolve();
        await settled.promise;
      }
      expect(await service(input, readInput)).toMatchObject({ status: 202 });
    }
  );
  it.each(["save", "save-rejection", "correction-rejection"] as const)(
    "durably restores only the owned resume when authority is lost during %s",
    async (failure) => {
      const owner = createEnvironmentExecutionOwner();
      const { operation, dependencies, input, readInput } = fixture({
        claimAdmission: owner.claimAdmission
      });
      operation.operationId = input.operationId =
        "op_11111111-1111-4111-8111-111111111111";
      operation.resumeRequest = { azure: { appId: "old" } };
      const before = structuredClone(operation);
      const entered = createDeferred<void>();
      const held = createDeferred<void>();
      let current = true;
      let bytes = "";
      let writes = 0;
      const registry = createRegistry({
        store: {
          load: async () => null,
          save: async (envelope) => {
            writes++;
            if (writes === 1) {
              entered.resolve();
              await held.promise;
            } else if (failure === "correction-rejection") {
              throw new Error("correction offline");
            }
            bytes = JSON.stringify(envelope);
            if (writes === 1 && failure === "save-rejection")
              throw new Error("write completed before rejection");
          }
        }
      });
      registry.put(operation);
      dependencies.getOperation = (id) => registry.get(id);
      dependencies.persistOperations = () => registry.persist();
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const service = createOperationResumeService(dependencies);
      const pending = service(
        { ...input, isCurrent: () => current },
        readInput
      );
      await Promise.race([
        entered.promise,
        pending.then((result) => {
          throw new Error(
            `Resume returned before saving: ${JSON.stringify(result)}`
          );
        })
      ]);
      current = false;
      held.resolve();
      expect(await pending).toMatchObject({
        status: failure === "correction-rejection" ? 500 : 409,
        body: {
          code:
            failure === "correction-rejection" ?
              "operation-resume-recovery-persist-failed"
            : "operation-resume-mismatch"
        }
      });
      expect(operation).toEqual(before);
      expect(writes).toBe(2);
      expect(dependencies.scheduleEnvironmentOperation).not.toHaveBeenCalled();
      if (failure === "correction-rejection") {
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining("operation-resume-recovery-persist-failed")
        );
        expect(owner.claimAdmission(operation.operationId)).toBeNull();
      } else {
        expect(JSON.parse(bytes).operations[0]).toMatchObject({
          state: "input_required",
          inputRequired: before.inputRequired
        });
        expect(await service(input, readInput)).toMatchObject({ status: 202 });
      }
    }
  );

  it.each(["prompt", "task"] as const)(
    "does not schedule or overwrite a competing %s after a held resume save",
    async (change) => {
      const owner = createEnvironmentExecutionOwner();
      const entered = createDeferred<void>();
      const held = createDeferred<void>();
      const taskGate = createDeferred<void>();
      const settled = createDeferred<void>();
      const { operation, dependencies, input, readInput } = fixture({
        claimAdmission: owner.claimAdmission,
        persistOperations: vi.fn(async () => {
          entered.resolve();
          await held.promise;
        })
      });
      const pending = createOperationResumeService(dependencies)(
        input,
        readInput
      );
      await entered.promise;
      if (change === "prompt") {
        requireInput(operation, {
          code: "service-management-reference-required",
          checkpoint: "new"
        });
      } else {
        owner.attach("other").schedule(operation.operationId, {
          run: () => taskGate.promise,
          failed: async () => {
            throw new Error("Unexpected task failure");
          },
          settling: () => {},
          settled: () => settled.resolve()
        });
      }
      const competing = structuredClone(operation);
      held.resolve();
      try {
        expect(await pending).toMatchObject({
          status: 409,
          body: { code: "operation-resume-mismatch" }
        });
        expect(operation).toEqual(competing);
        expect(dependencies.persistOperations).toHaveBeenCalledOnce();
        expect(
          dependencies.scheduleEnvironmentOperation
        ).not.toHaveBeenCalled();
      } finally {
        taskGate.resolve();
        if (change === "task") await settled.promise;
      }
    }
  );

  describe.each(["input", "persist", "persist-rejection"] as const)(
    "identity changes during %s",
    (phase) => {
      it.each([
        "removed",
        "replaced",
        "id",
        "repository",
        "environment"
      ] as const)(
        "rejects a %s operation without publishing acceptance or touching the new target",
        async (change) => {
          const entered = createDeferred<void>();
          const held = createDeferred<void>();
          const { operation, dependencies, input, readInput } = fixture();
          let current: OperationActionRecord | undefined = operation;
          dependencies.getOperation = () => current;
          dependencies.persistOperations = vi.fn(async () => {
            if (phase !== "input") {
              entered.resolve();
              await held.promise;
              if (phase === "persist-rejection")
                throw new Error("store offline");
            }
          });
          const publish = vi.fn();
          const pending = createOperationResumeService(dependencies)(
            input,
            async () => {
              if (phase === "input") {
                entered.resolve();
                await held.promise;
              }
              return readInput();
            },
            publish
          );
          try {
            await entered.promise;
            if (change === "removed") current = undefined;
            else if (change === "replaced")
              current = structuredClone(operation);
            else if (change === "id") operation.operationId = "replacement-id";
            else if (change === "repository") operation.repo = "other/repo";
            else operation.environment = "production";
            const originalBefore = structuredClone(operation);
            const currentBefore = structuredClone(current);
            held.resolve();
            const result = await pending;
            expect(result).toMatchObject({
              status: 409,
              body: {
                code: "operation-resume-mismatch",
                operationId: input.operationId
              }
            });
            expect(publish).toHaveBeenCalledExactlyOnceWith(result);
            expect(operation).toEqual(originalBefore);
            expect(current).toEqual(currentBefore);
            expect(dependencies.persistOperations).toHaveBeenCalledTimes(
              phase === "input" ? 0 : 1
            );
            expect(
              dependencies.scheduleEnvironmentOperation
            ).not.toHaveBeenCalled();
          } finally {
            held.resolve();
            await pending;
          }
        }
      );
    }
  );

  it("reports shutdown without terminalizing a durably resumed operation", async () => {
    let shuttingDown = false;
    const { operation, dependencies, input, readInput } = fixture({
      isShuttingDown: () => shuttingDown,
      persistOperations: vi.fn(async () => {
        shuttingDown = true;
      })
    });
    const publish = vi.fn();
    const result = await createOperationResumeService(dependencies)(
      input,
      readInput,
      publish
    );
    expect(result).toMatchObject({
      status: 503,
      body: { code: "operation-shutting-down" }
    });
    expect(publish).toHaveBeenCalledExactlyOnceWith(result);
    expect(operation.endedAt).toBeNull();
    expect(operation.failure).toBeNull();
    expect(operation.request?.azure.appId).toBe("chosen-app");
    expect(dependencies.scheduleEnvironmentOperation).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "resumes without a panel and records scheduling refusal when accepted=%s",
    async (scheduled) => {
      const { operation, dependencies, input, readInput } = fixture({
        scheduleEnvironmentOperation: vi.fn(() => scheduled)
      });
      const result = await createOperationResumeService(dependencies)(
        { operationId: input.operationId, code: input.code },
        readInput
      );
      expect(result.status).toBe(202);
      expect(
        dependencies.scheduleEnvironmentOperation
      ).toHaveBeenCalledExactlyOnceWith(undefined, operation);
      expect(operation.request?.azure.appId).toBe("chosen-app");
      if (scheduled) expect(operation.state).not.toBe("failed");
      else
        expect(operation.failure).toMatchObject({
          code: "operation-scheduling-failed",
          evidence: "No runtime setup task runner was available."
        });
    }
  );

  it.each([
    "getOperation",
    "claimAdmission",
    "canResumeInput",
    "resumeAfterInput",
    "requireInput",
    "persistOperations",
    "toClientView",
    "finish",
    "scheduleEnvironmentOperation",
    "errorMessage"
  ] as const)("requires the %s binding before accepting work", (name) => {
    const { dependencies } = fixture();
    Reflect.deleteProperty(dependencies, name);
    expect(() => createOperationResumeService(dependencies)).toThrow(
      `Missing operation resume dependency: ${name}`
    );
  });

  it("constructs without looking up or advancing saved work", () => {
    const { dependencies } = fixture();
    createOperationResumeService(dependencies);
    expect(dependencies.getOperation).not.toHaveBeenCalled();
    expect(dependencies.persistOperations).not.toHaveBeenCalled();
    expect(dependencies.scheduleEnvironmentOperation).not.toHaveBeenCalled();
  });

  it("continues the real operation with the tied input and rejects reuse", async () => {
    const { operation, dependencies, input, readInput } = fixture();
    const service = createOperationResumeService(dependencies);
    const publish = vi.fn();
    const result = await service(input, readInput, publish);
    expect(result).toEqual({
      status: 202,
      body: {
        operationId: input.operationId,
        statusUrl: "/api/operations/resume-fixture"
      }
    });
    expect(publish).toHaveBeenCalledExactlyOnceWith(result);
    expect(operation.request?.azure.appId).toBe("chosen-app");
    expect(operation.inputRequired).toBeNull();
    expect(
      dependencies.scheduleEnvironmentOperation
    ).toHaveBeenCalledExactlyOnceWith("runtime-adapter", operation);
    expect(await service(input, readInput)).toMatchObject({
      status: 409,
      body: { code: "operation-resume-mismatch" }
    });
    expect(dependencies.scheduleEnvironmentOperation).toHaveBeenCalledOnce();
  });

  it("honors a saved Stop while the answer is being collected", async () => {
    const { operation, dependencies, input, readInput } = fixture();
    const result = await createOperationResumeService(dependencies)(
      input,
      async () => {
        requestStop(operation);
        return readInput();
      }
    );
    expect(result).toMatchObject({
      status: 409,
      body: { code: "operation-resume-mismatch" }
    });
    expect(dependencies.persistOperations).not.toHaveBeenCalled();
    expect(dependencies.scheduleEnvironmentOperation).not.toHaveBeenCalled();
  });

  it("restores the original prompt and answer fields after a failed save", async () => {
    const { operation, dependencies, input, readInput } = fixture({
      persistOperations: vi
        .fn()
        .mockRejectedValueOnce(new Error("store offline"))
        .mockResolvedValue(undefined)
    });
    const result = await createOperationResumeService(dependencies)(
      input,
      readInput
    );
    expect(result).toMatchObject({
      status: 500,
      body: { code: "operation-resume-persist-failed" }
    });
    expect(operation.state).toBe("input_required");
    expect(operation.inputRequired).toMatchObject({
      code: input.code,
      checkpoint: "saved-prompt"
    });
    expect(operation.request?.azure).toEqual({});
    expect(dependencies.scheduleEnvironmentOperation).not.toHaveBeenCalled();
  });

  it("reports a failed recovery checkpoint while retaining the unscheduled terminal record", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { operation, dependencies, input, readInput } = fixture({
      scheduleEnvironmentOperation: () => false,
      persistOperations: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("repair offline"))
    });
    expect(
      await createOperationResumeService(dependencies)(input, readInput)
    ).toMatchObject({ status: 202 });
    expect(operation.state).toBe("failed");
    expect(operation.failure?.code).toBe("operation-scheduling-failed");
    expect(log).toHaveBeenCalledExactlyOnceWith(
      "[radius operation-scheduling] Could not persist the scheduling failure: repair offline"
    );
  });
});
