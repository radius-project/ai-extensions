import { describe, expect, it } from "vitest";
import {
  beginEntry,
  createBindingRegistry,
  NOOP_TEARDOWN
} from "./lifecycle.js";
import {
  createFakeBrowser,
  FakeElement
} from "../../test/support/browser/fakes.js";
import type { BrowserContext, ClockPort } from "./ports.js";

describe("browser binding registry", () => {
  it("claims each key once and releases it explicitly", () => {
    const bindings = createBindingRegistry();
    expect(bindings.claim("entry")).toBe(true);
    expect(bindings.has("entry")).toBe(true);
    expect(bindings.claim("entry")).toBe(false);
    bindings.release("entry");
    expect(bindings.has("entry")).toBe(false);
    expect(NOOP_TEARDOWN()).toBeUndefined();
  });
});

describe("browser entry scope", () => {
  it("binds once, tears down every resource, and permits a later rebind", () => {
    const browser = createFakeBrowser();
    const target = new FakeElement("target");
    const scope = beginEntry(browser.context, "entry");
    if (scope === null) throw new Error("expected entry scope");
    let cleanups = 0;

    scope.on(target, "click", () => undefined);
    scope.every(100, () => undefined);
    scope.after(50, () => undefined);
    scope.onTeardown(() => {
      cleanups += 1;
    });

    expect(scope.key).toBe("entry");
    expect(scope.active).toBe(true);
    expect(beginEntry(browser.context, "entry")).toBeNull();
    expect(target.listenerCount("click")).toBe(1);
    expect(browser.clock.pending).toBe(2);

    scope.teardown();
    scope.teardown();

    expect(scope.active).toBe(false);
    expect(target.listenerCount()).toBe(0);
    expect(browser.clock.pending).toBe(0);
    expect(cleanups).toBe(1);
    const rebound = beginEntry(browser.context, "entry");
    expect(rebound).not.toBeNull();
    rebound?.teardown();
  });

  it("fires and forgets one-shot timers and cancels known handles", () => {
    const browser = createFakeBrowser();
    const scope = beginEntry(browser.context, "entry");
    if (scope === null) throw new Error("expected entry scope");
    let fired = 0;

    scope.after(25, () => {
      fired += 1;
    });
    browser.clock.tick(25);
    expect(fired).toBe(1);
    expect(browser.clock.pending).toBe(0);

    const interval = scope.every(10, () => undefined);
    const timeout = scope.after(20, () => undefined);
    scope.cancel(interval);
    scope.cancel(timeout);
    scope.cancel(interval);
    scope.cancel({ kind: "timeout", handle: timeout.handle });
    expect(browser.clock.pending).toBe(0);
    scope.teardown();
  });

  it("cancels only the timer that owns a recycled handle", () => {
    const browser = createFakeBrowser();
    const cleared: string[] = [];
    let timeoutHandler: (() => void) | undefined;
    // Browsers allocate timeouts and intervals from one pool, so a handle freed
    // by a fired timeout can be reissued to a later interval.
    const recyclingClock: ClockPort = {
      setTimeout(handler) {
        timeoutHandler = handler;
        return 1;
      },
      clearTimeout(handle) {
        cleared.push(`timeout:${handle}`);
      },
      setInterval() {
        return 1;
      },
      clearInterval(handle) {
        cleared.push(`interval:${handle}`);
      },
      now() {
        return 0;
      }
    };
    const context: BrowserContext = {
      ...browser.context,
      clock: recyclingClock
    };
    const scope = beginEntry(context, "entry");
    if (scope === null) throw new Error("expected entry scope");

    const timeout = scope.after(10, () => undefined);
    timeoutHandler?.();
    const interval = scope.every(10, () => undefined);
    expect(interval.handle).toBe(timeout.handle);

    scope.cancel(timeout);

    expect(cleared).toEqual([]);
    scope.teardown();
    expect(cleared).toEqual(["interval:1"]);
  });

  it("does not run a timeout callback after teardown", () => {
    const browser = createFakeBrowser();
    const scope = beginEntry(browser.context, "entry");
    if (scope === null) throw new Error("expected entry scope");
    let fired = false;
    scope.after(10, () => {
      fired = true;
    });
    scope.teardown();
    browser.clock.tick(10);
    expect(fired).toBe(false);
  });

  it("ignores a stale timeout callback even when the clock fires it after cancellation", () => {
    const browser = createFakeBrowser();
    let timeout: (() => void) | undefined;
    const leakyClock: ClockPort = {
      setTimeout(handler) {
        timeout = handler;
        return 1;
      },
      clearTimeout() {},
      setInterval() {
        return 2;
      },
      clearInterval() {},
      now() {
        return 0;
      }
    };
    const context: BrowserContext = { ...browser.context, clock: leakyClock };
    const scope = beginEntry(context, "entry");
    if (scope === null) throw new Error("expected entry scope");
    let fired = false;
    scope.after(10, () => {
      fired = true;
    });
    scope.teardown();
    timeout?.();
    expect(fired).toBe(false);
  });

  it("rejects new resources after teardown instead of leaking them", () => {
    const browser = createFakeBrowser();
    const scope = beginEntry(browser.context, "entry");
    if (scope === null) throw new Error("expected entry scope");
    scope.teardown();
    const target = new FakeElement("target");

    expect(() => scope.on(target, "click", () => undefined)).toThrow(
      'Cannot bind a listener after browser entry "entry" teardown.'
    );
    expect(() => scope.every(1, () => undefined)).toThrow(
      'Cannot start an interval after browser entry "entry" teardown.'
    );
    expect(() => scope.after(1, () => undefined)).toThrow(
      'Cannot start a timeout after browser entry "entry" teardown.'
    );
    expect(() => scope.onTeardown(() => undefined)).toThrow(
      'Cannot register cleanup after browser entry "entry" teardown.'
    );
  });

  it("runs cleanup newest first, continues after a failure, and releases the claim", () => {
    const browser = createFakeBrowser();
    const scope = beginEntry(browser.context, "entry");
    if (scope === null) throw new Error("expected entry scope");
    const order: string[] = [];
    scope.onTeardown(() => {
      order.push("first");
    });
    scope.onTeardown(() => {
      order.push("second");
      throw new Error("cleanup failed");
    });
    scope.onTeardown(() => {
      order.push("third");
    });

    expect(() => scope.teardown()).toThrow(
      'Browser entry "entry" teardown failed: cleanup failed'
    );
    expect(order).toEqual(["third", "second", "first"]);
    const rebound = beginEntry(browser.context, "entry");
    expect(rebound).not.toBeNull();
    rebound?.teardown();
  });

  it("formats a non-Error cleanup failure without skipping release", () => {
    const browser = createFakeBrowser();
    const scope = beginEntry(browser.context, "entry");
    if (scope === null) throw new Error("expected entry scope");
    scope.onTeardown(() => {
      throw "string failure";
    });
    expect(() => scope.teardown()).toThrow(
      'Browser entry "entry" teardown failed: string failure'
    );
    const rebound = beginEntry(browser.context, "entry");
    expect(rebound).not.toBeNull();
    rebound?.teardown();
  });
});
