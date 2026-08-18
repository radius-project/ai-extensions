import { describe, expect, it, vi } from "vitest";
import {
  APP_SERVES_REPOS_ENDPOINT,
  COMBO_PAIRS,
  DEFAULT_NAMESPACES,
  DISCOVER_ENDPOINT,
  LIST_APP_REGISTRATIONS_ENDPOINT,
  SERVES_LABEL_CONCURRENCY,
  abandonedOperationError,
  initializeDiscoveryPanel,
  parseDiscoveryOptions,
  promptSmr,
  showAppPicker,
  sortDiscoveryOptions
} from "./discovery.js";
import type {
  AppRegistrationCandidate,
  DiscoveryPanelHandle
} from "./discovery.js";
import type { HttpResponse } from "../ports.js";
import {
  createFakeBrowser,
  createFakeElement,
  createFakeInput,
  createFakeSelect,
  fakeText,
  fakeTree,
  flushPromises,
  jsonResponse
} from "../../../test/support/browser/fakes.js";
import type { FakeBrowser } from "../../../test/support/browser/fakes.js";

// Two defensive branches in discovery.ts are not reachable through any real
// public call site and are intentionally left uncovered rather than forced
// with a dishonest test:
//  - renderAzureClusters's `if (hasKeepValue) select.value = keepValue;`
//    (source line 253, false arm): both call sites only ever pass a
//    `keepValue` of "" or a value pre-verified to be present in the same
//    `list` that is about to be rendered into `select`'s options, so
//    `hasKeepValue` can never be false when `keepValue !== ""`.
//  - useExistingApplication's `if (!("appId" in choice)) return;`
//    (source line 636, true arm): this call always passes
//    `allowCreateNew: false` to showAppPicker, so the picker can never
//    resolve with `{ createNew: true }` here.

const HOSTILE = "<img src=x onerror=alert(1)>'\"&";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface DiscoveryPage {
  browser: FakeBrowser;
  selects: Record<string, ReturnType<typeof createFakeSelect>>;
  customs: Record<string, ReturnType<typeof createFakeInput>>;
  azureStatus: ReturnType<typeof createFakeElement>;
  awsStatus: ReturnType<typeof createFakeElement>;
  selectedAppId: ReturnType<typeof createFakeInput>;
  selectedAppNote: ReturnType<typeof createFakeElement>;
  clearPinLink: ReturnType<typeof createFakeElement>;
  useExistingLink: ReturnType<typeof createFakeElement>;
  appNameInput: ReturnType<typeof createFakeInput>;
  smrModal: ReturnType<typeof createFakeElement>;
  smrInput: ReturnType<typeof createFakeInput>;
  smrError: ReturnType<typeof createFakeElement>;
  smrRetry: ReturnType<typeof createFakeInput>;
  smrCancel: ReturnType<typeof createFakeInput>;
  appselectModal: ReturnType<typeof createFakeElement>;
  appselectTitle: ReturnType<typeof createFakeElement>;
  appselectIntro: ReturnType<typeof createFakeElement>;
  appselectCaution: ReturnType<typeof createFakeElement>;
  appselectList: ReturnType<typeof createFakeElement>;
  appselectError: ReturnType<typeof createFakeElement>;
  appselectConfirm: ReturnType<typeof createFakeInput>;
  appselectCancel: ReturnType<typeof createFakeInput>;
}

function renderDiscoveryPage(omit: readonly string[] = []): DiscoveryPage {
  const browser = createFakeBrowser();
  const selects: Record<string, ReturnType<typeof createFakeSelect>> = {};
  const customs: Record<string, ReturnType<typeof createFakeInput>> = {};
  for (const [selectId, customId] of COMBO_PAIRS) {
    const select = createFakeSelect(selectId);
    const custom = createFakeInput(customId);
    selects[selectId] = select;
    customs[customId] = custom;
    if (!omit.includes(selectId)) browser.document.add(select);
    if (!omit.includes(customId)) browser.document.add(custom);
  }
  const azureStatus = createFakeElement("azure-discover-status");
  const awsStatus = createFakeElement("aws-discover-status");
  const selectedAppId = createFakeInput("az-selected-app-id");
  const selectedAppNote = createFakeElement("az-selected-app-note");
  const clearPinLink = createFakeElement("az-clear-pin-link");
  const useExistingLink = createFakeElement("az-use-existing-link");
  const appNameInput = createFakeInput("az-app-name-input");
  const smrModal = createFakeElement("env-smr-modal");
  const smrInput = createFakeInput("env-smr-input");
  const smrError = createFakeElement("env-smr-error");
  const smrRetry = createFakeInput("env-smr-retry");
  const smrCancel = createFakeInput("env-smr-cancel");
  const appselectModal = createFakeElement("env-appselect-modal");
  const appselectTitle = createFakeElement("env-appselect-title");
  const appselectIntro = createFakeElement("env-appselect-intro");
  const appselectCaution = createFakeElement("env-appselect-caution");
  const appselectList = createFakeElement("env-appselect-list");
  const appselectError = createFakeElement("env-appselect-error");
  const appselectConfirm = createFakeInput("env-appselect-confirm");
  const appselectCancel = createFakeInput("env-appselect-cancel");
  for (const element of [
    azureStatus,
    awsStatus,
    selectedAppId,
    selectedAppNote,
    clearPinLink,
    useExistingLink,
    appNameInput,
    smrModal,
    smrInput,
    smrError,
    smrRetry,
    smrCancel,
    appselectModal,
    appselectTitle,
    appselectIntro,
    appselectCaution,
    appselectList,
    appselectError,
    appselectConfirm,
    appselectCancel
  ]) {
    browser.document.add(element);
  }
  return {
    browser,
    selects,
    customs,
    azureStatus,
    awsStatus,
    selectedAppId,
    selectedAppNote,
    clearPinLink,
    useExistingLink,
    appNameInput,
    smrModal,
    smrInput,
    smrError,
    smrRetry,
    smrCancel,
    appselectModal,
    appselectTitle,
    appselectIntro,
    appselectCaution,
    appselectList,
    appselectError,
    appselectConfirm,
    appselectCancel
  };
}

function discoverResponse(data: Record<string, unknown>) {
  return jsonResponse(data);
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

describe("parseDiscoveryOptions", () => {
  it("parses strings, numbers, and booleans into id/name pairs", () => {
    expect(parseDiscoveryOptions(["cluster-a", 42, true])).toEqual([
      { id: "cluster-a", name: "cluster-a" },
      { id: "42", name: "42" },
      { id: "true", name: "true" }
    ]);
  });

  it("drops an empty string item", () => {
    expect(parseDiscoveryOptions(["", "cluster-a"])).toEqual([
      { id: "cluster-a", name: "cluster-a" }
    ]);
  });

  it("parses record items with id, name, and optional resourceGroup", () => {
    expect(
      parseDiscoveryOptions([
        { id: "c1", name: "Cluster One", resourceGroup: "rg-1" },
        { id: "c2" },
        { name: "c3-name-only" }
      ])
    ).toEqual([
      { id: "c1", name: "Cluster One", resourceGroup: "rg-1" },
      { id: "c2", name: "c2", resourceGroup: undefined },
      { id: "c3-name-only", name: "c3-name-only", resourceGroup: undefined }
    ]);
  });

  it("drops a record with neither id nor name, and drops non-record/non-primitive items", () => {
    expect(parseDiscoveryOptions([{}, null, undefined, [1, 2]])).toEqual([]);
  });

  it("keeps hostile text as inert data (no HTML interpretation at this layer)", () => {
    expect(parseDiscoveryOptions([HOSTILE])).toEqual([
      { id: HOSTILE, name: HOSTILE }
    ]);
  });
});

describe("sortDiscoveryOptions", () => {
  it("sorts case-insensitively by name", () => {
    const sorted = sortDiscoveryOptions([
      { id: "b", name: "banana" },
      { id: "a", name: "Apple" },
      { id: "c", name: "cherry" }
    ]);
    expect(sorted.map((option) => option.id)).toEqual(["a", "b", "c"]);
  });

  it("preserves relative order for equal names and does not mutate the input", () => {
    const input = [
      { id: "1", name: "same" },
      { id: "2", name: "same" }
    ];
    const sorted = sortDiscoveryOptions(input);
    expect(sorted.map((option) => option.id)).toEqual(["1", "2"]);
    expect(input.map((option) => option.id)).toEqual(["1", "2"]);
  });

  it("returns an empty array for an empty input", () => {
    expect(sortDiscoveryOptions([])).toEqual([]);
  });
});

describe("abandonedOperationError", () => {
  it("creates an Error tagged with abandonOperation: true", () => {
    const error = abandonedOperationError("cancelled");
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("cancelled");
    expect(error.abandonOperation).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// promptSmr
// ---------------------------------------------------------------------------

describe("promptSmr", () => {
  it("rejects immediately with an abandon-tagged error when any modal element is missing", async () => {
    const browser = createFakeBrowser();
    await expect(promptSmr(browser.context)).rejects.toMatchObject({
      abandonOperation: true,
      message: "Service Management Reference is required to continue."
    });
  });

  it("shows the modal, focuses the input, and resolves the trimmed GUID on a valid retry", async () => {
    const page = renderDiscoveryPage();
    const promise = promptSmr(page.browser.context);
    expect(page.smrModal.style.display).toBe("flex");
    expect(page.smrInput.value).toBe("");
    expect(page.smrError.style.display).toBe("none");
    expect(page.smrInput.focusCount).toBe(1);

    page.smrInput.value = "  123e4567-e89b-12d3-a456-426614174000  ";
    page.smrRetry.dispatch("click");

    await expect(promise).resolves.toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(page.smrModal.style.display).toBe("none");
    expect(page.smrRetry.listenerCount("click")).toBe(0);
    expect(page.smrCancel.listenerCount("click")).toBe(0);
  });

  it("shows a validation error and keeps the modal open for an invalid GUID", async () => {
    const page = renderDiscoveryPage();
    const promise = promptSmr(page.browser.context);
    page.smrInput.value = "not-a-guid";
    page.smrRetry.dispatch("click");

    expect(page.smrError.textContent).toBe("Enter a valid GUID.");
    expect(page.smrError.style.display).toBe("block");
    expect(page.smrModal.style.display).toBe("flex");

    // A subsequent valid retry still resolves the same promise.
    page.smrInput.value = "123e4567-e89b-12d3-a456-426614174000";
    page.smrRetry.dispatch("click");
    await expect(promise).resolves.toBe("123e4567-e89b-12d3-a456-426614174000");
  });

  it("does not reflect hostile input back into the error message", async () => {
    const page = renderDiscoveryPage();
    void promptSmr(page.browser.context);
    page.smrInput.value = HOSTILE;
    page.smrRetry.dispatch("click");
    expect(page.smrError.textContent).toBe("Enter a valid GUID.");
    expect(fakeText(page.smrError)).not.toContain(HOSTILE);
  });

  it("rejects with an abandon-tagged error and closes the modal on cancel", async () => {
    const page = renderDiscoveryPage();
    const promise = promptSmr(page.browser.context);
    page.smrCancel.dispatch("click");
    await expect(promise).rejects.toMatchObject({
      abandonOperation: true,
      message: "Service Management Reference is required to continue."
    });
    expect(page.smrModal.style.display).toBe("none");
    expect(page.smrRetry.listenerCount("click")).toBe(0);
    expect(page.smrCancel.listenerCount("click")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// showAppPicker
// ---------------------------------------------------------------------------

function candidate(
  overrides: Partial<AppRegistrationCandidate> = {}
): AppRegistrationCandidate {
  return { appId: "app-1", displayName: "App One", ...overrides };
}

describe("showAppPicker", () => {
  it("rejects immediately with an abandon-tagged error when any modal element is missing", async () => {
    const browser = createFakeBrowser();
    await expect(
      showAppPicker(browser.context, { candidates: [] })
    ).rejects.toMatchObject({
      abandonOperation: true,
      message: "Identity selection cancelled."
    });
  });

  it("renders the default title/intro and hides the caution line when none is given", async () => {
    const page = renderDiscoveryPage();
    void showAppPicker(page.browser.context, { candidates: [candidate()] });
    expect(page.appselectTitle.textContent).toBe("Choose a deploy identity");
    expect(page.appselectIntro.textContent).toBe("");
    expect(page.appselectCaution.style.display).toBe("none");
  });

  it("renders a custom title/intro/caution and shows the caution line", async () => {
    const page = renderDiscoveryPage();
    void showAppPicker(page.browser.context, {
      title: "Pick one",
      intro: "Choose wisely.",
      caution: "This is risky.",
      candidates: [candidate()]
    });
    expect(page.appselectTitle.textContent).toBe("Pick one");
    expect(page.appselectIntro.textContent).toBe("Choose wisely.");
    expect(page.appselectCaution.textContent).toBe("This is risky.");
    expect(page.appselectCaution.style.display).toBe("block");
  });

  it("renders a row per candidate with primary/secondary text and no HTML injection", async () => {
    const page = renderDiscoveryPage();
    void showAppPicker(page.browser.context, {
      candidates: [
        candidate({
          appId: HOSTILE,
          displayName: HOSTILE,
          createdDateTime: "2024-01-02T00:00:00Z"
        })
      ]
    });
    const rendered = fakeTree(page.appselectList);
    for (const element of rendered) {
      expect(element.innerHTML).toBe("");
    }
    expect(fakeText(page.appselectList)).toContain(HOSTILE);
    expect(fakeText(page.appselectList)).toContain("created 2024-01-02");
  });

  it("falls back to appId as the primary line when displayName is absent", async () => {
    const page = renderDiscoveryPage();
    void showAppPicker(page.browser.context, {
      candidates: [candidate({ appId: "bare-app", displayName: undefined })]
    });
    expect(fakeText(page.appselectList)).toContain("bare-app");
  });

  it("defaults the selection to defaultAppId when present", async () => {
    const page = renderDiscoveryPage();
    const promise = showAppPicker(page.browser.context, {
      candidates: [
        candidate({ appId: "app-1" }),
        candidate({ appId: "app-2" })
      ],
      defaultAppId: "app-2"
    });
    page.appselectConfirm.dispatch("click");
    await expect(promise).resolves.toEqual({ appId: "app-2" });
  });

  it("defaults the selection to the first candidate when defaultAppId is absent", async () => {
    const page = renderDiscoveryPage();
    const promise = showAppPicker(page.browser.context, {
      candidates: [candidate({ appId: "app-1" }), candidate({ appId: "app-2" })]
    });
    page.appselectConfirm.dispatch("click");
    await expect(promise).resolves.toEqual({ appId: "app-1" });
  });

  it("lets a radio change select a different candidate before confirming", async () => {
    const page = renderDiscoveryPage();
    const promise = showAppPicker(page.browser.context, {
      candidates: [candidate({ appId: "app-1" }), candidate({ appId: "app-2" })]
    });
    const radios = fakeTree(page.appselectList).filter(
      (element) => element.tagName === "input"
    );
    const appTwoRadio = radios.find(
      (radio) => radio.getAttribute("value") === "app-2"
    );
    appTwoRadio?.dispatch("change");
    page.appselectConfirm.dispatch("click");
    await expect(promise).resolves.toEqual({ appId: "app-2" });
  });

  it("adds a create-new row and resolves { createNew: true } when chosen and allowed", async () => {
    const page = renderDiscoveryPage();
    const promise = showAppPicker(page.browser.context, {
      candidates: [],
      allowCreateNew: true
    });
    expect(fakeText(page.appselectList)).toContain(
      "Create a new application instead"
    );
    page.appselectConfirm.dispatch("click");
    await expect(promise).resolves.toEqual({ createNew: true });
  });

  it("keeps the first candidate selected instead of defaulting to create-new when candidates exist", async () => {
    const page = renderDiscoveryPage();
    const promise = showAppPicker(page.browser.context, {
      candidates: [candidate({ appId: "app-1" })],
      allowCreateNew: true
    });
    page.appselectConfirm.dispatch("click");
    await expect(promise).resolves.toEqual({ appId: "app-1" });
  });

  it("renders a row for a candidate with an empty appId using the 'create' id and no secondary line", async () => {
    const page = renderDiscoveryPage();
    void showAppPicker(page.browser.context, {
      candidates: [
        candidate({
          appId: "",
          displayName: undefined,
          createdDateTime: undefined
        })
      ]
    });
    const rendered = fakeTree(page.appselectList);
    const radio = rendered.find((element) => element.tagName === "input");
    expect(radio?.id).toBe("appsel-create");
  });

  it("shows a validation error and does not resolve when nothing is selectable", async () => {
    const page = renderDiscoveryPage();
    const promise = showAppPicker(page.browser.context, {
      candidates: [],
      allowCreateNew: false
    });
    page.appselectConfirm.dispatch("click");
    expect(page.appselectError.textContent).toBe(
      "Select an application or choose to create a new one."
    );
    expect(page.appselectError.style.display).toBe("block");
    expect(page.appselectModal.style.display).toBe("flex");

    page.appselectCancel.dispatch("click");
    await expect(promise).rejects.toMatchObject({ abandonOperation: true });
  });

  it("rejects with an abandon-tagged error and closes the modal on cancel", async () => {
    const page = renderDiscoveryPage();
    const promise = showAppPicker(page.browser.context, {
      candidates: [candidate()]
    });
    page.appselectCancel.dispatch("click");
    await expect(promise).rejects.toMatchObject({
      abandonOperation: true,
      message: "Identity selection cancelled."
    });
    expect(page.appselectModal.style.display).toBe("none");
    expect(page.appselectConfirm.listenerCount("click")).toBe(0);
    expect(page.appselectCancel.listenerCount("click")).toBe(0);
  });

  it("uses the server-provided servesRepos label without a network call", async () => {
    const page = renderDiscoveryPage();
    void showAppPicker(page.browser.context, {
      candidates: [candidate({ servesRepos: ["octo/one", "octo/two"] })]
    });
    expect(fakeText(page.appselectList)).toContain(
      "Serves: octo/one, octo/two"
    );
    expect(page.browser.net.calls).toHaveLength(0);
  });

  it("lazily loads and appends the serves label for candidates without one, bounded by concurrency", async () => {
    const page = renderDiscoveryPage();
    const candidateCount = SERVES_LABEL_CONCURRENCY + 2;
    const candidates = Array.from({ length: candidateCount }, (_, index) =>
      candidate({ appId: `app-${index}`, displayName: `App ${index}` })
    );
    const requested: string[] = [];
    // FakeNetwork.handle keys by exact URL, so register one handler per candidate.
    for (const item of candidates) {
      page.browser.net.handle(
        `${APP_SERVES_REPOS_ENDPOINT}?appId=${encodeURIComponent(item.appId)}`,
        () => {
          requested.push(item.appId);
          return jsonResponse({ servesRepos: [`octo/${item.appId}`] });
        }
      );
    }
    void showAppPicker(page.browser.context, { candidates });
    await flushPromises();
    await flushPromises();

    expect(requested.sort()).toEqual(
      candidates.map((item) => item.appId).sort()
    );
    for (const item of candidates) {
      expect(fakeText(page.appselectList)).toContain(
        `Serves: octo/${item.appId}`
      );
    }
  });

  it("skips a best-effort serves label when its request fails", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(
      `${APP_SERVES_REPOS_ENDPOINT}?appId=${encodeURIComponent("app-1")}`,
      () => Promise.reject(new Error("network down"))
    );
    void showAppPicker(page.browser.context, {
      candidates: [candidate({ appId: "app-1" })]
    });
    await flushPromises();
    await flushPromises();
    expect(fakeText(page.appselectList)).not.toContain("Serves:");
  });

  it("does not append a serves label when the lazy-loaded response has no repos", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(
      `${APP_SERVES_REPOS_ENDPOINT}?appId=${encodeURIComponent("app-1")}`,
      () => jsonResponse({ servesRepos: [] })
    );
    void showAppPicker(page.browser.context, {
      candidates: [candidate({ appId: "app-1" })]
    });
    await flushPromises();
    await flushPromises();
    expect(fakeText(page.appselectList)).not.toContain("Serves:");
  });

  it("skips appending a serves label whose row was detached by a later picker render", async () => {
    const page = renderDiscoveryPage();
    let resolveFirst: (value: HttpResponse) => void = () => {};
    const pending = new Promise<HttpResponse>((resolve) => {
      resolveFirst = resolve;
    });
    page.browser.net.handle(
      `${APP_SERVES_REPOS_ENDPOINT}?appId=${encodeURIComponent("app-1")}`,
      () => pending
    );
    void showAppPicker(page.browser.context, {
      candidates: [candidate({ appId: "app-1" })]
    });
    // A second picker render (e.g. a re-invocation) replaces the list's children,
    // detaching the first render's row before its serves-label fetch resolves.
    void showAppPicker(page.browser.context, {
      candidates: [candidate({ appId: "app-2" })]
    });

    resolveFirst(jsonResponse({ servesRepos: ["octo/stale"] }));
    await flushPromises();
    await flushPromises();

    expect(fakeText(page.appselectList)).not.toContain("octo/stale");
  });
});

// ---------------------------------------------------------------------------
// initializeDiscoveryPanel
// ---------------------------------------------------------------------------

describe("initializeDiscoveryPanel gating, idempotence, and teardown", () => {
  it("succeeds even when every optional element is absent from the page", () => {
    const browser = createFakeBrowser();
    const handle = initializeDiscoveryPanel(browser.context);
    expect(handle).not.toBeNull();
    expect(() => handle?.clearSharedAppPin()).not.toThrow();
    expect(() => handle?.teardown()).not.toThrow();
  });

  it("returns null on a second concurrent init and allows re-init after teardown", () => {
    const page = renderDiscoveryPage();
    const first = initializeDiscoveryPanel(page.browser.context);
    expect(first).not.toBeNull();
    const second = initializeDiscoveryPanel(page.browser.context);
    expect(second).toBeNull();

    first?.teardown();
    const third = initializeDiscoveryPanel(page.browser.context);
    expect(third).not.toBeNull();
    third?.teardown();
  });

  it("teardown removes the pin-clear, use-existing, and combo listeners", () => {
    const page = renderDiscoveryPage();
    const handle = initializeDiscoveryPanel(page.browser.context);
    expect(page.clearPinLink.listenerCount("click")).toBe(1);
    expect(page.useExistingLink.listenerCount("click")).toBe(1);
    for (const [selectId] of COMBO_PAIRS) {
      expect(page.selects[selectId].listenerCount("change")).toBeGreaterThan(0);
    }
    handle?.teardown();
    expect(page.clearPinLink.listenerCount("click")).toBe(0);
    expect(page.useExistingLink.listenerCount("click")).toBe(0);
    for (const [selectId] of COMBO_PAIRS) {
      expect(page.selects[selectId].listenerCount("change")).toBe(0);
    }
  });

  it("is idempotent to call teardown twice", () => {
    const page = renderDiscoveryPage();
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.teardown();
    expect(() => handle?.teardown()).not.toThrow();
  });
});

describe("DiscoveryPanelHandle cross-module delegation", () => {
  it("promptServiceManagementReference delegates to promptSmr using the panel's context", async () => {
    const page = renderDiscoveryPage();
    const handle = initializeDiscoveryPanel(page.browser.context);
    const promise = handle?.promptServiceManagementReference();
    expect(page.smrModal.style.display).toBe("flex");
    page.smrInput.value = "11111111-1111-1111-1111-111111111111";
    page.smrRetry.dispatch("click");
    await expect(promise).resolves.toBe("11111111-1111-1111-1111-111111111111");
  });

  it("promptAppSelection delegates to showAppPicker using the panel's context", async () => {
    const page = renderDiscoveryPage();
    const handle = initializeDiscoveryPanel(page.browser.context);
    const promise = handle?.promptAppSelection({
      candidates: [candidate({ appId: "app-1" })]
    });
    page.appselectConfirm.dispatch("click");
    await expect(promise).resolves.toEqual({ appId: "app-1" });
  });
});

describe("clearSharedAppPin", () => {
  it("clears the hidden id, note, clear-link, and restores the app-name input", () => {
    const page = renderDiscoveryPage();
    page.appNameInput.setAttribute("data-default-name", "my-repo");
    page.selectedAppId.value = "app-123";
    page.selectedAppNote.style.display = "block";
    page.selectedAppNote.textContent = "Will reuse: App One (app-123).";
    page.clearPinLink.style.display = "inline";
    page.appNameInput.value = "App One";
    page.appNameInput.disabled = true;
    page.appNameInput.classList.add("rad-input--dimmed");

    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.clearSharedAppPin();

    expect(page.selectedAppId.value).toBe("");
    expect(page.selectedAppNote.style.display).toBe("none");
    expect(page.selectedAppNote.textContent).toBe("");
    expect(page.clearPinLink.style.display).toBe("none");
    expect(page.appNameInput.value).toBe("my-repo");
    expect(page.appNameInput.disabled).toBe(false);
    expect(page.appNameInput.classList.contains("rad-input--dimmed")).toBe(
      false
    );
  });

  it("falls back to an empty name when no data-default-name attribute is set", () => {
    const page = renderDiscoveryPage();
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.clearSharedAppPin();
    expect(page.appNameInput.value).toBe("");
  });

  it("clicking the clear-pin link prevents the default action and clears the pin", () => {
    const page = renderDiscoveryPage();
    page.selectedAppId.value = "app-123";
    initializeDiscoveryPanel(page.browser.context);
    const preventDefault = vi.fn();
    page.clearPinLink.dispatch("click", { preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(page.selectedAppId.value).toBe("");
  });
});

describe("using an existing application", () => {
  it("lists applications, opens the picker, and pins the chosen appId", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(LIST_APP_REGISTRATIONS_ENDPOINT, () =>
      jsonResponse({
        apps: [
          { appId: "app-1", displayName: "App One" },
          { appId: "app-2", displayName: "App Two" }
        ]
      })
    );
    initializeDiscoveryPanel(page.browser.context);

    page.useExistingLink.dispatch("click", { preventDefault: () => {} });
    expect(page.useExistingLink.textContent).toBe("Loading applications…");
    await flushPromises();
    expect(page.useExistingLink.textContent).toBe(
      "Use an existing application…"
    );
    expect(page.appselectModal.style.display).toBe("flex");

    page.appselectConfirm.dispatch("click");
    await flushPromises();

    expect(page.selectedAppId.value).toBe("app-1");
    expect(page.selectedAppNote.textContent).toContain(
      "Will reuse: App One (app-1)"
    );
    expect(page.selectedAppNote.style.display).toBe("block");
    expect(page.clearPinLink.style.display).toBe("inline");
    expect(page.appNameInput.value).toBe("App One");
    expect(page.appNameInput.disabled).toBe(true);
  });

  it("falls back to the appId in the note when the picked candidate has no displayName", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(LIST_APP_REGISTRATIONS_ENDPOINT, () =>
      jsonResponse({ apps: [{ appId: "bare-app" }] })
    );
    initializeDiscoveryPanel(page.browser.context);
    page.useExistingLink.dispatch("click", { preventDefault: () => {} });
    await flushPromises();
    page.appselectConfirm.dispatch("click");
    await flushPromises();
    expect(page.selectedAppNote.textContent).toBe(
      "Will reuse: bare-app (bare-app)."
    );
    expect(page.appNameInput.value).toBe("bare-app");
  });

  it("shows a red note and does not open the picker when the server reports an error", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(LIST_APP_REGISTRATIONS_ENDPOINT, () =>
      jsonResponse({ error: "Graph throttled" })
    );
    initializeDiscoveryPanel(page.browser.context);
    page.useExistingLink.dispatch("click", { preventDefault: () => {} });
    await flushPromises();
    expect(page.selectedAppNote.textContent).toBe(
      "Could not list applications: Graph throttled"
    );
    expect(page.selectedAppNote.style.color).toBe("var(--rad-danger,#cf222e)");
    expect(page.selectedAppNote.style.display).toBe("block");
    expect(page.appselectModal.style.display).toBe("");
  });

  it("shows a red note when there are no owned App Registrations", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(LIST_APP_REGISTRATIONS_ENDPOINT, () =>
      jsonResponse({ apps: [] })
    );
    initializeDiscoveryPanel(page.browser.context);
    page.useExistingLink.dispatch("click", { preventDefault: () => {} });
    await flushPromises();
    expect(page.selectedAppNote.textContent).toBe(
      "You do not own any App Registrations yet — create one instead."
    );
    expect(page.selectedAppNote.style.color).toBe("var(--rad-danger,#cf222e)");
  });

  it("drops apps missing an appId before counting candidates", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(LIST_APP_REGISTRATIONS_ENDPOINT, () =>
      jsonResponse({ apps: [{ displayName: "No id" }] })
    );
    initializeDiscoveryPanel(page.browser.context);
    page.useExistingLink.dispatch("click", { preventDefault: () => {} });
    await flushPromises();
    expect(page.selectedAppNote.textContent).toBe(
      "You do not own any App Registrations yet — create one instead."
    );
  });

  it("restores the link text and shows a red note on a network error", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(LIST_APP_REGISTRATIONS_ENDPOINT, () =>
      Promise.reject(new Error("offline"))
    );
    initializeDiscoveryPanel(page.browser.context);
    page.useExistingLink.dispatch("click", { preventDefault: () => {} });
    await flushPromises();
    expect(page.useExistingLink.textContent).toBe(
      "Use an existing application…"
    );
    expect(page.selectedAppNote.textContent).toBe(
      "Could not list applications: offline"
    );
    expect(page.selectedAppNote.style.color).toBe("var(--rad-danger,#cf222e)");
  });

  it("leaves the pin untouched when the picker is cancelled", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(LIST_APP_REGISTRATIONS_ENDPOINT, () =>
      jsonResponse({ apps: [{ appId: "app-1", displayName: "App One" }] })
    );
    initializeDiscoveryPanel(page.browser.context);
    page.useExistingLink.dispatch("click", { preventDefault: () => {} });
    await flushPromises();
    page.appselectCancel.dispatch("click");
    await flushPromises();
    expect(page.selectedAppId.value).toBe("");
    expect(page.selectedAppNote.textContent).toBe("");
  });

  function renderMinimalUseExistingPage(): {
    browser: FakeBrowser;
    useExistingLink: ReturnType<typeof createFakeElement>;
    appselectModal: ReturnType<typeof createFakeElement>;
    appselectList: ReturnType<typeof createFakeElement>;
    appselectConfirm: ReturnType<typeof createFakeInput>;
    appselectCancel: ReturnType<typeof createFakeInput>;
  } {
    const browser = createFakeBrowser();
    const useExistingLink = createFakeElement("az-use-existing-link");
    const appselectModal = createFakeElement("env-appselect-modal");
    const appselectTitle = createFakeElement("env-appselect-title");
    const appselectIntro = createFakeElement("env-appselect-intro");
    const appselectCaution = createFakeElement("env-appselect-caution");
    const appselectList = createFakeElement("env-appselect-list");
    const appselectError = createFakeElement("env-appselect-error");
    const appselectConfirm = createFakeInput("env-appselect-confirm");
    const appselectCancel = createFakeInput("env-appselect-cancel");
    // Deliberately omit az-selected-app-id, az-selected-app-note,
    // az-clear-pin-link, and az-app-name-input to cover the code paths that
    // treat those elements as optional.
    for (const element of [
      useExistingLink,
      appselectModal,
      appselectTitle,
      appselectIntro,
      appselectCaution,
      appselectList,
      appselectError,
      appselectConfirm,
      appselectCancel
    ]) {
      browser.document.add(element);
    }
    return {
      browser,
      useExistingLink,
      appselectModal,
      appselectList,
      appselectConfirm,
      appselectCancel
    };
  }

  it("lists and pins an existing application when every optional pin/name element is absent", async () => {
    const page = renderMinimalUseExistingPage();
    page.browser.net.handle(LIST_APP_REGISTRATIONS_ENDPOINT, () =>
      jsonResponse({ apps: [{ appId: "app-1", displayName: "App One" }] })
    );
    initializeDiscoveryPanel(page.browser.context);
    page.useExistingLink.dispatch("click", { preventDefault: () => {} });
    await flushPromises();
    expect(page.appselectModal.style.display).toBe("flex");
    page.appselectConfirm.dispatch("click");
    await flushPromises();
    // No pin/name elements exist to assert on; reaching here without a
    // thrown error is the behavior under test for the optional-element gates.
    expect(page.appselectModal.style.display).toBe("none");
  });

  it("reports a server error without throwing when the note element is absent", async () => {
    const page = renderMinimalUseExistingPage();
    page.browser.net.handle(LIST_APP_REGISTRATIONS_ENDPOINT, () =>
      jsonResponse({ error: "Graph throttled" })
    );
    initializeDiscoveryPanel(page.browser.context);
    page.useExistingLink.dispatch("click", { preventDefault: () => {} });
    await expect(flushPromises()).resolves.toBeUndefined();
    expect(page.appselectModal.style.display).not.toBe("flex");
  });

  it("reports no owned App Registrations without throwing when the note element is absent", async () => {
    const page = renderMinimalUseExistingPage();
    page.browser.net.handle(LIST_APP_REGISTRATIONS_ENDPOINT, () =>
      jsonResponse({ apps: [] })
    );
    initializeDiscoveryPanel(page.browser.context);
    page.useExistingLink.dispatch("click", { preventDefault: () => {} });
    await expect(flushPromises()).resolves.toBeUndefined();
  });

  it("reports a network failure without throwing when the note element is absent", async () => {
    const page = renderMinimalUseExistingPage();
    page.browser.net.handle(LIST_APP_REGISTRATIONS_ENDPOINT, () =>
      Promise.reject(new Error("offline"))
    );
    initializeDiscoveryPanel(page.browser.context);
    page.useExistingLink.dispatch("click", { preventDefault: () => {} });
    await expect(flushPromises()).resolves.toBeUndefined();
    expect(page.useExistingLink.textContent).toBe(
      "Use an existing application…"
    );
  });
});

describe("combo select custom-value reveal", () => {
  it.each(COMBO_PAIRS)(
    "reveals and focuses %s's custom input only when __custom__ is chosen",
    (selectId, customId) => {
      const page = renderDiscoveryPage();
      initializeDiscoveryPanel(page.browser.context);
      const select = page.selects[selectId];
      const custom = page.customs[customId];

      select.value = "__custom__";
      select.dispatch("change");
      expect(custom.style.display).toBe("");
      expect(custom.focusCount).toBe(1);

      select.value = "some-real-value";
      select.dispatch("change");
      expect(custom.style.display).toBe("none");
    }
  );

  it("skips wiring a combo pair when its select or custom input is missing", () => {
    const browser = createFakeBrowser();
    // Only the select half of the first pair exists; no custom input.
    const [selectId] = COMBO_PAIRS[0];
    const select = createFakeSelect(selectId);
    browser.document.add(select);
    expect(() => initializeDiscoveryPanel(browser.context)).not.toThrow();
    expect(select.listenerCount("change")).toBe(0);
  });
});

describe("getComboValue", () => {
  it("returns an empty string when the select is missing", () => {
    const browser = createFakeBrowser();
    const handle = initializeDiscoveryPanel(browser.context);
    expect(
      handle?.getComboValue("azure-cluster-select", "azure-cluster-custom")
    ).toBe("");
  });

  it("returns the select's value when it is not __custom__", () => {
    const page = renderDiscoveryPage();
    const handle = initializeDiscoveryPanel(page.browser.context);
    page.selects["azure-cluster-select"].value = "cluster-1";
    expect(
      handle?.getComboValue("azure-cluster-select", "azure-cluster-custom")
    ).toBe("cluster-1");
  });

  it("returns the custom input's value when the select is __custom__", () => {
    const page = renderDiscoveryPage();
    const handle = initializeDiscoveryPanel(page.browser.context);
    page.selects["azure-cluster-select"].value = "__custom__";
    page.customs["azure-cluster-custom"].value = "manual-cluster";
    expect(
      handle?.getComboValue("azure-cluster-select", "azure-cluster-custom")
    ).toBe("manual-cluster");
  });

  it("returns an empty string when the select is __custom__ but the custom input is missing", () => {
    const browser = createFakeBrowser();
    const select = createFakeSelect("azure-cluster-select");
    select.value = "__custom__";
    browser.document.add(select);
    const handle = initializeDiscoveryPanel(browser.context);
    expect(
      handle?.getComboValue("azure-cluster-select", "azure-cluster-custom")
    ).toBe("");
  });
});

describe("discoverResources", () => {
  function azurePayload(overrides: Record<string, unknown> = {}) {
    return {
      clusters: [{ id: "aks-1", name: "AKS One", resourceGroup: "rg-1" }],
      resourceGroups: [{ id: "rg-1", name: "rg-1" }],
      ...overrides
    };
  }

  it("sends the exact POST request shape, omitting empty subscriptionId/tenantId", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, (init) => {
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ "Content-Type": "application/json" });
      expect(JSON.parse(init?.body ?? "{}")).toEqual({ provider: "azure" });
      return discoverResponse(azurePayload());
    });
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("azure", "", "");
  });

  it("includes subscriptionId and tenantId in the request body when provided", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, (init) => {
      expect(JSON.parse(init?.body ?? "{}")).toEqual({
        provider: "azure",
        subscriptionId: "sub-1",
        tenantId: "tenant-1"
      });
      return discoverResponse(azurePayload());
    });
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("azure", "sub-1", "tenant-1");
  });

  it("renders azure clusters, resource groups, and default namespaces on success", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(azurePayload())
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("azure", "", "");

    expect(page.azureStatus.textContent).toBe(
      "Found 1 cluster(s), 1 resource group(s)"
    );
    const clusterSelect = page.selects["azure-cluster-select"];
    expect(
      Array.from(clusterSelect.options).map((option) => option.value)
    ).toEqual(["", "aks-1", "__custom__"]);
    const namespaceSelect = page.selects["azure-namespace-select"];
    expect(
      Array.from(namespaceSelect.options).map((option) => option.value)
    ).toEqual(["", ...DEFAULT_NAMESPACES, "__custom__"]);
  });

  it("restores a saved azure selection once discovery has populated the lists", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(azurePayload())
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection({
      resourceGroup: "rg-1",
      cluster: "aks-1",
      namespace: "default"
    });

    await handle?.discoverResources("azure", "", "");

    expect(page.selects["azure-rg-select"].value).toBe("rg-1");
    expect(page.selects["azure-cluster-select"].value).toBe("aks-1");
    expect(page.selects["azure-namespace-select"].value).toBe("default");
  });

  it("restores an azure value the discovered lists do not offer as a custom entry", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(azurePayload())
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection({ resourceGroup: "rg-gone" });

    await handle?.discoverResources("azure", "", "");

    expect(page.selects["azure-rg-select"].value).toBe("__custom__");
    expect(page.customs["azure-rg-custom"].value).toBe("rg-gone");
    expect(page.customs["azure-rg-custom"].style.display).toBe("");
  });

  it("applies a saved selection only once", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(azurePayload())
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection({ resourceGroup: "rg-1" });
    await handle?.discoverResources("azure", "", "");
    page.selects["azure-rg-select"].value = "";

    await handle?.discoverResources("azure", "", "");

    // A restore is a one-shot hand-off from the edit form; re-running discovery
    // must not overwrite what the user has since chosen.
    expect(page.selects["azure-rg-select"].value).toBe("");
  });

  it("leaves the selects untouched when nothing was saved", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(azurePayload())
    );
    const handle = initializeDiscoveryPanel(page.browser.context);

    await handle?.discoverResources("azure", "", "");

    expect(page.selects["azure-rg-select"].value).toBe("");
    expect(page.customs["azure-rg-custom"].value).toBe("");
  });

  it("ignores a saved selection whose fields are all empty", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(azurePayload())
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection({});

    await handle?.discoverResources("azure", "", "");

    expect(page.selects["azure-rg-select"].value).toBe("");
    expect(page.customs["azure-rg-custom"].value).toBe("");
  });

  it("ignores a saved aws selection whose fields are all empty", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse({ clusters: [{ id: "eks-1", name: "EKS One" }] })
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection({});

    await handle?.discoverResources("aws", "", "");

    expect(page.customs["aws-cluster-custom"].value).toBe("");
    expect(page.customs["aws-vpc-custom"].value).toBe("");
    expect(page.customs["aws-subnets-custom"].value).toBe("");
  });

  it("drops a saved value when its select is missing from the page", async () => {
    const page = renderDiscoveryPage(["azure-rg-select"]);
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(azurePayload())
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection({ resourceGroup: "rg-gone" });

    await handle?.discoverResources("azure", "", "");

    expect(page.customs["azure-rg-custom"].value).toBe("");
  });

  it("drops a saved value that has nowhere to go without its custom input", async () => {
    const page = renderDiscoveryPage(["azure-rg-custom"]);
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(azurePayload())
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection({ resourceGroup: "rg-gone" });

    await handle?.discoverResources("azure", "", "");

    expect(page.selects["azure-rg-select"].value).toBe("");
  });

  it("reports the current aws selection for a form that is being reopened", () => {
    const page = renderDiscoveryPage();
    const handle = initializeDiscoveryPanel(page.browser.context);
    page.selects["aws-cluster-select"].value = "eks-1";
    page.selects["aws-vpc-select"].value = "vpc-1";
    page.selects["aws-subnets-select"].value = "subnet-1";

    expect(handle?.currentInfraSelection("aws")).toEqual(
      expect.objectContaining({
        cluster: "eks-1",
        vpcId: "vpc-1",
        subnetIds: "subnet-1"
      })
    );
  });

  it("reports the current azure selection for a form that is being reopened", () => {
    const page = renderDiscoveryPage();
    const handle = initializeDiscoveryPanel(page.browser.context);
    page.selects["azure-rg-select"].value = "rg-1";
    page.selects["azure-cluster-select"].value = "__custom__";
    page.customs["azure-cluster-custom"].value = "aks-custom";

    expect(handle?.currentInfraSelection("azure")).toEqual(
      expect.objectContaining({
        resourceGroup: "rg-1",
        cluster: "aks-custom"
      })
    );
  });

  it("restores a saved aws selection across every infrastructure field", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse({
        clusters: [{ id: "eks-1", name: "EKS One" }],
        namespaces: ["team-a"],
        vpcs: [{ id: "vpc-1", name: "vpc-1" }],
        subnets: [{ id: "subnet-1", name: "subnet-1" }]
      })
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection({
      cluster: "eks-1",
      namespace: "team-a",
      vpcId: "vpc-1",
      subnetIds: "subnet-1"
    });

    await handle?.discoverResources("aws", "", "");

    expect(page.selects["aws-cluster-select"].value).toBe("eks-1");
    expect(page.selects["aws-namespace-select"].value).toBe("team-a");
    expect(page.selects["aws-vpc-select"].value).toBe("vpc-1");
    expect(page.selects["aws-subnets-select"].value).toBe("subnet-1");
  });

  it("renders an explicit empty namespaces array as no options, not the defaults", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(azurePayload({ namespaces: [] }))
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("azure", "", "");
    const namespaceSelect = page.selects["azure-namespace-select"];
    expect(
      Array.from(namespaceSelect.options).map((option) => option.value)
    ).toEqual(["", "__custom__"]);
  });

  it("renders aws clusters, namespaces, VPCs, and subnets on success with a leading None option", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse({
        clusters: [{ id: "eks-1", name: "EKS One" }],
        vpcs: [{ id: "vpc-1", name: "VPC One" }],
        subnets: [{ id: "subnet-1", name: "Subnet One" }]
      })
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("aws", "", "");

    expect(page.awsStatus.textContent).toBe("Found 1 cluster(s), 1 VPC(s)");
    const vpcSelect = page.selects["aws-vpc-select"];
    expect(Array.from(vpcSelect.options).map((option) => option.value)).toEqual(
      ["", "", "vpc-1", "__custom__"]
    );
    expect(
      Array.from(vpcSelect.options).map((option) => option.textContent)
    ).toContain("None (optional)");
  });

  it("treats a malformed (non-array) clusters field as an empty result", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse({ clusters: "not-an-array", resourceGroups: [] })
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("azure", "", "");
    const clusterSelect = page.selects["azure-cluster-select"];
    expect(
      Array.from(clusterSelect.options).map((option) => option.value)
    ).toEqual(["", "__custom__"]);
    expect(clusterSelect.options[0].textContent).toBe("No resources found");
  });

  it("surfaces a per-resource discovery error via the status text", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse({ errors: { resourceGroups: "permission denied" } })
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("azure", "", "");
    expect(page.azureStatus.textContent).toBe(
      "Discovery failed: permission denied"
    );
  });

  it("shows a discovery error message on a network failure", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      Promise.reject(new Error("boom"))
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("azure", "", "");
    expect(page.azureStatus.textContent).toBe("Discovery error: boom");
  });

  it("reads the message field from a record-shaped (non-Error) rejection", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      Promise.reject({ message: "record failure" })
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("azure", "", "");
    expect(page.azureStatus.textContent).toBe(
      "Discovery error: record failure"
    );
  });

  it("stringifies a rejection that is neither an Error nor a message-bearing record", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      Promise.reject("plain string failure")
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("azure", "", "");
    expect(page.azureStatus.textContent).toBe(
      "Discovery error: plain string failure"
    );
  });

  it("stringifies a message-less record-shaped rejection", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      Promise.reject({ code: 500 })
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("azure", "", "");
    expect(page.azureStatus.textContent).toBe(
      "Discovery error: [object Object]"
    );
  });

  it("drops a non-string per-resource error entry instead of surfacing it", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse({ ...azurePayload(), errors: { resourceGroups: 500 } })
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("azure", "", "");
    expect(page.azureStatus.textContent).toBe(
      "Found 1 cluster(s), 1 resource group(s)"
    );
  });

  it("defaults every list when the response body is not a JSON object", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () => jsonResponse([]));
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("azure", "", "");
    const namespaceSelect = page.selects["azure-namespace-select"];
    // A non-object response body cannot carry a "namespaces" key, so the
    // default namespace list is used rather than an empty result.
    expect(namespaceSelect.options).toHaveLength(DEFAULT_NAMESPACES.length + 2);
    const clusterSelect = page.selects["azure-cluster-select"];
    expect(
      Array.from(clusterSelect.options).map((option) => option.value)
    ).toEqual(["", "__custom__"]);
  });

  it("does not throw when the azure-cluster-select element is absent", async () => {
    const browser = createFakeBrowser();
    for (const [selectId, customId] of COMBO_PAIRS) {
      if (selectId === "azure-cluster-select") continue;
      browser.document.add(createFakeSelect(selectId));
      browser.document.add(createFakeInput(customId));
    }
    browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(azurePayload())
    );
    const handle = initializeDiscoveryPanel(browser.context);
    await expect(
      handle?.discoverResources("azure", "", "")
    ).resolves.toBeUndefined();
  });

  it("suppresses a duplicate azure discovery for the same account while one is in flight", async () => {
    const page = renderDiscoveryPage();
    let resolveFirst: (value: HttpResponse) => void = () => {};
    const first = new Promise<HttpResponse>((resolve) => {
      resolveFirst = resolve;
    });
    let callCount = 0;
    page.browser.net.handle(DISCOVER_ENDPOINT, () => {
      callCount += 1;
      return callCount === 1 ? first : (
          discoverResponse({
            clusters: [{ id: "aks-2", name: "AKS Two" }],
            resourceGroups: []
          })
        );
    });
    const handle = initializeDiscoveryPanel(page.browser.context);
    const firstCall = handle?.discoverResources("azure", "", "");
    const secondCall = handle?.discoverResources("azure", "", "");
    await secondCall;
    resolveFirst(discoverResponse(azurePayload()));
    await firstCall;
    await flushPromises();

    // The overlapping request repeats the same account, so it never reaches
    // the network and the first response is the only one that can land.
    expect(callCount).toBe(1);
    const clusterSelect = page.selects["azure-cluster-select"];
    expect(
      Array.from(clusterSelect.options).map((option) => option.value)
    ).toEqual(["", "aks-1", "__custom__"]);
  });

  it("keeps Refresh disabled when a duplicate request is suppressed", async () => {
    const page = renderDiscoveryPage();
    const refreshBtn = createFakeInput("azure-refresh-btn");
    page.browser.document.add(refreshBtn);
    let resolveFirst: (value: HttpResponse) => void = () => {};
    const first = new Promise<HttpResponse>((resolve) => {
      resolveFirst = resolve;
    });
    page.browser.net.handle(DISCOVER_ENDPOINT, () => first);
    const handle = initializeDiscoveryPanel(page.browser.context);
    const firstCall = handle?.discoverResources("azure", "sub-1", "tenant-1");
    // Profile selection optimistically re-enables Refresh before delegating
    // back into discovery; the suppressed duplicate must re-assert it.
    refreshBtn.disabled = false;
    await handle?.discoverResources("azure", "sub-1", "tenant-1");
    expect(refreshBtn.disabled).toBe(true);

    resolveFirst(discoverResponse(azurePayload()));
    await firstCall;
    await flushPromises();
    expect(refreshBtn.disabled).toBe(false);
  });

  it("supersedes an in-flight azure discovery when the account changes", async () => {
    const page = renderDiscoveryPage();
    let resolveFirst: (value: HttpResponse) => void = () => {};
    const first = new Promise<HttpResponse>((resolve) => {
      resolveFirst = resolve;
    });
    const bodies: string[] = [];
    page.browser.net.handle(DISCOVER_ENDPOINT, (init) => {
      bodies.push(init?.body ?? "");
      return bodies.length === 1 ?
          first
        : discoverResponse(
            azurePayload({
              clusters: [
                { id: "aks-2", name: "AKS Two", resourceGroup: "rg-2" }
              ]
            })
          );
    });
    const handle = initializeDiscoveryPanel(page.browser.context);
    const firstCall = handle?.discoverResources("azure", "sub-1", "tenant-1");
    // Switching to a different subscription is a different question, so it
    // must be issued rather than dropped as a duplicate.
    await handle?.discoverResources("azure", "sub-2", "tenant-1");
    await flushPromises();

    expect(bodies).toHaveLength(2);
    expect(JSON.parse(bodies[1]).subscriptionId).toBe("sub-2");
    const clusterSelect = page.selects["azure-cluster-select"];
    expect(
      Array.from(clusterSelect.options).map((option) => option.value)
    ).toEqual(["", "aks-2", "__custom__"]);

    // The superseded response lands last and must not overwrite the newer
    // account's resource list.
    resolveFirst(discoverResponse(azurePayload()));
    await firstCall;
    await flushPromises();
    expect(
      Array.from(clusterSelect.options).map((option) => option.value)
    ).toEqual(["", "aks-2", "__custom__"]);
  });

  it("leaves Refresh disabled when a superseded response settles first", async () => {
    const page = renderDiscoveryPage();
    const refreshBtn = createFakeInput("azure-refresh-btn");
    page.browser.document.add(refreshBtn);
    let resolveFirst: (value: HttpResponse) => void = () => {};
    let resolveSecond: (value: HttpResponse) => void = () => {};
    const first = new Promise<HttpResponse>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<HttpResponse>((resolve) => {
      resolveSecond = resolve;
    });
    let callCount = 0;
    page.browser.net.handle(DISCOVER_ENDPOINT, () => {
      callCount += 1;
      return callCount === 1 ? first : second;
    });
    const handle = initializeDiscoveryPanel(page.browser.context);
    const firstCall = handle?.discoverResources("azure", "sub-1", "tenant-1");
    const secondCall = handle?.discoverResources("azure", "sub-2", "tenant-1");

    resolveFirst(discoverResponse(azurePayload()));
    await firstCall;
    await flushPromises();
    // The newer request still owns the panel, so its predecessor completing
    // must not hand Refresh back to the user.
    expect(refreshBtn.disabled).toBe(true);

    resolveSecond(discoverResponse(azurePayload()));
    await secondCall;
    await flushPromises();
    expect(refreshBtn.disabled).toBe(false);
  });

  it("re-runs a discovery for an account whose earlier request already finished", async () => {
    const page = renderDiscoveryPage();
    let callCount = 0;
    page.browser.net.handle(DISCOVER_ENDPOINT, () => {
      callCount += 1;
      return discoverResponse(azurePayload());
    });
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("azure", "sub-1", "tenant-1");
    // Suppression is scoped to in-flight requests; an explicit Refresh for the
    // same account after the first settled must still reach the network.
    await handle?.discoverResources("azure", "sub-1", "tenant-1");
    expect(callCount).toBe(2);
  });

  it("tracks azure and aws staleness independently", async () => {
    const page = renderDiscoveryPage();
    let resolveAzure: (value: HttpResponse) => void = () => {};
    const azureFirst = new Promise<HttpResponse>((resolve) => {
      resolveAzure = resolve;
    });
    page.browser.net.handle(DISCOVER_ENDPOINT, (init) => {
      const body = JSON.parse(init?.body ?? "{}");
      if (body.provider === "azure") return azureFirst;
      return discoverResponse({ clusters: [{ id: "eks-1", name: "EKS One" }] });
    });
    const handle = initializeDiscoveryPanel(page.browser.context);
    const azureCall = handle?.discoverResources("azure", "", "");
    const awsCall = handle?.discoverResources("aws", "", "");
    await awsCall;
    resolveAzure(discoverResponse(azurePayload()));
    await azureCall;
    await flushPromises();

    // The aws request completing must not have marked the azure request stale.
    const clusterSelect = page.selects["azure-cluster-select"];
    expect(
      Array.from(clusterSelect.options).map((option) => option.value)
    ).toEqual(["", "aks-1", "__custom__"]);
  });

  it("drops a stale response after teardown", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(azurePayload())
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    const pending = handle?.discoverResources("azure", "", "");
    handle?.teardown();
    await expect(pending).resolves.toBeUndefined();
    const clusterSelect = page.selects["azure-cluster-select"];
    expect(clusterSelect.options).toHaveLength(0);
  });

  it("drops a stale rejected response after teardown", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      Promise.reject(new Error("boom"))
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    const pending = handle?.discoverResources("azure", "", "");
    handle?.teardown();
    await expect(pending).resolves.toBeUndefined();
    expect(page.azureStatus.textContent).toBe("Discovering resources…");
  });

  it("does not throw when the status element is absent", async () => {
    const browser = createFakeBrowser();
    for (const [selectId, customId] of COMBO_PAIRS) {
      browser.document.add(createFakeSelect(selectId));
      browser.document.add(createFakeInput(customId));
    }
    browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse({ clusters: [] })
    );
    const handle = initializeDiscoveryPanel(browser.context);
    await expect(
      handle?.discoverResources("azure", "", "")
    ).resolves.toBeUndefined();
    await expect(
      handle?.discoverResources("aws", "", "")
    ).resolves.toBeUndefined();
  });

  it("does not throw on a network failure when the status element is absent", async () => {
    const browser = createFakeBrowser();
    for (const [selectId, customId] of COMBO_PAIRS) {
      browser.document.add(createFakeSelect(selectId));
      browser.document.add(createFakeInput(customId));
    }
    browser.net.handle(DISCOVER_ENDPOINT, () =>
      Promise.reject(new Error("boom"))
    );
    const handle = initializeDiscoveryPanel(browser.context);
    await expect(
      handle?.discoverResources("azure", "", "")
    ).resolves.toBeUndefined();
  });
});

describe("azure resource-group / cluster cross-filter", () => {
  async function loadTwoClusters(
    page: DiscoveryPage,
    handle: DiscoveryPanelHandle | null
  ) {
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse({
        clusters: [
          { id: "aks-1", name: "AKS One", resourceGroup: "rg-1" },
          { id: "aks-2", name: "AKS Two", resourceGroup: "rg-2" }
        ],
        resourceGroups: [
          { id: "rg-1", name: "rg-1" },
          { id: "rg-2", name: "rg-2" }
        ]
      })
    );
    await handle?.discoverResources("azure", "", "");
  }

  it("filters the cluster list to the chosen resource group and reselects the only match", async () => {
    const page = renderDiscoveryPage();
    const handle = initializeDiscoveryPanel(page.browser.context);
    await loadTwoClusters(page, handle);

    const clusterSelect = page.selects["azure-cluster-select"];
    const rgSelect = page.selects["azure-rg-select"];
    clusterSelect.value = "aks-2";
    rgSelect.value = "rg-1";
    rgSelect.dispatch("change");

    expect(
      Array.from(clusterSelect.options).map((option) => option.value)
    ).toEqual(["", "aks-1", "__custom__"]);
    // The previous selection is no longer in the filtered list, and a single
    // remaining cluster is unambiguous, so it is selected outright.
    expect(clusterSelect.value).toBe("aks-1");
  });

  it("excludes a cluster without a resource group when filtering by resource group", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse({
        clusters: [
          { id: "aks-1", name: "AKS One", resourceGroup: "rg-1" },
          { id: "aks-unassigned", name: "AKS Unassigned" }
        ],
        resourceGroups: [{ id: "rg-1", name: "rg-1" }]
      })
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("azure", "", "");

    const clusterSelect = page.selects["azure-cluster-select"];
    const rgSelect = page.selects["azure-rg-select"];
    rgSelect.value = "rg-1";
    rgSelect.dispatch("change");

    expect(
      Array.from(clusterSelect.options).map((option) => option.value)
    ).toEqual(["", "aks-1", "__custom__"]);
  });

  it("keeps the cluster selection when it still matches the chosen resource group", async () => {
    const page = renderDiscoveryPage();
    const handle = initializeDiscoveryPanel(page.browser.context);
    await loadTwoClusters(page, handle);

    const clusterSelect = page.selects["azure-cluster-select"];
    const rgSelect = page.selects["azure-rg-select"];
    clusterSelect.value = "aks-1";
    rgSelect.value = "rg-1";
    rgSelect.dispatch("change");

    expect(clusterSelect.value).toBe("aks-1");
  });

  it("shows every cluster again when the resource group is cleared or set to custom", async () => {
    const page = renderDiscoveryPage();
    const handle = initializeDiscoveryPanel(page.browser.context);
    await loadTwoClusters(page, handle);

    const clusterSelect = page.selects["azure-cluster-select"];
    const rgSelect = page.selects["azure-rg-select"];
    rgSelect.value = "";
    rgSelect.dispatch("change");
    expect(
      Array.from(clusterSelect.options).map((option) => option.value)
    ).toEqual(["", "aks-1", "aks-2", "__custom__"]);

    rgSelect.value = "__custom__";
    rgSelect.dispatch("change");
    expect(
      Array.from(clusterSelect.options).map((option) => option.value)
    ).toEqual(["", "aks-1", "aks-2", "__custom__"]);
  });

  it("back-fills the resource group when selecting a cluster that carries one", async () => {
    const page = renderDiscoveryPage();
    const handle = initializeDiscoveryPanel(page.browser.context);
    await loadTwoClusters(page, handle);

    const clusterSelect = page.selects["azure-cluster-select"];
    const rgSelect = page.selects["azure-rg-select"];
    clusterSelect.value = "aks-1";
    clusterSelect.dispatch("change");

    expect(rgSelect.value).toBe("rg-1");
    expect(
      Array.from(rgSelect.options).map((option) => option.value)
    ).toContain("rg-1");
  });

  it("adds a missing resource-group option before the custom entry when back-filling", async () => {
    const page = renderDiscoveryPage();
    const handle = initializeDiscoveryPanel(page.browser.context);
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse({
        clusters: [
          { id: "aks-1", name: "AKS One", resourceGroup: "rg-unlisted" }
        ],
        resourceGroups: []
      })
    );
    await handle?.discoverResources("azure", "", "");

    const clusterSelect = page.selects["azure-cluster-select"];
    const rgSelect = page.selects["azure-rg-select"];
    clusterSelect.value = "aks-1";
    clusterSelect.dispatch("change");

    const values = Array.from(rgSelect.options).map((option) => option.value);
    expect(values.indexOf("rg-unlisted")).toBeLessThan(
      values.indexOf("__custom__")
    );
    expect(rgSelect.value).toBe("rg-unlisted");
  });

  it("appends the missing resource-group option at the end when no __custom__ entry exists", async () => {
    const page = renderDiscoveryPage();
    const handle = initializeDiscoveryPanel(page.browser.context);
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse({
        clusters: [
          { id: "aks-1", name: "AKS One", resourceGroup: "rg-unlisted" }
        ],
        resourceGroups: []
      })
    );
    await handle?.discoverResources("azure", "", "");

    const clusterSelect = page.selects["azure-cluster-select"];
    const rgSelect = page.selects["azure-rg-select"];
    // Simulate a resource-group select whose markup never got a trailing
    // "__custom__" entry, exercising the append-at-end fallback path.
    rgSelect.replaceChildren();
    clusterSelect.value = "aks-1";
    clusterSelect.dispatch("change");

    const values = Array.from(rgSelect.options).map((option) => option.value);
    expect(values.at(-1)).toBe("rg-unlisted");
    expect(rgSelect.value).toBe("rg-unlisted");
  });

  it("does nothing when the cluster change selects __custom__, empty, an unknown cluster, or one without a resource group", async () => {
    const page = renderDiscoveryPage();
    const handle = initializeDiscoveryPanel(page.browser.context);
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse({
        clusters: [{ id: "aks-no-rg", name: "AKS No RG" }],
        resourceGroups: []
      })
    );
    await handle?.discoverResources("azure", "", "");

    const clusterSelect = page.selects["azure-cluster-select"];
    const rgSelect = page.selects["azure-rg-select"];
    const initialRgValues = Array.from(rgSelect.options).map(
      (option) => option.value
    );

    clusterSelect.value = "__custom__";
    clusterSelect.dispatch("change");
    clusterSelect.value = "";
    clusterSelect.dispatch("change");
    clusterSelect.value = "unknown-cluster";
    clusterSelect.dispatch("change");
    clusterSelect.value = "aks-no-rg";
    clusterSelect.dispatch("change");

    expect(Array.from(rgSelect.options).map((option) => option.value)).toEqual(
      initialRgValues
    );
  });

  it("wires the cross-filter only once across repeated azure discoveries", async () => {
    const page = renderDiscoveryPage();
    const handle = initializeDiscoveryPanel(page.browser.context);
    await loadTwoClusters(page, handle);
    // Each select already carries one "change" listener from the combo-pair
    // custom-value reveal wiring; a second discovery must not add another
    // cross-filter listener on top of that.
    const rgListenersAfterFirst =
      page.selects["azure-rg-select"].listenerCount("change");
    const clusterListenersAfterFirst =
      page.selects["azure-cluster-select"].listenerCount("change");
    await loadTwoClusters(page, handle);

    expect(page.selects["azure-rg-select"].listenerCount("change")).toBe(
      rgListenersAfterFirst
    );
    expect(page.selects["azure-cluster-select"].listenerCount("change")).toBe(
      clusterListenersAfterFirst
    );
  });

  it("does not wire the cross-filter when the azure select elements are absent", async () => {
    const browser = createFakeBrowser();
    for (const [selectId, customId] of COMBO_PAIRS) {
      if (selectId === "azure-rg-select") continue; // omit the RG select
      browser.document.add(createFakeSelect(selectId));
      browser.document.add(createFakeInput(customId));
    }
    browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse({
        clusters: [{ id: "aks-1", name: "AKS One", resourceGroup: "rg-1" }]
      })
    );
    const handle = initializeDiscoveryPanel(browser.context);
    await expect(
      handle?.discoverResources("azure", "", "")
    ).resolves.toBeUndefined();
  });
});

describe("findAzureClusterResourceGroup", () => {
  it("returns '' before any azure discovery has populated the cluster list", () => {
    const page = renderDiscoveryPage();
    const handle = initializeDiscoveryPanel(page.browser.context);
    expect(handle?.findAzureClusterResourceGroup("aks-1")).toBe("");
  });

  it("returns the resource group for a known cluster", async () => {
    const page = renderDiscoveryPage();
    const handle = initializeDiscoveryPanel(page.browser.context);
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse({
        clusters: [{ id: "aks-1", name: "AKS One", resourceGroup: "rg-1" }],
        resourceGroups: []
      })
    );
    await handle?.discoverResources("azure", "", "");
    expect(handle?.findAzureClusterResourceGroup("aks-1")).toBe("rg-1");
  });

  it("returns '' for a known cluster without a resource group", async () => {
    const page = renderDiscoveryPage();
    const handle = initializeDiscoveryPanel(page.browser.context);
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse({
        clusters: [{ id: "aks-1", name: "AKS One" }],
        resourceGroups: []
      })
    );
    await handle?.discoverResources("azure", "", "");
    expect(handle?.findAzureClusterResourceGroup("aks-1")).toBe("");
  });

  it("returns '' for an unknown cluster id", async () => {
    const page = renderDiscoveryPage();
    const handle = initializeDiscoveryPanel(page.browser.context);
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse({
        clusters: [{ id: "aks-1", name: "AKS One", resourceGroup: "rg-1" }],
        resourceGroups: []
      })
    );
    await handle?.discoverResources("azure", "", "");
    expect(handle?.findAzureClusterResourceGroup("does-not-exist")).toBe("");
  });
});
