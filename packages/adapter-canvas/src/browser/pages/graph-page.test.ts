import { describe, expect, it, vi } from "vitest";
import {
  createDeferred,
  createFakeBrowser,
  createFakeElement,
  createFakeInput,
  createFakeSelect,
  flushPromises,
  jsonResponse
} from "../../../test/support/browser/fakes.js";
import { NOOP_TEARDOWN } from "../lifecycle.js";
import type { HttpResponse } from "../ports.js";
import {
  GRAPH_PAGE_STATE_ID,
  GRAPH_PROGRESS_MS,
  GRAPH_RETRY_MS,
  GRAPH_STALE_RETRY_MS,
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
  stateBranch?: string;
}

function fixture(options: FixtureOptions = {}) {
  const {
    loaded = false,
    repo = "octo/app",
    branchValue = "feature",
    withStatus = true,
    withWrapper = true,
    withBranchSelect = true,
    withButton = true,
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
  const elements = [state, app, container];
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
  return { browser, state, app, branch, button, container, wrapper, status };
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

  it("polls progress once per interval and ignores a late response", async () => {
    const { browser } = fixture({ loaded: false });
    browser.net.supportsAbort = false;
    const load = createDeferred<HttpResponse>();
    browser.net.handle("/api/load-graph", () => load.promise);
    browser.net.handle("/api/progress", () =>
      jsonResponse({ messages: ["Drafting .radius/app.bicep"] })
    );
    const teardown = initializeGraphPage(browser.context, globals());
    await flushPromises();

    browser.clock.tick(GRAPH_PROGRESS_MS);
    await flushPromises();
    expect(
      browser.net.calls.filter((call) => call.url === "/api/progress")
    ).toHaveLength(1);
    teardown();
    load.resolve(jsonResponse({ reload: true }));
    await flushPromises();
    expect(browser.nav.reloads).toBe(0);
    expect(browser.clock.pending).toBe(0);
  });

  it("keeps external error detail out of user-visible failures", async () => {
    const { browser, status } = fixture({ loaded: false });
    browser.net.handle("/api/load-graph", () =>
      Promise.reject(new Error("credential-like detail"))
    );
    initializeGraphPage(browser.context, globals());
    await flushPromises();

    expect(status?.textContent).toBe(
      "Failed to generate the application graph."
    );
    expect(status?.textContent).not.toContain("credential-like");
    expect(browser.logger.errors.length).toBeGreaterThan(0);
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

  it("reloads the page once the graph finishes generating", async () => {
    const { browser, status } = fixture({ loaded: false });
    browser.net.handle("/api/load-graph", () => jsonResponse({ reload: true }));
    initializeGraphPage(browser.context, globals());
    await flushPromises();

    expect(browser.nav.reloads).toBe(1);
    expect(status?.textContent).toBe("Application graph ready.");
  });

  it("schedules a slow retry while Copilot drafts app.bicep and cancels it on a branch change", async () => {
    const { browser, branch, status } = fixture({ loaded: false });
    let calls = 0;
    browser.net.handle("/api/load-graph", () => {
      calls++;
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

    browser.clock.tick(GRAPH_RETRY_MS);
    await flushPromises();
    expect(calls).toBe(3);
  });

  it("retries quickly after a stale response", async () => {
    const { browser, status } = fixture({ loaded: false });
    let calls = 0;
    browser.net.handle("/api/load-graph", () => {
      calls++;
      return calls === 1 ?
          jsonResponse({ stale: true })
        : jsonResponse({ reload: true });
    });
    initializeGraphPage(browser.context, globals());
    await flushPromises();

    expect(status?.textContent).toContain("newer graph request");
    expect(browser.clock.timeouts).toBe(1);

    browser.clock.tick(GRAPH_STALE_RETRY_MS);
    await flushPromises();
    expect(calls).toBe(2);
    expect(browser.nav.reloads).toBe(1);
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
    expect(status?.textContent).toBe("Error: app.bicep is invalid");
  });

  it("regenerates the graph for a newly selected branch and reloads", async () => {
    const { browser, branch, status } = fixture({ loaded: true });
    browser.net.handle("/api/load-graph", () => jsonResponse({ reload: true }));
    initializeGraphPage(browser.context, globals());
    await flushPromises();

    branch.value = "another";
    branch.dispatch("change");
    expect(status?.textContent).toBe("Regenerating graph for another…");
    await flushPromises();

    expect(browser.nav.reloads).toBe(1);
  });

  it("surfaces a regenerate error message returned by the server", async () => {
    const { browser, branch, status } = fixture({ loaded: true });
    browser.net.handle("/api/load-graph", () =>
      jsonResponse({ error: "cannot regenerate" })
    );
    initializeGraphPage(browser.context, globals());
    await flushPromises();

    branch.value = "another";
    branch.dispatch("change");
    await flushPromises();

    expect(status?.textContent).toBe("Error: cannot regenerate");
  });

  it("keeps regenerate error detail out of user-visible failures", async () => {
    const { browser, branch, status } = fixture({ loaded: true });
    browser.net.handle("/api/load-graph", () =>
      Promise.reject(new Error("secret-shaped detail"))
    );
    initializeGraphPage(browser.context, globals());
    await flushPromises();

    branch.value = "another";
    branch.dispatch("change");
    await flushPromises();

    expect(status?.textContent).toBe("Failed to regenerate graph.");
    expect(status?.textContent).not.toContain("secret-shaped");
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
      return jsonResponse({ reload: true });
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
    // Only the second (current) regenerate request's reload should count.
    expect(browser.nav.reloads).toBe(1);
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

  it("surfaces a needsAppBicep refresh message", async () => {
    const { browser, status } = fixture({ loaded: true });
    browser.net.handle("/api/load-graph", () =>
      jsonResponse({ needsAppBicep: true })
    );
    initializeGraphPage(browser.context, globals());
    await flushPromises();

    expect(status?.textContent).toContain("rebuilding the application graph");
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

  it("ignores a stale progress response superseded by a branch change", async () => {
    const { browser, branch, status } = fixture({ loaded: false });
    const load = createDeferred<HttpResponse>();
    const progress = createDeferred<HttpResponse>();
    browser.net.handle("/api/load-graph", () => load.promise);
    browser.net.handle("/api/progress", () => progress.promise);
    initializeGraphPage(browser.context, globals());
    await flushPromises();

    browser.clock.tick(GRAPH_PROGRESS_MS);
    branch.dispatch("change");
    progress.resolve(jsonResponse({ messages: ["late message"] }));
    await flushPromises();

    expect(status?.textContent).not.toBe("late message");
  });

  it("logs a failing progress request without breaking the page", async () => {
    const { browser } = fixture({ loaded: false });
    const load = createDeferred<HttpResponse>();
    browser.net.handle("/api/load-graph", () => load.promise);
    browser.net.handle("/api/progress", () =>
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
    browser.net.handle("/api/progress", () => jsonResponse({ messages: [] }));
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
    browser.clock.tick(GRAPH_RETRY_MS);
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
      return calls === 1 ? first.promise : jsonResponse({ reload: true });
    });
    initializeGraphPage(browser.context, globals());
    await flushPromises();

    branch.dispatch("change");
    await flushPromises();
    expect(calls).toBe(2);

    first.reject(new Error("stale failure"));
    await flushPromises();

    expect(browser.nav.reloads).toBe(1);
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
      return jsonResponse({ reload: true });
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

    expect(browser.nav.reloads).toBe(1);
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
      return calls === 1 ? refresh.promise : jsonResponse({ reload: true });
    });
    initializeGraphPage(browser.context, globals());
    branch.dispatch("change");
    await flushPromises();

    refresh.reject(new Error("stale refresh failure"));
    await flushPromises();

    expect(browser.logger.errors).toHaveLength(0);
    expect(browser.nav.reloads).toBe(1);
  });

  it("ignores a stale progress failure superseded by a branch change", async () => {
    const { browser, branch } = fixture({ loaded: false });
    const load = createDeferred<HttpResponse>();
    const progress = createDeferred<HttpResponse>();
    browser.net.handle("/api/load-graph", () => load.promise);
    browser.net.handle("/api/progress", () => progress.promise);
    initializeGraphPage(browser.context, globals());
    await flushPromises();

    browser.clock.tick(GRAPH_PROGRESS_MS);
    branch.dispatch("change");
    progress.reject(new Error("stale progress failure"));
    await flushPromises();

    expect(browser.logger.errors).toHaveLength(0);
  });
});
