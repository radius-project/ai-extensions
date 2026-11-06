import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDeploymentOwner,
  type DeploymentTarget
} from "./deployment-owner.js";

const target: DeploymentTarget = {
  repo: "fixture/app",
  environment: "dev",
  branch: "topic",
  provider: "azure",
  appFile: ".radius/app.bicep"
};

function fixture() {
  let counter = 0;
  let now = 0;
  const reportError = vi.fn();
  const owner = createDeploymentOwner<{ status: string }>({
    now: () => now,
    id: () => String(++counter),
    reportError
  });
  function begin(input = target, attemptId?: string) {
    const reservation = owner.reserve(input, "deploy");
    if (!reservation) throw new Error("Test target is reserved.");
    const invocation = owner.begin(
      input,
      { status: "pending" },
      reservation,
      attemptId
    );
    return { invocation, reservation };
  }
  return { owner, begin, reportError, advance: (ms: number) => (now += ms) };
}

function deferred() {
  let resolve: () => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

afterEach(() => vi.useRealTimers());

describe("runtime deployment ownership", () => {
  it.each(["success", "failure"] as const)(
    "invalidates observable evidence while retaining issued work through %s",
    async (outcome) => {
      const { owner, begin, advance } = fixture();
      const { invocation, reservation } = begin();
      owner.release(reservation);
      const done = deferred();
      const entered = deferred();
      const subscriber = vi.fn();
      owner.subscribe(invocation, subscriber);
      const work = owner.run(invocation, () => {
        entered.resolve();
        return done.promise;
      });
      await entered.promise;
      expect(owner.retire(invocation)).toBe(false);
      expect(owner.invalidate(invocation)).toBe(true);
      expect(owner.invalidate(invocation)).toBe(false);
      expect(invocation.signal.aborted).toBe(true);
      expect(owner.lookup()).toEqual({ kind: "missing" });
      expect(owner.lookupTarget(target)).toEqual({ kind: "missing" });
      expect(owner.lookup({ attemptId: invocation.attemptId }).kind).toBe(
        "missing"
      );
      expect(
        owner.lookup({ observationId: invocation.observationId }).kind
      ).toBe("missing");
      expect(owner.claim(invocation, "retry")).toBe(false);
      await expect(owner.run(invocation, async () => {})).rejects.toThrow(
        "no longer active"
      );
      advance(31 * 60 * 1000);
      expect(
        owner.reserve({ ...target, environment: "DEV" }, "delete")
      ).toBeNull();
      expect(owner.hasActiveWork()).toBe(true);
      owner.publish(invocation);
      expect(subscriber).not.toHaveBeenCalled();
      if (outcome === "failure") {
        const rejected = expect(work).rejects.toThrow("delivery failed");
        done.reject(new Error("delivery failed"));
        await rejected;
      } else {
        done.resolve();
        await work;
      }
      expect(owner.hasActiveWork()).toBe(false);
      const next = begin();
      expect(owner.invalidate(invocation)).toBe(false);
      expect(owner.lookup()).toEqual({
        kind: "found",
        invocation: next.invocation
      });
      expect(subscriber).not.toHaveBeenCalled();
    }
  );

  it("drains hidden work and excludes it from unbound status selection", async () => {
    const { owner, begin } = fixture();
    const { invocation } = begin();
    const done = deferred();
    const entered = deferred();
    const work = owner.run(invocation, () => {
      entered.resolve();
      return done.promise;
    });
    await entered.promise;
    owner.invalidate(invocation);
    const other = begin({ ...target, environment: "staging" }).invocation;
    expect(owner.lookup()).toEqual({ kind: "found", invocation: other });
    begin({ ...target, repo: "fixture/other" });
    expect(owner.lookup()).toEqual({ kind: "ambiguous" });
    expect(await owner.shutdown(0)).toEqual({
      complete: false,
      pending: [invocation.observationId]
    });
    done.resolve();
    await work;
    expect(await owner.shutdown(0)).toEqual({ complete: true, pending: [] });
  });

  it("fences work invalidated before execution", async () => {
    const { owner, begin } = fixture();
    const { invocation } = begin();
    const callback = vi.fn(async () => {});
    const work = owner.run(invocation, callback);
    owner.invalidate(invocation);
    await expect(work).rejects.toThrow("stopped before execution");
    expect(callback).not.toHaveBeenCalled();
    expect(owner.hasActiveWork()).toBe(false);
  });

  it("distinguishes no attempt from an admitted pending attempt", () => {
    const { owner, begin } = fixture();
    expect(owner.lookup()).toEqual({ kind: "missing" });
    const { invocation } = begin();
    expect(owner.lookup()).toEqual({ kind: "found", invocation });
    expect(owner.lookup({ observationId: invocation.observationId })).toEqual({
      kind: "found",
      invocation
    });
    expect(owner.lookup({ attemptId: invocation.attemptId })).toEqual({
      kind: "found",
      invocation
    });
  });

  it("never interprets observation identity as repair authority", () => {
    const { owner, begin } = fixture();
    const { invocation } = begin();
    expect(owner.lookup({ attemptId: invocation.observationId })).toEqual({
      kind: "missing"
    });
    expect(owner.lookup({ observationId: invocation.attemptId })).toEqual({
      kind: "missing"
    });
    expect(owner.lookup({ attemptId: "", observationId: "" })).toEqual({
      kind: "invalid"
    });
    expect(owner.lookup({ attemptId: "" })).toEqual({ kind: "missing" });
    expect(owner.lookup({ observationId: "" })).toEqual({ kind: "missing" });
  });

  it("refuses ambiguous unbound lookup across independent targets", () => {
    const { owner, begin } = fixture();
    begin();
    begin({ ...target, environment: "other" });
    expect(owner.lookup()).toEqual({ kind: "ambiguous" });
  });

  it("reattaches by exact target without selecting another environment or a retired attempt", () => {
    const { owner, begin } = fixture();
    const first = begin();
    const other = begin({ ...target, environment: "staging" });
    expect(
      owner.lookupTarget({ repo: "FIXTURE/APP", environment: "dev" })
    ).toEqual({
      kind: "found",
      invocation: first.invocation
    });
    expect(
      owner.lookupTarget({ repo: "fixture/app", environment: "DEV" })
    ).toEqual({
      kind: "found",
      invocation: first.invocation
    });
    expect(
      owner.lookupTarget({ repo: "fixture/app", environment: "staging" })
    ).toEqual({
      kind: "found",
      invocation: other.invocation
    });
    expect(
      owner.lookupTarget({ repo: "fixture/other", environment: "dev" })
    ).toEqual({
      kind: "missing"
    });
    owner.release(first.reservation);
    const replacement = begin();
    expect(owner.lookupTarget(target)).toEqual({
      kind: "found",
      invocation: replacement.invocation
    });
    owner.retire(replacement.invocation);
    expect(owner.lookupTarget(target)).toEqual({ kind: "missing" });
  });

  it("shares reservations across panels and mutation kinds", () => {
    const { owner, begin } = fixture();
    const { reservation } = begin();
    expect(
      owner.reserve({ ...target, repo: "FIXTURE/APP" }, "delete")
    ).toBeNull();
    expect(owner.reserve(target, "abandon")).toBeNull();
    expect(
      owner.reserve({ ...target, environment: "DEV" }, "deploy")
    ).toBeNull();
    owner.release(reservation);
    expect(owner.reserve(target, "delete")).not.toBeNull();
  });

  it.each(["deploy", "delete", "abandon"] as const)(
    "excludes every mutation while %s owns a differently cased target",
    (kind) => {
      const { owner } = fixture();
      const reserved = owner.reserve(target, kind);
      expect(reserved?.target).toEqual(target);
      for (const next of ["deploy", "delete", "abandon"] as const)
        expect(
          owner.reserve({ repo: "FIXTURE/APP", environment: "DEV" }, next)
        ).toBeNull();
    }
  );

  it("preserves environment spelling and refuses case-only repair retargeting at the owner boundary", () => {
    const { owner, begin } = fixture();
    const first = begin();
    owner.release(first.reservation);
    const variant = { ...target, environment: "DEV" };
    const reservation = owner.reserve(variant, "deploy");
    if (!reservation) throw new Error("Missing reservation");
    expect(() =>
      owner.begin(
        variant,
        { status: "pending" },
        reservation,
        first.invocation.attemptId
      )
    ).toThrow("The repair target changed.");
    expect(first.invocation.target.environment).toBe("dev");
    expect(reservation.target.environment).toBe("DEV");
  });

  it.each(["repo", "environment"] as const)("rejects missing %s", (field) => {
    const { owner } = fixture();
    expect(() => owner.reserve({ ...target, [field]: " " }, "deploy")).toThrow(
      "requires a repository and environment"
    );
  });

  it("expires a reservation without letting a late release clear its replacement", () => {
    const { owner, begin, advance } = fixture();
    const { reservation } = begin();
    advance(30 * 60 * 1000);
    const replacement = owner.reserve(
      { ...target, environment: "DEV" },
      "delete"
    );
    expect(replacement).not.toBeNull();
    owner.release(reservation);
    expect(owner.reserve(target, "abandon")).toBeNull();
  });

  it("refuses admission without the current unexpired deploy reservation", () => {
    const { owner, begin, advance } = fixture();
    const { reservation } = begin();
    const state = { status: "pending" };
    expect(() =>
      owner.begin({ ...target, environment: "other" }, state, reservation)
    ).toThrow("no longer owns");
    advance(30 * 60 * 1000);
    expect(() => owner.begin(target, state, reservation)).toThrow(
      "no longer owns"
    );
    const deletion = owner.reserve(target, "delete");
    if (!deletion) throw new Error("Expected delete reservation.");
    expect(() => owner.begin(target, state, deletion)).toThrow(
      "no longer owns"
    );
  });

  it("keeps active targets reserved beyond lease expiry and refuses retirement", async () => {
    const { owner, begin, advance } = fixture();
    const { invocation } = begin();
    const work = deferred();
    const running = owner.run(invocation, () => work.promise);
    expect(owner.hasActiveWork()).toBe(true);
    advance(31 * 60 * 1000);
    expect(owner.reserve(target, "delete")).toBeNull();
    expect(owner.retire(invocation)).toBe(false);
    work.resolve();
    await running;
    expect(owner.hasActiveWork()).toBe(false);
    expect(owner.reserve(target, "delete")).not.toBeNull();
    expect(owner.retire(invocation)).toBe(true);
    expect(owner.lookup()).toEqual({ kind: "missing" });
    expect(owner.retire(invocation)).toBe(false);
  });

  it("increments repair generation and invalidates old observations and claims", () => {
    const { owner, begin } = fixture();
    const first = begin();
    expect(owner.claim(first.invocation, "repair")).toBe(true);
    expect(owner.claim(first.invocation, "repair")).toBe(false);
    owner.release(first.reservation);
    const second = begin(target, first.invocation.attemptId);
    expect(second.invocation.generation).toBe(2);
    expect(first.invocation.signal.aborted).toBe(true);
    expect(
      owner.lookup({ observationId: first.invocation.observationId })
    ).toEqual({
      kind: "missing"
    });

    expect(owner.claim(first.invocation, "repair")).toBe(false);
    expect(owner.claim(second.invocation, "repair")).toBe(true);
    owner.releaseClaim(first.invocation, "repair");
    expect(owner.claim(second.invocation, "repair")).toBe(false);
    owner.releaseClaim(second.invocation, "repair");
    expect(owner.claim(second.invocation, "repair")).toBe(true);
  });

  it("replaces a settled same-target attempt on an ordinary repeat", () => {
    const { owner, begin } = fixture();
    const first = begin();
    owner.release(first.reservation);
    const second = begin();
    expect(second.invocation.attemptId).not.toBe(first.invocation.attemptId);
    expect(second.invocation.generation).toBeGreaterThan(
      first.invocation.generation
    );
    expect(owner.lookup()).toEqual({
      kind: "found",
      invocation: second.invocation
    });
    expect(owner.isCurrent(first.invocation)).toBe(false);
  });

  it("refuses reusing a live reservation to replace or repair active work", async () => {
    const { owner, begin } = fixture();
    const { invocation, reservation } = begin();
    const work = deferred();
    const running = owner.run(invocation, () => work.promise);
    for (const attemptId of [undefined, invocation.attemptId]) {
      expect(() =>
        owner.begin(target, { status: "pending" }, reservation, attemptId)
      ).toThrow("target is still running");
    }
    expect(owner.lookup()).toEqual({ kind: "found", invocation });
    work.resolve();
    await running;
  });

  it("rejects nonexistent and retargeted repair attempts", () => {
    const { owner, begin } = fixture();
    const first = begin();
    owner.release(first.reservation);
    expect(() => begin(target, "attempt:missing")).toThrow("no longer current");
    const reservation = owner.reserve(
      { ...target, environment: "other" },
      "deploy"
    );
    if (!reservation) throw new Error("Expected independent reservation.");
    expect(() =>
      owner.begin(
        { ...target, environment: "other" },
        { status: "pending" },
        reservation,
        first.invocation.attemptId
      )
    ).toThrow("repair target changed");
  });

  it("rejects identity collisions without replacing the existing attempt", () => {
    const owner = createDeploymentOwner({
      now: () => 0,
      id: () => "same",
      reportError: vi.fn()
    });
    const one = owner.reserve(target, "deploy");
    const two = owner.reserve({ ...target, environment: "other" }, "deploy");
    if (!one || !two) throw new Error("Expected independent reservations.");
    const first = owner.begin(target, {}, one);
    expect(() =>
      owner.begin({ ...target, environment: "other" }, {}, two)
    ).toThrow("duplicate");
    expect(owner.lookup()).toEqual({ kind: "found", invocation: first });
    owner.retire(first);
    owner.release(one);
    const replacement = owner.reserve(target, "deploy");
    if (!replacement) throw new Error("Expected available reservation.");
    expect(() => owner.begin(target, {}, replacement)).toThrow("duplicate");
    expect(owner.lookup({ observationId: first.observationId })).toEqual({
      kind: "missing"
    });
  });

  it("publishes to subscribers without letting a failed view lose the result", () => {
    const { owner, begin, reportError } = fixture();
    const { invocation } = begin();
    const error = new Error("view unavailable");
    const listener = vi.fn();
    const detach = owner.subscribe(invocation, listener);
    owner.subscribe(invocation, () => {
      throw error;
    });
    invocation.state.status = "complete";
    owner.publish(invocation);
    expect(listener).toHaveBeenCalledWith(invocation);
    expect(reportError).toHaveBeenCalledWith(error);
    detach();
    owner.publish(invocation);
    expect(listener).toHaveBeenCalledTimes(1);
    owner.retire(invocation);
    expect(() => owner.subscribe(invocation, listener)).toThrow("superseded");
    owner.publish(invocation);
    expect(reportError).toHaveBeenCalledTimes(2);
  });

  it("detaches a subscriber without cancelling background work", async () => {
    const { owner, begin } = fixture();
    const { invocation } = begin();
    const work = deferred();
    const listener = vi.fn();
    const detach = owner.subscribe(invocation, listener);
    const running = owner.run(invocation, () => work.promise);
    detach();
    expect(invocation.signal.aborted).toBe(false);
    expect(owner.hasActiveWork()).toBe(true);
    work.resolve();
    await running;
    expect(listener).not.toHaveBeenCalled();
  });

  it("propagates task failure and removes only the settled task", async () => {
    const { owner, begin } = fixture();
    const { invocation } = begin();
    const work = deferred();
    const running = owner.run(invocation, () => work.promise);
    const failure = new Error("monitor failed");
    await expect(
      owner.run(invocation, async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(owner.isActive(invocation)).toBe(true);
    work.resolve();
    await running;
    expect(owner.isActive(invocation)).toBe(false);
  });

  it("fences queued work and new admission during shutdown", async () => {
    const { owner, begin } = fixture();
    const { invocation, reservation } = begin();
    const work = vi.fn(async () => {});
    const running = owner.run(invocation, work);
    const result = owner.shutdown(100);
    await expect(running).rejects.toThrow("stopped before execution");
    await expect(result).resolves.toEqual({ complete: true, pending: [] });
    expect(work).not.toHaveBeenCalled();
    expect(owner.reserve(target, "deploy")).toBeNull();
    expect(owner.claim(invocation, "notice")).toBe(false);
    expect(owner.isShuttingDown()).toBe(true);
    expect(invocation.signal.aborted).toBe(true);
    expect(() =>
      owner.begin(target, { status: "pending" }, reservation)
    ).toThrow("shutting down");
    await expect(owner.run(invocation, work)).rejects.toThrow(
      "no longer active"
    );
  });

  it("reports bounded incomplete shutdown while preserving issued settlement", async () => {
    vi.useFakeTimers();
    const { owner, begin } = fixture();
    const { invocation } = begin();
    const work = deferred();
    const entered = deferred();
    const running = owner.run(invocation, async () => {
      entered.resolve();
      await work.promise;
      invocation.state.status = "complete";
    });
    await entered.promise;
    const stopping = owner.shutdown(100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(stopping).resolves.toEqual({
      complete: false,
      pending: [invocation.observationId]
    });
    expect(owner.isCurrent(invocation)).toBe(true);
    work.resolve();
    await running;
    expect(invocation.state.status).toBe("complete");
    await expect(owner.shutdown(0)).resolves.toEqual({
      complete: true,
      pending: []
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fences queued admission and refuses admission after shutdown", async () => {
    const { owner } = fixture();
    const work = vi.fn(async () => "admitted");
    const admission = owner.trackAdmission(work);
    const stopping = owner.shutdown(100);
    await expect(admission).rejects.toThrow("shutting down");
    await stopping;
    await expect(owner.trackAdmission(work)).rejects.toThrow("shutting down");
    expect(work).not.toHaveBeenCalled();
  });

  it("includes held admission in bounded shutdown diagnostics", async () => {
    vi.useFakeTimers();
    const { owner } = fixture();
    const work = deferred();
    const entered = deferred();
    const admission = owner.trackAdmission(async () => {
      entered.resolve();
      await work.promise;
    });
    await entered.promise;
    const stopping = owner.shutdown(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await stopping).toEqual({
      complete: false,
      pending: [expect.stringMatching(/^admission:/)]
    });
    work.resolve();
    await admission;
    expect(owner.hasActiveWork()).toBe(false);
  });

  it.each([-1, Infinity, NaN])(
    "rejects invalid shutdown budget %s",
    async (budget) => {
      const { owner } = fixture();
      await expect(owner.shutdown(budget)).rejects.toThrow(
        "finite non-negative"
      );
      expect(owner.isShuttingDown()).toBe(false);
    }
  );
});
