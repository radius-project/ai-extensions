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
import { formatElapsed } from "../progress-format.js";
import { NOOP_TEARDOWN } from "../lifecycle.js";
import type { HttpResponse } from "../ports.js";
import { GRAPH_APP_BICEP_TIMEOUT_MESSAGE } from "../../graph-progress-contract.js";
import {
  GRAPH_PAGE_STATE_ID,
  GRAPH_PLAN_BLOCKED_TITLE,
  GRAPH_PROGRESS_MS,
  GRAPH_RETRY_MAX_MS,
  GRAPH_RETRY_SCHEDULE_MS,
  GRAPH_STALE_RETRY_MS,
  graphRetryDelayMs,
  initializeGraphPage
} from "./graph-page.js";

interface FixtureOptions {
  loaded?: boolean;
  repo?: string;
  branchValue?: string;
  withStatus?: boolean;
  withWrapper?: boolean;
  withBranchSelect?: boolean;
  withButton?: boolean;
  withGuidance?: boolean;
  stateBranch?: string;
}

function fixture(options: FixtureOptions = {}) {
  const {
    loaded = false,
    repo = "octo/app",
    branchValue = "feature",
    withStatus = true,
    withWrapper = !loaded,
    withBranchSelect = true,
    withButton = true,
    withGuidance = true,
    stateBranch = "feature"
  } = options;
  const browser = createFakeBrowser();
  const state = createFakeElement(GRAPH_PAGE_STATE_ID);
  state.textContent = JSON.stringify({
    repo,
    branch: stateBranch,
    resources: loaded ? [{ id: "app/web" }] : [],
    loaded,
    localSource: true
  });
  const app = createFakeSelect("graph-app");
  const branch = createFakeSelect("graph-branch");
  branch.value = branchValue;
  const button = createFakeInput("deploy-app-btn");
  const container = createFakeElement("graph-container");
  const wrapper = createFakeElement("graph-container-wrapper");
  // The real loading surface mounts this host; the fake render globals do not,
  // so the fixture provides it for the shared progress panel to render into.
  const progressHost = createFakeElement("progress-steps");
  const guidance = createFakeElement("graph-guidance");
  guidance.textContent = "Click a node to view source code links.";
  const elements = [state, app, container, progressHost];
  if (withGuidance) elements.push(guidance);
  if (withBranchSelect) elements.push(branch);
  if (withButton) elements.push(button);
  if (withWrapper) elements.push(wrapper);
  const status =
    withStatus ?
      createFakeElement(loaded ? "graph-refresh-status" : "graph-status")
    : null;
  if (status) elements.push(status);
  for (const element of elements) browser.document.add(element);
  browser.net.handle(
    `/api/list-applications?repo=${encodeURIComponent(repo)}`,
    () => jsonResponse({ applications: [{ name: "app" }] })
  );
  browser.net.handle("/api/discover-branches", () =>
    jsonResponse({
      branches: [{ name: "feature", sha: "worktree" }],
      workspaceBranch: "feature"
    })
  );
  browser.net.handle(
    `/api/list-environments?repo=${encodeURIComponent(repo)}`,
    () => jsonResponse({ environments: [] })
  );
  // The page polls progress as soon as it starts a build, so every scenario
  // reaches this route whether or not it is what the scenario is about. A test
  // that cares overrides it.
  browser.net.handle("/api/progress?view=graph", () => jsonResponse({}));
  return {
    browser,
    state,
    app,
    branch,
    button,
    container,
    wrapper,
    status,
    progressHost,
    guidance
  };
}

function globals(overrides: Record<string, unknown> = {}) {
  return {
    radiusRenderGraph: vi.fn(),
    radiusSetGraphLoading: vi.fn(),
    radiusSetGraphError: vi.fn(),
    ...overrides
  };
}

describe("initializeGraphPage", () => {
  it("does nothing when the page state element is absent", () => {
    const browser = createFakeBrowser();
    const teardown = initializeGraphPage(browser.context, globals());
    expect(teardown).toBe(NOOP_TEARDOWN);
  });

  it("does not retain the entry binding when required globals are missing", () => {
    const { browser, branch } = fixture();
    expect(() => initializeGraphPage(browser.context, {})).toThrow(
      'Radius browser global "radiusRenderGraph" is not available.'
    );
    const teardown = initializeGraphPage(browser.context, globals());
    expect(teardown).not.toBe(NOOP_TEARDOWN);
    expect(branch.listenerCount("change")).toBe(1);
    teardown();
  });

  it("does not retain the entry binding when page state is malformed", () => {
    const { browser, state, branch } = fixture();
    state.textContent = "{";
    expect(() => initializeGraphPage(browser.context, globals())).toThrow(
      `Radius browser page state "${GRAPH_PAGE_STATE_ID}" is invalid.`
    );
    state.textContent = JSON.stringify({
      repo: "octo/app",
      branch: "feature",
      resources: [],
      loaded: false,
      localSource: true
    });
    const teardown = initializeGraphPage(browser.context, globals());
    expect(branch.listenerCount("change")).toBe(1);
    teardown();
  });

  it("renders a persisted worktree graph and refreshes it", async () => {
    const { browser, branch } = fixture({ loaded: true });
    browser.net.handle("/api/load-graph", () =>
      jsonResponse({ resources: [{ id: "app/refreshed" }] })
    );
    const render = vi.fn();
    const teardown = initializeGraphPage(
      browser.context,
      globals({
        radiusRenderGraph: render
      })
    );
    initializeGraphPage(
      browser.context,
      globals({ radiusRenderGraph: render })
    );
    await flushPromises();

    expect(render).toHaveBeenNthCalledWith(
      1,
      "graph-container",
      [{ id: "app/web" }],
      expect.objectContaining({
        branch: "feature",
        localSource: true
      })
    );
    expect(render).toHaveBeenLastCalledWith(
      "graph-container",
      [{ id: "app/refreshed" }],
      expect.any(Object)
    );
    expect(branch.listenerCount("change")).toBe(1);
    teardown();
    expect(branch.listenerCount()).toBe(0);
  });

  it("disables Plan Deployment while a loaded graph is being refreshed", async () => {
    const { browser, button } = fixture({ loaded: true });
    browser.net.handle("/api/list-environments?repo=octo%2Fapp", () =>
      jsonResponse({ environments: [{ name: "dev", provider: "azure" }] })
    );
    browser.net.handle(
      "/api/load-graph",
      () => createDeferred<HttpResponse>().promise
    );

    initializeGraphPage(browser.context, globals());
    await flushPromises();

    expect(button.dataset.mode).toBe("plan");
    expect(button.disabled).toBe(true);
  });

  it("enables Plan Deployment when the environment listing settles after the refresh", async () => {
    const { browser, button } = fixture({ loaded: true });
    const environments = createDeferred<HttpResponse>();
    browser.net.handle(
      "/api/list-environments?repo=octo%2Fapp",
      () => environments.promise
    );
    browser.net.handle("/api/load-graph", () =>
      jsonResponse({ resources: [{ id: "app/web" }] })
    );

    initializeGraphPage(browser.context, globals());
    await flushPromises();

    // The listing is what assigns the button its "plan" mode, so a graph that
    // compiled before it arrives must still leave the button usable.
    environments.resolve(
      jsonResponse({ environments: [{ name: "dev", provider: "azure" }] })
    );
    await flushPromises();

    expect(button.dataset.mode).toBe("plan");
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("title")).toBeNull();
  });

  it("leaves Plan Deployment disabled when the model failed before the environment listing settles", async () => {
    const { browser, button } = fixture({ loaded: true });
    const environments = createDeferred<HttpResponse>();
    browser.net.handle(
      "/api/list-environments?repo=octo%2Fapp",
      () => environments.promise
    );
    browser.net.handle("/api/load-graph", () =>
      jsonResponse({
        error: "Your application model couldn't be compiled.",
        modelingFailed: true
      })
    );

    initializeGraphPage(
      browser.context,
      globals({ radiusSetGraphError: vi.fn() })
    );
    await flushPromises();

    environments.resolve(
      jsonResponse({ environments: [{ name: "dev", provider: "azure" }] })
    );
    await flushPromises();

    expect(button.dataset.mode).toBe("plan");
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toBe(GRAPH_PLAN_BLOCKED_TITLE);
  });

  it("does not re-enable a button owned by the create-environment mode", async () => {
    const { browser, button } = fixture({ loaded: true });
    browser.net.handle("/api/load-graph", () =>
      jsonResponse({ resources: [{ id: "app/web" }] })
    );

    initializeGraphPage(browser.context, globals());
    await flushPromises();

    expect(button.dataset.mode).toBe("create-env");
    expect(button.disabled).toBe(false);
  });

  it("falls back to the rendered branch when the page has no branch selector", async () => {
    const { browser, button } = fixture({
      loaded: true,
      withBranchSelect: false
    });
    browser.net.handle("/api/list-environments?repo=octo%2Fapp", () =>
      jsonResponse({ environments: [{ name: "dev", provider: "azure" }] })
    );
    browser.net.handle("/api/load-graph", () =>
      jsonResponse({ resources: [{ id: "app/web" }] })
    );

    initializeGraphPage(browser.context, globals());
    await flushPromises();

    expect(button.dataset.mode).toBe("plan");
    expect(button.disabled).toBe(false);
  });

  it("polls progress immediately and then once per interval, ignoring a late response", async () => {
    const { browser } = fixture({ loaded: false });
    browser.net.supportsAbort = false;
    const load = createDeferred<HttpResponse>();
    browser.net.handle("/api/load-graph", () => load.promise);
    browser.net.handle("/api/progress?view=graph", () =>
      jsonResponse({ messages: ["Drafting .radius/app.bicep"] })
    );
    const teardown = initializeGraphPage(browser.context, globals());
    await flushPromises();

    // A build already in flight is adopted without waiting out an interval, so
    // a user returning to this page does not watch an empty panel first.
    expect(
      browser.net.calls.filter(
        (call) => call.url === "/api/progress?view=graph"
      )
    ).toHaveLength(1);
    browser.clock.tick(GRAPH_PROGRESS_MS);
    await flushPromises();
    expect(
      browser.net.calls.filter(
        (call) => call.url === "/api/progress?view=graph"
      )
    ).toHaveLength(2);
    teardown();
    load.resolve(jsonResponse({ reload: true }));
    await flushPromises();
    expect(browser.nav.reloads).toBe(0);
    expect(browser.clock.pending).toBe(0);
  });

  it("keeps external error detail out of user-visible failures", async () => {
    const setError = vi.fn();
    const { browser, status } = fixture({ loaded: false });
    browser.net.handle("/api/load-graph", () =>
      Promise.reject(new Error("credential-like detail"))
    );
    initializeGraphPage(
      browser.context,
      globals({ radiusSetGraphError: setError })
    );
    await flushPromises();

    expect(setError).toHaveBeenCalledWith(
      "graph-container",
      "Failed to generate the application graph."
    );
    expect(setError.mock.calls[0]?.[1]).not.toContain("credential-like");
    // Reported once: the strip above the surface is cleared rather than
    // repeating the same error in a second box.
    expect(status?.textContent).toBe("");
    expect(browser.logger.errors.length).toBeGreaterThan(0);
  });

  it("reports a failure once instead of in both error surfaces", async () => {
    const setError = vi.fn();
    const { browser, status } = fixture({ loaded: false });
    browser.net.handle("/api/load-graph", () =>
      jsonResponse({ error: "app.bicep is invalid" })
    );
    initializeGraphPage(
      browser.context,
      globals({ radiusSetGraphError: setError })
    );
    await flushPromises();

    // The strip sits directly above the graph surface, so leaving the message
    // in both renders the same error twice.
    expect(setError).toHaveBeenCalledTimes(1);
    expect(status?.textContent).toBe("");
    expect(status?.style.display).toBe("none");
  });

  it("disables planning when the selected model does not compile", async () => {
    const setError = vi.fn();
    const { browser, button, branch } = fixture({ loaded: false });
    browser.net.handle("/api/list-environments?repo=octo%2Fapp", () =>
      jsonResponse({ environments: [{ name: "dev", provider: "azure" }] })
    );
    browser.net.handle("/api/load-graph", () =>
      jsonResponse({
        error: "Your application model couldn't be compiled.",
        modelingFailed: true
      })
    );

    initializeGraphPage(
      browser.context,
      globals({ radiusSetGraphError: setError })
    );
    await flushPromises();

    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toContain(
      "until the application model"
    );
    expect(branch.listenerCount("change")).toBe(1);
  });

  it("still offers environment creation when the model does not compile", async () => {
    // Creating an environment is a prerequisite the model cannot invalidate, so
    // a compile failure must not strand a repository with no environment.
    const { browser, button } = fixture({ loaded: false });
    browser.net.handle("/api/load-graph", () =>
      jsonResponse({
        error: "Your application model couldn't be compiled.",
        modelingFailed: true
      })
    );

    initializeGraphPage(
      browser.context,
      globals({ radiusSetGraphError: vi.fn() })
    );
    await flushPromises();

    expect(button.dataset.mode).toBe("create-env");
    expect(button.disabled).toBe(false);
  });

  it("keeps Plan Deployment disabled while a changed branch is compiling", async () => {
    const { browser, branch, button } = fixture({ loaded: true });
    browser.net.handle("/api/list-environments?repo=octo%2Fapp", () =>
      jsonResponse({ environments: [{ name: "dev", provider: "azure" }] })
    );
    browser.net.handle("/api/load-graph", () =>
      jsonResponse({ resources: [{ id: "app/web" }] })
    );
    initializeGraphPage(browser.context, globals());
    await flushPromises();
    expect(button.dataset.mode).toBe("plan");

    browser.net.handle(
      "/api/load-graph",
      () => createDeferred<HttpResponse>().promise
    );
    branch.value = "another";
    branch.dispatch("change");

    expect(button.disabled).toBe(true);
  });

  it("silently skips the status update when no status element exists", async () => {
    const { browser } = fixture({ loaded: false, withStatus: false });
    browser.net.handle("/api/load-graph", () =>
      Promise.reject(new Error("network down"))
    );
    expect(() => {
      initializeGraphPage(browser.context, globals());
    }).not.toThrow();
    await flushPromises();
    expect(browser.logger.errors.length).toBeGreaterThan(0);
  });

  it("ignores an automatic branch load already superseded by a manual one", async () => {
    const { browser, branch, button } = fixture({ loaded: false });
    const load = createDeferred<HttpResponse>();
    let loadCalls = 0;
    browser.net.handle("/api/load-graph", () => {
      loadCalls++;
      return load.promise;
    });
    button.disabled = true;
    initializeGraphPage(browser.context, globals());
    // Dispatch a manual branch change synchronously, before the automatic
    // branches-loaded follow-up has a chance to run, so its own load() call
    // is superseded and the requestActive guard rejects the duplicate.
    branch.dispatch("change");
    await flushPromises();

    expect(loadCalls).toBe(1);
    expect(button.disabled).toBe(false);
    load.resolve(jsonResponse({ reload: true }));
    await flushPromises();
  });

  it("does not let a late branch listing replace the latest dropdown selection", async () => {
    const { browser, branch } = fixture({ loaded: false });
    const branches = createDeferred<HttpResponse>();
    const graph = createDeferred<HttpResponse>();
    browser.net.handle("/api/discover-branches", () => branches.promise);
    browser.net.handle("/api/load-graph", () => graph.promise);

    initializeGraphPage(browser.context, globals());
    branch.value = "release";
    branch.dispatch("change");
    branch.value = "hotfix";
    branch.dispatch("change");
    branches.resolve(
      jsonResponse({
        branches: [
          { name: "main", sha: "aaaaaaa" },
          { name: "release", sha: "bbbbbbb" }
        ]
      })
    );
    await flushPromises();

    expect(branch.value).toBe("hotfix");
    graph.resolve(jsonResponse({ resources: [{ id: "app/current" }] }));
    await flushPromises();
  });

  it("skips the automatic load when no branch is selected", async () => {
    const { browser, button } = fixture({ loaded: false, branchValue: "" });
    browser.net.handle("/api/discover-branches", () =>
      jsonResponse({ branches: [], workspaceBranch: "" })
    );
    button.disabled = false;
    initializeGraphPage(browser.context, globals());
    await flushPromises();

    expect(button.disabled).toBe(false);
    expect(
      browser.net.calls.some((call) => call.url === "/api/load-graph")
    ).toBe(false);
  });

  it("skips the automatic branches follow-up load when already loaded", async () => {
    const { browser, button } = fixture({ loaded: true });
    browser.net.handle("/api/list-environments?repo=octo%2Fapp", () =>
      jsonResponse({ environments: [{ name: "dev", provider: "azure" }] })
    );
    button.disabled = true;
    browser.net.handle("/api/load-graph", () => jsonResponse({}));
    initializeGraphPage(browser.context, globals());
    await flushPromises();

    expect(button.disabled).toBe(true);
  });

  it("shows an info prompt when no repository is available to load", async () => {
    const { browser, status } = fixture({ loaded: false, repo: "" });
    initializeGraphPage(browser.context, globals());
    await flushPromises();

    expect(status?.textContent).toBe(
      "Select a branch to generate the application graph."
    );
  });

  it("does not reload for a legacy reload-only graph response", async () => {
    const setError = vi.fn();
    const { browser } = fixture({ loaded: false });
    browser.net.handle("/api/load-graph", () => jsonResponse({ reload: true }));
    initializeGraphPage(
      browser.context,
      globals({ radiusSetGraphError: setError })
    );
    await flushPromises();

    expect(browser.nav.reloads).toBe(0);
    expect(setError).toHaveBeenCalledWith(
      "graph-container",
      "The application graph response did not include any resources."
    );
  });

  it("renders generated resources in place without reloading", async () => {
    const { browser, branch, status, wrapper } = fixture({ loaded: false });
    const render = vi.fn();
    let calls = 0;
    browser.net.handle("/api/load-graph", () => {
      calls++;
      return (
        calls === 1 ? jsonResponse({ needsAppBicep: true })
        : calls === 2 ?
          jsonResponse({
            reload: true,
            resources: [{ id: "app/generated" }],
            fromWorkspace: false
          })
        : jsonResponse({ needsAppBicep: true })
      );
    });
    initializeGraphPage(
      browser.context,
      globals({
        radiusRenderGraph: render
      })
    );
    await flushPromises();
    browser.clock.tick(GRAPH_RETRY_MAX_MS);
    await flushPromises();

    expect(browser.nav.reloads).toBe(0);
    expect(
      browser.net.calls.filter((call) => call.url === "/api/load-graph")
    ).toHaveLength(2);
    expect(render).toHaveBeenCalledWith(
      "graph-container",
      expect.arrayContaining([
        expect.objectContaining({ id: "app/generated" })
      ]),
      expect.objectContaining({
        branch: "feature",
        localSource: false
      })
    );
    expect(status?.textContent).toBe("Application graph ready.");
    expect(status?.style.display).toBe("none");
    expect(wrapper.children[0]?.id).toBe("graph-container");
    expect(wrapper.children[1]?.textContent).toBe(
      "Click a node to view source code links."
    );

    branch.value = "without-model";
    branch.dispatch("change");
    await flushPromises();

    expect(status?.textContent).toContain(
      "Copilot is generating .radius/app.bicep"
    );
    expect(browser.clock.timeouts).toBe(1);
    expect(calls).toBe(3);
  });

  it("presents an empty successful graph as loaded without a ready banner", async () => {
    const { browser, status, wrapper } = fixture({ loaded: false });
    const render = vi.fn();
    browser.net.handle("/api/load-graph", () =>
      jsonResponse({
        reload: true,
        resources: [],
        fromWorkspace: true
      })
    );
    initializeGraphPage(
      browser.context,
      globals({
        radiusRenderGraph: render
      })
    );
    await flushPromises();

    expect(render).toHaveBeenCalledWith(
      "graph-container",
      [],
      expect.objectContaining({ localSource: true })
    );
    expect(status?.style.display).toBe("none");
    expect(wrapper.children[1]?.textContent).toBe(
      "Click a node to view source code links."
    );
  });

  it("schedules a slow retry while Copilot drafts app.bicep and cancels it on a branch change", async () => {
    const { browser, branch, status } = fixture({ loaded: false });
    let calls = 0;
    const bodies: string[] = [];
    browser.net.handle("/api/load-graph", (init) => {
      calls++;
      bodies.push(String(init?.body ?? ""));
      return jsonResponse({ needsAppBicep: true });
    });
    initializeGraphPage(browser.context, globals());
    await flushPromises();

    expect(status?.textContent).toContain(
      "Copilot is generating .radius/app.bicep"
    );
    expect(browser.clock.timeouts).toBe(1);
    expect(calls).toBe(1);

    branch.dispatch("change");
    await flushPromises();
    // The retry from the first request must have been cancelled, so only the
    // manual branch-change load happened, not an extra retry-triggered load.
    expect(calls).toBe(2);

    browser.clock.tick(GRAPH_RETRY_MAX_MS);
    await flushPromises();
    expect(calls).toBe(3);
    expect(bodies[0]).toContain('"restartWait":true');
    expect(bodies[1]).toContain('"restartWait":true');
    expect(bodies[2]).toContain('"restartWait":false');
  });

  it("keeps the generating status stable while an automatic retry is pending", async () => {
    const { browser, status } = fixture({ loaded: false });
    const retry = createDeferred<HttpResponse>();
    let calls = 0;
    browser.net.handle("/api/load-graph", () => {
      calls++;
      return calls === 1 ?
          jsonResponse({ needsAppBicep: true })
        : retry.promise;
    });
    initializeGraphPage(browser.context, globals());
    await flushPromises();
    const generating = status?.textContent;

    browser.clock.tick(GRAPH_RETRY_MAX_MS);
    await flushPromises();

    expect(calls).toBe(2);
    expect(status?.textContent).toBe(generating);

    retry.resolve(jsonResponse({ needsAppBicep: true }));
    await flushPromises();
    expect(status?.textContent).toBe(generating);
  });

  it("retries quickly after a stale response", async () => {
    const { browser, status } = fixture({ loaded: false });
    let calls = 0;
    browser.net.handle("/api/load-graph", () => {
      calls++;
      return calls === 1 ?
          jsonResponse({ stale: true })
        : jsonResponse({ resources: [{ id: "app/current" }] });
    });
    initializeGraphPage(browser.context, globals());
    await flushPromises();

    expect(status?.textContent).toContain("newer graph request");
    expect(browser.clock.timeouts).toBe(1);

    browser.clock.tick(GRAPH_STALE_RETRY_MS);
    await flushPromises();
    expect(calls).toBe(2);
    expect(browser.nav.reloads).toBe(0);
  });

  // Copilot usually finishes authoring the model within the first few seconds.
  // The wait between polls therefore starts short and only lengthens for a
  // genuinely slow modeling run, so the common case does not pay the worst
  // case's idle time.
  describe("app.bicep wait backoff", () => {
    it("schedules each attempt at its position in the backoff schedule", () => {
      expect(
        GRAPH_RETRY_SCHEDULE_MS.map((_, attempt) => graphRetryDelayMs(attempt))
      ).toEqual([...GRAPH_RETRY_SCHEDULE_MS]);
    });

    it("holds at the last schedule entry once the schedule is exhausted", () => {
      expect(graphRetryDelayMs(GRAPH_RETRY_SCHEDULE_MS.length)).toBe(
        GRAPH_RETRY_MAX_MS
      );
      expect(graphRetryDelayMs(10_000)).toBe(GRAPH_RETRY_MAX_MS);
    });

    it.each([
      ["a negative attempt", -1],
      ["a fractional attempt", 0.9],
      ["a non-finite attempt", Number.NaN]
    ])("falls back to the first delay for %s", (_label, attempt) => {
      expect(graphRetryDelayMs(attempt)).toBe(GRAPH_RETRY_SCHEDULE_MS[0]);
    });

    it("polls again within the first schedule step rather than the longest one", async () => {
      const { browser } = fixture({ loaded: false });
      let calls = 0;
      browser.net.handle("/api/load-graph", () => {
        calls++;
        return jsonResponse({ needsAppBicep: true });
      });
      initializeGraphPage(browser.context, globals());
      await flushPromises();
      expect(calls).toBe(1);

      browser.clock.tick(GRAPH_RETRY_SCHEDULE_MS[0] - 1);
      await flushPromises();
      expect(calls).toBe(1);

      browser.clock.tick(1);
      await flushPromises();
      expect(calls).toBe(2);
    });

    it("lengthens the wait with each successive retry of the same wait", async () => {
      const { browser } = fixture({ loaded: false });
      let calls = 0;
      browser.net.handle("/api/load-graph", () => {
        calls++;
        return jsonResponse({ needsAppBicep: true });
      });
      initializeGraphPage(browser.context, globals());
      await flushPromises();

      for (const [index, delay] of GRAPH_RETRY_SCHEDULE_MS.entries()) {
        browser.clock.tick(delay - 1);
        await flushPromises();
        expect(calls).toBe(index + 1);

        browser.clock.tick(1);
        await flushPromises();
        expect(calls).toBe(index + 2);
      }

      // Past the end of the schedule the wait holds steady instead of growing.
      browser.clock.tick(GRAPH_RETRY_MAX_MS - 1);
      await flushPromises();
      expect(calls).toBe(GRAPH_RETRY_SCHEDULE_MS.length + 1);

      browser.clock.tick(1);
      await flushPromises();
      expect(calls).toBe(GRAPH_RETRY_SCHEDULE_MS.length + 2);
    });

    it("restarts the backoff when a fresh request starts a new wait", async () => {
      const { browser, branch } = fixture({ loaded: false });
      let calls = 0;
      browser.net.handle("/api/load-graph", () => {
        calls++;
        return jsonResponse({ needsAppBicep: true });
      });
      initializeGraphPage(browser.context, globals());
      await flushPromises();

      browser.clock.tick(GRAPH_RETRY_SCHEDULE_MS[0]);
      await flushPromises();
      browser.clock.tick(GRAPH_RETRY_SCHEDULE_MS[1]);
      await flushPromises();
      expect(calls).toBe(3);

      branch.dispatch("change");
      await flushPromises();
      expect(calls).toBe(4);

      // The new wait is its own sequence, so it must not inherit the previous
      // one's longer delay.
      browser.clock.tick(GRAPH_RETRY_SCHEDULE_MS[0] - 1);
      await flushPromises();
      expect(calls).toBe(4);

      browser.clock.tick(1);
      await flushPromises();
      expect(calls).toBe(5);
    });

    it("backs off the preloaded graph refresh on the same schedule", async () => {
      const { browser } = fixture({ loaded: true });
      let calls = 0;
      browser.net.handle("/api/load-graph", () => {
        calls++;
        return jsonResponse({ needsAppBicep: true });
      });
      initializeGraphPage(browser.context, globals());
      await flushPromises();
      expect(calls).toBe(1);

      browser.clock.tick(GRAPH_RETRY_SCHEDULE_MS[0] - 1);
      await flushPromises();
      expect(calls).toBe(1);

      browser.clock.tick(1);
      await flushPromises();
      expect(calls).toBe(2);

      browser.clock.tick(GRAPH_RETRY_SCHEDULE_MS[1] - 1);
      await flushPromises();
      expect(calls).toBe(2);

      browser.clock.tick(1);
      await flushPromises();
      expect(calls).toBe(3);
    });
  });

  it("surfaces a load error message returned by the server", async () => {
    const { browser, status } = fixture({ loaded: false });
    const setError = vi.fn();
    browser.net.handle("/api/load-graph", () =>
      jsonResponse({ error: "app.bicep is invalid" })
    );
    initializeGraphPage(
      browser.context,
      globals({ radiusSetGraphError: setError })
    );
    await flushPromises();

    expect(setError).toHaveBeenCalledWith(
      "graph-container",
      "app.bicep is invalid"
    );
    expect(status?.textContent).toBe("");
  });

  it("regenerates the graph for a newly selected branch in place", async () => {
    const { browser, branch, status } = fixture({ loaded: true });
    browser.net.handle("/api/load-graph", () =>
      jsonResponse({ resources: [{ id: "app/current" }] })
    );
    initializeGraphPage(browser.context, globals());
    await flushPromises();

    branch.value = "another";
    branch.dispatch("change");
    expect(status?.textContent).toContain(
      "Checking the selected branch for .radius/app.bicep"
    );
    await flushPromises();

    expect(browser.nav.reloads).toBe(0);
  });

  it("aborts an in-flight graph and requests the newly selected branch", async () => {
    const { browser, branch } = fixture({ loaded: false });
    const first = createDeferred<HttpResponse>();
    const requestedBranches: string[] = [];
    browser.net.handle("/api/load-graph", (init) => {
      const body = JSON.parse(String(init?.body)) as { branch?: string };
      requestedBranches.push(body.branch || "");
      return requestedBranches.length === 1 ?
          first.promise
        : jsonResponse({ resources: [] });
    });
    initializeGraphPage(browser.context, globals());
    await flushPromises();

    branch.value = "another";
    branch.dispatch("change");
    await flushPromises();

    expect(browser.net.aborted).toBe(1);
    expect(requestedBranches).toEqual(["feature", "another"]);
  });

  it("updates a loaded graph for a new branch using response provenance", async () => {
    const { browser, branch } = fixture({
      loaded: true,
      withStatus: false
    });
    const first = { update: vi.fn(() => first), destroy: vi.fn() };
    const render = vi.fn().mockReturnValueOnce(first);
    let calls = 0;
    browser.net.handle("/api/load-graph", () => {
      calls++;
      return calls === 1 ?
          jsonResponse({})
        : jsonResponse({
            resources: [{ id: "app/remote" }],
            fromWorkspace: false
          });
    });
    initializeGraphPage(
      browser.context,
      globals({
        radiusRenderGraph: render
      })
    );
    await flushPromises();

    branch.value = "remote";
    branch.dispatch("change");
    await flushPromises();

    expect(render).toHaveBeenLastCalledWith(
      "graph-container",
      [{ id: "app/remote" }],
      expect.objectContaining({
        branch: "remote",
        localSource: false
      })
    );
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(first.update).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("surfaces a regenerate error message returned by the server", async () => {
    const setError = vi.fn();
    const { browser, branch, status } = fixture({ loaded: true });
    browser.net.handle("/api/load-graph", () =>
      jsonResponse({ error: "cannot regenerate" })
    );
    initializeGraphPage(
      browser.context,
      globals({ radiusSetGraphError: setError })
    );
    await flushPromises();

    branch.value = "another";
    branch.dispatch("change");
    await flushPromises();

    expect(setError).toHaveBeenCalledWith(
      "graph-container",
      "cannot regenerate"
    );
    expect(status?.textContent).toBe("");
  });

  it("keeps request error detail out of user-visible failures", async () => {
    const setError = vi.fn();
    const { browser, branch, status } = fixture({ loaded: true });
    browser.net.handle("/api/load-graph", () =>
      Promise.reject(new Error("secret-shaped detail"))
    );
    initializeGraphPage(
      browser.context,
      globals({ radiusSetGraphError: setError })
    );
    await flushPromises();

    branch.value = "another";
    branch.dispatch("change");
    await flushPromises();

    expect(setError).toHaveBeenCalledWith(
      "graph-container",
      "Failed to generate the application graph."
    );
    expect(setError.mock.calls[0]?.[1]).not.toContain("secret-shaped");
    expect(status?.textContent).toBe("");
    expect(browser.logger.errors.length).toBeGreaterThan(0);
  });

  it("ignores a stale regenerate response superseded by another branch change", async () => {
    const { browser, branch } = fixture({ loaded: true });
    browser.net.supportsAbort = false;
    const stale = createDeferred<HttpResponse>();
    let calls = 0;
    browser.net.handle("/api/load-graph", () => {
      calls++;
      if (calls === 1) return jsonResponse({});
      if (calls === 2) return stale.promise;
      return jsonResponse({ resources: [{ id: "app/current" }] });
    });
    initializeGraphPage(browser.context, globals());
    await flushPromises();

    branch.value = "one";
    branch.dispatch("change");
    branch.value = "two";
    branch.dispatch("change");
    await flushPromises();

    stale.resolve(jsonResponse({ reload: true }));
    await flushPromises();
    expect(browser.nav.reloads).toBe(0);
  });

  it("does nothing when reloading a branch without a repository", async () => {
    const { browser, branch } = fixture({ loaded: true, repo: "" });
    browser.net.handle("/api/load-graph", () => jsonResponse({}));
    initializeGraphPage(browser.context, globals());
    await flushPromises();
    const callsBeforeChange = browser.net.calls.filter(
      (call) => call.url === "/api/load-graph"
    ).length;

    branch.value = "another";
    branch.dispatch("change");
    await flushPromises();

    expect(
      browser.net.calls.filter((call) => call.url === "/api/load-graph").length
    ).toBe(callsBeforeChange);
  });

  it("delegates deploy button clicks to the shared modeled primary action", async () => {
    const { browser, button, app } = fixture({ loaded: false });
    browser.net.handle("/api/load-graph", () => jsonResponse({}));
    browser.net.handle("/api/list-environments?repo=octo%2Fapp", () =>
      jsonResponse({ environments: [{ name: "dev", provider: "azure" }] })
    );
    initializeGraphPage(browser.context, globals());
    await flushPromises();

    app.value = "app";
    button.disabled = false;
    button.dispatch("click");
    expect(browser.nav.assigned).toEqual(["/?page=planned&app=app"]);

    browser.nav.assigned.length = 0;
    button.disabled = true;
    button.dispatch("click");
    expect(browser.nav.assigned).toEqual([]);
  });

  it("updates the existing controller in place when the graph accepts refreshed resources", async () => {
    const { browser } = fixture({ loaded: true });
    const controller = { update: vi.fn(() => controller), destroy: vi.fn() };
    const render = vi.fn(() => controller);
    browser.net.handle("/api/load-graph", () =>
      jsonResponse({ resources: [{ id: "app/refreshed" }] })
    );
    initializeGraphPage(
      browser.context,
      globals({ radiusRenderGraph: render })
    );
    await flushPromises();

    expect(render).toHaveBeenCalledTimes(1);
    expect(controller.update).toHaveBeenCalledWith([{ id: "app/refreshed" }]);
    expect(controller.destroy).not.toHaveBeenCalled();
  });

  it("destroys and recreates the controller when the graph cannot accept refreshed resources", async () => {
    const { browser } = fixture({ loaded: true });
    const first = { update: vi.fn(() => null), destroy: vi.fn() };
    const second = { update: vi.fn(() => second), destroy: vi.fn() };
    const render = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    browser.net.handle("/api/load-graph", () =>
      jsonResponse({ resources: [{ id: "app/refreshed" }] })
    );
    const teardown = initializeGraphPage(
      browser.context,
      globals({ radiusRenderGraph: render })
    );
    await flushPromises();

    expect(render).toHaveBeenCalledTimes(2);
    expect(first.update).toHaveBeenCalledWith([{ id: "app/refreshed" }]);
    expect(first.destroy).toHaveBeenCalledTimes(1);
    teardown();
    expect(second.destroy).toHaveBeenCalledTimes(1);
  });

  it("re-renders a refreshed graph when the server reports new provenance", async () => {
    const { browser } = fixture({ loaded: true });
    const first = { update: vi.fn(() => first), destroy: vi.fn() };
    const second = { update: vi.fn(() => second), destroy: vi.fn() };
    const render = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    browser.net.handle("/api/load-graph", () =>
      jsonResponse({
        resources: [{ id: "app/refreshed" }],
        fromWorkspace: false
      })
    );
    initializeGraphPage(
      browser.context,
      globals({ radiusRenderGraph: render })
    );
    await flushPromises();

    // update() keeps the options it was rendered with, so changed provenance
    // only reaches the source links through a fresh render.
    expect(first.update).not.toHaveBeenCalled();
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenLastCalledWith(
      "graph-container",
      [{ id: "app/refreshed" }],
      expect.objectContaining({ localSource: false })
    );
  });

  it("keeps page provenance when a graph response omits it", async () => {
    const { browser } = fixture({ loaded: false });
    const render = vi.fn();
    browser.net.handle("/api/load-graph", () =>
      jsonResponse({ reload: true, resources: [{ id: "app/generated" }] })
    );
    initializeGraphPage(
      browser.context,
      globals({ radiusRenderGraph: render })
    );
    await flushPromises();

    expect(render).toHaveBeenCalledWith(
      "graph-container",
      [{ id: "app/generated" }],
      expect.objectContaining({ localSource: true })
    );
  });

  it("retries a preloaded graph refresh until the replacement model lands", async () => {
    const render = vi.fn();
    const { browser, status } = fixture({ loaded: true });
    let calls = 0;
    browser.net.handle("/api/load-graph", () => {
      calls++;
      return calls === 1 ?
          jsonResponse({ needsAppBicep: true })
        : jsonResponse({
            resources: [{ id: "app/rebuilt" }],
            fromWorkspace: true
          });
    });
    browser.net.handle("/api/progress?view=graph", () =>
      jsonResponse({
        generation: 1,
        events: [
          {
            sequence: 1,
            stage: "checking_model",
            state: "succeeded",
            detail: "No application model exists yet."
          },
          {
            sequence: 2,
            stage: "creating_model",
            state: "running",
            detail: "Copilot is creating the application model."
          }
        ]
      })
    );
    initializeGraphPage(
      browser.context,
      globals({ radiusRenderGraph: render })
    );
    await flushPromises();

    expect(status?.textContent).toContain("rebuilding the application graph");
    browser.clock.tick(GRAPH_RETRY_MAX_MS);
    await flushPromises();

    expect(calls).toBe(2);
    expect(render).toHaveBeenLastCalledWith(
      "graph-container",
      [{ id: "app/rebuilt" }],
      expect.objectContaining({ localSource: true })
    );
  });

  it("retries a loaded graph until the rebuilt model is available", async () => {
    const { browser, status } = fixture({ loaded: true });
    const render = vi.fn();
    let calls = 0;
    browser.net.handle("/api/load-graph", () => {
      calls++;
      return calls === 1 ?
          jsonResponse({ needsAppBicep: true })
        : jsonResponse({ resources: [{ id: "app/rebuilt" }] });
    });
    initializeGraphPage(
      browser.context,
      globals({ radiusRenderGraph: render })
    );
    await flushPromises();

    browser.clock.tick(GRAPH_RETRY_MAX_MS);
    await flushPromises();

    expect(calls).toBe(2);
    expect(render).toHaveBeenLastCalledWith(
      "graph-container",
      [{ id: "app/rebuilt" }],
      expect.objectContaining({ branch: "feature" })
    );
    expect(status?.textContent).toBe("Application graph ready.");
    expect(browser.nav.reloads).toBe(0);
  });

  it("keeps a pending branch listing current across loaded-graph retries", async () => {
    const { browser, branch } = fixture({ loaded: true });
    const branches = createDeferred<HttpResponse>();
    let calls = 0;
    browser.net.handle("/api/discover-branches", () => branches.promise);
    browser.net.handle("/api/load-graph", () => {
      calls++;
      return calls === 1 ?
          jsonResponse({ needsAppBicep: true })
        : jsonResponse({ resources: [{ id: "app/rebuilt" }] });
    });
    initializeGraphPage(browser.context, globals());
    await flushPromises();

    browser.clock.tick(GRAPH_RETRY_MAX_MS);
    await flushPromises();
    branches.resolve(
      jsonResponse({
        branches: [
          { name: "feature", sha: "aaaaaaa" },
          { name: "release", sha: "bbbbbbb" }
        ]
      })
    );
    await flushPromises();

    expect(Array.from(branch.options).map((option) => option.value)).toContain(
      "release"
    );
  });

  it("preserves a loaded graph when the server ends the model wait", async () => {
    const { browser, status } = fixture({ loaded: true });
    const controller = { update: vi.fn(() => controller), destroy: vi.fn() };
    const setError = vi.fn();
    let calls = 0;
    const bodies: string[] = [];
    browser.net.handle("/api/load-graph", (init) => {
      calls++;
      bodies.push(String(init?.body ?? ""));
      return calls === 1 ?
          jsonResponse({ needsAppBicep: true })
        : jsonResponse({ error: GRAPH_APP_BICEP_TIMEOUT_MESSAGE });
    });
    initializeGraphPage(
      browser.context,
      globals({
        radiusRenderGraph: vi.fn(() => controller),
        radiusSetGraphError: setError
      })
    );
    await flushPromises();

    browser.clock.tick(GRAPH_RETRY_MAX_MS);
    await flushPromises();

    // The page owns no clock of its own: it waits until the server stops
    // answering `needsAppBicep`, and only the first request may restart that
    // server-side wait.
    expect(calls).toBe(2);
    expect(bodies[0]).toContain('"restartWait":true');
    expect(bodies[1]).toContain('"restartWait":false');
    expect(controller.destroy).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
    expect(status?.textContent).toBe(
      `Unable to refresh the application graph: ${GRAPH_APP_BICEP_TIMEOUT_MESSAGE}`
    );
  });

  it("retries a stale loaded-graph refresh without replacing the current graph", async () => {
    const { browser, status } = fixture({ loaded: true });
    const controller = { update: vi.fn(() => controller), destroy: vi.fn() };
    const render = vi.fn(() => controller);
    let calls = 0;
    browser.net.handle("/api/load-graph", () => {
      calls++;
      return calls === 1 ?
          jsonResponse({ stale: true })
        : jsonResponse({ resources: [{ id: "app/refreshed" }] });
    });
    initializeGraphPage(
      browser.context,
      globals({ radiusRenderGraph: render })
    );
    await flushPromises();

    expect(status?.textContent).toContain("Retrying");
    expect(controller.destroy).not.toHaveBeenCalled();
    browser.clock.tick(GRAPH_STALE_RETRY_MS);
    await flushPromises();

    expect(calls).toBe(2);
    expect(controller.update).toHaveBeenCalledWith([{ id: "app/refreshed" }]);
    expect(controller.destroy).not.toHaveBeenCalled();
  });

  it("preserves the current graph when a refresh response has no resources", async () => {
    const { browser, status } = fixture({ loaded: true });
    const controller = { update: vi.fn(() => controller), destroy: vi.fn() };
    const render = vi.fn(() => controller);
    const setError = vi.fn();
    browser.net.handle("/api/load-graph", () => jsonResponse({}));

    initializeGraphPage(
      browser.context,
      globals({ radiusRenderGraph: render, radiusSetGraphError: setError })
    );
    await flushPromises();

    expect(render).toHaveBeenCalledTimes(1);
    expect(controller.destroy).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
    expect(status?.textContent).toBe(
      "Unable to refresh the application graph: the response did not include any resources."
    );
  });

  it("surfaces a refresh error message from the server", async () => {
    const { browser, status } = fixture({ loaded: true });
    browser.net.handle("/api/load-graph", () =>
      jsonResponse({ error: "bad refresh" })
    );
    initializeGraphPage(browser.context, globals());
    await flushPromises();

    expect(status?.textContent).toBe(
      "Unable to refresh the application graph: bad refresh"
    );
  });

  it("keeps refresh error detail out of user-visible failures", async () => {
    const { browser, status } = fixture({ loaded: true });
    browser.net.handle("/api/load-graph", () =>
      Promise.reject(new Error("secret-refresh-detail"))
    );
    initializeGraphPage(browser.context, globals());
    await flushPromises();

    expect(status?.textContent).toBe(
      "Unable to refresh the application graph."
    );
    expect(status?.textContent).not.toContain("secret-refresh-detail");
    expect(browser.logger.errors.length).toBeGreaterThan(0);
  });

  it("ignores a stale refresh response superseded by a branch change", async () => {
    const { browser, branch } = fixture({ loaded: true });
    browser.net.supportsAbort = false;
    const refresh = createDeferred<HttpResponse>();
    browser.net.handle("/api/load-graph", () => refresh.promise);
    initializeGraphPage(browser.context, globals());
    branch.dispatch("change");
    await flushPromises();

    refresh.resolve(jsonResponse({ resources: [{ id: "app/refreshed" }] }));
    await flushPromises();
    // The stale refresh must not have re-armed requestAbort after teardown of
    // its own generation, so a subsequent load should proceed normally.
    expect(
      browser.net.calls.filter((call) => call.url === "/api/load-graph")
    ).toHaveLength(2);
  });

  it("surfaces an error when branches cannot be loaded", async () => {
    const { browser, status } = fixture({ loaded: false });
    browser.net.handle("/api/discover-branches", () =>
      Promise.reject(new Error("branches unavailable"))
    );
    initializeGraphPage(browser.context, globals());
    await flushPromises();

    expect(status?.textContent).toBe("Unable to load branches.");
    expect(browser.logger.errors.length).toBeGreaterThan(0);
  });

  it("ignores a stale branch-list failure after the selected branch changes", async () => {
    const { browser, branch, status } = fixture({ loaded: false });
    const listing = createDeferred<HttpResponse>();
    browser.net.handle("/api/discover-branches", () => listing.promise);
    browser.net.handle(
      "/api/load-graph",
      () => new Promise<HttpResponse>(() => {})
    );
    initializeGraphPage(browser.context, globals());
    await flushPromises();

    branch.value = "other";
    branch.dispatch("change");
    await flushPromises();
    listing.reject(new Error("stale branch failure"));
    await flushPromises();

    expect(status?.textContent).not.toBe("Unable to load branches.");
    expect(
      browser.logger.errors.some(
        (entry) => entry.message === "Radius could not load graph branches."
      )
    ).toBe(false);
  });

  it("ignores a stale progress response superseded by a branch change", async () => {
    const { browser, branch, status } = fixture({ loaded: false });
    const load = createDeferred<HttpResponse>();
    const stale = createDeferred<HttpResponse>();
    let polls = 0;
    browser.net.handle("/api/load-graph", () => load.promise);
    // Only the first poll is the stale one. Later polls belong to the request
    // the branch change started and never settle, so the assertion can only be
    // satisfied by the guard rejecting the superseded response.
    browser.net.handle("/api/progress?view=graph", () => {
      polls++;
      return polls === 1 ? stale.promise : new Promise<HttpResponse>(() => {});
    });
    initializeGraphPage(browser.context, globals());
    await flushPromises();

    branch.dispatch("change");
    await flushPromises();
    stale.resolve(jsonResponse({ messages: ["late message"] }));
    await flushPromises();

    expect(status?.textContent).not.toBe("late message");
  });

  it("logs a failing progress request without breaking the page", async () => {
    const { browser } = fixture({ loaded: false });
    const load = createDeferred<HttpResponse>();
    browser.net.handle("/api/load-graph", () => load.promise);
    browser.net.handle("/api/progress?view=graph", () =>
      Promise.reject(new Error("progress unavailable"))
    );
    initializeGraphPage(browser.context, globals());
    await flushPromises();

    browser.clock.tick(GRAPH_PROGRESS_MS);
    await flushPromises();

    expect(
      browser.logger.errors.some(
        (entry) => entry.message === "Radius graph progress request failed."
      )
    ).toBe(true);
  });

  it("falls back to 'main' when the persisted branch is empty", async () => {
    const { browser } = fixture({ loaded: false, stateBranch: "" });
    let body = "";
    browser.net.handle("/api/load-graph", (init) => {
      body = String(init?.body ?? "");
      return jsonResponse({});
    });
    initializeGraphPage(browser.context, globals());
    await flushPromises();

    expect(body).toContain('"branch":"feature"');
  });

  it("ignores an empty progress message list", async () => {
    const { browser, status } = fixture({ loaded: false });
    const load = createDeferred<HttpResponse>();
    browser.net.handle("/api/load-graph", () => load.promise);
    browser.net.handle("/api/progress?view=graph", () =>
      jsonResponse({ messages: [] })
    );
    initializeGraphPage(browser.context, globals());
    await flushPromises();
    if (status) status.textContent = "unchanged";

    browser.clock.tick(GRAPH_PROGRESS_MS);
    await flushPromises();

    expect(status?.textContent).toBe("unchanged");
  });

  it("falls back to the page branch when the selector is cleared before a retry fires", async () => {
    const { browser, branch } = fixture({ loaded: false });
    let calls = 0;
    const bodies: string[] = [];
    browser.net.handle("/api/load-graph", (init) => {
      calls++;
      bodies.push(String(init?.body ?? ""));
      return jsonResponse({ needsAppBicep: true });
    });
    initializeGraphPage(browser.context, globals());
    await flushPromises();
    expect(calls).toBe(1);

    // Cleared programmatically (no "change" event), unlike a user edit.
    branch.value = "";
    browser.clock.tick(GRAPH_RETRY_MAX_MS);
    await flushPromises();

    expect(calls).toBe(2);
    expect(bodies[1]).toContain('"branch":"feature"');
  });

  it("resets the graph container wrapper only when it exists", async () => {
    const { browser, container } = fixture({
      loaded: false,
      withWrapper: false
    });
    browser.net.handle("/api/load-graph", () => jsonResponse({}));
    expect(() => {
      initializeGraphPage(browser.context, globals());
    }).not.toThrow();
    await flushPromises();

    expect(container.innerHTML).toBe("");
  });

  it("ignores a stale load failure superseded by a branch change", async () => {
    const { browser, branch } = fixture({ loaded: false });
    const first = createDeferred<HttpResponse>();
    let calls = 0;
    browser.net.handle("/api/load-graph", () => {
      calls++;
      return calls === 1 ?
          first.promise
        : jsonResponse({ resources: [{ id: "app/current" }] });
    });
    initializeGraphPage(browser.context, globals());
    await flushPromises();

    branch.dispatch("change");
    await flushPromises();
    expect(calls).toBe(2);

    first.reject(new Error("stale failure"));
    await flushPromises();

    expect(browser.nav.reloads).toBe(0);
    expect(browser.logger.errors).toHaveLength(0);
  });

  it("ignores a stale regenerate failure superseded by another branch change", async () => {
    const { browser, branch } = fixture({ loaded: true });
    const stale = createDeferred<HttpResponse>();
    let calls = 0;
    browser.net.handle("/api/load-graph", () => {
      calls++;
      if (calls === 1) return jsonResponse({});
      if (calls === 2) return stale.promise;
      return jsonResponse({ resources: [{ id: "app/current" }] });
    });
    initializeGraphPage(browser.context, globals());
    await flushPromises();

    branch.value = "one";
    branch.dispatch("change");
    branch.value = "two";
    branch.dispatch("change");
    await flushPromises();

    stale.reject(new Error("stale regenerate failure"));
    await flushPromises();

    expect(browser.nav.reloads).toBe(0);
    expect(browser.logger.errors).toHaveLength(0);
  });

  it("does not bind a change listener when no branch selector exists", async () => {
    const { browser } = fixture({ loaded: false, withBranchSelect: false });
    browser.net.handle("/api/load-graph", () => jsonResponse({}));

    expect(() => {
      initializeGraphPage(browser.context, globals());
    }).not.toThrow();
    await flushPromises();
  });

  it("ignores a branch change that clears the selection", async () => {
    const { browser, branch, button } = fixture({ loaded: false });
    browser.net.handle("/api/load-graph", () => jsonResponse({}));
    browser.net.handle("/api/list-environments?repo=octo%2Fapp", () =>
      jsonResponse({ environments: [{ name: "dev", provider: "azure" }] })
    );
    initializeGraphPage(browser.context, globals());
    await flushPromises();
    const callsBefore = browser.net.calls.filter(
      (call) => call.url === "/api/load-graph"
    ).length;

    branch.value = "";
    branch.dispatch("change");
    await flushPromises();

    expect(button.disabled).toBe(true);
    expect(
      browser.net.calls.filter((call) => call.url === "/api/load-graph").length
    ).toBe(callsBefore);
  });

  it("does not bind a click listener when no deploy button exists", async () => {
    const { browser } = fixture({ loaded: false, withButton: false });
    browser.net.handle("/api/load-graph", () => jsonResponse({}));

    expect(() => {
      initializeGraphPage(browser.context, globals());
    }).not.toThrow();
    await flushPromises();
  });

  it("ignores a stale refresh failure superseded by a branch change", async () => {
    const { browser, branch } = fixture({ loaded: true });
    const refresh = createDeferred<HttpResponse>();
    let calls = 0;
    browser.net.handle("/api/load-graph", () => {
      calls++;
      return calls === 1 ?
          refresh.promise
        : jsonResponse({ resources: [{ id: "app/current" }] });
    });
    initializeGraphPage(browser.context, globals());
    branch.dispatch("change");
    await flushPromises();

    refresh.reject(new Error("stale refresh failure"));
    await flushPromises();

    expect(browser.logger.errors).toHaveLength(0);
    expect(browser.nav.reloads).toBe(0);
  });

  it("ignores a stale progress failure superseded by a branch change", async () => {
    const { browser, branch } = fixture({ loaded: false });
    const load = createDeferred<HttpResponse>();
    const stale = createDeferred<HttpResponse>();
    let polls = 0;
    browser.net.handle("/api/load-graph", () => load.promise);
    // Only the first poll fails, and it belongs to the superseded request; the
    // polls the branch change starts never settle.
    browser.net.handle("/api/progress?view=graph", () => {
      polls++;
      return polls === 1 ? stale.promise : new Promise<HttpResponse>(() => {});
    });
    initializeGraphPage(browser.context, globals());
    await flushPromises();

    branch.dispatch("change");
    await flushPromises();
    stale.reject(new Error("stale progress failure"));
    await flushPromises();

    expect(browser.logger.errors).toHaveLength(0);
  });

  describe("graph build progress", () => {
    const stageText = graphProgressStages;

    it("renders typed build stages instead of prose", async () => {
      const { browser, progressHost } = fixture({ loaded: false });
      const load = createDeferred<HttpResponse>();
      browser.net.handle("/api/load-graph", () => load.promise);
      browser.net.handle("/api/progress?view=graph", () =>
        jsonResponse({
          generation: 1,
          events: [
            {
              sequence: 1,
              stage: "checking_model",
              state: "succeeded",
              detail: "Found .radius/app.bicep."
            },
            {
              sequence: 2,
              stage: "building_graph",
              state: "running",
              detail: "Compiling the application model."
            }
          ]
        })
      );
      initializeGraphPage(browser.context, globals());
      await flushPromises();

      browser.clock.tick(GRAPH_PROGRESS_MS);
      await flushPromises();

      expect(stageText(progressHost)).toEqual([
        `${GRAPH_STAGE_LABELS.checking_model}:succeeded`,
        `${GRAPH_STAGE_LABELS.building_graph}:running`
      ]);
      expect(graphProgressElapsed(progressHost)).toMatch(/^\d+:\d{2}$/);
      expect(fakeText(progressHost)).not.toMatch(/%/);
    });

    it("shows a starting stage before the first poll returns", async () => {
      const { browser, progressHost } = fixture({ loaded: false });
      browser.net.handle(
        "/api/load-graph",
        () => createDeferred<HttpResponse>().promise
      );
      initializeGraphPage(browser.context, globals());
      await flushPromises();

      expect(stageText(progressHost)).toEqual([
        `${GRAPH_STAGE_LABELS.checking_model}:running`
      ]);
    });

    it("clears the panel once the request settles", async () => {
      const { browser, progressHost } = fixture({ loaded: false });
      browser.net.handle("/api/load-graph", () => jsonResponse({}));
      browser.net.handle("/api/progress?view=graph", () =>
        jsonResponse({ events: [] })
      );
      initializeGraphPage(browser.context, globals());
      await flushPromises();

      const before = fakeText(progressHost);
      browser.clock.tick(GRAPH_PROGRESS_MS * 4);
      await flushPromises();

      // The request already resolved, so the frozen panel never advances.
      expect(fakeText(progressHost)).toBe(before);
    });

    it("reports branch regeneration through the same panel", async () => {
      const { browser, branch, progressHost } = fixture({ loaded: true });
      browser.net.handle(
        "/api/load-graph",
        () => createDeferred<HttpResponse>().promise
      );
      browser.net.handle("/api/progress?view=graph", () =>
        jsonResponse({
          generation: 1,
          events: [
            {
              sequence: 1,
              stage: "building_graph",
              state: "running",
              detail: "Compiling for release."
            }
          ]
        })
      );
      initializeGraphPage(browser.context, globals());
      await flushPromises();

      branch.value = "release";
      branch.dispatch("change");
      await flushPromises();
      browser.clock.tick(GRAPH_PROGRESS_MS);
      await flushPromises();

      expect(stageText(progressHost)).toEqual([
        `${GRAPH_STAGE_LABELS.building_graph}:running`
      ]);
    });

    it("keeps one panel and one clock running across an app.bicep retry", async () => {
      const { browser, progressHost } = fixture({ loaded: false });
      browser.net.handle("/api/load-graph", () =>
        jsonResponse({ needsAppBicep: true })
      );
      browser.net.handle("/api/progress?view=graph", () =>
        jsonResponse({
          generation: 1,
          events: [
            {
              sequence: 1,
              stage: "checking_model",
              state: "succeeded",
              detail: "No application model exists yet."
            },
            {
              sequence: 2,
              stage: "creating_model",
              state: "running",
              detail: "Copilot is creating the application model."
            }
          ]
        })
      );
      initializeGraphPage(browser.context, globals());
      await flushPromises();

      expect(stageText(progressHost)).toEqual([
        `${GRAPH_STAGE_LABELS.checking_model}:succeeded`,
        `${GRAPH_STAGE_LABELS.creating_model}:running`
      ]);

      browser.clock.tick(GRAPH_RETRY_MAX_MS);
      await flushPromises();

      // The retry reuses the running panel, so the clock reflects the whole
      // wait rather than restarting at zero on every poll.
      expect(graphProgressElapsed(progressHost)).toBe(
        formatElapsed(GRAPH_RETRY_MAX_MS)
      );
      expect(stageText(progressHost)).toEqual([
        `${GRAPH_STAGE_LABELS.checking_model}:succeeded`,
        `${GRAPH_STAGE_LABELS.creating_model}:running`
      ]);
    });

    it("stops retrying once the server ends the app.bicep wait", async () => {
      const setError = vi.fn();
      const { browser, progressHost, status } = fixture({ loaded: false });
      let calls = 0;
      browser.net.handle("/api/load-graph", () => {
        calls++;
        // The server owns the wait: once it expires it drops `needsAppBicep`
        // and answers with the reason, which is what ends the page's polling.
        return calls < 3 ?
            jsonResponse({ needsAppBicep: true })
          : jsonResponse({
              error: GRAPH_APP_BICEP_TIMEOUT_MESSAGE,
              appBicepWaitExpired: true
            });
      });
      initializeGraphPage(
        browser.context,
        globals({ radiusSetGraphError: setError })
      );
      await flushPromises();

      for (let attempt = 0; attempt < 2; attempt++) {
        browser.clock.tick(GRAPH_RETRY_MAX_MS);
        await flushPromises();
      }
      const settled = calls;
      browser.clock.tick(GRAPH_RETRY_MAX_MS * 5);
      await flushPromises();

      expect(settled).toBe(3);
      expect(calls).toBe(settled);
      expect(setError).toHaveBeenCalledWith(
        "graph-container",
        GRAPH_APP_BICEP_TIMEOUT_MESSAGE
      );
      expect(status?.textContent).toBe("");
      // The failure belongs on the graph surface alone; a frozen panel left
      // underneath would state it a second time.
      expect(graphProgressStages(progressHost)).toEqual([]);
    });

    // The page must not impose a budget of its own: a modeling run that is
    // demonstrably working keeps `needsAppBicep` coming, and the page keeps
    // asking for as long as the server says to.
    it("keeps polling for as long as the server answers needsAppBicep", async () => {
      const setError = vi.fn();
      const { browser } = fixture({ loaded: false });
      let calls = 0;
      browser.net.handle("/api/load-graph", () => {
        calls++;
        return jsonResponse({ needsAppBicep: true });
      });
      initializeGraphPage(
        browser.context,
        globals({ radiusSetGraphError: setError })
      );
      await flushPromises();

      for (let attempt = 0; attempt < 200; attempt++) {
        browser.clock.tick(GRAPH_RETRY_MAX_MS);
        await flushPromises();
      }

      expect(calls).toBe(201);
      expect(setError).not.toHaveBeenCalled();
    });

    it("stops immediately when the server says the skill cannot model the repo", async () => {
      const setError = vi.fn();
      const { browser, status } = fixture({ loaded: false });
      let calls = 0;
      browser.net.handle("/api/load-graph", () => {
        calls++;
        return jsonResponse({
          error: "octo/app has no Dockerfile on main.",
          appBicepUnsupported: true
        });
      });
      initializeGraphPage(
        browser.context,
        globals({ radiusSetGraphError: setError })
      );
      await flushPromises();

      browser.clock.tick(GRAPH_RETRY_MAX_MS * 5);
      await flushPromises();

      expect(calls).toBe(1);
      expect(setError).toHaveBeenCalledWith(
        "graph-container",
        "octo/app has no Dockerfile on main."
      );
      expect(status?.textContent).toBe("");
    });

    it("hides stale modeled graph guidance after a terminal refusal", async () => {
      const { browser, guidance } = fixture({ loaded: true });
      const setError = vi.fn();
      browser.net.handle("/api/load-graph", () =>
        jsonResponse({
          error: "octo/app has no Dockerfile on main.",
          appBicepUnsupported: true
        })
      );

      initializeGraphPage(
        browser.context,
        globals({ radiusSetGraphError: setError })
      );
      await flushPromises();

      expect(setError).toHaveBeenCalledWith(
        "graph-container",
        "Unable to refresh the application graph: octo/app has no Dockerfile on main."
      );
      expect(guidance.style.display).toBe("none");
    });

    it("restores modeled graph guidance after a successful branch change", async () => {
      const { browser, branch, guidance } = fixture({ loaded: true });
      let requests = 0;
      browser.net.handle("/api/load-graph", () => {
        requests++;
        return jsonResponse(
          requests === 1 ?
            {
              error: "octo/app has no Dockerfile on main.",
              appBicepUnsupported: true
            }
          : { resources: [{ id: "app/web" }] }
        );
      });

      initializeGraphPage(browser.context, globals());
      await flushPromises();
      expect(guidance.style.display).toBe("none");

      branch.value = "release";
      branch.dispatch("change");
      await flushPromises();

      expect(guidance.style.display).toBe("");
    });

    it("renders a successful refresh when optional guidance is absent", async () => {
      const { browser } = fixture({ loaded: true, withGuidance: false });
      browser.net.handle("/api/load-graph", () =>
        jsonResponse({ resources: [{ id: "app/web" }] })
      );

      expect(() =>
        initializeGraphPage(browser.context, globals())
      ).not.toThrow();
      await flushPromises();
    });

    it.each([
      [
        "the skill refuses the repository",
        {
          error: "octo/app has no Dockerfile on main.",
          appBicepUnsupported: true
        }
      ],
      ["the build errors", { error: "invalid app.bicep" }]
    ])("clears the panel when %s", async (_name, body) => {
      const { browser, progressHost } = fixture({ loaded: false });
      const setError = vi.fn();
      browser.net.handle("/api/load-graph", () => jsonResponse(body));
      initializeGraphPage(
        browser.context,
        globals({ radiusSetGraphError: setError })
      );
      await flushPromises();

      // The failure is stated once, on the graph surface. A panel left behind
      // would either repeat it or claim the build is still running.
      expect(setError).toHaveBeenCalledTimes(1);
      expect(stageText(progressHost)).toEqual([]);
    });

    it("clears the panel when the request throws", async () => {
      const { browser, progressHost } = fixture({ loaded: false });
      const setError = vi.fn();
      browser.net.handle("/api/load-graph", () =>
        Promise.reject(new Error("offline"))
      );
      initializeGraphPage(
        browser.context,
        globals({ radiusSetGraphError: setError })
      );
      await flushPromises();

      expect(setError).toHaveBeenCalledTimes(1);
      expect(stageText(progressHost)).toEqual([]);
    });

    it("surfaces a regeneration failure on the graph surface", async () => {
      const { browser, branch, status } = fixture({ loaded: true });
      const setError = vi.fn();
      browser.net.handle("/api/load-graph", () =>
        jsonResponse({ error: "branch missing" })
      );
      initializeGraphPage(
        browser.context,
        globals({ radiusSetGraphError: setError })
      );
      await flushPromises();

      branch.value = "release";
      branch.dispatch("change");
      await flushPromises();

      expect(setError).toHaveBeenCalledWith(
        "graph-container",
        "branch missing"
      );
      expect(status?.textContent).toBe("");
    });
  });
  describe("graph build progress defaults", () => {
    const stageText = graphProgressStages;

    it("accepts typed events from a payload that omits the generation", async () => {
      const { browser, progressHost } = fixture({ loaded: false });
      browser.net.handle(
        "/api/load-graph",
        () => createDeferred<HttpResponse>().promise
      );
      browser.net.handle("/api/progress?view=graph", () =>
        jsonResponse({
          events: [
            {
              sequence: 3,
              stage: "building_graph",
              state: "running",
              detail: "Compiling the application model."
            }
          ]
        })
      );
      initializeGraphPage(browser.context, globals());
      await flushPromises();
      browser.clock.tick(GRAPH_PROGRESS_MS);
      await flushPromises();

      expect(stageText(progressHost)).toEqual([
        `${GRAPH_STAGE_LABELS.building_graph}:running`
      ]);
    });

    it("regenerates for a branch when the page has no graph wrapper", async () => {
      const { browser, branch, progressHost } = fixture({
        loaded: true,
        withWrapper: false
      });
      browser.net.handle(
        "/api/load-graph",
        () => createDeferred<HttpResponse>().promise
      );
      initializeGraphPage(browser.context, globals());
      await flushPromises();

      branch.value = "other";
      branch.dispatch("change");
      await flushPromises();

      expect(stageText(progressHost)).toEqual([
        `${GRAPH_STAGE_LABELS.checking_model}:running`
      ]);
    });
  });
});
