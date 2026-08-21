import { describe, expect, it } from "vitest";
import {
  createFakeBrowserScope,
  createFakeElement,
  flushPromises,
  jsonResponse
} from "../../../test/support/browser/fakes.js";
import { PAGE_REGISTRY_GLOBAL } from "../globals.js";
import {
  GRAPH_CHIP_ID,
  GRAPH_CHIP_LABEL_ID,
  GRAPH_PROGRESS_PATH
} from "../graph-chip.js";
import { resolvePageRegistry } from "../registry.js";
import { installGraphChipEntry } from "./graph-chip.js";

describe("graph chip browser entry", () => {
  it("owns one document-lifetime poller and tears down with the document", async () => {
    const browser = createFakeBrowserScope();
    browser.document.add(createFakeElement(GRAPH_CHIP_ID));
    browser.document.add(createFakeElement(GRAPH_CHIP_LABEL_ID));
    browser.net.handle(GRAPH_PROGRESS_PATH, () =>
      jsonResponse({ active: false, events: [] })
    );

    installGraphChipEntry(browser.scope);
    installGraphChipEntry(browser.scope);
    await flushPromises();

    const registry = resolvePageRegistry(browser.scope);
    expect(browser.scope[PAGE_REGISTRY_GLOBAL]).toBe(registry);
    // Polling and the local clock, once each, no matter how often the shell
    // re-runs the entry.
    expect(browser.clock.intervals).toBe(2);

    // A build outlives any one page, so navigating between pages must not
    // stop the chip. Only the document going away does.
    registry.teardownPage();
    expect(browser.clock.pending).toBe(2);
    registry.teardownAll();
    expect(browser.clock.pending).toBe(0);
  });

  it("does nothing when the shell has no graph chip", () => {
    const browser = createFakeBrowserScope();

    expect(() => installGraphChipEntry(browser.scope)).not.toThrow();
    expect(browser.scope[PAGE_REGISTRY_GLOBAL]).toBe(
      resolvePageRegistry(browser.scope)
    );
  });
});
