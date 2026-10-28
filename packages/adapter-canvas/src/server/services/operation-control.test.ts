import { afterEach, describe, expect, it, vi } from "vitest";
import { createEnvironmentExecutionOwner } from "../../runtime/environment-execution-owner.js";
import type {
  OperationStore,
  PersistedOperationsEnvelope
} from "../../operation-store.js";
import type { OperationRecord } from "../routes/operations-status.js";
import {
  enterStage,
  createRegistry,
  acceptCommand,
  beginRetryAttempt,
  finish,
  pauseForProviderRestart,
  onOperationTerminal,
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
  retryableSetup,
  reusedOnlyFailure
} from "../../../test/support/server/operation-fixtures.js";

afterEach(() => onOperationTerminal(null));

function deferred() {
  let resolve = () => {};
  let reject = (_error: Error) => {};
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(overrides: Partial<OperationsControlDependencies> = {}) {
  const operation = stoppedSetup();
  const dependencies: OperationsControlDependencies = {
    claimAdmission: createEnvironmentExecutionOwner().claimAdmission,
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
  it.each(
    [
      "run",
      "replacement",
      "removal",
      "shutdown",
      "repo",
      "environment",
      "account",
      "attempt",
      "state",
      "id"
    ].flatMap((change) =>
      ["read", "save"].flatMap((boundary) =>
        [false, true].map((reject) => ({ change, boundary, reject }))
      )
    )
  )(
    "preserves the recorded Stop without stale observation writes: $change at $boundary reject=$reject",
    async ({ change, boundary, reject }) => {
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
      operation.verification = { runId: "42", workflowState: "active" };
      pauseForProviderRestart(operation);
      let current: OperationRecord | null = operation;
      const entered = deferred();
      const gate = deferred();
      const owner = createEnvironmentExecutionOwner();
      let saves = 0;
      const { dependencies } = fixture({
        get: () => current,
        isShuttingDown: owner.isShuttingDown,
        inspectVerificationWorkflow: async () => {
          if (boundary === "read") {
            entered.resolve();
            await gate.promise;
          }
          return "inactive";
        },
        persistOperations: vi.fn(async () => {
          if (++saves === 2 && boundary === "save") {
            entered.resolve();
            await gate.promise;
          }
        })
      });
      const pending = createOperationsControlService(dependencies)({
        operationId: operation.operationId,
        command: "stop"
      });
      await entered.promise;
      const announce = vi.fn();
      onOperationTerminal(announce);
      expect(operation.state).toBe("cancelled");
      if (change === "run")
        operation.verification = { runId: "43", workflowState: "active" };
      if (change === "replacement") current = structuredClone(operation);
      if (change === "removal") current = null;
      if (change === "shutdown") owner.shutdown();
      if (change === "repo") operation.repo = "fixture/other";
      if (change === "environment") operation.environment = "other";
      if (change === "account") operation.context = { githubLogin: "other" };
      if (change === "attempt") operation.control.attempts.verification++;
      if (change === "state") operation.state = "running";
      if (change === "id") operation.operationId = "other";
      const before = structuredClone(operation);
      const replacement = structuredClone(current);
      if (reject) gate.reject(new Error("late network error"));
      else gate.resolve();
      expect(await pending).toMatchObject({
        status: change === "shutdown" ? 503 : 409,
        body: {
          code:
            change === "shutdown" ?
              "operation-shutting-down"
            : "operation-context-changed",
          stopRecorded: true
        }
      });
      expect(operation).toEqual(before);
      expect(current).toEqual(replacement);
      expect(dependencies.persistOperations).toHaveBeenCalledTimes(
        boundary === "read" ? 1 : 2
      );
      expect(operation.journey?.notifiedAt).toBeFalsy();
      expect(announce).not.toHaveBeenCalled();
    }
  );

  it("retains known workflow status when its save fails after the Stop was recorded", async () => {
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
    operation.verification = { runId: "42", workflowState: "active" };
    pauseForProviderRestart(operation);
    const { dependencies } = fixture({
      get: () => operation,
      inspectVerificationWorkflow: async () => "inactive",
      persistOperations: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("disk unavailable"))
    });
    expect(
      await createOperationsControlService(dependencies)({
        operationId: operation.operationId,
        command: "stop"
      })
    ).toMatchObject({
      status: 500,
      body: {
        code: "workflow-status-persist-failed",
        stopRecorded: true,
        detail: "disk unavailable"
      }
    });
    expect(operation.state).toBe("cancelled");
    expect(verificationWorkflowState(operation)).toBe("inactive");
    expect(dependencies.persistOperations).toHaveBeenCalledTimes(2);
    expect(operation.journey?.notifiedAt).toBeFalsy();
  });

  it("rejects a replacement login during final admission persistence without restoring the old account", async () => {
    const operation = mergeHandoff();
    operation.context = { githubLogin: " original " };
    const before = structuredClone(operation);
    const registry = createRegistry();
    registry.put(operation);
    const entered = deferred();
    const gate = deferred();
    let saves = 0;
    const { dependencies } = fixture({
      get: (id) => registry.get(id),
      acquireForRetry: (op) => registry.acquireForRetry(op),
      checkPullRequestMerge: async () => ({ state: "merged" }),
      persistOperations: async () => {
        if (++saves === 2) {
          entered.resolve();
          await gate.promise;
        }
      }
    });
    const pending = createOperationsControlService(dependencies)({
      operationId: operation.operationId,
      command: "retry",
      retryKind: "verification"
    });
    await entered.promise;
    operation.context = { githubLogin: "replacement" };
    gate.resolve();
    expect(await pending).toMatchObject({
      status: 409,
      body: { code: "operation-context-changed" }
    });
    expect(operation).toMatchObject({
      ...before,
      context: { githubLogin: "replacement" }
    });
    expect(registry.running(operation.repo)).toBeNull();
    expect(dependencies.schedule).not.toHaveBeenCalled();
    expect(saves).toBe(3);
  });

  it.each(["monitor", "terminal"] as const)(
    "refuses an unsettled %s task transiently before admission writes and allows retry after settlement",
    async (kind) => {
      const owner = createEnvironmentExecutionOwner();
      const operation = kind === "monitor" ? mergeHandoff() : stoppedSetup();
      const gate = deferred();
      const settled = deferred();
      owner.attach("panel").schedule(operation.operationId, {
        run: () => gate.promise,
        failed: async () => {
          throw new Error("Unexpected failure");
        },
        settling: () => {},
        settled: () => settled.resolve()
      });
      const { dependencies } = fixture({
        claimAdmission: owner.claimAdmission,
        get: () => operation,
        checkPullRequestMerge: vi.fn(async () => ({ state: "merged" as const }))
      });
      const input = {
        operationId: operation.operationId,
        command:
          kind === "monitor" ? ("retry" as const) : ("continue" as const),
        retryKind: "verification"
      };
      const service = createOperationsControlService(dependencies);
      const before = structuredClone(operation);
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          expect(await service(input)).toMatchObject({
            status: 409,
            body: { code: "operation-task-busy" }
          });
        }
        expect(operation).toEqual(before);
        expect(dependencies.persistOperations).not.toHaveBeenCalled();
        expect(dependencies.checkPullRequestMerge).not.toHaveBeenCalled();
        expect(dependencies.schedule).not.toHaveBeenCalled();
      } finally {
        gate.resolve();
        await settled.promise;
      }
      expect(await service(input)).toMatchObject({ status: 202 });
      expect(dependencies.schedule).toHaveBeenCalledOnce();
    }
  );

  it("refuses a record whose registered ID does not match before acquiring admission", async () => {
    const operation = stoppedSetup();
    const { dependencies } = fixture({ get: () => operation });
    expect(
      await createOperationsControlService(dependencies)({
        operationId: "different-id",
        command: "continue"
      })
    ).toMatchObject({
      status: 409,
      body: { code: "operation-context-changed" }
    });
    expect(dependencies.acquireForRetry).not.toHaveBeenCalled();
    expect(dependencies.persistOperations).not.toHaveBeenCalled();
  });

  it("refuses a competing admission rather than reporting a provisional command as accepted", async () => {
    const owner = createEnvironmentExecutionOwner();
    const { operation, dependencies, input } = fixture({
      claimAdmission: owner.claimAdmission
    });
    const claim = owner.claimAdmission(operation.operationId);
    if (!claim) throw new Error("Missing admission");
    acceptCommand(operation, {
      kind: "rollback",
      attempt: 1,
      target: "competing"
    });
    try {
      expect(
        await createOperationsControlService(dependencies)(input)
      ).toMatchObject({
        status: 409,
        body: { code: "operation-context-changed" }
      });
      expect(dependencies.schedule).not.toHaveBeenCalled();
    } finally {
      claim.release();
    }
  });

  it.each([false, true])(
    "corrects a stale rejected precondition save (undo fails=%s)",
    async (undoFails) => {
      const operation = mergeHandoff();
      const entered = deferred();
      const gate = deferred();
      const owner = createEnvironmentExecutionOwner();
      let current = true;
      let writes = 0;
      const { dependencies } = fixture({
        claimAdmission: owner.claimAdmission,
        get: () => operation,
        persistOperations: async () => {
          if (++writes === 1) {
            entered.resolve();
            await gate.promise;
          } else if (undoFails) throw new Error("undo offline");
        }
      });
      const pending = createOperationsControlService(dependencies)({
        operationId: operation.operationId,
        command: "retry",
        retryKind: "verification",
        isCurrent: () => current
      });
      await entered.promise;
      current = false;
      gate.reject(new Error("deadline offline"));
      expect(await pending).toMatchObject({
        status: undoFails ? 500 : 409,
        body: {
          code:
            undoFails ?
              "operation-control-recovery-persist-failed"
            : "operation-context-changed"
        }
      });
      expect(writes).toBe(2);
      expect(dependencies.schedule).not.toHaveBeenCalled();
      expect(dependencies.reportOperationDiagnostic).toHaveBeenCalledTimes(
        undoFails ? 1 : 0
      );
    }
  );

  it.each([false, true])(
    "does not close or invalidate a stale ownership-free exit after save (reject=%s)",
    async (reject) => {
      const operation = reusedOnlyFailure();
      const before = structuredClone(operation);
      const entered = deferred();
      const gate = deferred();
      let current = true;
      let writes = 0;
      const { dependencies } = fixture({
        get: () => operation,
        persistOperations: async () => {
          if (++writes === 1) {
            entered.resolve();
            await gate.promise;
          }
        }
      });
      const pending = createOperationsControlService(dependencies)({
        operationId: operation.operationId,
        command: "exit",
        isCurrent: () => current
      });
      await entered.promise;
      current = false;
      if (reject) gate.reject(new Error("exit save failed"));
      else gate.resolve();
      expect(await pending).toMatchObject({
        status: 409,
        body: { code: "operation-context-changed" }
      });
      expect(operation).toMatchObject(before);
      expect(dependencies.invalidateEnvironmentListing).not.toHaveBeenCalled();
      expect(dependencies.schedule).not.toHaveBeenCalled();
      expect(writes).toBe(2);
    }
  );
  it.each(["removed", "replaced", "id", "repository", "environment"] as const)(
    "does not reacquire a %s record after an asynchronous precondition",
    async (change) => {
      for (const phase of ["deadline", "merge"] as const) {
        const operation = mergeHandoff();
        const registry = createRegistry();
        registry.put(operation);
        const id = operation.operationId;
        const entered = deferred();
        const gate = deferred();
        let saves = 0;
        const { dependencies } = fixture({
          get: (operationId) => registry.get(operationId),
          acquireForRetry: vi.fn((record) => registry.acquireForRetry(record)),
          persistOperations: async () => {
            if (++saves === 1 && phase === "deadline") {
              entered.resolve();
              await gate.promise;
            }
          },
          checkPullRequestMerge: vi.fn(async () => {
            entered.resolve();
            await gate.promise;
            return { state: "merged" as const };
          })
        });
        const result = createOperationsControlService(dependencies)({
          operationId: id,
          command: "retry",
          retryKind: "verification"
        });
        await entered.promise;
        if (change === "removed") registry.delete(id);
        else if (change === "replaced")
          registry.put(structuredClone(operation));
        else if (change === "id") operation.operationId = "replacement-id";
        else if (change === "repository") operation.repo = "fixture/other";
        else operation.environment = "other";
        const replacement = registry.get(id);
        const before = structuredClone(replacement);
        gate.resolve();
        expect(await result).toMatchObject({
          status: 409,
          body: { code: "operation-context-changed" }
        });
        expect(registry.get(id)).toBe(replacement);
        expect(registry.get(id)).toEqual(before);
        expect(dependencies.acquireForRetry).not.toHaveBeenCalled();
        expect(dependencies.schedule).not.toHaveBeenCalled();
        if (phase === "deadline")
          expect(dependencies.checkPullRequestMerge).not.toHaveBeenCalled();
      }
    }
  );

  it.each(["removed", "replaced", "coordinator"] as const)(
    "corrects a held snapshot before restart when %s changes",
    async (change) => {
      const entered = deferred();
      const gate = deferred();
      let saved: PersistedOperationsEnvelope | null = null;
      let writes = 0;
      const store: OperationStore = {
        load: async () => structuredClone(saved),
        save: async (envelope) => {
          if (++writes === 1) {
            entered.resolve();
            await gate.promise;
          }
          saved = structuredClone(envelope);
        }
      };
      const registry = createRegistry({ store });
      const operation = stoppedSetup();
      registry.put(operation);
      const before = structuredClone(operation);
      let current = true;
      const { dependencies } = fixture({
        get: (id) => registry.get(id),
        acquireForRetry: (op) => registry.acquireForRetry(op),
        persistOperations: () => registry.persist()
      });
      const result = createOperationsControlService(dependencies)({
        operationId: operation.operationId,
        command: "continue",
        isCurrent: () => current
      });
      await entered.promise;
      let replacement: OperationRecord | null = null;
      if (change === "removed") registry.delete(operation.operationId);
      else if (change === "replaced") {
        replacement = structuredClone(before);
        replacement.environment = "replacement";
        registry.put(replacement);
      } else current = false;
      gate.resolve();
      expect(await result).toMatchObject({
        status: 409,
        body: { code: "operation-context-changed" }
      });
      expect(writes).toBe(2);
      expect(dependencies.schedule).not.toHaveBeenCalled();
      const restarted = createRegistry({ store });
      await restarted.hydrate();
      const restored = restarted.get(operation.operationId);
      if (change === "removed") expect(restored).toBeNull();
      else {
        expect(restored.control.commands).toEqual([]);
        expect(restored.environment).toBe(
          change === "replaced" ? "replacement" : before.environment
        );
      }
      if (replacement)
        expect(registry.get(operation.operationId)).toBe(replacement);
      if (change === "coordinator") expect(operation).toMatchObject(before);
    }
  );

  it.each([false, true])(
    "refuses stale admission after a held save (reject=%s) and restores its lock and retry token",
    async (reject) => {
      const operation = mergeHandoff();
      const before = structuredClone(operation);
      const registry = createRegistry();
      registry.put(operation);
      const entered = deferred();
      const gate = deferred();
      let current = true;
      let saves = 0;
      const { dependencies } = fixture({
        get: (id) => registry.get(id),
        acquireForRetry: (op) => registry.acquireForRetry(op),
        checkPullRequestMerge: async () => ({ state: "merged" }),
        persistOperations: async () => {
          if (++saves === 2) {
            entered.resolve();
            await gate.promise;
          }
        }
      });
      const service = createOperationsControlService(dependencies);
      const input = {
        operationId: operation.operationId,
        command: "retry" as const,
        retryKind: "verification",
        isCurrent: () => current
      };
      const result = service(input);
      await entered.promise;
      current = false;
      if (reject) gate.reject(new Error("save failed"));
      else gate.resolve();
      expect(await result).toMatchObject({
        status: 409,
        body: { code: "operation-context-changed" }
      });
      expect(operation).toMatchObject(before);
      expect(operation.verification).not.toHaveProperty(
        "acquisitionProvisionalToken"
      );
      expect(registry.running(operation.repo)).toBeNull();
      expect(dependencies.schedule).not.toHaveBeenCalled();
      expect(saves).toBe(3);
      current = true;
      expect(await service(input)).toMatchObject({ status: 202 });
      expect(dependencies.schedule).toHaveBeenCalledOnce();
    }
  );

  it.each(["write", "task", "new-command"] as const)(
    "fails closed without restoring over %s ownership or failed correction",
    async (failure) => {
      const owner = createEnvironmentExecutionOwner();
      const entered = deferred();
      const gate = deferred();
      let current = true;
      let saves = 0;
      const { operation, dependencies, input } = fixture({
        claimAdmission: owner.claimAdmission,
        persistOperations: async () => {
          if (++saves === 1) {
            entered.resolve();
            await gate.promise;
          } else if (failure === "write")
            throw new Error("corrective store offline");
        }
      });
      const result = createOperationsControlService(dependencies)({
        ...input,
        isCurrent: () => current
      });
      await entered.promise;
      const taskGate = deferred();
      const taskSettled = deferred();
      if (failure === "task")
        owner.attach("competing").schedule(operation.operationId, {
          run: () => taskGate.promise,
          failed: async () => {
            throw new Error("Unexpected task failure");
          },
          settling: () => {},
          settled: () => taskSettled.resolve()
        });
      if (failure === "new-command")
        acceptCommand(operation, {
          kind: "retry_cleanup",
          attempt: beginRetryAttempt(operation, "cleanup"),
          target: "new-owner"
        });
      const competing = structuredClone(operation);
      current = false;
      gate.resolve();
      expect(await result).toMatchObject({
        status: 500,
        body: {
          detail: expect.stringContaining("could not durably undo admission")
        }
      });
      expect(dependencies.reportOperationDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          code: "operation-control-recovery-persist-failed"
        })
      );
      expect(dependencies.schedule).not.toHaveBeenCalled();
      const recover = vi.fn();
      expect(owner.deferAdmissionRecovery(operation.operationId, recover)).toBe(
        true
      );
      expect(owner.claimAdmission(operation.operationId)).toBeNull();
      expect(recover).not.toHaveBeenCalled();
      if (failure !== "write") expect(operation).toEqual(competing);
      taskGate.resolve();
      if (failure === "task") await taskSettled.promise;
    }
  );
  it.each([true, false])(
    "revalidates a queued command with optional publisher=%s",
    async (publishResult) => {
      const { dependencies, input } = fixture();
      const service = createOperationsControlService(dependencies);
      const publish = vi.fn();
      let current = true;
      const result = service(
        {
          ...input,
          isCurrent: () => current
        },
        publishResult ? publish : undefined
      );
      current = false;
      expect(await result).toMatchObject({
        status: 409,
        body: {
          code: "operation-context-changed",
          operationId: input.operationId
        }
      });
      expect(publish).toHaveBeenCalledTimes(publishResult ? 1 : 0);
      expect(dependencies.get).not.toHaveBeenCalled();
      expect(dependencies.persistOperations).not.toHaveBeenCalled();
      expect(dependencies.schedule).not.toHaveBeenCalled();
    }
  );
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
    "claimAdmission",
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
    const reads = vi.mocked(dependencies.get).mock.calls.length;
    const second = service({ ...input, instanceId: "another-subscriber" });
    expect(dependencies.get).toHaveBeenCalledTimes(reads);
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

  it("records an explicit scheduling failure for an accepted direct retry without a runner", async () => {
    const operation = retryableSetup();
    const { dependencies } = fixture({
      get: () => operation,
      schedule: () => false
    });
    expect(
      await createOperationsControlService(dependencies)({
        operationId: operation.operationId,
        command: "retry",
        retryKind: "setup"
      })
    ).toMatchObject({ status: 202 });
    expect(operation.failure).toMatchObject({
      code: "operation-scheduling-failed",
      evidence: "No runtime setup task runner was available."
    });
    expect(operation.control.commands).toEqual([
      expect.objectContaining({ state: "finished", outcome: "unscheduled" })
    ]);
    expect(dependencies.persistOperations).toHaveBeenCalledTimes(2);
  });

  it("rechecks a waiting subscriber after the previous command settles", async () => {
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
    let current = true;
    const second = service({ ...input, isCurrent: () => current });
    current = false;
    release();
    expect(await first).toMatchObject({ status: 202 });
    expect(await second).toMatchObject({
      status: 409,
      body: { code: "operation-context-changed" }
    });
    expect(dependencies.schedule).toHaveBeenCalledOnce();
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

  it("closes an ownership-free legacy setup with a missing repository without scheduling deletion", async () => {
    const operation = reusedOnlyFailure();
    delete operation.repo;
    const { dependencies } = fixture({ get: () => operation });
    expect(
      await createOperationsControlService(dependencies)({
        operationId: operation.operationId,
        command: "exit"
      })
    ).toMatchObject({
      status: 200,
      body: { code: "setup-exited", removed: false }
    });
    expect(
      dependencies.invalidateEnvironmentListing
    ).toHaveBeenCalledExactlyOnceWith("");
    expect(dependencies.schedule).not.toHaveBeenCalled();
    expect(dependencies.persistOperations).toHaveBeenCalledOnce();
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
      body: { code: "operation-context-changed" }
    });
    expect(dependencies.schedule).not.toHaveBeenCalled();
    expect(current.control.commands).toEqual([]);
  });
});
