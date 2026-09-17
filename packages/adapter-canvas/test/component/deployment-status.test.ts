import { afterEach, expect, it } from "vitest";
import { waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { initializeDeployingPage } from "../../src/browser/deploying/page.js";
import { createRealScope, jsonResponse } from "./support/real-scope.js";
import {
  APPLICATIONS_PATH,
  ENVIRONMENTS_PATH,
  BRANCHES_PATH
} from "../../src/browser/repositories.js";

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0).reverse()) dispose();
});

it.each(["unconfirmed", "cancelled", "failed"])(
  "announces %s phases in a real DOM without dispatching on keyboard dismissal",
  async (outcome) => {
    const scope = createRealScope({
      route(request) {
        const path = request.url.split("?")[0];
        if (path === APPLICATIONS_PATH)
          return jsonResponse(200, { applications: [{ name: "app" }] });
        if (path === ENVIRONMENTS_PATH)
          return jsonResponse(200, {
            environments: [
              { name: "dev", provider: "azure", status: "success" }
            ]
          });
        if (path === BRANCHES_PATH)
          return jsonResponse(200, {
            branches: [{ name: "feature", sha: "a".repeat(40) }],
            workspaceBranch: "feature"
          });
        if (path === "/api/list-deployments")
          return jsonResponse(200, { deployments: [] });
        if (path === "/api/deploy") return jsonResponse(200, { ok: true });
        if (path === "/api/deploy-status")
          return jsonResponse(200, {
            status: outcome,
            repairing: false,
            phases: [
              {
                phase: "state-save",
                status: outcome === "failed" ? "failed" : "unknown"
              }
            ],
            handoff: { state: "idle", pending: false }
          });
        throw new Error(`Unexpected component request: ${path}`);
      }
    });
    disposals.push(scope.dispose);
    scope.host.innerHTML = `
      <label for="deploy-app-select">Application</label><select id="deploy-app-select"></select>
      <label for="deploy-env-select">Environment</label><select id="deploy-env-select"></select>
      <label for="deploy-branch-select">Branch</label><select id="deploy-branch-select"></select>
      <button id="deploy-now-btn" disabled>Deploy</button>
      <div id="deploy-inline-status" role="status" aria-live="polite"></div>
      <table><tbody id="deploy-table-body"></tbody></table>
      <div id="deploy-progress-modal" style="display:none">
        <div id="deploy-progress-spinner"></div><div id="deploy-progress-failicon"></div>
        <div id="deploy-progress-title" role="status" aria-live="polite"></div>
        <div id="deploy-progress-subtitle"></div>
        <div id="deploy-progress-fail-actions"><button id="deploy-fail-back">Back to Deployments</button></div>
        <div id="deploy-fail-repair-note"></div>
      </div>`;
    disposals.push(
      initializeDeployingPage(scope.context, {
        repo: "owner/repo",
        branch: "feature",
        mutationNonce: "fixture-nonce"
      })
    );
    const deploy =
      scope.host.querySelector<HTMLButtonElement>("#deploy-now-btn");
    const back =
      scope.host.querySelector<HTMLButtonElement>("#deploy-fail-back");
    if (!deploy || !back) throw new Error("Missing component controls");
    await waitFor(() => expect(deploy.disabled).toBe(false));
    const user = userEvent.setup();
    deploy.focus();
    await user.keyboard("{Enter}");
    await waitFor(
      () =>
        expect(
          scope.host.querySelector("#deploy-progress-title")?.textContent
        ).toContain(outcome),
      { timeout: 5000 }
    );
    expect(
      scope.host.querySelector("#deploy-progress-subtitle")?.textContent
    ).toContain("State save:");
    expect(
      scope.host
        .querySelector("#deploy-progress-title")
        ?.getAttribute("aria-live")
    ).toBe("polite");
    back.focus();
    await user.keyboard("{Enter}");
    expect(
      scope.host.querySelector<HTMLElement>("#deploy-progress-modal")?.style
        .display
    ).toBe("none");
    expect(
      scope.requests.filter((request) => request.url === "/api/deploy")
    ).toHaveLength(1);
  }
);
