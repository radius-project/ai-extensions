import { describe, expect, it } from "vitest";
import {
  createFakeBrowserScope,
  createFakeElement,
  flushPromises,
  jsonResponse
} from "../../../test/support/browser/fakes.js";
import { PAGE_REGISTRY_GLOBAL } from "../globals.js";
import {
  DEPLOY_CHIP_ID,
  DEPLOY_CHIP_LABEL_ID,
  DEPLOY_NOTIFICATION_PATH
} from "../deploy-chip.js";
import { resolvePageRegistry } from "../registry.js";
import { installDeployChipEntry } from "./deploy-chip.js";

describe("deploy chip browser entry", () => {
  it("owns one document-lifetime poller and tears down with the document", async () => {
    const browser = createFakeBrowserScope();
    const chip = createFakeElement(DEPLOY_CHIP_ID);
    browser.document.add(chip);
    browser.document.add(createFakeElement(DEPLOY_CHIP_LABEL_ID));
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () =>
      jsonResponse({ status: "pending" })
    );

    installDeployChipEntry(browser.scope);
    installDeployChipEntry(browser.scope);
    await flushPromises();

    const registry = resolvePageRegistry(browser.scope);
    expect(browser.scope[PAGE_REGISTRY_GLOBAL]).toBe(registry);
    expect(chip.listenerCount("click")).toBe(1);
    expect(browser.clock.intervals).toBe(1);

    registry.teardownPage();
    expect(chip.listenerCount("click")).toBe(1);
    registry.teardownAll();
    expect(chip.listenerCount()).toBe(0);
    expect(browser.clock.pending).toBe(0);
  });

  it("does nothing when the shell has no deploy chip", () => {
    const browser = createFakeBrowserScope();

    expect(() => installDeployChipEntry(browser.scope)).not.toThrow();
    expect(browser.scope[PAGE_REGISTRY_GLOBAL]).toBe(
      resolvePageRegistry(browser.scope)
    );
  });
});
