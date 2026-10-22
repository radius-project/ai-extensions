import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEnvironmentExecutionOwner,
  type EnvironmentExecutionOwner
} from "./environment-execution-owner.js";

function deferred() {
  let resolve = () => {};
  let reject = (_error: Error) => {};
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function task(run: () => Promise<void>) {
  return {
    run,
    failed: vi.fn(async (_error: unknown) => {}),
    settling: vi.fn(),
    settled: vi.fn()
  };
}

function settled(owner: EnvironmentExecutionOwner, instanceId: string) {
  return new Promise<void>((resolve) => {
    const stop = owner.onEnvironmentTasksSettled(instanceId, () => {
      stop();
      resolve();
    });
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runtime environment execution ownership", () => {
  it("fences only a replaced setup presentation, not other panels or deletion scopes", () => {
    const owner = createEnvironmentExecutionOwner();
    const first = owner.attach("panel");
    const runtime = owner.attachRuntime();
    owner.attachDeletion("panel");
    owner.attach("other");
    expect(first.isCurrent()).toBe(true);
    const replacement = owner.attach("panel");
    expect(first.isCurrent()).toBe(false);
    expect(replacement.isCurrent()).toBe(true);
    expect(runtime.isCurrent()).toBe(true);
    first.detach();
    expect(replacement.isCurrent()).toBe(true);
    replacement.detach();
    replacement.detach();
    expect(replacement.isCurrent()).toBe(false);
  });

  it("stops queued setup, cancels timers and rejects admission without stopping legacy deletion", async () => {
    const callbacks: Array<() => void> = [];
    const cancel = vi.fn();
    const owner = createEnvironmentExecutionOwner({
      deferTask: async () => {},
      microtask: queueMicrotask,
      reconciliationTimer: (callback) => {
        callbacks.push(callback);
        return cancel;
      }
    });
    const setup = owner.attachRuntime();
    const deletion = owner.attachDeletion("panel");
    const pending = task(vi.fn(async () => {}));
    const legacy = task(vi.fn(async () => {}));
    const reconcile = vi.fn();
    setup.schedule("queued", pending);
    setup.scheduleReconciliation("recover", reconcile);
    owner.shutdown();
    owner.shutdown();
    expect(setup.isShuttingDown()).toBe(true);
    expect(owner.isShuttingDown()).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    callbacks[0]();
    expect(reconcile).not.toHaveBeenCalled();
    setup.scheduleReconciliation("later", reconcile);
    expect(callbacks).toHaveLength(1);
    expect(() =>
      setup.schedule(
        "new",
        task(async () => {})
      )
    ).toThrow("Setup execution is shutting down.");
    deletion.schedule("legacy", legacy);
    await Promise.all([
      new Promise<void>((resolve) => {
        const stop = setup.onTasksSettled(() => {
          stop();
          resolve();
        });
      }),
      settled(owner, "panel")
    ]);
    expect(pending.run).not.toHaveBeenCalled();
    expect(legacy.run).toHaveBeenCalledOnce();
    expect(pending.settled).toHaveBeenCalledOnce();
    expect(legacy.settled).toHaveBeenCalledOnce();
    expect(setup.hasActiveTasks()).toBe(false);
  });

  it("notifies shutdown subscribers once and isolates failure and stale unsubscribe", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const owner = createEnvironmentExecutionOwner();
    const callback = vi.fn();
    const release = owner.onShutdown(callback);
    const releaseReplacement = owner.onShutdown(callback);
    release();
    release();
    owner.onShutdown(() => {
      throw new Error("observer failure");
    });
    const following = vi.fn();
    owner.onShutdown(following);
    owner.shutdown();
    owner.shutdown();
    releaseReplacement();
    expect(callback).toHaveBeenCalledOnce();
    expect(following).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledExactlyOnceWith(
      "[radius] setup shutdown callback failed: observer failure"
    );
    const late = vi.fn();
    owner.onShutdown(late)();
    expect(late).toHaveBeenCalledOnce();
  });

  it("signals deletion settlement while shared setup still owns its task", async () => {
    const owner = createEnvironmentExecutionOwner();
    const setup = owner.attach("panel");
    const deletion = owner.attachDeletion("panel");
    const setupGate = deferred();
    const deleteGate = deferred();
    setup.schedule(
      "setup",
      task(() => setupGate.promise)
    );
    deletion.schedule(
      "delete",
      task(() => deleteGate.promise)
    );
    const completed = settled(owner, "panel");
    const deletionDone = new Promise<void>((resolve) => {
      const stop = owner.onDeletionTasksSettled("panel", () => {
        stop();
        resolve();
      });
    });
    expect(owner.hasActiveDeletionTasks("panel")).toBe(true);
    try {
      deleteGate.resolve();
      await deletionDone;
      expect(owner.hasActiveDeletionTasks("panel")).toBe(false);
      expect(owner.hasActiveEnvironmentTasks("panel")).toBe(true);
      deletion.markShuttingDown();
      expect(setup.isShuttingDown()).toBe(false);
      expect(deletion.isShuttingDown()).toBe(true);
    } finally {
      setupGate.resolve();
      deleteGate.resolve();
      await completed;
    }
    expect(owner.hasActiveEnvironmentTasks("panel")).toBe(false);
  });

  it("does not close deletion subscribers when an earlier listener schedules another deletion", async () => {
    const owner = createEnvironmentExecutionOwner();
    const scope = owner.attachDeletion("panel");
    const gate = deferred();
    const replacement = deferred();
    scope.schedule(
      "first",
      task(() => gate.promise)
    );
    const stop = owner.onDeletionTasksSettled("panel", () => {
      stop();
      scope.schedule(
        "next",
        task(() => replacement.promise)
      );
    });
    const close = vi.fn();
    const finished = new Promise<void>((resolve) => {
      const unsubscribe = owner.onDeletionTasksSettled("panel", () => {
        close();
        unsubscribe();
        resolve();
      });
    });
    const entered = new Promise<void>((resolve) => {
      owner.onEnvironmentTasksSettled("panel", resolve);
    });
    try {
      gate.resolve();
      await entered;
      expect(owner.hasActiveDeletionTasks("panel")).toBe(true);
      expect(close).not.toHaveBeenCalled();
    } finally {
      replacement.resolve();
      await finished;
    }
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["settling", "settled"] as const)(
    "reports a throwing %s callback without leaking ownership",
    async (phase) => {
      const diagnostic = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const owner = createEnvironmentExecutionOwner();
      const scope = owner.attach("panel");
      const work = task(async () => {});
      work[phase].mockImplementation(() => {
        throw new Error(`${phase} failed`);
      });
      scope.schedule("op", work);
      await settled(owner, "panel");
      expect(scope.hasTask("op")).toBe(false);
      expect(scope.hasActiveTasks()).toBe(false);
      expect(work.settling).toHaveBeenCalledOnce();
      expect(work.settled).toHaveBeenCalledOnce();
      expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
        `[radius] environment task finalization failed (operationId=op, instanceId=panel): ${phase} failed`
      );
      const next = task(async () => {});
      scope.schedule("op", next);
      await settled(owner, "panel");
      expect(next.settled).toHaveBeenCalledOnce();
    }
  );

  it.each(["settling", "listener"] as const)(
    "does not notify idle consumers or finalize old work after %s schedules a successor",
    async (phase) => {
      const owner = createEnvironmentExecutionOwner();
      const scope = owner.attach("panel");
      const entered = deferred();
      const gate = deferred();
      const next = task(async () => {
        entered.resolve();
        await gate.promise;
      });
      const work = task(async () => {});
      if (phase === "settling") {
        work.settling.mockImplementation(() => scope.schedule("op", next));
      } else {
        const stop = scope.onTasksSettled(() => {
          stop();
          scope.schedule("op", next);
        });
      }
      scope.schedule("op", work);
      const notified = vi.fn();
      const stop = scope.onTasksSettled(notified);
      const completed = settled(owner, "panel");
      try {
        await entered.promise;
        expect(scope.hasActiveTasks()).toBe(true);
        expect(scope.hasTask("op")).toBe(true);
        expect(work.settled).not.toHaveBeenCalled();
        expect(notified).not.toHaveBeenCalled();
      } finally {
        gate.resolve();
        await completed;
        stop();
      }
      expect(next.settled).toHaveBeenCalledOnce();
      expect(notified).toHaveBeenCalledOnce();
    }
  );

  it("ignores an already-queued old timer without clearing the replacement timer", async () => {
    const callbacks: Array<() => void> = [];
    const cancel = vi.fn();
    const owner = createEnvironmentExecutionOwner({
      deferTask: async () => {},
      microtask: queueMicrotask,
      reconciliationTimer: (callback) => {
        callbacks.push(callback);
        return cancel;
      }
    });
    const first = owner.attach("old");
    const replacement = owner.attach("new");
    const stale = vi.fn();
    const current = vi.fn();
    first.scheduleReconciliation("op", stale);
    replacement.schedule(
      "op",
      task(async () => {})
    );
    expect(cancel).toHaveBeenCalledOnce();
    await settled(owner, "new");
    replacement.scheduleReconciliation("op", current);
    callbacks[0]();
    first.scheduleReconciliation("op", stale);
    expect(callbacks).toHaveLength(2);
    expect(stale).not.toHaveBeenCalled();
    callbacks[1]();
    callbacks[0]();
    callbacks[1]();
    expect(current).toHaveBeenCalledOnce();
    expect(stale).not.toHaveBeenCalled();
  });

  it("cancels the actual reconciliation timer when a new command is scheduled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const owner = createEnvironmentExecutionOwner();
    const scope = owner.attach("panel");
    const callback = vi.fn();
    scope.scheduleReconciliation("op", callback);
    expect(vi.getTimerCount()).toBe(1);
    scope.schedule(
      "op",
      task(async () => {})
    );
    expect(vi.getTimerCount()).toBe(0);
    await settled(owner, "panel");
    await vi.advanceTimersByTimeAsync(5000);
    expect(callback).not.toHaveBeenCalled();
  });

  it("keeps panel-free diagnostics while shutdown reaches every shared attachment", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const owner = createEnvironmentExecutionOwner();
    const runtime = owner.attachRuntime();
    const panel = owner.attach("panel");
    const entered = deferred();
    const gate = deferred();
    const work = task(async () => {
      entered.resolve();
      await gate.promise;
      throw new Error("runner failed");
    });
    work.failed.mockRejectedValue(new Error("settlement failed"));
    runtime.schedule("op", work);
    expect(runtime.instanceId).toBeUndefined();
    expect(runtime.hasActiveTasks()).toBe(true);
    expect(panel.hasActiveTasks()).toBe(false);
    await entered.promise;
    runtime.markShuttingDown();
    expect(runtime.isShuttingDown()).toBe(true);
    expect(panel.isShuttingDown()).toBe(true);
    gate.resolve();
    await new Promise<void>((resolve) => {
      const stop = runtime.onTasksSettled(() => {
        stop();
        resolve();
      });
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.hasActiveTasks()).toBe(false);
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
      "[radius] environment task finalization failed (operationId=op, scope=runtime): settlement failed"
    );
  });

  it("constructs without work and isolates runtime claims and shutdown markers", () => {
    const owner = createEnvironmentExecutionOwner();
    const other = createEnvironmentExecutionOwner();
    expect(owner.hasActiveEnvironmentTasks("panel")).toBe(false);
    owner.markEnvironmentInstanceShuttingDown("panel");
    expect(owner.isShuttingDown("panel")).toBe(true);
    expect(other.isShuttingDown("panel")).toBe(false);
    owner.markEnvironmentInstanceStarted("panel");
    expect(owner.isShuttingDown("panel")).toBe(false);
    const release = owner.claimVerificationMonitor("op");
    expect(release).toEqual(expect.any(Function));
    expect(owner.claimVerificationMonitor("op")).toBeUndefined();
    const otherRelease = other.claimVerificationMonitor("op");
    expect(otherRelease).toEqual(expect.any(Function));
    release?.();
    const replacementRelease = owner.claimVerificationMonitor("op");
    expect(replacementRelease).toEqual(expect.any(Function));
    release?.();
    expect(owner.claimVerificationMonitor("op")).toBeUndefined();
    replacementRelease?.();
    otherRelease?.();
  });

  it("serializes the same operation across subscribers without losing queued work", async () => {
    const owner = createEnvironmentExecutionOwner();
    const first = owner.attach("a");
    const second = owner.attach("b");
    const blocked = deferred();
    const entered = deferred();
    const order: string[] = [];
    const initial = task(async () => {
      order.push("a:start");
      entered.resolve();
      await blocked.promise;
    });
    first.schedule("op", initial);
    first.schedule(
      "op",
      task(async () => {
        order.push("a:command");
      })
    );
    second.schedule(
      "op",
      task(async () => {
        order.push("b:start");
      })
    );
    await entered.promise;
    expect(owner.hasActiveEnvironmentTasks("b")).toBe(true);
    expect(owner.hasActiveEnvironmentTasks("a")).toBe(true);
    expect(first.hasTask("op")).toBe(true);
    expect(order).toEqual(["a:start"]);
    blocked.resolve();
    await Promise.all([settled(owner, "a"), settled(owner, "b")]);
    expect(order).toEqual(["a:start", "a:command", "b:start"]);
    expect(initial.settling).not.toHaveBeenCalled();
    expect(initial.settled).not.toHaveBeenCalled();
    expect(first.hasTask("op")).toBe(false);
  });

  it("keeps a replacement active after the older same-ID task settles", async () => {
    const owner = createEnvironmentExecutionOwner();
    const first = owner.attach("same");
    const replacement = owner.attach("same");
    expect(replacement.generation).toBeGreaterThan(first.generation);
    const blocked = deferred();
    const entered = deferred();
    first.schedule(
      "op",
      task(async () => {})
    );
    replacement.schedule(
      "op",
      task(async () => {
        entered.resolve();
        await blocked.promise;
      })
    );
    expect(owner.hasActiveEnvironmentTasks("same")).toBe(true);
    await entered.promise;
    expect(owner.hasActiveEnvironmentTasks("same")).toBe(true);
    expect(replacement.hasTask("op")).toBe(true);
    const completed = deferred();
    const continuation = task(async () => {});
    continuation.settled.mockImplementation(completed.resolve);
    replacement.schedule("op", continuation);
    blocked.resolve();
    await completed.promise;
    expect(owner.hasActiveEnvironmentTasks("same")).toBe(false);
  });

  it("keeps distinct operations active through same-ID replacement", async () => {
    const owner = createEnvironmentExecutionOwner();
    const blocked = deferred();
    const completed = deferred();
    const first = task(async () => {});
    first.settled.mockImplementation(completed.resolve);
    owner.attach("same").schedule("old", first);
    owner.attach("same").schedule(
      "new",
      task(() => blocked.promise)
    );
    await completed.promise;
    expect(owner.hasActiveEnvironmentTasks("same")).toBe(true);
    blocked.resolve();
    await settled(owner, "same");
  });

  it("reports failures through the bound handler and continues after its rejection", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const owner = createEnvironmentExecutionOwner();
    const attachment = owner.attach("a");
    const error = new Error("provider unavailable");
    const initial = task(async () => {
      throw error;
    });
    initial.failed.mockRejectedValue(new Error("diagnostic save failed"));
    const next = task(async () => {});
    attachment.schedule("op", initial);
    attachment.schedule("op", next);
    await settled(owner, "a");
    expect(initial.failed).toHaveBeenCalledWith(error);
    expect(next.settling).toHaveBeenCalledOnce();
    expect(next.settled).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
      "[radius] environment task finalization failed (operationId=op, instanceId=a): diagnostic save failed"
    );
  });

  it("observes a failure-handler rejection without a successor and releases the task", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const owner = createEnvironmentExecutionOwner();
    const attachment = owner.attach("a");
    const error = new Error("provider unavailable");
    const final = task(async () => {
      throw error;
    });
    final.failed.mockRejectedValue(new Error("diagnostic save failed"));

    attachment.schedule("op", final);
    await settled(owner, "a");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(final.failed).toHaveBeenCalledExactlyOnceWith(error);
    expect(final.settling).toHaveBeenCalledOnce();
    expect(final.settled).toHaveBeenCalledOnce();
    expect(attachment.hasTask("op")).toBe(false);
    expect(owner.hasActiveEnvironmentTasks("a")).toBe(false);
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
      "[radius] environment task finalization failed (operationId=op, instanceId=a): diagnostic save failed"
    );
  });

  it("identifies the operation and instance for concurrent task failures", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const owner = createEnvironmentExecutionOwner();
    const first = owner.attach("panel-a");
    const second = owner.attach("panel-b");
    const blocked = deferred();
    for (const [attachment, operationId] of [
      [first, "op-1"],
      [first, "op-2"],
      [second, "op-1"]
    ] as const) {
      const work = task(async () => {
        await blocked.promise;
        throw new Error("provider unavailable");
      });
      work.failed.mockRejectedValue(new Error("diagnostic save failed"));
      attachment.schedule(operationId, work);
    }

    const completed = Promise.all([
      settled(owner, "panel-a"),
      settled(owner, "panel-b")
    ]);
    blocked.resolve();
    await completed;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(diagnostic).toHaveBeenCalledTimes(3);
    for (const identity of [
      "operationId=op-1, instanceId=panel-a",
      "operationId=op-2, instanceId=panel-a",
      "operationId=op-1, instanceId=panel-b"
    ]) {
      expect(diagnostic).toHaveBeenCalledWith(
        `[radius] environment task finalization failed (${identity}): diagnostic save failed`
      );
    }
  });

  it("unsubscribes idempotently and isolates throwing listeners before finalization", async () => {
    const owner = createEnvironmentExecutionOwner();
    const order: string[] = [];
    const abandoned = vi.fn();
    const stop = owner.onEnvironmentTasksSettled("a", abandoned);
    stop();
    stop();
    const stopThrowing = owner.onEnvironmentTasksSettled("a", () => {
      order.push("throwing");
      throw new Error("view closed");
    });
    const stopFollowing = owner.onEnvironmentTasksSettled("a", () => {
      order.push("following");
    });
    const work = task(async () => {});
    work.settling.mockImplementation(() => {
      order.push("settling");
    });
    work.settled.mockImplementation(() => {
      order.push("settled");
    });
    owner.attach("a").schedule("op", work);
    await settled(owner, "a");
    expect(abandoned).not.toHaveBeenCalled();
    expect(order).toEqual(["settling", "throwing", "following", "settled"]);
    stopThrowing();
    stopFollowing();
    const idle = vi.fn();
    const stopIdle = owner.onEnvironmentTasksSettled("a", idle);
    await Promise.resolve();
    expect(idle).toHaveBeenCalledOnce();
    stopIdle();
  });

  it("shares rollback claims and reconciliation timers across subscribers", async () => {
    vi.useFakeTimers();
    const owner = createEnvironmentExecutionOwner();
    const a = owner.attach("a");
    const b = owner.attach("b");
    const release = a.claimAutomaticRollback("op");
    expect(release).toEqual(expect.any(Function));
    expect(a.claimAutomaticRollback("op")).toBeUndefined();
    expect(b.claimAutomaticRollback("op")).toBeUndefined();
    release?.();
    const replacementRelease = b.claimAutomaticRollback("op");
    expect(replacementRelease).toEqual(expect.any(Function));
    release?.();
    expect(a.claimAutomaticRollback("op")).toBeUndefined();
    replacementRelease?.();
    const callback = vi.fn();
    a.scheduleReconciliation("op", callback);
    a.scheduleReconciliation("op", callback);
    b.scheduleReconciliation("op", callback);
    owner.markEnvironmentInstanceShuttingDown("a");
    await vi.advanceTimersByTimeAsync(4999);
    expect(callback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    // The provider callback, not storage, owns its shutdown predicate.
    expect(callback).toHaveBeenCalledOnce();
    a.scheduleReconciliation("op", callback);
    await vi.advanceTimersByTimeAsync(5000);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("does not use shutdown marking as task admission or discard settling work", async () => {
    const owner = createEnvironmentExecutionOwner();
    const attachment = owner.attach("a");
    const blocked = deferred();
    const running = task(() => blocked.promise);
    attachment.schedule("op", running);
    owner.markEnvironmentInstanceShuttingDown("a");
    const command = task(async () => {});
    attachment.schedule("op", command);
    expect(owner.hasActiveEnvironmentTasks("a")).toBe(true);
    blocked.resolve();
    await settled(owner, "a");
    expect(command.settled).toHaveBeenCalledOnce();
  });
});
