import { describe, expect, it } from "vitest";
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_PING_PATH } from "../heartbeat.js";
import { PAGE_REGISTRY_GLOBAL } from "../globals.js";
import { resolvePageRegistry } from "../registry.js";
import { installHeartbeatEntry } from "./heartbeat.js";
import {
  createFakeBrowserScope,
  flushPromises,
  jsonResponse
} from "../../../test/support/browser/fakes.js";

describe("heartbeat browser entry", () => {
  it("installs through the shared page registry and binds only once", async () => {
    const browser = createFakeBrowserScope();
    browser.net.handle(HEARTBEAT_PING_PATH, () => jsonResponse({}));

    installHeartbeatEntry(browser.scope);
    installHeartbeatEntry(browser.scope);

    expect(browser.scope[PAGE_REGISTRY_GLOBAL]).toBe(
      resolvePageRegistry(browser.scope)
    );
    expect(browser.clock.intervals).toBe(1);
    expect(browser.document.listenerCount("visibilitychange")).toBe(1);
    expect(browser.page.listenerCount("focus")).toBe(1);

    browser.clock.tick(HEARTBEAT_INTERVAL_MS);
    await flushPromises();
    expect(browser.net.calls).toHaveLength(1);

    resolvePageRegistry(browser.scope).teardownAll();
    expect(browser.clock.pending).toBe(0);
    expect(browser.document.listenerCount()).toBe(0);
    expect(browser.page.listenerCount()).toBe(0);
  });
});
