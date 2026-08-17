import { describe, expect, it } from "vitest";
import { createFakeBrowserScope } from "../../../test/support/browser/fakes.js";
import { PAGE_REGISTRY_GLOBAL } from "../globals.js";
import { resolvePageRegistry } from "../registry.js";
import { installEnvironmentPageEntry } from "./environment-page.js";

describe("environment page browser entry", () => {
  it("delegates through the page registry and does nothing off-page", () => {
    const browser = createFakeBrowserScope();

    expect(() => installEnvironmentPageEntry(browser.scope)).not.toThrow();
    expect(browser.scope[PAGE_REGISTRY_GLOBAL]).toBe(
      resolvePageRegistry(browser.scope)
    );
  });
});
