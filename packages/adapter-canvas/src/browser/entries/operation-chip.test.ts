import { describe, expect, it } from "vitest";
import {
  createFakeBrowserScope,
  createFakeElement,
  flushPromises,
  jsonResponse
} from "../../../test/support/browser/fakes.js";
import { PAGE_REGISTRY_GLOBAL } from "../globals.js";
import {
  OPERATION_CHIP_ID,
  OPERATION_CHIP_LABEL_ID,
  OPERATION_STATUS_PATH
} from "../operation-chip.js";
import { resolvePageRegistry } from "../registry.js";
import { installOperationChipEntry } from "./operation-chip.js";

describe("operation chip browser entry", () => {
  it("owns one document-lifetime poller and tears down with the document", async () => {
    const browser = createFakeBrowserScope();
    const chip = createFakeElement(OPERATION_CHIP_ID);
    browser.document.add(chip);
    browser.document.add(createFakeElement(OPERATION_CHIP_LABEL_ID));
    browser.net.handle(OPERATION_STATUS_PATH, () =>
      jsonResponse({ operation: null })
    );

    installOperationChipEntry(browser.scope);
    installOperationChipEntry(browser.scope);
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

  it("does nothing when the shell has no operation chip", () => {
    const browser = createFakeBrowserScope();

    expect(() => installOperationChipEntry(browser.scope)).not.toThrow();
    expect(browser.scope[PAGE_REGISTRY_GLOBAL]).toBe(
      resolvePageRegistry(browser.scope)
    );
  });
});
