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
  initializePlannedGraphPage,
  PLANNED_GRAPH_STATE_ID,
  PLAN_DEBOUNCE_MS,
  PLAN_PROGRESS_MS,
  PLAN_RETRY_MS
} from "./planned-graph-page.js";
import { DEPLOYMENTS_PATH } from "../repositories.js";

type EnvListing = "ok" | "empty" | "error";

interface FixtureOptions {
  resources?: unknown[];
  repo?: string;
  branchField?: string;
  providerField?: string;
  environment?: string;
  withStatus?: boolean;
  withWrapper?: boolean;
  withApp?: boolean;
  withBranch?: boolean;
  withEnvironment?: boolean;
  withButton?: boolean;
  withContainer?: boolean;
  envListing?: EnvListing;
  deploymentsPayload?: unknown;
}

function fixture(options: FixtureOptions = {}) {
  const {
    resources = [],
    repo = "octo/app",
    branchField = "feature",
    providerField = "azure",
    environment = "dev",
    withStatus = true,
    withWrapper = true,
    withApp = true,
    withBranch = true,
    withEnvironment = true,
    withButton = true,
    withContainer = true,
    envListing = "ok",
    deploymentsPayload = { deployments: [] }
  } = options;
  const browser = createFakeBrowser();
  const state = createFakeElement(PLANNED_GRAPH_STATE_ID);
  state.textContent = JSON.stringify({
    repo,
    branch: branchField,
    environment,
    provider: providerField,
    resources,
    localSource: true
  });
  const app = createFakeSelect("planned-app");
  const branch = createFakeSelect("planned-branch");
  branch.value = branchField;
  const environmentSelect = createFakeSelect("planned-env");
  environmentSelect.value = environment;
  const button = createFakeInput("plan-btn");
  const hint = createFakeElement("planned-subtitle-hint");
  const status = createFakeElement("plan-status");
  const container = createFakeElement("graph-container");
  const wrapper = createFakeElement("graph-container-wrapper");
  const progressHost = createFakeElement("progress-steps");
  const elements = [state, hint, progressHost];
  if (withContainer) elements.push(container);
  if (withApp) elements.push(app);
  if (withBranch) elements.push(branch);
  if (withEnvironment) elements.push(environmentSelect);
  if (withButton) elements.push(button);
  if (withStatus) elements.push(status);
  if (withWrapper) elements.push(wrapper);
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
  const envPayload: Record<string, unknown> =
    envListing === "error" ? { environments: [], error: "boom" }
    : envListing === "empty" ? { environments: [] }
    : {
        environments: [
          { name: "dev", provider: "azure", status: "success" },
          { name: "half-built", provider: "azure", status: "pending" }
        ]
      };
  browser.net.handle(
    `/api/list-environments?repo=${encodeURIComponent(repo)}`,
    () => jsonResponse(envPayload)
  );
  browser.net.handle(
    `${DEPLOYMENTS_PATH}?repo=${encodeURIComponent(repo)}&fresh=1`,
    () => jsonResponse(deploymentsPayload)
  );
  browser.net.handle("/api/deploy", () => jsonResponse({}));
  // The page polls progress as soon as it starts a plan, so every scenario
  // reaches this route whether or not it is what the scenario is about. A test
  // that cares overrides it.
  browser.net.handle("/api/progress?view=planned", () => jsonResponse({}));

  return {
    browser,
    app,
    branch,
    environment: environmentSelect,
    button,
    hint,
    status,
    container,
    wrapper,
    progressHost
  };
}

function globals(overrides: Record<string, unknown> = {}) {
  return {
    radiusRenderGraph: vi.fn(),
    radiusSetGraphLoading: vi.fn(),
    ...overrides
  };
}

describe("initializePlannedGraphPage", () => {
  it("does nothing when the page state element is absent", () => {
    const browser = createFakeBrowser();
    const teardown = initializePlannedGraphPage(browser.context, globals());
    expect(teardown).toBe(NOOP_TEARDOWN);
  });

  it("renders model compilation failures only on the graph and disables deployment", async () => {
    const { browser, button, status, branch } = fixture();
    const setError = vi.fn();
    browser.net.handle("/api/plan-graph", () =>
      jsonResponse({
        error: "Your application model couldn't be compiled.",
        modelingFailed: true
      })
    );

    initializePlannedGraphPage(browser.context, {
      radiusRenderGraph: vi.fn(),
      radiusSetGraphLoading: vi.fn(),
      radiusSetGraphError: setError
    });
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();

    expect(setError).toHaveBeenCalledWith(
      "graph-container",
      "Your application model couldn't be compiled."
    );
    expect(status.style.display).toBe("none");
    expect(button.disabled).toBe(true);
    expect(branch.listenerCount("change")).toBe(1);
  });

  it("renders persisted resources and binds idempotently", async () => {
    const { browser, app, branch, environment } = fixture({
      resources: [{ id: "app/web" }]
    });
    const render = vi.fn();
    const teardown = initializePlannedGraphPage(browser.context, {
      radiusRenderGraph: render,
      radiusSetGraphLoading: vi.fn()
    });
    initializePlannedGraphPage(browser.context, {
      radiusRenderGraph: render,
      radiusSetGraphLoading: vi.fn()
    });
    await flushPromises();

    expect(render).toHaveBeenCalledWith(
      "graph-container",
      [{ id: "app/web" }],
      expect.objectContaining({
        branch: "feature",
        localSource: true,
        plannedMode: true
      })
    );
    expect(app.listenerCount("change")).toBe(1);
    expect(branch.listenerCount("change")).toBe(1);
    expect(environment.listenerCount("change")).toBe(1);

    teardown();
    expect(app.listenerCount()).toBe(0);
    expect(branch.listenerCount()).toBe(0);
    expect(environment.listenerCount()).toBe(0);
  });

  it("reconciles freshness for cached planned resources by invoking the plan workflow", async () => {
    const { browser, status } = fixture({
      resources: [{ id: "app/web" }]
    });
    let planCalls = 0;
    let requestBody = "";
    browser.net.handle("/api/plan-graph", (init) => {
      planCalls++;
      requestBody = String(init?.body ?? "");
      return jsonResponse({ refreshed: true });
    });
    const render = vi.fn();
    initializePlannedGraphPage(browser.context, {
      radiusRenderGraph: render,
      radiusSetGraphLoading: vi.fn()
    });
    await flushPromises();
    // After selectors load, queue(true) fires immediately (no debounce).
    browser.clock.tick(0);
    await flushPromises();

    expect(planCalls).toBe(1);
    expect(requestBody).toContain('"refresh":true');
    expect(requestBody).toContain('"restartWait":true');
    expect(render).toHaveBeenCalledOnce();
    expect(status.textContent).toBe("The planned deployment is current.");
  });

  it("keeps the cached planned graph on screen while a refresh reconciles freshness", async () => {
    const { browser, status } = fixture({
      resources: [{ id: "app/web" }]
    });
    browser.net.handle("/api/plan-graph", () =>
      jsonResponse({ refreshed: true })
    );
    const destroy = vi.fn();
    const render = vi.fn(() => ({ update: vi.fn(), destroy }));
    const setLoading = vi.fn();
    initializePlannedGraphPage(browser.context, {
      radiusRenderGraph: render,
      radiusSetGraphLoading: setLoading
    });
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();

    // The refresh exists to confirm the graph that is already rendered, and the
    // `refreshed` reply returns without re-rendering. Swapping in the loading
    // state here would leave the page permanently blank.
    expect(setLoading).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledOnce();
    expect(status.textContent).toBe("The planned deployment is current.");
  });

  it("shows the loading state when the user re-plans an already rendered graph", async () => {
    const { browser, branch } = fixture({
      resources: [{ id: "app/web" }]
    });
    browser.net.handle("/api/plan-graph", () =>
      jsonResponse({ refreshed: true })
    );
    const destroy = vi.fn();
    const render = vi.fn(() => ({ update: vi.fn(), destroy }));
    const setLoading = vi.fn();
    initializePlannedGraphPage(browser.context, {
      radiusRenderGraph: render,
      radiusSetGraphLoading: setLoading
    });
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();
    expect(setLoading).not.toHaveBeenCalled();

    branch.value = "other";
    branch.dispatch("change");
    browser.clock.tick(PLAN_DEBOUNCE_MS);
    await flushPromises();

    // A user-driven plan replaces the graph, so the stale one must come down.
    expect(setLoading).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("reloads when cached planned resources are stale and the workflow says so", async () => {
    const { browser } = fixture({
      resources: [{ id: "app/web" }]
    });
    browser.net.handle("/api/plan-graph", () => jsonResponse({ reload: true }));
    initializePlannedGraphPage(browser.context, {
      radiusRenderGraph: vi.fn(),
      radiusSetGraphLoading: vi.fn()
    });
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();

    expect(browser.nav.reloads).toBe(1);
  });

  it("uses refresh mode only for the initial cached reconciliation", async () => {
    const { browser, branch } = fixture({
      resources: [{ id: "app/web" }]
    });
    const bodies: string[] = [];
    browser.net.handle("/api/plan-graph", (init) => {
      bodies.push(String(init?.body ?? ""));
      return jsonResponse(
        bodies.length === 1 ? { refreshed: true } : { reload: true }
      );
    });
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();

    branch.value = "another";
    branch.dispatch("change");
    browser.clock.tick(PLAN_DEBOUNCE_MS);
    await flushPromises();

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain('"refresh":true');
    expect(bodies[0]).toContain('"restartWait":true');
    expect(bodies[1]).toContain('"refresh":false');
    expect(bodies[1]).toContain('"restartWait":true');
  });

  it("omits an empty environment while reconciling cached resources", async () => {
    const { browser } = fixture({
      resources: [{ id: "app/web" }],
      environment: "",
      envListing: "error"
    });
    let requestBody = "";
    browser.net.handle("/api/plan-graph", (init) => {
      requestBody = String(init?.body ?? "");
      return jsonResponse({ refreshed: true });
    });

    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();

    expect(requestBody).toContain('"refresh":true');
    expect(requestBody).not.toContain('"environment"');
  });

  it("coalesces changes and ignores an outdated plan response", async () => {
    const { browser, branch, status } = fixture();
    browser.net.handle("/api/plan-graph", () =>
      jsonResponse({ message: "incomplete" })
    );
    const teardown = initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();

    branch.value = "one";
    branch.dispatch("change");
    branch.value = "two";
    branch.dispatch("change");
    expect(browser.clock.timeouts).toBe(1);
    browser.clock.tick(PLAN_DEBOUNCE_MS);
    await flushPromises();

    const planCalls = browser.net.calls.filter(
      (call) => call.url === "/api/plan-graph"
    );
    expect(planCalls.at(-1)?.init?.body).toContain('"branch":"two"');
    expect(status.className).toBe("status error");
    teardown();
    expect(browser.clock.pending).toBe(0);
  });

  it("routes create-environment mode without dispatching a deploy", async () => {
    const { browser, button } = fixture();
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    button.dataset.mode = "create-env";
    button.dispatch("click");

    expect(browser.nav.assigned).toEqual(["/?page=environment&new=1"]);
    expect(
      browser.net.calls.filter((call) => call.url === "/api/deploy")
    ).toHaveLength(0);
  });

  it("delegates a plan button click to the shared deploy flow", async () => {
    const { browser, button } = fixture();
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();
    button.disabled = false;
    button.dispatch("click");
    await flushPromises();

    expect(browser.net.calls.some((call) => call.url === "/api/deploy")).toBe(
      true
    );
  });

  it("disables deployment when the selected application and environment already have a pending deployment", async () => {
    const { browser, button } = fixture({
      deploymentsPayload: {
        deployments: [
          { app: "app", environment: "dev", status: "pending", runUrl: "" },
          { app: "other", environment: "dev", status: "success", runUrl: "" }
        ]
      }
    });

    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();

    expect(button.dataset.mode).toBe("deploy");
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toContain("already in progress");
  });

  it("hides status silently when no status element exists", async () => {
    const { browser } = fixture({ withStatus: false, repo: "" });
    expect(() => {
      initializePlannedGraphPage(browser.context, globals());
    }).not.toThrow();
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();
  });

  it("falls back to main/azure defaults when branch and provider are empty", async () => {
    const { browser } = fixture({ branchField: "", providerField: "" });
    browser.net.handle("/api/discover-branches", () =>
      jsonResponse({ branches: [], workspaceBranch: "" })
    );
    let body = "";
    browser.net.handle("/api/plan-graph", (init) => {
      body = String(init?.body ?? "");
      return jsonResponse({});
    });
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();

    expect(body).toContain('"branch":"main"');
    expect(body).toContain('"provider":"azure"');
  });

  it("does not bind selector listeners or reset the container when elements are absent", async () => {
    const { browser } = fixture({
      withApp: false,
      withBranch: false,
      withEnvironment: false,
      withWrapper: false
    });
    expect(() => {
      initializePlannedGraphPage(browser.context, globals());
    }).not.toThrow();
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();
  });

  it("runs a plan without a container wrapper element present", async () => {
    const { browser, container } = fixture({ withWrapper: false });
    let body = "";
    browser.net.handle("/api/plan-graph", (init) => {
      body = String(init?.body ?? "");
      return jsonResponse({});
    });
    expect(() => {
      initializePlannedGraphPage(browser.context, globals());
    }).not.toThrow();
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();

    expect(body).toContain('"repo":"octo/app"');
    expect(container.innerHTML).toBe("");
  });

  it("shows a stale-environments message and retains the graph when a change is queued with resources present", async () => {
    const { browser, branch, status } = fixture({
      resources: [{ id: "app/web" }],
      envListing: "error"
    });
    browser.net.handle("/api/plan-graph", () =>
      jsonResponse({ refreshed: true })
    );
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();

    branch.value = "another";
    branch.dispatch("change");
    browser.clock.tick(PLAN_DEBOUNCE_MS);
    await flushPromises();

    expect(status.textContent).toBe(
      "Environments could not be loaded. The last planned graph is retained."
    );
  });

  it("shows a stale-environments message with no prior graph", async () => {
    const { browser, status } = fixture({ envListing: "error" });
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();

    expect(status.textContent).toBe(
      "Environments could not be loaded. Try again before planning a deployment."
    );
  });

  it("prompts for a branch when the repository or branch is missing", async () => {
    const { browser, status } = fixture({ repo: "" });
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();

    expect(status.textContent).toBe(
      "Select a branch to preview the planned deployment."
    );
  });

  it("sets a create-environment message on the container via the initial follow-up", async () => {
    const { browser, container, status } = fixture({
      envListing: "empty",
      resources: [{ id: "app/web" }]
    });
    container.innerHTML = "<div>stale</div>";
    browser.net.handle("/api/plan-graph", () =>
      jsonResponse({ refreshed: true })
    );
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();

    expect(container.innerHTML).toBe("<div>stale</div>");
    expect(status.textContent).toContain(
      "Create an environment to preview the planned deployment for this application."
    );
  });

  it("prompts to create an environment and clears the container when a change is queued with no environment", async () => {
    const { browser, branch, status, container } = fixture({
      envListing: "empty",
      resources: [{ id: "app/web" }]
    });
    browser.net.handle("/api/plan-graph", () =>
      jsonResponse({ refreshed: true })
    );
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    container.innerHTML = "<div>stale</div>";

    branch.value = "another";
    branch.dispatch("change");
    browser.clock.tick(PLAN_DEBOUNCE_MS);
    await flushPromises();

    expect(status.textContent).toBe(
      "Create an environment to preview the planned deployment for this application."
    );
    expect(container.innerHTML).toBe("");
  });

  it("plans a deployment for a selection made while the deployment listing is still in flight", async () => {
    const { browser, branch, status, container } = fixture({
      resources: [{ id: "app/web" }]
    });
    const deployments = createDeferred<HttpResponse>();
    browser.net.handle(
      `${DEPLOYMENTS_PATH}?repo=octo%2Fapp&fresh=1`,
      () => deployments.promise
    );
    browser.net.handle("/api/plan-graph", () => jsonResponse({ reload: true }));
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();

    branch.value = "another";
    branch.dispatch("change");
    browser.clock.tick(PLAN_DEBOUNCE_MS);
    await flushPromises();

    const planCalls = browser.net.calls.filter(
      (call) => call.url === "/api/plan-graph"
    );
    expect(planCalls.at(-1)?.init?.body).toContain('"branch":"another"');
    expect(status.textContent).not.toBe(
      "Create an environment to preview the planned deployment for this application."
    );
    expect(container.innerHTML).not.toContain("Create an environment");

    deployments.resolve(jsonResponse({ deployments: [] }));
    await flushPromises();
  });

  it("defers a selection made while environments are loading and plans it once selectors are ready", async () => {
    const { browser, branch, button, status, container } = fixture({
      resources: [{ id: "app/web" }]
    });
    const environments = createDeferred<HttpResponse>();
    browser.net.handle(
      "/api/list-environments?repo=octo%2Fapp",
      () => environments.promise
    );
    browser.net.handle("/api/plan-graph", () => jsonResponse({ reload: true }));
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();

    branch.value = "another";
    branch.dispatch("change");
    browser.clock.tick(PLAN_DEBOUNCE_MS);
    await flushPromises();

    expect(
      browser.net.calls.filter((call) => call.url === "/api/plan-graph")
    ).toHaveLength(0);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toContain(
      "selections are still loading"
    );
    expect(status.textContent).not.toContain("Create an environment");
    expect(container.innerHTML).not.toContain("Create an environment");

    environments.resolve(
      jsonResponse({
        environments: [{ name: "dev", provider: "azure", status: "success" }]
      })
    );
    await flushPromises();
    browser.clock.tick(PLAN_DEBOUNCE_MS);
    await flushPromises();

    const planCalls = browser.net.calls.filter(
      (call) => call.url === "/api/plan-graph"
    );
    expect(planCalls).toHaveLength(1);
    expect(planCalls[0]?.init?.body).toContain('"branch":"another"');
  });

  it("polls progress immediately and then per interval, ignoring a late message", async () => {
    const { browser, status } = fixture();
    const plan = createDeferred<HttpResponse>();
    browser.net.handle("/api/plan-graph", () => plan.promise);
    browser.net.handle("/api/progress?view=planned", () =>
      jsonResponse({ messages: ["Drafting .radius/app.bicep"] })
    );
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();

    // A plan already in flight is adopted without waiting out an interval.
    expect(
      browser.net.calls.filter(
        (call) => call.url === "/api/progress?view=planned"
      )
    ).toHaveLength(1);
    browser.clock.tick(PLAN_PROGRESS_MS);
    await flushPromises();
    expect(
      browser.net.calls.filter(
        (call) => call.url === "/api/progress?view=planned"
      )
    ).toHaveLength(2);
    expect(status.textContent).toBe("Drafting .radius/app.bicep");

    plan.resolve(jsonResponse({ reload: true }));
    await flushPromises();
    expect(browser.nav.reloads).toBe(1);
  });

  it("ignores an empty progress message list", async () => {
    const { browser, status } = fixture();
    const plan = createDeferred<HttpResponse>();
    browser.net.handle("/api/plan-graph", () => plan.promise);
    browser.net.handle("/api/progress?view=planned", () =>
      jsonResponse({ messages: [] })
    );
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();
    status.textContent = "unchanged";

    browser.clock.tick(PLAN_PROGRESS_MS);
    await flushPromises();

    expect(status.textContent).toBe("unchanged");
  });

  it("ignores a stale progress response superseded by another change", async () => {
    const { browser, branch, status } = fixture();
    const plan = createDeferred<HttpResponse>();
    const progress = createDeferred<HttpResponse>();
    browser.net.handle("/api/plan-graph", () => plan.promise);
    browser.net.handle("/api/progress?view=planned", () => progress.promise);
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();

    browser.clock.tick(PLAN_PROGRESS_MS);
    branch.value = "another";
    branch.dispatch("change");
    progress.resolve(jsonResponse({ messages: ["late message"] }));
    await flushPromises();

    expect(status.textContent).not.toBe("late message");
  });

  it("logs a failing progress request without breaking the page", async () => {
    const { browser } = fixture();
    const plan = createDeferred<HttpResponse>();
    browser.net.handle("/api/plan-graph", () => plan.promise);
    browser.net.handle("/api/progress?view=planned", () =>
      Promise.reject(new Error("progress unavailable"))
    );
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();

    browser.clock.tick(PLAN_PROGRESS_MS);
    await flushPromises();

    expect(
      browser.logger.errors.some(
        (entry) => entry.message === "Radius planned graph progress failed."
      )
    ).toBe(true);
  });

  it("ignores a stale progress failure superseded by another change", async () => {
    const { browser, branch } = fixture();
    const plan = createDeferred<HttpResponse>();
    const progress = createDeferred<HttpResponse>();
    browser.net.handle("/api/plan-graph", () => plan.promise);
    browser.net.handle("/api/progress?view=planned", () => progress.promise);
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();

    browser.clock.tick(PLAN_PROGRESS_MS);
    branch.value = "another";
    branch.dispatch("change");
    progress.reject(new Error("stale progress failure"));
    await flushPromises();

    expect(browser.logger.errors).toHaveLength(0);
  });

  it("does not navigate when a deploy completes after page teardown", async () => {
    const { browser, button } = fixture();
    const deployment = createDeferred<HttpResponse>();
    browser.net.handle("/api/deploy", () => deployment.promise);
    const teardown = initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();
    button.disabled = false;
    button.dispatch("click");
    await flushPromises();

    teardown();
    deployment.resolve(jsonResponse({ ok: true }));
    await flushPromises();

    expect(
      browser.nav.assigned.some((url) => url.includes("page=deploying"))
    ).toBe(false);
  });

  it("reloads once the plan is ready", async () => {
    const { browser } = fixture();
    browser.net.handle("/api/plan-graph", () => jsonResponse({ reload: true }));
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();

    expect(browser.nav.reloads).toBe(1);
  });

  it("falls back to the page provider when the selected environment has no known provider", async () => {
    const { browser, environment } = fixture({ providerField: "aws" });
    let body = "";
    browser.net.handle("/api/plan-graph", (init) => {
      body = String(init?.body ?? "");
      return jsonResponse({});
    });
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();

    // A value outside the populated environment list has no known provider,
    // unlike the normal selection which always resolves to a real listing.
    environment.value = "unlisted-env";
    environment.dispatch("change");
    browser.clock.tick(PLAN_DEBOUNCE_MS);
    await flushPromises();

    expect(body).toContain('"environment":"unlisted-env"');
    expect(body).toContain('"provider":"aws"');
  });

  it("shows a needsAppBicep message", async () => {
    const { browser, status } = fixture();
    browser.net.handle("/api/plan-graph", () =>
      jsonResponse({ needsAppBicep: true })
    );
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();

    expect(status.textContent).toContain(
      "Copilot is generating .radius/app.bicep"
    );
  });

  it("stops retrying and shows the server refusal when the skill cannot model the repository", async () => {
    const setError = vi.fn();
    const { browser, status } = fixture();
    let calls = 0;
    browser.net.handle("/api/plan-graph", () => {
      calls++;
      return jsonResponse({
        error: "I could not find a Dockerfile in this repository.",
        appBicepUnsupported: true
      });
    });
    initializePlannedGraphPage(
      browser.context,
      globals({ radiusSetGraphError: setError })
    );
    await flushPromises();

    browser.clock.tick(PLAN_RETRY_MS * 5);
    await flushPromises();

    expect(calls).toBe(1);
    expect(setError).toHaveBeenCalledWith(
      "graph-container",
      "I could not find a Dockerfile in this repository."
    );
    expect(status.textContent).toBe("");
  });

  // Nothing announces the model's arrival, so a page that reported the wait
  // once and then stopped asking never recovered — even after the model landed.
  it("keeps asking until the model lands, then renders the planned graph", async () => {
    const renderGraph = vi.fn();
    const { browser, status } = fixture();
    let calls = 0;
    const bodies: string[] = [];
    browser.net.handle("/api/plan-graph", (init) => {
      calls++;
      bodies.push(String(init?.body ?? ""));
      return calls < 3 ?
          jsonResponse({ needsAppBicep: true })
        : jsonResponse({ reload: true });
    });
    initializePlannedGraphPage(
      browser.context,
      globals({ radiusRenderGraph: renderGraph })
    );
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();

    for (let attempt = 0; attempt < 2; attempt++) {
      browser.clock.tick(PLAN_RETRY_MS);
      await flushPromises();
      browser.clock.tick(0);
      await flushPromises();
    }

    expect(calls).toBe(3);
    expect(bodies[0]).toContain('"restartWait":true');
    expect(bodies[1]).toContain('"restartWait":false');
    expect(bodies[2]).toContain('"restartWait":false');
    expect(browser.nav.reloads).toBe(1);
    expect(status.textContent).toContain("Copilot is generating");
  });

  it("stops asking once the server ends the wait", async () => {
    const { browser, status } = fixture();
    let calls = 0;
    browser.net.handle("/api/plan-graph", () => {
      calls++;
      return jsonResponse({
        error: "No modeling run has started.",
        appBicepWaitExpired: true
      });
    });
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();
    browser.clock.tick(PLAN_RETRY_MS * 5);
    await flushPromises();

    expect(calls).toBe(1);
    expect(status.textContent).toBe("Error: No modeling run has started.");
  });

  // A pending retry must not fire a request for a selection the user replaced.
  it("abandons a pending retry when the selection changes", async () => {
    const { browser, branch } = fixture();
    const bodies: string[] = [];
    browser.net.handle("/api/plan-graph", (init) => {
      bodies.push(String(init?.body ?? ""));
      return jsonResponse({ needsAppBicep: true });
    });
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();

    branch.value = "another";
    branch.dispatch("change");
    browser.clock.tick(PLAN_DEBOUNCE_MS);
    await flushPromises();
    const settled = bodies.length;
    browser.clock.tick(PLAN_RETRY_MS);
    await flushPromises();

    expect(bodies).toHaveLength(settled + 1);
    expect(bodies.at(-1)).toContain('"branch":"another"');
  });

  it("keeps external error detail out of user-visible failures", async () => {
    const { browser, status } = fixture();
    browser.net.handle("/api/plan-graph", () =>
      Promise.reject(new Error("credential-like detail"))
    );
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();

    expect(status.textContent).toBe(
      "The planned deployment could not be generated. Try again."
    );
    expect(status.textContent).not.toContain("credential-like");
    expect(browser.logger.errors.length).toBeGreaterThan(0);
  });

  it("ignores a stale plan failure superseded by another change", async () => {
    const { browser, branch } = fixture();
    const first = createDeferred<HttpResponse>();
    let calls = 0;
    const requestedBranches: string[] = [];
    browser.net.handle("/api/plan-graph", (init) => {
      calls++;
      const body = JSON.parse(String(init?.body)) as { branch?: string };
      requestedBranches.push(body.branch || "");
      return calls === 1 ? first.promise : jsonResponse({ reload: true });
    });
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();

    branch.value = "another";
    branch.dispatch("change");
    browser.clock.tick(PLAN_DEBOUNCE_MS);
    await flushPromises();

    expect(calls).toBe(2);
    expect(browser.net.aborted).toBe(1);
    expect(requestedBranches).toEqual(["feature", "another"]);

    first.reject(new Error("stale plan failure"));
    await flushPromises();

    expect(calls).toBe(2);
    expect(browser.nav.reloads).toBe(1);
    expect(browser.logger.errors).toHaveLength(0);
  });

  it("holds the deploy action closed while a plan is in flight and reopens it once the plan settles", async () => {
    const { browser, button } = fixture();
    const pending = createDeferred<HttpResponse>();
    browser.net.handle("/api/plan-graph", () => pending.promise);
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();

    expect(button.dataset.mode).toBe("deploy");
    expect(button.disabled).toBe(true);

    pending.resolve(jsonResponse({ reload: true }));
    await flushPromises();

    expect(browser.nav.reloads).toBe(1);
    expect(button.disabled).toBe(false);
  });

  it("closes the deploy action again as soon as a selection queues a new plan", async () => {
    const { browser, button, branch } = fixture();
    browser.net.handle("/api/plan-graph", () => jsonResponse({ reload: true }));
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();

    expect(button.disabled).toBe(false);

    branch.value = "another";
    branch.dispatch("change");

    // Closed on the selection itself, before the debounce even elapses: the
    // previewed plan no longer matches what the button would deploy.
    expect(button.disabled).toBe(true);
  });

  it("keeps deployment closed when deployment states resolve during the plan debounce", async () => {
    const { browser, button, branch, hint } = fixture({
      resources: [{ id: "app/web" }]
    });
    const deployments = createDeferred<HttpResponse>();
    browser.net.handle(
      `${DEPLOYMENTS_PATH}?repo=octo%2Fapp&fresh=1`,
      () => deployments.promise
    );
    browser.net.handle("/api/plan-graph", () => jsonResponse({ reload: true }));
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();

    branch.value = "another";
    branch.dispatch("change");
    deployments.resolve(jsonResponse({ deployments: [] }));
    await flushPromises();

    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toContain(
      "deployment plan is still updating"
    );
    expect(hint.innerHTML).toContain(
      "deployment plan is still updating, so deployment is temporarily unavailable"
    );

    browser.clock.tick(PLAN_DEBOUNCE_MS);
    await flushPromises();
    expect(button.disabled).toBe(false);
  });

  it("keeps deployment closed when deployment states resolve during an active plan", async () => {
    const { browser, button, branch, hint } = fixture({
      resources: [{ id: "app/web" }]
    });
    const deployments = createDeferred<HttpResponse>();
    const plan = createDeferred<HttpResponse>();
    browser.net.handle(
      `${DEPLOYMENTS_PATH}?repo=octo%2Fapp&fresh=1`,
      () => deployments.promise
    );
    browser.net.handle("/api/plan-graph", () => plan.promise);
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    branch.value = "another";
    branch.dispatch("change");
    browser.clock.tick(0);
    browser.clock.tick(PLAN_DEBOUNCE_MS);
    await flushPromises();

    deployments.resolve(jsonResponse({ deployments: [] }));
    await flushPromises();

    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toContain(
      "deployment plan is still updating"
    );
    expect(hint.innerHTML).toContain(
      "deployment plan is still updating, so deployment is temporarily unavailable"
    );
    expect(
      browser.net.calls.some((call) => call.url === "/api/plan-graph")
    ).toBe(true);

    plan.resolve(jsonResponse({ reload: true }));
    await flushPromises();
  });

  it("abandons a queued plan when the page is torn down before it drains", async () => {
    const { browser, branch } = fixture();
    let calls = 0;
    const first = createDeferred<HttpResponse>();
    browser.net.handle("/api/plan-graph", () => {
      calls += 1;
      return calls === 1 ? first.promise : jsonResponse({ reload: true });
    });
    const teardown = initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();

    branch.value = "another";
    branch.dispatch("change");
    teardown();

    first.resolve(jsonResponse({ reload: true }));
    await flushPromises();
    browser.clock.tick(PLAN_DEBOUNCE_MS);
    await flushPromises();

    // The queued request belonged to a page the user has already left.
    expect(calls).toBe(1);
    expect(browser.nav.reloads).toBe(0);
    expect(browser.logger.errors).toHaveLength(0);
  });

  it("re-applies environment state and re-queues a plan on each selector change", async () => {
    const { browser, app, environment } = fixture();
    browser.net.handle("/api/plan-graph", () => jsonResponse({ reload: true }));
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();

    app.dispatch("change");
    environment.dispatch("change");
    browser.clock.tick(PLAN_DEBOUNCE_MS);
    await flushPromises();

    expect(browser.nav.reloads).toBeGreaterThan(0);
  });

  it("tears down pending work, aborting an in-flight plan request", async () => {
    const { browser } = fixture();
    const plan = createDeferred<HttpResponse>();
    browser.net.handle("/api/plan-graph", () => plan.promise);
    browser.net.handle("/api/progress?view=planned", () =>
      jsonResponse({ messages: [] })
    );
    const teardown = initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();
    expect(browser.net.aborted).toBe(0);

    teardown();
    expect(browser.net.aborted).toBe(1);
    expect(browser.clock.pending).toBe(0);

    plan.resolve(jsonResponse({ reload: true }));
    await flushPromises();
    expect(browser.nav.reloads).toBe(0);
  });

  it("ignores a late plan response when abort support is unavailable", async () => {
    const { browser } = fixture();
    browser.net.supportsAbort = false;
    const plan = createDeferred<HttpResponse>();
    browser.net.handle("/api/plan-graph", () => plan.promise);
    const teardown = initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();

    teardown();
    plan.resolve(jsonResponse({ reload: true }));
    await flushPromises();

    expect(browser.nav.reloads).toBe(0);
  });

  it("surfaces a validation error returned by the server", async () => {
    const { browser, status } = fixture();
    browser.net.handle("/api/plan-graph", () =>
      jsonResponse({ error: "invalid provider" })
    );
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();

    expect(status.textContent).toBe("Error: invalid provider");
  });

  it("does not bind a click listener when no plan button exists", async () => {
    const { browser } = fixture({ withButton: false });
    browser.net.handle("/api/plan-graph", () => jsonResponse({}));

    expect(() => {
      initializePlannedGraphPage(browser.context, globals());
    }).not.toThrow();
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();
  });

  it("skips clearing a missing container when no environment exists", async () => {
    const { browser } = fixture({ envListing: "empty", withContainer: false });
    expect(() => {
      initializePlannedGraphPage(browser.context, globals());
    }).not.toThrow();
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();
  });

  it("skips the create-environment message when no container exists", async () => {
    const { browser } = fixture({
      envListing: "empty",
      resources: [{ id: "app/web" }],
      withContainer: false
    });
    expect(() => {
      initializePlannedGraphPage(browser.context, globals());
    }).not.toThrow();
    await flushPromises();
  });

  it("skips the automatic follow-up once the page has been torn down", async () => {
    const { browser } = fixture();
    const selectors = createDeferred<HttpResponse>();
    browser.net.handle(
      "/api/list-applications?repo=octo%2Fapp",
      () => selectors.promise
    );
    const teardown = initializePlannedGraphPage(browser.context, globals());
    teardown();

    selectors.resolve(jsonResponse({ applications: [{ name: "app" }] }));
    await flushPromises();

    expect(browser.clock.pending).toBe(0);
  });
  describe("graph build progress", () => {
    const stageText = graphProgressStages;

    it("renders typed planning stages instead of prose", async () => {
      const { browser, progressHost } = fixture();
      const plan = createDeferred<HttpResponse>();
      browser.net.handle("/api/plan-graph", () => plan.promise);
      browser.net.handle("/api/progress?view=planned", () =>
        jsonResponse({
          generation: 3,
          events: [
            {
              sequence: 1,
              stage: "building_graph",
              state: "succeeded",
              detail: "Built a graph with 4 resource(s)."
            },
            {
              sequence: 2,
              stage: "resolving_recipes",
              state: "running",
              detail: "Resolving recipes for dev."
            }
          ]
        })
      );
      initializePlannedGraphPage(browser.context, globals());
      await flushPromises();
      browser.clock.tick(0);
      await flushPromises();

      browser.clock.tick(PLAN_PROGRESS_MS);
      await flushPromises();

      expect(stageText(progressHost)).toEqual([
        `${GRAPH_STAGE_LABELS.building_graph}:succeeded`,
        `${GRAPH_STAGE_LABELS.resolving_recipes}:running`
      ]);
      expect(graphProgressElapsed(progressHost)).toMatch(/^\d+:\d{2}$/);
      expect(fakeText(progressHost)).not.toMatch(/%/);
    });

    it("shows a starting stage before the first poll returns", async () => {
      const { browser, progressHost } = fixture();
      browser.net.handle(
        "/api/plan-graph",
        () => createDeferred<HttpResponse>().promise
      );
      initializePlannedGraphPage(browser.context, globals());
      await flushPromises();
      browser.clock.tick(0);
      await flushPromises();

      expect(stageText(progressHost)).toEqual([
        `${GRAPH_STAGE_LABELS.checking_model}:running`
      ]);
    });
    it.each([
      ["the plan errors", { error: "invalid app.bicep" }],
      ["the plan response is incomplete", {}]
    ])("clears the panel when %s", async (_name, body) => {
      const { browser, progressHost } = fixture();
      browser.net.handle("/api/plan-graph", () => jsonResponse(body));
      initializePlannedGraphPage(browser.context, globals());
      await flushPromises();
      browser.clock.tick(0);
      await flushPromises();

      // The failure is stated once, in the status surface. A panel left behind
      // would repeat it and keep claiming the plan is running.
      expect(stageText(progressHost)).toEqual([]);
    });

    it("clears the panel when the request throws", async () => {
      const { browser, progressHost } = fixture();
      browser.net.handle("/api/plan-graph", () =>
        Promise.reject(new Error("offline"))
      );
      initializePlannedGraphPage(browser.context, globals());
      await flushPromises();
      browser.clock.tick(0);
      await flushPromises();

      expect(stageText(progressHost)).toEqual([]);
    });

    it("clears the panel while Copilot authors the model", async () => {
      const { browser, progressHost } = fixture();
      browser.net.handle("/api/plan-graph", () =>
        jsonResponse({ needsAppBicep: true })
      );
      initializePlannedGraphPage(browser.context, globals());
      await flushPromises();
      browser.clock.tick(0);
      await flushPromises();

      expect(stageText(progressHost)).toEqual([]);
    });
  });
  describe("planned graph progress defaults", () => {
    it("accepts typed events from a payload that omits the generation", async () => {
      const { browser, progressHost } = fixture();
      browser.net.handle(
        "/api/plan-graph",
        () => createDeferred<HttpResponse>().promise
      );
      browser.net.handle("/api/progress?view=planned", () =>
        jsonResponse({
          events: [
            {
              sequence: 5,
              stage: "resolving_recipes",
              state: "running",
              detail: "Resolving recipes."
            }
          ]
        })
      );
      initializePlannedGraphPage(browser.context, globals());
      await flushPromises();
      browser.clock.tick(0);
      await flushPromises();
      browser.clock.tick(PLAN_PROGRESS_MS);
      await flushPromises();

      expect(graphProgressStages(progressHost)).toEqual([
        `${GRAPH_STAGE_LABELS.resolving_recipes}:running`
      ]);
    });
  });
});
