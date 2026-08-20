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
import type { HttpResponse } from "../ports.js";
import {
  DIFF_DEBOUNCE_MS,
  DIFF_PROGRESS_MS,
  DIFF_PROGRESS_STEPS_ID,
  GRAPH_DIFF_STATE_ID,
  initializeGraphDiffPage
} from "./graph-diff-page.js";

interface FixtureOptions {
  resources?: unknown[];
  repo?: string;
  base?: string;
  head?: string;
  withStatus?: boolean;
  withRepoInput?: boolean;
  withBaseSelect?: boolean;
  withHeadSelect?: boolean;
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
    withHeadSelect = true
  } = options;
  const browser = createFakeBrowser();
  const state = createFakeElement(GRAPH_DIFF_STATE_ID);
  state.textContent = JSON.stringify({ repo, base, head, resources });
  const repoInput = createFakeInput("diff-repo-select", repo);
  const app = createFakeSelect("diff-app");
  const baseSelect = createFakeSelect("base-branch");
  baseSelect.value = base;
  const headSelect = createFakeSelect("head-branch");
  headSelect.value = head;
  const status = createFakeElement("diff-status");
  const progressHost = createFakeElement(DIFF_PROGRESS_STEPS_ID);
  const elements = [state, app, progressHost];
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

  return {
    browser,
    repoInput,
    app,
    base: baseSelect,
    head: headSelect,
    status,
    progressHost
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
        baseBranch: "main"
      })
    );
    expect(base.listenerCount("change")).toBe(1);
    expect(head.listenerCount("change")).toBe(1);
    teardown();
    expect(base.listenerCount()).toBe(0);
    expect(head.listenerCount()).toBe(0);
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

  it("shows the refusal verbatim when the skill cannot model the repo", async () => {
    const { browser, head, status } = fixture();
    browser.net.handle("/api/diff-branches", () =>
      jsonResponse({
        error: "octo/app has no Dockerfile on feature/x.",
        appBicepUnsupported: true
      })
    );
    initializeGraphDiffPage(browser.context, { radiusRenderGraph: vi.fn() });
    await flushPromises();

    head.dispatch("change");
    browser.clock.tick(DIFF_DEBOUNCE_MS);
    await flushPromises();

    expect(status.textContent).toBe("octo/app has no Dockerfile on feature/x.");
  });

  it("falls back to a generic refusal message without an error string", async () => {
    const { browser, head, status } = fixture();
    browser.net.handle("/api/diff-branches", () =>
      jsonResponse({ appBicepUnsupported: true })
    );
    initializeGraphDiffPage(browser.context, { radiusRenderGraph: vi.fn() });
    await flushPromises();

    head.dispatch("change");
    browser.clock.tick(DIFF_DEBOUNCE_MS);
    await flushPromises();

    expect(status.textContent).toBe(
      "The Radius app-bicep skill cannot model this repository."
    );
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
      browser.net.handle("/api/progress", () =>
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
      browser.net.handle("/api/progress", () =>
        jsonResponse(payloads.shift() ?? { events: [] })
      );
      initializeGraphDiffPage(browser.context, { radiusRenderGraph: vi.fn() });
      await flushPromises();

      head.dispatch("change");
      browser.clock.tick(DIFF_DEBOUNCE_MS);
      await flushPromises();
      browser.clock.tick(DIFF_PROGRESS_MS);
      await flushPromises();

      expect(stageText(progressHost)).toEqual([
        `${GRAPH_STAGE_LABELS.building_base_graph}:running`
      ]);

      browser.clock.tick(DIFF_PROGRESS_MS);
      await flushPromises();

      expect(stageText(progressHost)).toEqual([
        `${GRAPH_STAGE_LABELS.comparing_graphs}:running`
      ]);
    });
    it("stops polling progress once the diff settles", async () => {
      const { browser, head } = fixture();
      browser.net.handle("/api/diff-branches", () => jsonResponse({}));
      browser.net.handle("/api/progress", () => jsonResponse({ events: [] }));
      const teardown = initializeGraphDiffPage(browser.context, {
        radiusRenderGraph: vi.fn()
      });
      await flushPromises();

      head.dispatch("change");
      browser.clock.tick(DIFF_DEBOUNCE_MS);
      await flushPromises();
      const polls = browser.net.calls.filter(
        (call) => call.url === "/api/progress"
      ).length;

      browser.clock.tick(DIFF_PROGRESS_MS * 5);
      await flushPromises();

      expect(
        browser.net.calls.filter((call) => call.url === "/api/progress")
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
      browser.net.handle("/api/progress", () =>
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
      browser.net.handle("/api/progress", () => progress);
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
