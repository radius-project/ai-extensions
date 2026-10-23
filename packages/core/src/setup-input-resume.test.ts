import { describe, expect, it, vi } from "vitest";
import {
  resumeSetupInput,
  type SetupResumeOperation,
  type SetupInputResumePorts
} from "./setup-input-resume.js";

const selectionCode = "app-selection-required";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(
  overrides: Partial<SetupInputResumePorts<SetupResumeOperation>> = {}
) {
  const operation: SetupResumeOperation = {
    state: "input_required",
    inputRequired: { code: selectionCode, checkpoint: "saved-checkpoint" },
    request: { azure: {} }
  };
  const ports: SetupInputResumePorts<SetupResumeOperation> = {
    isCurrent: () => true,
    readInput: vi.fn(async () => ({
      checkpoint: "saved-checkpoint",
      repo: "fixture/repo",
      environment: "dev",
      provider: "azure",
      appId: "chosen-app",
      createNew: true
    })),
    canResumeInput: vi.fn(() => true),
    resumeAfterInput: vi.fn((current) => {
      current.state = "running";
      current.inputRequired = null;
    }),
    requireInput: vi.fn((current, input) => {
      current.state = "input_required";
      current.inputRequired = input;
    }),
    persist: vi.fn(async () => {}),
    accepted: vi.fn(),
    schedule: vi.fn(() => true),
    schedulingFailed: vi.fn(async () => {}),
    ...overrides
  };
  return { operation, ports };
}

describe("setup input continuation", () => {
  it.each(["input", "persist", "persist-rejection"] as const)(
    "refuses stale work after %s without later mutation, restoration or scheduling",
    async (phase) => {
      const entered = deferred();
      const held = deferred();
      let current = true;
      const { operation, ports } = fixture({ isCurrent: () => current });
      const readInput = ports.readInput;
      ports.readInput = async () => {
        if (phase === "input") {
          entered.resolve();
          await held.promise;
        }
        return readInput();
      };
      ports.persist = vi.fn(async () => {
        if (phase !== "input") {
          entered.resolve();
          await held.promise;
          if (phase === "persist-rejection") throw new Error("store offline");
        }
      });
      const pending = resumeSetupInput(operation, selectionCode, ports);
      try {
        await entered.promise;
        current = false;
        const before = structuredClone(operation);
        held.resolve();
        expect(await pending).toEqual({ state: "mismatch" });
        expect(operation).toEqual(before);
        expect(ports.requireInput).not.toHaveBeenCalled();
        expect(ports.accepted).not.toHaveBeenCalled();
        expect(ports.schedule).not.toHaveBeenCalled();
        expect(ports.schedulingFailed).not.toHaveBeenCalled();
        expect(ports.persist).toHaveBeenCalledTimes(phase === "input" ? 0 : 1);
      } finally {
        held.resolve();
        await pending;
      }
    }
  );

  it.each(["before", "input", "persist"] as const)(
    "does not fail the operation when shutdown occurs during %s",
    async (phase) => {
      let stopped = phase === "before";
      const { operation, ports } = fixture({ isStopped: () => stopped });
      const originalRead = ports.readInput;
      ports.readInput = vi.fn(async () => {
        const input = await originalRead();
        if (phase === "input") stopped = true;
        return input;
      });
      ports.persist = vi.fn(async () => {
        stopped = true;
      });
      expect(await resumeSetupInput(operation, selectionCode, ports)).toEqual({
        state: "stopped"
      });
      expect(ports.accepted).not.toHaveBeenCalled();
      expect(ports.schedule).not.toHaveBeenCalled();
      expect(ports.schedulingFailed).not.toHaveBeenCalled();
      expect(operation.state).toBe(
        phase === "persist" ? "running" : "input_required"
      );
      expect(ports.persist).toHaveBeenCalledTimes(phase === "persist" ? 1 : 0);
    }
  );

  it("validates the original prompt context before persisting and scheduling", async () => {
    const { operation, ports } = fixture();
    expect(await resumeSetupInput(operation, selectionCode, ports)).toEqual({
      state: "accepted"
    });
    expect(ports.canResumeInput).toHaveBeenCalledExactlyOnceWith(operation, {
      code: selectionCode,
      checkpoint: "saved-checkpoint",
      repo: "fixture/repo",
      environment: "dev",
      provider: "azure"
    });
    expect(operation.request?.azure).toEqual({
      appId: "chosen-app",
      createNew: true
    });
    expect(vi.mocked(ports.persist).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(ports.accepted).mock.invocationCallOrder[0]
    );
    expect(vi.mocked(ports.accepted).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(ports.schedule).mock.invocationCallOrder[0]
    );
    expect(ports.schedule).toHaveBeenCalledExactlyOnceWith(operation);
  });

  it.each([null, undefined])(
    "does not read input for missing work",
    async (operation) => {
      const { ports } = fixture();
      expect(await resumeSetupInput(operation, selectionCode, ports)).toEqual({
        state: "unknown"
      });
      expect(ports.readInput).not.toHaveBeenCalled();
    }
  );

  it("keeps an expired prompt expired without reading a replacement answer", async () => {
    const { operation, ports } = fixture();
    operation.state = "failed_partial";
    operation.failure = { code: "operation-input-expired" };
    expect(await resumeSetupInput(operation, selectionCode, ports)).toEqual({
      state: "expired",
      operation,
      message: undefined
    });
    expect(ports.readInput).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { code: "other-failure" }])(
    "refuses a changed operation without mutating its request",
    async (failure) => {
      const { operation, ports } = fixture({ canResumeInput: () => false });
      operation.state = "failed_partial";
      operation.failure = failure;
      const before = structuredClone(operation);
      expect(await resumeSetupInput(operation, selectionCode, ports)).toEqual({
        state: "mismatch"
      });
      expect(operation).toEqual(before);
      expect(ports.persist).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, null, {}, { azure: null }, { azure: "invalid" }])(
    "refuses missing or malformed saved requests",
    async (request) => {
      const { operation, ports } = fixture();
      Reflect.set(operation, "request", request);
      expect(await resumeSetupInput(operation, selectionCode, ports)).toEqual({
        state: "request-unavailable"
      });
      expect(ports.resumeAfterInput).not.toHaveBeenCalled();
      expect(ports.schedule).not.toHaveBeenCalled();
    }
  );

  it.each([true, false])(
    "restores legacy request data and records the explicit selection (create=%s)",
    async (create) => {
      const { operation, ports } = fixture({
        readInput: async () =>
          create ? { appId: "chosen", createNew: true } : {}
      });
      operation.resumeRequest = { azure: { appId: "old" } };
      Reflect.deleteProperty(operation, "request");
      expect(await resumeSetupInput(operation, selectionCode, ports)).toEqual({
        state: "accepted"
      });
      expect(operation.request?.azure).toEqual({
        appId: create ? "chosen" : "",
        createNew: create
      });
      expect(operation.resumeRequest.azure).toEqual(operation.request?.azure);
      expect(operation.request).not.toBe(operation.resumeRequest);
    }
  );

  it.each(["saved-reference", ""])(
    "applies the service-management reference to both saved requests",
    async (reference) => {
      const { operation, ports } = fixture({
        readInput: async () => ({ serviceManagementReference: reference })
      });
      operation.resumeRequest = { azure: {} };
      await resumeSetupInput(
        operation,
        "service-management-reference-required",
        ports
      );
      expect(operation.request?.azure.serviceManagementReference).toBe(
        reference
      );
      expect(operation.resumeRequest.azure.serviceManagementReference).toBe(
        reference
      );
    }
  );

  it("accepts a reference without requiring a legacy resume copy", async () => {
    const { operation, ports } = fixture({ readInput: async () => ({}) });
    await resumeSetupInput(
      operation,
      "service-management-reference-required",
      ports
    );
    expect(operation.request?.azure.serviceManagementReference).toBe("");
    expect(operation.resumeRequest).toBeUndefined();
  });

  it("refuses unsupported prompts before saving or scheduling", async () => {
    const { operation, ports } = fixture();
    expect(await resumeSetupInput(operation, "future-prompt", ports)).toEqual({
      state: "unsupported"
    });
    expect(ports.persist).not.toHaveBeenCalled();
    expect(ports.schedule).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "restores the input and request when saving fails (legacy=%s)",
    async (legacy) => {
      const error = new Error("save refused");
      const { operation, ports } = fixture({
        persist: async () => {
          throw error;
        }
      });
      if (legacy) operation.resumeRequest = { azure: { appId: "old" } };
      const before = structuredClone(operation);
      expect(await resumeSetupInput(operation, selectionCode, ports)).toEqual({
        state: "persist-failed",
        error
      });
      expect(operation).toEqual(before);
      expect(ports.accepted).not.toHaveBeenCalled();
      expect(ports.schedule).not.toHaveBeenCalled();
    }
  );

  it("retains acceptance but awaits explicit settlement if the runner refuses work", async () => {
    const { operation, ports } = fixture({ schedule: () => false });
    expect(await resumeSetupInput(operation, selectionCode, ports)).toEqual({
      state: "accepted"
    });
    expect(ports.accepted).toHaveBeenCalledOnce();
    expect(ports.schedulingFailed).toHaveBeenCalledExactlyOnceWith(operation);
  });

  it("propagates input read failures instead of accepting an empty response", async () => {
    const error = new Error("input unavailable");
    const { operation, ports } = fixture({
      readInput: async () => {
        throw error;
      }
    });
    await expect(
      resumeSetupInput(operation, selectionCode, ports)
    ).rejects.toBe(error);
    expect(ports.resumeAfterInput).not.toHaveBeenCalled();
  });
});
