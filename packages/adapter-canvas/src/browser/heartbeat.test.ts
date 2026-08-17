import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MISS_THRESHOLD,
  HEARTBEAT_OVERLAY_ID,
  HEARTBEAT_PING_PATH,
  HEARTBEAT_RELOAD_RETRY_MS,
  HEARTBEAT_REQUEST_TIMEOUT_MS,
  initializeHeartbeat
} from "./heartbeat.js";
import {
  createDeferred,
  createFakeBrowser,
  FakeElement,
  flushPromises,
  jsonResponse
} from "../../test/support/browser/fakes.js";
import type { HttpResponse } from "./ports.js";

function setup() {
  const browser = createFakeBrowser();
  const overlay = new FakeElement(HEARTBEAT_OVERLAY_ID);
  overlay.style.display = "none";
  browser.document.add(overlay);
  return { ...browser, overlay };
}

async function beat(
  clock: { tick(elapsedMs: number): void },
  count = 1,
  intervalMs = HEARTBEAT_INTERVAL_MS
): Promise<void> {
  for (let index = 0; index < count; index++) {
    clock.tick(intervalMs);
    await flushPromises();
  }
}

describe("heartbeat watchdog", () => {
  it("waits for the first interval and requests a no-store ping", async () => {
    const browser = setup();
    browser.net.handle(HEARTBEAT_PING_PATH, () => jsonResponse({}));

    initializeHeartbeat(browser.context);
    await flushPromises();
    expect(browser.net.calls).toHaveLength(0);

    await beat(browser.clock);

    expect(browser.net.calls).toEqual([
      {
        url: HEARTBEAT_PING_PATH,
        init: expect.objectContaining({ cache: "no-store" })
      }
    ]);
  });

  it("keeps one request in flight when timer, focus, and visibility coincide", async () => {
    const browser = setup();
    const pending = createDeferred<HttpResponse>();
    browser.net.handle(HEARTBEAT_PING_PATH, () => pending.promise);
    initializeHeartbeat(browser.context);

    browser.clock.tick(HEARTBEAT_INTERVAL_MS);
    browser.page.dispatch("focus");
    browser.document.dispatch("visibilitychange");
    await flushPromises();

    expect(browser.net.calls).toHaveLength(1);
    pending.resolve(jsonResponse({}));
    await flushPromises();
    browser.page.dispatch("focus");
    await flushPromises();
    expect(browser.net.calls).toHaveLength(2);
  });

  it("probes on visibility only when the document is visible", async () => {
    const browser = setup();
    browser.net.handle(HEARTBEAT_PING_PATH, () => jsonResponse({}));
    initializeHeartbeat(browser.context);

    browser.document.visibilityState = "hidden";
    browser.document.dispatch("visibilitychange");
    await flushPromises();
    expect(browser.net.calls).toHaveLength(0);

    browser.document.visibilityState = "visible";
    browser.document.dispatch("visibilitychange");
    await flushPromises();
    expect(browser.net.calls).toHaveLength(1);
  });

  it("shows recovery UI only after consecutive misses and resets after a healthy blip", async () => {
    const browser = setup();
    let call = 0;
    browser.net.handle(HEARTBEAT_PING_PATH, () => {
      call += 1;
      if (call === 2) return jsonResponse({});
      return Promise.reject(new Error("offline"));
    });
    initializeHeartbeat(browser.context);

    await beat(browser.clock);
    expect(browser.overlay.style.display).toBe("none");
    await beat(browser.clock);
    expect(browser.overlay.style.display).toBe("none");
    await beat(browser.clock);
    expect(browser.overlay.style.display).toBe("none");
    await beat(browser.clock);
    expect(browser.overlay.style.display).toBe("flex");
    expect(HEARTBEAT_MISS_THRESHOLD).toBe(2);
  });

  it("treats a non-success status as a miss", async () => {
    const browser = setup();
    browser.net.handle(HEARTBEAT_PING_PATH, () => jsonResponse({}, false, 503));
    initializeHeartbeat(browser.context);

    await beat(browser.clock, 2);

    expect(browser.overlay.style.display).toBe("flex");
  });

  it("reloads the current page exactly once within the recovery retry window", async () => {
    const browser = setup();
    let healthy = false;
    browser.net.handle(HEARTBEAT_PING_PATH, () =>
      healthy ? jsonResponse({}) : Promise.reject(new Error("offline"))
    );
    initializeHeartbeat(browser.context);
    await beat(browser.clock, 2);
    expect(browser.overlay.style.display).toBe("flex");

    healthy = true;
    await beat(browser.clock, 3);

    expect(browser.nav.reloads).toBe(1);
    expect(browser.nav.href).toBe("http://localhost/?page=graph");
    expect(HEARTBEAT_RELOAD_RETRY_MS).toBeGreaterThan(
      2 * HEARTBEAT_INTERVAL_MS
    );
  });

  it("retries recovery when a host accepts a reload without navigating", async () => {
    const browser = setup();
    let healthy = false;
    browser.net.handle(HEARTBEAT_PING_PATH, () =>
      healthy ? jsonResponse({}) : Promise.reject(new Error("offline"))
    );
    initializeHeartbeat(browser.context, {
      missThreshold: 1,
      reloadRetryMs: 2 * HEARTBEAT_INTERVAL_MS
    });
    await beat(browser.clock);
    expect(browser.overlay.style.display).toBe("flex");

    healthy = true;
    await beat(browser.clock);
    expect(browser.nav.reloads).toBe(1);

    await beat(browser.clock);
    expect(browser.nav.reloads).toBe(1);

    await beat(browser.clock);
    expect(browser.nav.reloads).toBe(2);
  });

  it("never reloads a page that remained healthy", async () => {
    const browser = setup();
    browser.net.handle(HEARTBEAT_PING_PATH, () => jsonResponse({}));
    initializeHeartbeat(browser.context);

    await beat(browser.clock, 5);

    expect(browser.nav.reloads).toBe(0);
    expect(browser.overlay.style.display).toBe("none");
  });

  it("aborts a request at its deadline and clears the deadline after settlement", async () => {
    const browser = setup();
    const pending = createDeferred<HttpResponse>();
    browser.net.handle(HEARTBEAT_PING_PATH, () => pending.promise);
    initializeHeartbeat(browser.context);

    browser.clock.tick(HEARTBEAT_INTERVAL_MS);
    await flushPromises();
    expect(browser.net.calls[0].init?.signal).toBeDefined();

    browser.clock.tick(HEARTBEAT_REQUEST_TIMEOUT_MS);
    expect(browser.net.aborted).toBe(1);
    pending.resolve(jsonResponse({}));
    await flushPromises();
    expect(browser.clock.timeouts).toBe(0);
  });

  it("continues without a deadline when AbortController is unavailable", async () => {
    const browser = setup();
    browser.net.supportsAbort = false;
    browser.net.handle(HEARTBEAT_PING_PATH, () => jsonResponse({}));
    initializeHeartbeat(browser.context);

    await beat(browser.clock);

    expect(browser.net.calls[0].init?.signal).toBeUndefined();
    expect(browser.clock.timeouts).toBe(0);
  });

  it("runs without recovery markup and accepts explicit timing thresholds", async () => {
    const browser = createFakeBrowser();
    browser.net.handle(HEARTBEAT_PING_PATH, () =>
      Promise.reject(new Error("offline"))
    );
    const teardown = initializeHeartbeat(browser.context, {
      intervalMs: 100,
      requestTimeoutMs: 10,
      missThreshold: 1
    });

    await beat(browser.clock, 1, 100);

    expect(browser.net.calls).toHaveLength(1);
    teardown();
  });

  it("binds once, tears down idempotently, and permits a clean rebind", async () => {
    const browser = setup();
    browser.net.handle(HEARTBEAT_PING_PATH, () => jsonResponse({}));
    const teardown = initializeHeartbeat(browser.context);
    const duplicate = initializeHeartbeat(browser.context);

    expect(browser.clock.intervals).toBe(1);
    expect(browser.document.listenerCount("visibilitychange")).toBe(1);
    expect(browser.page.listenerCount("focus")).toBe(1);
    duplicate();
    teardown();
    teardown();

    expect(browser.clock.pending).toBe(0);
    expect(browser.document.listenerCount()).toBe(0);
    expect(browser.page.listenerCount()).toBe(0);
    await beat(browser.clock, 2);
    expect(browser.net.calls).toHaveLength(0);

    initializeHeartbeat(browser.context);
    await beat(browser.clock);
    expect(browser.net.calls).toHaveLength(1);
  });

  it("aborts and ignores an in-flight response after teardown", async () => {
    const browser = setup();
    const pending = createDeferred<HttpResponse>();
    let call = 0;
    browser.net.handle(HEARTBEAT_PING_PATH, () => {
      call += 1;
      return call === 1 ?
          Promise.reject(new Error("offline"))
        : pending.promise;
    });
    const teardown = initializeHeartbeat(browser.context, {
      missThreshold: 1
    });
    await beat(browser.clock);
    expect(browser.overlay.style.display).toBe("flex");

    browser.clock.tick(HEARTBEAT_INTERVAL_MS);
    await flushPromises();
    teardown();
    expect(browser.net.aborted).toBe(1);
    pending.reject(new Error("aborted"));
    await flushPromises();

    expect(browser.nav.reloads).toBe(0);
    expect(browser.logger.errors).toEqual([]);
    expect(browser.clock.pending).toBe(0);
  });

  it("ignores an in-flight rejection after teardown without AbortController", async () => {
    const browser = setup();
    browser.net.supportsAbort = false;
    const pending = createDeferred<HttpResponse>();
    browser.net.handle(HEARTBEAT_PING_PATH, () => pending.promise);
    const teardown = initializeHeartbeat(browser.context);
    browser.clock.tick(HEARTBEAT_INTERVAL_MS);
    await flushPromises();
    teardown();
    expect(browser.net.aborted).toBe(0);

    pending.reject(new Error("late failure"));
    await flushPromises();

    expect(browser.overlay.style.display).toBe("none");
    expect(browser.logger.errors).toEqual([]);
  });

  it("reports a reload failure and retries recovery on the next healthy beat", async () => {
    const browser = setup();
    let healthy = false;
    browser.net.handle(HEARTBEAT_PING_PATH, () =>
      healthy ? jsonResponse({}) : Promise.reject(new Error("offline"))
    );
    initializeHeartbeat(browser.context, { missThreshold: 1 });
    await beat(browser.clock);
    healthy = true;
    browser.nav.reload = () => {
      throw new Error("reload failed");
    };

    await beat(browser.clock);

    expect(browser.logger.errors).toEqual([
      {
        message: "Radius heartbeat recovery failed.",
        detail: expect.objectContaining({ message: "reload failed" })
      }
    ]);
    browser.nav.reload = () => {
      browser.nav.reloads += 1;
    };
    await beat(browser.clock);
    expect(browser.nav.reloads).toBe(1);
  });

  it("does not report a reload failure after recovery teardown", async () => {
    const browser = setup();
    let healthy = false;
    browser.net.handle(HEARTBEAT_PING_PATH, () =>
      healthy ? jsonResponse({}) : Promise.reject(new Error("offline"))
    );
    const teardown = initializeHeartbeat(browser.context, {
      missThreshold: 1
    });
    await beat(browser.clock);
    healthy = true;
    browser.nav.reload = () => {
      teardown();
      throw new Error("reload after teardown");
    };

    await beat(browser.clock);

    expect(browser.logger.errors).toEqual([]);
    expect(browser.clock.pending).toBe(0);
  });
});
