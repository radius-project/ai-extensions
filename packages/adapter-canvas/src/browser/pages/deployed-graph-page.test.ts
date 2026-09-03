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
import type { FakeElement } from "../../../test/support/browser/fakes.js";
import {
  graphProgressElapsed,
  graphProgressStages
} from "../../../test/support/browser/graph-progress.js";
import { GRAPH_STAGE_LABELS } from "../graph/progress.js";
import { DELETE_CONFLICT_PATH, deleteConflictUrl } from "../force-delete.js";
import { NOOP_TEARDOWN } from "../lifecycle.js";
import type { HttpResponse } from "../ports.js";
import {
  DEPLOYED_GRAPH_POLL_MS,
  DEPLOYED_GRAPH_STATE_ID,
  DEPLOYED_LOG_POLL_MS,
  DEPLOYED_STATE_POLL_LIMIT,
  DEPLOYED_STATE_POLL_MS,
  initializeDeployedGraphPage
} from "./deployed-graph-page.js";

type Listing = "ok" | "empty" | "error";

interface FixtureOptions {
  repo?: string;
  branchField?: string;
  graphBranchField?: string;
  providerField?: string;
  withStatus?: boolean;
  withLabel?: boolean;
  withNote?: boolean;
  withLogSection?: boolean;
  withLogOutput?: boolean;
  withAppSelect?: boolean;
  withEnvSelect?: boolean;
  withAction?: boolean;
  withContainer?: boolean;
  withInlineStatus?: boolean;
  withModal?: boolean;
  withModalText?: boolean;
  appListing?: Listing;
  envListing?: Listing;
  deploymentsListing?: Listing;
  deployments?: Array<{ app: string; environment: string; status: string }>;
  search?: string;
}

function fixture(options: FixtureOptions = {}) {
  const {
    repo = "octo/app",
    branchField = "feature",
    graphBranchField = "feature",
    providerField = "azure",
    withStatus = true,
    withLabel = true,
    withNote = true,
    withLogSection = true,
    withLogOutput = true,
    withAppSelect = true,
    withEnvSelect = true,
    withAction = true,
    withContainer = true,
    withInlineStatus = true,
    withModal = true,
    withModalText = true,
    appListing = "ok",
    envListing = "ok",
    deploymentsListing = "ok",
    deployments = [{ app: "app", environment: "dev", status: "success" }],
    search = ""
  } = options;
  const browser = createFakeBrowser();
  if (search) {
    browser.nav.search = search;
    browser.nav.href = `http://localhost/?page=deployed${search}`;
  }
  const state = createFakeElement(DEPLOYED_GRAPH_STATE_ID);
  state.textContent = JSON.stringify({
    repo,
    branch: branchField,
    graphBranch: graphBranchField,
    provider: providerField,
    mutationNonce: "nonce-1"
  });
  const appSelect = createFakeSelect("deployed-app-select");
  const envSelect = createFakeSelect("deployed-env-select");
  const action = createFakeInput("deployed-delete-btn");
  const stopTrackingAction = createFakeInput("deployed-stop-tracking-btn");
  const status = createFakeElement("deployed-status");
  const label = createFakeElement("deployed-graph-label");
  const note = createFakeElement("deployed-mode-note");
  const inlineStatus = createFakeElement("deployed-inline-status");
  const logSection = createFakeElement("deployed-log-section");
  const logOutput = createFakeElement("deployed-log-output");
  const container = createFakeElement("graph-container");
  const modal = createFakeElement("deployed-deleting-modal");
  const modalText = createFakeElement("deployed-deleting-text");
  // The lighter shared confirmation this page renders for the forced delete.
  const confirmElements: Record<string, FakeElement> = {};
  for (const id of CONFIRM_DIALOG_IDS) {
    const element = createFakeElement(id);
    if (id === "env-confirm-modal") element.style.display = "none";
    confirmElements[id] = element;
  }

  const elements = [state, ...Object.values(confirmElements)];
  const progressHost = createFakeElement("deployed-progress-steps");
  elements.push(progressHost);
  if (withAppSelect) elements.push(appSelect);
  if (withEnvSelect) elements.push(envSelect);
  if (withAction) elements.push(action);
  if (withAction) elements.push(stopTrackingAction);
  if (withStatus) elements.push(status);
  if (withLabel) elements.push(label);
  if (withNote) elements.push(note);
  if (withInlineStatus) elements.push(inlineStatus);
  if (withLogSection) elements.push(logSection);
  if (withLogOutput) elements.push(logOutput);
  if (withContainer) elements.push(container);
  if (withModal) elements.push(modal);
  if (withModalText) elements.push(modalText);
  for (const element of elements) browser.document.add(element);

  const appPayload: Record<string, unknown> =
    appListing === "error" ? { applications: [], error: "boom" }
    : appListing === "empty" ? { applications: [] }
    : { applications: [{ name: "app" }, { name: "other-app" }] };
  browser.net.handle(
    `/api/list-applications?repo=${encodeURIComponent(repo)}`,
    () => jsonResponse(appPayload)
  );
  const envPayload: Record<string, unknown> =
    envListing === "error" ? { environments: [], error: "boom" }
    : envListing === "empty" ? { environments: [] }
    : { environments: [{ name: "dev", provider: "azure" }] };
  browser.net.handle(
    `/api/list-environments?repo=${encodeURIComponent(repo)}`,
    () => jsonResponse(envPayload)
  );
  const deploymentsPayload: Record<string, unknown> =
    deploymentsListing === "error" ? { deployments: [], error: "boom" }
    : deploymentsListing === "empty" ? { deployments: [] }
    : { deployments };
  browser.net.handle(
    `/api/list-deployments?repo=${encodeURIComponent(repo)}`,
    () => jsonResponse(deploymentsPayload)
  );
  // A sensible default for the automatic initial graph load, so tests that
  // are not specifically exercising the graph fetch do not need to register
  // it themselves. Tests may override this with their own `net.handle` call.
  browser.net.handle(
    `/api/deployed-graph?repo=${encodeURIComponent(repo)}&application=app&environment=dev`,
    () => jsonResponse({ resources: [], mode: "greyed" })
  );
  // A pristine session for the startup deploy-feed probe: no run has produced
  // logs, so the log stream stays closed. Tests that exercise the feed override
  // this with their own `net.handle` call.
  browser.net.handle("/api/deploy-status", () =>
    jsonResponse({ status: "pending", logTotal: 0 })
  );

  return {
    confirm: confirmElements,
    browser,
    appSelect,
    envSelect,
    action,
    stopTrackingAction,
    status,
    label,
    note,
    inlineStatus,
    logSection,
    logOutput,
    container,
    modal,
    modalText,
    progressHost
  };
}

// The lighter shared confirmation's markup ids, rendered by this page.
const CONFIRM_DIALOG_IDS = [
  "env-confirm-modal",
  "env-confirm-title",
  "env-confirm-message",
  "env-confirm-usage",
  "env-confirm-usage-label",
  "env-confirm-usage-list",
  "env-confirm-cancel",
  "env-confirm-ok"
] as const;

function globals(overrides: Record<string, unknown> = {}) {
  return {
    radiusRenderGraph: vi.fn(),
    ...overrides
  };
}

// A confirmable delete dialog double. Holding the pending confirmation on a
// plain object (rather than a reassigned `let`) sidesteps the closure and
// avoids relying on non-null assertions to invoke it later.
function createConfirmingDialog() {
  const holder: {
    confirmed: (() => void) | null;
    opened: boolean;
  } = {
    confirmed: null,
    opened: false
  };
  const createDialog = vi.fn(
    (options: { onConfirm: (a: string, e: string) => void }) => ({
      open: (application: string, environment: string) => {
        holder.opened = true;
        holder.confirmed = () => options.onConfirm(application, environment);
      }
    })
  );
  return {
    createDialog,
    confirm: (): void => holder.confirmed?.(),
    wasOpened: (): boolean => holder.opened
  };
}

describe("initializeDeployedGraphPage", () => {
  it("does nothing when the page state element is absent", () => {
    const browser = createFakeBrowser();
    const teardown = initializeDeployedGraphPage(browser.context, globals());
    expect(teardown).toBe(NOOP_TEARDOWN);
  });

  it("loads the selected target, renders its branch and binds once", async () => {
    const { browser, appSelect, envSelect, action } = fixture();
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () =>
        jsonResponse({
          resources: [{ id: "app/web" }],
          mode: "terminal",
          branch: "feature",
          updatedAt: new Date(0).toISOString(),
          application: "app"
        })
    );
    const render = vi.fn();
    const teardown = initializeDeployedGraphPage(
      browser.context,
      globals({ radiusRenderGraph: render })
    );
    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusRenderGraph: render })
    );
    await flushPromises();

    expect(render).toHaveBeenCalledWith(
      "graph-container",
      [{ id: "app/web" }],
      expect.objectContaining({
        branch: "feature",
        deployMode: true,
        showLegend: true
      })
    );
    expect(action.dataset.mode).toBe("delete");
    expect(appSelect.listenerCount("change")).toBe(1);
    expect(envSelect.listenerCount("change")).toBe(1);
    teardown();
    expect(appSelect.listenerCount()).toBe(0);
    expect(envSelect.listenerCount()).toBe(0);
    expect(browser.clock.pending).toBe(0);
  });

  it("does not show a deploying legend for a never-deployed graph", async () => {
    const { browser } = fixture();
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () =>
        jsonResponse({
          resources: [{ id: "app/web", deployStatus: "pending" }],
          mode: "greyed",
          branch: "feature"
        })
    );
    const render = vi.fn();

    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusRenderGraph: render })
    );
    await flushPromises();

    expect(render).toHaveBeenCalledWith(
      "graph-container",
      expect.any(Array),
      expect.objectContaining({ deployMode: true, showLegend: false })
    );
  });

  it("updates in place when a live graph becomes terminal so the viewport survives", async () => {
    const { browser } = fixture();
    let mode = "live";
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () =>
        jsonResponse({
          resources: [{ id: "app/web", deployStatus: "success" }],
          mode,
          branch: "feature"
        })
    );
    browser.net.handle("/api/deploy-status?since=0", () =>
      jsonResponse({ status: "complete", logsNew: [], logTotal: 0 })
    );
    const update = vi.fn();
    const destroy = vi.fn();
    const render = vi.fn(() => ({ update, destroy }));

    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusRenderGraph: render })
    );
    await flushPromises();
    expect(render).toHaveBeenCalledTimes(1);

    mode = "terminal";
    browser.clock.tick(DEPLOYED_GRAPH_POLL_MS);
    await flushPromises();

    expect(destroy).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith([
      { id: "app/web", deployStatus: "success" }
    ]);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("remounts when a greyed graph becomes live so the legend appears", async () => {
    const { browser, envSelect } = fixture();
    let mode = "greyed";
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () =>
        jsonResponse({
          resources: [{ id: "app/web" }],
          mode,
          branch: "feature"
        })
    );
    browser.net.handle("/api/deploy-status?since=0", () =>
      jsonResponse({ status: "complete", logsNew: [], logTotal: 0 })
    );
    const update = vi.fn();
    const destroy = vi.fn();
    const render = vi.fn(() => ({ update, destroy }));

    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusRenderGraph: render })
    );
    await flushPromises();
    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenLastCalledWith(
      "graph-container",
      expect.any(Array),
      expect.objectContaining({ showLegend: false })
    );

    mode = "live";
    envSelect.dispatch("change");
    await flushPromises();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenLastCalledWith(
      "graph-container",
      expect.any(Array),
      expect.objectContaining({ showLegend: true })
    );
  });

  it("polls only a live graph and pauses while hidden", async () => {
    const { browser } = fixture();
    const url =
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev";
    browser.net.handle(url, () =>
      jsonResponse({
        resources: [{ id: "app/web" }],
        mode: "live",
        branch: "feature"
      })
    );
    browser.net.handle("/api/deploy-status?since=0", () =>
      jsonResponse({ status: "in_progress", logsNew: [], logTotal: 0 })
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();
    expect(browser.clock.timeouts).toBe(1);

    browser.document.visibilityState = "hidden";
    browser.document.dispatch("visibilitychange");
    expect(browser.clock.timeouts).toBe(0);
    browser.document.visibilityState = "visible";
    browser.document.dispatch("visibilitychange");
    await flushPromises();
    browser.clock.tick(DEPLOYED_GRAPH_POLL_MS);
    await flushPromises();
    expect(
      browser.net.calls.filter((call) => call.url === url).length
    ).toBeGreaterThan(1);
  });

  it("fails closed when deployment state cannot be read", async () => {
    const { browser, action } = fixture({ deploymentsListing: "error" });
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => jsonResponse({ resources: [], mode: "greyed" })
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(action.disabled).toBe(true);
    action.dispatch("click");
    expect(
      browser.net.calls.filter((call) => call.url === "/api/deploy")
    ).toHaveLength(0);
  });

  it("wires a delete dialog, opens it from the delete action and tears it down", async () => {
    const { browser, action, appSelect, envSelect } = fixture();
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => jsonResponse({ resources: [], mode: "greyed" })
    );
    const opens: Array<[string, string]> = [];
    const dialogTeardown = vi.fn();
    const createDialog = vi.fn(
      (options: { onConfirm: (a: string, e: string) => void }) => ({
        open: (application: string, environment: string) => {
          opens.push([application, environment]);
          options.onConfirm(application, environment);
        },
        teardown: dialogTeardown
      })
    );
    const teardown = initializeDeployedGraphPage(
      browser.context,
      globals({ radiusCreateDeleteDeploymentDialog: createDialog })
    );
    await flushPromises();

    expect(createDialog).toHaveBeenCalledTimes(2);
    expect(action.dataset.mode).toBe("delete");
    appSelect.value = "app";
    envSelect.value = "dev";
    action.dispatch("click");

    expect(opens).toEqual([["app", "dev"]]);
    teardown();
    expect(dialogTeardown).toHaveBeenCalledTimes(2);
  });

  it("ignores an invalid delete dialog factory result", async () => {
    const { browser } = fixture();
    const createDialog = vi.fn(() => "not-a-dialog");
    expect(() => {
      initializeDeployedGraphPage(
        browser.context,
        globals({ radiusCreateDeleteDeploymentDialog: createDialog })
      );
    }).not.toThrow();
    await flushPromises();
  });

  it("does not open a dialog without both an application and an environment selected", async () => {
    const { browser, action, appSelect, envSelect } = fixture();
    const open = vi.fn();
    const createDialog = vi.fn(() => ({ open }));
    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusCreateDeleteDeploymentDialog: createDialog })
    );
    await flushPromises();

    appSelect.value = "";
    envSelect.value = "dev";
    action.dispatch("click");

    expect(open).not.toHaveBeenCalled();
  });

  it("routes create-environment mode without opening a dialog", async () => {
    const { browser, action } = fixture();
    const open = vi.fn();
    const createDialog = vi.fn(() => ({ open }));
    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusCreateDeleteDeploymentDialog: createDialog })
    );
    await flushPromises();

    action.dataset.mode = "create-env";
    action.dispatch("click");

    expect(browser.nav.assigned).toEqual(["/?page=environment&new=1"]);
    expect(open).not.toHaveBeenCalled();
  });

  it("delegates a deploy-mode action click to the shared deploy flow", async () => {
    const { browser, action, appSelect, envSelect } = fixture();
    browser.net.handle("/api/deploy", () => jsonResponse({}));
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    action.dataset.mode = "deploy";
    action.disabled = false;
    appSelect.value = "app";
    envSelect.value = "dev";
    action.dispatch("click");
    await flushPromises();

    expect(browser.net.calls.some((call) => call.url === "/api/deploy")).toBe(
      true
    );
  });

  it("does not navigate when a deploy completes after page teardown", async () => {
    const { browser, action, appSelect, envSelect } = fixture();
    const deployment = createDeferred<HttpResponse>();
    browser.net.handle("/api/deploy", () => deployment.promise);
    const teardown = initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();
    action.dataset.mode = "deploy";
    action.disabled = false;
    appSelect.value = "app";
    envSelect.value = "dev";
    action.dispatch("click");
    await flushPromises();

    teardown();
    deployment.resolve(jsonResponse({ ok: true }));
    await flushPromises();

    expect(
      browser.nav.assigned.some((url) => url.includes("page=deploying"))
    ).toBe(false);
  });

  it("does not bind selector listeners or a delete action when elements are absent", async () => {
    const { browser } = fixture({
      withAppSelect: false,
      withEnvSelect: false,
      withAction: false
    });
    expect(() => {
      initializeDeployedGraphPage(browser.context, globals());
    }).not.toThrow();
    await flushPromises();
  });

  it("falls back to main/azure defaults when branch, graph branch and provider are empty", async () => {
    const { browser } = fixture({
      branchField: "",
      graphBranchField: "",
      providerField: ""
    });
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => jsonResponse({ resources: [{ id: "app/web" }], mode: "terminal" })
    );
    const render = vi.fn();
    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusRenderGraph: render })
    );
    await flushPromises();

    expect(render).toHaveBeenCalledWith(
      "graph-container",
      [{ id: "app/web" }],
      expect.objectContaining({ branch: "main" })
    );
  });

  it("shows nothing when there is no repository to load a graph for", async () => {
    const { browser, container, status } = fixture({ repo: "" });
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(container.appended[0]?.textContent).toBe("Nothing deployed yet");
    expect(status.style.display).toBe("none");
  });

  it("updates the controller in place when the branch has not changed", async () => {
    const { browser, envSelect } = fixture();
    let updateResult: { update: () => unknown; destroy: () => void } | null =
      null;
    const controller = {
      update: vi.fn(() => updateResult),
      destroy: vi.fn()
    };
    updateResult = controller;
    const render = vi.fn(() => controller);
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () =>
        jsonResponse({
          resources: [{ id: "app/web" }],
          mode: "terminal",
          branch: "feature"
        })
    );
    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusRenderGraph: render })
    );
    await flushPromises();
    expect(render).toHaveBeenCalledTimes(1);

    // Re-triggering a load for the same branch should update the existing
    // controller in place rather than tearing it down and re-rendering.
    envSelect.dispatch("change");
    await flushPromises();

    expect(render).toHaveBeenCalledTimes(1);
    expect(controller.update).toHaveBeenCalledWith([{ id: "app/web" }]);

    // A falsy update result is a valid outcome (the controller could not
    // apply the update in place) and must not throw or force a re-render.
    updateResult = null;
    envSelect.dispatch("change");
    await flushPromises();

    expect(render).toHaveBeenCalledTimes(1);
  });

  it("recreates the controller when the branch changes", async () => {
    const { browser, appSelect } = fixture();
    const first = { update: vi.fn(() => null), destroy: vi.fn() };
    const second = { update: vi.fn(() => second), destroy: vi.fn() };
    const render = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    let call = 0;
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => {
        call++;
        return jsonResponse({
          resources: [{ id: "app/web" }],
          mode: "terminal",
          branch: call === 1 ? "feature" : "another"
        });
      }
    );
    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusRenderGraph: render })
    );
    await flushPromises();
    expect(render).toHaveBeenCalledTimes(1);

    appSelect.dispatch("change");
    await flushPromises();

    expect(render).toHaveBeenCalledTimes(2);
    expect(first.destroy).toHaveBeenCalledTimes(1);
  });

  it("shows an error status when the graph request fails and nothing is rendered", async () => {
    const { browser, status } = fixture();
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => Promise.reject(new Error("secret-shaped detail"))
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(status.className).toBe("status error");
    expect(status.textContent).toBe(
      "The deployed application graph could not be loaded."
    );
    expect(status.textContent).not.toContain("secret-shaped");
    expect(browser.logger.errors.length).toBeGreaterThan(0);
  });

  it("shows a modeled workflow error returned by the graph route", async () => {
    const { browser, status } = fixture();
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () =>
        jsonResponse(
          { error: "Application model compilation failed." },
          false,
          400
        )
    );

    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(status.className).toBe("status error");
    expect(status.textContent).toBe("Application model compilation failed.");
  });

  it("retries while application model generation is pending", async () => {
    const { browser } = fixture();
    let calls = 0;
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => {
        calls++;
        return calls === 1 ?
            jsonResponse({
              error: "Copilot is generating .radius/app.bicep.",
              retry: true
            })
          : jsonResponse({ resources: [], mode: "greyed" });
      }
    );

    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();
    expect(calls).toBe(1);

    browser.clock.tick(DEPLOYED_GRAPH_POLL_MS);
    await flushPromises();

    expect(calls).toBe(2);
  });

  it("keeps a rendered graph on screen when a later refresh fails", async () => {
    const { browser, appSelect, status } = fixture();
    const controller = { update: vi.fn(() => controller), destroy: vi.fn() };
    const render = vi.fn(() => controller);
    let call = 0;
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => {
        call++;
        if (call === 1) {
          return jsonResponse({
            resources: [{ id: "app/web" }],
            mode: "terminal",
            branch: "feature"
          });
        }
        return Promise.reject(new Error("network down"));
      }
    );
    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusRenderGraph: render })
    );
    await flushPromises();

    appSelect.dispatch("change");
    await flushPromises();

    expect(status.className).not.toBe("status error");
  });

  it("keeps a rendered graph and reports a later modeled workflow error", async () => {
    const { browser, appSelect, note, status } = fixture();
    const controller = { update: vi.fn(() => controller), destroy: vi.fn() };
    let call = 0;
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => {
        call++;
        return call === 1 ?
            jsonResponse({
              resources: [{ id: "app/web" }],
              mode: "terminal",
              branch: "feature"
            })
          : jsonResponse(
              { error: "Application model compilation failed." },
              false,
              400
            );
      }
    );
    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusRenderGraph: () => controller })
    );
    await flushPromises();

    appSelect.dispatch("change");
    await flushPromises();

    expect(status.className).not.toBe("status error");
    expect(note.textContent).toBe("Application model compilation failed.");
  });

  it("ignores a stale graph response superseded by another selection", async () => {
    const { browser, appSelect } = fixture();
    browser.net.supportsAbort = false;
    const first = createDeferred<HttpResponse>();
    let call = 0;
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => {
        call++;
        return call === 1 ?
            first.promise
          : jsonResponse({ resources: [], mode: "greyed" });
      }
    );
    const render = vi.fn();
    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusRenderGraph: render })
    );
    await flushPromises();
    appSelect.dispatch("change");
    await flushPromises();

    first.resolve(jsonResponse({ resources: [{ id: "stale" }], mode: "live" }));
    await flushPromises();

    expect(render).not.toHaveBeenCalled();
  });

  it("ignores a stale graph failure superseded by another selection", async () => {
    const { browser, appSelect } = fixture();
    const first = createDeferred<HttpResponse>();
    let call = 0;
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => {
        call++;
        return call === 1 ?
            first.promise
          : jsonResponse({ resources: [], mode: "greyed" });
      }
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();
    appSelect.dispatch("change");
    await flushPromises();

    first.reject(new Error("stale failure"));
    await flushPromises();

    expect(browser.logger.errors).toHaveLength(0);
  });

  it("describes a greyed graph as not yet deployed", async () => {
    const { browser, note } = fixture();
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => jsonResponse({ resources: [{ id: "app/web" }], mode: "greyed" })
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(note.textContent).toBe(
      "Not deployed yet — showing the modeled application."
    );
  });

  it("describes a live deploy with recent age and a differing application", async () => {
    const { browser, note } = fixture();
    browser.clock.tick(30_000);
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () =>
        jsonResponse({
          resources: [{ id: "app/web" }],
          mode: "live",
          updatedAt: new Date(browser.clock.now() - 10_000).toISOString(),
          application: "Other-App"
        })
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    // appSelect.value defaults to "app" (first option), which differs in
    // case from the shown application "Other-App".
    expect(note.textContent).toContain("Deploying");
    expect(note.textContent).toContain("10s");
    expect(note.textContent).toContain("showing Other-App");
    expect(note.textContent).toContain(
      `every ${DEPLOYED_GRAPH_POLL_MS / 1000}s`
    );
  });

  it("describes deployment age in minutes and hours", async () => {
    const { browser, note } = fixture();
    browser.clock.tick(4000_000);
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () =>
        jsonResponse({
          resources: [{ id: "app/web" }],
          mode: "terminal",
          updatedAt: new Date(browser.clock.now() - 5 * 60_000).toISOString()
        })
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(note.textContent).toContain("5m ago");
  });

  it("describes a terminal deployment with no timestamp and no app note", async () => {
    const { browser, note } = fixture();
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => jsonResponse({ resources: [{ id: "app/web" }], mode: "terminal" })
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(note.textContent).toBe("Last deployment.");
  });

  it("omits the app note when the shown application matches the selection", async () => {
    const { browser, note } = fixture();
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () =>
        jsonResponse({
          resources: [{ id: "app/web" }],
          mode: "terminal",
          application: "APP"
        })
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(note.textContent).toBe("Last deployment.");
  });

  it("skips setting the mode note when no note element exists", async () => {
    const { browser } = fixture({ withNote: false });
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => jsonResponse({ resources: [{ id: "app/web" }], mode: "terminal" })
    );
    expect(() => {
      initializeDeployedGraphPage(browser.context, globals());
    }).not.toThrow();
    await flushPromises();
  });

  it("streams deployment logs while live, appending new lines and stopping on completion", async () => {
    const { browser, logSection, logOutput } = fixture();
    logOutput.scrollHeight = 240;
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => jsonResponse({ resources: [{ id: "app/web" }], mode: "live" })
    );
    let since = -1;
    browser.net.handle("/api/deploy-status?since=0", () => {
      since = 0;
      return jsonResponse({
        logsNew: ["line one"],
        logTotal: 1,
        status: "in_progress"
      });
    });
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(logSection.style.display).toBe("block");
    expect(logOutput.textContent).toContain("line one");
    expect(logOutput.scrollTop).toBe(240);
    expect(since).toBe(0);

    browser.net.handle("/api/deploy-status?since=1", () =>
      jsonResponse({ logsNew: [], logTotal: 1, status: "complete" })
    );
    browser.clock.tick(DEPLOYED_LOG_POLL_MS);
    await flushPromises();

    // The log stream (an interval) stops; a live graph poll (a timeout)
    // legitimately remains scheduled independent of log completion.
    expect(browser.clock.intervals).toBe(0);
  });

  it("does not restart an already-running log stream", async () => {
    const { browser } = fixture();
    let calls = 0;
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => jsonResponse({ resources: [{ id: "app/web" }], mode: "live" })
    );
    browser.net.handle("/api/deploy-status?since=0", () => {
      calls++;
      return jsonResponse({ logsNew: [], logTotal: 0, status: "in_progress" });
    });
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();
    const before = calls;

    browser.document.visibilityState = "hidden";
    browser.document.dispatch("visibilitychange");
    browser.document.visibilityState = "visible";
    browser.document.dispatch("visibilitychange");
    await flushPromises();

    // The log stream is not tied to graph visibility polling, so it should
    // not have been restarted (and thus not re-fetched immediately) purely
    // from a visibility toggle while already streaming.
    expect(calls).toBe(before);
  });

  it("skips appending log lines when no log output element exists", async () => {
    const { browser } = fixture({
      withLogOutput: false,
      withLogSection: false
    });
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => jsonResponse({ resources: [{ id: "app/web" }], mode: "live" })
    );
    browser.net.handle("/api/deploy-status?since=0", () =>
      jsonResponse({ logsNew: ["ignored"], logTotal: 1, status: "in_progress" })
    );
    expect(() => {
      initializeDeployedGraphPage(browser.context, globals());
    }).not.toThrow();
    await flushPromises();
  });

  it("logs a failing log request without breaking the page", async () => {
    const { browser } = fixture();
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => jsonResponse({ resources: [{ id: "app/web" }], mode: "live" })
    );
    browser.net.handle("/api/deploy-status?since=0", () =>
      Promise.reject(new Error("log request failed"))
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(
      browser.logger.errors.some(
        (entry) => entry.message === "Radius deployment log request failed."
      )
    ).toBe(true);
  });

  it("resets the deploy feed only when a later deployment changes attempt", async () => {
    const { browser, logOutput } = fixture();
    let bufferReads = 0;
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => jsonResponse({ resources: [{ id: "app/web" }], mode: "live" })
    );
    browser.net.handle("/api/deploy-status", () =>
      jsonResponse({
        status: "complete",
        logTotal: 1,
        attempt: { id: "attempt-one" }
      })
    );
    browser.net.handle("/api/deploy-status?since=0", () => {
      bufferReads++;
      return bufferReads === 1 ?
          jsonResponse({
            logsNew: ["first run"],
            logTotal: 1,
            status: "complete",
            attempt: { id: "attempt-one" }
          })
        : jsonResponse({
            logsNew: ["second run"],
            logTotal: 1,
            status: "in_progress",
            attempt: { id: "attempt-two" }
          });
    });
    let resumedReads = 0;
    browser.net.handle("/api/deploy-status?since=1", () => {
      resumedReads++;
      return jsonResponse({
        logsNew: [],
        logTotal: 1,
        status: "in_progress",
        attempt: { id: "attempt-two" }
      });
    });
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(logOutput.textContent).toContain("first run");
    expect(browser.clock.intervals).toBe(0);

    // A new attempt resets deployLogs and deployLogBase on the server. Reusing
    // the first attempt's cursor would permanently skip the new buffer's start.
    browser.clock.tick(DEPLOYED_GRAPH_POLL_MS);
    await flushPromises();

    expect(bufferReads).toBe(2);
    expect(resumedReads).toBe(1);
    expect(logOutput.textContent).toContain("second run");
    expect(browser.clock.intervals).toBe(1);
  });

  it("resumes the same attempt when a late live graph reopens its feed", async () => {
    const { browser, logOutput } = fixture();
    const graph = createDeferred<HttpResponse>();
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => graph.promise
    );
    browser.net.handle("/api/deploy-status", () =>
      jsonResponse({
        status: "complete",
        logTotal: 1,
        attempt: { id: "attempt-one" }
      })
    );
    let bufferReads = 0;
    browser.net.handle("/api/deploy-status?since=0", () => {
      bufferReads++;
      return jsonResponse({
        logsNew: ["first run"],
        logTotal: 1,
        status: "complete",
        attempt: { id: "attempt-one" }
      });
    });
    let resumeReads = 0;
    browser.net.handle("/api/deploy-status?since=1", () => {
      resumeReads++;
      return jsonResponse({
        logsNew: [],
        logTotal: 1,
        status: "complete",
        attempt: { id: "attempt-one" }
      });
    });
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();
    expect(logOutput.textContent).toBe("first run\n");

    graph.resolve(
      jsonResponse({ resources: [{ id: "app/web" }], mode: "live" })
    );
    await flushPromises();

    expect(bufferReads).toBe(1);
    expect(resumeReads).toBe(1);
    expect(logOutput.textContent).toBe("first run\n");
  });

  it("restarts an active feed when the startup probe finds a newer attempt", async () => {
    const { browser, logOutput } = fixture();
    const probe = createDeferred<HttpResponse>();
    browser.net.handle("/api/deploy-status", () => probe.promise);
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => jsonResponse({ resources: [{ id: "app/web" }], mode: "live" })
    );
    let bufferReads = 0;
    browser.net.handle("/api/deploy-status?since=0", () => {
      bufferReads++;
      return bufferReads === 1 ?
          jsonResponse({
            logsNew: ["first run"],
            logTotal: 1,
            status: "in_progress",
            attempt: { id: "attempt-one" }
          })
        : jsonResponse({
            logsNew: ["second run"],
            logTotal: 1,
            status: "in_progress",
            attempt: { id: "attempt-two" }
          });
    });
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();
    expect(logOutput.textContent).toContain("first run");

    probe.resolve(
      jsonResponse({
        status: "in_progress",
        logTotal: 1,
        attempt: { id: "attempt-two" }
      })
    );
    await flushPromises();

    expect(bufferReads).toBe(2);
    expect(logOutput.textContent).toContain("second run");
    expect(browser.clock.intervals).toBe(1);
  });

  it("ignores an unidentified feed response after the startup probe establishes its attempt", async () => {
    const { browser, logOutput } = fixture();
    const probe = createDeferred<HttpResponse>();
    const unidentifiedBuffer = createDeferred<HttpResponse>();
    browser.net.handle("/api/deploy-status", () => probe.promise);
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => jsonResponse({ resources: [{ id: "app/web" }], mode: "live" })
    );
    let bufferReads = 0;
    browser.net.handle("/api/deploy-status?since=0", () => {
      bufferReads++;
      return bufferReads === 1 ?
          unidentifiedBuffer.promise
        : jsonResponse({
            logsNew: ["current run"],
            logTotal: 1,
            status: "in_progress",
            attempt: { id: "attempt-two" }
          });
    });
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();
    expect(bufferReads).toBe(1);

    probe.resolve(
      jsonResponse({
        status: "in_progress",
        logTotal: 1,
        attempt: { id: "attempt-two" }
      })
    );
    await flushPromises();

    expect(bufferReads).toBe(2);
    expect(logOutput.textContent).toBe("current run\n");

    unidentifiedBuffer.resolve(
      jsonResponse({
        logsNew: ["stale run"],
        logTotal: 1,
        status: "in_progress",
        attempt: { id: "attempt-one" }
      })
    );
    await flushPromises();

    expect(logOutput.textContent).toBe("current run\n");
    expect(browser.clock.intervals).toBe(1);
  });

  it("keeps streaming after a failing incremental log poll", async () => {
    const { browser, logOutput } = fixture();
    browser.net.handle("/api/deploy-status", () =>
      jsonResponse({ status: "in_progress", logTotal: 1 })
    );
    browser.net.handle("/api/deploy-status?since=0", () =>
      jsonResponse({ logsNew: ["one"], logTotal: 1, status: "in_progress" })
    );
    browser.net.handle("/api/deploy-status?since=1", () =>
      Promise.reject(new Error("poll failed"))
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(DEPLOYED_LOG_POLL_MS);
    await flushPromises();

    expect(
      browser.logger.errors.some(
        (entry) => entry.message === "Radius deployment log request failed."
      )
    ).toBe(true);
    // A single failed poll must not silently end an in-progress deployment feed.
    expect(browser.clock.intervals).toBe(1);

    browser.net.handle("/api/deploy-status?since=1", () =>
      jsonResponse({ logsNew: ["two"], logTotal: 2, status: "complete" })
    );
    browser.clock.tick(DEPLOYED_LOG_POLL_MS);
    await flushPromises();

    expect(logOutput.textContent).toContain("two");
    expect(browser.clock.intervals).toBe(0);
  });

  it("opens the deploy feed for a finished deployment whose graph is not live", async () => {
    const { browser, logSection, logOutput } = fixture();
    browser.net.handle("/api/deploy-status", () =>
      jsonResponse({ status: "failed", logTotal: 2 })
    );
    browser.net.handle("/api/deploy-status?since=0", () =>
      jsonResponse({
        logsNew: ["boom", "stack"],
        logTotal: 2,
        status: "failed"
      })
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    // The default graph for this fixture is "greyed", not "live": a failed run
    // explains itself in this log, so it must not be hidden behind live mode.
    expect(logSection.style.display).toBe("block");
    expect(logOutput.textContent).toContain("boom");
    expect(logOutput.textContent).toContain("stack");
    // A finished run has nothing left to stream.
    expect(browser.clock.intervals).toBe(0);
  });

  it("opens the deploy feed when the session retained logs and streams from the shown cursor", async () => {
    const { browser, logOutput } = fixture();
    browser.net.handle("/api/deploy-status", () =>
      jsonResponse({ status: "pending", logTotal: 1 })
    );
    browser.net.handle("/api/deploy-status?since=0", () =>
      jsonResponse({ logsNew: ["queued"], status: "pending" })
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(logOutput.textContent).toContain("queued");
    expect(browser.clock.intervals).toBe(1);

    // That first response carried no logTotal, so the cursor falls back to the
    // number of lines already shown rather than replaying them.
    browser.net.handle("/api/deploy-status?since=1", () =>
      jsonResponse({ logsNew: [], logTotal: 1, status: "complete" })
    );
    browser.clock.tick(DEPLOYED_LOG_POLL_MS);
    await flushPromises();

    expect(browser.clock.intervals).toBe(0);
  });

  it("arms the log poll only after the first buffer response resolves", async () => {
    const { browser } = fixture();
    const buffer = createDeferred<HttpResponse>();
    browser.net.handle("/api/deploy-status", () =>
      jsonResponse({ status: "in_progress", logTotal: 1 })
    );
    browser.net.handle("/api/deploy-status?since=0", () => buffer.promise);
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    // Arming the interval up front would let a second request share the same
    // cursor and append the whole buffer twice.
    expect(browser.clock.intervals).toBe(0);

    buffer.resolve(
      jsonResponse({ logsNew: ["one"], logTotal: 1, status: "in_progress" })
    );
    await flushPromises();

    expect(browser.clock.intervals).toBe(1);
  });

  it("keeps incremental log polling single-flight", async () => {
    const { browser } = fixture();
    const poll = createDeferred<HttpResponse>();
    browser.net.handle("/api/deploy-status", () =>
      jsonResponse({ status: "in_progress", logTotal: 1 })
    );
    browser.net.handle("/api/deploy-status?since=0", () =>
      jsonResponse({ logsNew: ["one"], logTotal: 1, status: "in_progress" })
    );
    browser.net.handle("/api/deploy-status?since=1", () => poll.promise);
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    browser.clock.tick(DEPLOYED_LOG_POLL_MS * 3);
    await flushPromises();

    expect(
      browser.net.calls.filter(
        (call) => call.url === "/api/deploy-status?since=1"
      )
    ).toHaveLength(1);
    poll.resolve(
      jsonResponse({ logsNew: ["two"], logTotal: 2, status: "complete" })
    );
    await flushPromises();
  });

  it("keeps polling when a log response is malformed", async () => {
    const { browser } = fixture();
    browser.net.handle("/api/deploy-status", () =>
      jsonResponse({ status: "in_progress", logTotal: 1 })
    );
    browser.net.handle("/api/deploy-status?since=0", () => jsonResponse(null));

    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(browser.clock.intervals).toBe(1);
  });

  it("leaves the deploy feed closed for a session that never deployed", async () => {
    const { browser, logSection } = fixture();
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(logSection.style.display).not.toBe("block");
    expect(browser.clock.intervals).toBe(0);
  });

  it("leaves the deploy feed closed when the status payload omits a log total", async () => {
    const { browser, logSection } = fixture();
    browser.net.handle("/api/deploy-status", () =>
      jsonResponse({ status: "pending" })
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(logSection.style.display).not.toBe("block");
    expect(browser.clock.intervals).toBe(0);
  });

  it("ignores an incremental log poll that resolves after teardown", async () => {
    const { browser, logOutput } = fixture();
    const poll = createDeferred<HttpResponse>();
    browser.net.handle("/api/deploy-status", () =>
      jsonResponse({ status: "in_progress", logTotal: 1 })
    );
    browser.net.handle("/api/deploy-status?since=0", () =>
      jsonResponse({ logsNew: ["one"], logTotal: 1, status: "in_progress" })
    );
    browser.net.handle("/api/deploy-status?since=1", () => poll.promise);
    const teardown = initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(DEPLOYED_LOG_POLL_MS);
    await flushPromises();
    teardown();

    poll.resolve(
      jsonResponse({ logsNew: ["late"], logTotal: 2, status: "in_progress" })
    );
    await flushPromises();

    expect(logOutput.textContent ?? "").not.toContain("late");
  });

  it("logs a failing startup deploy-status probe without breaking the page", async () => {
    const { browser, logSection } = fixture();
    browser.net.handle("/api/deploy-status", () =>
      Promise.reject(new Error("status down"))
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(
      browser.logger.errors.some(
        (entry) => entry.message === "Radius deployment status could not load."
      )
    ).toBe(true);
    expect(logSection.style.display).not.toBe("block");
  });

  it("ignores a startup deploy-status probe that resolves after teardown", async () => {
    const { browser, logSection } = fixture();
    const probe = createDeferred<HttpResponse>();
    browser.net.handle("/api/deploy-status", () => probe.promise);
    const teardown = initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();
    teardown();

    probe.resolve(jsonResponse({ status: "failed", logTotal: 3 }));
    await flushPromises();

    expect(logSection.style.display).not.toBe("block");
  });

  it("ignores a log buffer that arrives after teardown", async () => {
    const { browser, logOutput } = fixture();
    const buffer = createDeferred<HttpResponse>();
    browser.net.handle("/api/deploy-status", () =>
      jsonResponse({ status: "in_progress", logTotal: 1 })
    );
    browser.net.handle("/api/deploy-status?since=0", () => buffer.promise);
    const teardown = initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();
    teardown();

    buffer.resolve(
      jsonResponse({ logsNew: ["late"], logTotal: 1, status: "in_progress" })
    );
    await flushPromises();

    expect(logOutput.textContent ?? "").not.toContain("late");
    expect(browser.clock.intervals).toBe(0);
  });

  it("selects the application named by the query string", async () => {
    const { browser, appSelect } = fixture({
      search: "?application=other-app"
    });
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=other-app&environment=dev",
      () => jsonResponse({ resources: [], mode: "greyed" })
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(appSelect.value).toBe("other-app");
  });

  it("shows a 'no applications' option and skips the query default when none exist", async () => {
    const { browser, appSelect } = fixture({ appListing: "empty" });
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&environment=dev",
      () => jsonResponse({ resources: [], mode: "greyed" })
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(appSelect.value).toBe("");
  });

  it("shows a load failure option when applications cannot be loaded", async () => {
    const { browser, appSelect } = fixture();
    browser.net.handle("/api/list-applications?repo=octo%2Fapp", () =>
      Promise.reject(new Error("apps down"))
    );
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&environment=dev",
      () => jsonResponse({ resources: [], mode: "greyed" })
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(appSelect.value).toBe("");
    expect(
      browser.logger.errors.some(
        (entry) => entry.message === "Radius applications could not load."
      )
    ).toBe(true);
  });

  it("does not populate applications when no select element exists", async () => {
    const { browser } = fixture({ withAppSelect: false });
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&environment=dev",
      () => jsonResponse({ resources: [], mode: "greyed" })
    );
    expect(() => {
      initializeDeployedGraphPage(browser.context, globals());
    }).not.toThrow();
    await flushPromises();
  });

  it("shows a 'no environments' option and disables the destructive action", async () => {
    const { browser, envSelect, action } = fixture({ envListing: "empty" });
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app",
      () => jsonResponse({ resources: [], mode: "greyed" })
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(envSelect.value).toBe("");
    expect(action.dataset.mode).toBe("create-env");
  });

  it("shows a load failure option when environments cannot be loaded", async () => {
    const { browser, envSelect } = fixture();
    browser.net.handle("/api/list-environments?repo=octo%2Fapp", () =>
      Promise.reject(new Error("envs down"))
    );
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app",
      () => jsonResponse({ resources: [], mode: "greyed" })
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(envSelect.value).toBe("");
    expect(
      browser.logger.errors.some(
        (entry) => entry.message === "Radius environments could not load."
      )
    ).toBe(true);
  });

  it("does not populate environments when no select element exists", async () => {
    const { browser } = fixture({ withEnvSelect: false });
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app",
      () => jsonResponse({ resources: [], mode: "greyed" })
    );
    expect(() => {
      initializeDeployedGraphPage(browser.context, globals());
    }).not.toThrow();
    await flushPromises();
  });

  it("selects the environment named by the query string", async () => {
    const { browser, envSelect } = fixture({ search: "?environment=dev" });
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => jsonResponse({ resources: [], mode: "greyed" })
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(envSelect.value).toBe("dev");
  });

  it("marks the deployment status stale when the listing errors, and polls it", async () => {
    const { browser } = fixture({ deploymentsListing: "error" });
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => jsonResponse({ resources: [], mode: "greyed" })
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(browser.clock.timeouts).toBeGreaterThan(0);
  });

  it("logs a failing deployment-state request and retries it", async () => {
    const { browser } = fixture();
    browser.net.handle("/api/list-deployments?repo=octo%2Fapp", () =>
      Promise.reject(new Error("state down"))
    );
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => jsonResponse({ resources: [], mode: "greyed" })
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(
      browser.logger.errors.some(
        (entry) => entry.message === "Radius deployment states could not load."
      )
    ).toBe(true);
    expect(browser.clock.timeouts).toBeGreaterThan(0);
  });

  it("stops polling deployment state once the poll limit is reached", async () => {
    const { browser } = fixture({
      deployments: [{ app: "app", environment: "dev", status: "pending" }]
    });
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => jsonResponse({ resources: [], mode: "greyed" })
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    for (let index = 0; index < DEPLOYED_STATE_POLL_LIMIT; index++) {
      browser.clock.tick(DEPLOYED_STATE_POLL_MS);
      await flushPromises();
    }

    expect(browser.clock.timeouts).toBe(0);
  });

  it("stops polling deployment state once the deployment leaves a transient status", async () => {
    const { browser } = fixture({
      deployments: [{ app: "app", environment: "dev", status: "pending" }]
    });
    let status = "pending";
    browser.net.handle("/api/list-deployments?repo=octo%2Fapp", () =>
      jsonResponse({
        deployments: [{ app: "app", environment: "dev", status }]
      })
    );
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => jsonResponse({ resources: [], mode: "greyed" })
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();
    expect(browser.clock.timeouts).toBe(1);

    status = "success";
    browser.clock.tick(DEPLOYED_STATE_POLL_MS);
    await flushPromises();

    expect(browser.clock.timeouts).toBe(0);
  });

  it("skips the label text when no application or environment is selected", async () => {
    const { browser, label } = fixture({ envListing: "empty" });
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app",
      () => jsonResponse({ resources: [], mode: "greyed" })
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(label.textContent).toBe("");
  });

  it("skips updating the label when no label element exists", async () => {
    const { browser } = fixture({ withLabel: false });
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => jsonResponse({ resources: [], mode: "greyed" })
    );
    expect(() => {
      initializeDeployedGraphPage(browser.context, globals());
    }).not.toThrow();
    await flushPromises();
  });

  it("deletes a deployment and navigates to the deploying page", async () => {
    const { browser, action, appSelect, envSelect, modal, modalText } =
      fixture();
    const open = vi.fn((application: string, environment: string) => {
      void application;
      void environment;
    });
    const { createDialog, confirm, wasOpened } = createConfirmingDialog();
    void open;
    browser.net.handle("/api/delete-deployment", () => jsonResponse({}));
    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusCreateDeleteDeploymentDialog: createDialog })
    );
    await flushPromises();

    appSelect.value = "app";
    envSelect.value = "dev";
    action.dispatch("click");
    expect(wasOpened()).toBe(true);
    confirm();
    expect(modal.style.display).toBe("flex");
    expect(modalText.textContent).toContain("Deleting application app");
    await flushPromises();

    expect(browser.nav.assigned).toEqual(["/?page=deploying"]);
    expect(modal.style.display).toBe("none");
  });

  // Only a server-proven stranded-resource conflict may escalate this button to
  // the forced delete, and only that delete may carry `force`.
  it("forces the delete once the server proves the stranded-resource conflict", async () => {
    const page = fixture({
      deployments: [{ app: "app", environment: "dev", status: "delete-failed" }]
    });
    const { browser, action, appSelect, envSelect, modalText } = page;
    const { createDialog, wasOpened } = createConfirmingDialog();
    let dispatched: unknown;
    browser.net.handle(
      deleteConflictUrl({
        repo: "octo/app",
        environment: "dev",
        application: "app"
      }),
      () =>
        jsonResponse({
          conflict: true,
          resourceState: "Updating",
          forced: false,
          detail: ""
        })
    );
    browser.net.handle("/api/delete-deployment", (init) => {
      dispatched = init?.body;
      return jsonResponse({});
    });
    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusCreateDeleteDeploymentDialog: createDialog })
    );
    await flushPromises();

    appSelect.value = "app";
    envSelect.value = "dev";
    action.dispatch("click");
    await flushPromises();
    // The three-step dialog stays shut; the forced question is asked by the
    // same lighter confirmation the rest of the product uses.
    expect(wasOpened()).toBe(false);
    expect(page.confirm["env-confirm-title"].textContent).toBe(
      "Force delete this deployment?"
    );
    expect(page.confirm["env-confirm-usage-label"].textContent).toContain(
      "orphaned external resources"
    );

    page.confirm["env-confirm-ok"].dispatch("click");
    expect(modalText.textContent).toContain("Force deleting application app");
    expect(modalText.textContent).toContain("orphaned external resources");
    await flushPromises();
    expect(JSON.parse(String(dispatched))).toEqual({
      repo: "octo/app",
      environment: "dev",
      application: "app",
      force: true
    });
  });

  // The redirect hands the delete to the Deployments page; a forced one has to
  // arrive there still forced, or its completion drops the orphan caution.
  it("carries the forced delete and its run into the Deployments page", async () => {
    const page = fixture({
      deployments: [{ app: "app", environment: "dev", status: "delete-failed" }]
    });
    const { browser, action, appSelect, envSelect } = page;
    const { createDialog } = createConfirmingDialog();
    browser.net.handle(
      deleteConflictUrl({
        repo: "octo/app",
        environment: "dev",
        application: "app"
      }),
      () =>
        jsonResponse({
          conflict: true,
          resourceState: "Updating",
          forced: false,
          detail: ""
        })
    );
    browser.net.handle("/api/delete-deployment", () =>
      jsonResponse({ runUrl: "https://github.com/octo/app/actions/runs/42" })
    );
    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusCreateDeleteDeploymentDialog: createDialog })
    );
    await flushPromises();

    appSelect.value = "app";
    envSelect.value = "dev";
    action.dispatch("click");
    await flushPromises();
    page.confirm["env-confirm-ok"].dispatch("click");
    await flushPromises();

    const redirect = browser.nav.assigned.find((url) =>
      url.includes("page=deploying")
    );
    expect(redirect).toContain("delete=forced");
    expect(redirect).toContain("application=app");
    expect(redirect).toContain("environment=dev");
    expect(redirect).toContain(
      `run=${encodeURIComponent("https://github.com/octo/app/actions/runs/42")}`
    );
  });

  // The probe downloads a workflow artifact server-side, so the button says it
  // is working and a second click cannot start a second probe.
  it("disables the button while probing and ignores a second click", async () => {
    const page = fixture({
      deployments: [{ app: "app", environment: "dev", status: "delete-failed" }]
    });
    const { browser, action, appSelect, envSelect } = page;
    const { createDialog } = createConfirmingDialog();
    const probe = createDeferred<HttpResponse>();
    let probes = 0;
    browser.net.handle(
      deleteConflictUrl({
        repo: "octo/app",
        environment: "dev",
        application: "app"
      }),
      () => {
        probes++;
        return probe.promise;
      }
    );
    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusCreateDeleteDeploymentDialog: createDialog })
    );
    await flushPromises();

    appSelect.value = "app";
    envSelect.value = "dev";
    action.dispatch("click");
    await flushPromises();
    expect(action.disabled).toBe(true);

    action.dispatch("click");
    await flushPromises();
    expect(probes).toBe(1);

    probe.resolve(
      jsonResponse({
        conflict: true,
        resourceState: "Updating",
        forced: true,
        detail: ""
      })
    );
    await flushPromises();
    expect(action.disabled).toBe(false);
    expect(page.confirm["env-confirm-message"].textContent).toContain(
      "previous delete was already forced"
    );
  });

  it("keeps the ordinary delete when the probe cannot prove a conflict", async () => {
    const page = fixture({
      deployments: [{ app: "app", environment: "dev", status: "delete-failed" }]
    });
    const { browser, action, appSelect, envSelect } = page;
    const { createDialog, confirm, wasOpened } = createConfirmingDialog();
    let dispatched: unknown;
    browser.net.handle(
      deleteConflictUrl({
        repo: "octo/app",
        environment: "dev",
        application: "app"
      }),
      () => jsonResponse({ conflict: false, detail: "artifact expired." })
    );
    browser.net.handle("/api/delete-deployment", (init) => {
      dispatched = init?.body;
      return jsonResponse({});
    });
    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusCreateDeleteDeploymentDialog: createDialog })
    );
    await flushPromises();

    appSelect.value = "app";
    envSelect.value = "dev";
    action.dispatch("click");
    await flushPromises();
    expect(wasOpened()).toBe(true);
    expect(page.confirm["env-confirm-modal"].style.display).toBe("none");

    confirm();
    await flushPromises();
    expect(JSON.parse(String(dispatched))).toEqual({
      repo: "octo/app",
      environment: "dev",
      application: "app",
      force: false
    });
  });

  it("dispatches nothing when the forced confirmation is cancelled", async () => {
    const page = fixture({
      deployments: [{ app: "app", environment: "dev", status: "delete-failed" }]
    });
    const { browser, action, appSelect, envSelect } = page;
    const { createDialog } = createConfirmingDialog();
    let dispatched = false;
    browser.net.handle(
      deleteConflictUrl({
        repo: "octo/app",
        environment: "dev",
        application: "app"
      }),
      () =>
        jsonResponse({
          conflict: true,
          resourceState: "Updating",
          forced: false,
          detail: ""
        })
    );
    browser.net.handle("/api/delete-deployment", () => {
      dispatched = true;
      return jsonResponse({});
    });
    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusCreateDeleteDeploymentDialog: createDialog })
    );
    await flushPromises();

    appSelect.value = "app";
    envSelect.value = "dev";
    action.dispatch("click");
    await flushPromises();
    page.confirm["env-confirm-cancel"].dispatch("click");
    await flushPromises();
    expect(dispatched).toBe(false);
    expect(page.confirm["env-confirm-modal"].style.display).toBe("none");
  });

  it("never probes for a deployment whose delete has not failed", async () => {
    const { browser, action, appSelect, envSelect } = fixture();
    const { createDialog, wasOpened } = createConfirmingDialog();
    browser.net.handle("/api/delete-deployment", () => jsonResponse({}));
    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusCreateDeleteDeploymentDialog: createDialog })
    );
    await flushPromises();

    appSelect.value = "app";
    envSelect.value = "dev";
    action.dispatch("click");

    expect(wasOpened()).toBe(true);
    expect(
      browser.net.calls.some((call) =>
        call.url.startsWith(DELETE_CONFLICT_PATH)
      )
    ).toBe(false);
  });

  it("does not open the dialog when the page is torn down mid-probe", async () => {
    const { browser, action, appSelect, envSelect } = fixture({
      deployments: [{ app: "app", environment: "dev", status: "delete-failed" }]
    });
    const { createDialog, wasOpened } = createConfirmingDialog();
    browser.net.handle(
      deleteConflictUrl({
        repo: "octo/app",
        environment: "dev",
        application: "app"
      }),
      () =>
        jsonResponse({
          conflict: true,
          resourceState: "Updating",
          forced: false,
          detail: ""
        })
    );
    const teardown = initializeDeployedGraphPage(
      browser.context,
      globals({ radiusCreateDeleteDeploymentDialog: createDialog })
    );
    await flushPromises();

    appSelect.value = "app";
    envSelect.value = "dev";
    action.dispatch("click");
    teardown();
    await flushPromises();

    expect(wasOpened()).toBe(false);
  });

  it("keeps cloud teardown available after a failed redeploy", async () => {
    const { browser, action, stopTrackingAction, appSelect, envSelect } =
      fixture({
        deployments: [{ app: "app", environment: "dev", status: "failed" }]
      });
    const { createDialog, confirm, wasOpened } = createConfirmingDialog();
    browser.net.handle("/api/delete-deployment", () => jsonResponse({}));
    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusCreateDeleteDeploymentDialog: createDialog })
    );
    await flushPromises();

    expect(action.textContent).toBe("Delete Deployment");
    expect(stopTrackingAction.style.display).toBe("none");
    stopTrackingAction.dispatch("click");
    expect(wasOpened()).toBe(false);
    appSelect.value = "app";
    envSelect.value = "dev";
    action.dispatch("click");
    confirm();
    await flushPromises();

    expect(
      browser.net.calls.some((call) => call.url === "/api/delete-deployment")
    ).toBe(true);
    expect(browser.nav.assigned).toEqual(["/?page=deploying"]);
  });

  it("offers stop tracking only after a failed teardown and sends its identity", async () => {
    const {
      browser,
      action,
      stopTrackingAction,
      appSelect,
      envSelect,
      inlineStatus
    } = fixture({
      deployments: [{ app: "app", environment: "dev", status: "delete-failed" }]
    });
    const { createDialog, confirm, wasOpened } = createConfirmingDialog();
    browser.net.handle("/api/abandon-deployment", () =>
      jsonResponse({ outcome: "abandoned" })
    );
    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusCreateDeleteDeploymentDialog: createDialog })
    );
    await flushPromises();

    expect(action.dataset.mode).toBe("delete");
    expect(action.textContent).toBe("Retry Delete");
    expect(stopTrackingAction.textContent).toBe("Stop tracking deployment");
    expect(stopTrackingAction.style.display).toBe("");
    expect(createDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "abandon",
        modalId: "deploy-abandon-modal"
      })
    );
    appSelect.value = "app";
    envSelect.value = "dev";
    stopTrackingAction.dispatch("click");
    expect(wasOpened()).toBe(true);
    confirm();
    expect(stopTrackingAction.textContent).toBe("Stopping tracking…");
    await flushPromises();

    const request = browser.net.calls.find(
      (call) => call.url === "/api/abandon-deployment"
    );
    expect(request?.init).toEqual({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Radius-Mutation-Nonce": "nonce-1"
      },
      body: JSON.stringify({
        repo: "octo/app",
        environment: "dev",
        application: "app"
      })
    });
    expect(inlineStatus.textContent).toContain(
      "Cloud resources were not deleted"
    );
    expect(inlineStatus.textContent).toContain("may still exist");
    expect(action.dataset.mode).toBe("deploy");
    expect(browser.nav.assigned).toEqual([]);
  });

  it("surfaces a stop-tracking refusal from the server", async () => {
    const { browser, action, stopTrackingAction, inlineStatus } = fixture({
      deployments: [{ app: "app", environment: "dev", status: "delete-failed" }]
    });
    const { createDialog, confirm } = createConfirmingDialog();
    browser.net.handle("/api/abandon-deployment", () =>
      jsonResponse({ error: "not failed" }, false, 409)
    );
    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusCreateDeleteDeploymentDialog: createDialog })
    );
    await flushPromises();

    stopTrackingAction.dispatch("click");
    confirm();
    await flushPromises();

    expect(inlineStatus.textContent).toBe("not failed");
    expect(action.dataset.mode).toBe("delete");
    expect(stopTrackingAction.disabled).toBe(false);
  });

  it("uses a generic abandonment refusal when the server omits an error", async () => {
    const { browser, stopTrackingAction, inlineStatus } = fixture({
      deployments: [{ app: "app", environment: "dev", status: "delete-failed" }]
    });
    const { createDialog, confirm } = createConfirmingDialog();
    browser.net.handle("/api/abandon-deployment", () =>
      jsonResponse({}, false, 500)
    );
    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusCreateDeleteDeploymentDialog: createDialog })
    );
    await flushPromises();

    stopTrackingAction.dispatch("click");
    confirm();
    await flushPromises();

    expect(inlineStatus.textContent).toBe(
      "Could not stop tracking the deployment."
    );
  });

  it("turns a stale mutation nonce refusal into a reload instruction", async () => {
    const { browser, action, stopTrackingAction, inlineStatus } = fixture({
      deployments: [{ app: "app", environment: "dev", status: "delete-failed" }]
    });
    const { createDialog, confirm } = createConfirmingDialog();
    browser.net.handle("/api/abandon-deployment", () =>
      jsonResponse(
        { error: "This browser mutation request is not trusted." },
        false,
        403
      )
    );
    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusCreateDeleteDeploymentDialog: createDialog })
    );
    await flushPromises();

    stopTrackingAction.dispatch("click");
    confirm();
    await flushPromises();

    expect(inlineStatus.textContent).toBe(
      "This Radius Canvas page is out of date. Reload it and try again."
    );
    expect(action.dataset.mode).toBe("delete");
    expect(stopTrackingAction.disabled).toBe(false);
  });

  it("surfaces a transport-safe abandonment failure and restores the action", async () => {
    const { browser, action, stopTrackingAction, inlineStatus } = fixture({
      deployments: [{ app: "app", environment: "dev", status: "delete-failed" }]
    });
    const { createDialog, confirm } = createConfirmingDialog();
    browser.net.handle("/api/abandon-deployment", () =>
      Promise.reject(new Error("secret-shaped detail"))
    );
    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusCreateDeleteDeploymentDialog: createDialog })
    );
    await flushPromises();

    stopTrackingAction.dispatch("click");
    confirm();
    await flushPromises();

    expect(inlineStatus.textContent).toBe(
      "Could not stop tracking the deployment. Please try again."
    );
    expect(inlineStatus.textContent).not.toContain("secret-shaped");
    expect(action.dataset.mode).toBe("delete");
    expect(stopTrackingAction.disabled).toBe(false);
    expect(browser.logger.errors).toHaveLength(1);
  });

  it.each(["success", "failure"] as const)(
    "ignores a stale abandonment %s after teardown",
    async (outcome) => {
      const { browser, stopTrackingAction, inlineStatus } = fixture({
        deployments: [
          { app: "app", environment: "dev", status: "delete-failed" }
        ]
      });
      const { createDialog, confirm } = createConfirmingDialog();
      const request = createDeferred<HttpResponse>();
      browser.net.handle("/api/abandon-deployment", () => request.promise);
      const teardown = initializeDeployedGraphPage(
        browser.context,
        globals({ radiusCreateDeleteDeploymentDialog: createDialog })
      );
      await flushPromises();

      stopTrackingAction.dispatch("click");
      confirm();
      teardown();
      if (outcome === "success") {
        request.resolve(jsonResponse({ outcome: "abandoned" }));
      } else {
        request.reject(new Error("stale"));
      }
      await flushPromises();

      expect(inlineStatus.textContent).toBe("");
      expect(browser.logger.errors).toHaveLength(0);
    }
  );

  it("surfaces a delete failure returned by the server", async () => {
    const { browser, action, appSelect, envSelect, inlineStatus } = fixture();
    const { createDialog, confirm } = createConfirmingDialog();
    browser.net.handle("/api/delete-deployment", () =>
      jsonResponse({ error: "in use" }, false, 400)
    );
    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusCreateDeleteDeploymentDialog: createDialog })
    );
    await flushPromises();

    appSelect.value = "app";
    envSelect.value = "dev";
    action.dispatch("click");
    confirm();
    await flushPromises();

    expect(inlineStatus.textContent).toBe("in use");
    expect(browser.nav.assigned).toEqual([]);
  });

  it("surfaces a generic delete failure message when the server gives none", async () => {
    const { browser, action, appSelect, envSelect, inlineStatus } = fixture();
    const { createDialog, confirm } = createConfirmingDialog();
    browser.net.handle("/api/delete-deployment", () =>
      jsonResponse({}, false, 500)
    );
    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusCreateDeleteDeploymentDialog: createDialog })
    );
    await flushPromises();

    appSelect.value = "app";
    envSelect.value = "dev";
    action.dispatch("click");
    confirm();
    await flushPromises();

    expect(inlineStatus.textContent).toBe(
      "Could not start the delete workflow."
    );
  });

  it("keeps external delete failure detail out of user-visible failures", async () => {
    const { browser, action, appSelect, envSelect, inlineStatus } = fixture();
    const { createDialog, confirm } = createConfirmingDialog();
    browser.net.handle("/api/delete-deployment", () =>
      Promise.reject(new Error("secret-shaped delete detail"))
    );
    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusCreateDeleteDeploymentDialog: createDialog })
    );
    await flushPromises();

    appSelect.value = "app";
    envSelect.value = "dev";
    action.dispatch("click");
    confirm();
    await flushPromises();

    expect(inlineStatus.textContent).toBe(
      "Could not delete the deployment. Please try again."
    );
    expect(inlineStatus.textContent).not.toContain("secret-shaped");
    expect(browser.logger.errors.length).toBeGreaterThan(0);
  });

  it("ignores a stale delete outcome after teardown", async () => {
    const { browser, action, appSelect, envSelect } = fixture();
    const { createDialog, confirm } = createConfirmingDialog();
    const deletePromise = createDeferred<HttpResponse>();
    browser.net.handle("/api/delete-deployment", () => deletePromise.promise);
    const teardown = initializeDeployedGraphPage(
      browser.context,
      globals({ radiusCreateDeleteDeploymentDialog: createDialog })
    );
    await flushPromises();

    appSelect.value = "app";
    envSelect.value = "dev";
    action.dispatch("click");
    confirm();
    teardown();
    deletePromise.resolve(jsonResponse({}));
    await flushPromises();

    expect(browser.nav.assigned).toEqual([]);
  });

  it("ignores a stale delete failure after teardown", async () => {
    const { browser, action, appSelect, envSelect } = fixture();
    const { createDialog, confirm } = createConfirmingDialog();
    const deletePromise = createDeferred<HttpResponse>();
    browser.net.handle("/api/delete-deployment", () => deletePromise.promise);
    const teardown = initializeDeployedGraphPage(
      browser.context,
      globals({ radiusCreateDeleteDeploymentDialog: createDialog })
    );
    await flushPromises();

    appSelect.value = "app";
    envSelect.value = "dev";
    action.dispatch("click");
    confirm();
    teardown();
    deletePromise.reject(new Error("stale delete failure"));
    await flushPromises();

    expect(browser.logger.errors).toHaveLength(0);
  });

  it("skips the deleting modal text and display toggle when absent", async () => {
    const { browser, action, appSelect, envSelect } = fixture({
      withModal: false,
      withModalText: false
    });
    const { createDialog, confirm } = createConfirmingDialog();
    browser.net.handle("/api/delete-deployment", () => jsonResponse({}));
    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusCreateDeleteDeploymentDialog: createDialog })
    );
    await flushPromises();

    appSelect.value = "app";
    envSelect.value = "dev";
    action.dispatch("click");
    expect(() => confirm()).not.toThrow();
    await flushPromises();

    expect(browser.nav.assigned).toEqual(["/?page=deploying"]);
  });

  it("skips inline status when it has no element to update", async () => {
    const { browser, action, appSelect, envSelect } = fixture({
      withInlineStatus: false
    });
    const { createDialog, confirm } = createConfirmingDialog();
    browser.net.handle("/api/delete-deployment", () =>
      jsonResponse({ error: "in use" }, false, 400)
    );
    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusCreateDeleteDeploymentDialog: createDialog })
    );
    await flushPromises();

    appSelect.value = "app";
    envSelect.value = "dev";
    action.dispatch("click");
    expect(() => confirm()).not.toThrow();
    await flushPromises();
  });

  it("skips the automatic follow-up once the page has been torn down", async () => {
    const { browser } = fixture();
    const deferredApps = createDeferred<HttpResponse>();
    browser.net.handle(
      "/api/list-applications?repo=octo%2Fapp",
      () => deferredApps.promise
    );
    const teardown = initializeDeployedGraphPage(browser.context, globals());
    teardown();

    deferredApps.resolve(jsonResponse({ applications: [{ name: "app" }] }));
    await flushPromises();

    expect(browser.clock.pending).toBe(0);
  });

  it("tears down pending work, aborting an in-flight graph request", async () => {
    const { browser } = fixture();
    const graph = createDeferred<HttpResponse>();
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => graph.promise
    );
    const teardown = initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();
    expect(browser.net.aborted).toBe(0);

    teardown();
    expect(browser.net.aborted).toBe(1);
    expect(browser.clock.pending).toBe(0);

    graph.resolve(
      jsonResponse({ resources: [{ id: "app/web" }], mode: "live" })
    );
    await flushPromises();
    expect(browser.clock.pending).toBe(0);
  });

  it("parses the query string without a leading '?' and skips a bare key with no value", async () => {
    const { browser, appSelect } = fixture({
      search: "flag&application=other-app"
    });
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=other-app&environment=dev",
      () => jsonResponse({ resources: [], mode: "greyed" })
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(appSelect.value).toBe("other-app");
  });

  it("treats a matching query key with no '=' as an empty value", async () => {
    const { browser, appSelect } = fixture({ search: "application" });
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&environment=dev",
      () => jsonResponse({ resources: [], mode: "greyed" })
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    // No "=" means no requested application, so the first listed option
    // remains selected rather than an empty query value overriding it.
    expect(appSelect.value).toBe("app");
  });

  it("falls back to 'unknown' when a deployment listing omits a status", async () => {
    const { browser, action } = fixture({
      deployments: [{ app: "app", environment: "dev", status: "" }]
    });
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    // "unknown" is neither pending, deleting nor a recognized transient
    // state, so the destructive action is enabled rather than left stuck.
    expect(action.disabled).toBe(false);
  });

  it("fails deployment actions closed when the environment listing reports an error", async () => {
    const { browser, envSelect, action } = fixture({ envListing: "error" });
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app",
      () => jsonResponse({ resources: [], mode: "greyed" })
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(envSelect.innerHTML).toContain("Could not load");
    expect(action.dataset.mode).toBe("deploy");
    expect(action.disabled).toBe(true);
    expect(action.getAttribute("title")).toContain(
      "Environments could not be loaded"
    );
    expect(browser.logger.errors).toHaveLength(1);
  });

  it("cancels an in-flight state poll once the selection is no longer pending", async () => {
    const { browser, appSelect } = fixture({
      deployments: [
        { app: "app", environment: "dev", status: "pending" },
        { app: "other-app", environment: "dev", status: "success" }
      ]
    });
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=other-app&environment=dev",
      () => jsonResponse({ resources: [], mode: "greyed" })
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();
    expect(browser.clock.timeouts).toBe(1);

    appSelect.value = "other-app";
    appSelect.dispatch("change");

    expect(browser.clock.timeouts).toBe(0);
  });

  it("shows nothing without throwing when no status or container element exists", async () => {
    const { browser } = fixture({
      repo: "",
      withStatus: false,
      withContainer: false
    });
    expect(() => {
      initializeDeployedGraphPage(browser.context, globals());
    }).not.toThrow();
    await flushPromises();
  });

  it("describes deployment age in whole hours", async () => {
    const { browser, note } = fixture();
    browser.clock.tick(10_000_000);
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () =>
        jsonResponse({
          resources: [{ id: "app/web" }],
          mode: "terminal",
          updatedAt: new Date(browser.clock.now() - 2 * 3_600_000).toISOString()
        })
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(note.textContent).toContain("2h ago");
  });

  it("loads a graph successfully without a status element present", async () => {
    const { browser } = fixture({ withStatus: false });
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => jsonResponse({ resources: [{ id: "app/web" }], mode: "terminal" })
    );
    expect(() => {
      initializeDeployedGraphPage(browser.context, globals());
    }).not.toThrow();
    await flushPromises();
  });

  it("omits the abort signal when the network port cannot create one", async () => {
    const { browser } = fixture();
    browser.net.supportsAbort = false;
    let sawSignal = true;
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      (init) => {
        sawSignal = init?.signal !== undefined;
        return jsonResponse({ resources: [], mode: "greyed" });
      }
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(sawSignal).toBe(false);
  });

  it("falls back to 'greyed' when the graph response omits a mode", async () => {
    const { browser, note } = fixture();
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => jsonResponse({ resources: [{ id: "app/web" }] })
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(note.textContent).toBe(
      "Not deployed yet — showing the modeled application."
    );
  });

  it("ignores a log rejection after teardown without logging or throwing", async () => {
    const { browser } = fixture();
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => jsonResponse({ resources: [{ id: "app/web" }], mode: "live" })
    );
    const poll = createDeferred<HttpResponse>();
    browser.net.handle("/api/deploy-status?since=0", () => poll.promise);
    const teardown = initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    teardown();
    poll.reject(new Error("late failure"));
    await flushPromises();

    expect(browser.logger.errors).toHaveLength(0);
  });

  it("treats a null log output textContent as empty when appending", async () => {
    const { browser, logOutput } = fixture();
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => jsonResponse({ resources: [{ id: "app/web" }], mode: "live" })
    );
    logOutput.textContent = null;
    browser.net.handle("/api/deploy-status?since=0", () =>
      jsonResponse({
        logsNew: ["first line"],
        logTotal: 1,
        status: "in_progress"
      })
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    expect(logOutput.textContent).toBe("first line\n");
  });

  it("keeps the prior log total when a response omits it", async () => {
    const { browser } = fixture();
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
      () => jsonResponse({ resources: [{ id: "app/web" }], mode: "live" })
    );
    browser.net.handle("/api/deploy-status?since=0", () =>
      jsonResponse({ logsNew: [], status: "in_progress" })
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();

    browser.clock.tick(DEPLOYED_LOG_POLL_MS);
    await flushPromises();

    expect(
      browser.net.calls.some(
        (call) => call.url === "/api/deploy-status?since=0"
      )
    ).toBe(true);
  });

  it("shows a load-failure option without throwing when applications fail to load and no select exists", async () => {
    const { browser } = fixture({ withAppSelect: false });
    browser.net.handle("/api/list-applications?repo=octo%2Fapp", () =>
      Promise.reject(new Error("apps down"))
    );
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&environment=dev",
      () => jsonResponse({ resources: [], mode: "greyed" })
    );
    expect(() => {
      initializeDeployedGraphPage(browser.context, globals());
    }).not.toThrow();
    await flushPromises();
  });

  it("shows a load-failure option without throwing when environments fail to load and no select exists", async () => {
    const { browser } = fixture({ withEnvSelect: false });
    browser.net.handle("/api/list-environments?repo=octo%2Fapp", () =>
      Promise.reject(new Error("envs down"))
    );
    browser.net.handle(
      "/api/deployed-graph?repo=octo%2Fapp&application=app",
      () => jsonResponse({ resources: [], mode: "greyed" })
    );
    expect(() => {
      initializeDeployedGraphPage(browser.context, globals());
    }).not.toThrow();
    await flushPromises();
  });

  it("hides a delete-failure without a modal element to update", async () => {
    const { browser, action, appSelect, envSelect } = fixture({
      withModal: false
    });
    const { createDialog, confirm } = createConfirmingDialog();
    browser.net.handle("/api/delete-deployment", () =>
      Promise.reject(new Error("network down"))
    );
    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusCreateDeleteDeploymentDialog: createDialog })
    );
    await flushPromises();

    appSelect.value = "app";
    envSelect.value = "dev";
    action.dispatch("click");
    expect(() => confirm()).not.toThrow();
    await flushPromises();
  });

  it("does not reload the graph on a second visible transition while already live", async () => {
    const { browser } = fixture();
    const url =
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev";
    browser.net.handle(url, () =>
      jsonResponse({ resources: [{ id: "app/web" }], mode: "live" })
    );
    browser.net.handle("/api/deploy-status?since=0", () =>
      jsonResponse({ logsNew: [], logTotal: 0, status: "in_progress" })
    );
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();
    const before = browser.net.calls.filter((call) => call.url === url).length;

    browser.document.visibilityState = "hidden";
    browser.document.dispatch("visibilitychange");
    browser.document.visibilityState = "visible";
    browser.document.dispatch("visibilitychange");
    await flushPromises();
    // A second "visible" transition without going hidden again must not
    // trigger another immediate load: the graph poll timer is already set.
    browser.document.dispatch("visibilitychange");
    await flushPromises();

    expect(browser.net.calls.filter((call) => call.url === url).length).toBe(
      before + 1
    );
  });

  it("keeps the rendered graph visible while a live refresh is in flight", async () => {
    const { browser, status } = fixture();
    const controller = {
      update: vi.fn(function () {
        return controller;
      }),
      destroy: vi.fn()
    };
    const url =
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev";
    const refresh = createDeferred<HttpResponse>();
    let calls = 0;
    browser.net.handle(url, () => {
      calls++;
      return calls === 1 ?
          jsonResponse({ resources: [{ id: "app/web" }], mode: "live" })
        : refresh.promise;
    });
    browser.net.handle("/api/deploy-status?since=0", () =>
      jsonResponse({ logsNew: [], logTotal: 0, status: "in_progress" })
    );
    initializeDeployedGraphPage(
      browser.context,
      globals({ radiusRenderGraph: () => controller })
    );
    await flushPromises();
    expect(status.style.display).toBe("none");

    browser.clock.tick(DEPLOYED_GRAPH_POLL_MS);
    await flushPromises();
    expect(status.style.display).toBe("none");
    refresh.resolve(
      jsonResponse({ resources: [{ id: "app/web" }], mode: "terminal" })
    );
    await flushPromises();
  });

  it("renders an empty-state child without styling the graph container", async () => {
    const { browser, container } = fixture();
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();
    expect(container.className).toBe("");
    expect(container.appended[0]?.className).toBe("status info");
    expect(container.appended[0]?.textContent).toBe("Nothing deployed yet");
  });

  it("ignores a deployment-state poll that resolves after teardown", async () => {
    const { browser } = fixture({
      deployments: [{ app: "app", environment: "dev", status: "pending" }]
    });
    const statePoll = createDeferred<HttpResponse>();
    let calls = 0;
    browser.net.handle("/api/list-deployments?repo=octo%2Fapp", () => {
      calls++;
      return calls === 1 ?
          jsonResponse({
            deployments: [{ app: "app", environment: "dev", status: "pending" }]
          })
        : statePoll.promise;
    });
    const teardown = initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();
    browser.clock.tick(DEPLOYED_STATE_POLL_MS);
    await flushPromises();
    teardown();

    statePoll.resolve(jsonResponse({ deployments: [] }));
    await flushPromises();
    expect(browser.clock.pending).toBe(0);
  });

  it("ignores an in-flight initial load aborted while hidden and resumes on visible", async () => {
    const { browser, status } = fixture();
    const url =
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev";
    browser.net.handle(url, () => new Promise(() => {}));
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();
    const before = browser.net.calls.filter((call) => call.url === url).length;

    browser.document.visibilityState = "hidden";
    browser.document.dispatch("visibilitychange");
    await flushPromises();
    expect(status.className).not.toBe("status error");
    expect(browser.clock.timeouts).toBe(0);

    browser.net.handle(url, () =>
      jsonResponse({ resources: [], mode: "greyed" })
    );
    browser.document.visibilityState = "visible";
    browser.document.dispatch("visibilitychange");
    await flushPromises();
    expect(browser.net.calls.filter((call) => call.url === url).length).toBe(
      before + 1
    );
  });

  it("resumes an in-flight initial load without AbortController support", async () => {
    const { browser } = fixture();
    browser.net.supportsAbort = false;
    const url =
      "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev";
    browser.net.handle(url, () => new Promise(() => {}));
    initializeDeployedGraphPage(browser.context, globals());
    await flushPromises();
    const before = browser.net.calls.filter((call) => call.url === url).length;
    browser.document.visibilityState = "hidden";
    browser.document.dispatch("visibilitychange");
    browser.net.handle(url, () =>
      jsonResponse({ resources: [], mode: "greyed" })
    );
    browser.document.visibilityState = "visible";
    browser.document.dispatch("visibilitychange");
    await flushPromises();
    expect(browser.net.calls.filter((call) => call.url === url).length).toBe(
      before + 1
    );
  });
  describe("graph build progress", () => {
    const stageText = graphProgressStages;

    it("shows the loading stage while the first request is in flight", async () => {
      const { browser, progressHost } = fixture();
      browser.net.handle(
        "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
        () => createDeferred<HttpResponse>().promise
      );
      initializeDeployedGraphPage(browser.context, globals());
      await flushPromises();

      expect(stageText(progressHost)).toEqual([
        `${GRAPH_STAGE_LABELS.loading_deployment}:running`
      ]);
      expect(graphProgressElapsed(progressHost)).toMatch(/^\d+:\d{2}$/);
      expect(fakeText(progressHost)).not.toMatch(/%/);
    });

    it("clears the panel once the deployed graph arrives", async () => {
      const { browser, progressHost } = fixture();
      browser.net.handle(
        "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
        () => jsonResponse({ resources: [{ id: "app/web" }], mode: "greyed" })
      );
      initializeDeployedGraphPage(browser.context, globals());
      await flushPromises();

      expect(stageText(progressHost)).toEqual([]);
      expect(fakeText(progressHost)).toBe("");
    });

    it("reports the failure once in the status banner, clearing the panel", async () => {
      const { browser, progressHost, status } = fixture();
      browser.net.handle(
        "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
        () => Promise.reject(new Error("graph service down"))
      );
      initializeDeployedGraphPage(browser.context, globals());
      await flushPromises();

      expect(status.textContent).toBe(
        "The deployed application graph could not be loaded."
      );
      expect(stageText(progressHost)).toEqual([]);
    });

    it("states the failure on the panel when there is no status banner", async () => {
      const { browser, progressHost } = fixture({ withStatus: false });
      browser.net.handle(
        "/api/deployed-graph?repo=octo%2Fapp&application=app&environment=dev",
        () => Promise.reject(new Error("graph service down"))
      );
      initializeDeployedGraphPage(browser.context, globals());
      await flushPromises();

      // The panel is the only surface left, so it carries the failure rather
      // than being cleared and leaving the outcome unreported.
      expect(stageText(progressHost)).toEqual([
        `${GRAPH_STAGE_LABELS.loading_deployment}:failed`
      ]);
      expect(fakeText(progressHost)).not.toContain("graph service down");
    });
  });
});
