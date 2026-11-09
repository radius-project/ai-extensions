import { describe, expect, it, vi } from "vitest";
import { COMMAND_COPY_LABEL, COMMAND_RUN_LABEL } from "../command-action.js";
import {
  APP_SERVES_REPOS_ENDPOINT,
  COMBO_PAIRS,
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
  azureRemediation: ReturnType<typeof createFakeElement>;
  awsStatus: ReturnType<typeof createFakeElement>;
  awsRemediation: ReturnType<typeof createFakeElement>;
  awsClusterNote: ReturnType<typeof createFakeElement>;
  awsNamespaceNote: ReturnType<typeof createFakeElement>;
  awsVpcValue: ReturnType<typeof createFakeElement>;
  awsVpcNote: ReturnType<typeof createFakeElement>;
  awsRestoreNote: ReturnType<typeof createFakeElement>;
  awsSubnetsList: ReturnType<typeof createFakeElement>;
  awsSubnetsError: ReturnType<typeof createFakeElement>;
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
  for (const selectId of [
    "azure-rg-select",
    "azure-cluster-select",
    "aws-cluster-select"
  ]) {
    const select = createFakeSelect(selectId);
    selects[selectId] = select;
    if (!omit.includes(selectId)) browser.document.add(select);
  }
  for (const [selectId, customId] of COMBO_PAIRS) {
    const select = createFakeSelect(selectId);
    const custom = createFakeInput(customId);
    selects[selectId] = select;
    customs[customId] = custom;
    if (!omit.includes(selectId)) browser.document.add(select);
    if (!omit.includes(customId)) browser.document.add(custom);
  }
  const azureStatus = createFakeElement("azure-discover-status");
  const azureRemediation = createFakeElement("azure-discover-remediation");
  const awsStatus = createFakeElement("aws-discover-status");
  const awsRemediation = createFakeElement("aws-discover-remediation");
  const awsClusterNote = createFakeElement("aws-cluster-note");
  const awsNamespaceNote = createFakeElement("aws-namespace-note");
  const awsVpcValue = createFakeElement("aws-vpc-value", "output");
  const awsVpcNote = createFakeElement("aws-vpc-note");
  const awsRestoreNote = createFakeElement("aws-restore-note");
  const awsSubnetsList = createFakeElement("aws-subnets-list");
  const awsSubnetsError = createFakeElement("aws-subnets-error");
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
    azureRemediation,
    awsStatus,
    awsRemediation,
    awsClusterNote,
    awsNamespaceNote,
    awsVpcValue,
    awsVpcNote,
    awsRestoreNote,
    awsSubnetsList,
    awsSubnetsError,
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
    azureRemediation,
    awsStatus,
    awsRemediation,
    awsClusterNote,
    awsNamespaceNote,
    awsVpcValue,
    awsVpcNote,
    awsRestoreNote,
    awsSubnetsList,
    awsSubnetsError,
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

function awsCluster(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    vpcId: "vpc-1",
    authenticationMode: "API_AND_CONFIG_MAP",
    status: "ACTIVE",
    usable: true,
    ...overrides
  };
}

function awsSubnet(
  id: string,
  zone: string,
  routing: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    id,
    name: `${routing}-${zone.slice(-1)}`,
    vpcId: "vpc-1",
    availabilityZone: zone,
    routing,
    zoneKind: "standard",
    ...overrides
  };
}

function awsPayload(overrides: Record<string, unknown> = {}) {
  return {
    clusters: [awsCluster("eks-1")],
    namespaces: ["default"],
    vpcs: [{ id: "vpc-1", name: "main (vpc-1)" }],
    subnets: [
      awsSubnet("subnet-a", "us-west-2a", "private"),
      awsSubnet("subnet-b", "us-west-2b", "private"),
      awsSubnet("subnet-c", "us-west-2c", "public")
    ],
    ...overrides
  };
}

function optionValues(select: ReturnType<typeof createFakeSelect>) {
  return Array.from(select.options).map((option) => option.value);
}

function checkedSubnets(page: DiscoveryPage): string[] {
  return fakeTree(page.awsSubnetsList)
    .filter(
      (element) =>
        element.tagName === "input" &&
        element.getAttribute("checked") === "checked"
    )
    .map((element) => element.getAttribute("value") ?? "");
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

  it("does not look up serves labels when the caller disables lazy serves", async () => {
    const page = renderDiscoveryPage();
    void showAppPicker(page.browser.context, {
      candidates: [candidate({ appId: "app-1" })],
      lazyServes: false
    });
    await flushPromises();
    await flushPromises();

    expect(page.browser.net.calls).toHaveLength(0);
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

describe("currentInfraSelection", () => {
  it("returns an empty string when the select is missing", () => {
    const browser = createFakeBrowser();
    const handle = initializeDiscoveryPanel(browser.context);
    expect(handle?.currentInfraSelection("azure").cluster).toBe("");
  });

  it("returns the discovered Azure select values", () => {
    const page = renderDiscoveryPage();
    const handle = initializeDiscoveryPanel(page.browser.context);
    page.selects["azure-rg-select"].value = "rg-1";
    page.selects["azure-cluster-select"].value = "cluster-1";
    expect(handle?.currentInfraSelection("azure")).toEqual(
      expect.objectContaining({
        resourceGroup: "rg-1",
        cluster: "cluster-1"
      })
    );
  });

  it("returns an empty custom value when a supported custom input is missing", () => {
    const page = renderDiscoveryPage(["aws-namespace-custom"]);
    const handle = initializeDiscoveryPanel(page.browser.context);
    page.selects["aws-namespace-select"].value = "__custom__";

    expect(handle?.currentInfraSelection("aws").namespace).toBe("");
  });

  it("returns empty AWS values when the AWS selects are missing", () => {
    const browser = createFakeBrowser();
    const handle = initializeDiscoveryPanel(browser.context);

    expect(handle?.currentInfraSelection("aws")).toEqual({
      cluster: "",
      namespace: "",
      vpcId: "",
      subnetIds: ""
    });
  });
});

describe("discoverResources", () => {
  function azurePayload(overrides: Record<string, unknown> = {}) {
    return {
      clusters: [{ id: "aks-1", name: "AKS One", resourceGroup: "rg-1" }],
      resourceGroups: [{ id: "rg-1", name: "rg-1" }],
      namespaces: [],
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

  it("includes the current resource group and cluster when rediscovering", async () => {
    const page = renderDiscoveryPage();
    const bodies: unknown[] = [];
    page.browser.net.handle(DISCOVER_ENDPOINT, (init) => {
      bodies.push(JSON.parse(init?.body ?? "{}"));
      return discoverResponse(
        azurePayload({
          clusters: [
            { id: "aks-1", name: "AKS One", resourceGroup: "rg-1" },
            { id: "aks-2", name: "AKS Two", resourceGroup: "rg-2" }
          ],
          resourceGroups: [
            { id: "rg-1", name: "rg-1" },
            { id: "rg-2", name: "rg-2" }
          ],
          namespaces: ["selected-namespace"]
        })
      );
    });
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("azure", "sub-1", "tenant-1");
    page.selects["azure-rg-select"].value = "rg-2";
    page.selects["azure-rg-select"].dispatch("change");
    page.selects["azure-cluster-select"].value = "aks-2";

    await handle?.discoverResources("azure", "sub-1", "tenant-1");

    expect(bodies).toEqual([
      { provider: "azure", subscriptionId: "sub-1", tenantId: "tenant-1" },
      {
        provider: "azure",
        subscriptionId: "sub-1",
        tenantId: "tenant-1",
        resourceGroup: "rg-2",
        cluster: "aks-2"
      }
    ]);
    expect(page.selects["azure-rg-select"].value).toBe("rg-2");
    expect(page.selects["azure-cluster-select"].value).toBe("aks-2");
  });

  it("shows namespace failures without static namespace choices", async () => {
    const page = renderDiscoveryPage();
    let requestCount = 0;
    page.browser.net.handle(DISCOVER_ENDPOINT, (init) => {
      requestCount += 1;
      const body = JSON.parse(init?.body ?? "{}");
      if (requestCount === 1) {
        expect(body).not.toHaveProperty("resourceGroup");
        expect(body).not.toHaveProperty("cluster");
        return discoverResponse(
          azurePayload({
            clusters: [{ id: "aks-2", name: "AKS Two", resourceGroup: "rg-2" }],
            resourceGroups: [{ id: "rg-2", name: "rg-2" }]
          })
        );
      }
      expect(body).toMatchObject({ resourceGroup: "rg-2", cluster: "aks-2" });
      return discoverResponse(
        azurePayload({
          clusters: [{ id: "aks-2", name: "AKS Two", resourceGroup: "rg-2" }],
          resourceGroups: [{ id: "rg-2", name: "rg-2" }],
          errors: { namespaces: "selected cluster unavailable" }
        })
      );
    });
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection(
      { resourceGroup: "rg-2", cluster: "aks-2" },
      "azure"
    );

    await handle?.discoverResources("azure", "sub-1", "tenant-1");
    await flushPromises();

    expect(page.azureStatus.textContent).toBe(
      "Discovery failed: selected cluster unavailable"
    );
    expect(
      Array.from(page.selects["azure-namespace-select"].options).map(
        (option) => option.value
      )
    ).toEqual(["", "__custom__"]);
    expect(page.selects["azure-namespace-select"].value).toBe("");
  });

  it("renders the trusted Azure login remediation and hands it off with the page nonce", async () => {
    const page = renderDiscoveryPage();
    const tenantId = "11111111-2222-3333-4444-555555555555";
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(
        azurePayload({
          clusters: [],
          resourceGroups: [],
          errors: {
            clusters: "Azure CLI sign-in is required to discover resources."
          },
          remediation: {
            id: "azure-cli-login",
            params: { tenantId, nextStep: "refresh-discovery" },
            command: "ignored server-authored command text"
          }
        })
      )
    );
    page.browser.net.handle("/api/run-remediation", (init) => {
      expect(init?.headers).toEqual({
        "Content-Type": "application/json",
        "X-Radius-Mutation-Nonce": "nonce-647"
      });
      expect(JSON.parse(init?.body ?? "{}")).toEqual({
        id: "azure-cli-login",
        params: { tenantId, nextStep: "refresh-discovery" },
        confirmed: false
      });
      return jsonResponse({ success: true, message: "Handed off." });
    });
    const handle = initializeDiscoveryPanel(page.browser.context, {
      mutationNonce: "nonce-647"
    });

    await handle?.discoverResources("azure", "", tenantId);

    expect(page.azureStatus.textContent).toBe(
      "Discovery failed: Azure CLI sign-in is required to discover resources."
    );
    expect(page.azureRemediation.hidden).toBe(false);
    expect(fakeText(page.azureRemediation)).toContain("Sign in to Azure CLI");
    expect(fakeText(page.azureRemediation)).toContain(
      `az login --use-device-code --tenant ${tenantId}`
    );
    expect(fakeText(page.azureRemediation)).not.toContain(
      "ignored server-authored command text"
    );
    const runButton = fakeTree(page.azureRemediation).find(
      (element) => element.textContent === COMMAND_RUN_LABEL
    );
    expect(runButton).toBeDefined();
    runButton?.dispatch("click");
    await flushPromises();

    expect(page.browser.net.calls.at(-1)?.url).toBe("/api/run-remediation");
    expect(fakeText(page.azureRemediation)).toContain(
      "refresh resource discovery"
    );
  });

  it("renders an unsupported discovery remediation disabled with its reason", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(
        azurePayload({
          errors: {
            clusters: "Azure CLI sign-in is required to discover resources."
          },
          remediation: {
            id: "untrusted-command",
            params: {},
            command: "ignored server-authored command text"
          }
        })
      )
    );
    const handle = initializeDiscoveryPanel(page.browser.context, {
      mutationNonce: "nonce-647"
    });

    await handle?.discoverResources("azure", "", "");

    expect(page.azureRemediation.hidden).toBe(false);
    expect(fakeText(page.azureRemediation)).toContain(
      "Radius does not offer to run this command."
    );
    expect(fakeText(page.azureRemediation)).not.toContain(
      "ignored server-authored command text"
    );
    const runButton = fakeTree(page.azureRemediation).find(
      (element) => element.textContent === COMMAND_RUN_LABEL
    );
    if (!runButton)
      throw new Error("unsupported remediation did not render Run");
    expect(Reflect.get(runButton, "disabled")).toBe(true);
    runButton.dispatch("click");
    await flushPromises();
    expect(page.browser.net.calls).toHaveLength(1);
  });

  it("keeps Copy available but disables Run when the page nonce is missing", async () => {
    const page = renderDiscoveryPage();
    const tenantId = "11111111-2222-3333-4444-555555555555";
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(
        azurePayload({
          errors: {
            clusters: "Azure CLI sign-in is required to discover resources."
          },
          remediation: {
            id: "azure-cli-login",
            params: { tenantId, nextStep: "refresh-discovery" }
          }
        })
      )
    );
    const handle = initializeDiscoveryPanel(page.browser.context);

    await handle?.discoverResources("azure", "", tenantId);

    expect(page.azureRemediation.hidden).toBe(false);
    expect(fakeText(page.azureRemediation)).toContain(
      "Reload the Radius canvas before asking Copilot to run this command."
    );
    const runButton = fakeTree(page.azureRemediation).find(
      (element) => element.textContent === COMMAND_RUN_LABEL
    );
    const copyButton = fakeTree(page.azureRemediation).find(
      (element) => element.textContent === COMMAND_COPY_LABEL
    );
    if (!runButton || !copyButton)
      throw new Error("missing-nonce remediation did not render both actions");
    expect(Reflect.get(runButton, "disabled")).toBe(true);
    expect(Reflect.get(copyButton, "disabled")).toBe(false);

    runButton.dispatch("click");
    copyButton.dispatch("click");
    await flushPromises();

    expect(page.browser.net.calls).toHaveLength(1);
    expect(page.browser.clipboard.writes).toEqual([
      `az login --use-device-code --tenant ${tenantId}`
    ]);
  });

  it("clears discovery remediation on refresh success and teardown", async () => {
    const page = renderDiscoveryPage();
    let interactionRequired = true;
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(
        interactionRequired ?
          azurePayload({
            errors: {
              resourceGroups:
                "Azure CLI sign-in is required to discover resources."
            },
            remediation: {
              id: "azure-cli-login",
              params: { nextStep: "refresh-discovery" }
            }
          })
        : azurePayload()
      )
    );
    const handle = initializeDiscoveryPanel(page.browser.context, {
      mutationNonce: "nonce-647"
    });

    await handle?.discoverResources("azure", "", "");
    expect(page.azureRemediation.children.length).toBeGreaterThan(0);
    expect(page.azureRemediation.hidden).toBe(false);

    interactionRequired = false;
    await handle?.discoverResources("azure", "", "");
    expect(page.azureRemediation.children).toEqual([]);
    expect(page.azureRemediation.hidden).toBe(true);

    interactionRequired = true;
    await handle?.discoverResources("azure", "", "");
    expect(page.azureRemediation.children.length).toBeGreaterThan(0);
    handle?.teardown();
    expect(page.azureRemediation.children).toEqual([]);
    expect(page.azureRemediation.hidden).toBe(true);
  });

  it("selects a sole cluster and a discovered default namespace", async () => {
    const page = renderDiscoveryPage();
    const bodies: Array<Record<string, string>> = [];
    page.browser.net.handle(DISCOVER_ENDPOINT, (init) => {
      const body = JSON.parse(init?.body ?? "{}");
      bodies.push(body);
      return discoverResponse(
        azurePayload({ namespaces: body.cluster ? ["team-a", "default"] : [] })
      );
    });
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("azure", "", "");

    expect(page.azureStatus.textContent).toBe(
      "Found 1 cluster(s), 1 resource group(s)"
    );
    const namespaceSelect = page.selects["azure-namespace-select"];
    expect(
      Array.from(namespaceSelect.options).map((option) => option.value)
    ).toEqual(["", "__custom__"]);
    const clusterSelect = page.selects["azure-cluster-select"];
    expect(
      Array.from(clusterSelect.options).map((option) => option.value)
    ).toEqual([""]);
    page.selects["azure-rg-select"].value = "rg-1";
    page.selects["azure-rg-select"].dispatch("change");
    await flushPromises();
    expect(
      Array.from(clusterSelect.options).map((option) => option.value)
    ).toEqual(["", "aks-1"]);
    expect(clusterSelect.value).toBe("aks-1");
    expect(namespaceSelect.value).toBe("default");
    expect(bodies).toEqual([
      { provider: "azure" },
      {
        provider: "azure",
        resourceGroup: "rg-1",
        cluster: "aks-1"
      }
    ]);
  });

  it("restores a saved azure selection once discovery has populated the lists", async () => {
    const page = renderDiscoveryPage();
    const bodies: unknown[] = [];
    page.browser.net.handle(DISCOVER_ENDPOINT, (init) => {
      const body = JSON.parse(init?.body ?? "{}");
      bodies.push(body);
      return discoverResponse(
        azurePayload({ namespaces: body.cluster ? ["default"] : [] })
      );
    });
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection(
      {
        resourceGroup: "rg-1",
        cluster: "aks-1",
        namespace: "default"
      },
      "azure"
    );

    await handle?.discoverResources("azure", "", "");
    await flushPromises();

    expect(page.selects["azure-rg-select"].value).toBe("rg-1");
    expect(page.selects["azure-cluster-select"].value).toBe("aks-1");
    expect(page.selects["azure-namespace-select"].value).toBe("default");
    expect(bodies).toEqual([
      { provider: "azure" },
      { provider: "azure", resourceGroup: "rg-1", cluster: "aks-1" }
    ]);
  });

  it("keeps a saved namespace across the follow-up cluster discovery", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, (init) => {
      const body = JSON.parse(init?.body ?? "{}");
      return discoverResponse(
        azurePayload({
          namespaces: body.cluster ? ["default", "team-a"] : []
        })
      );
    });
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection(
      { resourceGroup: "rg-1", cluster: "aks-1", namespace: "team-a" },
      "azure"
    );

    await handle?.discoverResources("azure", "", "");
    await flushPromises();

    // The first request cannot list namespaces, so the saved value has to
    // survive until the targeted follow-up returns the cluster's real list.
    expect(page.selects["azure-namespace-select"].value).toBe("team-a");
    expect(page.customs["azure-namespace-custom"].style.display).toBe("none");
    expect(handle?.currentInfraSelection("azure").namespace).toBe("team-a");
  });

  // The cluster picker is filtered by the resource group the cluster lives in,
  // not the application's. Filtering on the application's would leave the
  // environment's own cluster out of the list whenever the two differ, so
  // editing it would silently drop the cluster selection.
  it("restores a cluster that lives in a different resource group from the application", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(
        azurePayload({
          clusters: [
            { id: "aks-1", name: "AKS One", resourceGroup: "cluster-rg" }
          ],
          resourceGroups: [
            { id: "app-rg", name: "app-rg" },
            { id: "cluster-rg", name: "cluster-rg" }
          ]
        })
      )
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection(
      {
        resourceGroup: "app-rg",
        clusterResourceGroup: "cluster-rg",
        cluster: "aks-1"
      },
      "azure"
    );

    await handle?.discoverResources("azure", "", "");
    await flushPromises();

    expect(page.selects["azure-rg-select"].value).toBe("app-rg");
    expect(page.selects["azure-cluster-select"].value).toBe("aks-1");
  });

  // An environment saved before the cluster's resource group was recorded has
  // none, so the application's still selects the cluster exactly as it did.
  it("falls back to the application resource group when no cluster resource group was stored", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(azurePayload())
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection(
      { resourceGroup: "rg-1", cluster: "aks-1" },
      "azure"
    );

    await handle?.discoverResources("azure", "", "");
    await flushPromises();

    expect(page.selects["azure-rg-select"].value).toBe("rg-1");
    expect(page.selects["azure-cluster-select"].value).toBe("aks-1");
  });

  it("leaves the cluster unselected when the saved one is gone", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(azurePayload())
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection(
      { resourceGroup: "rg-1", cluster: "aks-gone" },
      "azure"
    );

    await handle?.discoverResources("azure", "", "");
    await flushPromises();

    // rg-1 offers exactly one cluster, but silently substituting it for the
    // deleted saved cluster would retarget the environment without telling
    // the user.
    expect(page.selects["azure-rg-select"].value).toBe("rg-1");
    expect(page.selects["azure-cluster-select"].value).toBe("");
    expect(page.browser.net.calls).toHaveLength(1);
  });

  it("does not guess a resource group for a saved duplicate AKS name", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse({
        clusters: [
          { id: "shared-aks", name: "Shared AKS", resourceGroup: "rg-1" },
          { id: "shared-aks", name: "Shared AKS", resourceGroup: "rg-2" }
        ],
        resourceGroups: [{ id: "app-rg", name: "app-rg" }]
      })
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection(
      { resourceGroup: "app-rg", cluster: "shared-aks" },
      "azure"
    );

    await handle?.discoverResources("azure", "sub-1", "tenant-1");
    await flushPromises();

    expect(page.selects["azure-cluster-select"].value).toBe("");
    expect(page.browser.net.calls).toHaveLength(1);
  });

  it("tolerates a missing cluster select while restoring saved discovery", async () => {
    const browser = createFakeBrowser();
    browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse({
        clusters: [
          { id: "aks-1", name: "AKS One", resourceGroup: "cluster-rg" }
        ],
        resourceGroups: []
      })
    );
    const handle = initializeDiscoveryPanel(browser.context);
    handle?.setPendingInfraSelection({ cluster: "aks-1" }, "azure");

    await handle?.discoverResources("azure", "sub-1", "tenant-1");
    await flushPromises();

    expect(browser.net.calls).toHaveLength(1);
  });

  it("does not send or restore Azure targets the discovered lists do not offer", async () => {
    const page = renderDiscoveryPage();
    const bodies: unknown[] = [];
    page.browser.net.handle(DISCOVER_ENDPOINT, (init) => {
      bodies.push(JSON.parse(init?.body ?? "{}"));
      return discoverResponse(azurePayload());
    });
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection(
      { resourceGroup: "rg-gone", cluster: "aks-gone" },
      "azure"
    );

    await handle?.discoverResources("azure", "", "");

    expect(bodies).toEqual([{ provider: "azure" }]);
    expect(page.selects["azure-rg-select"].value).toBe("");
    expect(page.selects["azure-cluster-select"].value).toBe("");
    expect(
      Array.from(page.selects["azure-rg-select"].options).map(
        (option) => option.value
      )
    ).toEqual(["", "rg-1"]);
  });

  it("applies a saved selection only once", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(azurePayload())
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection({ resourceGroup: "rg-1" }, "azure");
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
  });

  it("ignores a saved selection whose fields are all empty", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(azurePayload())
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection({}, "azure");

    await handle?.discoverResources("azure", "", "");

    expect(page.selects["azure-rg-select"].value).toBe("");
  });

  it("ignores a saved aws selection whose fields are all empty", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(awsPayload())
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection({}, "aws");

    await handle?.discoverResources("aws", "123456789012", "us-west-2");

    // An empty saved selection must leave the discovered defaults in place:
    // the single cluster, its VPC, and its private subnets.
    expect(page.customs["aws-namespace-custom"].value).toBe("");
    expect(handle?.currentInfraSelection("aws")).toEqual(
      expect.objectContaining({
        cluster: "eks-1",
        vpcId: "vpc-1",
        subnetIds: "subnet-a,subnet-b"
      })
    );
  });

  it("does not let an azure response consume an aws pending selection", async () => {
    const page = renderDiscoveryPage();
    let resolveAzure: (value: HttpResponse) => void = () => {};
    const azureFirst = new Promise<HttpResponse>((resolve) => {
      resolveAzure = resolve;
    });
    page.browser.net.handle(DISCOVER_ENDPOINT, (init) => {
      const body = JSON.parse(init?.body ?? "{}");
      if (body.provider === "azure") return azureFirst;
      return discoverResponse(awsPayload({ namespaces: ["team-a"] }));
    });
    const handle = initializeDiscoveryPanel(page.browser.context);
    // An azure discovery is already outstanding when the user opens an aws
    // edit form, which hands its saved selection over.
    const azureCall = handle?.discoverResources("azure", "", "");
    handle?.setPendingInfraSelection(
      { cluster: "eks-1", namespace: "team-a" },
      "aws"
    );

    resolveAzure(discoverResponse(azurePayload()));
    await azureCall;
    await flushPromises();
    // The aws hand-off carries a namespace, so azure consuming it would show
    // up as "team-a" here instead of leaving the unqueried list empty.
    expect(page.selects["azure-namespace-select"].value).toBe("");

    await handle?.discoverResources("aws", "", "");
    expect(page.selects["aws-cluster-select"].value).toBe("eks-1");
    expect(page.selects["aws-namespace-select"].value).toBe("team-a");
  });

  it("drops a saved value when its select is missing from the page", async () => {
    const page = renderDiscoveryPage(["azure-rg-select"]);
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(azurePayload())
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection({ resourceGroup: "rg-gone" }, "azure");

    await handle?.discoverResources("azure", "", "");

    expect(page.selects["azure-cluster-select"].value).toBe("");
  });

  it("reports the current aws selection for a form that is being reopened", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(awsPayload())
    );
    const handle = initializeDiscoveryPanel(page.browser.context);

    await handle?.discoverResources("aws", "123456789012", "us-west-2");

    // Discovery follows the single cluster's VPC and selects its private
    // subnets, which span two availability zones.
    expect(handle?.currentInfraSelection("aws")).toEqual(
      expect.objectContaining({
        cluster: "eks-1",
        vpcId: "vpc-1",
        subnetIds: "subnet-a,subnet-b"
      })
    );
    expect(handle?.awsInfrastructureError()).toBe("");
  });

  it("reports the current azure selection for a form that is being reopened", () => {
    const page = renderDiscoveryPage();
    const handle = initializeDiscoveryPanel(page.browser.context);
    page.selects["azure-rg-select"].value = "rg-1";
    page.selects["azure-cluster-select"].value = "aks-1";

    expect(handle?.currentInfraSelection("azure")).toEqual(
      expect.objectContaining({
        resourceGroup: "rg-1",
        cluster: "aks-1"
      })
    );
  });

  it("restores a saved aws selection across every infrastructure field", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(awsPayload({ namespaces: ["team-a"] }))
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection(
      {
        cluster: "eks-1",
        namespace: "team-a",
        vpcId: "vpc-1",
        subnetIds: "subnet-a"
      },
      "aws"
    );

    await handle?.discoverResources("aws", "123456789012", "us-west-2");

    expect(page.selects["aws-cluster-select"].value).toBe("eks-1");
    expect(page.selects["aws-namespace-select"].value).toBe("team-a");
    expect(page.awsVpcValue.textContent).toBe("main (vpc-1)");
    expect(handle?.currentInfraSelection("aws")).toEqual({
      cluster: "eks-1",
      namespace: "team-a",
      vpcId: "vpc-1",
      subnetIds: "subnet-a"
    });
    // The saved selection spans one zone, so Create Environment stays blocked.
    expect(handle?.awsInfrastructureError()).toBe(
      "Select subnets in at least two availability zones."
    );
  });

  it("applies the defaults and keeps a typed namespace when the saved selection has no cluster", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(awsPayload())
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection(
      { namespace: "not-offered", subnetIds: "subnet-a,subnet-b" },
      "aws"
    );

    await handle?.discoverResources("aws", "123456789012", "us-west-2");

    expect(page.customs["aws-namespace-custom"].value).toBe("not-offered");
    expect(page.customs["aws-namespace-custom"].style.display).toBe("");
    expect(handle?.currentInfraSelection("aws").subnetIds).toBe(
      "subnet-a,subnet-b"
    );

    handle?.setPendingInfraSelection({ namespace: "default" }, "aws");
    await handle?.discoverResources("aws", "123456789012", "us-west-2");
    expect(page.selects["aws-namespace-select"].value).toBe("default");
    expect(page.customs["aws-namespace-custom"].style.display).toBe("none");
  });

  it("requires a cluster when the cluster select is missing", () => {
    const page = renderDiscoveryPage(["aws-cluster-select"]);
    const handle = initializeDiscoveryPanel(page.browser.context);
    expect(handle?.awsInfrastructureError()).toBe("Select an EKS cluster.");
  });

  it("does not invent an undiscovered AWS cluster on restore, and names it in the cluster note", async () => {
    const page = renderDiscoveryPage();
    const bodies: unknown[] = [];
    page.browser.net.handle(DISCOVER_ENDPOINT, (init) => {
      bodies.push(JSON.parse(init?.body ?? "{}"));
      return discoverResponse(
        awsPayload({ clusters: [awsCluster("eks-2"), awsCluster("eks-1")] })
      );
    });
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection(
      { cluster: "eks-external", namespace: "team-a" },
      "aws"
    );

    await handle?.discoverResources("aws", "123456789012", "us-west-2");

    const clusterSelect = page.selects["aws-cluster-select"];
    expect(clusterSelect.value).toBe("");
    expect(optionValues(clusterSelect)).toEqual(["", "eks-1", "eks-2"]);
    expect(page.awsClusterNote.hidden).toBe(false);
    expect(fakeText(page.awsClusterNote)).toBe(
      "The saved cluster eks-external wasn't found in us-west-2."
    );
    expect(checkedSubnets(page)).toEqual([]);
    expect(page.customs["aws-namespace-custom"].value).toBe("team-a");
    expect(bodies[0]).toHaveProperty("cluster", "eks-external");

    // The held selection was used once, so the next discovery doesn't send it.
    await handle?.discoverResources("aws", "123456789012", "us-west-2");
    expect(bodies[1]).not.toHaveProperty("cluster");
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

  it("renders aws clusters, namespaces, the cluster VPC, and a subnet checklist without a custom option", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(awsPayload())
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("aws", "123456789012", "us-west-2");

    expect(page.awsStatus.textContent).toBe(
      "Found 1 EKS cluster in us-west-2."
    );
    const clusterSelect = page.selects["aws-cluster-select"];
    expect(optionValues(clusterSelect)).toEqual(["", "eks-1"]);
    expect(page.awsVpcValue.textContent).toBe("main (vpc-1)");
    expect(page.awsClusterNote.hidden).toBe(true);
    const boxes = fakeTree(page.awsSubnetsList).filter(
      (element) => element.tagName === "input"
    );
    expect(boxes.map((box) => box.id)).toEqual([
      "aws-subnet-subnet-a",
      "aws-subnet-subnet-b",
      "aws-subnet-subnet-c"
    ]);
    expect(fakeText(page.awsSubnetsList)).toContain("us-west-2a");
    expect(fakeText(page.awsSubnetsList)).toContain("public");
  });

  it("posts the AWS account and region instead of an Azure subscription and tenant", async () => {
    const page = renderDiscoveryPage();
    const bodies: unknown[] = [];
    page.browser.net.handle(DISCOVER_ENDPOINT, (init) => {
      bodies.push(JSON.parse(init?.body ?? "{}"));
      return discoverResponse(awsPayload());
    });
    const handle = initializeDiscoveryPanel(page.browser.context);

    await handle?.discoverResources("aws", "123456789012", "us-west-2");

    expect(bodies).toEqual([
      { provider: "aws", accountId: "123456789012", region: "us-west-2" }
    ]);
  });

  it("disables an unusable CONFIG_MAP cluster and reports its note line for a selection made by code", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(
        awsPayload({
          clusters: [
            awsCluster("legacy", {
              authenticationMode: "CONFIG_MAP",
              usable: false,
              unusableReason: "config-map"
            })
          ]
        })
      )
    );
    const handle = initializeDiscoveryPanel(page.browser.context);

    await handle?.discoverResources("aws", "123456789012", "us-west-2");

    const clusterSelect = page.selects["aws-cluster-select"];
    const option = clusterSelect.options.find(
      (entry) => entry.value === "legacy"
    );
    expect(option?.textContent).toBe("legacy (CONFIG_MAP authentication)");
    expect(option?.disabled).toBe(true);
    expect(clusterSelect.value).toBe("");
    expect(handle?.awsInfrastructureError()).toBe("Select an EKS cluster.");

    // The select can't pick a disabled option, so only code can select it.
    clusterSelect.value = "legacy";
    const command =
      "aws eks update-cluster-config --name legacy --region us-west-2 --access-config authenticationMode=API_AND_CONFIG_MAP";
    expect(handle?.awsInfrastructureError()).toBe(
      `legacy uses CONFIG_MAP authentication, which doesn't support access entries. A cluster administrator can enable access entries with this command. After that, AWS doesn't allow a switch back to CONFIG_MAP. ${command}`
    );
    expect(page.awsClusterNote.hidden).toBe(false);
    expect(fakeText(page.awsClusterNote)).toContain(command);
  });

  it.each([
    ["is still running", "pending"],
    ["fails", "fails"]
  ])(
    "clears the AWS selection while discovery for a new profile %s",
    async (_label, outcome) => {
      const page = renderDiscoveryPage();
      let answer: Promise<HttpResponse> = Promise.resolve(
        discoverResponse(awsPayload())
      );
      page.browser.net.handle(DISCOVER_ENDPOINT, () => answer);
      const onInfrastructureChange = vi.fn();
      const handle = initializeDiscoveryPanel(page.browser.context, {
        mutationNonce: "nonce",
        onInfrastructureChange
      });
      await handle?.discoverResources("aws", "123456789012", "us-west-2");
      expect(page.selects["aws-cluster-select"].value).toBe("eks-1");
      expect(handle?.awsInfrastructureError()).toBe("");

      let fail: (reason: unknown) => void = () => {};
      answer = new Promise<HttpResponse>((_resolve, reject) => {
        fail = reject;
      });
      onInfrastructureChange.mockClear();
      const next = handle?.discoverResources(
        "aws",
        "999988887777",
        "eu-west-1"
      );

      expect(page.selects["aws-cluster-select"].value).toBe("");
      expect(page.selects["aws-cluster-select"].options[0].textContent).toBe(
        "Discovering EKS clusters…"
      );
      expect(page.awsVpcValue.textContent).toBe(
        "Select a cluster to see its VPC."
      );
      expect(handle?.currentInfraSelection("aws")).toMatchObject({
        cluster: "",
        vpcId: "",
        subnetIds: ""
      });
      expect(handle?.awsInfrastructureError()).not.toBe("");
      expect(onInfrastructureChange).toHaveBeenCalled();

      if (outcome === "fails") {
        fail(new Error("denied"));
        await next;
        expect(page.selects["aws-cluster-select"].value).toBe("");
        expect(page.selects["aws-cluster-select"].options[0].textContent).toBe(
          "Clusters unavailable"
        );
        expect(handle?.awsInfrastructureError()).not.toBe("");
      } else {
        fail(new Error("abandoned"));
        await next;
      }
    }
  );

  it("requires a cluster before AWS discovery has run", () => {
    const page = renderDiscoveryPage();
    const handle = initializeDiscoveryPanel(page.browser.context);

    expect(handle?.awsInfrastructureError()).toBe("Select an EKS cluster.");
  });

  it("notifies the page when the AWS infrastructure selection changes", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(awsPayload())
    );
    const onInfrastructureChange = vi.fn();
    const handle = initializeDiscoveryPanel(page.browser.context, {
      mutationNonce: "nonce",
      onInfrastructureChange
    });

    await handle?.discoverResources("aws", "123456789012", "us-west-2");

    expect(onInfrastructureChange).toHaveBeenCalled();
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
    ).toEqual([""]);
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
    expect(
      Array.from(page.selects["azure-namespace-select"].options).map(
        (option) => option.value
      )
    ).toEqual(["", "__custom__"]);
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

  it("renders empty Azure lists when the response body is not a JSON object", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () => jsonResponse([]));
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("azure", "", "");
    const namespaceSelect = page.selects["azure-namespace-select"];
    expect(
      Array.from(namespaceSelect.options).map((option) => option.value)
    ).toEqual(["", "__custom__"]);
    const clusterSelect = page.selects["azure-cluster-select"];
    expect(
      Array.from(clusterSelect.options).map((option) => option.value)
    ).toEqual([""]);
  });

  it("does not throw when the azure-cluster-select element is absent", async () => {
    const browser = createFakeBrowser();
    browser.document.add(createFakeSelect("azure-rg-select"));
    for (const [selectId, customId] of COMBO_PAIRS) {
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
    ).toEqual([""]);
  });

  it("supersedes an in-flight namespace lookup when editing another Azure environment", async () => {
    const page = renderDiscoveryPage();
    let resolveEnvironmentA: (value: HttpResponse) => void = () => {};
    const environmentAResponse = new Promise<HttpResponse>((resolve) => {
      resolveEnvironmentA = resolve;
    });
    const bodies: Array<Record<string, string>> = [];
    const resources = azurePayload({
      clusters: [
        { id: "aks-a", name: "AKS A", resourceGroup: "rg-a" },
        { id: "aks-b", name: "AKS B", resourceGroup: "rg-b" }
      ],
      resourceGroups: [
        { id: "rg-a", name: "rg-a" },
        { id: "rg-b", name: "rg-b" }
      ]
    });
    page.browser.net.handle(DISCOVER_ENDPOINT, (init) => {
      const body = JSON.parse(init?.body ?? "{}");
      bodies.push(body);
      if (body.cluster === "aks-a") return environmentAResponse;
      return discoverResponse({
        ...resources,
        namespaces: body.cluster === "aks-b" ? ["team-b"] : []
      });
    });
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("azure", "sub-1", "tenant-1");
    const resourceGroupSelect = page.selects["azure-rg-select"];
    resourceGroupSelect.value = "rg-a";
    resourceGroupSelect.dispatch("change");
    await flushPromises();

    handle?.setPendingInfraSelection(
      { resourceGroup: "rg-b", cluster: "aks-b", namespace: "team-b" },
      "azure"
    );
    await handle?.discoverResources("azure", "sub-1", "tenant-1");
    await flushPromises();

    resolveEnvironmentA(
      discoverResponse({ ...resources, namespaces: ["team-a"] })
    );
    await flushPromises();

    expect(bodies).toEqual([
      { provider: "azure", subscriptionId: "sub-1", tenantId: "tenant-1" },
      {
        provider: "azure",
        subscriptionId: "sub-1",
        tenantId: "tenant-1",
        resourceGroup: "rg-a",
        cluster: "aks-a"
      },
      { provider: "azure", subscriptionId: "sub-1", tenantId: "tenant-1" },
      {
        provider: "azure",
        subscriptionId: "sub-1",
        tenantId: "tenant-1",
        resourceGroup: "rg-b",
        cluster: "aks-b"
      }
    ]);
    expect(resourceGroupSelect.value).toBe("rg-b");
    expect(page.selects["azure-cluster-select"].value).toBe("aks-b");
    expect(
      Array.from(page.selects["azure-namespace-select"].options).map(
        (option) => option.value
      )
    ).toEqual(["", "team-b", "__custom__"]);
    expect(page.selects["azure-namespace-select"].value).toBe("team-b");
  });

  it("suppresses a duplicate Azure discovery when the namespace select is absent", async () => {
    const browser = createFakeBrowser();
    let resolveFirst: (value: HttpResponse) => void = () => {};
    const first = new Promise<HttpResponse>((resolve) => {
      resolveFirst = resolve;
    });
    browser.net.handle(DISCOVER_ENDPOINT, () => first);
    const handle = initializeDiscoveryPanel(browser.context);
    const firstCall = handle?.discoverResources("azure", "", "");

    await expect(
      handle?.discoverResources("azure", "", "")
    ).resolves.toBeUndefined();
    resolveFirst(discoverResponse(azurePayload()));
    await firstCall;
  });

  it("keeps Azure refresh controls disabled when a duplicate request is suppressed", async () => {
    const page = renderDiscoveryPage();
    const refreshBtn = createFakeInput("azure-refresh-btn");
    page.browser.document.add(refreshBtn);
    const namespaceSelect = page.selects["azure-namespace-select"];
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
    namespaceSelect.disabled = false;
    namespaceSelect.value = "default";
    await handle?.discoverResources("azure", "sub-1", "tenant-1");
    expect(refreshBtn.disabled).toBe(true);
    expect(namespaceSelect.disabled).toBe(true);
    expect(namespaceSelect.value).toBe("");
    expect(
      Array.from(namespaceSelect.options).map((option) => option.textContent)
    ).toEqual(["Discovering namespaces…"]);

    resolveFirst(discoverResponse(azurePayload()));
    await firstCall;
    await flushPromises();
    expect(refreshBtn.disabled).toBe(false);
    expect(namespaceSelect.disabled).toBe(false);
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
              ],
              resourceGroups: [{ id: "rg-2", name: "rg-2" }]
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
    page.selects["azure-rg-select"].value = "rg-2";
    page.selects["azure-rg-select"].dispatch("change");
    expect(
      Array.from(clusterSelect.options).map((option) => option.value)
    ).toEqual(["", "aks-2"]);

    // The superseded response lands last and must not overwrite the newer
    // account's resource list.
    resolveFirst(discoverResponse(azurePayload()));
    await firstCall;
    await flushPromises();
    page.selects["azure-rg-select"].value = "rg-2";
    page.selects["azure-rg-select"].dispatch("change");
    expect(
      Array.from(clusterSelect.options).map((option) => option.value)
    ).toEqual(["", "aks-2"]);
  });

  it("does not restore a stale deployment resource group after namespace discovery", async () => {
    const page = renderDiscoveryPage();
    let resolveOld: (value: HttpResponse) => void = () => {};
    const oldResponse = new Promise<HttpResponse>((resolve) => {
      resolveOld = resolve;
    });
    let requestCount = 0;
    const resources = azurePayload({
      resourceGroups: [
        { id: "rg-1", name: "rg-1" },
        { id: "rg-2", name: "rg-2" }
      ]
    });
    page.browser.net.handle(DISCOVER_ENDPOINT, () => {
      requestCount += 1;
      if (requestCount === 2) return oldResponse;
      return discoverResponse(resources);
    });
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("azure", "sub-1", "tenant-1");
    page.selects["azure-cluster-select"].value = "aks-1";
    page.selects["azure-rg-select"].value = "rg-1";
    const oldRequest = handle?.discoverResources("azure", "sub-1", "tenant-1");

    page.selects["azure-rg-select"].value = "rg-2";
    await handle?.discoverResources("azure", "sub-1", "tenant-1");
    resolveOld(discoverResponse(resources));
    await oldRequest;
    await flushPromises();

    expect(page.selects["azure-rg-select"].value).toBe("rg-2");
  });

  it("leaves Azure refresh controls disabled when a superseded response settles first", async () => {
    const page = renderDiscoveryPage();
    const refreshBtn = createFakeInput("azure-refresh-btn");
    page.browser.document.add(refreshBtn);
    const namespaceSelect = page.selects["azure-namespace-select"];
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
    expect(namespaceSelect.disabled).toBe(true);

    resolveSecond(discoverResponse(azurePayload()));
    await secondCall;
    await flushPromises();
    expect(refreshBtn.disabled).toBe(false);
    expect(namespaceSelect.disabled).toBe(false);
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
    page.selects["azure-rg-select"].value = "rg-1";
    page.selects["azure-rg-select"].dispatch("change");
    expect(
      Array.from(clusterSelect.options).map((option) => option.value)
    ).toEqual(["", "aks-1"]);
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
    browser.document.add(createFakeSelect("azure-rg-select"));
    browser.document.add(createFakeSelect("azure-cluster-select"));
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
    browser.document.add(createFakeSelect("azure-rg-select"));
    browser.document.add(createFakeSelect("azure-cluster-select"));
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

  it("re-queries namespaces when the selected cluster changes", async () => {
    const page = renderDiscoveryPage();
    const bodies: Array<Record<string, string>> = [];
    page.browser.net.handle(DISCOVER_ENDPOINT, (init) => {
      bodies.push(JSON.parse(init?.body ?? "{}"));
      return discoverResponse({
        clusters: [
          { id: "aks-1", name: "AKS One", resourceGroup: "rg-1" },
          { id: "aks-2", name: "AKS Two", resourceGroup: "rg-2" }
        ],
        resourceGroups: [
          { id: "rg-1", name: "rg-1" },
          { id: "rg-2", name: "rg-2" }
        ],
        namespaces: bodies.length === 1 ? [] : ["team-two"]
      });
    });
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("azure", "sub-1", "tenant-1");

    page.selects["azure-rg-select"].value = "rg-2";
    page.selects["azure-rg-select"].dispatch("change");
    page.selects["azure-cluster-select"].value = "aks-2";
    page.selects["azure-cluster-select"].dispatch("change");
    await flushPromises();

    expect(bodies.at(-1)).toEqual({
      provider: "azure",
      subscriptionId: "sub-1",
      tenantId: "tenant-1",
      resourceGroup: "rg-2",
      cluster: "aks-2"
    });
    expect(page.selects["azure-rg-select"].value).toBe("rg-2");
    expect(
      Array.from(page.selects["azure-namespace-select"].options).map(
        (option) => option.value
      )
    ).toEqual(["", "team-two", "__custom__"]);
  });

  it("limits clusters to the selected resource group and clears invalid selections", async () => {
    const page = renderDiscoveryPage();
    const handle = initializeDiscoveryPanel(page.browser.context);
    await loadTwoClusters(page, handle);

    const clusterSelect = page.selects["azure-cluster-select"];
    const rgSelect = page.selects["azure-rg-select"];
    rgSelect.value = "rg-1";
    rgSelect.dispatch("change");

    expect(
      Array.from(clusterSelect.options).map((option) => option.value)
    ).toEqual(["", "aks-1"]);
    expect(clusterSelect.value).toBe("aks-1");

    rgSelect.value = "rg-2";
    rgSelect.dispatch("change");
    expect(
      Array.from(clusterSelect.options).map((option) => option.value)
    ).toEqual(["", "aks-2"]);
    expect(clusterSelect.value).toBe("aks-2");
    expect(handle?.currentInfraSelection("azure").resourceGroup).toBe("rg-2");
  });

  it("leaves the cluster unselected when a resource group has multiple clusters", async () => {
    const page = renderDiscoveryPage();
    const bodies: Array<Record<string, string>> = [];
    page.browser.net.handle(DISCOVER_ENDPOINT, (init) => {
      bodies.push(JSON.parse(init?.body ?? "{}"));
      return discoverResponse({
        clusters: [
          { id: "aks-1", name: "AKS One", resourceGroup: "rg-1" },
          { id: "aks-2", name: "AKS Two", resourceGroup: "rg-1" }
        ],
        resourceGroups: [{ id: "rg-1", name: "rg-1" }],
        namespaces: []
      });
    });
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("azure", "sub-1", "tenant-1");

    page.selects["azure-rg-select"].value = "rg-1";
    page.selects["azure-rg-select"].dispatch("change");
    await flushPromises();

    expect(page.selects["azure-cluster-select"].value).toBe("");
    expect(bodies).toHaveLength(1);
  });

  it("does not restore auto-discovered namespaces after the cluster is cleared", async () => {
    const page = renderDiscoveryPage();
    let resolveNamespaces: (value: HttpResponse) => void = () => {};
    const namespaces = new Promise<HttpResponse>((resolve) => {
      resolveNamespaces = resolve;
    });
    let requestCount = 0;
    const resources = {
      clusters: [{ id: "aks-1", name: "AKS One", resourceGroup: "rg-1" }],
      resourceGroups: [{ id: "rg-1", name: "rg-1" }],
      namespaces: []
    };
    page.browser.net.handle(DISCOVER_ENDPOINT, () => {
      requestCount += 1;
      return requestCount === 1 ? discoverResponse(resources) : namespaces;
    });
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("azure", "sub-1", "tenant-1");

    const clusterSelect = page.selects["azure-cluster-select"];
    const namespaceSelect = page.selects["azure-namespace-select"];
    page.selects["azure-rg-select"].value = "rg-1";
    page.selects["azure-rg-select"].dispatch("change");
    expect(clusterSelect.value).toBe("aks-1");
    expect(namespaceSelect.disabled).toBe(true);

    clusterSelect.value = "";
    clusterSelect.dispatch("change");
    expect(namespaceSelect.disabled).toBe(false);

    resolveNamespaces(
      discoverResponse({ ...resources, namespaces: ["default"] })
    );
    await flushPromises();

    expect(clusterSelect.value).toBe("");
    expect(
      Array.from(namespaceSelect.options).map((option) => option.value)
    ).toEqual(["", "__custom__"]);
    expect(namespaceSelect.value).toBe("");
  });

  it("does not let an earlier namespace response restore clusters from another resource group", async () => {
    const page = renderDiscoveryPage();
    let resolveEarlierNamespaces: (value: HttpResponse) => void = () => {};
    const earlierNamespaces = new Promise<HttpResponse>((resolve) => {
      resolveEarlierNamespaces = resolve;
    });
    let resolveCurrentNamespaces: (value: HttpResponse) => void = () => {};
    const currentNamespaces = new Promise<HttpResponse>((resolve) => {
      resolveCurrentNamespaces = resolve;
    });
    let requestCount = 0;
    const resources = {
      clusters: [
        { id: "aks-1", name: "AKS One", resourceGroup: "rg-1" },
        { id: "aks-2", name: "AKS Two", resourceGroup: "rg-2" }
      ],
      resourceGroups: [
        { id: "rg-1", name: "rg-1" },
        { id: "rg-2", name: "rg-2" }
      ]
    };
    page.browser.net.handle(DISCOVER_ENDPOINT, () => {
      requestCount += 1;
      if (requestCount === 1) return discoverResponse(resources);
      return requestCount === 2 ? earlierNamespaces : currentNamespaces;
    });
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("azure", "sub-1", "tenant-1");

    const rgSelect = page.selects["azure-rg-select"];
    const clusterSelect = page.selects["azure-cluster-select"];
    const namespaceSelect = page.selects["azure-namespace-select"];
    rgSelect.value = "rg-1";
    rgSelect.dispatch("change");
    expect(clusterSelect.value).toBe("aks-1");
    expect(namespaceSelect.disabled).toBe(true);

    rgSelect.value = "rg-2";
    rgSelect.dispatch("change");
    expect(clusterSelect.value).toBe("aks-2");
    expect(namespaceSelect.disabled).toBe(true);
    expect(
      Array.from(clusterSelect.options).map((option) => option.value)
    ).toEqual(["", "aks-2"]);

    resolveEarlierNamespaces(
      discoverResponse({ ...resources, namespaces: ["stale-team"] })
    );
    await flushPromises();

    expect(rgSelect.value).toBe("rg-2");
    expect(clusterSelect.value).toBe("aks-2");
    expect(namespaceSelect.disabled).toBe(true);
    expect(namespaceSelect.value).toBe("");

    resolveCurrentNamespaces(
      discoverResponse({ ...resources, namespaces: ["team-two", "default"] })
    );
    await flushPromises();

    expect(
      Array.from(clusterSelect.options).map((option) => option.value)
    ).toEqual(["", "aks-2"]);
    expect(
      Array.from(namespaceSelect.options).map((option) => option.value)
    ).toEqual(["", "default", "team-two", "__custom__"]);
    expect(namespaceSelect.value).toBe("default");
  });

  it("uses the selected option's resource group when AKS names repeat", async () => {
    const page = renderDiscoveryPage();
    const handle = initializeDiscoveryPanel(page.browser.context);
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse({
        clusters: [
          { id: "shared-aks", name: "Shared AKS", resourceGroup: "rg-1" },
          { id: "shared-aks", name: "Shared AKS", resourceGroup: "rg-2" }
        ],
        resourceGroups: [
          { id: "rg-1", name: "rg-1" },
          { id: "rg-2", name: "rg-2" }
        ],
        namespaces: ["selected-team"]
      })
    );
    await handle?.discoverResources("azure", "sub-1", "tenant-1");

    const clusterSelect = page.selects["azure-cluster-select"];
    const rgSelect = page.selects["azure-rg-select"];
    rgSelect.value = "rg-2";
    rgSelect.dispatch("change");
    clusterSelect.value = "shared-aks";
    clusterSelect.dispatch("change");
    await flushPromises();

    expect(
      Array.from(clusterSelect.options).map((option) => option.textContent)
    ).toEqual(["Select AKS cluster…", "Shared AKS"]);
    expect(handle?.currentInfraSelection("azure").resourceGroup).toBe("rg-2");
    expect(page.browser.net.calls.at(-1)?.init?.body).toContain(
      '"resourceGroup":"rg-2"'
    );
  });

  it("does nothing when the cluster change selects empty, an unknown cluster, or one without a resource group", async () => {
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
    // A second discovery must not add another cross-filter listener.
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
    browser.document.add(createFakeSelect("azure-cluster-select"));
    for (const [selectId, customId] of COMBO_PAIRS) {
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
    page.selects["azure-cluster-select"].selectedIndex = 1;
    page.selects["azure-cluster-select"].value = "does-not-exist";
    expect(handle?.findAzureClusterResourceGroup("does-not-exist")).toBe("");
  });

  it("falls back to unambiguous metadata when no cluster option is selected", async () => {
    const page = renderDiscoveryPage();
    const handle = initializeDiscoveryPanel(page.browser.context);
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse({
        clusters: [
          { id: "aks-with-rg", name: "AKS With RG", resourceGroup: "rg-1" },
          { id: "aks-no-rg", name: "AKS No RG" }
        ],
        resourceGroups: []
      })
    );
    await handle?.discoverResources("azure", "", "");

    expect(handle?.findAzureClusterResourceGroup("aks-with-rg")).toBe("rg-1");
    expect(handle?.findAzureClusterResourceGroup("aks-no-rg")).toBe("");
  });

  it("resolves duplicate cluster names from the selected option", async () => {
    const page = renderDiscoveryPage();
    const handle = initializeDiscoveryPanel(page.browser.context);
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse({
        clusters: [
          { id: "shared-aks", name: "Shared AKS", resourceGroup: "rg-1" },
          { id: "shared-aks", name: "Shared AKS", resourceGroup: "rg-2" }
        ],
        resourceGroups: [
          { id: "rg-1", name: "rg-1" },
          { id: "rg-2", name: "rg-2" }
        ]
      })
    );
    await handle?.discoverResources("azure", "", "");

    expect(handle?.findAzureClusterResourceGroup("shared-aks")).toBe("");
    page.selects["azure-rg-select"].value = "rg-2";
    page.selects["azure-rg-select"].dispatch("change");
    page.selects["azure-cluster-select"].value = "shared-aks";
    expect(handle?.findAzureClusterResourceGroup("shared-aks")).toBe("rg-2");
  });

  it("gives duplicate malformed cluster entries distinct option identities", async () => {
    const page = renderDiscoveryPage();
    const handle = initializeDiscoveryPanel(page.browser.context);
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse({
        clusters: [
          { id: "shared-aks", name: "Shared AKS", resourceGroup: "rg-1" },
          { id: "shared-aks", name: "Shared AKS", resourceGroup: "rg-1" }
        ],
        resourceGroups: [{ id: "rg-1", name: "rg-1" }]
      })
    );
    await handle?.discoverResources("azure", "", "");
    page.selects["azure-rg-select"].value = "rg-1";
    page.selects["azure-rg-select"].dispatch("change");

    expect(
      Array.from(page.selects["azure-cluster-select"].options).map(
        (option) => option.value
      )
    ).toEqual(["", "__aks__:rg-1:shared-aks:0", "__aks__:rg-1:shared-aks:1"]);
  });
});

describe("AWS cluster discovery", () => {
  const ACCOUNT = "123456789012";
  const REGION = "us-west-2";
  const SAVED = {
    cluster: "eks-1",
    namespace: "team-a",
    vpcId: "vpc-1",
    subnetIds: "subnet-a,subnet-c"
  };

  // A discovery endpoint whose next answers the test sets one at a time.
  function scriptedDiscovery(page: DiscoveryPage) {
    const answers: Array<() => Promise<HttpResponse>> = [];
    const requests: Array<Record<string, unknown>> = [];
    page.browser.net.handle(DISCOVER_ENDPOINT, (init) => {
      requests.push(JSON.parse(init?.body ?? "{}"));
      const next = answers.shift();
      if (!next) throw new Error("No discovery answer was scripted.");
      return next();
    });
    return {
      // The parsed body of each request, oldest first.
      requests,
      answer(data: Record<string, unknown>) {
        answers.push(() => Promise.resolve(discoverResponse(data)));
      },
      fail(message: string) {
        answers.push(() => Promise.reject(new Error(message)));
      },
      hold() {
        let resolve: (response: HttpResponse) => void = () => {};
        const pending = new Promise<HttpResponse>((done) => {
          resolve = done;
        });
        answers.push(() => pending);
        return (data: Record<string, unknown>) =>
          resolve(discoverResponse(data));
      }
    };
  }

  function toggleSubnet(page: DiscoveryPage, id: string, checked: boolean) {
    const box = fakeTree(page.awsSubnetsList).find(
      (element) => element.id === `aws-subnet-${id}`
    );
    if (!box) throw new Error(`No checkbox for ${id}.`);
    Object.assign(box, { checked });
    box.dispatch("change");
  }

  it("renders a disabled option for each unusable cluster and never disables an Azure option", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, (init) =>
      JSON.parse(init?.body ?? "{}").provider === "aws" ?
        discoverResponse(
          awsPayload({
            clusters: [
              awsCluster("eks-1"),
              awsCluster("old", {
                status: "DELETING",
                usable: false,
                unusableReason: "status"
              })
            ]
          })
        )
      : discoverResponse({
          clusters: [{ id: "aks-1", name: "AKS One", resourceGroup: "rg-1" }],
          resourceGroups: [{ id: "rg-1", name: "rg-1" }],
          namespaces: ["default"]
        })
    );
    const handle = initializeDiscoveryPanel(page.browser.context);

    await handle?.discoverResources("aws", ACCOUNT, REGION);
    await handle?.discoverResources("azure", "", "");

    const disabled = (id: string) =>
      page.selects[id].options
        .filter((option) => option.value !== "")
        .map((option) => `${option.value}:${String(option.disabled)}`);
    expect(disabled("aws-cluster-select")).toEqual(["eks-1:false", "old:true"]);
    expect(
      page.selects["aws-cluster-select"].options.map(
        (option) => option.textContent
      )
    ).toEqual(["Select a cluster", "eks-1", "old (DELETING)"]);
    for (const id of [
      "azure-rg-select",
      "azure-cluster-select",
      "azure-namespace-select"
    ]) {
      expect(disabled(id).every((entry) => entry.endsWith(":false"))).toBe(
        true
      );
    }
  });

  it("keeps the error kinds of a response for the status line", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse({
        clusters: [],
        errors: { clusters: "AccessDenied" },
        errorKinds: { clusters: "denied" }
      })
    );
    const handle = initializeDiscoveryPanel(page.browser.context);

    await handle?.discoverResources("aws", ACCOUNT, REGION);

    expect(page.awsStatus.textContent).toBe(
      "The signed-in identity can't list EKS clusters (eks:ListClusters)."
    );
    expect(page.selects["aws-cluster-select"].options[0].textContent).toBe(
      "Clusters unavailable"
    );
  });

  it.each([
    ["one usable cluster beside an unusable one", ["eks-1"], ["old"], "eks-1"],
    ["two usable clusters", ["eks-1", "eks-2"], [], ""],
    ["no usable cluster", [], ["old"], ""]
  ])(
    "auto-selects a cluster only when exactly one is usable: %s",
    async (_label, usable, unusable, expected) => {
      const page = renderDiscoveryPage();
      page.browser.net.handle(DISCOVER_ENDPOINT, () =>
        discoverResponse(
          awsPayload({
            clusters: [
              ...usable.map((id) => awsCluster(id)),
              ...unusable.map((id) =>
                awsCluster(id, { usable: false, unusableReason: "status" })
              )
            ]
          })
        )
      );
      const handle = initializeDiscoveryPanel(page.browser.context);

      await handle?.discoverResources("aws", ACCOUNT, REGION);

      expect(page.selects["aws-cluster-select"].value).toBe(expected);
      expect(page.selects["aws-namespace-select"].value).toBe("default");
      expect(checkedSubnets(page)).toEqual(
        expected === "" ? [] : ["subnet-a", "subnet-b"]
      );
    }
  );

  it("treats a response that isn't an object as an empty cluster list", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () => jsonResponse([]));
    const handle = initializeDiscoveryPanel(page.browser.context);

    await handle?.discoverResources("aws", ACCOUNT, REGION);

    expect(page.awsStatus.textContent).toBe("No EKS clusters in us-west-2.");
    expect(page.selects["aws-cluster-select"].options[0].textContent).toBe(
      "No EKS clusters"
    );
    expect(handle?.awsInfrastructureError()).toBe("Select an EKS cluster.");
  });

  it("reports the status line of an unusable cluster selected by code", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(
        awsPayload({
          clusters: [
            awsCluster("old", {
              status: "DELETING",
              usable: false,
              unusableReason: "status"
            })
          ]
        })
      )
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("aws", ACCOUNT, REGION);

    page.selects["aws-cluster-select"].value = "old";

    expect(handle?.awsInfrastructureError()).toBe(
      "old is DELETING. Radius can use a cluster that is ACTIVE or UPDATING."
    );
  });

  it("shows the empty-list label when the account has no clusters", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(awsPayload({ clusters: [] }))
    );
    const handle = initializeDiscoveryPanel(page.browser.context);

    await handle?.discoverResources("aws", ACCOUNT, REGION);

    expect(page.selects["aws-cluster-select"].options[0].textContent).toBe(
      "No EKS clusters"
    );
    expect(page.awsStatus.textContent).toBe("No EKS clusters in us-west-2.");
  });

  it("writes one cluster note line for each reason a cluster can't be used", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(
        awsPayload({
          clusters: [
            awsCluster("a-config", {
              authenticationMode: "CONFIG_MAP",
              usable: false,
              unusableReason: "config-map"
            }),
            awsCluster("b-creating", {
              status: "CREATING",
              usable: false,
              unusableReason: "status"
            }),
            awsCluster("c-denied", {
              usable: false,
              unusableReason: "not-described",
              describeErrorKind: "denied"
            }),
            awsCluster("d-session", {
              usable: false,
              unusableReason: "not-described",
              describeErrorKind: "credentials"
            }),
            awsCluster("e-other", {
              usable: false,
              unusableReason: "not-described",
              describeErrorKind: "other"
            }),
            awsCluster("f-ok")
          ]
        })
      )
    );
    const handle = initializeDiscoveryPanel(page.browser.context);

    await handle?.discoverResources("aws", ACCOUNT, REGION);

    expect(page.awsClusterNote.hidden).toBe(false);
    expect(page.awsClusterNote.children.map((row) => fakeText(row))).toEqual([
      "a-config uses CONFIG_MAP authentication, which doesn't support access entries. A cluster administrator can enable access entries with this command. After that, AWS doesn't allow a switch back to CONFIG_MAP.aws eks update-cluster-config --name a-config --region us-west-2 --access-config authenticationMode=API_AND_CONFIG_MAP",
      "b-creating is CREATING. Radius can use a cluster that is ACTIVE or UPDATING.",
      "The signed-in identity can't read c-denied (eks:DescribeCluster).",
      "The AWS CLI session ended before d-session could be read. Sign in, then select Refresh.",
      "AWS didn't return the details of e-other. Select Refresh to try again."
    ]);
    const command = fakeTree(page.awsClusterNote).find(
      (element) => element.tagName === "code"
    );
    expect(command?.textContent).toContain("--region us-west-2");
    expect(page.selects["aws-cluster-select"].value).toBe("f-ok");

    // The next discovery clears the note until its response arrives.
    const pending = handle?.discoverResources("aws", ACCOUNT, "us-east-2");
    expect(page.awsClusterNote.hidden).toBe(true);
    await pending;
  });

  it("renders the AWS sign-in button in its own host and hides it after a discovery without a session error", async () => {
    const page = renderDiscoveryPage();
    let signedIn = false;
    page.browser.net.handle(DISCOVER_ENDPOINT, (init) => {
      const provider = JSON.parse(init?.body ?? "{}").provider;
      if (provider === "azure") {
        return discoverResponse({
          clusters: [],
          resourceGroups: [],
          errors: { clusters: "Azure CLI sign-in is required." },
          remediation: {
            id: "azure-cli-login",
            params: {
              tenantId: "11111111-2222-3333-4444-555555555555",
              nextStep: "refresh-discovery"
            }
          }
        });
      }
      return discoverResponse(
        signedIn ? awsPayload() : (
          {
            clusters: [],
            errors: { clusters: "Token has expired" },
            errorKinds: { clusters: "credentials" },
            remediation: {
              id: "aws-cli-login",
              params: { nextStep: "refresh-discovery" }
            }
          }
        )
      );
    });
    const handle = initializeDiscoveryPanel(page.browser.context, {
      mutationNonce: "nonce-1092"
    });

    await handle?.discoverResources("aws", ACCOUNT, REGION);
    await handle?.discoverResources(
      "azure",
      "",
      "11111111-2222-3333-4444-555555555555"
    );

    expect(page.awsStatus.textContent).toBe(
      "The AWS CLI has no valid session. Sign in, then select Refresh."
    );
    expect(page.awsRemediation.hidden).toBe(false);
    expect(fakeText(page.awsRemediation)).toContain("Sign in to AWS CLI");
    expect(fakeText(page.awsRemediation)).toContain("aws sso login");
    expect(
      fakeTree(page.awsRemediation).some((element) =>
        element.id.startsWith("aws-discover-login")
      )
    ).toBe(true);
    // The Azure button keeps its own host, prefix, and tenant.
    expect(page.azureRemediation.hidden).toBe(false);
    expect(fakeText(page.azureRemediation)).toContain(
      "az login --use-device-code --tenant 11111111-2222-3333-4444-555555555555"
    );
    expect(
      fakeTree(page.azureRemediation).some((element) =>
        element.id.startsWith("azure-discover-login")
      )
    ).toBe(true);
    expect(fakeText(page.awsRemediation)).not.toContain("az login");

    page.browser.net.handle("/api/run-remediation", (init) => {
      expect(JSON.parse(init?.body ?? "{}")).toEqual({
        id: "aws-cli-login",
        params: { nextStep: "refresh-discovery" },
        confirmed: false
      });
      return jsonResponse({ success: true, message: "Handed off." });
    });
    fakeTree(page.awsRemediation)
      .find((element) => element.textContent === COMMAND_RUN_LABEL)
      ?.dispatch("click");
    await flushPromises();
    expect(page.browser.net.calls.at(-1)?.url).toBe("/api/run-remediation");
    expect(fakeText(page.awsRemediation)).toContain(
      "refresh resource discovery"
    );

    signedIn = true;
    await handle?.discoverResources("aws", ACCOUNT, REGION);
    expect(page.awsRemediation.hidden).toBe(true);
    expect(page.awsRemediation.children).toEqual([]);
    expect(page.azureRemediation.hidden).toBe(false);

    signedIn = false;
    await handle?.discoverResources("aws", ACCOUNT, REGION);
    expect(page.awsRemediation.hidden).toBe(false);
    handle?.teardown();
    expect(page.awsRemediation.hidden).toBe(true);
    expect(page.azureRemediation.hidden).toBe(true);
  });

  it("doesn't let the AWS sign-in button run without a mutation nonce", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse({
        clusters: [],
        errors: { clusters: "Token has expired" },
        errorKinds: { clusters: "credentials" },
        remediation: {
          id: "aws-cli-login",
          params: { nextStep: "refresh-discovery" }
        }
      })
    );
    const handle = initializeDiscoveryPanel(page.browser.context);

    await handle?.discoverResources("aws", ACCOUNT, REGION);

    const runButton = fakeTree(page.awsRemediation).find(
      (element) => element.textContent === COMMAND_RUN_LABEL
    );
    if (!runButton) throw new Error("the sign-in remediation has no Run");
    expect(Reflect.get(runButton, "disabled")).toBe(true);
    expect(fakeText(page.awsRemediation)).toContain(
      "Reload the Radius canvas before asking Copilot to run this command."
    );
  });

  it("hides the AWS sign-in button when a discovery request fails", async () => {
    const page = renderDiscoveryPage();
    const discovery = scriptedDiscovery(page);
    discovery.answer({
      clusters: [],
      errors: { clusters: "Token has expired" },
      errorKinds: { clusters: "credentials" },
      remediation: {
        id: "aws-cli-login",
        params: { nextStep: "refresh-discovery" }
      }
    });
    discovery.fail("network down");
    const handle = initializeDiscoveryPanel(page.browser.context, {
      mutationNonce: "nonce-1092"
    });

    await handle?.discoverResources("aws", ACCOUNT, REGION);
    expect(page.awsRemediation.hidden).toBe(false);
    await handle?.discoverResources("aws", ACCOUNT, "us-east-2");

    expect(page.awsStatus.textContent).toBe("Discovery error: network down");
    expect(page.awsRemediation.hidden).toBe(true);
  });

  it("keeps the selected cluster, namespace, and subnets across Refresh without checking the defaults", async () => {
    const page = renderDiscoveryPage();
    const discovery = scriptedDiscovery(page);
    discovery.answer(awsPayload({ namespaces: ["default", "team-a"] }));
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("aws", ACCOUNT, REGION);
    expect(checkedSubnets(page)).toEqual(["subnet-a", "subnet-b"]);

    page.selects["aws-namespace-select"].value = "team-a";
    page.selects["aws-namespace-select"].dispatch("change");
    toggleSubnet(page, "subnet-b", false);
    toggleSubnet(page, "subnet-c", true);
    const release = discovery.hold();
    const refresh = handle?.discoverResources("aws", ACCOUNT, REGION, {
      keepSelection: true
    });
    // While the request runs the form is cleared, but the selection is held,
    // and the request names its cluster.
    expect(page.selects["aws-cluster-select"].value).toBe("");
    await flushPromises();
    expect(discovery.requests[1]).toHaveProperty("cluster", "eks-1");
    release(awsPayload({ namespaces: ["default", "team-a"] }));
    await refresh;

    expect(handle?.currentInfraSelection("aws")).toEqual({
      cluster: "eks-1",
      namespace: "team-a",
      vpcId: "vpc-1",
      subnetIds: "subnet-a,subnet-c"
    });
    expect(page.awsRestoreNote.hidden).toBe(true);
  });

  it("applies the defaults on Refresh when no cluster is selected", async () => {
    const page = renderDiscoveryPage();
    const discovery = scriptedDiscovery(page);
    discovery.answer(
      awsPayload({ clusters: [awsCluster("eks-1"), awsCluster("eks-2")] })
    );
    discovery.answer(awsPayload());
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("aws", ACCOUNT, REGION);
    expect(page.selects["aws-cluster-select"].value).toBe("");

    await handle?.discoverResources("aws", ACCOUNT, REGION, {
      keepSelection: true
    });

    expect(page.selects["aws-cluster-select"].value).toBe("eks-1");
    expect(checkedSubnets(page)).toEqual(["subnet-a", "subnet-b"]);
  });

  it("doesn't hold the selection when Refresh runs for another account or region", async () => {
    const page = renderDiscoveryPage();
    const discovery = scriptedDiscovery(page);
    discovery.answer(awsPayload());
    discovery.answer(
      awsPayload({ clusters: [awsCluster("eks-1"), awsCluster("eks-2")] })
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("aws", ACCOUNT, REGION);

    await handle?.discoverResources("aws", ACCOUNT, "us-east-2", {
      keepSelection: true
    });

    expect(page.selects["aws-cluster-select"].value).toBe("");
  });

  it.each([
    [
      "the request fails",
      (d: ReturnType<typeof scriptedDiscovery>) => d.fail("network down")
    ],
    [
      "the cluster list fails",
      (d: ReturnType<typeof scriptedDiscovery>) =>
        d.answer({
          clusters: [],
          errors: { clusters: "Throttling" },
          errorKinds: { clusters: "other" }
        })
    ],
    [
      "the response has a top-level error",
      (d: ReturnType<typeof scriptedDiscovery>) =>
        d.answer({ error: "server busy" })
    ]
  ])(
    "keeps a saved selection when %s, then restores it on the next discovery",
    async (_label, firstAnswer) => {
      const page = renderDiscoveryPage();
      const discovery = scriptedDiscovery(page);
      firstAnswer(discovery);
      discovery.answer(awsPayload({ namespaces: ["default", "team-a"] }));
      const handle = initializeDiscoveryPanel(page.browser.context);
      handle?.setPendingInfraSelection(SAVED, "aws");

      await handle?.discoverResources("aws", ACCOUNT, REGION);

      expect(page.selects["aws-cluster-select"].value).toBe("");
      expect(page.selects["aws-cluster-select"].options[0].textContent).toBe(
        "Clusters unavailable"
      );
      expect(handle?.awsInfrastructureError()).toBe("Select an EKS cluster.");
      expect(page.customs["aws-namespace-custom"].value).toBe("team-a");

      await handle?.discoverResources("aws", ACCOUNT, REGION);

      expect(discovery.requests.map((body) => body.cluster)).toEqual([
        "eks-1",
        "eks-1"
      ]);
      expect(handle?.currentInfraSelection("aws")).toEqual(SAVED);
      expect(page.selects["aws-namespace-select"].value).toBe("team-a");
      expect(handle?.awsInfrastructureError()).toBe("");
    }
  );

  it("selects the saved cluster but holds its subnets while the subnet list is denied", async () => {
    const page = renderDiscoveryPage();
    const discovery = scriptedDiscovery(page);
    discovery.answer(
      awsPayload({
        subnets: [],
        errors: { subnets: "UnauthorizedOperation" },
        errorKinds: { subnets: "denied" }
      })
    );
    discovery.answer(awsPayload());
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection(SAVED, "aws");

    await handle?.discoverResources("aws", ACCOUNT, REGION);

    expect(page.selects["aws-cluster-select"].value).toBe("eks-1");
    expect(page.awsRestoreNote.hidden).toBe(true);
    expect(fakeText(page.awsSubnetsList)).toBe("Subnets unavailable.");
    expect(handle?.awsInfrastructureError()).toBe(
      "Subnets couldn't be listed."
    );
    expect(page.awsStatus.textContent).toBe(
      "Found 1 EKS cluster in us-west-2. The signed-in identity can't list subnets (ec2:DescribeSubnets)."
    );

    await handle?.discoverResources("aws", ACCOUNT, REGION);

    expect(checkedSubnets(page)).toEqual(["subnet-a", "subnet-c"]);
    expect(handle?.currentInfraSelection("aws")).toEqual(SAVED);
  });

  it("treats a subnet error kind it does not know as a failed list", async () => {
    const page = renderDiscoveryPage();
    const discovery = scriptedDiscovery(page);
    discovery.answer(
      awsPayload({
        subnets: [],
        errors: { subnets: "Throttling" },
        errorKinds: { subnets: "throttled" }
      })
    );
    discovery.answer(awsPayload());
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection(SAVED, "aws");

    await handle?.discoverResources("aws", ACCOUNT, REGION);

    expect(fakeText(page.awsSubnetsList)).toBe("Subnets unavailable.");
    expect(handle?.awsInfrastructureError()).toBe(
      "Subnets couldn't be listed."
    );
    expect(page.awsStatus.textContent).toBe(
      "Found 1 EKS cluster in us-west-2. Can't list subnets: Throttling"
    );

    // The saved subnets were held, so the next discovery restores them.
    await handle?.discoverResources("aws", ACCOUNT, REGION);
    expect(checkedSubnets(page)).toEqual(["subnet-a", "subnet-c"]);
  });

  it("names saved subnets that are no longer usable", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(
        awsPayload({
          subnets: [
            awsSubnet("subnet-a", "us-west-2a", "private"),
            awsSubnet("subnet-b", "us-west-2b", "private"),
            awsSubnet("subnet-lz", "us-west-2-lax-1a", "private", {
              zoneKind: "local-zone"
            })
          ]
        })
      )
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection(
      { cluster: "eks-1", subnetIds: "subnet-a,subnet-lz,subnet-gone" },
      "aws"
    );

    await handle?.discoverResources("aws", ACCOUNT, REGION);

    expect(checkedSubnets(page)).toEqual(["subnet-a"]);
    expect(page.awsRestoreNote.hidden).toBe(false);
    expect(page.awsRestoreNote.textContent).toBe(
      "These saved subnets were removed from the selection: subnet-lz (Local Zone), subnet-gone (not found in the cluster's VPC)."
    );
  });

  it("clears a saved cluster that can't be used even when another cluster is the only usable one", async () => {
    const page = renderDiscoveryPage();
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      discoverResponse(
        awsPayload({
          clusters: [
            awsCluster("eks-1", {
              authenticationMode: "CONFIG_MAP",
              usable: false,
              unusableReason: "config-map"
            }),
            awsCluster("eks-2")
          ]
        })
      )
    );
    const onInfrastructureChange = vi.fn();
    const handle = initializeDiscoveryPanel(page.browser.context, {
      mutationNonce: "nonce",
      onInfrastructureChange
    });
    handle?.setPendingInfraSelection(SAVED, "aws");

    await handle?.discoverResources("aws", ACCOUNT, REGION);

    expect(page.selects["aws-cluster-select"].value).toBe("");
    expect(checkedSubnets(page)).toEqual([]);
    expect(handle?.awsInfrastructureError()).toBe("Select an EKS cluster.");
    expect(onInfrastructureChange).toHaveBeenCalled();
    expect(fakeText(page.awsClusterNote)).toContain(
      "eks-1 uses CONFIG_MAP authentication"
    );
    expect(fakeText(page.awsClusterNote)).not.toContain("wasn't found");
    expect(page.customs["aws-namespace-custom"].value).toBe("team-a");
  });

  it("holds a saved selection when AWS doesn't describe its cluster", async () => {
    const page = renderDiscoveryPage();
    const discovery = scriptedDiscovery(page);
    discovery.answer(
      awsPayload({
        clusters: [
          awsCluster("eks-1", {
            usable: false,
            unusableReason: "not-described",
            describeErrorKind: "other"
          }),
          awsCluster("eks-2")
        ]
      })
    );
    discovery.answer(
      awsPayload({ clusters: [awsCluster("eks-1"), awsCluster("eks-2")] })
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection(SAVED, "aws");

    await handle?.discoverResources("aws", ACCOUNT, REGION);

    expect(page.selects["aws-cluster-select"].value).toBe("");
    expect(fakeText(page.awsClusterNote)).not.toContain("wasn't found");

    await handle?.discoverResources("aws", ACCOUNT, REGION, {
      keepSelection: true
    });

    expect(discovery.requests[1]).toHaveProperty("cluster", "eks-1");
    expect(handle?.currentInfraSelection("aws")).toEqual(SAVED);
  });

  it("drops a saved selection when discovery moves to another account or region", async () => {
    const page = renderDiscoveryPage();
    const discovery = scriptedDiscovery(page);
    discovery.fail("network down");
    discovery.answer(awsPayload());
    discovery.answer(awsPayload());
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection(SAVED, "aws");

    await handle?.discoverResources("aws", ACCOUNT, REGION);
    await handle?.discoverResources("aws", "999988887777", REGION);

    expect(discovery.requests[1]).not.toHaveProperty("cluster");
    expect(checkedSubnets(page)).toEqual(["subnet-a", "subnet-b"]);
    expect(page.selects["aws-namespace-select"].value).toBe("default");

    await handle?.discoverResources("aws", ACCOUNT, REGION);
    expect(checkedSubnets(page)).toEqual(["subnet-a", "subnet-b"]);
  });

  it("keeps the account tie of a selection held across a subtab switch", async () => {
    const page = renderDiscoveryPage();
    const discovery = scriptedDiscovery(page);
    discovery.fail("network down");
    discovery.answer(awsPayload());
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection(SAVED, "aws");
    await handle?.discoverResources("aws", ACCOUNT, REGION);

    handle?.preserveInfraSelection("aws");
    await handle?.discoverResources("aws", ACCOUNT, "us-east-2");

    // The hold still belongs to us-west-2, so us-east-2 drops it.
    expect(discovery.requests[1]).not.toHaveProperty("cluster");
    expect(checkedSubnets(page)).toEqual(["subnet-a", "subnet-b"]);
  });

  it("holds the AWS selection on screen across a subtab switch", async () => {
    const page = renderDiscoveryPage();
    const discovery = scriptedDiscovery(page);
    const namespaces = ["default", "team-a"];
    discovery.answer(awsPayload({ namespaces }));
    discovery.answer(
      awsPayload({
        clusters: [awsCluster("eks-1"), awsCluster("eks-2")],
        namespaces
      })
    );
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("aws", ACCOUNT, REGION);
    page.selects["aws-namespace-select"].value = "team-a";
    toggleSubnet(page, "subnet-b", false);
    toggleSubnet(page, "subnet-c", true);

    handle?.preserveInfraSelection("aws");
    await handle?.discoverResources("aws", ACCOUNT, REGION);

    expect(discovery.requests[1]).toHaveProperty("cluster", "eks-1");
    expect(handle?.currentInfraSelection("aws")).toEqual(SAVED);
  });

  it("holds the Azure selection on screen across a subtab switch", async () => {
    const page = renderDiscoveryPage();
    const discovery = scriptedDiscovery(page);
    const azure = {
      clusters: [{ id: "aks-1", name: "AKS One", resourceGroup: "rg-1" }],
      resourceGroups: [{ id: "rg-1", name: "rg-1" }],
      namespaces: ["default"]
    };
    discovery.answer(azure);
    discovery.answer(azure);
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("azure", "", "");
    page.selects["azure-namespace-select"].value = "__custom__";
    page.customs["azure-namespace-custom"].value = "team-typed";

    handle?.preserveInfraSelection("azure");
    await handle?.discoverResources("azure", "", "");

    expect(handle?.currentInfraSelection("azure").namespace).toBe("team-typed");
  });

  it("drops a held selection when the developer picks a cluster", async () => {
    const page = renderDiscoveryPage();
    const discovery = scriptedDiscovery(page);
    discovery.fail("network down");
    const handle = initializeDiscoveryPanel(page.browser.context);
    discovery.answer(awsPayload());
    handle?.setPendingInfraSelection(SAVED, "aws");
    await handle?.discoverResources("aws", ACCOUNT, REGION);

    page.selects["aws-cluster-select"].dispatch("change");
    await handle?.discoverResources("aws", ACCOUNT, REGION);

    expect(discovery.requests[1]).not.toHaveProperty("cluster");
    expect(checkedSubnets(page)).toEqual(["subnet-a", "subnet-b"]);
  });

  it("copies a namespace the developer picks into the held selection", async () => {
    const page = renderDiscoveryPage();
    const discovery = scriptedDiscovery(page);
    discovery.fail("network down");
    discovery.answer(awsPayload({ namespaces: ["default", "team-b"] }));
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection(SAVED, "aws");
    await handle?.discoverResources("aws", ACCOUNT, REGION);

    // The failed request left the held namespace in the custom field.
    expect(page.selects["aws-namespace-select"].value).toBe("__custom__");
    page.customs["aws-namespace-custom"].value = "team-b";
    page.customs["aws-namespace-custom"].dispatch("change");

    await handle?.discoverResources("aws", ACCOUNT, REGION);
    expect(page.selects["aws-namespace-select"].value).toBe("team-b");
    expect(handle?.currentInfraSelection("aws").cluster).toBe("eks-1");
  });

  it("doesn't hold a selection when the developer picks a namespace", async () => {
    const page = renderDiscoveryPage();
    const discovery = scriptedDiscovery(page);
    discovery.answer(awsPayload({ namespaces: ["default", "team-b"] }));
    discovery.answer(awsPayload({ namespaces: ["default", "team-b"] }));
    const handle = initializeDiscoveryPanel(page.browser.context);
    await handle?.discoverResources("aws", ACCOUNT, REGION);

    page.selects["aws-namespace-select"].value = "team-b";
    page.selects["aws-namespace-select"].dispatch("change");
    expect(handle?.currentInfraSelection("aws").namespace).toBe("team-b");
    await handle?.discoverResources("aws", ACCOUNT, REGION);

    expect(discovery.requests[1]).not.toHaveProperty("cluster");
    expect(page.selects["aws-namespace-select"].value).toBe("default");
  });

  it("doesn't let a stale response change the held selection", async () => {
    const page = renderDiscoveryPage();
    const discovery = scriptedDiscovery(page);
    const releaseFirst = discovery.hold();
    const releaseSecond = discovery.hold();
    const handle = initializeDiscoveryPanel(page.browser.context);
    const other = { ...SAVED, namespace: "team-other" };
    handle?.setPendingInfraSelection(other, "aws");
    const first = handle?.discoverResources("aws", ACCOUNT, REGION);

    handle?.setPendingInfraSelection(SAVED, "aws");
    const second = handle?.discoverResources("aws", ACCOUNT, REGION);
    releaseFirst(awsPayload({ clusters: [] }));
    await first;

    expect(page.selects["aws-cluster-select"].options[0].textContent).toBe(
      "Discovering EKS clusters…"
    );

    releaseSecond(awsPayload({ namespaces: ["default", "team-a"] }));
    await second;
    expect(handle?.currentInfraSelection("aws")).toEqual(SAVED);
  });

  it("drops a held AWS selection when an Azure selection is set", async () => {
    const page = renderDiscoveryPage();
    const discovery = scriptedDiscovery(page);
    discovery.fail("network down");
    const handle = initializeDiscoveryPanel(page.browser.context);
    discovery.answer(awsPayload());
    handle?.setPendingInfraSelection(SAVED, "aws");
    await handle?.discoverResources("aws", ACCOUNT, REGION);

    handle?.setPendingInfraSelection({ cluster: "aks-1" }, "azure");
    await handle?.discoverResources("aws", ACCOUNT, REGION);

    expect(discovery.requests[1]).not.toHaveProperty("cluster");
  });

  it("notes that the namespace list has only default when the cluster's namespaces can't be read", async () => {
    const page = renderDiscoveryPage();
    const discovery = scriptedDiscovery(page);
    discovery.answer(
      awsPayload({
        errors: { namespaces: "kubectl: connection refused" },
        errorKinds: { namespaces: "other" }
      })
    );
    discovery.answer(awsPayload());
    const handle = initializeDiscoveryPanel(page.browser.context);

    await handle?.discoverResources("aws", ACCOUNT, REGION);

    expect(page.awsNamespaceNote.hidden).toBe(false);
    expect(fakeText(page.awsNamespaceNote)).toBe(
      "Can't list the namespaces in eks-1. Use default, or enter a custom namespace. Deploy creates the namespace if the cluster doesn't have it."
    );
    expect(page.awsNamespaceNote.textContent).not.toContain("connection");

    await handle?.discoverResources("aws", ACCOUNT, REGION);
    expect(page.awsNamespaceNote.hidden).toBe(true);
  });

  it("doesn't note the namespace list when no cluster is selected", async () => {
    const page = renderDiscoveryPage();
    const discovery = scriptedDiscovery(page);
    discovery.answer(
      awsPayload({ clusters: [awsCluster("eks-1"), awsCluster("eks-2")] })
    );
    const handle = initializeDiscoveryPanel(page.browser.context);

    await handle?.discoverResources("aws", ACCOUNT, REGION);

    expect(page.selects["aws-cluster-select"].value).toBe("");
    expect(page.awsNamespaceNote.hidden).toBe(true);
  });

  it("doesn't send a saved cluster name that EKS can't have", async () => {
    const page = renderDiscoveryPage();
    const discovery = scriptedDiscovery(page);
    discovery.answer(awsPayload());
    const handle = initializeDiscoveryPanel(page.browser.context);
    handle?.setPendingInfraSelection({ ...SAVED, cluster: "eks 1;" }, "aws");

    await handle?.discoverResources("aws", ACCOUNT, REGION);

    expect(discovery.requests[0]).not.toHaveProperty("cluster");
  });

  describe("when the developer picks a cluster", () => {
    const TWO_CLUSTERS = [awsCluster("eks-1"), awsCluster("eks-2")];

    async function discoverTwoClusters() {
      const page = renderDiscoveryPage();
      const discovery = scriptedDiscovery(page);
      discovery.answer(awsPayload({ clusters: TWO_CLUSTERS }));
      const handle = initializeDiscoveryPanel(page.browser.context);
      await handle?.discoverResources("aws", ACCOUNT, REGION);
      return { page, discovery, handle };
    }

    function pickCluster(page: DiscoveryPage, cluster: string) {
      page.selects["aws-cluster-select"].value = cluster;
      page.selects["aws-cluster-select"].dispatch("change");
    }

    it("lists the namespaces of that cluster", async () => {
      const { page, discovery } = await discoverTwoClusters();
      const release = discovery.hold();

      pickCluster(page, "eks-2");
      await flushPromises();

      const namespaceSelect = page.selects["aws-namespace-select"];
      expect(namespaceSelect.disabled).toBe(true);
      expect(discovery.requests[1]).toEqual({
        provider: "aws",
        accountId: ACCOUNT,
        region: REGION,
        cluster: "eks-2"
      });
      release(
        awsPayload({
          clusters: TWO_CLUSTERS,
          namespaces: ["default", "team-b"]
        })
      );
      await flushPromises();

      expect(optionValues(namespaceSelect)).toContain("team-b");
      expect(namespaceSelect.value).toBe("default");
      expect(namespaceSelect.disabled).toBe(false);
      expect(page.awsNamespaceNote.hidden).toBe(true);
      expect(page.selects["aws-cluster-select"].value).toBe("eks-2");
    });

    it("blocks Create until the namespaces of that cluster are read", async () => {
      const page = renderDiscoveryPage();
      const discovery = scriptedDiscovery(page);
      discovery.answer(awsPayload({ clusters: TWO_CLUSTERS }));
      // The page reads the error each time the panel reports a change.
      const createErrors: string[] = [];
      let handle: DiscoveryPanelHandle | null = null;
      handle = initializeDiscoveryPanel(page.browser.context, {
        mutationNonce: "",
        onInfrastructureChange: () => {
          createErrors.push(handle?.awsInfrastructureError() ?? "");
        }
      });
      await handle?.discoverResources("aws", ACCOUNT, REGION);
      const release = discovery.hold();

      pickCluster(page, "eks-2");
      await flushPromises();

      expect(createErrors.at(-1)).toBe("Wait for the namespace list to load.");
      release(awsPayload({ clusters: TWO_CLUSTERS }));
      await flushPromises();

      expect(createErrors.at(-1)).toBe("");
    });

    it("shows only default and the note when the request fails", async () => {
      const { page, discovery } = await discoverTwoClusters();
      discovery.fail("network down");

      pickCluster(page, "eks-2");
      await flushPromises();

      const namespaceSelect = page.selects["aws-namespace-select"];
      expect(namespaceSelect.disabled).toBe(false);
      expect(namespaceSelect.value).toBe("default");
      expect(
        optionValues(namespaceSelect).filter(
          (value) => value !== "" && value !== "__custom__"
        )
      ).toEqual(["default"]);
      expect(fakeText(page.awsNamespaceNote)).toBe(
        "Can't list the namespaces in eks-2. Use default, or enter a custom namespace. Deploy creates the namespace if the cluster doesn't have it."
      );
    });

    it("clears the cluster and keeps Create blocked when the response marks it unusable", async () => {
      const page = renderDiscoveryPage();
      const discovery = scriptedDiscovery(page);
      discovery.answer(awsPayload({ clusters: TWO_CLUSTERS }));
      const createErrors: string[] = [];
      let handle: DiscoveryPanelHandle | null = null;
      handle = initializeDiscoveryPanel(page.browser.context, {
        mutationNonce: "",
        onInfrastructureChange: () => {
          createErrors.push(handle?.awsInfrastructureError() ?? "");
        }
      });
      await handle?.discoverResources("aws", ACCOUNT, REGION);
      discovery.answer(
        awsPayload({
          clusters: [
            awsCluster("eks-1"),
            awsCluster("eks-2", {
              status: "DELETING",
              usable: false,
              unusableReason: "status"
            })
          ]
        })
      );

      pickCluster(page, "eks-2");
      await flushPromises();

      const clusterSelect = page.selects["aws-cluster-select"];
      expect(clusterSelect.value).toBe("");
      const option = clusterSelect.options.find(
        (entry) => entry.value === "eks-2"
      );
      expect(option?.textContent).toBe("eks-2 (DELETING)");
      expect(option?.disabled).toBe(true);
      expect(fakeText(page.awsClusterNote)).toBe(
        "eks-2 is DELETING. Radius can use a cluster that is ACTIVE or UPDATING."
      );
      expect(handle?.currentInfraSelection("aws")).toMatchObject({
        cluster: "",
        subnetIds: ""
      });
      expect(createErrors.at(-1)).toBe("Select an EKS cluster.");
      expect(handle?.awsInfrastructureError()).toBe("Select an EKS cluster.");
    });

    it("keeps the cluster and Create open when only its namespaces can't be read", async () => {
      const { page, discovery, handle } = await discoverTwoClusters();
      discovery.answer(
        awsPayload({
          clusters: TWO_CLUSTERS,
          errors: { namespaces: "Forbidden" },
          errorKinds: { namespaces: "denied" }
        })
      );

      pickCluster(page, "eks-2");
      await flushPromises();

      expect(page.selects["aws-cluster-select"].value).toBe("eks-2");
      expect(page.awsNamespaceNote.hidden).toBe(false);
      expect(handle?.awsInfrastructureError()).toBe("");
    });

    it("hides a custom namespace typed for the previous cluster", async () => {
      const { page, discovery } = await discoverTwoClusters();
      discovery.answer(awsPayload({ clusters: TWO_CLUSTERS }));
      const namespaceSelect = page.selects["aws-namespace-select"];
      const custom = page.customs["aws-namespace-custom"];
      namespaceSelect.value = "__custom__";
      namespaceSelect.dispatch("change");
      custom.value = "team-x";
      expect(custom.style.display).toBe("");

      pickCluster(page, "eks-2");
      await flushPromises();

      expect(namespaceSelect.value).toBe("default");
      expect(custom.style.display).toBe("none");
    });

    it("drops the namespaces of a cluster that is no longer selected", async () => {
      const { page, discovery } = await discoverTwoClusters();
      const releaseFirst = discovery.hold();
      discovery.answer(
        awsPayload({
          clusters: TWO_CLUSTERS,
          namespaces: ["default", "team-1"]
        })
      );

      pickCluster(page, "eks-2");
      pickCluster(page, "eks-1");
      await flushPromises();
      releaseFirst(
        awsPayload({
          clusters: TWO_CLUSTERS,
          namespaces: ["default", "team-2"]
        })
      );
      await flushPromises();

      const values = optionValues(page.selects["aws-namespace-select"]);
      expect(values).toContain("team-1");
      expect(values).not.toContain("team-2");
    });

    it("drops the namespaces when a full discovery starts", async () => {
      const { page, discovery, handle } = await discoverTwoClusters();
      const releaseFirst = discovery.hold();
      discovery.answer(
        awsPayload({
          clusters: TWO_CLUSTERS,
          namespaces: ["default", "team-full"]
        })
      );

      pickCluster(page, "eks-2");
      await handle?.discoverResources("aws", ACCOUNT, REGION, {
        keepSelection: true
      });
      releaseFirst(
        awsPayload({
          clusters: TWO_CLUSTERS,
          namespaces: ["default", "team-stale"]
        })
      );
      await flushPromises();

      expect(discovery.requests[2]).toHaveProperty("cluster", "eks-2");
      const namespaceSelect = page.selects["aws-namespace-select"];
      const values = optionValues(namespaceSelect);
      expect(values).toContain("team-full");
      expect(values).not.toContain("team-stale");
      expect(namespaceSelect.disabled).toBe(false);
      expect(handle?.awsInfrastructureError()).toBe("");
    });
  });
});
