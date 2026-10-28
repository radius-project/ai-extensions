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

describe("direct operation input continuation", () => {
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
