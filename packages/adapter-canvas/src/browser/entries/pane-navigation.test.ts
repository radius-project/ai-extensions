import { describe, expect, it } from "vitest";
import { PAGE_REGISTRY_GLOBAL } from "../globals.js";
import { resolvePageRegistry } from "../registry.js";
import { installPaneNavigationEntry } from "./pane-navigation.js";
import { createFakeBrowserScope } from "../../../test/support/browser/fakes.js";

describe("pane navigation browser entry", () => {
  it("installs through the shared page registry and binds only once", () => {
    const browser = createFakeBrowserScope();

    installPaneNavigationEntry(browser.scope);
    installPaneNavigationEntry(browser.scope);

    expect(browser.scope[PAGE_REGISTRY_GLOBAL]).toBe(
      resolvePageRegistry(browser.scope)
    );
    expect(browser.document.listenerCount("click")).toBe(1);
    expect(browser.page.listenerCount("popstate")).toBe(1);

    resolvePageRegistry(browser.scope).teardownAll();
    expect(browser.document.listenerCount()).toBe(0);
    expect(browser.page.listenerCount()).toBe(0);
  });
});
