import { describe, expect, it } from "vitest";
import {
  createFakeBrowserScope,
  createFakeElement
} from "../../../test/support/browser/fakes.js";
import { PAGE_REGISTRY_GLOBAL } from "../globals.js";
import { DEPLOYING_PAGE_STATE_ID } from "../deploying/page.js";
import { resolvePageRegistry } from "../registry.js";
import { installDeployingPageEntry } from "./deploying-page.js";

describe("deploying page browser entry", () => {
  it("does nothing when the page state is absent", () => {
    const browser = createFakeBrowserScope();

    expect(() => installDeployingPageEntry(browser.scope)).not.toThrow();
    expect(browser.scope[PAGE_REGISTRY_GLOBAL]).toBe(
      resolvePageRegistry(browser.scope)
    );
  });

  it.each([undefined, "operation-1", 42])(
    "reads and narrows serialized lifecycle identity %s before initialization",
    (lifecycleOperationId) => {
      const browser = createFakeBrowserScope();
      const state = createFakeElement(DEPLOYING_PAGE_STATE_ID);
      state.textContent = JSON.stringify({
        repo: "octo/app",
        branch: "feature/x",
        lifecycleOperationId
      });
      browser.document.add(state);

      expect(() => installDeployingPageEntry(browser.scope)).not.toThrow();
      expect(browser.net.calls).toHaveLength(0);
    }
  );
});
