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
  initializePlannedGraphPage,
  PLANNED_GRAPH_STATE_ID,
  PLAN_DEBOUNCE_MS,
  PLAN_PROGRESS_MS
} from "./planned-graph-page.js";

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
    envListing = "ok"
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
  const status = createFakeElement("plan-status");
  const container = createFakeElement("graph-container");
  const wrapper = createFakeElement("graph-container-wrapper");
  const elements = [state];
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
    : { environments: [{ name: "dev", provider: "azure" }] };
  browser.net.handle(
    `/api/list-environments?repo=${encodeURIComponent(repo)}`,
    () => jsonResponse(envPayload)
  );
  browser.net.handle("/api/deploy", () => jsonResponse({}));

  return {
    browser,
    app,
    branch,
    environment: environmentSelect,
    button,
    status,
    container,
    wrapper
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
    browser.net.handle("/api/plan-graph", () => jsonResponse({}));
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
    const { browser, container } = fixture({
      envListing: "empty",
      resources: [{ id: "app/web" }]
    });
    container.innerHTML = "<div>stale</div>";
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();

    expect(container.innerHTML).toContain(
      "Create an environment to preview the planned deployment for this application."
    );
  });

  it("prompts to create an environment and clears the container when a change is queued with no environment", async () => {
    const { browser, branch, status, container } = fixture({
      envListing: "empty",
      resources: [{ id: "app/web" }]
    });
    browser.net.handle("/api/plan-graph", () => jsonResponse({}));
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

  it("polls progress and ignores a late progress message", async () => {
    const { browser, status } = fixture();
    const plan = createDeferred<HttpResponse>();
    browser.net.handle("/api/plan-graph", () => plan.promise);
    browser.net.handle("/api/progress", () =>
      jsonResponse({ messages: ["Drafting .radius/app.bicep"] })
    );
    initializePlannedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(0);
    await flushPromises();

    browser.clock.tick(PLAN_PROGRESS_MS);
    await flushPromises();
    expect(
      browser.net.calls.filter((call) => call.url === "/api/progress")
    ).toHaveLength(1);
    expect(status.textContent).toBe("Drafting .radius/app.bicep");

    plan.resolve(jsonResponse({ reload: true }));
    await flushPromises();
    expect(browser.nav.reloads).toBe(1);
  });

  it("ignores an empty progress message list", async () => {
    const { browser, status } = fixture();
    const plan = createDeferred<HttpResponse>();
    browser.net.handle("/api/plan-graph", () => plan.promise);
    browser.net.handle("/api/progress", () => jsonResponse({ messages: [] }));
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
    browser.net.handle("/api/progress", () => progress.promise);
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
    browser.net.handle("/api/progress", () =>
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
    browser.net.handle("/api/progress", () => progress.promise);
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
    browser.net.handle("/api/plan-graph", () => {
      calls++;
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

    // Requests are serialized, so the replacement is still queued: it is only
    // released once the superseded request settles.
    expect(calls).toBe(1);

    first.reject(new Error("stale plan failure"));
    await flushPromises();
    browser.clock.tick(PLAN_DEBOUNCE_MS);
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
    browser.net.handle("/api/progress", () => jsonResponse({ messages: [] }));
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
});
