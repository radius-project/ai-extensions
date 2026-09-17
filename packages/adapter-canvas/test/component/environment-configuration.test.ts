import { afterEach, expect, it } from "vitest";
import { waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import {
  initializeEnvironmentOperations,
  parseOperationResponse,
  PROGRESS_IDS
} from "../../src/browser/environment/operations.js";
import { createRealScope, jsonResponse } from "./support/real-scope.js";

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0).reverse()) dispose();
});

it.each(["succeeded", "failed_partial", "unconfirmed"])(
  "keeps %s configuration explicit, keyboard accessible and deployment-free",
  async (state) => {
    const action = {
      id: "action-1",
      kind: "lifecycle.configure",
      label: "Continue configuration",
      description: "Review the environment settings.",
      path: "/api/operations/op-1/continue"
    };
    const summary =
      state === "succeeded" ?
        "Environment configuration completed. No application deployment was started."
      : "Configuration needs attention; completed phases remain.";
    const scope = createRealScope({
      route(request) {
        if (request.url !== action.path || request.method !== "POST")
          throw new Error(`Unexpected configuration request: ${request.url}`);
        return jsonResponse(202, {
          operation: {
            operationId: "op-1",
            kind: "lifecycle_environment",
            state,
            terminalState: state === "unconfirmed" ? "action_required" : state,
            summary,
            actions: [],
            stages: [],
            steps: []
          }
        });
      }
    });
    disposals.push(scope.dispose);
    scope.host.innerHTML = `<section id="${PROGRESS_IDS.panel}" tabindex="-1"><h2 id="${PROGRESS_IDS.title}" tabindex="-1" aria-live="polite"></h2>${Object.values(
      PROGRESS_IDS
    )
      .filter((id) => id !== PROGRESS_IDS.panel && id !== PROGRESS_IDS.title)
      .map((id) => `<div id="${id}"></div>`)
      .join("")}</section>`;
    const unexpected = (): never => {
      throw new Error(
        "Canonical configuration must not show legacy success or PR guidance."
      );
    };
    const controller = initializeEnvironmentOperations(scope.context, {
      repo: "owner/repo",
      mutationNonce: "fixture-nonce",
      deps: {
        showSuccessBanner: unexpected,
        showActionRequired: unexpected,
        showSetupWarnings: () => {},
        showError: () => {},
        reloadEnvironmentsTable: () => {},
        promptServiceManagementReference: async () => unexpected(),
        promptAppSelection: async () => unexpected()
      }
    });
    if (!controller) throw new Error("Missing configuration component");
    disposals.push(controller.teardown);
    const pending = parseOperationResponse({
      operation: {
        operationId: "op-1",
        kind: "lifecycle_environment",
        state: "action_required",
        terminalState: "action_required",
        summary: "Review configuration.",
        actions: [action]
      }
    });
    controller.renderProgress(pending);
    const button = scope.host.querySelector<HTMLButtonElement>("button");
    if (!button) throw new Error("Missing continuation button");
    button.focus();
    await userEvent.setup().keyboard("{Enter}");
    await waitFor(() =>
      expect(
        scope.host.querySelector(`#${PROGRESS_IDS.title}`)?.textContent
      ).toContain(summary)
    );
    expect(document.activeElement?.id).toBe(PROGRESS_IDS.title);
    expect(scope.requests).toHaveLength(1);
    expect(scope.requests[0].body).toEqual({
      actionId: action.id,
      choice: "continue"
    });
    expect(scope.requests[0].headers["x-radius-mutation-nonce"]).toBe(
      "fixture-nonce"
    );
    expect(
      scope.host
        .querySelector(`#${PROGRESS_IDS.dismiss}`)
        ?.getAttribute("style")
    ).toContain("display: none");
  }
);
