import { describe, expect, it } from "vitest";
import {
  DEPLOY_RESET_PATH,
  DEPLOY_RESULT_ENTRY_KEY,
  DEPLOY_RESULT_STATE_ID,
  initializeDeployResultPage
} from "./deploy-result-page.js";
import {
  createDeferred,
  createFakeBrowser,
  createFakeElement,
  createFakeInput,
  flushPromises,
  jsonResponse
} from "../../../test/support/browser/fakes.js";
import type { HttpResponse } from "../ports.js";

function renderResult(attemptId = "attempt-1", includeStatus = true) {
  const browser = createFakeBrowser();
  const button = createFakeInput("back-btn");
  button.textContent = "← Back to Deploy";
  const status = createFakeElement("deploy-reset-status");
  status.style.display = "none";
  const state = createFakeElement(DEPLOY_RESULT_STATE_ID);
  state.textContent = JSON.stringify({ attemptId });
  for (const element of [button, state]) browser.document.add(element);
  if (includeStatus) browser.document.add(status);
  return { ...browser, button, status, state };
}

describe("initializeDeployResultPage", () => {
  it("does nothing without the result controls", () => {
    const browser = createFakeBrowser();
    const teardown = initializeDeployResultPage(browser.context);
    teardown();
    expect(browser.bindings.has(DEPLOY_RESULT_ENTRY_KEY)).toBe(false);
  });

  it("posts the attempt identity and reloads only on explicit success", async () => {
    const browser = renderResult();
    browser.net.handle(DEPLOY_RESET_PATH, () => jsonResponse({ ok: true }));
    initializeDeployResultPage(browser.context);

    browser.button.dispatch("click");
    browser.button.dispatch("click");
    expect(browser.button.disabled).toBe(true);
    expect(browser.button.textContent).toBe("Resetting…");
    await flushPromises();

    expect(browser.net.calls).toHaveLength(1);
    expect(JSON.parse(String(browser.net.calls[0].init?.body))).toEqual({
      attemptId: "attempt-1"
    });
    expect(browser.nav.reloads).toBe(1);
  });

  it.each([
    [
      "an HTTP error",
      jsonResponse({ error: "The deployment attempt is stale." }, false, 409),
      "The deployment attempt is stale."
    ],
    [
      "a malformed success",
      jsonResponse({ ok: "yes" }),
      "The deployment view could not be reset."
    ]
  ])("fails closed on %s", async (_name, response, expected) => {
    const browser = renderResult();
    browser.net.handle(DEPLOY_RESET_PATH, () => response);
    initializeDeployResultPage(browser.context);

    browser.button.dispatch("click");
    await flushPromises();

    expect(browser.nav.reloads).toBe(0);
    expect(browser.button.disabled).toBe(false);
    expect(browser.button.textContent).toBe("← Back to Deploy");
    expect(browser.status.style.display).toBe("block");
    expect(browser.status.textContent).toBe(expected);
  });

  it("surfaces a request failure and permits a retry", async () => {
    const browser = renderResult("");
    let calls = 0;
    browser.net.handle(DEPLOY_RESET_PATH, () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("offline"));
      return jsonResponse({ ok: true });
    });
    initializeDeployResultPage(browser.context);

    browser.button.dispatch("click");
    await flushPromises();
    expect(browser.status.textContent).toBe("offline");
    expect(browser.button.disabled).toBe(false);

    browser.button.dispatch("click");
    await flushPromises();
    expect(browser.nav.reloads).toBe(1);
  });

  it("handles unavailable abort and status ports without inventing success", async () => {
    const browser = renderResult("attempt-1", false);
    browser.net.supportsAbort = false;
    browser.net.handle(DEPLOY_RESET_PATH, () => Promise.reject("offline"));
    initializeDeployResultPage(browser.context);

    browser.button.dispatch("click");
    await flushPromises();

    expect(browser.nav.reloads).toBe(0);
    expect(browser.button.disabled).toBe(false);
    expect(browser.button.textContent).toBe("← Back to Deploy");
  });

  it("uses a stable failure message for a non-Error rejection", async () => {
    const browser = renderResult();
    browser.net.handle(DEPLOY_RESET_PATH, () => Promise.reject("offline"));
    initializeDeployResultPage(browser.context);

    browser.button.dispatch("click");
    await flushPromises();

    expect(browser.status.textContent).toBe(
      "The deployment view could not be reset."
    );
  });

  it("binds once and teardown aborts and ignores a late success", async () => {
    const browser = renderResult();
    const pending = createDeferred<HttpResponse>();
    browser.net.handle(DEPLOY_RESET_PATH, () => pending.promise);
    const teardown = initializeDeployResultPage(browser.context);
    const second = initializeDeployResultPage(browser.context);
    expect(browser.button.listenerCount("click")).toBe(1);
    second();

    browser.button.dispatch("click");
    await flushPromises();
    teardown();
    teardown();
    expect(browser.net.aborted).toBe(1);
    expect(browser.button.listenerCount()).toBe(0);

    pending.resolve(jsonResponse({ ok: true }));
    await flushPromises();
    expect(browser.nav.reloads).toBe(0);
  });

  it("ignores a late successful response when abort is unavailable", async () => {
    const browser = renderResult();
    browser.net.supportsAbort = false;
    const pending = createDeferred<HttpResponse>();
    browser.net.handle(DEPLOY_RESET_PATH, () => pending.promise);
    const teardown = initializeDeployResultPage(browser.context);

    browser.button.dispatch("click");
    await flushPromises();
    teardown();
    pending.resolve(jsonResponse({ ok: true }));
    await flushPromises();

    expect(browser.nav.reloads).toBe(0);
  });

  it("rejects malformed serialized state during initialization", () => {
    const browser = renderResult();
    browser.state.textContent = "not json";
    expect(() => initializeDeployResultPage(browser.context)).toThrow(
      'Radius browser page state "radius-deploy-result-state" is invalid.'
    );
  });
});
