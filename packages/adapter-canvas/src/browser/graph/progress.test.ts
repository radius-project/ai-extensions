// The shared graph build progress view.
//
// Progress is honest here or it is nothing: the panel may only ever show
// stages the server actually reported plus real elapsed time. These tests pin
// that contract, the narrowing that keeps a malformed payload from reaching the
// DOM, and the ordering rules that stop a slow poll from walking the panel
// backwards.

import { describe, it, expect } from "vitest";
import {
  createGraphProgress,
  formatGraphElapsed,
  GRAPH_PROGRESS_STEPS_ID,
  GRAPH_PROGRESS_TICK_MS,
  GRAPH_STAGE_LABELS,
  parseGraphBuildEvent,
  parseGraphBuildEvents
} from "./progress.js";
import { beginEntry } from "../lifecycle.js";
import {
  createFakeBrowser,
  createFakeElement,
  fakeText
} from "../../../test/support/browser/fakes.js";
import type { FakeElement } from "../../../test/support/browser/fakes.js";
import type { EntryScope } from "../lifecycle.js";
import type { GraphBuildEvent } from "./progress.js";

function serverEvent(
  sequence: number,
  stage: string,
  state: string,
  detail = ""
): Record<string, unknown> {
  return { sequence, stage, state, detail };
}

function setup(hostId = GRAPH_PROGRESS_STEPS_ID) {
  const browser = createFakeBrowser();
  const host = createFakeElement(hostId);
  browser.document.add(host);
  const scope = beginEntry(browser.context, "graph-progress-test");
  if (!scope) throw new Error("The lifecycle refused a fresh entry scope.");
  return { browser, host, scope };
}

function stageRows(host: FakeElement): Array<{ text: string; state: string }> {
  const list = host.children.find(
    (child) => child.className === "rad-graph-progress__steps"
  );
  return (list?.children ?? []).map((row) => ({
    text: fakeText(row),
    state: row.className
  }));
}

function stageHeading(host: FakeElement): string {
  const row = host.children.find(
    (child) => child.className === "rad-graph-progress__status"
  );
  const heading = row?.children.find(
    (child) => child.className === "rad-graph-progress__stage"
  );
  return heading ? fakeText(heading) : "";
}

function elapsedText(host: FakeElement): string {
  const row = host.children.find(
    (child) => child.className === "rad-graph-progress__status"
  );
  const elapsed = row?.children.find(
    (child) => child.className === "rad-graph-progress__elapsed"
  );
  return elapsed ? fakeText(elapsed) : "";
}

function detailElement(host: FakeElement): FakeElement | undefined {
  return host.children.find(
    (child) => child.className === "rad-graph-progress__detail"
  );
}

describe("formatGraphElapsed", () => {
  it.each([
    [0, "Elapsed 0s"],
    [999, "Elapsed 0s"],
    [1000, "Elapsed 1s"],
    [59_000, "Elapsed 59s"],
    [60_000, "Elapsed 1m 0s"],
    [125_000, "Elapsed 2m 5s"],
    [-5000, "Elapsed 0s"]
  ])("renders %ims as %s", (ms, expected) => {
    expect(formatGraphElapsed(ms)).toBe(expected);
  });
});

describe("parseGraphBuildEvent", () => {
  it("accepts a complete typed event", () => {
    expect(
      parseGraphBuildEvent(
        serverEvent(3, "building_graph", "running", "Compiling the model.")
      )
    ).toEqual({
      sequence: 3,
      stage: "building_graph",
      state: "running",
      detail: "Compiling the model."
    });
  });

  it("defaults a missing sequence and detail rather than dropping the event", () => {
    expect(
      parseGraphBuildEvent({ stage: "checking_model", state: "succeeded" })
    ).toEqual({
      sequence: 0,
      stage: "checking_model",
      state: "succeeded",
      detail: ""
    });
  });

  it.each([
    ["a non-record", "building_graph"],
    ["a null value", null],
    ["an unknown stage", serverEvent(1, "reticulating_splines", "running")],
    ["an unknown state", serverEvent(1, "building_graph", "cancelled")],
    ["a missing stage", { sequence: 1, state: "running" }],
    ["a missing state", { sequence: 1, stage: "building_graph" }],
    [
      "a prototype-polluting stage name",
      serverEvent(1, "constructor", "running")
    ]
  ])("rejects %s", (_label, value) => {
    expect(parseGraphBuildEvent(value)).toBeNull();
  });

  it("keeps the well-formed entries of a partially malformed list", () => {
    expect(
      parseGraphBuildEvents([
        serverEvent(1, "checking_model", "succeeded"),
        "not an event",
        serverEvent(2, "nope", "running"),
        serverEvent(3, "building_graph", "running")
      ]).map((event) => event.stage)
    ).toEqual(["checking_model", "building_graph"]);
  });
});

describe("createGraphProgress", () => {
  it("renders the stage list, current stage, detail and elapsed time", () => {
    const { browser, host, scope } = setup();
    const view = createGraphProgress(browser.context, scope);

    view.sync(
      [
        serverEvent(1, "checking_model", "succeeded", "Found the model."),
        serverEvent(2, "building_graph", "running", "Compiling the model.")
      ],
      1
    );

    expect(stageRows(host)).toEqual([
      { text: GRAPH_STAGE_LABELS.checking_model, state: "step-done" },
      { text: GRAPH_STAGE_LABELS.building_graph, state: "step-active" }
    ]);
    expect(stageHeading(host)).toBe(GRAPH_STAGE_LABELS.building_graph);
    expect(fakeText(detailElement(host)!)).toBe("Compiling the model.");
    expect(elapsedText(host)).toBe("Elapsed 0s");
  });

  it("never renders a percentage, a progress bar or an estimate", () => {
    const { browser, host, scope } = setup();
    const view = createGraphProgress(browser.context, scope);
    browser.clock.tick(45_000);
    view.sync([serverEvent(1, "building_graph", "running", "Working.")], 1);

    const rendered = fakeText(host);
    expect(rendered).not.toMatch(/%|remaining|estimat/i);
    expect(host.innerHTML).not.toContain("progress");
    expect(host.children.some((child) => child.tagName === "progress")).toBe(
      false
    );
  });

  it("announces the detail politely for assistive technology", () => {
    const { browser, host, scope } = setup();
    const view = createGraphProgress(browser.context, scope);
    view.sync([serverEvent(1, "building_graph", "running", "Working.")], 1);

    const detail = detailElement(host)!;
    expect(detail.getAttribute("role")).toBe("status");
    expect(detail.getAttribute("aria-live")).toBe("polite");
  });

  it("advances the elapsed clock on each tick without re-announcing the detail", () => {
    const { browser, host, scope } = setup();
    const view = createGraphProgress(browser.context, scope);
    view.sync([serverEvent(1, "building_graph", "running", "Working.")], 1);
    const detail = detailElement(host);

    browser.clock.tick(GRAPH_PROGRESS_TICK_MS * 3);

    expect(elapsedText(host)).toBe("Elapsed 3s");
    expect(detailElement(host)).toBe(detail);
  });

  it("collapses repeated events for one stage into that stage's latest state", () => {
    const { browser, host, scope } = setup();
    const view = createGraphProgress(browser.context, scope);

    view.sync(
      [
        serverEvent(1, "building_graph", "running", "Starting."),
        serverEvent(2, "building_graph", "running", "Still going."),
        serverEvent(3, "building_graph", "succeeded", "Built 4 resource(s).")
      ],
      1
    );

    expect(stageRows(host)).toEqual([
      { text: GRAPH_STAGE_LABELS.building_graph, state: "step-done" }
    ]);
  });

  it("marks a failed stage so the panel shows where the build stopped", () => {
    const { browser, host, scope } = setup();
    const view = createGraphProgress(browser.context, scope);

    view.sync(
      [
        serverEvent(1, "checking_model", "succeeded"),
        serverEvent(2, "building_graph", "failed", "Bicep build failed.")
      ],
      1
    );

    expect(stageRows(host).at(-1)).toEqual({
      text: GRAPH_STAGE_LABELS.building_graph,
      state: "step-error"
    });
  });

  it("renders an initial client-supplied stage before any server event arrives", () => {
    const { browser, host, scope } = setup();
    const initial: GraphBuildEvent = {
      sequence: 0,
      stage: "checking_model",
      state: "running",
      detail: "Checking the branch."
    };

    createGraphProgress(browser.context, scope, { initial });

    expect(stageHeading(host)).toBe(GRAPH_STAGE_LABELS.checking_model);
    expect(fakeText(detailElement(host)!)).toBe("Checking the branch.");
  });

  it("renders into an alternate host when one is named", () => {
    const { browser, scope } = setup("diff-progress-steps");
    const view = createGraphProgress(browser.context, scope, {
      hostId: "diff-progress-steps"
    });

    view.sync([serverEvent(1, "comparing_graphs", "running", "Diffing.")], 1);

    const host = browser.document.getElementById(
      "diff-progress-steps"
    ) as FakeElement;
    expect(stageHeading(host)).toBe(GRAPH_STAGE_LABELS.comparing_graphs);
  });

  it("stays silent when its host is missing from the page", () => {
    const browser = createFakeBrowser();
    const scope = beginEntry(browser.context, "graph-progress-missing-host");
    if (!scope) throw new Error("The lifecycle refused a fresh entry scope.");

    const view = createGraphProgress(browser.context, scope);
    expect(() =>
      view.sync([serverEvent(1, "building_graph", "running")], 1)
    ).not.toThrow();
    expect(view.events()).toHaveLength(1);
  });

  describe("ordering", () => {
    it("ignores a stale snapshot from the same stream", () => {
      const { browser, host, scope } = setup();
      const view = createGraphProgress(browser.context, scope);
      view.sync(
        [
          serverEvent(1, "checking_model", "succeeded"),
          serverEvent(2, "building_graph", "running", "Compiling.")
        ],
        1
      );

      view.sync([serverEvent(1, "checking_model", "running", "Checking.")], 1);

      expect(stageHeading(host)).toBe(GRAPH_STAGE_LABELS.building_graph);
      expect(fakeText(detailElement(host)!)).toBe("Compiling.");
    });

    it("accepts a newer snapshot from the same stream", () => {
      const { browser, host, scope } = setup();
      const view = createGraphProgress(browser.context, scope);
      view.sync([serverEvent(1, "checking_model", "succeeded")], 1);

      view.sync(
        [
          serverEvent(1, "checking_model", "succeeded"),
          serverEvent(2, "building_graph", "running", "Compiling.")
        ],
        1
      );

      expect(stageHeading(host)).toBe(GRAPH_STAGE_LABELS.building_graph);
    });

    it("always applies a newer generation, even when its sequence restarts", () => {
      const { browser, host, scope } = setup();
      const view = createGraphProgress(browser.context, scope);
      view.sync(
        [
          serverEvent(1, "checking_model", "succeeded"),
          serverEvent(2, "building_graph", "succeeded"),
          serverEvent(3, "rendering_graph", "running")
        ],
        1
      );

      view.sync([serverEvent(1, "checking_model", "running", "Restarted.")], 2);

      expect(stageRows(host)).toEqual([
        { text: GRAPH_STAGE_LABELS.checking_model, state: "step-active" }
      ]);
      expect(fakeText(detailElement(host)!)).toBe("Restarted.");
    });

    it("ignores an older generation entirely", () => {
      const { browser, host, scope } = setup();
      const view = createGraphProgress(browser.context, scope);
      view.sync(
        [serverEvent(1, "rendering_graph", "running", "Rendering.")],
        4
      );

      view.sync([serverEvent(9, "checking_model", "running", "Stale.")], 3);

      expect(stageHeading(host)).toBe(GRAPH_STAGE_LABELS.rendering_graph);
    });

    it("keeps a locally appended event ahead of an equal server sequence", () => {
      const { browser, host, scope } = setup();
      const view = createGraphProgress(browser.context, scope);
      view.sync([serverEvent(1, "checking_model", "succeeded")], 1);
      view.append("building_graph", "failed", "The request failed.");

      view.sync([serverEvent(2, "checking_model", "running", "Stale.")], 1);

      expect(stageRows(host).at(-1)).toEqual({
        text: GRAPH_STAGE_LABELS.building_graph,
        state: "step-error"
      });
    });

    it("lets a strictly newer server snapshot supersede a local append", () => {
      const { browser, host, scope } = setup();
      const view = createGraphProgress(browser.context, scope);
      view.sync([serverEvent(1, "checking_model", "succeeded")], 1);
      view.append("building_graph", "running", "Building locally.");

      view.sync(
        [
          serverEvent(1, "checking_model", "succeeded"),
          serverEvent(2, "building_graph", "running"),
          serverEvent(3, "rendering_graph", "running", "Rendering.")
        ],
        1
      );

      expect(stageHeading(host)).toBe(GRAPH_STAGE_LABELS.rendering_graph);
    });
  });

  describe("stop", () => {
    it("freezes the elapsed clock", () => {
      const { browser, host, scope } = setup();
      const view = createGraphProgress(browser.context, scope);
      view.sync([serverEvent(1, "building_graph", "running")], 1);
      browser.clock.tick(GRAPH_PROGRESS_TICK_MS * 2);

      view.stop();
      browser.clock.tick(GRAPH_PROGRESS_TICK_MS * 10);

      expect(elapsedText(host)).toBe("Elapsed 2s");
    });

    it("refuses further updates", () => {
      const { browser, host, scope } = setup();
      const view = createGraphProgress(browser.context, scope);
      view.sync([serverEvent(1, "building_graph", "running", "Working.")], 1);

      view.stop();
      view.sync([serverEvent(2, "rendering_graph", "running", "Late.")], 1);
      view.append("rendering_graph", "succeeded", "Later.");

      expect(view.stopped).toBe(true);
      expect(stageHeading(host)).toBe(GRAPH_STAGE_LABELS.building_graph);
      expect(view.events()).toHaveLength(1);
    });

    it("is idempotent", () => {
      const { browser, scope } = setup();
      const view = createGraphProgress(browser.context, scope);

      view.stop();
      expect(() => view.stop()).not.toThrow();
      expect(view.stopped).toBe(true);
    });

    it("leaves no timer behind for the scope to fire", () => {
      const { browser, scope } = setup();
      const view = createGraphProgress(browser.context, scope);
      expect(browser.clock.pending).toBeGreaterThan(0);

      view.stop();

      expect(browser.clock.pending).toBe(0);
    });
  });

  it("stops ticking once its entry scope is torn down", () => {
    const { browser, host, scope } = setup();
    createGraphProgress(browser.context, scope);
    browser.clock.tick(GRAPH_PROGRESS_TICK_MS);
    expect(elapsedText(host)).toBe("Elapsed 1s");

    (scope as EntryScope).teardown();
    browser.clock.tick(GRAPH_PROGRESS_TICK_MS * 5);

    expect(elapsedText(host)).toBe("Elapsed 1s");
  });
});

describe("createGraphProgress without a host element", () => {
  it("ticks harmlessly when the page has no progress host", () => {
    const { browser, scope } = setup();
    const view = createGraphProgress(browser.context, scope, {
      hostId: "absent-progress-host"
    });

    browser.clock.tick(GRAPH_PROGRESS_TICK_MS);
    view.append("creating_model", "running", "Working");
    browser.clock.tick(GRAPH_PROGRESS_TICK_MS);

    expect(view.stopped).toBe(false);
    expect(view.events()).toHaveLength(1);
  });
});
