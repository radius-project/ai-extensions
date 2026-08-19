import { describe, expect, it } from "vitest";
import {
  DEPLOY_BUTTON_ID,
  DEPLOY_BUTTON_IDLE_LABEL,
  ENVIRONMENT_OPERATIONS_ENTRY_KEY,
  ERROR_BANNER_ID,
  OPERATIONS_PATH,
  OperationResumeError,
  PROGRESS_IDS,
  ROLLBACK_IDS,
  VERIFY_STATUS_PATH,
  formatElapsed,
  initializeEnvironmentOperations,
  previewResourceLabel,
  parseOperationResponse,
  parseVerifyStatus
} from "./operations.js";
import type {
  AppPickerChoice,
  AppPickerRequest,
  EnvironmentOperationsDeps,
  OperationRecord,
  OperationTerminalPayload
} from "./operations.js";
import {
  createDeferred,
  createFakeBrowser,
  createFakeElement,
  createFakeInput,
  flushPromises,
  jsonResponse,
  textResponse
} from "../../../test/support/browser/fakes.js";
import type { FakeElement } from "../../../test/support/browser/fakes.js";
import type { HttpResponse } from "../ports.js";

const REPO = "octo/widgets";

function operationsUrl(repo = REPO): string {
  return `${OPERATIONS_PATH}?repo=${encodeURIComponent(repo)}`;
}

function operationUrl(operationId: string): string {
  return `${OPERATIONS_PATH}/${encodeURIComponent(operationId)}`;
}

function resumeUrl(operationId: string, code: string): string {
  return `${operationUrl(operationId)}/resume/${encodeURIComponent(code)}`;
}

function stopUrl(operationId: string): string {
  return `${operationUrl(operationId)}/stop`;
}

function verifyUrl(
  repo: string,
  environment: string,
  operationId: string
): string {
  return (
    `${VERIFY_STATUS_PATH}?repo=${encodeURIComponent(repo)}` +
    `&environment=${encodeURIComponent(environment)}` +
    `&operationId=${encodeURIComponent(operationId)}`
  );
}

function setup() {
  const browser = createFakeBrowser();
  const els: Record<string, FakeElement> = {};
  for (const id of [
    ...Object.values(PROGRESS_IDS),
    ...Object.values(ROLLBACK_IDS)
  ]) {
    // The rollback confirm control is disabled while its request is in
    // flight, so it has to be a real input-like node.
    const el =
      id === ROLLBACK_IDS.confirm ? createFakeInput(id) : createFakeElement(id);
    els[id] = el;
    browser.document.add(el);
  }
  const errorBanner = createFakeElement(ERROR_BANNER_ID);
  els[ERROR_BANNER_ID] = errorBanner;
  browser.document.add(errorBanner);
  const deployButton = createFakeInput(DEPLOY_BUTTON_ID);
  deployButton.disabled = true;
  deployButton.textContent = "Creating…";
  browser.document.add(deployButton);
  return { ...browser, els, deployButton };
}

/**
 * Builds a browser like `setup()` but omits the given element IDs entirely,
 * so `dom.byId`/`dom.inputById` genuinely returns null for them. Used to
 * prove the module's optional-DOM guards degrade gracefully — a real host
 * page can legitimately be missing an element the module treats as
 * optional, and only the panel itself is a hard requirement.
 */
function setupWithout(missingIds: readonly string[]) {
  const browser = createFakeBrowser();
  const els: Record<string, FakeElement> = {};
  for (const id of [
    ...Object.values(PROGRESS_IDS),
    ...Object.values(ROLLBACK_IDS)
  ]) {
    if (missingIds.includes(id)) continue;
    const el =
      id === ROLLBACK_IDS.confirm ? createFakeInput(id) : createFakeElement(id);
    els[id] = el;
    browser.document.add(el);
  }
  if (!missingIds.includes(ERROR_BANNER_ID)) {
    const errorBanner = createFakeElement(ERROR_BANNER_ID);
    els[ERROR_BANNER_ID] = errorBanner;
    browser.document.add(errorBanner);
  }
  if (!missingIds.includes(DEPLOY_BUTTON_ID)) {
    const deployButton = createFakeInput(DEPLOY_BUTTON_ID);
    deployButton.disabled = true;
    deployButton.textContent = "Creating…";
    browser.document.add(deployButton);
  }
  return { ...browser, els };
}

function op(overrides: Record<string, unknown> = {}): {
  operation: Record<string, unknown>;
} {
  return {
    operation: {
      operationId: "op-1",
      environment: "dev",
      provider: "azure",
      state: "running",
      terminalState: null,
      summary: "Creating dev…",
      currentStage: "provision",
      stages: [],
      steps: [],
      failure: null,
      cleanup: null,
      verification: null,
      inputRequired: null,
      startedAt: new Date(0).toISOString(),
      endedAt: null,
      terminal: null,
      ...overrides
    }
  };
}

/**
 * Builds a fully-normalized OperationRecord (as renderProgress/applyTerminal expect),
 * by round-tripping test overrides through the module's own parser. This mirrors what
 * the real fetch path produces and avoids feeding renderers a partially-shaped raw
 * wire object that is missing normalized nested fields (e.g. cleanup.retry).
 */
function record(overrides: Record<string, unknown> = {}): OperationRecord {
  const parsed = parseOperationResponse(op(overrides));
  if (!parsed) {
    throw new Error("test built an operation payload that failed to parse");
  }
  return parsed;
}

function createDeps(overrides: Partial<EnvironmentOperationsDeps> = {}) {
  const successBanners: Array<{ provider: string; environment: string }> = [];
  const actionRequired: Array<{
    provider: string;
    environment: string;
    pullRequestUrl: string;
    terminal: OperationTerminalPayload | null;
  }> = [];
  const setupWarnings: string[][] = [];
  const errors: string[] = [];
  let reloadCount = 0;
  const deps: EnvironmentOperationsDeps = {
    showSuccessBanner(provider, environment) {
      successBanners.push({ provider, environment });
    },
    showActionRequired(provider, environment, pullRequestUrl, terminal) {
      actionRequired.push({ provider, environment, pullRequestUrl, terminal });
    },
    showSetupWarnings(warnings) {
      setupWarnings.push([...warnings]);
    },
    showError(message) {
      errors.push(message);
    },
    reloadEnvironmentsTable() {
      reloadCount += 1;
    },
    promptServiceManagementReference: () =>
      Promise.reject(
        new Error(
          "promptServiceManagementReference was not stubbed for this test"
        )
      ),
    promptAppSelection: (
      _request: AppPickerRequest
    ): Promise<AppPickerChoice> =>
      Promise.reject(
        new Error("promptAppSelection was not stubbed for this test")
      ),
    ...overrides
  };
  return {
    deps,
    successBanners,
    actionRequired,
    setupWarnings,
    errors,
    get reloadCount() {
      return reloadCount;
    }
  };
}

async function tickClock(
  clock: { tick(ms: number): void },
  ms: number,
  beats = 1
): Promise<void> {
  for (let index = 0; index < beats; index += 1) {
    clock.tick(ms);
    await flushPromises();
  }
}

describe("formatElapsed", () => {
  it.each([
    [0, "0:00"],
    [999, "0:00"],
    [1000, "0:01"],
    [5000, "0:05"],
    [65000, "1:05"],
    [600000, "10:00"],
    [-5000, "0:00"]
  ])("formats %i ms as %s", (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected);
  });
});

describe("parseOperationResponse", () => {
  it.each([
    ["null", null],
    ["a string", "running"],
    ["an array", []],
    ["an empty envelope", {}],
    ["a null operation", { operation: null }],
    ["an operation with no operationId", { operation: { environment: "dev" } }],
    [
      "an operation with a non-string operationId",
      { operation: { operationId: 7 } }
    ]
  ])("reads %s as no operation", (_name, payload) => {
    expect(parseOperationResponse(payload)).toBeNull();
  });

  it("defaults malformed optional fields on an otherwise valid operation", () => {
    const parsed = parseOperationResponse(
      op({
        terminalState: "not-a-real-state",
        stages: "not-an-array",
        steps: { not: "an array" },
        failure: "not-an-object",
        cleanup: "not-an-object",
        verification: "not-an-object",
        inputRequired: "not-an-object",
        endedAt: ""
      })
    );
    expect(parsed).toMatchObject({
      terminalState: null,
      stages: [],
      steps: [],
      failure: null,
      verification: null,
      inputRequired: null,
      endedAt: null
    });
    expect(parsed?.cleanup).toEqual({
      state: "",
      rollbackBeforeCommit: undefined,
      retry: { startsCleanly: false, guidance: "" },
      removed: [],
      retained: [],
      warnings: [],
      created: [],
      retainedArtifacts: [],
      reused: [],
      cleaned: [],
      manualActionRequired: []
    });
  });

  it.each([
    "succeeded",
    "succeeded_with_warnings",
    "action_required",
    "failed",
    "failed_partial",
    "cancelled"
  ])("accepts the known terminal state %s", (terminalState) => {
    expect(parseOperationResponse(op({ terminalState }))?.terminalState).toBe(
      terminalState
    );
  });

  it("reads a fully populated cleanup summary", () => {
    const parsed = parseOperationResponse(
      op({
        cleanup: {
          state: "succeeded_with_warnings",
          rollbackBeforeCommit: false,
          retry: { startsCleanly: true, guidance: "Retry any time." },
          removed: [
            { target: "rg-dev" },
            { notATarget: true },
            { target: "" },
            "not-an-entry"
          ],
          retained: [{ target: "kv-dev" }],
          warnings: ["partial cleanup", "", 7, null],
          created: [{ target: "app-radius-dev" }, { target: "" }],
          retainedArtifacts: [{ target: "ghcr package" }],
          reused: [{ target: "existing-sp" }],
          cleaned: [{ target: "federated credential" }],
          manualActionRequired: [
            { target: "role assignment", action: "Remove it in the portal" },
            { target: "orphan app" },
            { action: "no target" },
            "not-an-entry"
          ]
        }
      })
    );
    expect(parsed?.cleanup).toEqual({
      state: "succeeded_with_warnings",
      rollbackBeforeCommit: false,
      retry: { startsCleanly: true, guidance: "Retry any time." },
      removed: [{ target: "rg-dev" }],
      retained: [{ target: "kv-dev" }],
      warnings: ["partial cleanup"],
      created: [{ target: "app-radius-dev" }],
      retainedArtifacts: [{ target: "ghcr package" }],
      reused: [{ target: "existing-sp" }],
      cleaned: [{ target: "federated credential" }],
      manualActionRequired: [
        { target: "role assignment", action: "Remove it in the portal" },
        { target: "orphan app", action: "" }
      ]
    });
  });

  it("treats a non-boolean rollbackBeforeCommit as undefined, distinct from false", () => {
    expect(
      parseOperationResponse(op({ cleanup: { rollbackBeforeCommit: "false" } }))
        ?.cleanup.rollbackBeforeCommit
    ).toBeUndefined();
    expect(
      parseOperationResponse(op({ cleanup: { rollbackBeforeCommit: true } }))
        ?.cleanup.rollbackBeforeCommit
    ).toBe(true);
  });

  it("reads the projected controls and drops what it cannot use", () => {
    const parsed = parseOperationResponse(
      op({
        actions: [
          {
            id: "rollback",
            kind: "rollback",
            label: "Roll back created resources",
            description: "This cannot be undone.",
            path: "/api/operations/op-1/rollback",
            pending: false,
            tone: "danger",
            requiresConfirmation: true,
            confirmTitle: "Roll back?",
            confirmLabel: "Roll back",
            cancelLabel: "Keep",
            preview: {
              removes: [
                { kind: "azure_app", target: "radius-dev" },
                { kind: "azure_app", target: "" },
                "not-an-entry"
              ],
              keeps: "not-a-list",
              manualActionRequired: [
                { kind: "role_assignment", target: "Contributor", action: "Go" }
              ]
            }
          },
          { id: "no-path", kind: "stop" },
          "not-an-action"
        ],
        guidance: [
          { code: "commit-point-passed", message: "Rollback is not offered." },
          { code: "empty", message: "" },
          "not-a-note"
        ],
        headline: { code: "stopped", title: "Stopped", message: "note" },
        activeCommandKind: "rollback",
        nextTransition: { code: "stopping", message: "Stopping…" }
      })
    );

    expect(parsed?.actions).toEqual([
      {
        id: "rollback",
        kind: "rollback",
        label: "Roll back created resources",
        description: "This cannot be undone.",
        path: "/api/operations/op-1/rollback",
        pending: false,
        tone: "danger",
        requiresConfirmation: true,
        confirmTitle: "Roll back?",
        confirmLabel: "Roll back",
        cancelLabel: "Keep",
        preview: {
          removes: [{ kind: "azure_app", target: "radius-dev", action: "" }],
          keeps: [],
          manualActionRequired: [
            { kind: "role_assignment", target: "Contributor", action: "Go" }
          ]
        }
      }
    ]);
    expect(parsed?.guidance).toEqual([
      { code: "commit-point-passed", message: "Rollback is not offered." }
    ]);
    expect(parsed?.headline).toEqual({
      code: "stopped",
      title: "Stopped",
      message: "note"
    });
    expect(parsed?.activeCommandKind).toBe("rollback");
    expect(parsed?.nextTransition).toEqual({
      code: "stopping",
      message: "Stopping…"
    });
  });

  it.each([
    ["a non-array action list", { actions: "stop" }],
    ["a non-array guidance list", { guidance: 7 }]
  ])("reads %s as nothing to render", (_name, overrides) => {
    const parsed = parseOperationResponse(op(overrides));
    expect(parsed?.actions).toEqual([]);
    expect(parsed?.guidance).toEqual([]);
  });

  it("reads a malformed preview as no preview at all", () => {
    const parsed = parseOperationResponse(
      op({
        actions: [
          { id: "a", kind: "stop", path: "/api/x", preview: "not-a-preview" }
        ]
      })
    );
    expect(parsed?.actions[0].preview).toBeNull();
  });

  it.each([
    ["a malformed headline", { headline: "stopped" }],
    ["a malformed nextTransition", { nextTransition: 7 }]
  ])("reads %s as absent", (_name, overrides) => {
    const parsed = parseOperationResponse(op(overrides));
    expect(parsed?.headline ?? parsed?.nextTransition).toBeNull();
  });

  it("ignores a non-finite verification.dispatchedAt", () => {
    expect(
      parseOperationResponse(op({ verification: { dispatchedAt: "soon" } }))
        ?.verification
    ).toEqual({ dispatchedAt: null });
    expect(
      parseOperationResponse(op({ verification: { dispatchedAt: 12345 } }))
        ?.verification
    ).toEqual({ dispatchedAt: 12345 });
  });

  it("discards an inputRequired prompt with no code", () => {
    expect(
      parseOperationResponse(op({ inputRequired: { requestedAt: "now" } }))
        ?.inputRequired
    ).toBeNull();
  });

  it("filters malformed app picker candidates and reads metadata defaults", () => {
    const parsed = parseOperationResponse(
      op({
        inputRequired: {
          requestedAt: "2024-01-01T00:00:00.000Z",
          code: "app-selection-required",
          checkpoint: { step: 3 },
          metadata: {
            defaultAppId: "app-2",
            candidates: [
              { appId: "app-1", displayName: "First" },
              { appId: "app-3", createdDateTime: "2024-02-02T00:00:00.000Z" },
              { appId: "app-4", servesRepos: ["octo/widgets", "octo/gizmos"] },
              { notAnAppId: true },
              "not-an-object"
            ]
          }
        }
      })
    );
    expect(parsed?.inputRequired).toEqual({
      requestedAt: "2024-01-01T00:00:00.000Z",
      code: "app-selection-required",
      checkpoint: { step: 3 },
      candidates: [
        {
          appId: "app-1",
          displayName: "First",
          createdDateTime: undefined,
          servesRepos: undefined
        },
        {
          appId: "app-3",
          displayName: undefined,
          createdDateTime: "2024-02-02T00:00:00.000Z",
          servesRepos: undefined
        },
        {
          appId: "app-4",
          displayName: undefined,
          createdDateTime: undefined,
          servesRepos: ["octo/widgets", "octo/gizmos"]
        }
      ],
      defaultAppId: "app-2"
    });
  });
});

describe("parseVerifyStatus", () => {
  it("defaults every field for a malformed payload", () => {
    expect(parseVerifyStatus(null)).toEqual({
      state: "",
      terminal: false,
      error: "",
      runUrl: "",
      activity: ""
    });
  });

  it("reads a well-formed payload", () => {
    expect(
      parseVerifyStatus({
        state: "success",
        terminal: true,
        error: "",
        runUrl: "https://example.test/run",
        activity: "Checking credentials"
      })
    ).toEqual({
      state: "success",
      terminal: true,
      error: "",
      runUrl: "https://example.test/run",
      activity: "Checking credentials"
    });
  });
});

describe("initializeEnvironmentOperations bootstrap", () => {
  it("returns null when the progress panel is not on the page", () => {
    const browser = createFakeBrowser();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    expect(controller).toBeNull();
  });

  it("returns null for a second instance bound to the same context", () => {
    const browser = setup();
    const first = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    expect(first).not.toBeNull();
    const second = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    expect(second).toBeNull();
    expect(browser.bindings.has(ENVIRONMENT_OPERATIONS_ENTRY_KEY)).toBe(true);
  });

  it("hides the panel and stops tracking when the dismiss button is clicked", () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    expect(controller).not.toBeNull();
    controller?.renderProgress(record());
    expect(browser.els[PROGRESS_IDS.panel].style.display).toBe("");

    browser.els[PROGRESS_IDS.dismiss].dispatch("click");
    expect(browser.els[PROGRESS_IDS.panel].style.display).toBe("none");

    // A second click is a no-op, not a crash.
    browser.els[PROGRESS_IDS.dismiss].dispatch("click");
    expect(browser.els[PROGRESS_IDS.panel].style.display).toBe("none");
  });
});

describe("trackProgress rendering", () => {
  it("renders stage and step lists and clears them on the next render", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(
        op({
          stages: [
            { state: "succeeded", label: "Provision" },
            "not-a-stage",
            { state: "running", label: "Configure" }
          ],
          steps: [
            { state: "succeeded", label: "Create resource group" },
            { state: "running", label: "Create key vault" }
          ]
        })
      )
    );

    controller?.trackProgress("dev", "azure");
    await flushPromises();

    const stages = browser.els[PROGRESS_IDS.stages];
    expect(stages.children).toHaveLength(2);
    expect(stages.children[0].className).toBe(
      "env-progress__stage env-progress__stage--succeeded"
    );
    expect(stages.children[1].children[1].textContent).toBe(
      "Configure — running"
    );
    const steps = browser.els[PROGRESS_IDS.steps];
    expect(steps.children.map((child) => child.textContent)).toEqual([
      "✓ Create resource group",
      "◐ Create key vault"
    ]);
    expect(browser.els[PROGRESS_IDS.activity].textContent).toBe(
      "Create key vault"
    );

    controller?.renderProgress(record({ stages: [], steps: [] }));
    expect(browser.els[PROGRESS_IDS.stages].children).toHaveLength(0);
    expect(browser.els[PROGRESS_IDS.steps].children).toHaveLength(0);
  });

  it("falls back to a default glyph for an unrecognized stage or step state", () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    controller?.renderProgress(
      record({
        stages: [{ state: "quantum", label: "Provision" }],
        steps: [{ state: "quantum", label: "Create resource group" }]
      })
    );
    const stageGlyph = browser.els[PROGRESS_IDS.stages].children[0].children[0];
    expect(stageGlyph.textContent).toBe("○");
    expect(browser.els[PROGRESS_IDS.steps].children[0].textContent).toBe(
      "· Create resource group"
    );
  });

  it("prefers the last running step, then the last step, over the verify activity", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });

    controller?.renderProgress(
      record({
        currentStage: "verify",
        steps: [
          { state: "succeeded", label: "Step one" },
          { state: "running", label: "Step two running" }
        ]
      })
    );
    expect(browser.els[PROGRESS_IDS.activity].textContent).toBe(
      "Step two running"
    );

    controller?.renderProgress(
      record({
        currentStage: "verify",
        steps: [{ state: "succeeded", label: "Only step" }]
      })
    );
    expect(browser.els[PROGRESS_IDS.activity].textContent).toBe("Only step");
  });

  it("shows the verify activity only while on the verify stage with no terminal state", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(op({ currentStage: "verify", steps: [] }))
    );
    browser.net.handle(verifyUrl(REPO, "dev", "op-1"), () =>
      jsonResponse({ state: "pending", activity: "Waiting on GitHub Actions" })
    );

    controller?.trackProgress("dev", "azure");
    await flushPromises();
    expect(browser.els[PROGRESS_IDS.activity].textContent).toBe("");

    // The verify poll only starts once the main poller has seen no operation
    // record after already observing one; force that by returning nothing
    // next, then let the verify poll report activity that the next render
    // must fold in.
    browser.net.handle(operationsUrl(), () =>
      jsonResponse({ operation: null })
    );
    await tickClock(browser.clock, 1500);
    await flushPromises();
    expect(
      browser.net.calls.some((call) => call.url.startsWith(VERIFY_STATUS_PATH))
    ).toBe(true);
  });

  it("lets a failure message override the activity line", () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    controller?.renderProgress(
      record({
        steps: [{ state: "running", label: "Configuring" }],
        failure: { message: "Azure CLI exited 1" }
      })
    );
    expect(browser.els[PROGRESS_IDS.activity].textContent).toBe(
      "Azure CLI exited 1"
    );
  });

  it("never drives planned-graph navigation in any operation state", () => {
    const browser = setup();
    // A host page that still carries the retired link must not be revived by
    // the panel: the progress dialog narrates one operation and never sends
    // the customer to a different page mid-outcome.
    const retiredLink = createFakeElement("env-progress-resume");
    browser.document.add(retiredLink);
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });

    for (const terminalState of [
      null,
      "succeeded",
      "succeeded_with_warnings",
      "action_required",
      "failed",
      "failed_partial",
      "cancelled"
    ]) {
      controller?.renderProgress(
        record({
          terminalState,
          journey: {
            resumeTarget: {
              page: "planned",
              repo: "octo/widgets",
              branch: "feature/x"
            },
            resumeReason: "Back to the graph"
          }
        })
      );

      expect(retiredLink.getAttribute("href")).toBeNull();
      expect(retiredLink.textContent).toBe("");
      expect(retiredLink.style.display).toBe("");
    }
  });

  it("renders successful completion as a simple OK action", () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });

    controller?.renderProgress(record({ terminalState: null }));
    expect(browser.els[PROGRESS_IDS.dismiss].style.display).toBe("none");
    expect(browser.els[PROGRESS_IDS.actions].style.display).toBe("none");

    controller?.renderProgress(record({ terminalState: "succeeded" }));
    expect(browser.els[PROGRESS_IDS.partialState].style.display).toBe("none");
    expect(browser.els[PROGRESS_IDS.commandButtons].children).toHaveLength(0);
    expect(browser.els[PROGRESS_IDS.dismiss].style.display).toBe("");
    expect(browser.els[PROGRESS_IDS.dismiss].textContent).toBe("OK");
    expect(browser.els[PROGRESS_IDS.actions].style.display).toBe("flex");
  });

  it("hides stale terminal copy after success", () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });

    controller?.renderProgress(
      record({
        terminalState: "succeeded",
        guidance: [
          { code: "stale", message: "This should not appear after success." }
        ],
        nextTransition: {
          code: "monitoring-verification",
          message: "Still monitoring."
        }
      })
    );

    expect(browser.els[PROGRESS_IDS.actions].style.display).toBe("flex");
    expect(browser.els[PROGRESS_IDS.commandNote].textContent).toBe("");
    expect(browser.els[PROGRESS_IDS.commandGuidance].style.display).toBe(
      "none"
    );
  });

  it("renders nothing and hides the panel for a null operation", () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    controller?.renderProgress(record());
    expect(browser.els[PROGRESS_IDS.panel].style.display).toBe("");

    controller?.renderProgress(null);
    expect(browser.els[PROGRESS_IDS.panel].style.display).toBe("none");
    expect(browser.els[PROGRESS_IDS.failureCard].style.display).toBe("none");
  });
});

describe("verify status polling", () => {
  function primeVerifyPoll(
    browser: ReturnType<typeof setup>,
    controller: ReturnType<typeof initializeEnvironmentOperations>,
    overrides: Record<string, unknown> = {}
  ): Promise<void> {
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(op({ currentStage: "verify", steps: [], ...overrides }))
    );
    controller?.trackProgress("dev", "azure");
    return flushPromises().then(() => {
      browser.net.handle(operationsUrl(), () =>
        jsonResponse({ operation: null })
      );
    });
  }

  it("folds pending verify activity into the next render once the operation reappears", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    await primeVerifyPoll(browser, controller);
    // A pending poll with no activity text must not clear or corrupt the
    // (currently empty) tracked verify activity, then continue polling.
    browser.net.handle(verifyUrl(REPO, "dev", "op-1"), () =>
      jsonResponse({ state: "pending" })
    );
    await tickClock(browser.clock, 1500);
    expect(browser.els[PROGRESS_IDS.activity].textContent).toBe("");

    browser.net.handle(verifyUrl(REPO, "dev", "op-1"), () =>
      jsonResponse({ state: "pending", activity: "Waiting on GitHub Actions" })
    );
    await tickClock(browser.clock, 1500);
    expect(
      browser.net.calls.some((call) => call.url.startsWith(VERIFY_STATUS_PATH))
    ).toBe(true);

    browser.net.handle(operationsUrl(), () =>
      jsonResponse(op({ currentStage: "verify", steps: [] }))
    );
    await tickClock(browser.clock, 1500);

    expect(browser.els[PROGRESS_IDS.activity].textContent).toBe(
      "Verifying credentials — Waiting on GitHub Actions"
    );
  });

  it.each([
    ["expired", "", "Credential verification is no longer being tracked."],
    [
      "expired",
      "GitHub Actions run was deleted.",
      "GitHub Actions run was deleted."
    ],
    ["cancelled", "", "Credential verification is no longer being tracked."]
  ])(
    "stops polling on a terminal verify state %s (error=%s)",
    async (state, error, expectedActivity) => {
      const browser = setup();
      const controller = initializeEnvironmentOperations(browser.context, {
        repo: REPO,
        deps: createDeps().deps
      });
      await primeVerifyPoll(browser, controller);
      browser.net.handle(verifyUrl(REPO, "dev", "op-1"), () =>
        jsonResponse({ state, terminal: state !== "expired", error })
      );
      await tickClock(browser.clock, 1500);

      expect(browser.els[PROGRESS_IDS.activity].textContent).toBe(
        expectedActivity
      );
      expect(browser.clock.pending).toBe(0);
    }
  );

  it("stops polling once verification exceeds its tracking window", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    await primeVerifyPoll(browser, controller, {
      verification: { dispatchedAt: 1000 }
    });
    browser.net.handle(verifyUrl(REPO, "dev", "op-1"), () =>
      jsonResponse({ state: "pending" })
    );

    // Jump far past the 45-minute verification tracking window; only the
    // single already-scheduled poll timer fires during this synchronous jump.
    browser.clock.tick(46 * 60 * 1000);
    await flushPromises();

    expect(browser.els[PROGRESS_IDS.activity].textContent).toBe(
      "Credential verification exceeded its tracking window. Check the GitHub Actions run before retrying."
    );
    expect(browser.clock.pending).toBe(0);
  });

  it("shows a success banner and reloads the table when verification succeeds", async () => {
    const browser = setup();
    const deps = createDeps();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: deps.deps
    });
    await primeVerifyPoll(browser, controller);
    browser.net.handle(verifyUrl(REPO, "dev", "op-1"), () =>
      jsonResponse({ state: "success" })
    );
    await tickClock(browser.clock, 1500);

    expect(deps.successBanners).toEqual([
      { provider: "azure", environment: "dev" }
    ]);
    expect(deps.reloadCount).toBe(1);
    expect(browser.els[PROGRESS_IDS.panel].style.display).toBe("none");
  });

  it("defaults the success banner provider to azure when trackProgress was called without one", async () => {
    const browser = setup();
    const deps = createDeps();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: deps.deps
    });
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(op({ currentStage: "verify", steps: [], provider: "" }))
    );
    controller?.trackProgress("dev", "");
    await flushPromises();
    browser.net.handle(operationsUrl(), () =>
      jsonResponse({ operation: null })
    );
    browser.net.handle(verifyUrl(REPO, "dev", "op-1"), () =>
      jsonResponse({ state: "success" })
    );
    await tickClock(browser.clock, 1500);

    expect(deps.successBanners).toEqual([
      { provider: "azure", environment: "dev" }
    ]);
  });

  it("marks the panel failed with the run url when verification fails", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    await primeVerifyPoll(browser, controller);
    browser.net.handle(verifyUrl(REPO, "dev", "op-1"), () =>
      jsonResponse({
        state: "failed",
        error: "Actions run failed",
        runUrl: "https://github.test/octo/widgets/actions/runs/9"
      })
    );
    await tickClock(browser.clock, 1500);

    expect(
      browser.els[PROGRESS_IDS.panel].classList.contains("env-progress--failed")
    ).toBe(true);
    expect(browser.els[PROGRESS_IDS.activity].textContent).toBe(
      "Credential verification failed. Actions run failed"
    );
    expect(browser.els[PROGRESS_IDS.details].textContent).toBe(
      "View the run: https://github.test/octo/widgets/actions/runs/9"
    );
    expect(browser.clock.pending).toBe(0);
  });

  it("ignores a stale verify-status response that resolves after its session was superseded", async () => {
    const browser = setup();
    browser.net.supportsAbort = false;
    const deps = createDeps();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: deps.deps
    });
    await primeVerifyPoll(browser, controller);
    const verifyResponse = createDeferred<HttpResponse>();
    browser.net.handle(
      verifyUrl(REPO, "dev", "op-1"),
      () => verifyResponse.promise
    );
    await tickClock(browser.clock, 1500);

    // The verify request is now in flight; supersede the session before it
    // resolves. Disabling abort support means it is never rejected for the
    // session change, so it reaches pollVerifyStatus's own continuation
    // while genuinely stale.
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(
        op({
          environment: "staging",
          provider: "aws",
          summary: "Creating staging…"
        })
      )
    );
    controller?.trackProgress("staging", "aws");
    await flushPromises();
    const timeoutsBeforeStaleSettles = browser.clock.timeouts;

    verifyResponse.resolve(jsonResponse({ state: "success" }));
    await flushPromises();

    // The stale "dev" verify success must not fire a success banner for the
    // superseded session or schedule an extra continuation.
    expect(deps.successBanners).toEqual([]);
    expect(browser.clock.timeouts).toBe(timeoutsBeforeStaleSettles);
  });

  it("ignores a stale verify-status rejection that arrives after its session was superseded", async () => {
    const browser = setup();
    browser.net.supportsAbort = false;
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    await primeVerifyPoll(browser, controller);
    const verifyResponse = createDeferred<HttpResponse>();
    browser.net.handle(
      verifyUrl(REPO, "dev", "op-1"),
      () => verifyResponse.promise
    );
    await tickClock(browser.clock, 1500);

    browser.net.handle(operationsUrl(), () =>
      jsonResponse(
        op({
          environment: "staging",
          provider: "aws",
          summary: "Creating staging…"
        })
      )
    );
    controller?.trackProgress("staging", "aws");
    await flushPromises();
    const timeoutsBeforeStaleSettles = browser.clock.timeouts;

    verifyResponse.reject(new Error("network drop"));
    await flushPromises();

    // The stale rejection must not schedule its own extra continuation on
    // top of the current ("staging") session's timer.
    expect(browser.clock.timeouts).toBe(timeoutsBeforeStaleSettles);
  });
});

describe("failure card rendering", () => {
  it.each([
    ["running", undefined, "Cleanup is still running."],
    ["pending", undefined, "Cleanup has not started yet."],
    [
      "anything",
      false,
      "Cleanup stopped at the commit point, so reusable artifacts were left in place."
    ],
    ["succeeded_with_warnings", undefined, "Cleanup finished with warnings."],
    ["succeeded", undefined, "Cleanup finished."],
    ["skipped", undefined, "Cleanup was not needed."]
  ])(
    "summarizes cleanup state %s (rollbackBeforeCommit=%s) as %s",
    (state, rollbackBeforeCommit, expected) => {
      const browser = setup();
      const controller = initializeEnvironmentOperations(browser.context, {
        repo: REPO,
        deps: createDeps().deps
      });
      controller?.renderProgress(
        record({
          terminalState: "failed",
          failure: { message: "boom" },
          cleanup: { state, rollbackBeforeCommit }
        })
      );
      expect(browser.els[PROGRESS_IDS.cleanupStatus].textContent).toBe(
        expected
      );
    }
  );

  it("renders removed, retained, and warning lists and hides empty ones", () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    controller?.renderProgress(
      record({
        terminalState: "failed_partial",
        failure: { message: "" },
        cleanup: {
          state: "succeeded_with_warnings",
          retry: { startsCleanly: true, guidance: "Retry now." },
          removed: [{ target: "rg-dev" }],
          retained: [],
          warnings: ["disk snapshot left behind"]
        }
      })
    );
    expect(browser.els[PROGRESS_IDS.failureMessage].textContent).toBe(
      "The setup request failed."
    );
    expect(browser.els[PROGRESS_IDS.retry].textContent).toBe(
      "Retry starts cleanly: Yes. Retry now."
    );
    expect(browser.els[PROGRESS_IDS.cleanupRemovedBlock].style.display).toBe(
      ""
    );
    expect(
      browser.els[PROGRESS_IDS.cleanupRemovedList].children.map(
        (c) => c.textContent
      )
    ).toEqual(["rg-dev"]);
    expect(browser.els[PROGRESS_IDS.cleanupRetainedBlock].style.display).toBe(
      "none"
    );
    expect(browser.els[PROGRESS_IDS.cleanupWarningsBlock].style.display).toBe(
      ""
    );

    // Now flip which lists are populated to cover the retained-list branch too.
    controller?.renderProgress(
      record({
        terminalState: "failed_partial",
        failure: { message: "" },
        cleanup: {
          state: "succeeded_with_warnings",
          retry: {
            startsCleanly: false,
            guidance: "Check the deployment logs."
          },
          removed: [],
          retained: [{ target: "kv-dev" }],
          warnings: []
        }
      })
    );
    expect(browser.els[PROGRESS_IDS.retry].textContent).toBe(
      "Retry starts cleanly: No. Check the deployment logs."
    );
    expect(browser.els[PROGRESS_IDS.cleanupRemovedBlock].style.display).toBe(
      "none"
    );
    expect(browser.els[PROGRESS_IDS.cleanupRetainedBlock].style.display).toBe(
      ""
    );
    expect(
      browser.els[PROGRESS_IDS.cleanupRetainedList].children.map(
        (c) => c.textContent
      )
    ).toEqual(["kv-dev"]);
    expect(browser.els[PROGRESS_IDS.cleanupWarningsBlock].style.display).toBe(
      "none"
    );
  });

  it("clears a previous failure card when the operation is running again", () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    controller?.renderProgress(
      record({
        terminalState: "failed_partial",
        failure: { message: "Setup failed." },
        cleanup: {
          state: "succeeded_with_warnings",
          retry: { startsCleanly: false, guidance: "Review first." },
          removed: [{ target: "rg-dev" }],
          retained: [{ target: "kv-dev" }],
          warnings: ["A cleanup warning."]
        }
      })
    );
    expect(browser.els[PROGRESS_IDS.failureCard].style.display).toBe("");

    controller?.renderProgress(
      record({ state: "running", terminalState: null, cleanup: null })
    );

    expect(browser.els[PROGRESS_IDS.failureCard].style.display).toBe("none");
    expect(browser.els[PROGRESS_IDS.failureMessage].textContent).toBe("");
    expect(browser.els[PROGRESS_IDS.cleanupStatus].textContent).toBe("");
    expect(browser.els[PROGRESS_IDS.retry].textContent).toBe("");
    expect(browser.els[PROGRESS_IDS.cleanupWarningsList].children).toHaveLength(
      0
    );
    expect(browser.els[PROGRESS_IDS.cleanupRemovedList].children).toHaveLength(
      0
    );
    expect(browser.els[PROGRESS_IDS.cleanupRetainedList].children).toHaveLength(
      0
    );
  });

  it("hides the failure card outside the two failed terminal states", () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    controller?.renderProgress(record({ terminalState: "succeeded" }));
    expect(browser.els[PROGRESS_IDS.failureCard].style.display).toBe("none");
  });
});

describe("partial-state inventory", () => {
  function controllerFor(browser: ReturnType<typeof setup>) {
    return initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
  }

  it("names each surviving resource group in its own block", () => {
    const browser = setup();
    controllerFor(browser)?.renderProgress(
      record({
        terminalState: "failed_partial",
        cleanup: {
          created: [{ target: "app radius-dev" }],
          retainedArtifacts: [{ target: "ghcr package" }],
          reused: [{ target: "existing service principal" }],
          cleaned: [{ target: "federated credential" }],
          manualActionRequired: [
            { target: "role assignment", action: "Remove it in the portal" },
            { target: "orphaned app" }
          ]
        }
      })
    );

    expect(browser.els[PROGRESS_IDS.partialState].style.display).toBe("");
    const listed = (id: string): string[] =>
      browser.els[id].children.map((child) => child.textContent ?? "");
    expect(listed(PROGRESS_IDS.stateCreatedList)).toEqual(["app radius-dev"]);
    expect(listed(PROGRESS_IDS.stateRetainedList)).toEqual(["ghcr package"]);
    expect(listed(PROGRESS_IDS.stateReusedList)).toEqual([
      "existing service principal"
    ]);
    expect(listed(PROGRESS_IDS.stateCleanedList)).toEqual([
      "federated credential"
    ]);
    // A manual entry keeps its instruction attached to its resource, and one
    // without an instruction is still named rather than dropped.
    expect(listed(PROGRESS_IDS.stateManualList)).toEqual([
      "role assignment — Remove it in the portal",
      "orphaned app"
    ]);
    for (const id of [
      PROGRESS_IDS.stateCreatedBlock,
      PROGRESS_IDS.stateRetainedBlock,
      PROGRESS_IDS.stateReusedBlock,
      PROGRESS_IDS.stateCleanedBlock,
      PROGRESS_IDS.stateManualBlock
    ]) {
      expect(browser.els[id].style.display).toBe("");
    }
  });

  it("keeps the inventory out of sight while setup is still running", () => {
    const browser = setup();
    controllerFor(browser)?.renderProgress(
      record({
        terminalState: null,
        cleanup: { created: [{ target: "app radius-dev" }] }
      })
    );

    expect(browser.els[PROGRESS_IDS.partialState].style.display).toBe("none");
  });

  it("hides an empty group and the panel when nothing survives", () => {
    const browser = setup();
    controllerFor(browser)?.renderProgress(
      record({ terminalState: "failed", cleanup: { created: [] } })
    );

    expect(browser.els[PROGRESS_IDS.partialState].style.display).toBe("none");
    expect(browser.els[PROGRESS_IDS.stateCreatedBlock].style.display).toBe(
      "none"
    );
  });

  it("keeps only the populated groups visible", () => {
    const browser = setup();
    controllerFor(browser)?.renderProgress(
      record({
        terminalState: "failed",
        cleanup: { reused: [{ target: "existing app" }] }
      })
    );

    expect(browser.els[PROGRESS_IDS.partialState].style.display).toBe("");
    expect(browser.els[PROGRESS_IDS.stateReusedBlock].style.display).toBe("");
    expect(browser.els[PROGRESS_IDS.stateCreatedBlock].style.display).toBe(
      "none"
    );
  });

  it("clears the inventory when the panel is cleared", () => {
    const browser = setup();
    const controller = controllerFor(browser);
    controller?.renderProgress(
      record({
        terminalState: "failed",
        cleanup: { created: [{ target: "app radius-dev" }] }
      })
    );
    controller?.renderProgress(null);

    expect(browser.els[PROGRESS_IDS.partialState].style.display).toBe("none");
  });

  it("inserts a customer-influenced label as text, never as markup", () => {
    const browser = setup();
    controllerFor(browser)?.renderProgress(
      record({
        terminalState: "failed",
        cleanup: { created: [{ target: "<img src=x onerror=alert(1)>" }] }
      })
    );

    const list = browser.els[PROGRESS_IDS.stateCreatedList];
    expect(list.innerHTML).toBe("");
    expect(list.children[0].textContent).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("operation commands", () => {
  const stopAction = {
    id: "stop",
    kind: "stop",
    label: "Stop setup",
    description: "Radius finishes the current step and stops.",
    path: "/api/operations/op-1/stop",
    pending: false
  };

  function commandsController(browser: ReturnType<typeof setup>) {
    return initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      mutationNonce: "browser-nonce",
      deps: createDeps().deps
    });
  }

  function buttons(browser: ReturnType<typeof setup>) {
    return browser.els[PROGRESS_IDS.commandButtons].children;
  }

  it("renders exactly the actions the server projected", () => {
    const browser = setup();
    commandsController(browser)?.renderProgress(
      record({
        actions: [
          stopAction,
          {
            id: "retry-setup",
            kind: "retry_setup",
            label: "",
            description: "",
            path: "/api/operations/op-1/retry/setup",
            pending: true
          }
        ]
      })
    );

    expect(browser.els[PROGRESS_IDS.commands].style.display).toBe("");
    const rendered = buttons(browser);
    expect(rendered).toHaveLength(2);
    expect(rendered[0].id).toBe("env-progress-command-stop");
    expect(rendered[0].textContent).toBe("Stop setup");
    expect(rendered[0].getAttribute("type")).toBe("button");
    expect(rendered[0].className).toBe("rad-btn rad-btn--secondary");
    // A label the server did not name still gets an honest default rather
    // than an empty button, and a pending action cannot be pressed twice.
    expect(rendered[1].textContent).toBe("Continue");
    expect(Reflect.get(rendered[1], "disabled")).toBe(true);
    expect(browser.els[PROGRESS_IDS.commandNote].textContent).toBe(
      "Radius finishes the current step and stops."
    );
  });

  it("places keep-and-dismiss beside retry verification for a terminal failure", () => {
    const browser = setup();
    commandsController(browser)?.renderProgress(
      record({
        state: "failed_partial",
        terminalState: "failed_partial",
        actions: [
          {
            id: "retry-verification",
            kind: "retry_verification",
            label: "Retry verification",
            description: "Check the same workflow again.",
            path: "/api/operations/op-1/retry/verification",
            pending: false
          }
        ]
      })
    );

    const rendered = buttons(browser);
    expect(rendered.map((button) => button.textContent)).toEqual([
      "Retry verification",
      "Keep resources and dismiss"
    ]);
    expect(browser.els[PROGRESS_IDS.dismiss].style.display).toBe("none");

    rendered[1].dispatch("click");

    expect(browser.els[PROGRESS_IDS.panel].style.display).toBe("none");
  });

  it("drops an action with no path rather than rendering a button that can only fail", () => {
    const browser = setup();
    commandsController(browser)?.renderProgress(
      record({ actions: [{ ...stopAction, path: "" }] })
    );

    expect(buttons(browser)).toHaveLength(0);
    expect(browser.els[PROGRESS_IDS.commands].style.display).toBe("none");
  });

  it("states the automatic next move when there is nothing to press", () => {
    const browser = setup();
    commandsController(browser)?.renderProgress(
      record({
        actions: [],
        nextTransition: { code: "stopping", message: "Stopping soon…" }
      })
    );

    // A record with no actions still has something to say, so the region
    // stays visible rather than leaving the customer watching a spinner.
    expect(browser.els[PROGRESS_IDS.commands].style.display).toBe("");
    expect(browser.els[PROGRESS_IDS.commandNote].textContent).toBe(
      "Stopping soon…"
    );
  });

  it("hides the region when there is neither an action nor anything to say", () => {
    const browser = setup();
    commandsController(browser)?.renderProgress(record({ actions: [] }));

    expect(browser.els[PROGRESS_IDS.commands].style.display).toBe("none");
    expect(browser.els[PROGRESS_IDS.commandNote].textContent).toBe("");
  });

  it("leads the note with the automatic next move when actions are offered", () => {
    const browser = setup();
    commandsController(browser)?.renderProgress(
      record({
        actions: [stopAction],
        nextTransition: { code: "stopping", message: "Stopping soon…" }
      })
    );

    expect(browser.els[PROGRESS_IDS.commandNote].textContent).toBe(
      "Stopping soon… Radius finishes the current step and stops."
    );
  });

  it("announces a stop that the server has already accepted", () => {
    const browser = setup();
    commandsController(browser)?.renderProgress(
      record({ actions: [{ ...stopAction, pending: true }] })
    );

    expect(browser.els[PROGRESS_IDS.commandStatus].textContent).toBe(
      "Stopping after the current step…"
    );
  });

  it("clears a stale status and error when a different operation takes over", () => {
    const browser = setup();
    const controller = commandsController(browser);
    controller?.renderProgress(
      record({ actions: [{ ...stopAction, pending: true }] })
    );
    browser.els[PROGRESS_IDS.commandError].textContent = "old refusal";

    controller?.renderProgress(
      record({ operationId: "op-2", actions: [stopAction] })
    );

    expect(browser.els[PROGRESS_IDS.commandError].textContent).toBe("");
    expect(browser.els[PROGRESS_IDS.commandStatus].textContent).toBe("");
  });

  it("submits the projected path and follows the reopened operation", async () => {
    const browser = setup();
    const controller = commandsController(browser);
    browser.net.handle(stopAction.path, () =>
      jsonResponse(op({ state: "stopping" }))
    );
    browser.net.handle(operationsUrl(), () => jsonResponse(op()));
    controller?.renderProgress(record({ actions: [stopAction] }));

    buttons(browser)[0].dispatch("click");
    await flushPromises();

    const submitted = browser.net.calls.find(
      (call) => call.url === stopAction.path
    );
    expect(submitted?.init?.method).toBe("POST");
    expect(submitted?.init?.body).toBe("{}");
    // Every control is a POST the server treats as nonce-required, so the
    // browser's mutation nonce rides along or the command is refused as
    // untrusted before the handler ever sees it.
    expect(submitted?.init?.headers).toEqual({
      "Content-Type": "application/json",
      "X-Radius-Mutation-Nonce": "browser-nonce"
    });
    // Following the same operation is what keeps the panel live after a
    // command reopens the record.
    expect(browser.clock.intervals).toBe(1);
  });

  it("reports a terminal result instead of rejoining the poller", async () => {
    const browser = setup();
    const deps = createDeps();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: deps.deps
    });
    browser.net.handle(stopAction.path, () =>
      jsonResponse(op({ terminalState: "cancelled", state: "cancelled" }))
    );
    controller?.renderProgress(record({ actions: [stopAction] }));

    buttons(browser)[0].dispatch("click");
    await flushPromises();

    expect(browser.els[PROGRESS_IDS.activity].textContent).toBe(
      "Environment setup cancelled."
    );
    expect(browser.clock.intervals).toBe(0);
    expect(deps.reloadCount).toBe(1);
  });

  it("re-reads the operation directly when there is no repository to track", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: "",
      deps: createDeps().deps
    });
    browser.net.handle(stopAction.path, () =>
      jsonResponse({ operation: null })
    );
    browser.net.handle(operationUrl("op-1"), () =>
      jsonResponse(op({ summary: "Stopping dev…" }))
    );
    controller?.renderProgress(record({ actions: [stopAction] }));

    buttons(browser)[0].dispatch("click");
    await flushPromises();

    expect(browser.els[PROGRESS_IDS.title].textContent).toBe("Stopping dev…");
    expect(browser.clock.intervals).toBe(0);
  });

  it("says nothing about a direct re-read the server refused", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: "",
      deps: createDeps().deps
    });
    browser.net.handle(stopAction.path, () =>
      jsonResponse({ operation: null })
    );
    browser.net.handle(operationUrl("op-1"), () =>
      jsonResponse({ error: "gone" }, false, 404)
    );
    controller?.renderProgress(record({ actions: [stopAction] }));

    buttons(browser)[0].dispatch("click");
    await flushPromises();

    expect(browser.els[PROGRESS_IDS.commandError].textContent).toBe("");
  });

  it("keeps a rejected re-read out of the panel", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: "",
      deps: createDeps().deps
    });
    browser.net.handle(stopAction.path, () =>
      jsonResponse({ operation: null })
    );
    browser.net.handle(operationUrl("op-1"), () =>
      Promise.reject(new Error("offline"))
    );
    controller?.renderProgress(record({ actions: [stopAction] }));

    buttons(browser)[0].dispatch("click");
    await flushPromises();

    expect(browser.els[PROGRESS_IDS.commandError].textContent).toBe("");
  });

  it("drops a malformed action entry rather than rendering a broken control", () => {
    const browser = setup();
    commandsController(browser)?.renderProgress(
      record({ actions: ["not-an-action", null, stopAction] })
    );

    expect(buttons(browser)).toHaveLength(1);
    expect(buttons(browser)[0].id).toBe("env-progress-command-stop");
  });

  it("still submits when the status and error regions are absent", async () => {
    const browser = setupWithout([
      PROGRESS_IDS.commandStatus,
      PROGRESS_IDS.commandError
    ]);
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    browser.net.handle(stopAction.path, () =>
      jsonResponse({ operation: null })
    );
    controller?.renderProgress(record({ actions: [stopAction] }));

    browser.els[PROGRESS_IDS.commandButtons].children[0].dispatch("click");
    await flushPromises();

    expect(browser.net.calls.some((call) => call.url === stopAction.path)).toBe(
      true
    );
  });

  it("still submits when the command container itself is absent", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    browser.net.handle(stopAction.path, () =>
      jsonResponse({ operation: null })
    );
    controller?.renderProgress(record({ actions: [stopAction] }));
    const button = browser.els[PROGRESS_IDS.commandButtons].children[0];
    // The container can disappear between render and click when the host page
    // re-renders around the panel; the command must still reach the server.
    browser.document.remove(PROGRESS_IDS.commands);

    button.dispatch("click");
    await flushPromises();

    expect(browser.net.calls.some((call) => call.url === stopAction.path)).toBe(
      true
    );
  });

  it("surfaces the server's own refusal and returns focus to the panel", async () => {
    const browser = setup();
    const controller = commandsController(browser);
    browser.net.handle(stopAction.path, () =>
      jsonResponse(
        { error: "operation-already-terminal", ...op({ state: "failed" }) },
        false,
        409
      )
    );
    controller?.renderProgress(record({ actions: [stopAction] }));

    buttons(browser)[0].dispatch("click");
    await flushPromises();

    expect(browser.els[PROGRESS_IDS.commandError].textContent).toBe(
      "operation-already-terminal"
    );
    expect(browser.els[PROGRESS_IDS.commandStatus].textContent).toBe("");
    expect(browser.els[PROGRESS_IDS.panel].focusCount).toBe(1);
  });

  it("never invents a cause for a refusal the server did not explain", async () => {
    const browser = setup();
    const controller = commandsController(browser);
    browser.net.handle(stopAction.path, () => jsonResponse({}, false, 500));
    controller?.renderProgress(record({ actions: [stopAction] }));

    buttons(browser)[0].dispatch("click");
    await flushPromises();

    expect(browser.els[PROGRESS_IDS.commandError].textContent).toBe(
      "Radius could not accept that request."
    );
  });

  it("treats an unreadable refusal body as an unexplained refusal", async () => {
    const browser = setup();
    const controller = commandsController(browser);
    browser.net.handle(stopAction.path, () => textResponse("<html>", false));
    controller?.renderProgress(record({ actions: [stopAction] }));

    buttons(browser)[0].dispatch("click");
    await flushPromises();

    expect(browser.els[PROGRESS_IDS.commandError].textContent).toBe(
      "Radius could not accept that request."
    );
  });

  it("reports an unreachable setup service without closing the panel", async () => {
    const browser = setup();
    const controller = commandsController(browser);
    browser.net.handle(stopAction.path, () =>
      Promise.reject(new Error("offline"))
    );
    controller?.renderProgress(record({ actions: [stopAction] }));

    buttons(browser)[0].dispatch("click");
    await flushPromises();

    expect(browser.els[PROGRESS_IDS.commandError].textContent).toBe(
      "Radius could not reach the setup service. Try again."
    );
    expect(browser.els[PROGRESS_IDS.panel].style.display).toBe("");
  });

  it("disables the controls while a command is in flight and ignores a second press", async () => {
    const browser = setup();
    const controller = commandsController(browser);
    const pending = createDeferred<HttpResponse>();
    let submissions = 0;
    browser.net.handle(stopAction.path, () => {
      submissions += 1;
      return pending.promise;
    });
    controller?.renderProgress(record({ actions: [stopAction] }));

    buttons(browser)[0].dispatch("click");
    await flushPromises();

    expect(browser.els[PROGRESS_IDS.commands].getAttribute("aria-busy")).toBe(
      "true"
    );
    expect(Reflect.get(buttons(browser)[0], "disabled")).toBe(true);
    expect(browser.els[PROGRESS_IDS.commandStatus].textContent).toBe(
      "Stopping after the current step…"
    );

    buttons(browser)[0].dispatch("click");
    await flushPromises();
    expect(submissions).toBe(1);

    pending.resolve(jsonResponse({ operation: null }));
    await flushPromises();
    expect(browser.els[PROGRESS_IDS.commands].getAttribute("aria-busy")).toBe(
      "false"
    );
  });

  it("announces a non-stop command without borrowing the stop wording", async () => {
    const browser = setup();
    const controller = commandsController(browser);
    const pending = createDeferred<HttpResponse>();
    browser.net.handle(
      "/api/operations/op-1/retry/setup",
      () => pending.promise
    );
    controller?.renderProgress(
      record({
        actions: [
          {
            ...stopAction,
            id: "retry-setup",
            kind: "retry_setup",
            label: "Retry setup",
            path: "/api/operations/op-1/retry/setup"
          }
        ]
      })
    );

    buttons(browser)[0].dispatch("click");
    await flushPromises();

    expect(browser.els[PROGRESS_IDS.commandStatus].textContent).toBe(
      "Retrying setup…"
    );
    pending.resolve(jsonResponse({ operation: null }));
    await flushPromises();
  });

  it("falls back to the general acceptance sentence for an unknown command", async () => {
    const browser = setup();
    const controller = commandsController(browser);
    const pending = createDeferred<HttpResponse>();
    browser.net.handle("/api/operations/op-1/unknown", () => pending.promise);
    controller?.renderProgress(
      record({
        actions: [
          {
            ...stopAction,
            id: "unknown",
            kind: "something-new",
            path: "/api/operations/op-1/unknown"
          }
        ]
      })
    );

    buttons(browser)[0].dispatch("click");
    await flushPromises();

    expect(browser.els[PROGRESS_IDS.commandStatus].textContent).toBe(
      "Radius accepted the request…"
    );
    pending.resolve(jsonResponse({ operation: null }));
    await flushPromises();
  });

  it("degrades quietly when the command region is not on the page", () => {
    const browser = setupWithout([
      PROGRESS_IDS.commands,
      PROGRESS_IDS.commandButtons,
      PROGRESS_IDS.commandNote,
      PROGRESS_IDS.partialState
    ]);
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });

    expect(() =>
      controller?.renderProgress(record({ actions: [stopAction] }))
    ).not.toThrow();
  });

  it("skips a partial-state group whose block is missing", () => {
    const browser = setupWithout([PROGRESS_IDS.stateCreatedBlock]);
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    controller?.renderProgress(
      record({
        terminalState: "failed",
        cleanup: { created: [{ target: "app radius-dev" }] }
      })
    );

    expect(browser.els[PROGRESS_IDS.partialState].style.display).toBe("none");
  });

  it("releases command button listeners on teardown", () => {
    const browser = setup();
    const controller = commandsController(browser);
    controller?.renderProgress(record({ actions: [stopAction] }));
    const button = buttons(browser)[0];
    controller?.teardown();

    button.dispatch("click");

    expect(browser.net.calls.some((call) => call.url === stopAction.path)).toBe(
      false
    );
  });

  it.each([
    ["primary", "rad-btn rad-btn--primary"],
    ["danger", "rad-btn rad-btn--danger"],
    ["neutral", "rad-btn rad-btn--secondary"],
    ["", "rad-btn rad-btn--secondary"]
  ])("renders the %s tone the server chose", (tone, expected) => {
    const browser = setup();
    commandsController(browser)?.renderProgress(
      record({ actions: [{ ...stopAction, tone }] })
    );

    expect(buttons(browser)[0].className).toBe(expected);
  });

  it("explains why a path the customer might expect is missing", () => {
    const browser = setup();
    commandsController(browser)?.renderProgress(
      record({
        actions: [],
        guidance: [
          { code: "commit-point-passed", message: "Rollback is not offered." },
          { code: "", message: "" }
        ]
      })
    );

    const guidance = browser.els[PROGRESS_IDS.commandGuidance];
    expect(guidance.style.display).toBe("");
    expect(guidance.children.map((child) => child.textContent)).toEqual([
      "Rollback is not offered."
    ]);
    // Guidance alone is reason enough to keep the region on screen.
    expect(browser.els[PROGRESS_IDS.commands].style.display).toBe("");
  });

  it("clears the guidance list once the record has nothing left to explain", () => {
    const browser = setup();
    const controller = commandsController(browser);
    controller?.renderProgress(
      record({
        actions: [],
        guidance: [{ code: "x", message: "Rollback is not offered." }]
      })
    );
    controller?.renderProgress(record({ operationId: "op-2", actions: [] }));

    expect(browser.els[PROGRESS_IDS.commandGuidance].style.display).toBe(
      "none"
    );
    expect(browser.els[PROGRESS_IDS.commandGuidance].children).toHaveLength(0);
  });
});

describe("previewResourceLabel", () => {
  it.each([
    ["azure_app", "App Registration: radius-dev"],
    ["service_principal", "Service Principal: radius-dev"],
    ["federated_credential", "Federated credential: radius-dev"],
    ["role_assignment", "Role assignment: radius-dev"],
    ["github_environment", "GitHub environment: radius-dev"],
    ["workflow_file", "Workflow file: radius-dev"]
  ])("names a %s in the customer's terms", (kind, expected) => {
    expect(
      previewResourceLabel({ kind, target: "radius-dev", action: "" })
    ).toBe(expected);
  });

  it("degrades an unfamiliar kind to a generic noun rather than leaking it", () => {
    expect(
      previewResourceLabel({ kind: "aks_cluster", target: "dev", action: "" })
    ).toBe("Resource: dev");
  });
});

describe("rollback confirmation", () => {
  const rollbackAction = {
    id: "rollback",
    kind: "rollback",
    label: "Roll back created resources",
    description: "This cannot be undone.",
    path: "/api/operations/op-1/rollback",
    pending: false,
    tone: "danger",
    requiresConfirmation: true,
    confirmTitle: "Roll back resources created by this setup?",
    confirmLabel: "Roll back resources",
    cancelLabel: "Keep resources",
    preview: {
      removes: [{ kind: "azure_app", target: "radius-dev" }],
      keeps: [{ kind: "service_principal", target: "existing-sp" }],
      manualActionRequired: [
        { kind: "role_assignment", target: "Contributor", action: "Remove it" }
      ]
    }
  };

  function open(browser: ReturnType<typeof setup>) {
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    controller?.renderProgress(record({ actions: [rollbackAction] }));
    browser.els[PROGRESS_IDS.commandButtons].children[0].dispatch("click");
    return controller;
  }

  it("confirms a destructive command before anything is sent", () => {
    const browser = setup();
    open(browser);

    expect(browser.els[ROLLBACK_IDS.modal].style.display).toBe("flex");
    expect(browser.net.calls).toHaveLength(0);
    expect(browser.els[ROLLBACK_IDS.title].textContent).toBe(
      "Roll back resources created by this setup?"
    );
    expect(browser.els[ROLLBACK_IDS.intro].textContent).toBe(
      "This cannot be undone."
    );
    // Each entry is named in the customer's terms, not the ledger's.
    expect(
      browser.els[ROLLBACK_IDS.removeList].children.map(
        (child) => child.textContent
      )
    ).toEqual(["App Registration: radius-dev"]);
    expect(
      browser.els[ROLLBACK_IDS.keepList].children.map(
        (child) => child.textContent
      )
    ).toEqual(["Service Principal: existing-sp"]);
    expect(
      browser.els[ROLLBACK_IDS.manualList].children.map(
        (child) => child.textContent
      )
    ).toEqual(["Role assignment: Contributor — Remove it"]);
    expect(browser.els[ROLLBACK_IDS.confirm].textContent).toBe(
      "Roll back resources"
    );
    expect(browser.els[ROLLBACK_IDS.cancel].textContent).toBe("Keep resources");
    expect(
      browser.els[PROGRESS_IDS.commandButtons].children[0].getAttribute(
        "aria-haspopup"
      )
    ).toBe("dialog");
  });

  it("renders the post-commit rollback in the server's own words", () => {
    // After the workflow commit point the destructive command promises more —
    // a revert commit in the customer's repository — so the dialog must show
    // the server's wording and the workflow files it names, never a local
    // rebuild of either.
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    controller?.renderProgress(
      record({
        actions: [
          {
            ...rollbackAction,
            label: "Roll back environment setup",
            confirmTitle: "Roll back this environment setup?",
            confirmLabel: "Roll back setup",
            description:
              "Radius reverts the workflow files it committed with a new commit.",
            preview: {
              removes: [
                {
                  kind: "workflow_file",
                  target:
                    ".github/workflows/radius-verify-credentials.yml on main"
                },
                { kind: "github_environment", target: "contoso/store:dev" },
                { kind: "azure_app", target: "radius-dev" }
              ],
              keeps: [],
              manualActionRequired: []
            }
          }
        ]
      })
    );
    const trigger = browser.els[PROGRESS_IDS.commandButtons].children[0];
    expect(trigger.textContent).toBe("Roll back environment setup");
    trigger.dispatch("click");

    expect(browser.els[ROLLBACK_IDS.title].textContent).toBe(
      "Roll back this environment setup?"
    );
    expect(browser.els[ROLLBACK_IDS.confirm].textContent).toBe(
      "Roll back setup"
    );
    // The workflow files are listed first, in the order the server will act.
    expect(
      browser.els[ROLLBACK_IDS.removeList].children.map(
        (child) => child.textContent
      )
    ).toEqual([
      "Workflow file: .github/workflows/radius-verify-credentials.yml on main",
      "GitHub environment: contoso/store:dev",
      "App Registration: radius-dev"
    ]);
    expect(browser.els[ROLLBACK_IDS.keepBlock].style.display).toBe("none");
    expect(browser.net.calls).toHaveLength(0);
  });

  it("names its own defaults when the server left the wording out", () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    controller?.renderProgress(
      record({
        actions: [
          {
            ...rollbackAction,
            confirmTitle: "",
            confirmLabel: "",
            cancelLabel: "",
            preview: undefined
          }
        ]
      })
    );
    browser.els[PROGRESS_IDS.commandButtons].children[0].dispatch("click");

    expect(browser.els[ROLLBACK_IDS.title].textContent).toBe(
      "Roll back resources created by this setup?"
    );
    expect(browser.els[ROLLBACK_IDS.confirm].textContent).toBe(
      "Roll back resources"
    );
    expect(browser.els[ROLLBACK_IDS.cancel].textContent).toBe("Keep resources");
    expect(browser.els[ROLLBACK_IDS.removeBlock].style.display).toBe("none");
  });

  it("sends the command only once the customer confirms", async () => {
    const browser = setup();
    browser.net.handle(rollbackAction.path, () =>
      jsonResponse({ operation: null })
    );
    browser.net.handle(operationsUrl(), () => jsonResponse(op()));
    open(browser);

    browser.els[ROLLBACK_IDS.confirm].dispatch("click");
    await flushPromises();

    expect(
      browser.net.calls.some((call) => call.url === rollbackAction.path)
    ).toBe(true);
    expect(browser.els[ROLLBACK_IDS.modal].style.display).toBe("none");
    expect(Reflect.get(browser.els[ROLLBACK_IDS.confirm], "disabled")).toBe(
      true
    );
  });

  it("sends nothing when the customer keeps the resources", () => {
    const browser = setup();
    open(browser);

    browser.els[ROLLBACK_IDS.cancel].dispatch("click");

    expect(browser.els[ROLLBACK_IDS.modal].style.display).toBe("none");
    expect(browser.net.calls).toHaveLength(0);
    // Focus goes back to the control that opened the dialog.
    expect(
      browser.els[PROGRESS_IDS.commandButtons].children[0].focusCount
    ).toBe(1);
  });

  it("ignores a confirmation that no longer has a pending command", () => {
    const browser = setup();
    open(browser);
    browser.els[ROLLBACK_IDS.cancel].dispatch("click");

    browser.els[ROLLBACK_IDS.confirm].dispatch("click");

    expect(browser.net.calls).toHaveLength(0);
  });

  it("closes on Escape and traps Tab inside the dialog", () => {
    const browser = setup();
    const dialog = browser.els[ROLLBACK_IDS.modal];
    const cancel = browser.els[ROLLBACK_IDS.cancel];
    const confirm = browser.els[ROLLBACK_IDS.confirm];
    dialog.matches.set("button:not([disabled])", [cancel, confirm]);
    open(browser);

    browser.document.activeElement = confirm;
    browser.document.dispatch("keydown", { key: "Tab" });
    expect(cancel.focusCount).toBe(1);

    browser.document.activeElement = cancel;
    browser.document.dispatch("keydown", { key: "Tab", shiftKey: true });
    expect(confirm.focusCount).toBe(1);

    browser.document.dispatch("keydown", { key: "Enter" });
    expect(dialog.style.display).toBe("flex");

    browser.document.dispatch("keydown", { key: "Escape" });
    expect(dialog.style.display).toBe("none");
  });

  it("leaves a Tab alone when the dialog exposes nothing focusable", () => {
    const browser = setup();
    browser.els[ROLLBACK_IDS.modal].matches.set("button:not([disabled])", []);
    open(browser);

    expect(() =>
      browser.document.dispatch("keydown", { key: "Tab" })
    ).not.toThrow();
  });

  it("ignores the key trap once the dialog markup is gone", () => {
    const browser = setup();
    open(browser);
    browser.document.remove(ROLLBACK_IDS.modal);

    expect(() =>
      browser.document.dispatch("keydown", { key: "Escape" })
    ).not.toThrow();
  });

  it("refuses the command outright when there is no confirmation to show", () => {
    const browser = setupWithout([ROLLBACK_IDS.modal]);
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    controller?.renderProgress(record({ actions: [rollbackAction] }));

    browser.els[PROGRESS_IDS.commandButtons].children[0].dispatch("click");

    expect(browser.els[PROGRESS_IDS.commandError].textContent).toBe(
      "Radius could not open the rollback confirmation."
    );
    expect(browser.net.calls).toHaveLength(0);
  });

  it("unbinds the key trap on teardown", () => {
    const browser = setup();
    const controller = open(browser);
    controller?.teardown();

    browser.document.dispatch("keydown", { key: "Escape" });

    expect(browser.els[ROLLBACK_IDS.modal].style.display).toBe("flex");
  });

  it("binds the key trap once across repeated openings", () => {
    const browser = setup();
    const controller = open(browser);
    browser.els[ROLLBACK_IDS.cancel].dispatch("click");
    browser.els[PROGRESS_IDS.commandButtons].children[0].dispatch("click");
    controller?.teardown();

    browser.document.dispatch("keydown", { key: "Escape" });

    expect(browser.els[ROLLBACK_IDS.modal].style.display).toBe("flex");
  });

  it("leaves focus alone for a Tab that is already mid-dialog", () => {
    const browser = setup();
    const cancel = browser.els[ROLLBACK_IDS.cancel];
    const confirm = browser.els[ROLLBACK_IDS.confirm];
    const middle = createFakeElement("env-rollback-extra");
    browser.els[ROLLBACK_IDS.modal].matches.set("button:not([disabled])", [
      cancel,
      middle,
      confirm
    ]);
    open(browser);

    browser.document.activeElement = middle;
    browser.document.dispatch("keydown", { key: "Tab" });
    browser.document.dispatch("keydown", { key: "Tab", shiftKey: true });

    expect(cancel.focusCount).toBe(0);
    expect(confirm.focusCount).toBe(0);
  });

  it("wraps a Shift+Tab that starts with nothing focused", () => {
    const browser = setup();
    const cancel = browser.els[ROLLBACK_IDS.cancel];
    const confirm = browser.els[ROLLBACK_IDS.confirm];
    browser.els[ROLLBACK_IDS.modal].matches.set("button:not([disabled])", [
      cancel,
      confirm
    ]);
    open(browser);

    browser.document.activeElement = null;
    browser.document.dispatch("keydown", { key: "Tab", shiftKey: true });

    expect(confirm.focusCount).toBe(1);
  });

  it("ignores a second press while the confirmed command is in flight", async () => {
    const browser = setup();
    const pending = createDeferred<HttpResponse>();
    let submissions = 0;
    browser.net.handle(rollbackAction.path, () => {
      submissions += 1;
      return pending.promise;
    });
    open(browser);
    browser.els[ROLLBACK_IDS.confirm].dispatch("click");
    await flushPromises();

    browser.els[PROGRESS_IDS.commandButtons].children[0].dispatch("click");
    await flushPromises();

    expect(submissions).toBe(1);
    expect(browser.els[ROLLBACK_IDS.modal].style.display).toBe("none");
    pending.resolve(jsonResponse({ operation: null }));
    await flushPromises();
  });

  it("opens without the optional dialog copy elements", () => {
    const browser = setupWithout([
      ROLLBACK_IDS.title,
      ROLLBACK_IDS.intro,
      ROLLBACK_IDS.cancel,
      ROLLBACK_IDS.confirm
    ]);
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    controller?.renderProgress(record({ actions: [rollbackAction] }));

    browser.els[PROGRESS_IDS.commandButtons].children[0].dispatch("click");

    expect(browser.els[ROLLBACK_IDS.modal].style.display).toBe("flex");
    expect(() =>
      browser.document.dispatch("keydown", { key: "Escape" })
    ).not.toThrow();
  });

  it("names a manual preview entry that carries no instruction", () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    controller?.renderProgress(
      record({
        actions: [
          {
            ...rollbackAction,
            preview: {
              removes: [],
              keeps: [],
              manualActionRequired: [
                { kind: "role_assignment", target: "Contributor" }
              ]
            }
          }
        ]
      })
    );
    browser.els[PROGRESS_IDS.commandButtons].children[0].dispatch("click");

    expect(
      browser.els[ROLLBACK_IDS.manualList].children.map(
        (child) => child.textContent
      )
    ).toEqual(["Role assignment: Contributor"]);
  });

  it("keeps one key trap when the dialog is reopened without closing", () => {
    const browser = setup();
    const controller = open(browser);
    // Reopening replaces the pending command; it must not stack a second
    // document-level key listener that would then survive teardown.
    browser.els[PROGRESS_IDS.commandButtons].children[0].dispatch("click");
    controller?.teardown();

    browser.document.dispatch("keydown", { key: "Escape" });

    expect(browser.els[ROLLBACK_IDS.modal].style.display).toBe("flex");
  });

  it("confirms without the dialog or its confirm control still in the document", async () => {
    const browser = setup();
    browser.net.handle(rollbackAction.path, () =>
      jsonResponse({ operation: null })
    );
    browser.net.handle(operationsUrl(), () => jsonResponse(op()));
    open(browser);
    const confirm = browser.els[ROLLBACK_IDS.confirm];
    browser.document.remove(ROLLBACK_IDS.modal);
    browser.document.remove(ROLLBACK_IDS.confirm);

    confirm.dispatch("click");
    await flushPromises();

    expect(
      browser.net.calls.some((call) => call.url === rollbackAction.path)
    ).toBe(true);
  });

  it("drops a confirmation that raced a command already in flight", async () => {
    const browser = setup();
    const pending = createDeferred<HttpResponse>();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    browser.net.handle("/api/operations/op-1/stop", () => pending.promise);
    controller?.renderProgress(
      record({
        actions: [
          rollbackAction,
          {
            id: "stop",
            kind: "stop",
            label: "Stop setup",
            description: "",
            path: "/api/operations/op-1/stop",
            pending: false
          }
        ]
      })
    );
    // Open the destructive confirmation, then let the non-destructive command
    // start underneath it.
    browser.els[PROGRESS_IDS.commandButtons].children[0].dispatch("click");
    browser.els[PROGRESS_IDS.commandButtons].children[1].dispatch("click");
    await flushPromises();

    browser.els[ROLLBACK_IDS.confirm].dispatch("click");
    await flushPromises();

    expect(
      browser.net.calls.some((call) => call.url === rollbackAction.path)
    ).toBe(false);
    pending.resolve(jsonResponse({ operation: null }));
    await flushPromises();
  });
});

describe("headline and rollback outcomes", () => {
  function controllerFor(browser: ReturnType<typeof setup>) {
    return initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
  }

  it("gives a state that needs its own words a heading and a note", () => {
    const browser = setup();
    controllerFor(browser)?.renderProgress(
      record({
        summary: "Creating dev…",
        headline: {
          code: "rolling-back",
          title: "Rolling back created resources…",
          message: "Radius is removing what it created."
        },
        activeCommandKind: "rollback"
      })
    );

    expect(browser.els[PROGRESS_IDS.title].textContent).toBe(
      "Rolling back created resources…"
    );
    expect(browser.els[PROGRESS_IDS.headlineNote].textContent).toBe(
      "Radius is removing what it created."
    );
    expect(browser.els[PROGRESS_IDS.headlineNote].style.display).toBe("");
    expect(
      browser.els[PROGRESS_IDS.panel].classList.contains(
        "env-progress--cleaning"
      )
    ).toBe(true);
  });

  it("keeps the plain summary and hides the note when there is no headline", () => {
    const browser = setup();
    controllerFor(browser)?.renderProgress(
      record({ summary: "Creating dev…" })
    );

    expect(browser.els[PROGRESS_IDS.title].textContent).toBe("Creating dev…");
    expect(browser.els[PROGRESS_IDS.headlineNote].style.display).toBe("none");
    expect(
      browser.els[PROGRESS_IDS.panel].classList.contains(
        "env-progress--cleaning"
      )
    ).toBe(false);
  });

  it("clears the headline with the panel", () => {
    const browser = setup();
    const controller = controllerFor(browser);
    controller?.renderProgress(
      record({ headline: { code: "x", title: "Stopped", message: "note" } })
    );
    controller?.renderProgress(null);

    expect(browser.els[PROGRESS_IDS.title].textContent).toBe("");
    expect(browser.els[PROGRESS_IDS.headlineNote].style.display).toBe("none");
  });

  it("names the failure card after the outcome the customer reached", () => {
    const browser = setup();
    controllerFor(browser)?.renderProgress(
      record({
        terminalState: "failed_partial",
        failure: { message: "boom" },
        headline: {
          code: "rollback-incomplete",
          title: "Rollback incomplete",
          message: "Some resources are still present."
        }
      })
    );

    expect(browser.els[PROGRESS_IDS.failureTitle].textContent).toBe(
      "Rollback incomplete"
    );
  });

  it("titles a blocked rollback as one that removed nothing", () => {
    const browser = setup();
    controllerFor(browser)?.renderProgress(
      record({
        terminalState: "failed_partial",
        failure: {
          message:
            "Radius could not prove every committed workflow file is still the file it wrote."
        },
        headline: {
          code: "rollback-blocked",
          title: "Rollback stopped before removing anything",
          message:
            "The committed workflow files are no longer exactly what Radius wrote."
        }
      })
    );

    expect(browser.els[PROGRESS_IDS.failureTitle].textContent).toBe(
      "Rollback stopped before removing anything"
    );
    expect(browser.els[PROGRESS_IDS.headlineNote].textContent).toBe(
      "The committed workflow files are no longer exactly what Radius wrote."
    );
  });

  it("falls back to the plain failure title when the server names none", () => {
    const browser = setup();
    controllerFor(browser)?.renderProgress(
      record({ terminalState: "failed", failure: { message: "boom" } })
    );

    expect(browser.els[PROGRESS_IDS.failureTitle].textContent).toBe(
      "Setup didn’t finish"
    );
  });

  it("says which cancellation this was", () => {
    const browser = setup();
    const deps = createDeps();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: deps.deps
    });

    controller?.applyTerminal(
      record({
        terminalState: "cancelled",
        headline: {
          code: "rollback-complete",
          title: "Rollback complete",
          message: "Radius removed the resources it created."
        }
      })
    );

    expect(browser.els[PROGRESS_IDS.activity].textContent).toBe(
      "Radius removed the resources it created."
    );
    expect(deps.errors).toEqual([]);
  });

  it("treats an incomplete rollback as a rollback, not a broken setup", () => {
    const browser = setup();
    const deps = createDeps();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: deps.deps
    });

    controller?.applyTerminal(
      record({
        terminalState: "failed_partial",
        failure: { message: "delete failed" },
        headline: {
          code: "rollback-incomplete",
          title: "Rollback incomplete",
          message: "Two resources are still present."
        }
      })
    );

    expect(browser.els[PROGRESS_IDS.activity].textContent).toBe(
      "Two resources are still present."
    );
    // No error banner: the customer's setup did not break, the rollback did
    // not finish.
    expect(deps.errors).toEqual([]);
    expect(
      browser.els[PROGRESS_IDS.panel].classList.contains("env-progress--failed")
    ).toBe(true);
  });

  it("still reports an ordinary partial failure as a failure", () => {
    const browser = setup();
    const deps = createDeps();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: deps.deps
    });

    controller?.applyTerminal(
      record({
        terminalState: "failed_partial",
        failure: { message: "role assignment failed" },
        headline: { code: "setup-failed", title: "", message: "" }
      })
    );

    expect(deps.errors).toEqual([
      "Environment setup failed: role assignment failed"
    ]);
  });

  it("reports an incomplete rollback without the activity or note elements", () => {
    const browser = setupWithout([
      PROGRESS_IDS.activity,
      PROGRESS_IDS.headlineNote,
      PROGRESS_IDS.title,
      PROGRESS_IDS.commandGuidance
    ]);
    const deps = createDeps();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: deps.deps
    });

    expect(() => {
      controller?.renderProgress(
        record({
          actions: [],
          guidance: [{ code: "x", message: "Rollback is not offered." }],
          headline: { code: "x", title: "Stopped", message: "note" }
        })
      );
      controller?.applyTerminal(
        record({
          terminalState: "failed_partial",
          failure: { message: "delete failed" },
          headline: {
            code: "rollback-incomplete",
            title: "Rollback incomplete",
            message: "Still present."
          }
        })
      );
    }).not.toThrow();
    expect(deps.errors).toEqual([]);
  });
});

describe("rollback lifecycle presentation", () => {
  const ROLLING_BACK_HEADLINE = {
    code: "rolling-back",
    title: "Rolling back created resources…",
    message:
      "Radius is removing the resources it proved it created during this attempt."
  };
  const ROLLBACK_COMPLETE_HEADLINE = {
    code: "rollback-complete",
    title: "Rollback complete",
    message:
      "Radius removed the resources it created during this attempt. Anything it reused was left alone."
  };
  const ROLLBACK_INCOMPLETE_HEADLINE = {
    code: "rollback-incomplete",
    title: "Rollback finished with items still present",
    message: "The resources below are still present."
  };
  const RETRY_CLEANUP_ACTION = {
    id: "retry-cleanup",
    kind: "retry_cleanup",
    label: "Retry rollback",
    description: "Radius tries again to remove what is still present.",
    path: "/api/operations/op-1/rollback/retry",
    pending: false,
    tone: "danger"
  };

  function controllerFor(browser: ReturnType<typeof setup>) {
    return initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
  }

  // A rollback that is still deleting: the server closes the command list
  // because cleanup has no pause control, and the record is non-terminal.
  function rollbackRunning(): OperationRecord {
    return record({
      state: "running",
      terminalState: null,
      actions: [],
      activeCommandKind: "rollback",
      headline: ROLLING_BACK_HEADLINE,
      cleanup: {
        state: "running",
        created: [{ target: "app radius-dev" }],
        retainedArtifacts: [{ target: "workflow file" }]
      }
    });
  }

  function rollbackComplete(): OperationRecord {
    return record({
      state: "cancelled",
      terminalState: "cancelled",
      actions: [],
      activeCommandKind: "",
      headline: ROLLBACK_COMPLETE_HEADLINE,
      cleanup: {
        state: "succeeded",
        cleaned: [{ target: "app radius-dev" }],
        reused: [{ target: "existing service principal" }]
      }
    });
  }

  function rollbackIncomplete(): OperationRecord {
    return record({
      state: "failed_partial",
      terminalState: "failed_partial",
      failure: { message: "Radius could not delete the role assignment." },
      actions: [RETRY_CLEANUP_ACTION],
      headline: ROLLBACK_INCOMPLETE_HEADLINE,
      cleanup: {
        state: "succeeded_with_warnings",
        created: [{ target: "role assignment" }]
      }
    });
  }

  function buttonLabels(browser: ReturnType<typeof setup>): string[] {
    return browser.els[PROGRESS_IDS.commandButtons].children.map(
      (child) => child.textContent ?? ""
    );
  }

  it("takes the resource inventory away as soon as the rollback starts deleting", () => {
    const browser = setup();
    const controller = controllerFor(browser);
    // The stopped decision state is where the inventory belongs; confirming the
    // rollback answers that decision, so the list goes with it.
    controller?.renderProgress(
      record({
        state: "cancelled",
        terminalState: "cancelled",
        headline: {
          code: "stopped",
          title: "Environment setup stopped",
          message: "Radius stopped before the next setup step."
        },
        cleanup: { created: [{ target: "app radius-dev" }] }
      })
    );
    expect(browser.els[PROGRESS_IDS.partialState].style.display).toBe("");

    controller?.renderProgress(rollbackRunning());

    expect(browser.els[PROGRESS_IDS.partialState].style.display).toBe("none");
    expect(browser.els[PROGRESS_IDS.title].textContent).toBe(
      "Rolling back created resources…"
    );
  });

  it("keeps the resource inventory out of sight once the rollback completes", () => {
    const browser = setup();
    const controller = controllerFor(browser);
    controller?.renderProgress(rollbackRunning());
    controller?.renderProgress(rollbackComplete());

    expect(browser.els[PROGRESS_IDS.partialState].style.display).toBe("none");
  });

  it("closes a completed rollback with the panel's OK button, not a keep-and-dismiss command", () => {
    const browser = setup();
    controllerFor(browser)?.renderProgress(rollbackComplete());

    expect(buttonLabels(browser)).toEqual([]);
    expect(browser.els[PROGRESS_IDS.dismiss].textContent).toBe("OK");
    expect(browser.els[PROGRESS_IDS.dismiss].style.display).toBe("");
    expect(browser.els[PROGRESS_IDS.actions].style.display).toBe("flex");
  });

  it("dismisses the panel from the completed rollback's OK button", () => {
    const browser = setup();
    controllerFor(browser)?.renderProgress(rollbackComplete());

    browser.els[PROGRESS_IDS.dismiss].dispatch("click");

    expect(browser.els[PROGRESS_IDS.panel].style.display).toBe("none");
  });

  it("offers no acknowledgement while the rollback is still deleting", () => {
    const browser = setup();
    controllerFor(browser)?.renderProgress(rollbackRunning());

    expect(buttonLabels(browser)).toEqual([]);
    expect(browser.els[PROGRESS_IDS.dismiss].style.display).toBe("none");
    expect(browser.els[PROGRESS_IDS.actions].style.display).toBe("none");
  });

  it("keeps the retry and keep-and-dismiss controls when the rollback left resources behind", () => {
    const browser = setup();
    controllerFor(browser)?.renderProgress(rollbackIncomplete());

    expect(buttonLabels(browser)).toEqual([
      "Retry rollback",
      "Keep resources and dismiss"
    ]);
    expect(browser.els[PROGRESS_IDS.dismiss].style.display).toBe("none");
    expect(browser.els[PROGRESS_IDS.actions].style.display).toBe("none");
    // The customer still has a decision to make here, so the inventory that
    // names what survived stays available.
    expect(browser.els[PROGRESS_IDS.partialState].style.display).toBe("");
    expect(browser.els[PROGRESS_IDS.failureCard].style.display).toBe("");
  });

  it("keeps the keep-and-dismiss choice for a stop that was never rolled back", () => {
    const browser = setup();
    controllerFor(browser)?.renderProgress(
      record({
        state: "cancelled",
        terminalState: "cancelled",
        actions: [],
        headline: {
          code: "stopped",
          title: "Environment setup stopped",
          message: "Radius stopped before the next setup step."
        },
        cleanup: { created: [{ target: "app radius-dev" }] }
      })
    );

    expect(buttonLabels(browser)).toEqual(["Keep resources and dismiss"]);
    expect(browser.els[PROGRESS_IDS.dismiss].style.display).toBe("none");
    expect(browser.els[PROGRESS_IDS.partialState].style.display).toBe("");
  });

  it("animates the panel while the rollback runs and settles it when the rollback completes", () => {
    const browser = setup();
    const controller = controllerFor(browser);
    const panel = browser.els[PROGRESS_IDS.panel];

    controller?.renderProgress(rollbackRunning());
    expect(panel.classList.contains("env-progress--active")).toBe(true);
    expect(panel.classList.contains("env-progress--cleaning")).toBe(true);

    controller?.renderProgress(rollbackComplete());
    expect(panel.classList.contains("env-progress--active")).toBe(false);
    expect(panel.classList.contains("env-progress--cleaning")).toBe(false);
    expect(panel.classList.contains("env-progress--done")).toBe(false);
    expect(panel.classList.contains("env-progress--failed")).toBe(false);
  });

  it.each([
    ["succeeded"],
    ["succeeded_with_warnings"],
    ["action_required"],
    ["failed"],
    ["failed_partial"],
    ["cancelled"]
  ])("stops the animation for a %s outcome", (terminalState) => {
    const browser = setup();
    const controller = controllerFor(browser);
    const panel = browser.els[PROGRESS_IDS.panel];

    controller?.renderProgress(record({ terminalState: null }));
    expect(panel.classList.contains("env-progress--active")).toBe(true);

    controller?.renderProgress(record({ terminalState }));

    expect(panel.classList.contains("env-progress--active")).toBe(false);
  });

  it("stops the animation when progress stops without another record", () => {
    const browser = setup();
    const controller = controllerFor(browser);
    const panel = browser.els[PROGRESS_IDS.panel];

    controller?.renderProgress(rollbackRunning());
    controller?.stopProgress();

    expect(panel.classList.contains("env-progress--active")).toBe(false);
  });

  it("stops the animation when a terminal record arrives without a re-render", () => {
    const browser = setup();
    const controller = controllerFor(browser);
    const panel = browser.els[PROGRESS_IDS.panel];

    controller?.renderProgress(rollbackRunning());
    controller?.applyTerminal(rollbackComplete());

    expect(panel.classList.contains("env-progress--active")).toBe(false);
  });

  it("stops the animation when the panel is cleared", () => {
    const browser = setup();
    const controller = controllerFor(browser);
    const panel = browser.els[PROGRESS_IDS.panel];

    controller?.renderProgress(rollbackRunning());
    controller?.renderProgress(null);

    expect(panel.classList.contains("env-progress--active")).toBe(false);
  });

  it("settles the panel when a tracked rollback reaches its terminal record", async () => {
    const browser = setup();
    const controller = controllerFor(browser);
    const panel = browser.els[PROGRESS_IDS.panel];
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(
        op({
          state: "running",
          terminalState: null,
          activeCommandKind: "rollback",
          headline: ROLLING_BACK_HEADLINE
        })
      )
    );

    controller?.trackProgress("dev", "azure");
    await flushPromises();
    expect(panel.classList.contains("env-progress--active")).toBe(true);

    browser.net.handle(operationsUrl(), () =>
      jsonResponse(
        op({
          state: "cancelled",
          terminalState: "cancelled",
          headline: ROLLBACK_COMPLETE_HEADLINE,
          endedAt: new Date(60000).toISOString()
        })
      )
    );
    await tickClock(browser.clock, 1500);
    await flushPromises();

    expect(panel.classList.contains("env-progress--active")).toBe(false);
    expect(browser.els[PROGRESS_IDS.dismiss].textContent).toBe("OK");
    expect(browser.els[PROGRESS_IDS.commandButtons].children).toHaveLength(0);
    expect(browser.els[PROGRESS_IDS.partialState].style.display).toBe("none");
  });
});

describe("terminal handling", () => {
  it("marks a succeeded operation and reloads the table", () => {
    const browser = setup();
    const deps = createDeps();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: deps.deps
    });
    controller?.applyTerminal(
      record({
        terminalState: "succeeded",
        provider: "azure",
        environment: "dev",
        steps: [{ state: "warning", label: "Quota is close to its limit" }]
      })
    );
    expect(deps.successBanners).toEqual([
      { provider: "azure", environment: "dev" }
    ]);
    expect(deps.setupWarnings).toEqual([["⚠️ Quota is close to its limit"]]);
    expect(deps.reloadCount).toBe(1);
    expect(browser.deployButton.textContent).toBe(DEPLOY_BUTTON_IDLE_LABEL);
    expect(browser.deployButton.disabled).toBe(false);
  });

  it("marks succeeded_with_warnings the same as succeeded", () => {
    const browser = setup();
    const deps = createDeps();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: deps.deps
    });
    controller?.applyTerminal(
      record({ terminalState: "succeeded_with_warnings" })
    );
    expect(deps.successBanners).toHaveLength(1);
  });

  it("shows action-required with the pull request url and warnings", () => {
    const browser = setup();
    const deps = createDeps();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: deps.deps
    });
    const terminal = { pullRequestUrl: "https://example.test/pr/1" };
    controller?.applyTerminal(
      record({
        terminalState: "action_required",
        terminal,
        steps: [{ state: "warning", label: "Manual approval needed" }]
      })
    );
    expect(deps.actionRequired).toEqual([
      {
        provider: "azure",
        environment: "dev",
        pullRequestUrl: "https://example.test/pr/1",
        terminal
      }
    ]);
    expect(deps.setupWarnings).toEqual([["⚠️ Manual approval needed"]]);
  });

  it("clears done/failed classes and reports cancellation", () => {
    const browser = setup();
    const deps = createDeps();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: deps.deps
    });
    browser.els[PROGRESS_IDS.panel].classList.add("env-progress--done");
    controller?.applyTerminal(record({ terminalState: "cancelled" }));
    expect(
      browser.els[PROGRESS_IDS.panel].classList.contains("env-progress--done")
    ).toBe(false);
    expect(browser.els[PROGRESS_IDS.activity].textContent).toBe(
      "Environment setup cancelled."
    );
  });

  it("shows a failure message and marks the panel failed for failed/failed_partial", () => {
    const browser = setup();
    const deps = createDeps();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: deps.deps
    });
    controller?.applyTerminal(
      record({
        terminalState: "failed",
        failure: { message: "az cli: quota exceeded" }
      })
    );
    expect(deps.errors).toEqual([
      "Environment setup failed: az cli: quota exceeded"
    ]);
    expect(
      browser.els[PROGRESS_IDS.panel].classList.contains("env-progress--failed")
    ).toBe(true);
  });

  it("falls back to a generic message when a failure has none", () => {
    const browser = setup();
    const deps = createDeps();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: deps.deps
    });
    controller?.applyTerminal(
      record({ terminalState: "failed_partial", failure: null })
    );
    expect(deps.errors).toEqual(["Environment setup failed: unknown error"]);
  });

  it.each(["succeeded", "action_required", "cancelled", "failed"])(
    "reaches %s through the poller and invokes the default terminal handler",
    async (terminalState) => {
      const browser = setup();
      const deps = createDeps();
      const controller = initializeEnvironmentOperations(browser.context, {
        repo: REPO,
        deps: deps.deps
      });
      // The poller must first observe a running record for this environment
      // before a terminal record is treated as this run's own outcome rather
      // than a stale leftover from a previous setup of the same environment.
      browser.net.handle(operationsUrl(), () =>
        jsonResponse(op({ terminalState: null }))
      );
      controller?.trackProgress("dev", "azure");
      await flushPromises();

      browser.net.handle(operationsUrl(), () =>
        jsonResponse(op({ terminalState }))
      );
      await tickClock(browser.clock, 1500);

      expect(deps.reloadCount).toBe(1);
      expect(browser.clock.pending).toBe(0);
    }
  );
});

describe("malformed, error, and rejected payloads", () => {
  it("retries after a network rejection without crashing", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    browser.net.handle(operationsUrl(), () =>
      Promise.reject(new Error("offline"))
    );

    controller?.trackProgress("dev", "azure");
    await flushPromises();
    expect(browser.clock.timeouts).toBe(1);

    browser.net.handle(operationsUrl(), () => jsonResponse(op()));
    await tickClock(browser.clock, 3000);
    expect(browser.els[PROGRESS_IDS.panel].style.display).toBe("");
  });

  it("retries when the response body is not JSON", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    browser.net.handle(operationsUrl(), () => textResponse("not json"));

    controller?.trackProgress("dev", "azure");
    await flushPromises();
    expect(browser.clock.timeouts).toBe(1);
  });

  it("treats a non-object payload as no operation yet and keeps polling", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    browser.net.handle(operationsUrl(), () => jsonResponse("not an object"));
    browser.els[PROGRESS_IDS.panel].style.display = "marker";

    controller?.trackProgress("dev", "azure");
    await flushPromises();

    // No render happened for an unusable payload; the panel is untouched.
    expect(browser.els[PROGRESS_IDS.panel].style.display).toBe("marker");
    expect(browser.clock.timeouts).toBe(1);
  });

  it("keeps polling when the verify-status response itself rejects", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    browser.net.handle(operationsUrl(), () => jsonResponse(op()));
    controller?.trackProgress("dev", "azure");
    await flushPromises();

    browser.net.handle(operationsUrl(), () =>
      jsonResponse({ operation: null })
    );
    browser.net.handle(verifyUrl(REPO, "dev", "op-1"), () =>
      Promise.reject(new Error("offline"))
    );
    await tickClock(browser.clock, 1500);
    await flushPromises();

    expect(browser.clock.timeouts).toBe(1);
  });
});

describe("stale response ordering and operation identity", () => {
  it("never lets a slow first poll overwrite a newer trackProgress call", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    const first = createDeferred<HttpResponse>();
    const second = createDeferred<HttpResponse>();
    const responses = [first, second];
    browser.net.handle(operationsUrl(), () => {
      const next = responses.shift();
      if (!next) throw new Error("unexpected third poll");
      return next.promise;
    });

    controller?.trackProgress("dev", "azure");
    await flushPromises();
    controller?.trackProgress("staging", "aws");
    await flushPromises();

    second.resolve(
      jsonResponse(
        op({ environment: "staging", provider: "aws", operationId: "op-2" })
      )
    );
    await flushPromises();
    first.resolve(
      jsonResponse(
        op({ environment: "dev", provider: "azure", operationId: "op-1" })
      )
    );
    await flushPromises();

    expect(browser.els[PROGRESS_IDS.title].textContent).toBe("Creating dev…");
    // The stale "dev" response must not have been allowed to schedule its own
    // continuation on top of the newer session's timer.
    expect(browser.clock.timeouts).toBeLessThanOrEqual(1);
  });

  it("ignores a stale resume-prompt resolution once a newer session has started", async () => {
    const browser = setup();
    const deps = createDeps();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: deps.deps
    });
    const smr = createDeferred<string>();
    deps.deps.promptServiceManagementReference = () => smr.promise;
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(
        op({
          state: "input_required",
          inputRequired: {
            requestedAt: "2024-01-01T00:00:00.000Z",
            code: "service-management-reference-required",
            checkpoint: {}
          }
        })
      )
    );

    controller?.trackProgress("dev", "azure");
    await flushPromises();

    // Supersede the session before the SMR prompt resolves.
    controller?.trackProgress("dev", "azure");
    await flushPromises();

    smr.resolve("11111111-1111-1111-1111-111111111111");
    await flushPromises();

    // The stale session's resolved prompt must not fire its own resume call;
    // only the current (second) session's continuation may proceed.
    expect(
      browser.net.calls.filter((call) => call.url.includes("/resume/")).length
    ).toBe(1);
  });

  it("ignores a stale resume-prompt rejection once a newer session has started", async () => {
    const browser = setup();
    const deps = createDeps();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: deps.deps
    });
    const smr = createDeferred<string>();
    deps.deps.promptServiceManagementReference = () => smr.promise;
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(
        op({
          state: "input_required",
          inputRequired: {
            requestedAt: "2024-01-01T00:00:00.000Z",
            code: "service-management-reference-required",
            checkpoint: {}
          }
        })
      )
    );

    controller?.trackProgress("dev", "azure");
    await flushPromises();

    // Supersede the session before the SMR prompt rejects.
    controller?.trackProgress("dev", "azure");
    await flushPromises();

    smr.reject(new Error("prompt closed"));
    await flushPromises();

    // Both sessions share the same pending prompt promise, so the reject
    // reaches both continuations. Only the current (second, still-active)
    // session may schedule its own retry; the stale first session's own
    // active()-check must suppress a second, duplicate retry.
    expect(browser.clock.timeouts).toBe(1);
  });

  it("discards a first poll response for a different environment or an already-terminal record", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    // The server-side registry can still hold the previous environment's
    // terminal record for a moment after a new setup is requested; the very
    // first poll must not paint that leftover as this session's state.
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(op({ environment: "staging", terminalState: "succeeded" }))
    );

    controller?.trackProgress("dev", "azure");
    await flushPromises();

    expect(browser.els[PROGRESS_IDS.title].textContent).toBe("");
    expect(browser.clock.timeouts).toBe(1);

    browser.net.handle(operationsUrl(), () =>
      jsonResponse(op({ environment: "dev", terminalState: null }))
    );
    await tickClock(browser.clock, 1500);

    expect(browser.els[PROGRESS_IDS.title].textContent).toBe("Creating dev…");
  });

  it("ignores a slow poll response that resolves after its session was superseded even when the network cannot abort it", async () => {
    const browser = setup();
    browser.net.supportsAbort = false;
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    const stale = createDeferred<HttpResponse>();
    browser.net.handle(operationsUrl(), () => stale.promise);

    controller?.trackProgress("dev", "azure");
    await flushPromises();

    // Disabling abort support means the first poll's request is never
    // rejected by the session change below, so its response reaches
    // tick()'s own continuation while genuinely stale.
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(
        op({
          environment: "staging",
          provider: "aws",
          summary: "Creating staging…"
        })
      )
    );
    controller?.trackProgress("staging", "aws");
    await flushPromises();
    expect(browser.els[PROGRESS_IDS.title].textContent).toBe(
      "Creating staging…"
    );
    const timeoutsBeforeStaleSettles = browser.clock.timeouts;

    stale.resolve(
      jsonResponse(
        op({ environment: "dev", provider: "azure", operationId: "op-1" })
      )
    );
    await flushPromises();

    // The stale "dev" response must not repaint the panel or schedule an
    // extra continuation on top of the current "staging" session's timer.
    expect(browser.els[PROGRESS_IDS.title].textContent).toBe(
      "Creating staging…"
    );
    expect(browser.clock.timeouts).toBe(timeoutsBeforeStaleSettles);
  });

  it("keeps polling for the current environment once observed, discarding a null record until it matches", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    // trackProgress is called with an empty environment (mirrors a caller
    // that has not yet resolved a target environment name); the first poll
    // must match on that same empty string to mark the operation observed.
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(op({ environment: "" }))
    );

    controller?.trackProgress("", "azure");
    await flushPromises();
    expect(browser.els[PROGRESS_IDS.title].textContent).toBe("Creating dev…");

    // Once observed, an operation-registry gap (record disappeared) with no
    // resolvable environment must keep polling rather than fall through to
    // verification tracking, which requires a known environment name.
    browser.net.handle(operationsUrl(), () =>
      jsonResponse({ operation: null })
    );
    await tickClock(browser.clock, 1500);

    expect(
      browser.net.calls.some((call) => call.url.startsWith(VERIFY_STATUS_PATH))
    ).toBe(false);
    expect(browser.clock.pending).toBeGreaterThan(0);
  });
});

describe("resume flow", () => {
  it("resumes a service-management-reference prompt with the exact route and body", async () => {
    const browser = setup();
    const deps = createDeps();
    deps.deps.promptServiceManagementReference = () =>
      Promise.resolve("11111111-1111-1111-1111-111111111111");
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      mutationNonce: "browser-nonce",
      deps: deps.deps
    });
    let resumeBody: unknown;
    let resumeHeaders: unknown;
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(
        op({
          state: "input_required",
          inputRequired: {
            requestedAt: "2024-01-01T00:00:00.000Z",
            code: "service-management-reference-required",
            checkpoint: { step: 2 }
          }
        })
      )
    );
    browser.net.handle(
      resumeUrl("op-1", "service-management-reference-required"),
      (init) => {
        resumeBody = init && init.body ? JSON.parse(init.body) : undefined;
        resumeHeaders = init?.headers;
        return jsonResponse({ ok: true });
      }
    );

    controller?.trackProgress("dev", "azure");
    await flushPromises();
    await flushPromises();

    expect(resumeBody).toEqual({
      serviceManagementReference: "11111111-1111-1111-1111-111111111111",
      checkpoint: { step: 2 },
      repo: REPO,
      environment: "dev",
      provider: "azure"
    });
    expect(resumeHeaders).toEqual({
      "Content-Type": "application/json",
      "X-Radius-Mutation-Nonce": "browser-nonce"
    });
  });

  it("resumes an app-selection prompt with the candidates and default from metadata", async () => {
    const browser = setup();
    const deps = createDeps();
    let requestSeen: AppPickerRequest | undefined;
    deps.deps.promptAppSelection = (request) => {
      requestSeen = request;
      return Promise.resolve({ appId: "app-2" });
    };
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: deps.deps
    });
    let resumeBody: unknown;
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(
        op({
          state: "input_required",
          inputRequired: {
            requestedAt: "2024-01-01T00:00:00.000Z",
            code: "app-selection-required",
            checkpoint: {},
            metadata: {
              defaultAppId: "app-2",
              candidates: [{ appId: "app-1" }, { appId: "app-2" }]
            }
          }
        })
      )
    );
    browser.net.handle(resumeUrl("op-1", "app-selection-required"), (init) => {
      resumeBody = init && init.body ? JSON.parse(init.body) : undefined;
      return jsonResponse({ ok: true });
    });

    controller?.trackProgress("dev", "azure");
    await flushPromises();
    await flushPromises();

    expect(requestSeen?.candidates).toEqual([
      { appId: "app-1" },
      { appId: "app-2" }
    ]);
    expect(requestSeen?.defaultAppId).toBe("app-2");
    expect(requestSeen?.allowCreateNew).toBe(true);
    expect(resumeBody).toMatchObject({ appId: "app-2" });
  });

  it("resumes with createNew when the picker requests a new app", async () => {
    const browser = setup();
    const deps = createDeps();
    deps.deps.promptAppSelection = () => Promise.resolve({ createNew: true });
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: deps.deps
    });
    let resumeBody: unknown;
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(
        op({
          state: "input_required",
          inputRequired: {
            requestedAt: "2024-01-01T00:00:00.000Z",
            code: "app-selection-required",
            checkpoint: {}
          }
        })
      )
    );
    browser.net.handle(resumeUrl("op-1", "app-selection-required"), (init) => {
      resumeBody = init && init.body ? JSON.parse(init.body) : undefined;
      return jsonResponse({ ok: true });
    });

    controller?.trackProgress("dev", "azure");
    await flushPromises();
    await flushPromises();

    expect(resumeBody).toMatchObject({ createNew: true });
  });

  it("does not prompt for an unrecognized input code and keeps polling", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(
        op({
          state: "input_required",
          inputRequired: {
            requestedAt: "2024-01-01T00:00:00.000Z",
            code: "some-unknown-code",
            checkpoint: {}
          }
        })
      )
    );

    controller?.trackProgress("dev", "azure");
    await flushPromises();

    expect(
      browser.net.calls.some((call) => call.url.includes("/resume/"))
    ).toBe(false);
    expect(browser.clock.timeouts).toBe(1);
  });

  it("re-prompts on the next poll after a generic resume failure", async () => {
    const browser = setup();
    const deps = createDeps();
    let smrCalls = 0;
    deps.deps.promptServiceManagementReference = () => {
      smrCalls += 1;
      return Promise.resolve("11111111-1111-1111-1111-111111111111");
    };
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: deps.deps
    });
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(
        op({
          state: "input_required",
          inputRequired: {
            requestedAt: "2024-01-01T00:00:00.000Z",
            code: "service-management-reference-required",
            checkpoint: {}
          }
        })
      )
    );
    browser.net.handle(
      resumeUrl("op-1", "service-management-reference-required"),
      () => jsonResponse({ error: "validation failed" }, false, 422)
    );

    controller?.trackProgress("dev", "azure");
    await flushPromises();
    await flushPromises();
    expect(smrCalls).toBe(1);

    await tickClock(browser.clock, 1500);
    await flushPromises();
    await flushPromises();
    expect(smrCalls).toBe(2);
  });

  it("re-prompts after a resume failure whose response body is not a JSON object", async () => {
    const browser = setup();
    const deps = createDeps();
    let smrCalls = 0;
    deps.deps.promptServiceManagementReference = () => {
      smrCalls += 1;
      return Promise.resolve("11111111-1111-1111-1111-111111111111");
    };
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: deps.deps
    });
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(
        op({
          state: "input_required",
          inputRequired: {
            requestedAt: "2024-01-01T00:00:00.000Z",
            code: "service-management-reference-required",
            checkpoint: {}
          }
        })
      )
    );
    // A bare JSON string (not an object) is still valid JSON, so `.json()`
    // resolves without throwing — parseResumeFailure must fall back safely
    // instead of assuming the payload is a record.
    browser.net.handle(
      resumeUrl("op-1", "service-management-reference-required"),
      () => jsonResponse("plain text failure", false, 500)
    );

    controller?.trackProgress("dev", "azure");
    await flushPromises();
    await flushPromises();
    expect(smrCalls).toBe(1);

    await tickClock(browser.clock, 1500);
    await flushPromises();
    await flushPromises();
    expect(smrCalls).toBe(2);
  });

  it("re-prompts after a resume failure whose response body is not valid JSON at all", async () => {
    const browser = setup();
    const deps = createDeps();
    let smrCalls = 0;
    deps.deps.promptServiceManagementReference = () => {
      smrCalls += 1;
      return Promise.resolve("11111111-1111-1111-1111-111111111111");
    };
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: deps.deps
    });
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(
        op({
          state: "input_required",
          inputRequired: {
            requestedAt: "2024-01-01T00:00:00.000Z",
            code: "service-management-reference-required",
            checkpoint: {}
          }
        })
      )
    );
    // The response's own `.json()` rejects entirely (e.g. an HTML error page
    // from a proxy). The resume handler must fall back to an empty payload
    // instead of letting the parse failure escape as an unhandled rejection.
    browser.net.handle(
      resumeUrl("op-1", "service-management-reference-required"),
      () => textResponse("<html>Bad Gateway</html>", false, 502)
    );

    controller?.trackProgress("dev", "azure");
    await flushPromises();
    await flushPromises();
    expect(smrCalls).toBe(1);

    await tickClock(browser.clock, 1500);
    await flushPromises();
    await flushPromises();
    expect(smrCalls).toBe(2);
  });

  it("does not re-prompt while a resume failure reports operation-input-expired but no usable operation", async () => {
    const browser = setup();
    const deps = createDeps();
    let smrCalls = 0;
    deps.deps.promptServiceManagementReference = () => {
      smrCalls += 1;
      return Promise.resolve("11111111-1111-1111-1111-111111111111");
    };
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: deps.deps
    });
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(
        op({
          state: "input_required",
          inputRequired: {
            requestedAt: "2024-01-01T00:00:00.000Z",
            code: "service-management-reference-required",
            checkpoint: {}
          }
        })
      )
    );
    browser.net.handle(
      resumeUrl("op-1", "service-management-reference-required"),
      () => jsonResponse({ code: "operation-input-expired" }, false, 409)
    );

    controller?.trackProgress("dev", "azure");
    await flushPromises();
    await flushPromises();
    expect(smrCalls).toBe(1);

    await tickClock(browser.clock, 1500);
    await flushPromises();
    await flushPromises();
    // Same requestedAt as before, and no reset, so the prompt is not repeated.
    expect(smrCalls).toBe(1);
  });

  it("applies the terminal record from a resume failure carrying an expired operation", async () => {
    const browser = setup();
    const deps = createDeps();
    deps.deps.promptServiceManagementReference = () =>
      Promise.resolve("11111111-1111-1111-1111-111111111111");
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: deps.deps
    });
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(
        op({
          state: "input_required",
          inputRequired: {
            requestedAt: "2024-01-01T00:00:00.000Z",
            code: "service-management-reference-required",
            checkpoint: {}
          }
        })
      )
    );
    browser.net.handle(
      resumeUrl("op-1", "service-management-reference-required"),
      () =>
        jsonResponse(
          {
            code: "operation-input-expired",
            operation: op({
              terminalState: "failed",
              failure: { code: "operation-input-expired", message: "expired" }
            }).operation
          },
          false,
          409
        )
    );

    controller?.trackProgress("dev", "azure");
    await flushPromises();
    await flushPromises();

    expect(deps.errors).toEqual(["Environment setup failed: expired"]);
    expect(browser.clock.pending).toBe(0);
  });

  it("stops silently when a resume failure's expired operation cannot itself be parsed", async () => {
    const browser = setup();
    const deps = createDeps();
    deps.deps.promptServiceManagementReference = () =>
      Promise.resolve("11111111-1111-1111-1111-111111111111");
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: deps.deps
    });
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(
        op({
          state: "input_required",
          inputRequired: {
            requestedAt: "2024-01-01T00:00:00.000Z",
            code: "service-management-reference-required",
            checkpoint: {}
          }
        })
      )
    );
    // The record is a genuine expired-input operation (it satisfies
    // isOperationInputExpired), but its operationId is missing, so the
    // record itself fails to parse into a usable OperationRecord.
    browser.net.handle(
      resumeUrl("op-1", "service-management-reference-required"),
      () =>
        jsonResponse(
          {
            code: "operation-input-expired",
            operation: {
              operationId: "",
              failure: { code: "operation-input-expired" }
            }
          },
          false,
          409
        )
    );

    controller?.trackProgress("dev", "azure");
    await flushPromises();
    await flushPromises();

    // Progress simply stops: no terminal callback fires and no further
    // poll is scheduled, but nothing throws either.
    expect(deps.errors).toEqual([]);
    expect(browser.clock.pending).toBe(0);
  });

  it("stops the operation when the prompt rejects with abandonOperation", async () => {
    const browser = setup();
    const deps = createDeps();
    deps.deps.promptServiceManagementReference = () => {
      const error = Object.assign(new Error("cancelled"), {
        abandonOperation: true
      });
      return Promise.reject(error);
    };
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      mutationNonce: "browser-nonce",
      deps: deps.deps
    });
    let stopCalled = false;
    let stopHeaders: unknown;
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(
        op({
          state: "input_required",
          inputRequired: {
            requestedAt: "2024-01-01T00:00:00.000Z",
            code: "service-management-reference-required",
            checkpoint: {}
          }
        })
      )
    );
    browser.net.handle(stopUrl("op-1"), (init) => {
      stopCalled = true;
      stopHeaders = init?.headers;
      return jsonResponse({ ok: true });
    });

    controller?.trackProgress("dev", "azure");
    await flushPromises();
    await flushPromises();

    expect(stopCalled).toBe(true);
    expect(stopHeaders).toEqual({
      "Content-Type": "application/json",
      "X-Radius-Mutation-Nonce": "browser-nonce"
    });
  });

  it("retries after the stop request itself fails", async () => {
    const browser = setup();
    const deps = createDeps();
    deps.deps.promptServiceManagementReference = () => {
      const error = Object.assign(new Error("cancelled"), {
        abandonOperation: true
      });
      return Promise.reject(error);
    };
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: deps.deps
    });
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(
        op({
          state: "input_required",
          inputRequired: {
            requestedAt: "2024-01-01T00:00:00.000Z",
            code: "service-management-reference-required",
            checkpoint: {}
          }
        })
      )
    );
    browser.net.handle(stopUrl("op-1"), () => jsonResponse({}, false, 500));

    controller?.trackProgress("dev", "azure");
    await flushPromises();
    await flushPromises();

    expect(browser.clock.timeouts).toBe(1);
  });

  it("retries after the stop request rejects outright", async () => {
    const browser = setup();
    const deps = createDeps();
    deps.deps.promptServiceManagementReference = () => {
      const error = Object.assign(new Error("cancelled"), {
        abandonOperation: true
      });
      return Promise.reject(error);
    };
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: deps.deps
    });
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(
        op({
          state: "input_required",
          inputRequired: {
            requestedAt: "2024-01-01T00:00:00.000Z",
            code: "service-management-reference-required",
            checkpoint: {}
          }
        })
      )
    );
    browser.net.handle(stopUrl("op-1"), () =>
      Promise.reject(new Error("offline"))
    );

    controller?.trackProgress("dev", "azure");
    await flushPromises();
    await flushPromises();

    expect(browser.clock.timeouts).toBe(1);
  });

  it("is a no-op when the stop request settles for a session that has since been superseded", async () => {
    const browser = setup();
    const deps = createDeps();
    deps.deps.promptServiceManagementReference = () => {
      const error = Object.assign(new Error("cancelled"), {
        abandonOperation: true
      });
      return Promise.reject(error);
    };
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: deps.deps
    });
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(
        op({
          state: "input_required",
          inputRequired: {
            requestedAt: "2024-01-01T00:00:00.000Z",
            code: "service-management-reference-required",
            checkpoint: {}
          }
        })
      )
    );
    const stopResponse = createDeferred<HttpResponse>();
    browser.net.handle(stopUrl("op-1"), () => stopResponse.promise);

    controller?.trackProgress("dev", "azure");
    await flushPromises();
    await flushPromises();
    // The stop POST is now in flight but unresolved. Superseding the
    // session before it settles means scheduleTick's own staleness guard
    // (not this handler) must suppress the reschedule it would otherwise
    // trigger.
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(op({ environment: "prod" }))
    );
    controller?.trackProgress("prod", "azure");
    await flushPromises();
    const timeoutsBeforeSettle = browser.clock.timeouts;

    stopResponse.resolve(jsonResponse({ ok: true }));
    await flushPromises();
    await flushPromises();

    // Only the current ("prod") session's own timer exists; the stale
    // stop-flow continuation scheduled nothing extra.
    expect(browser.clock.timeouts).toBe(timeoutsBeforeSettle);
  });

  it("does not re-prompt for the same requestedAt across polls", async () => {
    const browser = setup();
    const deps = createDeps();
    let smrCalls = 0;
    deps.deps.promptServiceManagementReference = () => {
      smrCalls += 1;
      return new Promise(() => {
        /* never resolves for this test */
      });
    };
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: deps.deps
    });
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(
        op({
          state: "input_required",
          inputRequired: {
            requestedAt: "2024-01-01T00:00:00.000Z",
            code: "service-management-reference-required",
            checkpoint: {}
          }
        })
      )
    );

    controller?.trackProgress("dev", "azure");
    await flushPromises();
    expect(smrCalls).toBe(1);
  });
});

describe("resumeProgress", () => {
  it("does nothing when there is no repo", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: "",
      deps: createDeps().deps
    });
    controller?.resumeProgress();
    await flushPromises();
    expect(browser.net.calls).toHaveLength(0);
  });

  it("rejoins a non-terminal operation and starts tracking it", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(op({ environment: "prod" }))
    );

    controller?.resumeProgress();
    await flushPromises();

    expect(browser.els[PROGRESS_IDS.panel].style.display).toBe("");
    expect(browser.clock.intervals).toBe(1);
  });

  it.each([
    ["no operation", { operation: null }],
    ["a terminal operation", op({ terminalState: "succeeded" })]
  ])("does not start tracking for %s", async (_name, payload) => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    browser.net.handle(operationsUrl(), () => jsonResponse(payload));

    controller?.resumeProgress();
    await flushPromises();

    expect(browser.clock.intervals).toBe(0);
  });

  it("rebuilds a closed record's panel and controls after a reload", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(
        op({
          terminalState: "failed_partial",
          state: "failed_partial",
          summary: "dev setup stopped",
          failure: { message: "role assignment failed" },
          cleanup: { created: [{ target: "app radius-dev" }] },
          actions: [
            {
              id: "retry-setup",
              kind: "retry_setup",
              label: "Retry setup",
              description: "Radius continues from the first unfinished step.",
              path: "/api/operations/op-1/retry/setup",
              pending: false
            }
          ]
        })
      )
    );

    controller?.resumeProgress();
    await flushPromises();

    // The saved record still offers its retry and still names what exists, so
    // a reload after a failure is not a dead end.
    expect(browser.els[PROGRESS_IDS.panel].style.display).toBe("");
    expect(
      browser.els[PROGRESS_IDS.commandButtons].children[0].textContent
    ).toBe("Retry setup");
    expect(browser.els[PROGRESS_IDS.partialState].style.display).toBe("");
    // A closed record is rendered, not re-polled.
    expect(browser.clock.intervals).toBe(0);
  });

  it("swallows a rejected resume fetch", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    browser.net.handle(operationsUrl(), () =>
      Promise.reject(new Error("offline"))
    );

    controller?.resumeProgress();
    await expect(flushPromises()).resolves.toBeUndefined();
  });

  it("ignores a resume-progress response that resolves after a newer session has started", async () => {
    const browser = setup();
    browser.net.supportsAbort = false;
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    const resumeResponse = createDeferred<HttpResponse>();
    browser.net.handle(operationsUrl(), () => resumeResponse.promise);

    controller?.resumeProgress();
    await flushPromises();

    // Disabling abort support means resumeProgress's own in-flight request
    // is never rejected by the trackProgress call below, so its response
    // reaches resumeProgress's continuation while genuinely stale.
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(op({ environment: "prod" }))
    );
    controller?.trackProgress("prod", "azure");
    await flushPromises();
    const intervalsBeforeStaleSettles = browser.clock.intervals;

    resumeResponse.resolve(jsonResponse(op({ environment: "dev" })));
    await flushPromises();

    // The stale resumeProgress response must not restart tracking on top of
    // the current ("prod") session.
    expect(browser.clock.intervals).toBe(intervalsBeforeStaleSettles);
  });
});

describe("syncFailureOperation", () => {
  it("resolves false without a network call when there is no operationId", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    await expect(controller?.syncFailureOperation({})).resolves.toBe(false);
    expect(browser.net.calls).toHaveLength(0);
  });

  it("renders the operation, opens details, and hides the error banner on success", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    browser.els[ERROR_BANNER_ID].style.display = "block";
    browser.net.handle(operationUrl("op-9"), () =>
      jsonResponse(op({ operationId: "op-9", terminalState: "failed" }))
    );

    await expect(
      controller?.syncFailureOperation({ operationId: "op-9" })
    ).resolves.toBe(true);
    expect(browser.els[PROGRESS_IDS.details].getAttribute("open")).toBe("");
    expect(browser.els[ERROR_BANNER_ID].style.display).toBe("none");
  });

  it("also opens details for the failed_partial terminal state", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    browser.net.handle(operationUrl("op-10"), () =>
      jsonResponse(
        op({ operationId: "op-10", terminalState: "failed_partial" })
      )
    );

    await expect(
      controller?.syncFailureOperation({ operationId: "op-10" })
    ).resolves.toBe(true);
    expect(browser.els[PROGRESS_IDS.details].getAttribute("open")).toBe("");
  });

  it("resolves false when the response is not ok, missing an operation, or rejects", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    browser.net.handle(operationUrl("not-ok"), () =>
      jsonResponse({}, false, 404)
    );
    browser.net.handle(operationUrl("missing"), () =>
      jsonResponse({ operation: null })
    );
    browser.net.handle(operationUrl("boom"), () =>
      Promise.reject(new Error("offline"))
    );

    await expect(
      controller?.syncFailureOperation({ operationId: "not-ok" })
    ).resolves.toBe(false);
    await expect(
      controller?.syncFailureOperation({ operationId: "missing" })
    ).resolves.toBe(false);
    await expect(
      controller?.syncFailureOperation({ operationId: "boom" })
    ).resolves.toBe(false);
  });
});

describe("timer uniqueness and elapsed rendering", () => {
  it("owns exactly one elapsed interval and one progress timeout at a time", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    browser.net.handle(operationsUrl(), () => jsonResponse(op()));

    controller?.trackProgress("dev", "azure");
    await flushPromises();
    expect(browser.clock.intervals).toBe(1);
    expect(browser.clock.timeouts).toBe(1);

    await tickClock(browser.clock, 1500, 3);
    expect(browser.clock.intervals).toBe(1);
    expect(browser.clock.timeouts).toBe(1);
  });

  it("still tracks progress when the network port cannot create an abort handle", async () => {
    const browser = setup();
    browser.net.supportsAbort = false;
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    // Observe a running record first so the poller does not treat the
    // terminal response below as a stale leftover from a previous run.
    browser.net.handle(operationsUrl(), () => jsonResponse(op()));
    controller?.trackProgress("dev", "azure");
    await flushPromises();

    browser.net.handle(operationsUrl(), () =>
      jsonResponse(op({ terminalState: "succeeded" }))
    );
    await tickClock(browser.clock, 1500);

    expect(
      browser.els[PROGRESS_IDS.panel].classList.contains("env-progress--done")
    ).toBe(true);
    expect(browser.net.calls.length).toBeGreaterThan(0);
  });

  it("renders the elapsed time from clock ticks and from the operation record", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(op({ startedAt: new Date(0).toISOString() }))
    );

    controller?.trackProgress("dev", "azure");
    await flushPromises();
    expect(browser.els[PROGRESS_IDS.elapsed].textContent).toBe("0:00");

    browser.clock.tick(3000);
    await flushPromises();
    expect(browser.els[PROGRESS_IDS.elapsed].textContent).toBe("0:03");
  });

  it("uses the ended-at time once the record reports an end", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    const startedAt = new Date(0).toISOString();
    const endedAt = new Date(7000).toISOString();
    // First observe a running record for this environment so the terminal
    // record that follows is not treated as a stale leftover.
    browser.net.handle(operationsUrl(), () => jsonResponse(op({ startedAt })));
    controller?.trackProgress("dev", "azure");
    await flushPromises();

    browser.net.handle(operationsUrl(), () =>
      jsonResponse(op({ startedAt, endedAt, terminalState: "succeeded" }))
    );
    await tickClock(browser.clock, 1500);

    expect(browser.els[PROGRESS_IDS.elapsed].textContent).toBe("0:07");
  });

  it("ignores a malformed startedAt instead of corrupting the elapsed time", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(op({ startedAt: "not-a-date" }))
    );

    controller?.trackProgress("dev", "azure");
    await flushPromises();

    expect(browser.els[PROGRESS_IDS.elapsed].textContent).not.toContain("NaN");
  });
});

describe("graceful degradation when optional DOM elements are missing", () => {
  const OPTIONAL_PROGRESS_IDS = [
    PROGRESS_IDS.activity,
    PROGRESS_IDS.stages,
    PROGRESS_IDS.steps,
    PROGRESS_IDS.details,
    PROGRESS_IDS.dismiss,
    PROGRESS_IDS.actions,
    PROGRESS_IDS.failureCard,
    PROGRESS_IDS.failureMessage,
    PROGRESS_IDS.cleanupStatus,
    PROGRESS_IDS.retry
  ];

  it("renders and applies terminal states without throwing when only the panel exists", () => {
    const browser = setupWithout([
      ...OPTIONAL_PROGRESS_IDS,
      ERROR_BANNER_ID,
      DEPLOY_BUTTON_ID
    ]);
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    expect(controller).not.toBeNull();

    expect(() =>
      controller?.renderProgress(
        record({
          terminalState: "failed",
          stages: [{ state: "running", label: "Provision" }],
          steps: [{ state: "running", label: "Create resource group" }],
          cleanup: {
            state: "succeeded",
            rollbackBeforeCommit: true,
            retry: { startsCleanly: true, guidance: "Retry any time." },
            removed: [{ target: "rg-dev" }],
            retained: [],
            warnings: []
          }
        })
      )
    ).not.toThrow();
    // The panel itself is always present and must keep reflecting state
    // even when every optional child element is absent.
    expect(
      browser.els[PROGRESS_IDS.panel].classList.contains("env-progress--failed")
    ).toBe(true);

    expect(() =>
      controller?.applyTerminal(record({ terminalState: "succeeded" }))
    ).not.toThrow();
    expect(() =>
      controller?.applyTerminal(record({ terminalState: "cancelled" }))
    ).not.toThrow();
    expect(() =>
      controller?.applyTerminal(
        record({ terminalState: "failed", failure: { message: "boom" } })
      )
    ).not.toThrow();
    expect(() =>
      controller?.applyTerminal(record({ terminalState: "action_required" }))
    ).not.toThrow();
  });

  it("skips opening details and hiding the error banner when both are missing", async () => {
    const browser = setupWithout([PROGRESS_IDS.details, ERROR_BANNER_ID]);
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    browser.net.handle(operationUrl("op-9"), () =>
      jsonResponse(op({ operationId: "op-9", terminalState: "failed" }))
    );

    await expect(
      controller?.syncFailureOperation({ operationId: "op-9" })
    ).resolves.toBe(true);
  });

  it("returns early from the cleanup list helper when its list or block element is missing", () => {
    const browser = setupWithout([PROGRESS_IDS.cleanupRemovedBlock]);
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });

    expect(() =>
      controller?.renderProgress(
        record({
          terminalState: "failed",
          cleanup: {
            state: "succeeded",
            rollbackBeforeCommit: true,
            retry: { startsCleanly: true, guidance: "Retry any time." },
            removed: [{ target: "rg-dev" }],
            retained: [],
            warnings: []
          }
        })
      )
    ).not.toThrow();
    expect(browser.els[PROGRESS_IDS.failureCard].style.display).toBe("");
  });

  it("skips the expired and failed verify activity/details updates, and the elapsed tick, when absent", async () => {
    const missingIds = [
      PROGRESS_IDS.activity,
      PROGRESS_IDS.details,
      PROGRESS_IDS.elapsed
    ];
    const browser = setupWithout(missingIds);
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    browser.net.handle(operationsUrl(), () =>
      jsonResponse(op({ currentStage: "verify", steps: [] }))
    );
    controller?.trackProgress("dev", "azure");
    await flushPromises();
    // The elapsed interval tick fires here too, exercising its own guard
    // for a missing elapsed element.
    browser.clock.tick(1000);
    browser.net.handle(operationsUrl(), () =>
      jsonResponse({ operation: null })
    );

    browser.net.handle(verifyUrl(REPO, "dev", "op-1"), () =>
      jsonResponse({
        state: "expired",
        terminal: false,
        error: "",
        runUrl: "",
        activity: ""
      })
    );
    await tickClock(browser.clock, 1500);

    // A fresh browser/controller for the failed-verify guards, so the two
    // controllers do not contend for the same claimed entry scope.
    const browser2 = setupWithout(missingIds);
    const controller2 = initializeEnvironmentOperations(browser2.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    expect(controller2).not.toBeNull();
    browser2.net.handle(operationsUrl(), () =>
      jsonResponse(op({ currentStage: "verify", steps: [] }))
    );
    controller2?.trackProgress("dev", "azure");
    await flushPromises();
    browser2.net.handle(operationsUrl(), () =>
      jsonResponse({ operation: null })
    );
    browser2.net.handle(verifyUrl(REPO, "dev", "op-1"), () =>
      jsonResponse({
        state: "failed",
        terminal: false,
        error: "Actions run failed",
        runUrl: "https://github.test/octo/widgets/actions/runs/9",
        activity: ""
      })
    );
    await tickClock(browser2.clock, 1500);

    // A third fresh controller for the tracking-window-exceeded guard, which
    // is only reachable on a still-pending verify response.
    const browser3 = setupWithout(missingIds);
    const controller3 = initializeEnvironmentOperations(browser3.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    expect(controller3).not.toBeNull();
    browser3.net.handle(operationsUrl(), () =>
      jsonResponse(
        op({
          currentStage: "verify",
          steps: [],
          verification: { dispatchedAt: 1000 }
        })
      )
    );
    controller3?.trackProgress("dev", "azure");
    await flushPromises();
    browser3.net.handle(operationsUrl(), () =>
      jsonResponse({ operation: null })
    );
    browser3.net.handle(verifyUrl(REPO, "dev", "op-1"), () =>
      jsonResponse({ state: "pending" })
    );
    browser3.clock.tick(46 * 60 * 1000);
    await flushPromises();
  });
});

describe("focus and dismiss", () => {
  it("focuses the panel and scrolls smoothly by default", () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    controller?.focusPanel();
    expect(browser.els[PROGRESS_IDS.panel].focusCount).toBe(1);
    expect(browser.els[PROGRESS_IDS.panel].scrollCount).toBe(1);
  });

  it("scrolls without animation when the dependency reports reduced motion", () => {
    const browser = setup();
    const deps = createDeps({ prefersReducedMotion: () => true });
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: deps.deps
    });
    controller?.focusPanel();
    expect(browser.els[PROGRESS_IDS.panel].focusCount).toBe(1);
  });
});

describe("hostile values", () => {
  it("renders hostile labels and messages as literal text through textContent, never innerHTML", () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    const hostileLabel = "<img src=x onerror=alert(1)>";
    const hostileSummary =
      "\"><script>document.location='https://evil.test'</script>";
    const secretShaped = "sk-live-AAAABBBBCCCCDDDDEEEEFFFF0000";

    controller?.renderProgress(
      record({
        summary: hostileSummary,
        steps: [{ state: "running", label: hostileLabel }],
        failure: { message: secretShaped }
      })
    );

    expect(browser.els[PROGRESS_IDS.title].textContent).toBe(hostileSummary);
    expect(browser.els[PROGRESS_IDS.title].innerHTML).toBe("");
    const stepEl = browser.els[PROGRESS_IDS.steps].children[0];
    expect(stepEl.textContent).toBe(`◐ ${hostileLabel}`);
    expect(stepEl.innerHTML).toBe("");
    // The failure message wins the activity line and must still be plain text.
    expect(browser.els[PROGRESS_IDS.activity].textContent).toBe(secretShaped);
    expect(browser.els[PROGRESS_IDS.activity].innerHTML).toBe("");
  });
});

describe("idempotence", () => {
  it("allows hideProgress and stopProgress to be called with nothing running", () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    expect(() => controller?.stopProgress()).not.toThrow();
    expect(() => controller?.hideProgress()).not.toThrow();
    expect(() => controller?.hideProgress()).not.toThrow();
  });

  it("allows teardown to be called more than once", () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    expect(() => controller?.teardown()).not.toThrow();
    expect(() => controller?.teardown()).not.toThrow();
  });
});

describe("teardown", () => {
  it("stops timers, releases the binding, and prevents a late response from painting", async () => {
    const browser = setup();
    const controller = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    const pending = createDeferred<HttpResponse>();
    browser.net.handle(operationsUrl(), () => pending.promise);

    controller?.trackProgress("dev", "azure");
    await flushPromises();
    browser.els[PROGRESS_IDS.panel].style.display = "marker";
    controller?.teardown();

    expect(browser.clock.pending).toBe(0);
    expect(browser.els[PROGRESS_IDS.dismiss].listenerCount("click")).toBe(0);
    expect(browser.bindings.has(ENVIRONMENT_OPERATIONS_ENTRY_KEY)).toBe(false);
    expect(browser.net.aborted).toBe(1);

    pending.resolve(jsonResponse(op()));
    await flushPromises();
    // The torn-down instance's in-flight response must not paint.
    expect(browser.els[PROGRESS_IDS.panel].style.display).toBe("marker");

    // A new instance can now claim the same entry key.
    const revived = initializeEnvironmentOperations(browser.context, {
      repo: REPO,
      deps: createDeps().deps
    });
    expect(revived).not.toBeNull();
  });
});

describe("OperationResumeError", () => {
  it("carries its retry flag and operation payload", () => {
    const error = new OperationResumeError("nope", true, { some: "payload" });
    expect(error.message).toBe("nope");
    expect(error.retryPrompt).toBe(true);
    expect(error.operation).toEqual({ some: "payload" });
    expect(error.name).toBe("OperationResumeError");
    expect(error).toBeInstanceOf(Error);
  });
});
