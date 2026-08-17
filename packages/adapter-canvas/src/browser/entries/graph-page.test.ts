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
import { GRAPH_PAGE_STATE_ID } from "../pages/graph-page.js";
import { installGraphPageEntry } from "./graph-page.js";

describe("graph page browser entry", () => {
  it("installs through the shared page registry, binds only once and tears down", async () => {
    const browser = createFakeBrowserScope();
    const state = createFakeElement(GRAPH_PAGE_STATE_ID);
    state.textContent = JSON.stringify({
      repo: "octo/app",
      branch: "feature",
      resources: [],
      loaded: false,
      localSource: false
    });
    const branch = createFakeSelect("graph-branch");
    branch.value = "feature";
    const button = createFakeInput("deploy-app-btn");
    for (const element of [
      state,
      createFakeSelect("graph-app"),
      branch,
      button,
      createFakeElement("graph-container"),
      createFakeElement("graph-container-wrapper"),
      createFakeElement("graph-status")
    ]) {
      browser.document.add(element);
    }
    browser.net.handle("/api/list-applications?repo=octo%2Fapp", () =>
      jsonResponse({ applications: [] })
    );
    browser.net.handle("/api/discover-branches", () =>
      jsonResponse({ branches: [], workspaceBranch: "" })
    );
    browser.net.handle("/api/list-environments?repo=octo%2Fapp", () =>
      jsonResponse({ environments: [] })
    );
    browser.net.handle("/api/load-graph", () => jsonResponse({}));
    browser.scope.radiusRenderGraph = vi.fn();
    browser.scope.radiusSetGraphLoading = vi.fn();
    browser.scope.radiusSetGraphError = vi.fn();

    installGraphPageEntry(browser.scope);
    installGraphPageEntry(browser.scope);
    await flushPromises();

    expect(browser.scope[PAGE_REGISTRY_GLOBAL]).toBe(
      resolvePageRegistry(browser.scope)
    );
    expect(branch.listenerCount("change")).toBe(1);

    resolvePageRegistry(browser.scope).teardownAll();
    expect(branch.listenerCount()).toBe(0);
  });

  it("does nothing when the page state element is absent", () => {
    const browser = createFakeBrowserScope();
    browser.scope.radiusRenderGraph = vi.fn();
    browser.scope.radiusSetGraphLoading = vi.fn();
    browser.scope.radiusSetGraphError = vi.fn();

    expect(() => installGraphPageEntry(browser.scope)).not.toThrow();
    expect(browser.scope[PAGE_REGISTRY_GLOBAL]).toBe(
      resolvePageRegistry(browser.scope)
    );
  });
});
