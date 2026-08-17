import { describe, expect, it } from "vitest";
import {
  createFakeBrowserScope,
  createFakeElement,
  createFakeInput
} from "../../../test/support/browser/fakes.js";
import { PAGE_REGISTRY_GLOBAL } from "../globals.js";
import { resolvePageRegistry } from "../registry.js";
import { installOidcPageEntry } from "./oidc-page.js";

describe("OIDC page browser entry", () => {
  it("installs through the shared registry, binds once, and tears down", () => {
    const browser = createFakeBrowserScope();
    const azureTab = createFakeElement("tab-azure");
    for (const element of [
      azureTab,
      createFakeElement("tab-aws"),
      createFakeElement("panel-azure"),
      createFakeElement("panel-aws"),
      createFakeInput("btn-azure"),
      createFakeInput("btn-aws"),
      createFakeElement("result-azure"),
      createFakeElement("result-aws")
    ]) {
      browser.document.add(element);
    }

    installOidcPageEntry(browser.scope);
    installOidcPageEntry(browser.scope);

    expect(browser.scope[PAGE_REGISTRY_GLOBAL]).toBe(
      resolvePageRegistry(browser.scope)
    );
    expect(azureTab.listenerCount("click")).toBe(1);

    resolvePageRegistry(browser.scope).teardownAll();
    expect(azureTab.listenerCount()).toBe(0);
  });

  it("does nothing when the accounts markup is absent", () => {
    const browser = createFakeBrowserScope();

    expect(() => installOidcPageEntry(browser.scope)).not.toThrow();
    expect(browser.scope[PAGE_REGISTRY_GLOBAL]).toBe(
      resolvePageRegistry(browser.scope)
    );
  });
});
