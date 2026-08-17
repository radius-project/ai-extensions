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
import { PLANNED_GRAPH_STATE_ID } from "../pages/planned-graph-page.js";
import { installPlannedGraphPageEntry } from "./planned-graph-page.js";

describe("planned graph page browser entry", () => {
  it("installs through the shared page registry, binds only once and tears down", async () => {
    const browser = createFakeBrowserScope();
    const state = createFakeElement(PLANNED_GRAPH_STATE_ID);
    state.textContent = JSON.stringify({
      repo: "octo/app",
      branch: "feature",
      environment: "dev",
      provider: "azure",
      resources: [],
      localSource: false
    });
    const branch = createFakeSelect("planned-branch");
    for (const element of [
      state,
      createFakeSelect("planned-app"),
      branch,
      createFakeSelect("planned-env"),
      createFakeInput("plan-btn"),
      createFakeElement("plan-status"),
      createFakeElement("graph-container")
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
    browser.scope.radiusRenderGraph = vi.fn();
    browser.scope.radiusSetGraphLoading = vi.fn();

    installPlannedGraphPageEntry(browser.scope);
    installPlannedGraphPageEntry(browser.scope);
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

    expect(() => installPlannedGraphPageEntry(browser.scope)).not.toThrow();
    expect(browser.scope[PAGE_REGISTRY_GLOBAL]).toBe(
      resolvePageRegistry(browser.scope)
    );
  });
});
