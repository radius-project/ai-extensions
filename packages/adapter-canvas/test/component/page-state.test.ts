import { afterEach, describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { initializeDeployResultPage } from "../../src/browser/pages/deploy-result-page.js";
import { readPageState } from "../../src/browser/pages/state.js";
import { DEPLOY_RESULT_STATE_ID } from "../../src/pages/browser-state-ids.js";
import { createRealScope, jsonResponse } from "./support/real-scope.js";

const disposals: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposals.splice(0).reverse()) dispose();
});

// Literal transport fixtures isolate the DOM reader from the producer, which
// is exercised through every real renderer in the HTTP and Chromium suites.
const RESULT_FRAGMENTS = [
  {
    attemptId: "first</script>&quot;",
    text: "{&quot;attemptId&quot;:&quot;first\\u003c/script\\u003e\\u0026quot;&quot;}"
  },
  {
    attemptId: "second</div>&amp;",
    text: "{&quot;attemptId&quot;:&quot;second\\u003c/div\\u003e\\u0026amp;&quot;}"
  }
];

function resultFragment(text: string): string {
  return `<button id="back-btn">Back to Deploy</button>
<div id="deploy-reset-status" style="display:none"></div>
<div hidden id="${DEPLOY_RESULT_STATE_ID}">${text}</div>`;
}

describe("page-state reader in Chromium", () => {
  it.each(RESULT_FRAGMENTS)(
    "reads hidden textContent without decoding entity-looking data twice: $attemptId",
    ({ attemptId, text }) => {
      const scope = createRealScope();
      disposals.push(scope.dispose);
      scope.host.innerHTML = resultFragment(text);

      expect(readPageState(scope.context, DEPLOY_RESULT_STATE_ID)).toEqual({
        attemptId
      });
      const state = scope.host.querySelector(`#${DEPLOY_RESULT_STATE_ID}`);
      expect(state?.hasAttribute("hidden")).toBe(true);
      expect(state?.childElementCount).toBe(0);
      expect(scope.host.querySelectorAll("script, svg")).toHaveLength(0);
      expect(scope.requests).toEqual([]);
    }
  );

  it("rebinds the replaced fragment's attempt identity and retires the old handler", async () => {
    const user = userEvent.setup();
    const scope = createRealScope({
      route(request) {
        expect(request.url).toBe("/api/deploy-reset");
        expect(request.method).toBe("POST");
        return jsonResponse(409, { error: "Attempt is no longer current." });
      }
    });
    disposals.push(scope.dispose);
    const first = RESULT_FRAGMENTS[0];
    const second = RESULT_FRAGMENTS[1];
    scope.host.innerHTML = resultFragment(first.text);
    const disposeFirst = initializeDeployResultPage(scope.context);
    disposals.push(disposeFirst);
    const oldButton = scope.host.querySelector<HTMLButtonElement>("#back-btn");
    if (oldButton === null) throw new Error("Result button is missing.");

    await user.click(oldButton);
    await waitFor(() => expect(oldButton.disabled).toBe(false));
    expect(scope.requests.map((request) => request.body)).toEqual([
      { attemptId: first.attemptId }
    ]);
    expect(scope.host.querySelector("#deploy-reset-status")?.textContent).toBe(
      "Attempt is no longer current."
    );

    disposeFirst();
    scope.host.innerHTML = resultFragment(second.text);
    disposals.push(initializeDeployResultPage(scope.context));
    oldButton.click();
    expect(scope.requests).toHaveLength(1);
    const nextButton = scope.host.querySelector<HTMLButtonElement>("#back-btn");
    if (nextButton === null) throw new Error("Replacement button is missing.");
    await user.click(nextButton);
    await waitFor(() => expect(nextButton.disabled).toBe(false));

    expect(scope.requests.map((request) => request.body)).toEqual([
      { attemptId: first.attemptId },
      { attemptId: second.attemptId }
    ]);
    expect(readPageState(scope.context, DEPLOY_RESULT_STATE_ID)).toEqual({
      attemptId: second.attemptId
    });
  });
});
