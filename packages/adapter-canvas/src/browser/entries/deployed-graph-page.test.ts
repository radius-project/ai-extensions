import { describe, expect, it, vi } from "vitest";
import {
  createFakeBrowserScope,
  createFakeElement,
  createFakeInput,
  createFakeSelect,
  flushPromises,
  jsonResponse
} from "../../../test/support/browser/fakes.js";
import { PAGE_REGISTRY_GLOBAL } from "../globals.js";
import { resolvePageRegistry } from "../registry.js";
import { DEPLOYED_GRAPH_STATE_ID } from "../pages/deployed-graph-page.js";
import { installDeployedGraphPageEntry } from "./deployed-graph-page.js";

describe("deployed graph page browser entry", () => {
  it("installs through the shared page registry, binds only once and tears down", async () => {
    const browser = createFakeBrowserScope();
    const state = createFakeElement(DEPLOYED_GRAPH_STATE_ID);
    state.textContent = JSON.stringify({
      repo: "octo/app",
      branch: "feature",
      graphBranch: "feature",
      provider: "azure"
    });
    const appSelect = createFakeSelect("deployed-app-select");
    for (const element of [
      state,
      appSelect,
      createFakeSelect("deployed-env-select"),
      createFakeInput("deployed-delete-btn"),
      createFakeElement("deployed-status"),
      createFakeElement("deployed-graph-label"),
      createFakeElement("deployed-mode-note"),
      createFakeElement("deployed-inline-status"),
      createFakeElement("deployed-log-section"),
      createFakeElement("deployed-log-output"),
      createFakeElement("graph-container")
    ]) {
      browser.document.add(element);
    }
    browser.net.handle("/api/list-applications?repo=octo%2Fapp", () =>
      jsonResponse({ applications: [] })
    );
    browser.net.handle("/api/list-environments?repo=octo%2Fapp", () =>
      jsonResponse({ environments: [] })
    );
    browser.net.handle("/api/list-deployments?repo=octo%2Fapp", () =>
      jsonResponse({ deployments: [] })
    );
    browser.net.handle("/api/deployed-graph?repo=octo%2Fapp", () =>
      jsonResponse({ resources: [], mode: "greyed" })
    );
    browser.scope.radiusRenderGraph = vi.fn();

    installDeployedGraphPageEntry(browser.scope);
    installDeployedGraphPageEntry(browser.scope);
    await flushPromises();

    expect(browser.scope[PAGE_REGISTRY_GLOBAL]).toBe(
      resolvePageRegistry(browser.scope)
    );
    expect(appSelect.listenerCount("change")).toBe(1);

    resolvePageRegistry(browser.scope).teardownAll();
    expect(appSelect.listenerCount()).toBe(0);
  });

  it("does nothing when the page state element is absent", () => {
    const browser = createFakeBrowserScope();
    browser.scope.radiusRenderGraph = vi.fn();

    expect(() => installDeployedGraphPageEntry(browser.scope)).not.toThrow();
    expect(browser.scope[PAGE_REGISTRY_GLOBAL]).toBe(
      resolvePageRegistry(browser.scope)
    );
  });
});
