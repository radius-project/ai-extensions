import { describe, expect, it } from "vitest";
import {
  createFakeBrowserScope,
  createFakeElement,
  createFakeInput
} from "../../../test/support/browser/fakes.js";
import { PAGE_REGISTRY_GLOBAL } from "../globals.js";
import { DEPLOY_RESULT_STATE_ID } from "../pages/deploy-result-page.js";
import { resolvePageRegistry } from "../registry.js";
import { installDeployResultPageEntry } from "./deploy-result-page.js";

describe("deploy result page browser entry", () => {
  it("installs once through the page registry and tears down", () => {
    const browser = createFakeBrowserScope();
    const button = createFakeInput("back-btn");
    const state = createFakeElement(DEPLOY_RESULT_STATE_ID);
    state.textContent = JSON.stringify({ attemptId: "attempt-1" });
    browser.document.add(button);
    browser.document.add(state);

    installDeployResultPageEntry(browser.scope);
    installDeployResultPageEntry(browser.scope);
    expect(browser.scope[PAGE_REGISTRY_GLOBAL]).toBe(
      resolvePageRegistry(browser.scope)
    );
    expect(button.listenerCount("click")).toBe(1);

    resolvePageRegistry(browser.scope).teardownPage();
    expect(button.listenerCount()).toBe(0);
  });

  it("does nothing on another page", () => {
    const browser = createFakeBrowserScope();
    expect(() => installDeployResultPageEntry(browser.scope)).not.toThrow();
  });
});
