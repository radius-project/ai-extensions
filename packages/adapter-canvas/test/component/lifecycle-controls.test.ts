import { afterEach, expect, it } from "vitest";
import { waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { createLifecycleControls } from "../../src/browser/lifecycle-controls.js";
import { createRealScope, jsonResponse } from "./support/real-scope.js";

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0).reverse()) dispose();
});

it.each(["repair", "cancel"] as const)(
  "requests explicit %s with keyboard focus and preserves observation-only navigation",
  async (kind) => {
    let accepted = false;
    const suffix = kind === "repair" ? "retry/repair" : "cancel-workflow";
    const scope = createRealScope({
      route(request) {
        if (
          request.url === `/api/operations/original/${suffix}` &&
          request.method === "POST"
        ) {
          accepted = true;
          return jsonResponse(202, {
            operationId: kind === "repair" ? "linked" : "original"
          });
        }
        if (
          request.method !== "GET" ||
          !["/api/operations/original", "/api/operations/linked"].includes(
            request.url
          )
        )
          throw new Error(`Unexpected lifecycle request: ${request.url}`);
        const operationId =
          accepted && kind === "repair" ? "linked" : "original";
        return jsonResponse(200, {
          operation: {
            operationId,
            summary:
              accepted ?
                "Cancellation or repair accepted; no rollback or redeployment."
              : "Known failed operation.",
            actions:
              accepted ?
                []
              : [
                  {
                    id: "control",
                    kind: `lifecycle.${kind}`,
                    path: `/api/operations/original/${suffix}`
                  }
                ]
          }
        });
      }
    });
    disposals.push(scope.dispose);
    scope.host.innerHTML = `<section id="lifecycle-controls" aria-label="Explicit lifecycle controls"><p id="lifecycle-control-status" role="status"></p><button id="lifecycle-repair" type="button">Request bounded repair</button><button id="lifecycle-cancel" type="button">Request cancellation</button></section>`;
    const controls = createLifecycleControls(scope.context, "fixture-nonce");
    disposals.push(controls.teardown);
    controls.observe("original");
    const button = scope.host.querySelector<HTMLButtonElement>(
      `#lifecycle-${kind}`
    );
    if (!button) throw new Error("Missing control");
    await waitFor(() => expect(button.style.display).toBe(""));
    expect(scope.requests).toHaveLength(1);
    button.focus();
    await userEvent.setup().keyboard("{Enter}");
    await waitFor(() =>
      expect(
        scope.host.querySelector("#lifecycle-control-status")?.textContent
      ).toContain("accepted")
    );
    expect(document.activeElement?.id).toBe("lifecycle-control-status");
    expect(
      scope.requests.filter((request) => request.method === "POST")
    ).toHaveLength(1);
    expect(scope.requests[1].headers["x-radius-mutation-nonce"]).toBe(
      "fixture-nonce"
    );
    expect(scope.requests[1].body).toEqual(
      kind === "repair" ?
        { repairPolicy: { mode: "manual", maxAttempts: 5 } }
      : {}
    );
    controls.teardown();
    expect(
      scope.requests.some((request) => /deploy|rollback/.test(request.url))
    ).toBe(false);
  }
);
