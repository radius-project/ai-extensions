// The ambient graph build chip.
//
// The chip makes a claim — "a build is running" — so these tests pin the two
// things that make the claim honest: it only appears when the server's record
// says the build is live, and the time it shows is the server's measurement of
// how long that build has actually been going, not the age of this page.

import { describe, expect, it } from "vitest";
import {
  GRAPH_CHIP_ID,
  GRAPH_CHIP_LABEL_ID,
  GRAPH_CHIP_POLL_MS,
  GRAPH_CHIP_TICK_MS,
  GRAPH_PANEL_ID_BY_VIEW,
  GRAPH_PANEL_IDS,
  GRAPH_PROGRESS_PATH,
  graphChipHref,
  graphChipLabel,
  graphChipStageLabel,
  initializeGraphChip,
  parseGraphBuildStatus
} from "./graph-chip.js";
import { GRAPH_STAGE_LABELS } from "./graph/progress.js";
import {
  createDeferred,
  createFakeBrowser,
  createFakeElement,
  flushPromises,
  jsonResponse
} from "../../test/support/browser/fakes.js";
import type { HttpResponse } from "./ports.js";

function setup() {
  const browser = createFakeBrowser();
  const chip = createFakeElement(GRAPH_CHIP_ID);
  chip.hidden = true;
  const label = createFakeElement(GRAPH_CHIP_LABEL_ID);
  browser.document.add(chip);
  browser.document.add(label);
  return { ...browser, chip, label };
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    active: true,
    view: "graph",
    generation: 1,
    elapsedMs: 5_000,
    events: [
      {
        sequence: 1,
        stage: "building_graph",
        state: "running",
        detail: "Compiling the application model."
      }
    ],
    ...overrides
  };
}

async function poll(clock: { tick(ms: number): void }, beats = 1) {
  for (let index = 0; index < beats; index++) {
    clock.tick(GRAPH_CHIP_POLL_MS);
    await flushPromises();
  }
}

describe("graph build record parsing", () => {
  it.each([
    ["null", null],
    ["a string", "running"],
    ["an array", []],
    ["an empty payload", {}],
    ["a record that is not active", record({ active: false })],
    ["a record whose liveness is not a boolean", record({ active: "yes" })],
    ["a record with no events", record({ events: [] })],
    ["a record whose events are not an array", record({ events: "none" })],
    ["a record whose events are not objects", record({ events: ["nope"] })],
    ["a record whose latest event names no stage", record({ events: [{}] })]
  ])("reads %s as nothing to report", (_name, payload) => {
    expect(parseGraphBuildStatus(payload)).toBeNull();
  });

  it("reports the latest stage of a live record", () => {
    expect(parseGraphBuildStatus(record())).toEqual({
      active: true,
      view: "graph",
      elapsedMs: 5_000,
      stage: "building_graph",
      detail: "Compiling the application model."
    });
  });

  it.each([
    ["an absent measurement", undefined],
    ["a measurement that is not a number", "soon"],
    ["a measurement that is not finite", Number.POSITIVE_INFINITY],
    ["a negative measurement", -1_000]
  ])("reports no elapsed time for %s", (_name, elapsedMs) => {
    const status = parseGraphBuildStatus(record({ elapsedMs }));
    expect(status?.elapsedMs).toBe(0);
  });
});

describe("graph chip labelling", () => {
  it("states the stage and the time spent on it", () => {
    expect(
      graphChipLabel(
        {
          active: true,
          view: "graph",
          elapsedMs: 0,
          stage: "building_graph",
          detail: ""
        },
        95_000
      )
    ).toBe(`${GRAPH_STAGE_LABELS.building_graph} · 1:35`);
  });

  it("says nothing for a stage it has no label for", () => {
    expect(graphChipStageLabel("teleporting")).toBe("");
    expect(
      graphChipLabel(
        {
          active: true,
          view: "graph",
          elapsedMs: 0,
          stage: "teleporting",
          detail: ""
        },
        1_000
      )
    ).toBe("");
  });

  it.each([
    ["graph", "/?page=graph"],
    ["planned", "/?page=planned"],
    ["diff", "/?page=graph-diff"],
    ["", "/?page=graph"],
    ["invented", "/?page=graph"]
  ])("links the %s view to %s", (view, href) => {
    expect(graphChipHref(view)).toBe(href);
  });
});

describe("graph chip polling", () => {
  it("does nothing when the page has no chip", async () => {
    const browser = createFakeBrowser();
    const teardown = initializeGraphChip(browser.context);
    await flushPromises();

    expect(browser.net.calls).toHaveLength(0);
    expect(browser.clock.pending).toBe(0);
    teardown();
  });

  it("polls once on load and then on the interval", async () => {
    const browser = setup();
    browser.net.handle(GRAPH_PROGRESS_PATH, () => jsonResponse(record()));

    initializeGraphChip(browser.context);
    await flushPromises();
    expect(browser.net.calls).toHaveLength(1);
    expect(browser.net.calls[0].init?.cache).toBe("no-store");

    await poll(browser.clock, 2);
    expect(browser.net.calls).toHaveLength(3);
  });

  it("renders a live build with its stage, elapsed time and identity", async () => {
    const browser = setup();
    browser.net.handle(GRAPH_PROGRESS_PATH, () =>
      jsonResponse(record({ elapsedMs: 65_000 }))
    );

    initializeGraphChip(browser.context);
    await flushPromises();

    expect(browser.chip.hidden).toBe(false);
    expect(browser.chip.className).toBe("rad-opchip rad-opchip--running");
    expect(browser.label.textContent).toBe(
      `${GRAPH_STAGE_LABELS.building_graph} · 1:05`
    );
    expect(browser.chip.getAttribute("aria-label")).toBe(
      "Compiling the application model."
    );
    expect(browser.chip.getAttribute("title")).toBe(
      "Compiling the application model."
    );
    expect(browser.chip.getAttribute("href")).toBe("/?page=graph");
    expect(browser.chip.dataset.view).toBe("graph");
    expect(browser.chip.dataset.stage).toBe("building_graph");
  });

  it("links to the view that owns the build", async () => {
    const browser = setup();
    browser.net.handle(GRAPH_PROGRESS_PATH, () =>
      jsonResponse(record({ view: "diff" }))
    );

    initializeGraphChip(browser.context);
    await flushPromises();

    expect(browser.chip.getAttribute("href")).toBe("/?page=graph-diff");
  });

  it("falls back to the short label when the stage narrates nothing", async () => {
    const browser = setup();
    browser.net.handle(GRAPH_PROGRESS_PATH, () =>
      jsonResponse(
        record({
          events: [
            {
              sequence: 1,
              stage: "building_graph",
              state: "running",
              detail: ""
            }
          ]
        })
      )
    );

    initializeGraphChip(browser.context);
    await flushPromises();

    expect(browser.chip.getAttribute("aria-label")).toBe(
      `${GRAPH_STAGE_LABELS.building_graph} · 0:05`
    );
  });

  it("renders without a label element on a trimmed page", async () => {
    const browser = createFakeBrowser();
    const chip = createFakeElement(GRAPH_CHIP_ID);
    chip.hidden = true;
    browser.document.add(chip);
    browser.net.handle(GRAPH_PROGRESS_PATH, () => jsonResponse(record()));

    initializeGraphChip(browser.context);
    await flushPromises();

    expect(chip.hidden).toBe(false);
  });

  it("advances the clock between polls from the server's measurement", async () => {
    const browser = setup();
    browser.net.handle(GRAPH_PROGRESS_PATH, () =>
      jsonResponse(record({ elapsedMs: 60_000 }))
    );

    initializeGraphChip(browser.context);
    await flushPromises();
    expect(browser.label.textContent).toBe(
      `${GRAPH_STAGE_LABELS.building_graph} · 1:00`
    );

    browser.clock.tick(GRAPH_CHIP_TICK_MS * 3);
    await flushPromises();

    expect(browser.label.textContent).toBe(
      `${GRAPH_STAGE_LABELS.building_graph} · 1:03`
    );
  });

  it("does not tick a clock for a build it is not showing", async () => {
    const browser = setup();
    browser.net.handle(GRAPH_PROGRESS_PATH, () =>
      jsonResponse(record({ active: false }))
    );

    initializeGraphChip(browser.context);
    await flushPromises();
    browser.clock.tick(GRAPH_CHIP_TICK_MS * 5);
    await flushPromises();

    expect(browser.chip.hidden).toBe(true);
    expect(browser.label.textContent).toBe("");
  });

  it("hides once the build settles", async () => {
    const browser = setup();
    let live = true;
    browser.net.handle(GRAPH_PROGRESS_PATH, () =>
      jsonResponse(record({ active: live }))
    );

    initializeGraphChip(browser.context);
    await flushPromises();
    expect(browser.chip.hidden).toBe(false);

    live = false;
    await poll(browser.clock);

    expect(browser.chip.hidden).toBe(true);
  });

  it("says nothing for a stage it has no label for", async () => {
    const browser = setup();
    browser.net.handle(GRAPH_PROGRESS_PATH, () =>
      jsonResponse(
        record({
          events: [
            { sequence: 1, stage: "teleporting", state: "running", detail: "" }
          ]
        })
      )
    );

    initializeGraphChip(browser.context);
    await flushPromises();

    expect(browser.chip.hidden).toBe(true);
  });

  // The page's own panel already narrates the build in full. Two widgets
  // reporting the same thing is noise, not redundancy.
  it.each(Object.entries(GRAPH_PANEL_ID_BY_VIEW))(
    "stands down while the %s panel is on screen",
    async (view, id) => {
      const browser = setup();
      const panel = createFakeElement(id);
      const progress = createFakeElement(`${id}-progress`);
      progress.className = "rad-graph-progress";
      panel.appendChild(progress);
      browser.document.add(panel);
      browser.net.handle(GRAPH_PROGRESS_PATH, () =>
        jsonResponse(record({ view }))
      );

      initializeGraphChip(browser.context);
      await flushPromises();
      expect(browser.chip.hidden).toBe(true);

      progress.style.display = "none";
      await poll(browser.clock);
      expect(browser.chip.hidden).toBe(false);
    }
  );

  it("does not hide behind the deployed page's client-only loading panel", async () => {
    const browser = setup();
    const panel = createFakeElement("deployed-progress-steps");
    const progress = createFakeElement("deployed-progress");
    progress.className = "rad-graph-progress";
    panel.appendChild(progress);
    browser.document.add(panel);
    browser.net.handle(GRAPH_PROGRESS_PATH, () => jsonResponse(record()));

    initializeGraphChip(browser.context);
    await flushPromises();

    expect(browser.chip.hidden).toBe(false);
  });

  it("treats a detached panel as not on screen", async () => {
    const browser = setup();
    const panel = createFakeElement(GRAPH_PANEL_IDS[0]);
    const progress = createFakeElement("detached-progress");
    progress.className = "rad-graph-progress";
    progress.offsetParent = null;
    panel.appendChild(progress);
    browser.document.add(panel);
    browser.net.handle(GRAPH_PROGRESS_PATH, () => jsonResponse(record()));

    initializeGraphChip(browser.context);
    await flushPromises();

    expect(browser.chip.hidden).toBe(false);
  });

  it("does not hide for an empty progress host", async () => {
    const browser = setup();
    browser.net.handle(GRAPH_PROGRESS_PATH, () => jsonResponse(record()));

    initializeGraphChip(browser.context);
    await flushPromises();
    expect(browser.chip.hidden).toBe(false);

    browser.document.add(createFakeElement(GRAPH_PANEL_IDS[0]));
    browser.clock.tick(GRAPH_CHIP_TICK_MS);
    await flushPromises();

    expect(browser.chip.hidden).toBe(false);
  });

  it("ignores a stale response that lands after a newer one", async () => {
    const browser = setup();
    const first = createDeferred<HttpResponse>();
    const second = createDeferred<HttpResponse>();
    const queue = [first, second];
    browser.net.handle(GRAPH_PROGRESS_PATH, () => {
      const next = queue.shift();
      if (!next) throw new Error("unexpected third poll");
      return next.promise;
    });

    initializeGraphChip(browser.context);
    await flushPromises();
    browser.document.dispatch("visibilitychange");
    await flushPromises();
    expect(browser.net.calls).toHaveLength(2);

    second.resolve(jsonResponse(record({ view: "diff" })));
    await flushPromises();
    first.resolve(jsonResponse(record({ view: "planned" })));
    await flushPromises();

    expect(browser.chip.dataset.view).toBe("diff");
  });

  it("does not overlap scheduled polls while one is outstanding", async () => {
    const browser = setup();
    const pending = createDeferred<HttpResponse>();
    browser.net.handle(GRAPH_PROGRESS_PATH, () => pending.promise);

    initializeGraphChip(browser.context);
    await flushPromises();
    await poll(browser.clock, 3);

    expect(browser.net.calls).toHaveLength(1);
    pending.resolve(jsonResponse(record()));
    await flushPromises();
    await poll(browser.clock);
    expect(browser.net.calls).toHaveLength(2);
  });

  it("leaves the chip as it was on a dropped poll and hides on an error", async () => {
    const browser = setup();
    let mode: "ok" | "error" | "reject" = "ok";
    browser.net.handle(GRAPH_PROGRESS_PATH, () => {
      if (mode === "reject") return Promise.reject(new Error("offline"));
      if (mode === "error") return jsonResponse({}, false, 500);
      return jsonResponse(record());
    });

    initializeGraphChip(browser.context);
    await flushPromises();
    expect(browser.chip.hidden).toBe(false);

    mode = "reject";
    await poll(browser.clock);
    expect(browser.chip.hidden).toBe(false);
    expect(browser.chip.dataset.stage).toBe("building_graph");

    mode = "error";
    await poll(browser.clock);
    expect(browser.chip.hidden).toBe(true);
  });

  it("polls when visible again without adding a timer", async () => {
    const browser = setup();
    browser.net.handle(GRAPH_PROGRESS_PATH, () => jsonResponse(record()));

    initializeGraphChip(browser.context);
    await flushPromises();
    const intervals = browser.clock.intervals;

    browser.document.visibilityState = "hidden";
    browser.document.dispatch("visibilitychange");
    await flushPromises();
    expect(browser.net.calls).toHaveLength(1);

    browser.document.visibilityState = "visible";
    browser.document.dispatch("visibilitychange");
    await flushPromises();
    expect(browser.net.calls).toHaveLength(2);
    expect(browser.clock.intervals).toBe(intervals);
  });

  it("binds once per context and never starts a second timer", async () => {
    const browser = setup();
    browser.net.handle(GRAPH_PROGRESS_PATH, () => jsonResponse(record()));

    initializeGraphChip(browser.context);
    const second = initializeGraphChip(browser.context);
    await flushPromises();
    const intervals = browser.clock.intervals;

    expect(browser.net.calls).toHaveLength(1);

    second();
    await poll(browser.clock);
    expect(browser.net.calls).toHaveLength(2);
    expect(browser.clock.intervals).toBe(intervals);
  });

  it("teardown stops timers, listeners, and late renders", async () => {
    const browser = setup();
    const pending = createDeferred<HttpResponse>();
    browser.net.handle(GRAPH_PROGRESS_PATH, () => pending.promise);

    const teardown = initializeGraphChip(browser.context);
    await flushPromises();
    teardown();

    pending.resolve(jsonResponse(record()));
    await flushPromises();

    expect(browser.chip.hidden).toBe(true);
    expect(browser.clock.pending).toBe(0);
  });
});
