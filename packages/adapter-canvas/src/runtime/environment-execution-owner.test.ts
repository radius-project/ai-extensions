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
  it("constructs without work and isolates runtime claims and shutdown markers", () => {
    const owner = createEnvironmentExecutionOwner();
    const other = createEnvironmentExecutionOwner();
    expect(owner.hasActiveEnvironmentTasks("panel")).toBe(false);
    owner.markEnvironmentInstanceShuttingDown("panel");
    expect(owner.isShuttingDown("panel")).toBe(true);
    expect(other.isShuttingDown("panel")).toBe(false);
    owner.markEnvironmentInstanceStarted("panel");
    expect(owner.isShuttingDown("panel")).toBe(false);
    expect(owner.claimVerificationMonitor("op")).toBe(true);
    expect(owner.claimVerificationMonitor("op")).toBe(false);
    expect(other.claimVerificationMonitor("op")).toBe(true);
    owner.releaseVerificationMonitor("op");
    expect(owner.claimVerificationMonitor("op")).toBe(true);
  });

  it("chains an attachment's commands but not another panel's same operation", async () => {
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
    await settled(owner, "b");
    expect(owner.hasActiveEnvironmentTasks("a")).toBe(true);
    expect(first.hasTask("op")).toBe(true);
    expect(order).toEqual(["a:start", "b:start"]);
    blocked.resolve();
    await settled(owner, "a");
    expect(order).toEqual(["a:start", "b:start", "a:command"]);
    expect(initial.settling).not.toHaveBeenCalled();
    expect(initial.settled).not.toHaveBeenCalled();
    expect(first.hasTask("op")).toBe(false);
  });

  it("retains instance-ID aggregation and operation-set settlement on replacement", async () => {
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
    // The inherited set is not a reference counter. Finishing the old
    // attachment removes the shared operation ID, even if the new one runs.
    expect(owner.hasActiveEnvironmentTasks("same")).toBe(false);
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
      "[radius] environment task finalization failed: diagnostic save failed"
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
      "[radius] environment task finalization failed: diagnostic save failed"
    );
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

  it("preserves per-attachment rollback claims and reconciliation timer release", async () => {
    vi.useFakeTimers();
    const owner = createEnvironmentExecutionOwner();
    const a = owner.attach("a");
    const b = owner.attach("b");
    expect(a.claimAutomaticRollback("op")).toBe(true);
    expect(a.claimAutomaticRollback("op")).toBe(false);
    expect(b.claimAutomaticRollback("op")).toBe(true);
    a.releaseAutomaticRollback("op");
    expect(a.claimAutomaticRollback("op")).toBe(true);
    const callback = vi.fn();
    a.scheduleReconciliation("op", callback);
    a.scheduleReconciliation("op", callback);
    b.scheduleReconciliation("op", callback);
    owner.markEnvironmentInstanceShuttingDown("a");
    await vi.advanceTimersByTimeAsync(4999);
    expect(callback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    // The provider callback, not storage, owns its shutdown predicate.
    expect(callback).toHaveBeenCalledTimes(2);
    a.scheduleReconciliation("op", callback);
    await vi.advanceTimersByTimeAsync(5000);
    expect(callback).toHaveBeenCalledTimes(3);
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
