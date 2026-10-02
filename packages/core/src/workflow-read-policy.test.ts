import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkflowReadContext,
  createWorkflowReadCooldowns,
  isSecondaryWorkflowRateLimitMessage,
  WORKFLOW_READ_LIMITS,
  type WorkflowReadClock
} from "./workflow-read-policy.js";
import type { WorkflowResponseMetadata } from "./workflow-read-metadata.js";

afterEach(() => vi.useRealTimers());

type Metadata = Extract<WorkflowResponseMetadata, { source: "gh-api-include" }>;
function response(status = 503, changes: Partial<Metadata> = {}) {
  return {
    ok: status === 200,
    metadata: {
      source: "gh-api-include",
      status,
      classification: status === 429 ? "rate-limit" : "other",
      receivedAtEpochMilliseconds: 100000,
      retryAfter: { state: "absent" },
      rateLimitReset: { state: "absent" },
      serverDate: { state: "absent" },
      rateLimitRemaining: null,
      ...changes
    } satisfies Metadata
  };
}

function fixture(timeout = 15000, jitter = 0) {
  let time = 0;
  let stopped = false;
  const waits: number[] = [];
  const clock: WorkflowReadClock = {
    monotonic: () => time,
    wall: () => 100000,
    jitter: () => jitter,
    sleep: async (ms) => {
      waits.push(ms);
      time += ms;
    }
  };
  const cooldowns = createWorkflowReadCooldowns(clock.monotonic);
  const create = () =>
    createWorkflowReadContext({
      clock,
      cooldowns,
      timeout,
      stopped: () => stopped
    });
  return {
    clock,
    cooldowns,
    context: create(),
    create,
    waits,
    advance: (ms: number) => (time += ms),
    stop: () => (stopped = true)
  };
}

describe("bounded workflow read policy", () => {
  it("retains one active cooldown slot for concurrent base reads of the same target", async () => {
    const f = fixture();
    const run = vi.fn(async () => response(200));
    const results = await Promise.all([
      f.context.read("run", 15000, run),
      f.create().read("run", 15000, run)
    ]);
    expect(results.map((result) => result.decision)).toEqual([
      { state: "ready" },
      { state: "ready" }
    ]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(f.cooldowns.check("run")).toEqual({ state: "ready" });
  });

  it("supports primary 403 timing without a secondary classifier", async () => {
    const f = fixture();
    let calls = 0;
    const result = await f.context.read("run", 15000, async () =>
      ++calls === 1 ?
        response(403, {
          classification: "rate-limit",
          retryAfter: { state: "delay", milliseconds: 1000 }
        })
      : response(200)
    );
    expect(result.decision).toEqual({ state: "ready" });
    expect(f.waits).toEqual([1000]);
    expect(calls).toBe(2);
  });
  it.each([
    ["You have exceeded a SECONDARY RATE LIMIT. Wait 5 seconds.", true],
    ["API rate limit exceeded", false],
    ["", false]
  ] as const)(
    "recognizes secondary classification without extracting message timing: %s",
    (message, expected) => {
      expect(isSecondaryWorkflowRateLimitMessage(message)).toBe(expected);
    }
  );

  it("requires a secondary deadline independently of an exhausted primary quota", async () => {
    const f = fixture();
    const read = vi.fn(async () =>
      response(403, {
        classification: "rate-limit",
        rateLimitRemaining: 0,
        serverDate: { state: "deadline", epochMilliseconds: 100000 },
        rateLimitReset: { state: "deadline", epochMilliseconds: 101000 }
      })
    );
    expect(
      (await f.context.read("run", 15000, read, () => true)).decision
    ).toEqual({ state: "deferred", reason: "missing-deadline" });
    expect(read).toHaveBeenCalledTimes(1);
    expect(f.waits).toEqual([]);
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid retry receipt %s without spending credits",
    (count) => {
      const f = fixture();
      expect(() => f.context.chargeRetries(count)).toThrow(
        "nonnegative integer"
      );
      expect(f.context.chargeRetries(2)).toBe(true);
    }
  );

  it("shares observation identity and retry meters across derived phases without charging receipts twice", async () => {
    const f = fixture();
    const first = { extraGets: 0 };
    const second = { extraGets: 0 };
    const derived = f.context
      .withRetryMeter(first)
      .limit(10000)
      .withCancellation({ stopped: () => false })
      .withRetryMeter(second);
    expect(derived.observation).toBe(f.context.observation);
    expect(f.create().observation).not.toBe(f.context.observation);
    expect(derived.chargeRetries(0)).toBe(true);
    let calls = 0;
    expect(
      (
        await derived.read("run", 10000, async () =>
          response(++calls === 1 ? 503 : 200)
        )
      ).decision
    ).toEqual({ state: "ready" });
    expect(first.extraGets).toBe(1);
    expect(second.extraGets).toBe(1);
    expect(f.context.chargeRetries(1)).toBe(true);
    expect(f.context.chargeRetries(1)).toBe(false);
    expect(f.context.chargeRetries(0)).toBe(true);
    expect(first.extraGets).toBe(1);
    const exhausted = await derived.read("jobs", 10000, async () => {
      calls++;
      return response(503);
    });
    expect(exhausted.decision).toEqual({
      state: "exhausted",
      reason: "attempts"
    });
    expect(calls).toBe(3);
  });
  it("does not dispatch when synchronous admission reaches the exact deadline", async () => {
    const f = fixture();
    let ticks = 0;
    f.clock.monotonic = () => (++ticks === 1 ? 14999 : 15000);
    const read = vi.fn(async () => response(200));
    expect(await f.context.read("run", 15000, read)).toEqual({
      response: null,
      decision: { state: "exhausted", reason: "elapsed" }
    });
    expect(read).not.toHaveBeenCalled();
  });
  it("supports clock ports without cancellation callbacks and preserves synchronous sleep failures", async () => {
    const f = fixture();
    f.clock.sleep = () => new Promise<void>(() => {});
    await expect(f.context.wait(Promise.resolve("ready"))).resolves.toBe(
      "ready"
    );
    const error = new Error("clock unavailable");
    f.clock.sleep = () => {
      throw error;
    };
    await expect(f.context.wait(Promise.resolve("ready"))).rejects.toBe(error);
  });
  it.each([0, 200, 1200])(
    "never requests early for Retry-After %sms",
    async (milliseconds) => {
      const f = fixture();
      let calls = 0;
      await f.context.read("run", 15000, async () =>
        response(++calls === 1 ? 429 : 200, {
          retryAfter: { state: "delay", milliseconds }
        })
      );
      expect(f.waits).toEqual([Math.max(500, milliseconds)]);
      expect(calls).toBe(2);
    }
  );

  it("shares credits through phase limits and cancellation forks without extending time", async () => {
    const f = fixture();
    const short = f.context.limit(2000);
    f.advance(1000);
    const promoted = short
      .limit(10000)
      .withCancellation({ stopped: () => false });
    expect(promoted.deadline).toBe(2000);
    expect(promoted.remaining()).toBe(1000);
    let calls = 0;
    await promoted.read("run", 15000, async () =>
      response(++calls === 1 ? 503 : 200)
    );
    await f.context.read("jobs", 15000, async () => response(503));
    expect(f.waits).toEqual([500, 500]);
    expect(f.context.limit(0).check()).toEqual({
      state: "exhausted",
      reason: "elapsed"
    });
  });

  it.each([-1, Infinity, NaN])(
    "rejects invalid phase timeout %s",
    (timeout) => {
      expect(() => fixture().context.limit(timeout)).toThrow("phase timeout");
    }
  );

  it("does not retry after stop during a wait or a concurrent permanent restriction", async () => {
    for (const stop of [true, false]) {
      const f = fixture();
      f.clock.sleep = async () => {
        if (stop) f.stop();
        else f.cooldowns.restrict("run", 0, "invalid-deadline");
      };
      let calls = 0;
      const result = await f.context.read(
        "run",
        15000,
        async () => (++calls, response())
      );
      expect(calls).toBe(1);
      expect(result.decision).toEqual(
        stop ?
          { state: "stopped", reason: "cancelled" }
        : { state: "deferred", reason: "invalid-deadline" }
      );
    }
  });

  it("rechecks a longer concurrent cooldown and never waits beyond the phase", async () => {
    const f = fixture();
    f.clock.sleep = async (ms) => {
      f.waits.push(ms);
      f.advance(ms);
      f.cooldowns.restrict("run", 15000);
    };
    let calls = 0;
    const result = await f.context.read(
      "run",
      15000,
      async () => (++calls, response())
    );
    expect(result.decision).toEqual({
      state: "deferred",
      reason: "not-before",
      notBefore: 15000
    });
    expect(f.waits).toEqual([500]);
    expect(calls).toBe(1);
  });
  it.each([0, 250])(
    "recovers with positive bounded jitter %s",
    async (jitter) => {
      const f = fixture(15000, jitter);
      let calls = 0;
      const result = await f.context.read("jobs", 15000, async () =>
        response(++calls === 3 ? 200 : 503)
      );
      expect(result.decision).toEqual({ state: "ready" });
      expect(calls).toBe(3);
      expect(f.waits).toEqual([500 + jitter, 1000 + jitter]);
    }
  );

  it("does not delay ordinary success and retains successful quota evidence", async () => {
    const f = fixture();
    expect(
      (await f.context.read("run", 15000, async () => response(200))).decision
    ).toEqual({ state: "ready" });
    await f.context.read("run", 15000, async () =>
      response(200, {
        rateLimitRemaining: 0,
        rateLimitReset: { state: "deadline", epochMilliseconds: 105000 },
        serverDate: { state: "deadline", epochMilliseconds: 100000 }
      })
    );
    expect(f.cooldowns.check("run")).toEqual({
      state: "deferred",
      reason: "not-before",
      notBefore: 6000
    });
    expect(f.waits).toEqual([]);
  });

  describe("observation result fencing", () => {
    function waitingFixture(timeout = 100) {
      vi.useFakeTimers();
      const listeners = new Set<() => void>();
      let stopped = false;
      const clock: WorkflowReadClock = {
        monotonic: () => performance.now(),
        wall: () => Date.now(),
        jitter: () => 0,
        sleep: (milliseconds, cancellation) =>
          new Promise<void>((resolve) => {
            let detach = () => {};
            const done = () => {
              clearTimeout(timer);
              detach();
              resolve();
            };
            const timer = setTimeout(done, milliseconds);
            detach = cancellation?.onStop?.(done) ?? (() => {});
            if (cancellation?.stopped()) done();
          })
      };
      const context = createWorkflowReadContext({
        clock,
        cooldowns: createWorkflowReadCooldowns(clock.monotonic),
        timeout,
        stopped: () => stopped,
        onStop: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        }
      });
      return {
        context,
        listeners,
        stop: () => {
          stopped = true;
          for (const listener of listeners) listener();
        }
      };
    }

    it("returns success and original failures while detaching every timer/listener", async () => {
      const f = waitingFixture();
      await expect(f.context.wait(Promise.resolve("ready"))).resolves.toBe(
        "ready"
      );
      const error = new Error("original read failure");
      await expect(f.context.wait(Promise.reject(error))).rejects.toBe(error);
      expect(vi.getTimerCount()).toBe(0);
      expect(f.listeners.size).toBe(0);
    });

    it.each(["resolve", "reject"] as const)(
      "fences an in-flight read and observes late %s",
      async (mode) => {
        const f = waitingFixture();
        let complete: ((value: string) => void) | undefined;
        let fail: ((error: Error) => void) | undefined;
        const pending = new Promise<string>((resolve, reject) => {
          complete = resolve;
          fail = reject;
        });
        const result = f.context.wait(pending).catch((error: unknown) => error);
        f.stop();
        expect(await result).toMatchObject({ reason: "cancelled" });
        if (!complete || !fail) throw new Error("Read was not initialized");
        if (mode === "resolve") complete("late");
        else fail(new Error("late rejection"));
        await vi.runAllTimersAsync();
        expect(vi.getTimerCount()).toBe(0);
        expect(f.listeners.size).toBe(0);
      }
    );

    it("rejects a result at the exact deadline even when it wins the promise race", async () => {
      const f = waitingFixture();
      vi.advanceTimersByTime(100);
      await expect(
        f.context.wait(Promise.resolve("too late"))
      ).rejects.toMatchObject({ reason: "elapsed" });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("stops an already-cancelled observer and expires an uncooperative read", async () => {
      const f = waitingFixture();
      const result = f.context
        .wait(new Promise<void>(() => {}))
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(100);
      expect(await result).toMatchObject({ reason: "elapsed" });
      f.stop();
      await expect(
        f.context.wait(Promise.resolve("late"))
      ).rejects.toMatchObject({ reason: "cancelled" });
      expect(vi.getTimerCount()).toBe(0);
      expect(f.listeners.size).toBe(0);
    });
  });

  it.each([400, 401, 403, 404, 408, 422, 501])(
    "never retries ineligible HTTP %s",
    async (status) => {
      const f = fixture();
      let calls = 0;
      expect(
        (
          await f.context.read("run", 15000, async () => {
            calls++;
            return response(status);
          })
        ).decision
      ).toEqual({ state: "exhausted", reason: "ineligible" });
      expect(calls).toBe(1);
      expect(f.waits).toEqual([]);
    }
  );

  it.each([500, 502, 503, 504])(
    "caps transient HTTP %s at three calls",
    async (status) => {
      const f = fixture();
      let calls = 0;
      const result = await f.context.read("run", 15000, async () => {
        calls++;
        return response(status);
      });
      expect(result.decision).toEqual({
        state: "exhausted",
        reason: "attempts"
      });
      expect(calls).toBe(3);
    }
  );

  it.each([
    [{ source: "unavailable", reason: "opaque-command" }],
    [response(403, { classification: "authorization" }).metadata]
  ] satisfies [WorkflowResponseMetadata][])(
    "does not retry opaque or authorization evidence %j",
    async (metadata) => {
      const f = fixture();
      const result = await f.context.read("run", 15000, async () => ({
        ok: false,
        metadata
      }));
      expect(result.decision).toEqual({
        state: "exhausted",
        reason: "ineligible"
      });
      expect(f.waits).toEqual([]);
    }
  );

  it.each([
    { changes: {}, reason: "missing-deadline" },
    {
      changes: { retryAfter: { state: "invalid" } },
      reason: "invalid-deadline"
    },
    {
      changes: { retryAfter: { state: "deadline", epochMilliseconds: 90000 } },
      reason: "unavailable-server-date"
    }
  ] as const)(
    "retains $reason across automatic polls without blocking other endpoints",
    async ({ changes, reason }) => {
      const f = fixture();
      await f.context.read("jobs", 15000, async () => response(429, changes));
      f.advance(5000);
      let calls = 0;
      const retry = await f.create().read("jobs", 20000, async () => {
        calls++;
        return response(200);
      });
      expect(retry.decision).toEqual({ state: "deferred", reason });
      expect(calls).toBe(0);
      expect(
        (await f.create().read("run", 20000, async () => response(200)))
          .decision
      ).toEqual({ state: "ready" });
    }
  );

  it("honors the latest server constraint despite clock skew and later wall jumps", async () => {
    const f = fixture();
    let calls = 0;
    const result = await f.context.read("jobs", 15000, async () => {
      if (++calls > 1) return response(200);
      f.clock.wall = () => 999999999;
      return response(429, {
        retryAfter: { state: "delay", milliseconds: 2000 },
        rateLimitReset: { state: "deadline", epochMilliseconds: 105000 },
        serverDate: { state: "deadline", epochMilliseconds: 99000 }
      });
    });
    expect(result.decision.state).toBe("ready");
    expect(f.waits).toEqual([7000]);
  });

  it("rejects invalid applicable timing without fallback but ignores an ordinary quota reset", async () => {
    const f = fixture();
    const result = await f.context.read("jobs", 15000, async () =>
      response(503, { retryAfter: { state: "invalid" } })
    );
    expect(result.decision).toEqual({
      state: "deferred",
      reason: "invalid-deadline"
    });
    let calls = 0;
    await f.context.read("run", 15000, async () =>
      response(++calls === 1 ? 503 : 200, {
        rateLimitReset: { state: "invalid" }
      })
    );
    expect(calls).toBe(2);
  });

  it.each([500, 499])(
    "does not sleep or retry at/beyond %sms of remaining budget",
    async (timeout) => {
      const f = fixture(timeout);
      const result = await f.context.read("jobs", timeout, async () =>
        response()
      );
      expect(result.decision).toEqual({
        state: "deferred",
        reason: "not-before",
        notBefore: 500
      });
      expect(f.waits).toEqual([]);
    }
  );

  it("admits at the server deadline but not at the observation deadline", async () => {
    const f = fixture(1000);
    await f.context.read("run", 1000, async () =>
      response(429, { retryAfter: { state: "delay", milliseconds: 2000 } })
    );
    f.advance(1999);
    expect(f.cooldowns.check("run").state).toBe("deferred");
    f.advance(1);
    expect(f.cooldowns.check("run")).toEqual({ state: "ready" });
    expect(f.context.check()).toEqual({
      state: "exhausted",
      reason: "elapsed"
    });
    expect(f.context.remaining()).toBe(0);
  });

  it("rechecks early timer wakes without resampling jitter", async () => {
    const f = fixture();
    let samples = 0;
    f.clock.jitter = () => (++samples, 0);
    f.clock.sleep = async (ms) => {
      f.waits.push(ms);
      f.advance(Math.min(ms, 300));
    };
    let calls = 0;
    await f.context.read("run", 15000, async () =>
      response(++calls === 1 ? 503 : 200)
    );
    expect(f.waits).toEqual([500, 200]);
    expect(samples).toBe(1);
  });

  it("charges pages and concurrent admissions to one ledger before sleep", async () => {
    const f = fixture();
    let first = 0;
    await f.context.read("page1", 15000, async () =>
      response(++first === 1 ? 503 : 200)
    );
    let finishWait: (() => void) | undefined;
    f.clock.sleep = (ms) =>
      new Promise<void>((resolve) => {
        finishWait = () => {
          f.advance(ms);
          resolve();
        };
      });
    let aCalls = 0;
    const a = f.context.read("page2", 15000, async () =>
      response(++aCalls === 1 ? 503 : 200)
    );
    await Promise.resolve();
    let bCalls = 0;
    const b = await f.context.read("artifact", 15000, async () => {
      bCalls++;
      return response();
    });
    expect(b.decision).toEqual({ state: "exhausted", reason: "attempts" });
    expect(bCalls).toBe(1);
    if (!finishWait) throw new Error("Expected reserved retry wait");
    finishWait();
    expect((await a).decision.state).toBe("ready");
    expect(aCalls).toBe(2);
  });

  it("bounds protected restrictions at 32 without evicting the first", async () => {
    const f = fixture();
    for (let index = 0; index < 32; index++)
      await f.create().read(`target${index}`, 15000, async () => response(429));
    let calls = 0;
    const read = async () => {
      calls++;
      return response(200);
    };
    expect((await f.create().read("target32", 15000, read)).decision).toEqual({
      state: "deferred",
      reason: "capacity"
    });
    expect((await f.create().read("target0", 15000, read)).decision).toEqual({
      state: "deferred",
      reason: "missing-deadline"
    });
    expect(calls).toBe(0);
  });

  it("fences stop and late results without resetting phase time", async () => {
    const f = fixture(WORKFLOW_READ_LIMITS.observationMs);
    f.advance(WORKFLOW_READ_LIMITS.monitorMs);
    expect(f.context.remaining()).toBe(2280000);
    const result = await f.context.read("run", f.context.deadline, async () => {
      f.stop();
      return response(200);
    });
    expect(result).toEqual({
      response: null,
      decision: { state: "stopped", reason: "cancelled" }
    });
    expect(
      (await f.context.read("next", f.context.deadline, async () => response()))
        .decision.state
    ).toBe("stopped");
  });

  it.each([-1, 251, 0.5])(
    "rejects invalid jitter %s and releases admission",
    async (jitter) => {
      const f = fixture(15000, jitter);
      await expect(
        f.context.read("run", 15000, async () => response())
      ).rejects.toThrow("jitter");
      expect(f.cooldowns.acquire("run")).toEqual({ state: "ready" });
      f.cooldowns.release("run");
    }
  );

  it.each([0, -1, Infinity, NaN])("rejects invalid timeout %s", (timeout) => {
    expect(() => fixture(timeout)).toThrow("timeout");
  });

  it("preserves unexpected read errors", async () => {
    const f = fixture();
    const error = new Error("host failure");
    await expect(
      f.context.read("run", 15000, () => Promise.reject(error))
    ).rejects.toBe(error);
    expect(f.cooldowns.check("run").state).toBe("ready");
    expect(() => f.cooldowns.restrict("unadmitted", 10)).toThrow(
      "not admitted"
    );
    f.cooldowns.release("unadmitted");
  });
});
