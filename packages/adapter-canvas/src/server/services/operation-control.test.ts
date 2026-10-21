import { describe, expect, it, vi } from "vitest";
import {
  enterStage,
  finish,
  pauseForProviderRestart,
  STAGE_VERIFY,
  verificationWorkflowState
} from "../../operations.js";
import {
  createOperationsControlService,
  type OperationsControlDependencies
} from "./operation-control.js";
import {
  stoppedSetup,
  mergeHandoff,
  newOperation,
  reusedOnlyFailure
} from "../../../test/support/server/operation-fixtures.js";

function fixture(overrides: Partial<OperationsControlDependencies> = {}) {
  const operation = stoppedSetup();
  const dependencies: OperationsControlDependencies = {
    get: vi.fn((id) => (id === operation.operationId ? operation : null)),
    acquireForRetry: vi.fn<OperationsControlDependencies["acquireForRetry"]>(
      () => ({ ok: true })
    ),
    persistOperations: vi.fn(async () => {}),
    reportOperationDiagnostic: vi.fn(),
    checkPullRequestMerge: async () => {
      throw new Error("Unexpected merge proof");
    },
    inspectVerificationWorkflow: async () => {
      throw new Error("Unexpected workflow inspection");
    },
    cancelVerificationWorkflow: async () => {
      throw new Error("Unexpected workflow cancellation");
    },
    schedule: vi.fn(() => true),
    invalidateEnvironmentListing: vi.fn(),
    ...overrides
  };
  return {
    operation,
    dependencies,
    input: {
      instanceId: "runtime-adapter",
      operationId: operation.operationId,
      command: "rollback" as const
    }
  };
}

describe("direct operation control service", () => {
  it("refuses new controls after shutdown without reading or mutating the operation", async () => {
    const { operation, dependencies, input } = fixture({
      isShuttingDown: () => true
    });
    const before = structuredClone(operation);
    const publish = vi.fn();
    const result = await createOperationsControlService(dependencies)(
      input,
      publish
    );
    expect(result).toMatchObject({
      status: 503,
      body: { code: "operation-shutting-down" }
    });
    expect(publish).toHaveBeenCalledExactlyOnceWith(result);
    expect(dependencies.get).not.toHaveBeenCalled();
    expect(dependencies.persistOperations).not.toHaveBeenCalled();
    expect(operation).toEqual(before);
  });

  it.each(["continue", "rollback"] as const)(
    "leaves a saved %s command recoverable if shutdown wins persistence",
    async (command) => {
      let stopped = false;
      const { operation, dependencies, input } = fixture({
        isShuttingDown: () => stopped,
        persistOperations: vi.fn(async () => {
          stopped = true;
        })
      });
      const result = await createOperationsControlService(dependencies)({
        ...input,
        command
      });
      expect(result).toMatchObject({
        status: 503,
        body: { code: "operation-shutting-down" }
      });
      expect(operation.endedAt).toBeNull();
      expect(operation.failure).toBeNull();
      expect(operation.control.commands).toHaveLength(1);
      expect(operation.control.commands[0].state).not.toBe("finished");
      expect(dependencies.schedule).not.toHaveBeenCalled();
      expect(dependencies.persistOperations).toHaveBeenCalledOnce();
    }
  );

  it.each([undefined, null, "invalid", {}])(
    "refuses exact-run cancellation when saved verification identity is missing",
    async (verification) => {
      const { operation, dependencies, input } = fixture();
      operation.verification = verification;
      const result = await createOperationsControlService(dependencies)({
        ...input,
        command: "cancel-workflow"
      });
      expect(result).toMatchObject({
        status: 409,
        body: { code: "workflow-cancel-not-available" }
      });
      expect(dependencies.persistOperations).not.toHaveBeenCalled();
      expect(dependencies.schedule).not.toHaveBeenCalled();
    }
  );

  it("rejects cancellation for an unknown operation", async () => {
    const { dependencies, input } = fixture({ get: () => null });
    expect(
      await createOperationsControlService(dependencies)({
        ...input,
        command: "cancel-workflow"
      })
    ).toMatchObject({ status: 404, body: { code: "unknown-operation" } });
  });

  it("rejects a direct retry that does not identify its attempt kind", async () => {
    const { dependencies, input } = fixture();
    expect(
      await createOperationsControlService(dependencies)({
        ...input,
        command: "retry"
      })
    ).toMatchObject({ status: 400, body: { code: "unsupported-retry" } });
    expect(dependencies.schedule).not.toHaveBeenCalled();
  });

  it("refuses abandoning a verified environment", async () => {
    const operation = newOperation();
    finish(operation, "succeeded");
    const { dependencies, input } = fixture({ get: () => operation });
    expect(
      await createOperationsControlService(dependencies)({
        ...input,
        operationId: operation.operationId,
        command: "exit",
        abandon: true
      })
    ).toMatchObject({ status: 409, body: { code: "exit-environment-ready" } });
    expect(dependencies.schedule).not.toHaveBeenCalled();
  });

  it("surfaces an unavailable account even when its login cannot be recovered", async () => {
    const operation = mergeHandoff();
    const { dependencies, input } = fixture({
      get: () => operation,
      checkPullRequestMerge: async () => ({
        state: "unavailable",
        login: "",
        detail: "Account unavailable"
      })
    });
    expect(
      await createOperationsControlService(dependencies)({
        ...input,
        operationId: operation.operationId,
        command: "retry",
        retryKind: "verification"
      })
    ).toMatchObject({
      status: 409,
      body: {
        code: "verification-retry-github-account-unavailable",
        error: expect.stringContaining("the selected account")
      }
    });
    expect(dependencies.schedule).not.toHaveBeenCalled();
  });

  it("persists unknown workflow status after stopping an interrupted verification read", async () => {
    const operation = newOperation();
    operation.context = { githubLogin: "alice" };
    operation.resumeRequest = {
      environment: {
        repo: operation.repo,
        environment: "dev",
        provider: "azure"
      }
    };
    enterStage(operation, STAGE_VERIFY);
    operation.verification = {
      dispatchedAt: Date.now(),
      workflow: "verify.yml",
      ref: "topic",
      environment: "dev",
      runId: "42"
    };
    pauseForProviderRestart(operation);
    const { dependencies, input } = fixture({
      get: () => operation,
      inspectVerificationWorkflow: async () => {
        throw new Error("GitHub unavailable");
      }
    });
    expect(
      await createOperationsControlService(dependencies)({
        ...input,
        operationId: operation.operationId,
        command: "stop"
      })
    ).toMatchObject({
      status: 200,
      body: {
        code: "operation-stopped-workflow-status-unknown",
        detail: "GitHub unavailable"
      }
    });
    expect(operation.state).toBe("cancelled");
    expect(verificationWorkflowState(operation)).toBe("unknown");
    expect(dependencies.persistOperations).toHaveBeenCalledTimes(2);
  });

  it.each([
    "get",
    "acquireForRetry",
    "persistOperations",
    "reportOperationDiagnostic",
    "checkPullRequestMerge",
    "inspectVerificationWorkflow",
    "cancelVerificationWorkflow",
    "schedule",
    "invalidateEnvironmentListing"
  ] as const)(
    "requires %s without performing work during construction",
    (name) => {
      const { dependencies } = fixture();
      Reflect.deleteProperty(dependencies, name);
      expect(() => createOperationsControlService(dependencies)).toThrow(
        `Missing operation control dependency: ${name}`
      );
    }
  );

  it("constructs without reading records, saving, or scheduling recovery", () => {
    const { dependencies } = fixture();
    createOperationsControlService(dependencies);
    expect(dependencies.get).not.toHaveBeenCalled();
    expect(dependencies.persistOperations).not.toHaveBeenCalled();
    expect(dependencies.schedule).not.toHaveBeenCalled();
  });

  it("admits a ledger-proven rollback through the direct service and publishes the same response", async () => {
    const { operation, dependencies, input } = fixture();
    const service = createOperationsControlService(dependencies);
    const publish = vi.fn();
    const result = await service(input, publish);
    expect(result).toMatchObject({
      status: 202,
      body: {
        operationId: operation.operationId,
        commandId: expect.any(String),
        attempt: 1
      }
    });
    expect(publish).toHaveBeenCalledExactlyOnceWith(result);
    expect(dependencies.schedule).toHaveBeenCalledExactlyOnceWith({
      kind: "rollback",
      instanceId: "runtime-adapter",
      operation,
      commandId: result.body.commandId
    });
    expect(dependencies.persistOperations).toHaveBeenCalledOnce();
    expect(operation.control.commands).toEqual([
      expect.objectContaining({
        commandId: result.body.commandId,
        kind: "rollback",
        state: "running"
      })
    ]);
  });

  it("serializes concurrent subscribers and schedules only the saved command", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let saving = () => {};
    const entered = new Promise<void>((resolve) => {
      saving = resolve;
    });
    const { dependencies, input } = fixture({
      persistOperations: async () => {
        saving();
        await gate;
      }
    });
    const service = createOperationsControlService(dependencies);
    const first = service(input);
    await entered;
    const second = service({ ...input, instanceId: "another-subscriber" });
    expect(dependencies.get).toHaveBeenCalledOnce();
    expect(dependencies.schedule).not.toHaveBeenCalled();
    release();
    const [accepted, duplicate] = await Promise.all([first, second]);
    expect(duplicate).toMatchObject({
      status: 202,
      body: { commandId: accepted.body.commandId, duplicate: true }
    });
    expect(dependencies.schedule).toHaveBeenCalledOnce();
  });

  it("restores the saved decision when admission cannot be persisted", async () => {
    const { operation, dependencies, input } = fixture({
      persistOperations: async () => {
        throw new Error("disk offline");
      }
    });
    const before = structuredClone(operation);
    const result = await createOperationsControlService(dependencies)({
      ...input,
      operationId: operation.operationId
    });
    expect(result).toMatchObject({
      status: 500,
      body: {
        code: "operation-rollback-persist-failed",
        detail: "disk offline"
      }
    });
    expect(operation).toMatchObject(before);
    expect(dependencies.schedule).not.toHaveBeenCalled();
  });

  it("refuses rollback without removable ownership instead of calling a destructive runner", async () => {
    const operation = reusedOnlyFailure();
    const { dependencies, input } = fixture({ get: () => operation });
    const result = await createOperationsControlService(dependencies)({
      ...input,
      operationId: operation.operationId
    });
    expect(result).toMatchObject({
      status: 409,
      body: { code: "rollback-nothing-owned" }
    });
    expect(dependencies.persistOperations).not.toHaveBeenCalled();
    expect(dependencies.schedule).not.toHaveBeenCalled();
  });

  it("does not retain a rejected request as the next subscriber's result", async () => {
    const { operation, dependencies, input } = fixture();
    const failure = new Error("registry unavailable");
    dependencies.get = vi
      .fn()
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockReturnValue(operation);
    const service = createOperationsControlService(dependencies);
    const first = service(input);
    const second = service(input);
    await expect(first).rejects.toBe(failure);
    expect(await second).toMatchObject({ status: 202 });
    expect(dependencies.get).toHaveBeenCalledTimes(2);
    expect(dependencies.schedule).toHaveBeenCalledOnce();
  });

  it.each([
    { githubLogin: "another-account" },
    { githubLogin: 123 },
    {},
    null,
    undefined
  ])("rejects an account changed during merge proof", async (context) => {
    const operation = mergeHandoff();
    const { dependencies, input } = fixture({
      get: () => operation,
      checkPullRequestMerge: async () => {
        operation.context = context;
        return { state: "merged" };
      }
    });
    const result = await createOperationsControlService(dependencies)({
      ...input,
      operationId: operation.operationId,
      command: "retry",
      retryKind: "verification"
    });
    expect(result).toMatchObject({
      status: 409,
      body: { code: "operation-active" }
    });
    expect(dependencies.schedule).not.toHaveBeenCalled();
  });

  it("does not admit a detached record after the live operation is replaced", async () => {
    const operation = mergeHandoff();
    let current = operation;
    const { dependencies, input } = fixture({
      get: () => current,
      checkPullRequestMerge: async () => {
        current = structuredClone(operation);
        return { state: "merged" };
      }
    });
    const result = await createOperationsControlService(dependencies)({
      ...input,
      operationId: operation.operationId,
      command: "retry",
      retryKind: "verification"
    });
    expect(result).toMatchObject({
      status: 409,
      body: { code: "operation-active" }
    });
    expect(dependencies.schedule).not.toHaveBeenCalled();
    expect(current.control.commands).toEqual([]);
  });
});
