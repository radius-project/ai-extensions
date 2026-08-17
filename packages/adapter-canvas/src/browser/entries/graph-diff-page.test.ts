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
import { GRAPH_DIFF_STATE_ID } from "../pages/graph-diff-page.js";
import { installGraphDiffPageEntry } from "./graph-diff-page.js";

describe("graph diff page browser entry", () => {
  it("installs through the shared page registry, binds only once and tears down", async () => {
    const browser = createFakeBrowserScope();
    const state = createFakeElement(GRAPH_DIFF_STATE_ID);
    state.textContent = JSON.stringify({
      repo: "octo/app",
      base: "main",
      head: "feature",
      resources: []
    });
    const head = createFakeSelect("head-branch");
    head.value = "feature";
    for (const element of [
      state,
      createFakeInput("diff-repo-select", "octo/app"),
      createFakeSelect("diff-app"),
      createFakeSelect("base-branch"),
      head,
      createFakeElement("diff-status")
    ]) {
      browser.document.add(element);
    }
    browser.net.handle("/api/list-applications?repo=octo%2Fapp", () =>
      jsonResponse({ applications: [] })
    );
    browser.net.handle("/api/discover-branches", () =>
      jsonResponse({ branches: [], workspaceBranch: "" })
    );
    browser.scope.radiusRenderGraph = vi.fn();

    installGraphDiffPageEntry(browser.scope);
    installGraphDiffPageEntry(browser.scope);
    await flushPromises();

    expect(browser.scope[PAGE_REGISTRY_GLOBAL]).toBe(
      resolvePageRegistry(browser.scope)
    );
    expect(head.listenerCount("change")).toBe(1);

    resolvePageRegistry(browser.scope).teardownAll();
    expect(head.listenerCount()).toBe(0);
  });

  it("does nothing when the page state element is absent", () => {
    const browser = createFakeBrowserScope();
    browser.scope.radiusRenderGraph = vi.fn();

    expect(() => installGraphDiffPageEntry(browser.scope)).not.toThrow();
    expect(browser.scope[PAGE_REGISTRY_GLOBAL]).toBe(
      resolvePageRegistry(browser.scope)
    );
  });
});
