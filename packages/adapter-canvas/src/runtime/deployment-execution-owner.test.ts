import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/support/browser/fakes.js";
import { successfulSelectedGhExecutor } from "../../test/support/server/selected-gh.js";
import { createWorkflowObservationScope } from "../server/services/workflow-observation-scope.js";
import {
  createDeploymentExecutionOwner,
  type DeploymentExecution,
  type DeploymentInvocation,
  type DeploymentTarget
} from "./deployment-execution-owner.js";

const TARGET: DeploymentTarget = {
  repo: "fixture/app",
  environment: "dev",
  branch: "feature/model",
  provider: "azure",
  appFile: ".radius/app.bicep",
  githubLogin: "fixture-user"
};
const EXECUTOR = successfulSelectedGhExecutor({
  login: TARGET.githubLogin,
  run: async () => {
    throw new Error("Unexpected GitHub command");
  }
});

function fixture() {
  let time = 0;
  let nextId = 0;
  const reportError = vi.fn();
  const newAttemptId = vi.fn(() => `attempt-${++nextId}`);
  const owner = createDeploymentExecutionOwner({
    now: () => time,
    newAttemptId,
    reportError,
    createObservation: () =>
      createWorkflowObservationScope(() => {
        throw new Error("Unexpected artifact read");
      })
  });
  const reserve = (
    target = TARGET,
    kind: "deploy" | "delete" | "abandon" = "deploy"
  ) => {
    const reservation = owner.reserve(target, kind);
    if (!reservation) throw new Error("Expected reservation");
    return reservation;
  };
  const begin = (
    target = TARGET,
    previous?: DeploymentInvocation,
    repair = false
  ) => {
    const reservation = reserve(target);
    const result = owner.begin({
      reservation,
      target,
      executor: EXECUTOR,
      previous,
      repair,
      state: { deployStatus: "in_progress", deployLogs: [] }
    });
    if (result.kind !== "resolved") throw new Error(result.kind);
    return { invocation: result.invocation, reservation };
  };
  return {
    owner,
    begin,
    reserve,
    reportError,
    newAttemptId,
    advance: (milliseconds: number) => {
      time += milliseconds;
    }
  };
}

describe("runtime deployment ownership", () => {
  it("counts unsettled work rather than saved tasks, snapshots, or current registrations", async () => {
    const { owner, begin } = fixture();
    const first = begin();
    expect(owner.hasPendingWork()).toBe(false);
    const hold = createDeferred<void>();
    const settled = vi.fn();
    const work = vi.fn(() => hold.promise);
    const task = owner.run(first.invocation, work, settled);
    const rejection = expect(task).rejects.toThrow("held failure");
    expect(owner.run(first.invocation, work, settled)).toBe(task);
    await Promise.resolve();
    expect(owner.hasPendingWork()).toBe(true);
    owner.release(first.reservation);
    const replacement = begin();
    expect(owner.hasPendingWork()).toBe(true);
    hold.reject(new Error("held failure"));
    await rejection;
    expect(settled).toHaveBeenCalledOnce();
    expect(owner.hasPendingWork()).toBe(false);
    expect(owner.snapshot(replacement.invocation)?.deployStatus).toBe(
      "in_progress"
    );
    const pending = createDeferred<void>();
    const second = owner.run(
      replacement.invocation,
      () => pending.promise,
      settled
    );
    await Promise.resolve();
    expect(owner.hasPendingWork()).toBe(true);
    owner.shutdown();
    expect(owner.hasPendingWork()).toBe(false);
    pending.resolve();
    await second;
    expect(settled).toHaveBeenCalledTimes(2);
  });
  it("normalizes only owned target state and invalidates a graph remembered from another source", () => {
    const { owner, reserve } = fixture();
    const state = {
      envName: "staging",
      appFile: "old.bicep",
      plannedRepo: "fixture/other",
      plannedBranch: "old",
      plannedResources: [{ id: "wrong" }],
      deployingResources: [{ id: "wrong" }],
      deployParams: { environment: "staging", appFile: "old.bicep" }
    };
    const begun = owner.begin({
      target: TARGET,
      reservation: reserve(),
      executor: EXECUTOR,
      state
    });
    if (begun.kind !== "resolved") throw new Error(begun.kind);
    expect(owner.snapshot(begun.invocation)).toMatchObject({
      envName: TARGET.environment,
      appFile: TARGET.appFile,
      deployParams: {
        targetRepo: TARGET.repo,
        branch: TARGET.branch,
        environment: TARGET.environment,
        provider: TARGET.provider,
        appFile: TARGET.appFile
      },
      plannedResources: [],
      deployingResources: []
    });
    expect(state.envName).toBe("staging");
    expect(state.deployParams.appFile).toBe("old.bicep");
    state.envName = "retargeted";
    expect(owner.execution(begun.invocation)?.state.envName).toBe("dev");
    owner.shutdown();
  });

  it.each(["", "another-login"])(
    "refuses an executor that is not authorized for account %j without consuming the reservation",
    (githubLogin) => {
      const { owner, reserve, newAttemptId } = fixture();
      const reservation = reserve();
      expect(() =>
        owner.begin({
          reservation,
          target: { ...TARGET, githubLogin },
          executor: EXECUTOR,
          state: {}
        })
      ).toThrow("must match the authorized GitHub account");
      expect(newAttemptId).not.toHaveBeenCalled();
      expect(owner.resolve()).toEqual({ kind: "missing" });
      expect(owner.activeReservation(TARGET)).toBe(reservation);
      const accepted = owner.begin({
        reservation,
        target: TARGET,
        executor: EXECUTOR,
        state: {}
      });
      if (accepted.kind !== "resolved") throw new Error(accepted.kind);
      expect(owner.execution(accepted.invocation)?.executor).toBe(EXECUTOR);
    }
  );

  it("matches account casing without changing the immutable target or executor", () => {
    const { owner, reserve } = fixture();
    const accepted = owner.begin({
      reservation: reserve(),
      target: { ...TARGET, githubLogin: TARGET.githubLogin.toUpperCase() },
      executor: EXECUTOR,
      state: {}
    });
    if (accepted.kind !== "resolved") throw new Error(accepted.kind);
    expect(accepted.invocation.target.githubLogin).toBe("FIXTURE-USER");
    expect(owner.execution(accepted.invocation)?.executor).toBe(EXECUTOR);
  });

  it("owns target identity and isolated snapshots without a panel", () => {
    const { owner, begin } = fixture();
    const target = { ...TARGET };
    const { invocation } = begin(target);
    target.branch = "another-branch";
    expect(invocation.target).toEqual(TARGET);
    expect(Object.isFrozen(invocation.target)).toBe(true);
    expect(Object.isFrozen(invocation)).toBe(true);
    expect(owner.resolve()).toEqual({ kind: "resolved", invocation });
    const snapshot = owner.snapshot(invocation)!;
    snapshot.deployLogs!.push("not an owner write");
    expect(owner.snapshot(invocation)?.deployLogs).toEqual([]);
    expect(snapshot.deployAttempt).toEqual({
      id: invocation.attemptId,
      targetRepo: TARGET.repo,
      environment: TARGET.environment,
      branch: TARGET.branch,
      provider: TARGET.provider,
      appFile: TARGET.appFile
    });
  });

  it("resolves explicit or unambiguous context without choosing the newest", () => {
    const { owner, begin } = fixture();
    expect(owner.resolve()).toEqual({ kind: "missing" });
    const first = begin();
    owner.release(first.reservation);
    const second = begin({ ...TARGET, branch: "another-branch" });
    expect(owner.resolve()).toEqual({
      kind: "ambiguous",
      choices: [first.invocation, second.invocation]
    });
    expect(
      owner.resolve({ repo: "FIXTURE/APP", branch: TARGET.branch })
    ).toEqual({
      kind: "resolved",
      invocation: first.invocation
    });
    expect(owner.resolve({ environment: "production" })).toEqual({
      kind: "missing"
    });
    expect(owner.resolve({ repo: "fixture/missing" })).toEqual({
      kind: "missing"
    });
    expect(owner.resolve({ attemptId: "missing" })).toEqual({ kind: "stale" });
    expect(owner.resolve({ attemptId: first.invocation.attemptId })).toEqual({
      kind: "resolved",
      invocation: first.invocation
    });
    expect(
      owner.resolve({
        attemptId: first.invocation.attemptId,
        branch: "another-branch"
      })
    ).toEqual({ kind: "retargeted" });
  });

  it("serializes the same repository/environment across all attachments and mutation kinds", () => {
    const { owner, reserve, advance } = fixture();
    const lease = reserve();
    expect(
      owner.reserve(
        { ...TARGET, repo: "FIXTURE/APP", environment: "DEV" },
        "delete"
      )
    ).toBeUndefined();
    advance(31 * 60 * 1000);
    expect(owner.activeReservation(TARGET)).toBe(lease);
    expect(owner.reserve(TARGET, "abandon")).toBeUndefined();
    owner.release({ ...lease });
    expect(owner.activeReservation(TARGET)).toBe(lease);
    owner.release(lease);
    const deletion = reserve(TARGET, "delete");
    advance(30 * 60 * 1000);
    expect(owner.activeReservation(TARGET)).toBeUndefined();
    const replacement = reserve(TARGET, "abandon");
    owner.release(deletion);
    expect(owner.activeReservation(TARGET)).toBe(replacement);
    expect(
      owner.reserve({ ...TARGET, environment: "different" }, "deploy")
    ).toBeDefined();
  });

  it("requires an unclaimed deploy reservation and a live previous invocation", () => {
    const { owner, reserve, begin } = fixture();
    const deletion = reserve(TARGET, "delete");
    expect(
      owner.begin({
        target: TARGET,
        executor: EXECUTOR,
        reservation: deletion,
        state: {}
      })
    ).toEqual({ kind: "stale" });
    owner.release(deletion);
    expect(
      owner.begin({
        target: TARGET,
        executor: EXECUTOR,
        reservation: deletion,
        state: {}
      })
    ).toEqual({ kind: "stale" });
    const first = begin();
    expect(
      owner.begin({
        target: TARGET,
        executor: EXECUTOR,
        reservation: first.reservation,
        state: {}
      })
    ).toEqual({ kind: "stale" });
    owner.release(first.reservation);
    const replacement = begin();
    expect(owner.snapshot(first.invocation)).toBeUndefined();
    expect(owner.execution(first.invocation)).toBeUndefined();
    owner.release(replacement.reservation);
    expect(
      owner.begin({
        target: TARGET,
        executor: EXECUTOR,
        reservation: reserve(),
        previous: first.invocation,
        state: {}
      })
    ).toEqual({ kind: "stale" });
  });

  it("gives repair invocations a new generation while retaining pinned identity", () => {
    const { owner, begin } = fixture();
    const first = begin();
    const observation = owner.execution(first.invocation)!.observation;
    owner.release(first.reservation);
    const repair = begin(TARGET, first.invocation, true);
    expect(repair.invocation.attemptId).toBe(first.invocation.attemptId);
    expect(repair.invocation.generation).toBe(first.invocation.generation + 1);
    expect(observation.stopped).toBe(true);
    expect(owner.execution(first.invocation)).toBeUndefined();
    expect(owner.execution(repair.invocation)).toBeDefined();
  });

  it.each([{ branch: "another-branch" }, { githubLogin: "another-login" }])(
    "refuses a retargeted repair %j",
    (override) => {
      const { owner, begin, reserve } = fixture();
      const first = begin();
      owner.release(first.reservation);
      expect(
        owner.begin({
          target: { ...TARGET, ...override },
          executor: EXECUTOR,
          reservation: reserve(),
          previous: first.invocation,
          repair: true,
          state: {}
        })
      ).toEqual({ kind: "retargeted" });
      expect(owner.execution(first.invocation)).toBeDefined();
    }
  );

  it("refuses a repair without prior context", () => {
    const { owner, reserve } = fixture();
    expect(
      owner.begin({
        target: TARGET,
        executor: EXECUTOR,
        reservation: reserve(),
        repair: true,
        state: {}
      })
    ).toEqual({ kind: "retargeted" });
  });

  it("does not infer repair authorization from a matching target alone", () => {
    const { owner, begin, reserve } = fixture();
    const first = begin();
    owner.release(first.reservation);
    expect(
      owner.begin({
        target: TARGET,
        executor: EXECUTOR,
        reservation: reserve(),
        repair: true,
        state: {}
      })
    ).toEqual({ kind: "retargeted" });
  });

  it("refuses an unrelated reservation without consuming it", () => {
    const { owner, reserve } = fixture();
    const reservation = reserve();
    expect(
      owner.begin({
        target: { ...TARGET, environment: "different" },
        executor: EXECUTOR,
        reservation,
        state: {}
      })
    ).toEqual({ kind: "stale" });
    expect(owner.activeReservation(TARGET)).toBe(reservation);
  });

  it("rejects empty or reused attempt identities without replacing prior work", () => {
    const { owner, begin, reserve, newAttemptId } = fixture();
    newAttemptId.mockReturnValueOnce("");
    const reservation = reserve();
    expect(() =>
      owner.begin({
        reservation,
        target: TARGET,
        executor: EXECUTOR,
        state: {}
      })
    ).toThrow("must be unique");
    owner.release(reservation);
    const first = begin();
    owner.release(first.reservation);
    const replacement = begin();
    owner.release(replacement.reservation);
    newAttemptId.mockReturnValueOnce(first.invocation.attemptId);
    expect(() =>
      owner.begin({
        reservation: reserve(),
        target: TARGET,
        executor: EXECUTOR,
        state: {}
      })
    ).toThrow("must be unique");
    expect(owner.execution(replacement.invocation)).toBeDefined();
  });

  it("detaches only the matching subscription and projects new generations", () => {
    const { owner, begin } = fixture();
    const first = begin();
    const listener = vi.fn((state) => {
      state.deployStatus = "presentation-only";
    });
    const detachOld = owner.subscribe(first.invocation, listener);
    const detachNew = owner.subscribe(first.invocation, listener);
    expect(owner.snapshot(first.invocation)?.deployStatus).toBe("in_progress");
    detachOld();
    detachOld();
    owner.publish(first.invocation);
    expect(listener).toHaveBeenCalledTimes(3);
    owner.release(first.reservation);
    const replacement = begin();
    expect(listener).toHaveBeenCalledTimes(4);
    owner.publish(first.invocation);
    expect(listener).toHaveBeenCalledTimes(4);
    detachNew();
    owner.publish(replacement.invocation);
    expect(listener).toHaveBeenCalledTimes(4);
    const staleDetach = owner.subscribe(first.invocation, listener);
    staleDetach();
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("reports failing subscribers without blocking other subscribers", () => {
    const { owner, begin, reportError } = fixture();
    const { invocation } = begin();
    const failure = new Error("projection failed");
    owner.subscribe(invocation, () => {
      throw failure;
    });
    const listener = vi.fn();
    owner.subscribe(invocation, listener);
    owner.publish(invocation);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledWith(failure);
    reportError.mockImplementation(() => {
      throw new Error("reporter failed");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      owner.publish(invocation);
      expect(error).toHaveBeenCalledWith(
        "[radius deployment-owner] Diagnostic failed:",
        expect.objectContaining({ message: "reporter failed" })
      );
    } finally {
      error.mockRestore();
    }
  });

  it("fences the rest of a publication if a subscriber shuts down", () => {
    const { owner, begin } = fixture();
    const { invocation } = begin();
    let stop = false;
    owner.subscribe(invocation, () => {
      if (stop) owner.shutdown();
    });
    const listener = vi.fn();
    owner.subscribe(invocation, listener);
    stop = true;
    owner.publish(invocation);
    expect(listener).toHaveBeenCalledOnce();
    owner.publish(invocation);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("fences reentrant publication when a subscriber replaces the invocation", () => {
    const { owner, begin } = fixture();
    const first = begin();
    owner.release(first.reservation);
    let replace = false;
    let replacement: DeploymentInvocation | undefined;
    owner.subscribe(first.invocation, () => {
      if (replace) {
        replace = false;
        replacement = begin().invocation;
      }
    });
    const listener = vi.fn();
    owner.subscribe(first.invocation, listener);
    replace = true;
    owner.publish(first.invocation);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[1][0].deployGeneration).toBe(
      replacement?.generation
    );
  });

  it("replaces both the selected context and an existing destination without leaking its subscribers", () => {
    const { owner, begin } = fixture();
    const first = begin();
    owner.release(first.reservation);
    const target = { ...TARGET, environment: "production" };
    const second = begin(target);
    const oldObservation = owner.execution(second.invocation)!.observation;
    const listener = vi.fn();
    owner.subscribe(second.invocation, listener);
    owner.release(second.reservation);
    const replacement = begin(target, first.invocation);
    expect(oldObservation.stopped).toBe(true);
    expect(owner.resolve()).toEqual({
      kind: "resolved",
      invocation: replacement.invocation
    });
    expect(owner.resolve({ attemptId: first.invocation.attemptId })).toEqual({
      kind: "stale"
    });
    expect(owner.resolve({ attemptId: second.invocation.attemptId })).toEqual({
      kind: "stale"
    });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("bounds diagnostic lines and offsets and redacts before publication", () => {
    const { owner, begin } = fixture();
    const { invocation } = begin();
    for (let index = 0; index < 4002; index++) {
      owner.appendLog(invocation, `line-${index}`);
    }
    expect(owner.snapshot(invocation)?.deployLogs).toHaveLength(4000);
    expect(owner.snapshot(invocation)?.deployLogBase).toBe(2);
    expect(owner.snapshot(invocation)?.deployLogs?.[0]).toBe("line-2");
    owner.appendLog(invocation, "x".repeat(4001));
    expect(owner.snapshot(invocation)?.deployLogs?.at(-1)).toHaveLength(4000);
    owner.appendLog(invocation, "client_secret=fixture-value");
    expect(owner.snapshot(invocation)?.deployLogs?.at(-1)).toBe(
      "client_secret=[REDACTED]"
    );
    owner.shutdown();
    owner.appendLog(invocation, "late log");
    expect(owner.snapshot(invocation)?.deployLogBase).toBe(4);
  });

  it("initializes absent diagnostics and rejects stale publication", () => {
    const { owner, reserve, begin } = fixture();
    const reservation = reserve();
    const result = owner.begin({
      target: TARGET,
      executor: EXECUTOR,
      reservation,
      state: {}
    });
    if (result.kind !== "resolved") throw new Error(result.kind);
    owner.appendLog(result.invocation, "first line");
    expect(owner.snapshot(result.invocation)?.deployLogs).toEqual([
      "first line"
    ]);
    owner.release(reservation);
    const replacement = begin();
    owner.appendLog(result.invocation, "stale line");
    expect(owner.snapshot(replacement.invocation)?.deployLogs).toEqual([]);
  });

  it("uses the retained executor's redactor before storing or publishing diagnostics", () => {
    const { owner, reserve } = fixture();
    const redact = vi.fn((text: string) =>
      text.replaceAll("private diagnostic", "[REDACTED]")
    );
    const result = owner.begin({
      target: TARGET,
      executor: { ...EXECUTOR, redact },
      reservation: reserve(),
      state: {}
    });
    if (result.kind !== "resolved") throw new Error(result.kind);
    const listener = vi.fn();
    owner.subscribe(result.invocation, listener);
    owner.appendLog(
      result.invocation,
      "prefix private diagnostic client_secret=fixture-value"
    );
    expect(redact).toHaveBeenCalledWith(
      "prefix private diagnostic client_secret=fixture-value"
    );
    expect(owner.snapshot(result.invocation)?.deployLogs).toEqual([
      "prefix [REDACTED] client_secret=[REDACTED]"
    ]);
    expect(listener.mock.lastCall?.[0].deployLogs).toEqual([
      "prefix [REDACTED] client_secret=[REDACTED]"
    ]);
    redact.mockImplementation(() => {
      throw new Error("redactor unavailable");
    });
    const before = owner.snapshot(result.invocation);
    expect(() =>
      owner.appendLog(result.invocation, "private diagnostic")
    ).toThrow("redactor unavailable");
    expect(owner.snapshot(result.invocation)).toEqual(before);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("shares one monitor and keeps credentials and the lease until actual settlement", async () => {
    const { owner, begin } = fixture();
    const { invocation, reservation } = begin();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const work = vi.fn(() => held);
    const settled = vi.fn(() => owner.release(reservation));
    const task = owner.run(invocation, work, settled);
    expect(owner.run(invocation, work, settled)).toBe(task);
    await Promise.resolve();
    owner.shutdown();
    owner.shutdown();
    expect(owner.stopped).toBe(true);
    expect(owner.execution(invocation)).toBeUndefined();
    expect(owner.snapshot(invocation)?.deployStatus).toBe("in_progress");
    expect(owner.activeReservation(TARGET)).toBe(reservation);
    expect(settled).not.toHaveBeenCalled();
    release();
    await task;
    expect(work).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledOnce();
    expect(owner.activeReservation(TARGET)).toBeUndefined();
    expect(owner.run(invocation, work, settled)).toBe(task);
  });

  it("releases a queued monitor without running it after shutdown", async () => {
    const { owner, begin } = fixture();
    const { invocation, reservation } = begin();
    const work = vi.fn(async () => {});
    const settled = vi.fn(() => owner.release(reservation));
    const task = owner.run(invocation, work, settled);
    owner.shutdown();
    await task;
    expect(work).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledOnce();
    expect(owner.reserve(TARGET, "deploy")).toBeUndefined();
    expect(owner.resolve()).toEqual({ kind: "shutdown" });
    expect(
      owner.begin({
        target: TARGET,
        executor: EXECUTOR,
        reservation,
        state: {}
      })
    ).toEqual({
      kind: "shutdown"
    });
    const listener = vi.fn();
    owner.subscribe(invocation, listener)();
    expect(listener).not.toHaveBeenCalled();
  });

  it("rejects a stale monitor and preserves its primary error if its finalizer also fails", async () => {
    const { owner, begin, reportError } = fixture();
    const first = begin();
    owner.release(first.reservation);
    const second = begin();
    const work = vi.fn(async () => {
      throw new Error("monitor failed");
    });
    const settled = vi.fn(() => {
      throw new Error("release failed");
    });
    await expect(owner.run(first.invocation, work, settled)).rejects.toThrow(
      "no longer active"
    );
    expect(work).not.toHaveBeenCalled();
    await expect(owner.run(second.invocation, work, settled)).rejects.toThrow(
      "monitor failed"
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "release failed" })
    );
  });

  it("refuses a not-yet-started monitor after shutdown", async () => {
    const { owner, begin } = fixture();
    const { invocation } = begin();
    owner.shutdown();
    const work = vi.fn(async () => {});
    const settled = vi.fn();
    await expect(owner.run(invocation, work, settled)).rejects.toThrow(
      "no longer active"
    );
    expect(work).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
  });

  it("does not start queued work for a replaced generation", async () => {
    const { owner, begin } = fixture();
    const first = begin();
    const work = vi.fn(async () => {});
    const settled = vi.fn(() => owner.release(first.reservation));
    const task = owner.run(first.invocation, work, settled);
    owner.release(first.reservation);
    const replacement = begin();
    await task;
    expect(work).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledOnce();
    expect(owner.activeReservation(TARGET)).toBe(replacement.reservation);
  });

  it("keeps a held task's executor while its old finalizer cannot release a replacement", async () => {
    const { owner, begin, reserve } = fixture();
    const first = begin();
    let finish = () => {};
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const work = vi.fn(async (execution: DeploymentExecution) => {
      await held;
      expect(execution.executor).toBe(EXECUTOR);
      expect(execution.invocation).toBe(first.invocation);
    });
    const settled = vi.fn(() => owner.release(first.reservation));
    const task = owner.run(first.invocation, work, settled);
    await Promise.resolve();
    owner.release(first.reservation);
    const executor = successfulSelectedGhExecutor({
      login: TARGET.githubLogin,
      run: async () => {
        throw new Error("Unexpected replacement command");
      }
    });
    const reservation = reserve();
    try {
      const next = owner.begin({
        reservation,
        target: TARGET,
        executor,
        previous: first.invocation,
        repair: true,
        state: { deployStatus: "in_progress" }
      });
      if (next.kind !== "resolved") throw new Error(next.kind);
      expect(next.invocation.attemptId).toBe(first.invocation.attemptId);
      expect(next.invocation.generation).toBeGreaterThan(
        first.invocation.generation
      );
      finish();
      await task;
      expect(settled).toHaveBeenCalledOnce();
      expect(owner.activeReservation(TARGET)).toBe(reservation);
      expect(owner.execution(next.invocation)?.executor).toBe(executor);
    } finally {
      finish();
      await task;
      owner.shutdown();
      owner.release(reservation);
    }
  });
});
