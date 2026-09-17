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

it("follows the linked repair from the environment panel without a second mutation", async () => {
  const summary = "Linked repair failed; the original failure is retained.";
  const scope = createRealScope({
    route(request) {
      if (
        request.url === "/api/operations/original/retry/repair" &&
        request.method === "POST"
      )
        return jsonResponse(202, { operationId: "linked" });
      if (request.url === "/api/operations/linked" && request.method === "GET")
        return jsonResponse(200, {
          operation: {
            operationId: "linked",
            kind: "lifecycle_operation",
            state: "failed",
            terminalState: "failed",
            summary,
            actions: [],
            stages: [],
            steps: []
          }
        });
      throw new Error(`Unexpected lifecycle request: ${request.url}`);
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
    throw new Error("No publication or deployment is authorized.");
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
  if (!controller) throw new Error("Missing environment controls");
  disposals.push(controller.teardown);
  controller.renderProgress(
    parseOperationResponse({
      operation: {
        operationId: "original",
        kind: "lifecycle_operation",
        state: "failed",
        terminalState: "failed",
        summary: "Original failure.",
        actions: [
          {
            id: "repair-original",
            kind: "lifecycle.repair",
            label: "Request bounded repair",
            path: "/api/operations/original/retry/repair"
          }
        ]
      }
    })
  );
  const button = scope.host.querySelector<HTMLButtonElement>("button");
  if (!button) throw new Error("Missing repair action");
  button.focus();
  await userEvent.setup().keyboard("{Enter}");
  await waitFor(() =>
    expect(
      scope.host.querySelector(`#${PROGRESS_IDS.title}`)?.textContent
    ).toContain(summary)
  );
  expect(
    scope.requests.map((request) => `${request.method} ${request.url}`)
  ).toEqual([
    "POST /api/operations/original/retry/repair",
    "GET /api/operations/linked"
  ]);
  expect(scope.requests[0].body).toEqual({
    repairPolicy: { mode: "manual", maxAttempts: 5 }
  });
  expect(document.activeElement?.id).toBe(PROGRESS_IDS.title);
});

it.each(
  ["succeeded", "failed_partial", "unconfirmed"].flatMap((state) =>
    ["lifecycle_environment", "lifecycle_operation"].map((kind) => ({
      state,
      kind
    }))
  )
)(
  "keeps $kind $state explicit, keyboard accessible and deployment-free",
  async ({ state, kind }) => {
    const action = {
      id: "action-1",
      kind:
        kind === "lifecycle_operation" ? "lifecycle.cancel" : (
          "lifecycle.configure"
        ),
      label: "Continue configuration",
      description: "Review the environment settings.",
      path:
        kind === "lifecycle_operation" ?
          "/api/operations/op-1/cancel-workflow"
        : "/api/operations/op-1/continue"
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
            kind,
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
        kind,
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
    expect(scope.requests[0].body).toEqual(
      kind === "lifecycle_operation" ?
        {}
      : {
          actionId: action.id,
          choice: "continue"
        }
    );
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
