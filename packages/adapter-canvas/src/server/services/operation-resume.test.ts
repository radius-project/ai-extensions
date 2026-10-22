import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canResumeInput,
  createOperation,
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
      persistOperations: async () => {
        throw new Error("store offline");
      }
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
