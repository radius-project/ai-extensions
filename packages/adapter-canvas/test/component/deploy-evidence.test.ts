import { afterEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { waitFor } from "@testing-library/dom";
import { initializeDeployingPage } from "../../src/browser/deploying/page.js";
import {
  APPLICATIONS_PATH,
  ENVIRONMENTS_PATH,
  BRANCHES_PATH,
  DEPLOYMENTS_PATH
} from "../../src/browser/repositories.js";
import { createRealScope, jsonResponse } from "./support/real-scope.js";
import { DEPLOY_COMPLETED_UNCONFIRMED_MESSAGE } from "../../src/deploy-messages.js";

const disposals: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposals.splice(0).reverse()) dispose();
  vi.useRealTimers();
});

it.each([
  {
    name: "primary and unavailable secondary evidence",
    error:
      "Deployment failed (failure). Failed step: Run rad commands.\n\n" +
      "Error: quota <img src=x>\n\nThe control-plane log could not be read.",
    errorKind: null
  },
  {
    name: "completed but unconfirmed outcome",
    error:
      DEPLOY_COMPLETED_UNCONFIRMED_MESSAGE +
      " View the full run: https://github.com/org/app/actions/runs/42",
    errorKind: "run-unconfirmed"
  }
])(
  "renders $name as text without suggesting repair",
  async ({ error, errorKind }) => {
    const originalUrl = window.location.href;
    disposals.push(() => window.history.replaceState(null, "", originalUrl));
    window.history.replaceState(null, "", "?application=app&environment=dev");
    vi.useFakeTimers();
    const scope = createRealScope({
      route(request) {
        const path = request.url.split("?")[0];
        if (path === "/api/deploy-status")
          return jsonResponse(200, {
            status: "failed",
            active: false,
            error,
            errorKind,
            repairing: false,
            handoff: { state: "idle", pending: false },
            attempt: { targetRepo: "org/app", environment: "dev" }
          });
        if (path === APPLICATIONS_PATH)
          return jsonResponse(200, { applications: [{ name: "app" }] });
        if (path === ENVIRONMENTS_PATH)
          return jsonResponse(200, { environments: [] });
        if (path === BRANCHES_PATH) return jsonResponse(200, { branches: [] });
        if (path === DEPLOYMENTS_PATH)
          return jsonResponse(200, { deployments: [] });
        throw new Error("Unexpected request: " + request.url);
      }
    });
    disposals.push(scope.dispose);
    scope.host.innerHTML = `
    <button id="deploy-now-btn">Deploy</button>
    <select id="deploy-app-select"></select><select id="deploy-env-select"></select>
    <div id="deploy-inline-status"></div><table><tbody id="deploy-table-body"></tbody></table>
    <div id="deploy-progress-modal">
      <div id="deploy-progress-spinner"></div><div id="deploy-progress-failicon"></div>
      <div id="deploy-progress-title"></div><div id="deploy-progress-subtitle"></div>
      <div id="deploy-progress-fail-actions"><button id="deploy-fail-back">Back to Deployments</button></div>
      <div id="deploy-fail-repair-note"></div>
    </div>`;
    disposals.push(
      initializeDeployingPage(scope.context, {
        repo: "org/app",
        branch: "feature",
        mutationNonce: "fixture-nonce"
      })
    );
    await vi.advanceTimersByTimeAsync(2500);
    vi.useRealTimers();

    const subtitle = scope.host.querySelector("#deploy-progress-subtitle");
    await waitFor(() => expect(subtitle?.textContent).toContain(error));
    expect(subtitle?.querySelector("img")).toBeNull();
    expect(
      scope.host.querySelector<HTMLElement>("#deploy-fail-repair-note")?.style
        .display
    ).toBe("none");
    expect(
      scope.host.querySelector("#deploy-progress-title")?.textContent
    ).toContain("failed");
    const back =
      scope.host.querySelector<HTMLButtonElement>("#deploy-fail-back");
    if (!back) throw new Error("Missing failure dismissal");
    await userEvent.setup().click(back);
    expect(
      scope.host.querySelector<HTMLElement>("#deploy-progress-modal")?.style
        .display
    ).toBe("none");
  }
);
