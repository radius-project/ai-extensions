import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkflowArtifactReader,
  type WorkflowRunner
} from "@radius-project/adapter-shared";
import { WORKFLOW_READ_LIMITS } from "@radius-project/core";
import { createWorkflowObservationScope } from "./workflow-observation-scope.js";

afterEach(() => vi.useRealTimers());

const target = { repo: "fixture/app", runId: 41 };
const rateLimited = () => ({
  code: 1,
  stdout: 'HTTP/2 429\n\n{"message":"rate limit"}',
  stderr: ""
});

describe("instance workflow observation ownership", () => {
  it("retains a missing rate deadline across polling and TTL expiry, but not a new instance", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => rateLimited());
    const create = () =>
      createWorkflowObservationScope((options) =>
        createWorkflowArtifactReader(options, run)
      );
    const scope = create();
    const reader = scope.reader(target);
    await reader.read(scope.observe().context);
    await vi.advanceTimersByTimeAsync(5000);
    await scope.reader(target).read(scope.observe().context);
    await vi.advanceTimersByTimeAsync(5001);
    const result = await scope.reader(target).read(scope.observe().context);
    expect(result).toMatchObject({
      status: "error",
      error: { decision: { state: "deferred", reason: "missing-deadline" } }
    });
    expect(run).toHaveBeenCalledTimes(1);
    const other = create();
    await other.reader(target).read(other.observe().context);
    expect(run).toHaveBeenCalledTimes(2);
    scope.stop();
    other.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps exactly 32 protected cooldowns across payload eviction and identity changes", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => rateLimited());
    const scope = createWorkflowObservationScope((options) =>
      createWorkflowArtifactReader(options, run)
    );
    for (let id = 1; id <= WORKFLOW_READ_LIMITS.cooldowns; id++) {
      const request = scope.observe({ login: "same-fixture-login" });
      await scope
        .reader({ ...target, runId: id, identity: request.identity })
        .read(request.context);
    }
    const request = scope.observe();
    const capacity = await scope
      .reader({ ...target, runId: 33 })
      .read(request.context);
    expect(capacity).toMatchObject({
      status: "error",
      error: {
        decision: { state: "deferred", reason: "capacity" },
        message: expect.stringContaining("32 protected")
      }
    });
    await vi.advanceTimersByTimeAsync(10001);
    const old = await scope
      .reader({ ...target, runId: 1, identity: "selected:1" })
      .read(scope.observe().context);
    expect(old).toMatchObject({
      status: "error",
      error: { decision: { reason: "missing-deadline" } }
    });
    expect(run).toHaveBeenCalledTimes(32);
    scope.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reuses a stable identity and target without sharing different selected executors", () => {
    const factory = vi.fn(
      (options: Parameters<typeof createWorkflowArtifactReader>[0]) =>
        createWorkflowArtifactReader(options, async () => {
          throw new Error("No reads expected");
        })
    );
    const scope = createWorkflowObservationScope(factory);
    const first = { login: "fixture" };
    const second = { login: "fixture" };
    expect(scope.observe(first).identity).toBe(scope.observe(first).identity);
    expect(scope.observe(first).identity).not.toBe(
      scope.observe(second).identity
    );
    const options = {
      ...target,
      identity: scope.observe(first).identity,
      environment: "dev",
      application: "app"
    };
    const reader = scope.reader(options);
    expect(scope.reader(options)).toBe(reader);
    expect(scope.reader({ ...options, application: "other" })).not.toBe(reader);
    expect(scope.reader({ ...options, environment: "other" })).not.toBe(reader);
    expect(
      scope.reader({ ...options, identity: scope.observe(second).identity })
    ).not.toBe(reader);
    const repository = scope.reader({ repo: target.repo });
    expect(repository).not.toBe(reader);
    expect(scope.reader({ repo: target.repo })).toBe(repository);
    expect(factory).toHaveBeenCalledTimes(5);
    scope.stop();
    scope.stop();
    expect(scope.stopped).toBe(true);
    expect(scope.observe().context.check()).toEqual({
      state: "stopped",
      reason: "cancelled"
    });
    expect(() => scope.reader(target)).toThrow("observation stopped");
  });

  it("cancels polling waits without waiting for the next five-second tick", async () => {
    vi.useFakeTimers();
    const scope = createWorkflowObservationScope(() => {
      throw new Error("No reader expected");
    });
    const wait = scope.delay(5000);
    expect(vi.getTimerCount()).toBe(1);
    scope.stop();
    await wait;
    expect(performance.now()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["resolve", "reject"] as const)(
    "stops local reads and fences late host %s after instance closure",
    async (mode) => {
      vi.useFakeTimers();
      let complete:
        ((value: Awaited<ReturnType<WorkflowRunner>>) => void) | undefined;
      let fail: ((error: Error) => void) | undefined;
      let signal: AbortSignal | undefined;
      const scope = createWorkflowObservationScope((options) =>
        createWorkflowArtifactReader(options, (_args, supplied) => {
          signal = supplied.signal;
          return new Promise((resolve, reject) => {
            complete = resolve;
            fail = reject;
          });
        })
      );
      const reader = scope.reader(target);
      const pending = reader
        .read(scope.observe().context)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(signal?.aborted).toBe(false);
      scope.stop();
      expect(await pending).toMatchObject({ reason: "cancelled" });
      expect(signal?.aborted).toBe(true);
      if (!complete || !fail) throw new Error("Host was not started");
      if (mode === "resolve")
        complete({
          code: 0,
          stdout: 'HTTP/2 200\n\n{"artifacts":[]}',
          stderr: ""
        });
      else fail(new Error("late host failure"));
      await vi.runAllTimersAsync();
      expect(reader.sequence).toBe(-1);
      expect(vi.getTimerCount()).toBe(0);
    }
  );
});
