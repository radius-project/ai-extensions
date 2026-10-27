import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acceptCommand,
  createOperation,
  finish,
  prepareProviderMutation,
  STAGE_VERIFY
} from "../operations.js";
import { createEnvironmentExecutionOwner } from "./environment-execution-owner.js";
import {
  createSetupExecution,
  type SetupExecutionOperation,
  type SetupExecutionPorts
} from "./setup-execution.js";

function fixture() {
  const timers: Array<() => void> = [];
  const owner = createEnvironmentExecutionOwner({
    deferTask: async () => {},
    microtask: queueMicrotask,
    reconciliationTimer: (callback) => {
      timers.push(callback);
      return () => {
        const index = timers.indexOf(callback);
        if (index >= 0) timers.splice(index, 1);
      };
    }
  });
  const scope = owner.attachRuntime();
  const records = new Map<string, SetupExecutionOperation>();
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected setup execution");
  };
  const ports = {
    deferAdmissionRecovery: owner.deferAdmissionRecovery,
    scope,
    getOperation: vi.fn((id: string) => records.get(id)),
    persist: vi.fn(async () => {}),
    report: vi.fn<SetupExecutionPorts["report"]>(),
    isShuttingDown: scope.isShuttingDown,
    deferRecovery: queueMicrotask,
    admitRecoveryRollback:
      vi.fn<SetupExecutionPorts["admitRecoveryRollback"]>(unexpected),
    claimVerificationMonitor: vi.fn(owner.claimVerificationMonitor),
    runOperation: vi.fn<SetupExecutionPorts["runOperation"]>(unexpected),
    runVerificationRetry:
      vi.fn<SetupExecutionPorts["runVerificationRetry"]>(unexpected),
    runVerificationContinuation:
      vi.fn<SetupExecutionPorts["runVerificationContinuation"]>(unexpected),
    observeRecoveredVerification:
      vi.fn<SetupExecutionPorts["observeRecoveredVerification"]>(unexpected),
    runCleanup: vi.fn<SetupExecutionPorts["runCleanup"]>(unexpected),
    recoverBranchDelete:
      vi.fn<SetupExecutionPorts["recoverBranchDelete"]>(unexpected),
    recoverCleanup: vi.fn<SetupExecutionPorts["recoverCleanup"]>(unexpected)
  } satisfies SetupExecutionPorts;
  function operation() {
    const op = createOperation({
      operationId: "setup-runtime",
      provider: "azure",
      repo: "fixture/app",
      environment: "dev"
    });
    records.set(op.operationId, op);
    return op;
  }
  function settled() {
    return new Promise<void>((resolve) => {
      const stop = scope.onTasksSettled(() => {
        stop();
        resolve();
      });
    });
  }
  return { owner, ports, scope, records, timers, operation, settled };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runtime setup execution construction", () => {
  it.each(Object.keys(fixture().ports).filter((name) => name !== "scope"))(
    "rejects a missing %s binding before doing work",
    (name) => {
      const { ports } = fixture();
      const runner = ports.runOperation;
      Reflect.deleteProperty(ports, name);
      expect(() => createSetupExecution(ports)).toThrow(
        `Missing setup execution dependency: ${name}`
      );
      expect(runner).not.toHaveBeenCalled();
    }
  );

  it.each([
    "schedule",
    "hasTask",
    "scheduleReconciliation",
    "claimAutomaticRollback"
  ])("rejects a missing task-scope %s binding", (name) => {
    const { ports } = fixture();
    Reflect.deleteProperty(ports.scope, name);
    expect(() => createSetupExecution(ports)).toThrow(
      `Missing setup execution dependency: scope.${name}`
    );
  });

  it("rejects a missing task scope", () => {
    const { ports } = fixture();
    Reflect.deleteProperty(ports, "scope");
    expect(() => createSetupExecution(ports)).toThrow(
      "Missing setup execution dependency: scope.schedule"
    );
  });

  it("constructs without a panel, registry reads, recovery or credential work", () => {
    const { ports, scope, operation } = fixture();
    const op = operation();
    finish(op, "failed");
    op.providerRecovery = { state: "rollback_pending" };
    const before = structuredClone(op);
    const execution = createSetupExecution(ports);

    expect(scope.instanceId).toBeUndefined();
    expect(scope.hasActiveTasks()).toBe(false);
    expect(ports.getOperation).not.toHaveBeenCalled();
    expect(ports.persist).not.toHaveBeenCalled();
    expect(ports.admitRecoveryRollback).not.toHaveBeenCalled();
    expect(ports.claimVerificationMonitor).not.toHaveBeenCalled();
    expect(ports.runOperation).not.toHaveBeenCalled();
    expect(op).toEqual(before);
    expect(execution).toEqual({
      recoverOperation: expect.any(Function),
      scheduleEnvironmentOperation: expect.any(Function),
      scheduleCommandTask: expect.any(Function)
    });
  });
});

describe("runtime setup execution", () => {
  it.each(["current", "replaced", "removed", "shutdown"])(
    "re-evaluates only the deferred runtime admission when it is %s",
    async (change) => {
      const { owner, ports, records, operation, settled } = fixture();
      const op = operation();
      op.recoveryState = "provider_reconciliation_pending";
      const claim = owner.claimAdmission(op.operationId);
      if (!claim) throw new Error("Missing claim");
      ports.runOperation.mockResolvedValue(undefined);
      const execution = createSetupExecution(ports);
      execution.recoverOperation(op);
      execution.recoverOperation(op);
      if (change === "removed") records.delete(op.operationId);
      if (change === "replaced") {
        const replacement = operation();
        replacement.recoveryState = "provider_reconciliation_pending";
      }
      if (change === "shutdown") owner.shutdown();
      claim.release();
      await Promise.resolve();
      await settled();
      expect(ports.runOperation).toHaveBeenCalledTimes(
        change === "current" || change === "replaced" ? 1 : 0
      );
      expect(ports.persist).not.toHaveBeenCalled();
      expect(ports.admitRecoveryRollback).not.toHaveBeenCalled();
    }
  );

  it.each(
    [
      "queued",
      "unresolved",
      "rollback",
      "terminal",
      "removed",
      "missing",
      "shutdown"
    ].flatMap((replacement) =>
      ["success", "failure"].map((outcome) => [replacement, outcome])
    )
  )(
    "does not grant old %s work authority on %s settlement",
    async (replacement, outcome) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const { ports, operation, records, settled, scope, timers } = fixture();
      const old = operation();
      if (replacement === "missing") records.delete(old.operationId);
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started = () => {};
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      ports.runOperation
        .mockImplementationOnce(async () => {
          started();
          await gate;
          if (outcome === "failure") throw new Error("Old work failed");
        })
        .mockResolvedValue(undefined);
      const execution = createSetupExecution(ports);
      execution.scheduleEnvironmentOperation(old);
      await entered;
      const current = operation();
      if (replacement === "unresolved") {
        prepareProviderMutation(current, {
          kind: "azure_app.create",
          target: "replacement"
        });
      }
      if (replacement === "terminal" || replacement === "rollback")
        finish(current, "failed");
      if (replacement === "rollback")
        current.providerRecovery.state = "rollback_pending";
      current.executionActive = true;
      if (replacement === "removed") records.delete(old.operationId);
      if (replacement === "shutdown") scope.markShuttingDown();
      const before = structuredClone(current);
      if (replacement === "queued" || replacement === "unresolved")
        execution.scheduleEnvironmentOperation(current);
      release();
      await settled();
      expect(current).toEqual(
        replacement === "queued" || replacement === "unresolved" ?
          { ...before, executionActive: false }
        : before
      );
      expect(ports.runOperation).toHaveBeenCalledTimes(
        replacement === "queued" || replacement === "unresolved" ? 2 : 1
      );
      expect(ports.persist).not.toHaveBeenCalled();
      expect(ports.report).not.toHaveBeenCalled();
      expect(ports.admitRecoveryRollback).not.toHaveBeenCalled();
      expect(ports.recoverCleanup).not.toHaveBeenCalled();
      expect(timers).toEqual([]);
      expect(scope.hasActiveTasks()).toBe(false);
    }
  );

  it("ignores a reconciliation callback delivered after the execution scope stops", async () => {
    const { ports, operation, settled, scope } = fixture();
    const op = operation();
    prepareProviderMutation(op, {
      kind: "azure_app.create",
      target: "fixture-app"
    });
    ports.runOperation.mockRejectedValue(new Error("Write reply lost"));
    const scheduled = vi
      .spyOn(scope, "scheduleReconciliation")
      .mockImplementation(() => {});
    createSetupExecution(ports).scheduleEnvironmentOperation(op);
    await settled();
    expect(scheduled).toHaveBeenCalledOnce();
    scope.markShuttingDown();
    scheduled.mock.calls[0][1]();
    expect(ports.runOperation).toHaveBeenCalledOnce();
    expect(scope.hasActiveTasks()).toBe(false);
    expect(op.endedAt).toBeNull();
  });

  it("releases a queued recovery claim when shutdown prevents the runner from starting", async () => {
    const { ports, scope, operation, settled } = fixture();
    const op = operation();
    op.currentStage = STAGE_VERIFY;
    op.recoveryState = "verification_pending";
    const execution = createSetupExecution(ports);
    execution.recoverOperation(op);
    scope.markShuttingDown();
    await settled();
    expect(ports.observeRecoveredVerification).not.toHaveBeenCalled();
    expect(op.executionActive).toBe(false);
    expect(op.endedAt).toBeNull();
    const release = ports.claimVerificationMonitor(op.operationId);
    expect(release).toEqual(expect.any(Function));
    release?.();
    expect(execution.scheduleEnvironmentOperation(op)).toBe(false);
    expect(execution.scheduleCommandTask("rollback", op, "command")).toBe(
      false
    );
    execution.recoverOperation(op);
    expect(scope.hasActiveTasks()).toBe(false);
    expect(ports.persist).not.toHaveBeenCalled();
    expect(ports.admitRecoveryRollback).not.toHaveBeenCalled();
  });

  it("releases automatic recovery admission when shutdown wins the deferred callback", async () => {
    const { ports, operation, scope } = fixture();
    const op = operation();
    finish(op, "failed");
    op.providerRecovery = { state: "rollback_pending" };
    createSetupExecution(ports).recoverOperation(op);
    scope.markShuttingDown();
    await Promise.resolve();
    expect(ports.admitRecoveryRollback).not.toHaveBeenCalled();
    const release = scope.claimAutomaticRollback(op.operationId);
    expect(release).toEqual(expect.any(Function));
    release?.();
  });

  it("leaves a claimed verification monitor alone until its owner releases it", async () => {
    const { ports, scope, operation, settled } = fixture();
    const op = operation();
    op.currentStage = STAGE_VERIFY;
    op.recoveryState = "verification_pending";
    ports.observeRecoveredVerification.mockResolvedValue(undefined);
    const release = ports.claimVerificationMonitor(op.operationId);
    expect(release).toEqual(expect.any(Function));
    const execution = createSetupExecution(ports);
    execution.recoverOperation(op);
    expect(scope.hasActiveTasks()).toBe(false);
    expect(ports.observeRecoveredVerification).not.toHaveBeenCalled();
    release?.();
    execution.recoverOperation(op);
    await settled();
    expect(ports.observeRecoveredVerification).toHaveBeenCalledExactlyOnceWith(
      op
    );
  });

  it("runs explicitly scheduled work without a presentation identity", async () => {
    const { ports, scope, operation, settled } = fixture();
    const op = operation();
    ports.runOperation.mockResolvedValue(undefined);
    createSetupExecution(ports).scheduleEnvironmentOperation(op);

    expect(scope.hasActiveTasks()).toBe(true);
    expect(op.executionActive).toBe(true);
    await settled();
    expect(ports.runOperation).toHaveBeenCalledExactlyOnceWith(op.operationId);
    expect(scope.hasActiveTasks()).toBe(false);
    expect(op.executionActive).toBe(false);
    expect(ports.persist).not.toHaveBeenCalled();
  });

  it.each([
    "verification_monitor",
    "verification_retry",
    "cleanup_retry",
    "rollback",
    "exit_setup"
  ] as const)("routes %s to its original command identity", async (kind) => {
    const { ports, operation, settled } = fixture();
    const op = operation();
    ports.runVerificationContinuation.mockResolvedValue(undefined);
    ports.runVerificationRetry.mockResolvedValue(undefined);
    ports.runCleanup.mockResolvedValue(undefined);
    createSetupExecution(ports).scheduleCommandTask(kind, op, "command-7");
    await settled();

    expect(ports.runOperation).not.toHaveBeenCalled();
    if (kind === "verification_monitor") {
      expect(ports.runVerificationContinuation).toHaveBeenCalledExactlyOnceWith(
        op.operationId,
        "command-7"
      );
      expect(ports.runVerificationRetry).not.toHaveBeenCalled();
      expect(ports.runCleanup).not.toHaveBeenCalled();
    } else if (kind === "verification_retry") {
      expect(ports.runVerificationRetry).toHaveBeenCalledExactlyOnceWith(
        op.operationId,
        "command-7"
      );
      expect(ports.runVerificationContinuation).not.toHaveBeenCalled();
      expect(ports.runCleanup).not.toHaveBeenCalled();
    } else {
      expect(ports.runCleanup).toHaveBeenCalledExactlyOnceWith(
        kind,
        op.operationId,
        "command-7"
      );
      expect(ports.runVerificationContinuation).not.toHaveBeenCalled();
      expect(ports.runVerificationRetry).not.toHaveBeenCalled();
    }
  });

  it("leaves deletion recovery to the server-ready owner", () => {
    const { ports, operation, scope } = fixture();
    const op = operation();
    op.kind = "delete";
    op.recoveryState = "provider_reconciliation_pending";
    op.providerRecovery = { state: "rollback_pending" };
    createSetupExecution(ports).recoverOperation(op);
    expect(scope.hasActiveTasks()).toBe(false);
    expect(ports.runOperation).not.toHaveBeenCalled();
    expect(ports.admitRecoveryRollback).not.toHaveBeenCalled();
    expect(ports.getOperation).not.toHaveBeenCalled();
  });

  it.each(["failure", "reconciliation"] as const)(
    "reports a %s persistence failure without preventing task settlement",
    async (kind) => {
      const { ports, operation, settled, scope, timers } = fixture();
      const op = operation();
      if (kind === "reconciliation") {
        prepareProviderMutation(op, {
          kind: "azure_app.create",
          target: "fixture-app"
        });
      }
      ports.runOperation.mockRejectedValue(new Error("Provider reply lost"));
      ports.persist.mockRejectedValue(new Error("Checkpoint unavailable"));
      createSetupExecution(ports).scheduleEnvironmentOperation(op);
      await settled();

      expect(scope.hasActiveTasks()).toBe(false);
      expect(ports.report).toHaveBeenCalledExactlyOnceWith({
        scope: "setup-task-persistence",
        operationId: op.operationId,
        message: "Checkpoint unavailable"
      });
      expect(ports.persist).toHaveBeenCalledOnce();
      if (kind === "reconciliation") {
        expect(op.recoveryState).toBe("provider_reconciliation_pending");
        expect(timers).toHaveLength(1);
      } else {
        expect(op.failure.code).toBe("server-owned-task-failed");
        expect(op.state).toBe("failed");
      }
    }
  );

  it("does not terminalize an in-flight operation after shutdown marking", async () => {
    const { ports, operation, settled, scope } = fixture();
    const op = operation();
    ports.runOperation.mockImplementation(async () => {
      scope.markShuttingDown();
      throw new Error("In-flight write interrupted");
    });
    createSetupExecution(ports).scheduleEnvironmentOperation(op);
    await settled();
    expect(scope.isShuttingDown()).toBe(true);
    expect(op.endedAt).toBeNull();
    expect(ports.persist).not.toHaveBeenCalled();
  });

  it.each(["branch", "cleanup", "verification", "setup"] as const)(
    "recovers the saved %s work rather than choosing a new operation",
    async (kind) => {
      const { ports, operation, settled } = fixture();
      const op = operation();
      op.recoveryState = "provider_reconciliation_pending";
      let commandId: string | undefined;
      if (kind === "branch") {
        prepareProviderMutation(op, {
          kind: "github_branch.delete",
          target: "fixture/app:setup",
          intent: { repo: "fixture/app", branch: "setup" }
        });
      } else if (kind === "cleanup") {
        op.providerRecovery = { state: "rollback_pending", mutations: [] };
      } else if (kind === "verification") {
        const accepted = acceptCommand(op, {
          kind: "retry_verification",
          attempt: 1,
          target: "fixture"
        });
        commandId = accepted.command.commandId;
        prepareProviderMutation(op, {
          kind: "github_workflow.dispatch_retry",
          target: "fixture"
        });
      }
      ports.recoverBranchDelete.mockResolvedValue(undefined);
      ports.recoverCleanup.mockResolvedValue(undefined);
      ports.runVerificationRetry.mockResolvedValue(undefined);
      ports.runOperation.mockResolvedValue(undefined);
      createSetupExecution(ports).recoverOperation(op);
      await settled();

      expect(ports.recoverBranchDelete).toHaveBeenCalledTimes(
        kind === "branch" ? 1 : 0
      );
      expect(ports.recoverCleanup).toHaveBeenCalledTimes(
        kind === "cleanup" ? 1 : 0
      );
      expect(ports.runVerificationRetry).toHaveBeenCalledTimes(
        kind === "verification" ? 1 : 0
      );
      expect(ports.runOperation).toHaveBeenCalledTimes(
        kind === "setup" ? 1 : 0
      );
      if (kind === "verification") {
        expect(ports.runVerificationRetry).toHaveBeenCalledWith(
          op.operationId,
          commandId
        );
      }
    }
  );

  it.each(["verification_pending", "verification_acquisition_pending"])(
    "releases the recovered %s claim even when its runner fails",
    async (state) => {
      const { ports, operation, settled } = fixture();
      const op = operation();
      op.recoveryState = state;
      op.currentStage = STAGE_VERIFY;
      op.verification = { retryCommandId: "saved-command" };
      const execution = createSetupExecution(ports);
      execution.recoverOperation(op);
      execution.recoverOperation(op);
      await settled();

      expect(op.failure.code).toBe("server-owned-task-failed");
      expect(ports.runVerificationRetry).toHaveBeenCalledTimes(
        state === "verification_acquisition_pending" ? 1 : 0
      );
      expect(ports.observeRecoveredVerification).toHaveBeenCalledTimes(
        state === "verification_pending" ? 1 : 0
      );
      const release = ports.claimVerificationMonitor(op.operationId);
      expect(release).toEqual(expect.any(Function));
      release?.();
    }
  );

  it("preserves a missing recovered retry command instead of inventing one", async () => {
    const { ports, operation, settled } = fixture();
    const op = operation();
    op.currentStage = STAGE_VERIFY;
    op.recoveryState = "verification_acquisition_pending";
    op.verification = undefined;
    ports.runVerificationRetry.mockResolvedValue(undefined);
    createSetupExecution(ports).recoverOperation(op);
    await settled();
    expect(ports.runVerificationRetry).toHaveBeenCalledExactlyOnceWith(
      op.operationId,
      ""
    );
    const release = ports.claimVerificationMonitor(op.operationId);
    expect(release).toEqual(expect.any(Function));
    release?.();
  });
});
