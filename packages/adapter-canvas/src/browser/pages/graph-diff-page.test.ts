import { describe, expect, it, vi } from "vitest";
import {
  createDeferred,
  createFakeBrowser,
  createFakeElement,
  createFakeInput,
  createFakeSelect,
  fakeText,
  flushPromises,
  jsonResponse
} from "../../../test/support/browser/fakes.js";
import {
  graphProgressElapsed,
  graphProgressStages
} from "../../../test/support/browser/graph-progress.js";
import { GRAPH_STAGE_LABELS } from "../graph/progress.js";
import { NOOP_TEARDOWN } from "../lifecycle.js";
import type { BrowserTeardown } from "../lifecycle.js";
import type { BrowserContext, HttpResponse } from "../ports.js";
import {
  DIFF_DEBOUNCE_MS,
  DIFF_PROGRESS_MS,
  DIFF_PROGRESS_STEPS_ID,
  DIFF_RETRY_MS,
  GRAPH_DIFF_STATE_ID,
  initializeGraphDiffPage as initializeGraphDiffPageEntry
} from "./graph-diff-page.js";

function initializeGraphDiffPage(
  context: BrowserContext,
  browserGlobals: Record<string, unknown>
): BrowserTeardown {
  return initializeGraphDiffPageEntry(context, {
    radiusSetGraphError: vi.fn(),
    ...browserGlobals
  });
}

interface FixtureOptions {
  resources?: unknown[];
  repo?: string;
  base?: string;
  head?: string;
  withStatus?: boolean;
  withRepoInput?: boolean;
  withBaseSelect?: boolean;
  withHeadSelect?: boolean;
  modelingError?: string;
  workspaceBranch?: unknown;
}

function fixture(options: FixtureOptions = {}) {
  const {
    resources = [],
    repo = "octo/app",
    base = "main",
    head = "feature",
    withStatus = true,
    withRepoInput = true,
    withBaseSelect = true,
    withHeadSelect = true,
    modelingError = ""
  } = options;
  // Distinguish an omitted key from an explicit undefined so a scenario can
  // model state that never carried a workspace branch at all.
  const workspaceBranch =
    "workspaceBranch" in options ? options.workspaceBranch : "feature";
  const browser = createFakeBrowser();
  const state = createFakeElement(GRAPH_DIFF_STATE_ID);
  state.textContent = JSON.stringify({
    repo,
    base,
    head,
    resources,
    modelingError,
    workspaceBranch
  });
  const repoInput = createFakeInput("diff-repo-select", repo);
  const app = createFakeSelect("diff-app");
  const baseSelect = createFakeSelect("base-branch");
  baseSelect.value = base;
  const headSelect = createFakeSelect("head-branch");
  headSelect.value = head;
  const status = createFakeElement("diff-status");
  const progressHost = createFakeElement(DIFF_PROGRESS_STEPS_ID);
  const graphContainer = createFakeElement("graph-container");
  const summary = createFakeElement("graph-diff-summary");
  summary.textContent = "No application graph changes.";
  const elements = [state, app, progressHost, graphContainer, summary];
  if (withRepoInput) elements.push(repoInput);
  if (withBaseSelect) elements.push(baseSelect);
  if (withHeadSelect) elements.push(headSelect);
  if (withStatus) elements.push(status);
  for (const element of elements) browser.document.add(element);

  browser.net.handle(
    `/api/list-applications?repo=${encodeURIComponent(repo)}`,
    () => jsonResponse({ applications: [{ name: "app" }] })
  );
  browser.net.handle("/api/discover-branches", () =>
    jsonResponse({
      branches: [
        { name: "main", sha: "1111111" },
        { name: "feature", sha: "2222222" }
      ],
      workspaceBranch: "feature"
    })
  );
  // The page polls progress as soon as it starts a comparison, so every
  // scenario reaches this route whether or not it is what the scenario is
  // about. A test that cares overrides it.
  browser.net.handle("/api/progress?view=diff", () => jsonResponse({}));

  return {
    browser,
    repoInput,
    app,
    base: baseSelect,
    head: headSelect,
    status,
    progressHost,
    graphContainer,
    summary
  };
}

describe("initializeGraphDiffPage", () => {
  it("does nothing when the page state element is absent", () => {
    const browser = createFakeBrowser();
    const teardown = initializeGraphDiffPage(browser.context, {
      radiusRenderGraph: vi.fn()
    });

    expect(teardown).toBe(NOOP_TEARDOWN);
  });

  it("fails initialization when the graph error renderer is unavailable", () => {
    const { browser } = fixture();

    expect(() => initializeGraphDiffPageEntry(browser.context, {})).toThrow(
      'Radius browser global "radiusSetGraphError" is not available.'
    );
  });

  it("renders preloaded resources and binds each selector once", async () => {
    const { browser, base, head } = fixture({ resources: [{ id: "app/web" }] });
    const render = vi.fn();
    const globals = { radiusRenderGraph: render };

    const teardown = initializeGraphDiffPage(browser.context, globals);
    initializeGraphDiffPage(browser.context, globals);
    await flushPromises();

    expect(render).toHaveBeenCalledWith(
      "graph-container",
      [{ id: "app/web" }],
      expect.objectContaining({
        diffMode: true,
        branch: "feature",
        baseBranch: "main",
        workspaceBranch: "feature"
      })
    );
    expect(base.listenerCount("change")).toBe(1);
    expect(head.listenerCount("change")).toBe(1);
    teardown();
    expect(base.listenerCount()).toBe(0);
    expect(head.listenerCount()).toBe(0);
  });

  // Without a workspace branch every node falls back to a remote URL, which is
  // the safe outcome when the page cannot say which branch is on disk.
  it.each([
    ["absent", undefined],
    ["not a string", 7]
  ])(
    "passes an empty workspace branch to the graph when it is %s",
    async (_label, workspaceBranch) => {
      const { browser } = fixture({
        resources: [{ id: "app/web" }],
        workspaceBranch
      });
      const render = vi.fn();

      initializeGraphDiffPage(browser.context, { radiusRenderGraph: render });
      await flushPromises();

      expect(render).toHaveBeenCalledWith(
        "graph-container",
        [{ id: "app/web" }],
        expect.objectContaining({ workspaceBranch: "" })
      );
    }
  );

  it("reconciles freshness for preloaded diff resources by invoking the HTTP workflow", async () => {
    const { browser, status } = fixture({
      resources: [{ id: "app/web" }]
    });
    let diffCalls = 0;
    let requestBody = "";
    browser.net.handle("/api/diff-branches", (init) => {
      diffCalls++;
      requestBody = String(init?.body ?? "");
      return jsonResponse({
        refreshed: true,
        message: "Comparing main → feature"
      });
    });
    const render = vi.fn();
    initializeGraphDiffPage(browser.context, { radiusRenderGraph: render });
    await flushPromises();

    // After branch listing loads, auto-compare triggers the debounced POST.
    browser.clock.tick(DIFF_DEBOUNCE_MS);
    await flushPromises();

    expect(diffCalls).toBe(1);
    expect(requestBody).toContain('"refresh":true');
    expect(requestBody).toContain('"restartWait":true');
    expect(render).toHaveBeenCalledOnce();
    expect(status.textContent).toBe("The graph comparison is current.");
  });

  it("reloads when preloaded diff resources are stale and the workflow says so", async () => {
    const { browser } = fixture({
      resources: [{ id: "app/web" }]
    });
    browser.net.handle("/api/diff-branches", () =>
      jsonResponse({ reload: true })
    );
    initializeGraphDiffPage(browser.context, { radiusRenderGraph: vi.fn() });
    await flushPromises();
    browser.clock.tick(DIFF_DEBOUNCE_MS);
    await flushPromises();

    expect(browser.nav.reloads).toBe(1);
  });

  it("rejects a stale comparison and leaves no debounce timer", async () => {
    const { browser, head, status } = fixture();
    browser.net.supportsAbort = false;
    const first = createDeferred<HttpResponse>();
    let calls = 0;
    browser.net.handle("/api/diff-branches", () => {
      calls++;
      return calls === 1 ? first.promise : jsonResponse({ message: "latest" });
    });
    const teardown = initializeGraphDiffPage(browser.context, {
      radiusRenderGraph: vi.fn()
    });
    await flushPromises();

    head.dispatch("change");
    browser.clock.tick(DIFF_DEBOUNCE_MS);
    head.value = "newer";
    head.dispatch("change");
    browser.clock.tick(DIFF_DEBOUNCE_MS);
    await flushPromises();
    expect(status.textContent).toBe("latest");

    first.resolve(jsonResponse({ reload: true }));
    await flushPromises();
    expect(browser.nav.reloads).toBe(0);

    teardown();
    expect(browser.clock.pending).toBe(0);
  });

  it("surfaces a current failure without leaking its detail", async () => {
    const { browser, head, status } = fixture();
    browser.net.handle("/api/diff-branches", () =>
      Promise.reject(new Error("secret-shaped detail"))
    );
    initializeGraphDiffPage(browser.context, {
      radiusRenderGraph: vi.fn()
    });

    await flushPromises();

    head.dispatch("change");
    browser.clock.tick(DIFF_DEBOUNCE_MS);
    await flushPromises();

    expect(status.className).toBe("status error");
    expect(status.textContent).not.toContain("secret-shaped");
    expect(browser.logger.errors).toHaveLength(1);
  });

  it("renders a compile failure only on the graph surface", async () => {
    const { browser, head, status } = fixture({
      resources: [{ id: "existing" }]
    });
    const setError = vi.fn();
    browser.net.handle("/api/diff-branches", () =>
      jsonResponse({
        error: "Your application model couldn't be compiled.",
        modelingFailed: true
      })
    );
    initializeGraphDiffPage(browser.context, {
      radiusRenderGraph: vi.fn(),
      radiusSetGraphError: setError
    });
    await flushPromises();

    head.dispatch("change");
    browser.clock.tick(DIFF_DEBOUNCE_MS);
    await flushPromises();

    expect(setError).toHaveBeenCalledWith(
      "graph-container",
      "Your application model couldn't be compiled."
    );
    expect(status.style.display).toBe("none");
    expect(head.listenerCount("change")).toBe(1);
  });

  it("shows a preloaded compile failure without immediately retrying", async () => {
    const { browser, status, graphContainer, head } = fixture({
      modelingError: "Your application model couldn't be compiled."
    });
    const setError = vi.fn();

    initializeGraphDiffPage(browser.context, {
      radiusSetGraphError: setError
    });
    await flushPromises();

    expect(setError).toHaveBeenCalledWith(
      "graph-container",
      "Your application model couldn't be compiled."
    );
    expect(status.style.display).toBe("none");
    expect(
      browser.net.calls.some((call) => call.url === "/api/diff-branches")
    ).toBe(false);

    graphContainer.innerHTML = "stale compile failure";
    browser.net.handle("/api/diff-branches", () => jsonResponse({}));
    head.dispatch("change");
    browser.clock.tick(DIFF_DEBOUNCE_MS);
    expect(graphContainer.innerHTML).toBe("");
  });

  it("hides status silently when no status element exists", async () => {
    const { browser, head } = fixture({ withStatus: false });
    browser.net.handle("/api/diff-branches", () => jsonResponse({}));
    expect(() => {
      initializeGraphDiffPage(browser.context, { radiusRenderGraph: vi.fn() });
    }).not.toThrow();
    await flushPromises();

    head.dispatch("change");
    browser.clock.tick(DIFF_DEBOUNCE_MS);
    await flushPromises();
  });

  it("falls back to 'main' when the persisted base branch is empty in the page state", () => {
    const { browser } = fixture({ base: "" });
    expect(() => {
      initializeGraphDiffPage(browser.context, { radiusRenderGraph: vi.fn() });
    }).not.toThrow();
  });

  it("does nothing when the head branch is cleared", async () => {
    const { browser, head } = fixture();
    browser.net.handle("/api/diff-branches", () => jsonResponse({}));
    initializeGraphDiffPage(browser.context, { radiusRenderGraph: vi.fn() });
    await flushPromises();

    head.value = "";
    head.dispatch("change");
    browser.clock.tick(DIFF_DEBOUNCE_MS);
    await flushPromises();

    expect(
      browser.net.calls.some((call) => call.url === "/api/diff-branches")
    ).toBe(false);
  });

  it("falls back to the persisted repo when no repo input is present", async () => {
    const { browser } = fixture({ withRepoInput: false, repo: "octo/other" });
    let body = "";
    browser.net.handle("/api/diff-branches", (init) => {
      body = String(init?.body ?? "");
      return jsonResponse({});
    });
    initializeGraphDiffPage(browser.context, { radiusRenderGraph: vi.fn() });
    await flushPromises();
    browser.clock.tick(DIFF_DEBOUNCE_MS);
    await flushPromises();

    expect(body).toContain('"repo":"octo/other"');
  });

  it("falls back to an empty base when no base selector is present", async () => {
    const { browser, head } = fixture({ withBaseSelect: false });
    browser.net.handle("/api/diff-branches", () => jsonResponse({}));
    initializeGraphDiffPage(browser.context, { radiusRenderGraph: vi.fn() });
    await flushPromises();

    head.dispatch("change");
    browser.clock.tick(DIFF_DEBOUNCE_MS);
    await flushPromises();

    // An absent base selector leaves base empty, so the guard rejects the
    // comparison rather than posting with an undefined base branch.
    expect(
      browser.net.calls.some((call) => call.url === "/api/diff-branches")
    ).toBe(false);
  });

  it("does not bind listeners when no head or base selector exists", async () => {
    const { browser } = fixture({
      withHeadSelect: false,
      withBaseSelect: false
    });
    expect(() => {
      initializeGraphDiffPage(browser.context, { radiusRenderGraph: vi.fn() });
    }).not.toThrow();
    await flushPromises();
  });

  it("ignores a base change while no head branch is selected", async () => {
    const { browser, base, head } = fixture();
    browser.net.handle("/api/diff-branches", () => jsonResponse({}));
    initializeGraphDiffPage(browser.context, { radiusRenderGraph: vi.fn() });
    await flushPromises();
    // Let the page's own auto-compare (triggered once branches populate)
    // settle first so only the explicit base change under test remains.
    browser.clock.tick(DIFF_DEBOUNCE_MS);
    await flushPromises();

    head.value = "";
    base.value = "another";
    base.dispatch("change");

    expect(browser.clock.timeouts).toBe(0);
  });

  it("queues a comparison on a base change once a head branch is selected", async () => {
    const { browser, base } = fixture();
    browser.net.handle("/api/diff-branches", () => jsonResponse({}));
    initializeGraphDiffPage(browser.context, { radiusRenderGraph: vi.fn() });
    await flushPromises();

    base.value = "another";
    base.dispatch("change");

    expect(browser.clock.timeouts).toBe(1);
  });

  it("shows a needsAppBicep message", async () => {
    const { browser, head, status } = fixture();
    browser.net.handle("/api/diff-branches", () =>
      jsonResponse({ needsAppBicep: true })
    );
    initializeGraphDiffPage(browser.context, { radiusRenderGraph: vi.fn() });
    await flushPromises();

    head.dispatch("change");
    browser.clock.tick(DIFF_DEBOUNCE_MS);
    await flushPromises();

    expect(status.textContent).toContain(
      "Copilot is generating .radius/app.bicep"
    );
  });

  // Nothing announces the model's arrival, so a page that reported the wait
  // once and then stopped asking never recovered — even after the model landed.
  it("keeps asking until the model lands, then renders the diff", async () => {
    const renderGraph = vi.fn();
    const { browser, head, status } = fixture();
    let calls = 0;
    const bodies: string[] = [];
    browser.net.handle("/api/diff-branches", (init) => {
      calls++;
      bodies.push(String(init?.body ?? ""));
      return calls < 3 ?
          jsonResponse({ needsAppBicep: true })
        : jsonResponse({ message: "Graphs are identical." });
    });
    browser.net.handle("/api/progress?view=diff", () =>
      jsonResponse({ events: [] })
    );
    initializeGraphDiffPage(browser.context, {
      radiusRenderGraph: renderGraph
    });
    await flushPromises();

    head.dispatch("change");
    browser.clock.tick(DIFF_DEBOUNCE_MS);
    await flushPromises();
    for (let attempt = 0; attempt < 2; attempt++) {
      browser.clock.tick(DIFF_RETRY_MS);
      await flushPromises();
    }

    expect(calls).toBe(3);
    expect(bodies[0]).toContain('"restartWait":true');
    expect(bodies[1]).toContain('"restartWait":false');
    expect(bodies[2]).toContain('"restartWait":false');
    expect(status.textContent).toBe("Graphs are identical.");
  });

  it("stops asking once the server ends the wait", async () => {
    const { browser, head, status } = fixture();
    let calls = 0;
    browser.net.handle("/api/diff-branches", () => {
      calls++;
      return jsonResponse({
        error: "No modeling run has started.",
        appBicepWaitExpired: true
      });
    });
    browser.net.handle("/api/progress?view=diff", () =>
      jsonResponse({ events: [] })
    );
    initializeGraphDiffPage(browser.context, { radiusRenderGraph: vi.fn() });
    await flushPromises();

    head.dispatch("change");
    browser.clock.tick(DIFF_DEBOUNCE_MS);
    await flushPromises();
    browser.clock.tick(DIFF_RETRY_MS * 5);
    await flushPromises();

    expect(calls).toBe(1);
    expect(status.textContent).toContain("No modeling run has started.");
  });

  // A pending retry must not fire a request for a selection the user replaced.
  it("abandons a pending retry when the selection changes", async () => {
    const { browser, head, base } = fixture();
    const bodies: string[] = [];
    browser.net.handle("/api/diff-branches", (init) => {
      bodies.push(String(init?.body ?? ""));
      return jsonResponse({ needsAppBicep: true });
    });
    browser.net.handle("/api/progress?view=diff", () =>
      jsonResponse({ events: [] })
    );
    initializeGraphDiffPage(browser.context, { radiusRenderGraph: vi.fn() });
    await flushPromises();

    head.dispatch("change");
    browser.clock.tick(DIFF_DEBOUNCE_MS);
    await flushPromises();
    const halfDebounce = Math.floor(DIFF_DEBOUNCE_MS / 2);
    browser.clock.tick(DIFF_RETRY_MS - halfDebounce);
    base.value = "another";
    base.dispatch("change");
    browser.clock.tick(halfDebounce);
    await flushPromises();
    expect(bodies).toHaveLength(1);

    browser.clock.tick(DIFF_DEBOUNCE_MS - halfDebounce);
    await flushPromises();

    expect(bodies).toHaveLength(2);
    expect(bodies.at(-1)).toContain('"base":"another"');
  });

  it("shows the refusal verbatim when the skill cannot model the repo", async () => {
    const { browser, head, status } = fixture();
    const setError = vi.fn();
    browser.net.handle("/api/diff-branches", () =>
      jsonResponse({
        error: "octo/app has no Dockerfile on feature/x.",
        appBicepUnsupported: true
      })
    );
    initializeGraphDiffPage(browser.context, {
      radiusRenderGraph: vi.fn(),
      radiusSetGraphError: setError
    });
    await flushPromises();

    head.dispatch("change");
    browser.clock.tick(DIFF_DEBOUNCE_MS);
    await flushPromises();

    expect(setError).toHaveBeenCalledWith(
      "graph-container",
      "octo/app has no Dockerfile on feature/x."
    );
    expect(status.style.display).toBe("none");
  });

  it("falls back to a generic refusal message without an error string", async () => {
    const { browser, head, status } = fixture();
    const setError = vi.fn();
    browser.net.handle("/api/diff-branches", () =>
      jsonResponse({ appBicepUnsupported: true })
    );
    initializeGraphDiffPage(browser.context, {
      radiusRenderGraph: vi.fn(),
      radiusSetGraphError: setError
    });
    await flushPromises();

    head.dispatch("change");
    browser.clock.tick(DIFF_DEBOUNCE_MS);
    await flushPromises();

    expect(setError).toHaveBeenCalledWith(
      "graph-container",
      "The Radius app-bicep skill cannot model this repository."
    );
    expect(status.style.display).toBe("none");
  });

  it("hides stale diff summaries after a terminal refusal", async () => {
    const { browser, head, summary } = fixture({
      resources: [{ id: "existing", diffStatus: "unchanged" }]
    });
    browser.net.handle("/api/diff-branches", () =>
      jsonResponse({
        error: "octo/app has no Dockerfile on feature/x.",
        appBicepUnsupported: true
      })
    );
    initializeGraphDiffPage(browser.context, {
      radiusRenderGraph: vi.fn()
    });
    await flushPromises();

    head.dispatch("change");
    browser.clock.tick(DIFF_DEBOUNCE_MS);
    await flushPromises();

    expect(summary.style.display).toBe("none");
  });

  it("surfaces a diff computation error", async () => {
    const { browser, head, status } = fixture();
    browser.net.handle("/api/diff-branches", () =>
      jsonResponse({ error: "invalid app.bicep" })
    );
    initializeGraphDiffPage(browser.context, { radiusRenderGraph: vi.fn() });
    await flushPromises();

    head.dispatch("change");
    browser.clock.tick(DIFF_DEBOUNCE_MS);
    await flushPromises();

    expect(status.textContent).toContain(
      "Error computing diff: invalid app.bicep"
    );
    expect(status.className).toBe("status error");
  });

  it("reloads once the diff is ready", async () => {
    const { browser, head } = fixture();
    browser.net.handle("/api/diff-branches", () =>
      jsonResponse({ reload: true })
    );
    initializeGraphDiffPage(browser.context, { radiusRenderGraph: vi.fn() });
    await flushPromises();

    head.dispatch("change");
    browser.clock.tick(DIFF_DEBOUNCE_MS);
    await flushPromises();

    expect(browser.nav.reloads).toBe(1);
  });

  it("stays silent when the response has no message, error or reload flag", async () => {
    const { browser, head, status } = fixture();
    browser.net.handle("/api/diff-branches", () => jsonResponse({}));
    initializeGraphDiffPage(browser.context, { radiusRenderGraph: vi.fn() });
    await flushPromises();

    head.dispatch("change");
    browser.clock.tick(DIFF_DEBOUNCE_MS);
    await flushPromises();

    // The "Comparing…" text set synchronously when the request starts is the
    // only status left: an empty payload never reaches the "message" branch.
    expect(status.textContent).toBe("Comparing main → feature…");
  });

  it("ignores a stale failure superseded by another change", async () => {
    const { browser, head } = fixture();
    const first = createDeferred<HttpResponse>();
    let calls = 0;
    browser.net.handle("/api/diff-branches", () => {
      calls++;
      return calls === 1 ? first.promise : jsonResponse({ reload: true });
    });
    initializeGraphDiffPage(browser.context, { radiusRenderGraph: vi.fn() });
    await flushPromises();

    head.dispatch("change");
    browser.clock.tick(DIFF_DEBOUNCE_MS);
    head.value = "newer";
    head.dispatch("change");
    browser.clock.tick(DIFF_DEBOUNCE_MS);
    await flushPromises();

    first.reject(new Error("stale failure"));
    await flushPromises();

    expect(browser.nav.reloads).toBe(1);
    expect(browser.logger.errors).toHaveLength(0);
  });

  it("tears down pending work, aborting an in-flight comparison", async () => {
    const { browser, head } = fixture();
    const first = createDeferred<HttpResponse>();
    browser.net.handle("/api/diff-branches", () => first.promise);
    const teardown = initializeGraphDiffPage(browser.context, {
      radiusRenderGraph: vi.fn()
    });
    await flushPromises();

    head.dispatch("change");
    browser.clock.tick(DIFF_DEBOUNCE_MS);
    expect(browser.net.aborted).toBe(0);

    teardown();
    expect(browser.clock.pending).toBe(0);

    first.resolve(jsonResponse({ reload: true }));
    await flushPromises();
    expect(browser.nav.reloads).toBe(0);
  });
  describe("graph build progress", () => {
    const stageText = graphProgressStages;

    it("renders typed comparison stages while the diff runs", async () => {
      const { browser, head, progressHost } = fixture();
      browser.net.handle(
        "/api/diff-branches",
        () => createDeferred<HttpResponse>().promise
      );
      browser.net.handle("/api/progress?view=diff", () =>
        jsonResponse({
          generation: 2,
          events: [
            {
              sequence: 1,
              stage: "building_base_graph",
              state: "succeeded",
              detail: "Built the base graph."
            },
            {
              sequence: 2,
              stage: "comparing_graphs",
              state: "running",
              detail: "Comparing main to feature."
            }
          ]
        })
      );
      initializeGraphDiffPage(browser.context, { radiusRenderGraph: vi.fn() });
      await flushPromises();

      head.dispatch("change");
      browser.clock.tick(DIFF_DEBOUNCE_MS);
      await flushPromises();
      browser.clock.tick(DIFF_PROGRESS_MS);
      await flushPromises();

      expect(stageText(progressHost)).toEqual([
        `${GRAPH_STAGE_LABELS.building_base_graph}:succeeded`,
        `${GRAPH_STAGE_LABELS.comparing_graphs}:running`
      ]);
      expect(graphProgressElapsed(progressHost)).toMatch(/^\d+:\d{2}$/);
      expect(fakeText(progressHost)).not.toMatch(/%/);
    });

    it("keeps the panel steady until typed events arrive", async () => {
      const { browser, head, progressHost } = fixture();
      browser.net.handle(
        "/api/diff-branches",
        () => createDeferred<HttpResponse>().promise
      );
      const payloads: Array<Record<string, unknown>> = [
        { events: [] },
        {
          events: [
            {
              sequence: 2,
              stage: "comparing_graphs",
              state: "running",
              detail: "Comparing the two graphs."
            }
          ]
        }
      ];
      browser.net.handle("/api/progress?view=diff", () =>
        jsonResponse(payloads.shift() ?? { events: [] })
      );
      initializeGraphDiffPage(browser.context, { radiusRenderGraph: vi.fn() });
      await flushPromises();

      head.dispatch("change");
      browser.clock.tick(DIFF_DEBOUNCE_MS);
      await flushPromises();

      // The comparison polls immediately, and that first reply carries no typed
      // stages, so the panel still shows only the stage it opened with.
      expect(stageText(progressHost)).toEqual([
        `${GRAPH_STAGE_LABELS.building_base_graph}:running`
      ]);

      browser.clock.tick(DIFF_PROGRESS_MS);
      await flushPromises();

      expect(stageText(progressHost)).toEqual([
        `${GRAPH_STAGE_LABELS.comparing_graphs}:running`
      ]);
    });
    it.each([
      [
        "the skill refuses the repository",
        {
          error: "octo/app has no Dockerfile on feature/x.",
          appBicepUnsupported: true
        }
      ],
      ["the comparison errors", { error: "invalid app.bicep" }]
    ])("clears the panel when %s", async (_name, body) => {
      const { browser, head, progressHost, status } = fixture();
      const setError = vi.fn();
      let requests = 0;
      browser.net.handle("/api/diff-branches", () => {
        requests++;
        return jsonResponse(body);
      });
      browser.net.handle("/api/progress?view=diff", () =>
        jsonResponse({ events: [] })
      );
      initializeGraphDiffPage(browser.context, {
        radiusRenderGraph: vi.fn(),
        radiusSetGraphError: setError
      });
      await flushPromises();

      head.dispatch("change");
      browser.clock.tick(DIFF_DEBOUNCE_MS);
      await flushPromises();

      if ("appBicepUnsupported" in body) {
        expect(setError).toHaveBeenCalledWith(
          "graph-container",
          "octo/app has no Dockerfile on feature/x."
        );
        expect(status.style.display).toBe("none");
        browser.clock.tick(DIFF_RETRY_MS * 2);
        await flushPromises();
        expect(requests).toBe(1);
      } else {
        expect(setError).not.toHaveBeenCalled();
        expect(status.textContent).not.toBe("");
      }
      expect(stageText(progressHost)).toEqual([]);
    });

    it("clears the panel when the request throws", async () => {
      const { browser, head, progressHost, status } = fixture();
      browser.net.handle("/api/diff-branches", () =>
        Promise.reject(new Error("offline"))
      );
      browser.net.handle("/api/progress?view=diff", () =>
        jsonResponse({ events: [] })
      );
      initializeGraphDiffPage(browser.context, { radiusRenderGraph: vi.fn() });
      await flushPromises();

      head.dispatch("change");
      browser.clock.tick(DIFF_DEBOUNCE_MS);
      await flushPromises();

      expect(status.textContent).toContain("Failed to compute diff");
      expect(stageText(progressHost)).toEqual([]);
    });

    it("clears the panel while Copilot authors the model", async () => {
      const { browser, head, progressHost } = fixture();
      browser.net.handle("/api/diff-branches", () =>
        jsonResponse({ needsAppBicep: true })
      );
      browser.net.handle("/api/progress?view=diff", () =>
        jsonResponse({ events: [] })
      );
      initializeGraphDiffPage(browser.context, { radiusRenderGraph: vi.fn() });
      await flushPromises();

      head.dispatch("change");
      browser.clock.tick(DIFF_DEBOUNCE_MS);
      await flushPromises();

      expect(stageText(progressHost)).toEqual([]);
    });

    it("stops polling progress once the diff settles", async () => {
      const { browser, head } = fixture();
      browser.net.handle("/api/diff-branches", () => jsonResponse({}));
      browser.net.handle("/api/progress?view=diff", () =>
        jsonResponse({ events: [] })
      );
      const teardown = initializeGraphDiffPage(browser.context, {
        radiusRenderGraph: vi.fn()
      });
      await flushPromises();

      head.dispatch("change");
      browser.clock.tick(DIFF_DEBOUNCE_MS);
      await flushPromises();
      const polls = browser.net.calls.filter(
        (call) => call.url === "/api/progress?view=diff"
      ).length;

      browser.clock.tick(DIFF_PROGRESS_MS * 5);
      await flushPromises();

      expect(
        browser.net.calls.filter(
          (call) => call.url === "/api/progress?view=diff"
        )
      ).toHaveLength(polls);
      teardown();
      expect(browser.clock.pending).toBe(0);
    });

    it("logs a failing progress request without breaking the diff", async () => {
      const { browser, head } = fixture();
      browser.net.handle(
        "/api/diff-branches",
        () => createDeferred<HttpResponse>().promise
      );
      browser.net.handle("/api/progress?view=diff", () =>
        Promise.reject(new Error("progress unavailable"))
      );
      initializeGraphDiffPage(browser.context, { radiusRenderGraph: vi.fn() });
      await flushPromises();

      head.dispatch("change");
      browser.clock.tick(DIFF_DEBOUNCE_MS);
      await flushPromises();
      browser.clock.tick(DIFF_PROGRESS_MS);
      await flushPromises();

      expect(
        browser.logger.errors.some(
          (entry) => entry.message === "Radius graph diff progress failed."
        )
      ).toBe(true);
    });
  });
  describe("graph build progress guards", () => {
    const stageText = graphProgressStages;

    const startCompare = async (progress: Promise<HttpResponse>) => {
      const { browser, head, progressHost } = fixture();
      browser.net.handle(
        "/api/diff-branches",
        () => createDeferred<HttpResponse>().promise
      );
      // Only the first poll gets the scripted promise. Later polls belong to
      // whatever comparison supersedes this one and never settle, so a guard
      // test can only pass by actually rejecting the superseded reply.
      let polls = 0;
      browser.net.handle("/api/progress?view=diff", () => {
        polls++;
        return polls === 1 ? progress : new Promise<HttpResponse>(() => {});
      });
      const teardown = initializeGraphDiffPage(browser.context, {
        radiusRenderGraph: vi.fn()
      });
      await flushPromises();
      head.dispatch("change");
      browser.clock.tick(DIFF_DEBOUNCE_MS);
      await flushPromises();
      return { browser, head, progressHost, teardown };
    };

    it("ignores a progress reply that belongs to a superseded comparison", async () => {
      const progress = createDeferred<HttpResponse>();
      const { browser, head, progressHost } = await startCompare(
        progress.promise
      );

      browser.clock.tick(DIFF_PROGRESS_MS);
      await flushPromises();
      head.dispatch("change");
      browser.clock.tick(DIFF_DEBOUNCE_MS);
      await flushPromises();
      progress.resolve(
        jsonResponse({
          generation: 9,
          events: [
            {
              sequence: 4,
              stage: "comparing_graphs",
              state: "running",
              detail: "Stale reply."
            }
          ]
        })
      );
      await flushPromises();

      expect(stageText(progressHost)).toEqual([
        `${GRAPH_STAGE_LABELS.building_base_graph}:running`
      ]);
    });

    it("stays silent when a superseded progress request fails", async () => {
      const progress = createDeferred<HttpResponse>();
      const { browser, head } = await startCompare(progress.promise);

      browser.clock.tick(DIFF_PROGRESS_MS);
      await flushPromises();
      head.dispatch("change");
      browser.clock.tick(DIFF_DEBOUNCE_MS);
      await flushPromises();
      progress.reject(new Error("stale progress"));
      await flushPromises();

      expect(
        browser.logger.errors.some(
          (entry) => entry.message === "Radius graph diff progress failed."
        )
      ).toBe(false);
    });

    it("ignores a progress reply that lands after teardown", async () => {
      const progress = createDeferred<HttpResponse>();
      const { browser, progressHost, teardown } = await startCompare(
        progress.promise
      );

      browser.clock.tick(DIFF_PROGRESS_MS);
      await flushPromises();
      const before = stageText(progressHost);
      teardown();
      progress.resolve(
        jsonResponse({
          generation: 3,
          events: [
            {
              sequence: 2,
              stage: "comparing_graphs",
              state: "running",
              detail: "After teardown."
            }
          ]
        })
      );
      await flushPromises();

      expect(stageText(progressHost)).toEqual(before);
    });

    it("stays silent when a progress request fails after teardown", async () => {
      const progress = createDeferred<HttpResponse>();
      const { browser, teardown } = await startCompare(progress.promise);

      browser.clock.tick(DIFF_PROGRESS_MS);
      await flushPromises();
      teardown();
      progress.reject(new Error("torn down"));
      await flushPromises();

      expect(
        browser.logger.errors.some(
          (entry) => entry.message === "Radius graph diff progress failed."
        )
      ).toBe(false);
    });
  });
});
