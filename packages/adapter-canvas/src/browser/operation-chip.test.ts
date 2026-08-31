import { describe, expect, it } from "vitest";
import {
  OPERATION_CHIP_ACK_KEY,
  OPERATION_CHIP_ID,
  OPERATION_CHIP_LABEL_ID,
  OPERATION_PANEL_ID,
  OPERATION_POLL_MS,
  OPERATION_STATUS_PATH,
  initializeOperationChip,
  operationChipLabel,
  operationChipTone,
  parseOperationStatus
} from "./operation-chip.js";
import {
  createDeferred,
  createFakeBrowser,
  createFakeElement,
  flushPromises,
  jsonResponse
} from "../../test/support/browser/fakes.js";
import type { BrowserContext, HttpResponse, StoragePort } from "./ports.js";

function setup() {
  const browser = createFakeBrowser();
  const chip = createFakeElement(OPERATION_CHIP_ID);
  chip.hidden = true;
  const label = createFakeElement(OPERATION_CHIP_LABEL_ID);
  browser.document.add(chip);
  browser.document.add(label);
  return { ...browser, chip, label };
}

function operation(overrides: Record<string, unknown> = {}) {
  return {
    operation: {
      operationId: "op-1",
      state: "running",
      environment: "dev",
      summary: "Creating the dev environment",
      ...overrides
    }
  };
}

async function poll(clock: { tick(ms: number): void }, beats = 1) {
  for (let index = 0; index < beats; index++) {
    clock.tick(OPERATION_POLL_MS);
    await flushPromises();
  }
}

describe("operation status payload parsing", () => {
  it.each([
    ["null", null],
    ["a string", "running"],
    ["an array", []],
    ["an empty envelope", {}],
    ["a null operation", { operation: null }],
    ["an operation with no state", { operation: { operationId: "op-1" } }],
    ["an operation with a non-string state", { operation: { state: 7 } }]
  ])("reads %s as nothing to show", (_name, payload) => {
    expect(parseOperationStatus(payload)).toBeNull();
  });

  it("keeps only rendered fields and defaults malformed optional values", () => {
    expect(
      parseOperationStatus({
        operation: { state: "running", extra: "ignored", operationId: 12 }
      })
    ).toEqual({
      operationId: "",
      state: "running",
      environment: "",
      summary: ""
    });
  });
});

describe("operation chip labelling", () => {
  it.each([
    ["running", "Setting up dev…", "rad-opchip--running"],
    ["succeeded", "dev ready", "rad-opchip--done"],
    ["succeeded_with_warnings", "dev ready · warnings", "rad-opchip--warn"],
    ["action_required", "dev needs you", "rad-opchip--warn"],
    ["failed", "dev setup failed", "rad-opchip--failed"],
    ["failed_partial", "dev setup failed", "rad-opchip--failed"],
    ["cancelled", "dev setup paused", ""],
    ["unheard-of", "", ""]
  ])("renders %s", (state, text, tone) => {
    const status = {
      operationId: "op-1",
      state,
      environment: "dev",
      summary: ""
    };
    expect(operationChipLabel(status)).toBe(text);
    expect(operationChipTone(state)).toBe(tone);
  });

  it("falls back to a generic environment name", () => {
    expect(
      operationChipLabel({
        operationId: "op-1",
        state: "running",
        environment: "",
        summary: ""
      })
    ).toBe("Setting up environment…");
  });
});

describe("operation chip polling", () => {
  it("does nothing when the page has no chip", async () => {
    const browser = createFakeBrowser();
    const teardown = initializeOperationChip(browser.context);
    await flushPromises();

    expect(browser.net.calls).toHaveLength(0);
    expect(browser.clock.pending).toBe(0);
    teardown();
  });

  it("polls once on load and then on the interval", async () => {
    const browser = setup();
    browser.net.handle(OPERATION_STATUS_PATH, () =>
      jsonResponse(operation({ state: "running" }))
    );

    initializeOperationChip(browser.context);
    await flushPromises();
    expect(browser.net.calls).toHaveLength(1);
    expect(browser.net.calls[0].init?.cache).toBe("no-store");

    await poll(browser.clock, 2);
    expect(browser.net.calls).toHaveLength(3);
    expect(browser.clock.intervals).toBe(1);
  });

  it("renders a running operation with accessible name and identity", async () => {
    const browser = setup();
    browser.net.handle(OPERATION_STATUS_PATH, () =>
      jsonResponse(operation({ state: "running" }))
    );

    initializeOperationChip(browser.context);
    await flushPromises();

    expect(browser.chip.hidden).toBe(false);
    expect(browser.chip.className).toBe("rad-opchip rad-opchip--running");
    expect(browser.label.textContent).toBe("Setting up dev…");
    expect(browser.chip.getAttribute("aria-label")).toBe(
      "Creating the dev environment"
    );
    expect(browser.chip.getAttribute("title")).toBe(
      "Creating the dev environment"
    );
    expect(browser.chip.dataset.operationId).toBe("op-1");
    expect(browser.chip.dataset.state).toBe("running");
  });

  it("falls back to the short label when summary is absent", async () => {
    const browser = setup();
    browser.net.handle(OPERATION_STATUS_PATH, () =>
      jsonResponse(operation({ summary: "" }))
    );

    initializeOperationChip(browser.context);
    await flushPromises();

    expect(browser.chip.getAttribute("aria-label")).toBe("Setting up dev…");
  });

  it("renders without a label element on a trimmed page", async () => {
    const browser = createFakeBrowser();
    const chip = createFakeElement(OPERATION_CHIP_ID);
    chip.hidden = true;
    browser.document.add(chip);
    browser.net.handle(OPERATION_STATUS_PATH, () =>
      jsonResponse(operation({ state: "running" }))
    );

    initializeOperationChip(browser.context);
    await flushPromises();

    expect(chip.hidden).toBe(false);
    expect(chip.getAttribute("aria-label")).toBe(
      "Creating the dev environment"
    );
  });

  it("stays hidden while the inline progress panel is on screen", async () => {
    const browser = setup();
    const panel = createFakeElement(OPERATION_PANEL_ID);
    browser.document.add(panel);
    browser.net.handle(OPERATION_STATUS_PATH, () => jsonResponse(operation()));

    initializeOperationChip(browser.context);
    await flushPromises();
    expect(browser.chip.hidden).toBe(true);

    panel.style.display = "none";
    await poll(browser.clock);
    expect(browser.chip.hidden).toBe(false);
  });

  it("treats a detached progress panel as not on screen", async () => {
    const browser = setup();
    const panel = createFakeElement(OPERATION_PANEL_ID);
    panel.offsetParent = null;
    browser.document.add(panel);
    browser.net.handle(OPERATION_STATUS_PATH, () => jsonResponse(operation()));

    initializeOperationChip(browser.context);
    await flushPromises();

    expect(browser.chip.hidden).toBe(false);
  });

  it.each([
    ["an unknown state", operation({ state: "sideways" })],
    ["no operation", { operation: null }]
  ])("hides the chip for %s", async (_name, payload) => {
    const browser = setup();
    browser.chip.hidden = false;
    browser.net.handle(OPERATION_STATUS_PATH, () => jsonResponse(payload));

    initializeOperationChip(browser.context);
    await flushPromises();

    expect(browser.chip.hidden).toBe(true);
  });

  it("dismisses a terminal operation once it is acknowledged", async () => {
    const browser = setup();
    browser.net.handle(OPERATION_STATUS_PATH, () =>
      jsonResponse(operation({ state: "succeeded" }))
    );

    initializeOperationChip(browser.context);
    await flushPromises();
    expect(browser.chip.hidden).toBe(false);

    browser.chip.dispatch("click");
    expect(browser.storage.get(OPERATION_CHIP_ACK_KEY)).toBe("op-1");

    await poll(browser.clock);
    expect(browser.chip.hidden).toBe(true);
  });

  it("keeps showing a still-running operation after a click", async () => {
    const browser = setup();
    browser.net.handle(OPERATION_STATUS_PATH, () =>
      jsonResponse(operation({ state: "running" }))
    );

    initializeOperationChip(browser.context);
    await flushPromises();
    browser.chip.dispatch("click");
    await poll(browser.clock);

    expect(browser.chip.hidden).toBe(false);
  });

  it("shows a different terminal operation after an acknowledgement", async () => {
    const browser = setup();
    let current = operation({ state: "succeeded", operationId: "op-1" });
    browser.net.handle(OPERATION_STATUS_PATH, () => jsonResponse(current));

    initializeOperationChip(browser.context);
    await flushPromises();
    browser.chip.dispatch("click");
    await poll(browser.clock);
    expect(browser.chip.hidden).toBe(true);

    current = operation({ state: "failed", operationId: "op-2" });
    await poll(browser.clock);
    expect(browser.chip.hidden).toBe(false);
    expect(browser.chip.dataset.operationId).toBe("op-2");
  });

  it("keeps showing the chip when storage refuses acknowledgement", async () => {
    const browser = setup();
    const storage: StoragePort = {
      available: true,
      get() {
        throw new Error("storage denied");
      },
      set() {
        throw new Error("storage denied");
      }
    };
    const context: BrowserContext = { ...browser.context, storage };
    browser.net.handle(OPERATION_STATUS_PATH, () =>
      jsonResponse(operation({ state: "succeeded" }))
    );

    initializeOperationChip(context);
    await flushPromises();
    browser.chip.dispatch("click");
    await poll(browser.clock);

    expect(browser.chip.hidden).toBe(false);
    expect(browser.logger.errors).toHaveLength(3);
  });

  it("ignores a click when the chip has no operation identity", async () => {
    const browser = setup();
    browser.net.handle(OPERATION_STATUS_PATH, () =>
      jsonResponse({ operation: { state: "succeeded" } })
    );

    initializeOperationChip(browser.context);
    await flushPromises();
    browser.chip.dispatch("click");

    expect(browser.storage.get(OPERATION_CHIP_ACK_KEY)).toBeNull();
  });

  it("ignores a stale response that lands after a newer one", async () => {
    const browser = setup();
    const first = createDeferred<HttpResponse>();
    const second = createDeferred<HttpResponse>();
    const queue = [first, second];
    browser.net.handle(OPERATION_STATUS_PATH, () => {
      const next = queue.shift();
      if (!next) throw new Error("unexpected third poll");
      return next.promise;
    });

    initializeOperationChip(browser.context);
    await flushPromises();
    browser.document.dispatch("visibilitychange");
    await flushPromises();
    expect(browser.net.calls).toHaveLength(2);

    second.resolve(jsonResponse(operation({ state: "succeeded" })));
    await flushPromises();
    first.resolve(jsonResponse(operation({ state: "running" })));
    await flushPromises();

    expect(browser.chip.dataset.state).toBe("succeeded");
  });

  it("does not overlap scheduled polls while one is outstanding", async () => {
    const browser = setup();
    const pending = createDeferred<HttpResponse>();
    browser.net.handle(OPERATION_STATUS_PATH, () => pending.promise);

    initializeOperationChip(browser.context);
    await flushPromises();
    await poll(browser.clock, 3);

    expect(browser.net.calls).toHaveLength(1);
    pending.resolve(jsonResponse(operation()));
    await flushPromises();
    await poll(browser.clock);
    expect(browser.net.calls).toHaveLength(2);
  });

  it("leaves state intact on rejection and hides on an error response", async () => {
    const browser = setup();
    let mode: "ok" | "error" | "reject" = "ok";
    browser.net.handle(OPERATION_STATUS_PATH, () => {
      if (mode === "reject") return Promise.reject(new Error("offline"));
      if (mode === "error") return jsonResponse({}, false, 500);
      return jsonResponse(operation({ state: "running" }));
    });

    initializeOperationChip(browser.context);
    await flushPromises();
    expect(browser.chip.hidden).toBe(false);

    mode = "reject";
    await poll(browser.clock);
    expect(browser.chip.hidden).toBe(false);
    expect(browser.chip.dataset.state).toBe("running");

    mode = "error";
    await poll(browser.clock);
    expect(browser.chip.hidden).toBe(true);
  });

  it("polls when visible again without adding a timer", async () => {
    const browser = setup();
    browser.net.handle(OPERATION_STATUS_PATH, () => jsonResponse(operation()));

    initializeOperationChip(browser.context);
    await flushPromises();

    browser.document.visibilityState = "hidden";
    browser.document.dispatch("visibilitychange");
    await flushPromises();
    expect(browser.net.calls).toHaveLength(1);

    browser.document.visibilityState = "visible";
    browser.document.dispatch("visibilitychange");
    await flushPromises();
    expect(browser.net.calls).toHaveLength(2);
    expect(browser.clock.intervals).toBe(1);
  });

  it("keeps polling across in-page navigation", async () => {
    const browser = setup();
    browser.net.handle(OPERATION_STATUS_PATH, () => jsonResponse(operation()));

    initializeOperationChip(browser.context);
    await flushPromises();
    browser.page.dispatch("popstate");
    await poll(browser.clock, 2);

    expect(browser.net.calls).toHaveLength(3);
    expect(browser.clock.intervals).toBe(1);
    expect(browser.chip.hidden).toBe(false);
  });

  it("binds once per context and never starts a second timer", async () => {
    const browser = setup();
    browser.net.handle(OPERATION_STATUS_PATH, () => jsonResponse(operation()));

    initializeOperationChip(browser.context);
    const second = initializeOperationChip(browser.context);
    await flushPromises();

    expect(browser.net.calls).toHaveLength(1);
    expect(browser.clock.intervals).toBe(1);
    expect(browser.chip.listenerCount("click")).toBe(1);

    second();
    await poll(browser.clock);
    expect(browser.net.calls).toHaveLength(2);
  });

  it("teardown stops timers, listeners, and late renders", async () => {
    const browser = setup();
    const pending = createDeferred<HttpResponse>();
    browser.net.handle(OPERATION_STATUS_PATH, () => pending.promise);

    const teardown = initializeOperationChip(browser.context);
    await flushPromises();
    teardown();
    teardown();

    expect(browser.clock.pending).toBe(0);
    expect(browser.chip.listenerCount()).toBe(0);
    expect(browser.document.listenerCount()).toBe(0);

    pending.resolve(jsonResponse(operation()));
    await flushPromises();
    expect(browser.chip.hidden).toBe(true);

    await poll(browser.clock);
    expect(browser.net.calls).toHaveLength(1);
  });
});
