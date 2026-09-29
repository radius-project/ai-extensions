import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowCommandResult } from "./workflow-reads.js";
import {
  createWorkflowReadBudget,
  createWorkflowReadSession,
  isWorkflowReadLimitError
} from "./workflow-read-budget.js";

afterEach(() => vi.useRealTimers());

describe("one logical workflow read budget", () => {
  it("cleans up a sleep cancelled synchronously while its listener is registered", async () => {
    vi.useFakeTimers();
    const { clock } = createWorkflowReadSession().observe(100);
    const detach = vi.fn();
    await clock.sleep(50, {
      stopped: () => true,
      onStop: (listener) => {
        listener();
        return detach;
      }
    });
    expect(detach).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("supports ordinary and already-cancelled injected sleep callers without leaking timers", async () => {
    vi.useFakeTimers();
    const { clock } = createWorkflowReadSession().observe(100);
    const ordinary = clock.sleep(10);
    await vi.advanceTimersByTimeAsync(10);
    await ordinary;
    await clock.sleep(10, { stopped: () => true });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves the smaller nested page/output and command/time limits", async () => {
    vi.useFakeTimers();
    const supplied: unknown[] = [];
    const context = createWorkflowReadSession().observe(100);
    const outer = createWorkflowReadBudget(
      async (_args, options) => {
        supplied.push(options);
        return { code: 0, stdout: "12", stderr: "" };
      },
      1000,
      30,
      context
    );
    const inner = createWorkflowReadBudget(outer, 500, 10, context);
    await inner([], { timeout: 50, maxBuffer: 5 });
    await vi.advanceTimersByTimeAsync(20);
    await inner([], { timeout: 500 });
    expect(supplied).toEqual([
      { timeout: 50, maxBuffer: 5, signal: expect.any(AbortSignal) },
      { timeout: 80, maxBuffer: 8, signal: expect.any(AbortSignal) }
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["context", "caller"] as const)(
    "cancels through the %s signal before and during a read",
    async (source) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const context = createWorkflowReadSession().observe(
        100,
        source === "context" ? controller.signal : undefined
      );
      let signal: AbortSignal | undefined;
      let complete: (() => void) | undefined;
      const run = vi.fn(
        async (_args: string[], options: { signal?: AbortSignal }) => {
          signal = options.signal;
          await new Promise<void>((resolve) => {
            complete = resolve;
          });
          return { code: 0, stdout: "", stderr: "" };
        }
      );
      const bounded = createWorkflowReadBudget(run, 100, 10, context);
      const options = {
        timeout: 100,
        ...(source === "caller" ? { signal: controller.signal } : {})
      };
      const pending = bounded([], options).catch((error: unknown) => error);
      controller.abort();
      expect(await pending).toMatchObject({ reason: "cancelled" });
      expect(signal?.aborted).toBe(true);
      await expect(bounded([], options)).rejects.toMatchObject({
        reason: "cancelled"
      });
      expect(run).toHaveBeenCalledTimes(1);
      if (!complete) throw new Error("Command did not start");
      complete();
      await vi.runAllTimersAsync();
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it("rejects synchronous cancellation even when the command fulfills first", async () => {
    const controller = new AbortController();
    const context = createWorkflowReadSession().observe(100, controller.signal);
    const run = createWorkflowReadBudget(
      async () => {
        controller.abort();
        return { code: 0, stdout: "", stderr: "" };
      },
      100,
      10,
      context
    );
    await expect(run([], { timeout: 100 })).rejects.toMatchObject({
      reason: "cancelled"
    });
  });
  it.each([
    { code: 1, stdout: "123", stderr: "" },
    { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stdout: "12", stderr: "" }
  ])(
    "identifies a command truncated at its output limit: %j",
    async (result) => {
      const run = createWorkflowReadBudget(async () => result, 15000, 3);
      await expect(run([], { timeout: 15000 })).rejects.toMatchObject({
        reason: "output-limit"
      });
    }
  );
  it("shares elapsed time and UTF-8 output bytes across pages", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    const supplied: unknown[] = [];
    const run = createWorkflowReadBudget(
      async (_args, options) => {
        supplied.push(options);
        await vi.advanceTimersByTimeAsync(10);
        return { code: 0, stdout: "é", stderr: "!" };
      },
      100,
      10
    );
    await run([], { timeout: 100 });
    await run([], { timeout: 100 });
    expect(supplied).toEqual([
      { timeout: 100, maxBuffer: 10, signal: expect.any(AbortSignal) },
      { timeout: 90, maxBuffer: 7, signal: expect.any(AbortSignal) }
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["resolve", "reject"] as const)(
    "bounds an uncooperative runner and observes its late %s",
    async (mode) => {
      vi.useFakeTimers({
        toFake: ["performance", "setTimeout", "clearTimeout"]
      });
      let resolve: ((value: WorkflowCommandResult) => void) | undefined;
      let reject: ((error: Error) => void) | undefined;
      const completion = new Promise<WorkflowCommandResult>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      let signal: AbortSignal | undefined;
      const run = createWorkflowReadBudget((_args, options) => {
        signal = options.signal;
        return completion;
      }, 20);
      const result = run([], { timeout: 20 }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(20);
      const error = await result;
      expect(isWorkflowReadLimitError(error)).toBe(true);
      expect(error).toMatchObject({ reason: "timeout" });
      expect(signal?.aborted).toBe(true);
      if (!resolve || !reject) throw new Error("Deferred read not initialized");
      if (mode === "resolve") resolve({ code: 0, stdout: "late", stderr: "" });
      else reject(new Error("late failure"));
      await vi.runAllTimersAsync();
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it("rejects a result that consumed the deadline synchronously", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    const run = createWorkflowReadBudget(async () => {
      vi.advanceTimersByTime(21);
      return { code: 0, stdout: "", stderr: "" };
    }, 20);
    await expect(run([], { timeout: 20 })).rejects.toMatchObject({
      reason: "timeout"
    });
  });

  it("does not start another page after deadline or exact byte exhaustion", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    const underlying = vi.fn(async () => ({
      code: 0,
      stdout: "123",
      stderr: ""
    }));
    const run = createWorkflowReadBudget(underlying, 20, 3);
    await run([], { timeout: 20 });
    await expect(run([], { timeout: 20 })).rejects.toMatchObject({
      reason: "output-limit"
    });
    await vi.advanceTimersByTimeAsync(20);
    await expect(run([], { timeout: 20 })).rejects.toMatchObject({
      reason: "timeout"
    });
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  it("counts both streams and preserves unexpected rejection identity", async () => {
    const run = createWorkflowReadBudget(
      async () => ({ code: 0, stdout: "12", stderr: "34" }),
      15000,
      3
    );
    await expect(run([], { timeout: 15000 })).rejects.toMatchObject({
      reason: "output-limit"
    });
    const error = new Error("fixture failure");
    expect(isWorkflowReadLimitError(error)).toBe(false);
    await expect(
      createWorkflowReadBudget(() => Promise.reject(error))([], {
        timeout: 15000
      })
    ).rejects.toBe(error);
  });
});
