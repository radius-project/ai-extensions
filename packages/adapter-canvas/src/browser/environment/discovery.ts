// Canvas adapter — importable browser behavior for Azure/AWS resource
// discovery, the shared-app-identity pin, and the deploy-identity picker.
//
// Translated from the inline script previously carried as a string in
// pages/environment/client-discovery.ts. The deploy-button submission
// handler and the new/cancel-environment navigation embedded in that legacy
// file belong to the environments/deploying page and credentials modules, not
// here, and are intentionally not reproduced.

import {
  discoverStatusText,
  formatServesReposLabel,
  isUuid
} from "../../azure-oidc.js";
import { isDomOptionElement } from "../context.js";
import { beginEntry } from "../lifecycle.js";
import { isRecord, readArray, readString, readStringArray } from "../json.js";
import type { DiscoveryData } from "../../azure-oidc.js";
import type {
  BrowserContext,
  DomElement,
  DomOptionElement,
  DomSelectElement
} from "../ports.js";

export const DISCOVERY_PANEL_ENTRY_KEY = "environment-discovery-panel";
export const DISCOVER_ENDPOINT = "/api/discover";
export const LIST_APP_REGISTRATIONS_ENDPOINT =
  "/api/list-azure-app-registrations";
export const APP_SERVES_REPOS_ENDPOINT = "/api/azure-app-serves-repos";
export const SERVES_LABEL_CONCURRENCY = 6;
export const DEFAULT_NAMESPACES: readonly string[] = [
  "default",
  "kube-system",
  "radius-system"
];

export const COMBO_PAIRS: readonly (readonly [string, string])[] = [
  ["azure-cluster-select", "azure-cluster-custom"],
  ["azure-rg-select", "azure-rg-custom"],
  ["azure-namespace-select", "azure-namespace-custom"],
  ["aws-cluster-select", "aws-cluster-custom"],
  ["aws-namespace-select", "aws-namespace-custom"],
  ["aws-vpc-select", "aws-vpc-custom"],
  ["aws-subnets-select", "aws-subnets-custom"]
];

const NONE_OPTION: DiscoveryOption = { id: "", name: "None (optional)" };

export interface DiscoveryOption {
  readonly id: string;
  readonly name: string;
  readonly resourceGroup?: string;
}

export interface AppRegistrationCandidate {
  readonly appId: string;
  readonly displayName?: string;
  readonly createdDateTime?: string;
  readonly servesRepos?: readonly string[];
}

export interface AppPickerOptions {
  readonly title?: string;
  readonly intro?: string;
  readonly caution?: string;
  readonly candidates: readonly AppRegistrationCandidate[];
  readonly defaultAppId?: string;
  readonly allowCreateNew?: boolean;
}

export type AppPickerChoice =
  { readonly appId: string } | { readonly createNew: true };

export interface AbandonedOperationError extends Error {
  readonly abandonOperation: true;
}

export interface DiscoveryPanelHandle {
  clearSharedAppPin(): void;
  promptServiceManagementReference(): Promise<string>;
  promptAppSelection(options: AppPickerOptions): Promise<AppPickerChoice>;
  discoverResources(
    provider: "azure" | "aws",
    subscriptionId: string,
    tenantId: string
  ): Promise<void>;
  getComboValue(selectId: string, customId: string): string;
  findAzureClusterResourceGroup(clusterId: string): string;
  setPendingInfraSelection(config: EnvironmentInfrastructure | null): void;
  currentInfraSelection(provider: "azure" | "aws"): EnvironmentInfrastructure;
  teardown(): void;
}

export interface EnvironmentInfrastructure {
  readonly resourceGroup?: string;
  readonly cluster?: string;
  readonly namespace?: string;
  readonly vpcId?: string;
  readonly subnetIds?: string;
}

export function abandonedOperationError(
  message: string
): AbandonedOperationError {
  return Object.assign(new Error(message), { abandonOperation: true as const });
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error)) {
    const message = readString(error, "message");
    if (message !== "") return message;
  }
  return String(error);
}

function optionalString(value: unknown, key: string): string | undefined {
  const text = readString(value, key);
  return text === "" ? undefined : text;
}

function parseDiscoveryOption(item: unknown): DiscoveryOption | null {
  if (typeof item === "string")
    return item === "" ? null : { id: item, name: item };
  if (typeof item === "number" || typeof item === "boolean") {
    const text = String(item);
    return { id: text, name: text };
  }
  if (!isRecord(item)) return null;
  const id = readString(item, "id");
  const name = readString(item, "name");
  if (id === "" && name === "") return null;
  return {
    id: id || name,
    name: name || id,
    resourceGroup: optionalString(item, "resourceGroup")
  };
}

export function parseDiscoveryOptions(
  items: readonly unknown[]
): DiscoveryOption[] {
  const options: DiscoveryOption[] = [];
  for (const item of items) {
    const option = parseDiscoveryOption(item);
    if (option) options.push(option);
  }
  return options;
}

// Case-insensitive sort by display name so discovered resource lists render in
// a predictable order in the dropdowns.
export function sortDiscoveryOptions(
  options: readonly DiscoveryOption[]
): DiscoveryOption[] {
  return [...options].sort((left, right) => {
    const leftName = left.name.toLowerCase();
    const rightName = right.name.toLowerCase();
    return (
      leftName < rightName ? -1
      : leftName > rightName ? 1
      : 0
    );
  });
}

// `data.namespaces || fallback` in the legacy client only applies the default
// list when the key is missing/non-array; an explicit empty array is kept.
// readArray alone cannot distinguish those two cases (both return []).
function readArrayOrDefault(
  value: unknown,
  key: string,
  fallback: readonly unknown[]
): unknown[] {
  if (!isRecord(value)) return [...fallback];
  const member = value[key];
  return Array.isArray(member) ? member : [...fallback];
}

function toDiscoveryData(payload: unknown): DiscoveryData {
  if (!isRecord(payload)) return {};
  const errorsRaw = payload.errors;
  const errors: Record<string, string> = {};
  if (isRecord(errorsRaw)) {
    for (const [key, value] of Object.entries(errorsRaw)) {
      if (typeof value === "string") errors[key] = value;
    }
  }
  return {
    clusters: readArray(payload, "clusters"),
    resourceGroups: readArray(payload, "resourceGroups"),
    vpcs: readArray(payload, "vpcs"),
    subnets: readArray(payload, "subnets"),
    error: optionalString(payload, "error"),
    errors
  };
}

function renderSelectOptions(
  context: BrowserContext,
  select: DomSelectElement,
  items: readonly DiscoveryOption[],
  placeholder: string
): void {
  const optionElements: DomOptionElement[] = [];
  if (items.length === 0) {
    const empty = context.dom.createOption({
      value: "",
      label: "No resources found",
      selected: true
    });
    empty.setAttribute("disabled", "true");
    optionElements.push(empty);
  } else {
    const placeholderOption = context.dom.createOption({
      value: "",
      label: placeholder,
      selected: true
    });
    placeholderOption.setAttribute("disabled", "true");
    optionElements.push(placeholderOption);
    for (const item of items) {
      optionElements.push(
        context.dom.createOption({ value: item.id, label: item.name })
      );
    }
  }
  optionElements.push(
    context.dom.createOption({
      value: "__custom__",
      label: "+ Enter custom..."
    })
  );
  select.replaceChildren(...optionElements);
}

function renderSelect(
  context: BrowserContext,
  selectId: string,
  items: readonly DiscoveryOption[],
  placeholder: string
): void {
  const select = context.dom.selectById(selectId);
  if (!select) return;
  renderSelectOptions(context, select, items, placeholder);
}

function selectOfferedValue(
  context: BrowserContext,
  selectId: string,
  value: string
): boolean {
  const select = context.dom.selectById(selectId);
  if (!select) return false;
  for (const option of Array.from(select.options)) {
    if (option.value !== value) continue;
    select.value = value;
    return true;
  }
  return false;
}

// Populate the AKS cluster dropdown from a (possibly RG-filtered) list, keeping
// the current selection when it is still present in the new list.
function renderAzureClusters(
  context: BrowserContext,
  list: readonly DiscoveryOption[],
  keepValue: string
): void {
  const select = context.dom.selectById("azure-cluster-select");
  if (!select) return;
  renderSelectOptions(context, select, list, "Select AKS cluster…");
  if (keepValue === "") {
    if (list.length === 1) select.value = list[0].id;
    return;
  }
  // Both callers pass a non-empty value only after confirming it is present in
  // the list being rendered, so no second membership branch is needed here.
  select.value = keepValue;
}

function backfillResourceGroupOption(
  context: BrowserContext,
  rgSelect: DomSelectElement,
  resourceGroup: string
): void {
  const existing = Array.from(rgSelect.querySelectorAll("option")).filter(
    isDomOptionElement
  );
  const hasRg = existing.some((option) => option.value === resourceGroup);
  if (!hasRg) {
    const customIndex = existing.findIndex(
      (option) => option.value === "__custom__"
    );
    const newOption = context.dom.createOption({
      value: resourceGroup,
      label: resourceGroup
    });
    const rebuilt = [...existing];
    if (customIndex >= 0) rebuilt.splice(customIndex, 0, newOption);
    else rebuilt.push(newOption);
    rgSelect.replaceChildren(...rebuilt);
  }
  rgSelect.value = resourceGroup;
}

function isAppRegistrationRecord(
  value: unknown
): value is Record<string, unknown> {
  return isRecord(value) && readString(value, "appId") !== "";
}

function toAppRegistrationCandidate(
  value: Record<string, unknown>
): AppRegistrationCandidate {
  return {
    appId: readString(value, "appId"),
    displayName: optionalString(value, "displayName"),
    createdDateTime: optionalString(value, "createdDateTime"),
    servesRepos: readStringArray(value, "servesRepos")
  };
}

// Prompt for a Service Management Reference (GUID) via the shared modal;
// resolves the entered GUID or rejects with an abandon-tagged error when the
// user cancels.
export function promptSmr(context: BrowserContext): Promise<string> {
  const modal = context.dom.byId("env-smr-modal");
  const input = context.dom.inputById("env-smr-input");
  const errEl = context.dom.byId("env-smr-error");
  const retryBtn = context.dom.inputById("env-smr-retry");
  const cancelBtn = context.dom.inputById("env-smr-cancel");
  if (!modal || !input || !errEl || !retryBtn || !cancelBtn) {
    return Promise.reject(
      abandonedOperationError(
        "Service Management Reference is required to continue."
      )
    );
  }
  input.value = "";
  errEl.style.display = "none";
  modal.style.display = "flex";
  context.focus.focus(input);
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      modal.style.display = "none";
      retryBtn.removeEventListener("click", onRetry);
      cancelBtn.removeEventListener("click", onCancel);
    };
    const onRetry = (): void => {
      const smr = input.value.trim();
      if (!isUuid(smr)) {
        errEl.textContent = "Enter a valid GUID.";
        errEl.style.display = "block";
        return;
      }
      cleanup();
      resolve(smr);
    };
    const onCancel = (): void => {
      cleanup();
      reject(
        abandonedOperationError(
          "Service Management Reference is required to continue."
        )
      );
    };
    retryBtn.addEventListener("click", onRetry);
    cancelBtn.addEventListener("click", onCancel);
  });
}

// Renders the identity picker. Resolves with {appId} or {createNew:true};
// rejects with an abandon-tagged error on cancel.
export function showAppPicker(
  context: BrowserContext,
  options: AppPickerOptions & { readonly allowCreateNew: false }
): Promise<{ readonly appId: string }>;
export function showAppPicker(
  context: BrowserContext,
  options: AppPickerOptions
): Promise<AppPickerChoice>;
export function showAppPicker(
  context: BrowserContext,
  options: AppPickerOptions
): Promise<AppPickerChoice> {
  const modal = context.dom.byId("env-appselect-modal");
  const titleEl = context.dom.byId("env-appselect-title");
  const introEl = context.dom.byId("env-appselect-intro");
  const cautionEl = context.dom.byId("env-appselect-caution");
  const listEl = context.dom.byId("env-appselect-list");
  const errEl = context.dom.byId("env-appselect-error");
  const confirmBtn = context.dom.inputById("env-appselect-confirm");
  const cancelBtn = context.dom.inputById("env-appselect-cancel");
  if (
    !modal ||
    !titleEl ||
    !introEl ||
    !cautionEl ||
    !listEl ||
    !errEl ||
    !confirmBtn ||
    !cancelBtn
  ) {
    return Promise.reject(
      abandonedOperationError("Identity selection cancelled.")
    );
  }

  titleEl.textContent = options.title ?? "Choose a deploy identity";
  introEl.textContent = options.intro ?? "";
  if (options.caution) {
    cautionEl.textContent = options.caution;
    cautionEl.style.display = "block";
  } else {
    cautionEl.style.display = "none";
  }
  errEl.style.display = "none";
  listEl.replaceChildren();

  const candidates = options.candidates;
  let chosenValue = options.defaultAppId || candidates[0]?.appId || "";
  // appId -> row body element still awaiting its lazy "Serves:" label.
  const servesSlots = new Map<string, DomElement>();

  const appendServes = (bodyEl: DomElement, text: string): void => {
    const line3 = context.dom.createElement("div");
    line3.setAttribute(
      "style",
      "font-size:11px; color:var(--rad-info,#0969da); margin-top:2px; word-break:break-all;"
    );
    line3.textContent = text;
    bodyEl.appendChild(line3);
  };

  const row = (
    value: string,
    primary: string,
    secondary: string,
    serves: readonly string[] | undefined
  ): void => {
    const id = `appsel-${value || "create"}`;
    const label = context.dom.createElement("label");
    label.setAttribute("for", id);
    label.setAttribute(
      "style",
      "display:flex; gap:10px; align-items:flex-start; padding:8px 10px; border:1px solid var(--rad-stroke); border-radius:8px; cursor:pointer;"
    );
    const radio = context.dom.createElement("input");
    radio.id = id;
    radio.setAttribute("type", "radio");
    radio.setAttribute("name", "appsel");
    radio.setAttribute("value", value);
    radio.style.marginTop = "2px";
    if (value === chosenValue) radio.setAttribute("checked", "checked");
    radio.addEventListener("change", () => {
      chosenValue = value;
    });
    const body = context.dom.createElement("div");
    const line1 = context.dom.createElement("div");
    line1.setAttribute(
      "style",
      "font-size:13px; font-weight:600; color:var(--rad-text); word-break:break-all;"
    );
    line1.textContent = primary;
    body.appendChild(line1);
    if (secondary !== "") {
      const line2 = context.dom.createElement("div");
      line2.setAttribute(
        "style",
        "font-size:11px; color:var(--rad-text-tertiary); margin-top:2px; word-break:break-all;"
      );
      line2.textContent = secondary;
      body.appendChild(line2);
    }
    const servesText = formatServesReposLabel(serves ?? null);
    if (servesText !== "") {
      appendServes(body, servesText);
    } else if (value !== "" && value !== "__create__") {
      // No server-provided label: remember the row so it can be filled lazily
      // once /api/azure-app-serves-repos resolves for this app.
      servesSlots.set(value, body);
    }
    label.appendChild(radio);
    label.appendChild(body);
    listEl.appendChild(label);
  };

  for (const candidate of candidates) {
    const created =
      candidate.createdDateTime ?
        `created ${candidate.createdDateTime.slice(0, 10)} · `
      : "";
    row(
      candidate.appId,
      candidate.displayName || candidate.appId,
      `${created}${candidate.appId}`,
      candidate.servesRepos
    );
  }
  if (options.allowCreateNew) {
    row(
      "__create__",
      "Create a new application instead",
      "A fresh per-repo deploy identity that only this repository can use.",
      undefined
    );
    if (chosenValue === "") chosenValue = "__create__";
  }

  // Lazy-load the per-app "Serves:" labels so the picker renders immediately
  // instead of blocking on one az federated-credential list per owned app.
  // Bounded concurrency; each label is best-effort and skipped on failure or
  // if its row was replaced by a later picker (detected via .parentNode, this
  // port's substitute for .isConnected).
  (() => {
    const pending = [...servesSlots.keys()];
    if (pending.length === 0) return;
    let pos = 0;
    const pump = (): void => {
      if (pos >= pending.length) return;
      const appId = pending[pos];
      pos += 1;
      const bodyEl = servesSlots.get(appId);
      void context.net
        .fetch(
          `${APP_SERVES_REPOS_ENDPOINT}?appId=${encodeURIComponent(appId)}`
        )
        .then((response) => response.json())
        .then((data) => {
          const text = formatServesReposLabel(
            readStringArray(data, "servesRepos")
          );
          if (text !== "" && bodyEl && bodyEl.parentNode !== null) {
            appendServes(bodyEl, text);
          }
        })
        .catch(() => {
          /* label is best-effort */
        })
        .then(() => pump());
    };
    for (
      let i = 0;
      i < Math.min(SERVES_LABEL_CONCURRENCY, pending.length);
      i += 1
    )
      pump();
  })();

  modal.style.display = "flex";
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      modal.style.display = "none";
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
    };
    const onConfirm = (): void => {
      if (chosenValue === "") {
        errEl.textContent =
          "Select an application or choose to create a new one.";
        errEl.style.display = "block";
        return;
      }
      cleanup();
      if (chosenValue === "__create__") resolve({ createNew: true });
      else resolve({ appId: chosenValue });
    };
    const onCancel = (): void => {
      cleanup();
      reject(abandonedOperationError("Identity selection cancelled."));
    };
    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
  });
}

export function initializeDiscoveryPanel(
  context: BrowserContext
): DiscoveryPanelHandle | null {
  const scope = beginEntry(context, DISCOVERY_PANEL_ENTRY_KEY);
  if (!scope) return null;

  let azureClusters: DiscoveryOption[] = [];
  let azureFilterWired = false;
  let azureInFlight = false;
  let awsInFlight = false;
  let pendingInfrastructure: EnvironmentInfrastructure | null = null;

  // Shared-identity pin helpers. The pin (az-selected-app-id) makes this repo
  // reuse another app's identity — deliberately wider blast radius, so it
  // must be cleared on any fresh form or context change and be explicitly
  // reversible.
  const clearSharedAppPin = (): void => {
    const hiddenId = context.dom.inputById("az-selected-app-id");
    if (hiddenId) hiddenId.value = "";
    const note = context.dom.byId("az-selected-app-note");
    if (note) {
      note.style.display = "none";
      note.textContent = "";
    }
    const clearLink = context.dom.byId("az-clear-pin-link");
    if (clearLink) clearLink.style.display = "none";
    const nameEl = context.dom.inputById("az-app-name-input");
    if (nameEl) {
      nameEl.value = nameEl.getAttribute("data-default-name") ?? "";
      nameEl.disabled = false;
      nameEl.classList.remove("rad-input--dimmed");
    }
  };

  const pinClearLink = context.dom.byId("az-clear-pin-link");
  if (pinClearLink) {
    scope.on(pinClearLink, "click", (event) => {
      event.preventDefault();
      clearSharedAppPin();
    });
  }

  const useExistingLink = context.dom.byId("az-use-existing-link");
  if (useExistingLink) {
    scope.on(useExistingLink, "click", (event) => {
      event.preventDefault();
      void useExistingApplication(useExistingLink);
    });
  }

  const useExistingApplication = async (link: DomElement): Promise<void> => {
    const note = context.dom.byId("az-selected-app-note");
    link.textContent = "Loading applications…";
    try {
      const response = await context.net.fetch(LIST_APP_REGISTRATIONS_ENDPOINT);
      const payload = await response.json();
      link.textContent = "Use an existing application…";
      const errorMessage = readString(payload, "error");
      if (errorMessage !== "") {
        if (note) {
          note.style.display = "block";
          note.style.color = "var(--rad-danger,#cf222e)";
          note.textContent = `Could not list applications: ${errorMessage}`;
        }
        return;
      }
      const candidates = readArray(payload, "apps")
        .filter(isAppRegistrationRecord)
        .map(toAppRegistrationCandidate);
      if (candidates.length === 0) {
        if (note) {
          note.style.display = "block";
          note.style.color = "var(--rad-danger,#cf222e)";
          note.textContent =
            "You do not own any App Registrations yet — create one instead.";
        }
        return;
      }
      let choice: AppPickerChoice;
      try {
        choice = await showAppPicker(context, {
          title: "Use an existing application",
          intro:
            "Select an App Registration you already own to reuse as this repository\u2019s deploy identity.",
          caution:
            "Sharing one identity across repositories means every wired repository can use its Azure permissions. Only do this for repos that belong to the same product.",
          candidates,
          defaultAppId: "",
          allowCreateNew: false
        });
      } catch {
        return; // cancelled
      }
      const hiddenId = context.dom.inputById("az-selected-app-id");
      if (hiddenId && choice.appId) hiddenId.value = choice.appId;
      const picked = candidates.find(
        (candidate) => candidate.appId === choice.appId
      );
      if (note) {
        note.style.display = "block";
        note.style.color = "var(--rad-info,#0969da)";
        note.textContent = `Will reuse: ${(picked && picked.displayName) || choice.appId} (${choice.appId}).`;
      }
      const clearLink = context.dom.byId("az-clear-pin-link");
      if (clearLink) clearLink.style.display = "inline";
      const nameEl = context.dom.inputById("az-app-name-input");
      if (nameEl) {
        nameEl.value = (picked && picked.displayName) || choice.appId;
        nameEl.disabled = true;
      }
    } catch (error) {
      link.textContent = "Use an existing application…";
      if (note) {
        note.style.display = "block";
        note.style.color = "var(--rad-danger,#cf222e)";
        note.textContent = `Could not list applications: ${errorMessageOf(error)}`;
      }
    }
  };

  // Combo select: reveal a custom input when "__custom__" is chosen.
  for (const [selectId, customId] of COMBO_PAIRS) {
    const select = context.dom.selectById(selectId);
    const input = context.dom.inputById(customId);
    if (!select || !input) continue;
    scope.on(select, "change", () => {
      const isCustom = select.value === "__custom__";
      input.style.display = isCustom ? "" : "none";
      if (isCustom) context.focus.focus(input);
    });
  }

  const findAzureClusterResourceGroup = (clusterId: string): string => {
    const cluster = azureClusters.find((item) => item.id === clusterId);
    return cluster?.resourceGroup ?? "";
  };

  const wireAzureInfraFilter = (): void => {
    if (azureFilterWired) return;
    const clusterSelect = context.dom.selectById("azure-cluster-select");
    const rgSelect = context.dom.selectById("azure-rg-select");
    if (!clusterSelect || !rgSelect) return;
    azureFilterWired = true;
    // Selecting a resource group limits the cluster dropdown to the AKS
    // clusters that live in that resource group. A custom-typed or empty RG
    // shows them all.
    scope.on(rgSelect, "change", () => {
      const rg = rgSelect.value;
      if (rg === "" || rg === "__custom__") {
        renderAzureClusters(context, azureClusters, clusterSelect.value);
        return;
      }
      const filtered = azureClusters.filter(
        (cluster) => (cluster.resourceGroup ?? "") === rg
      );
      const keep =
        filtered.some((cluster) => cluster.id === clusterSelect.value) ?
          clusterSelect.value
        : "";
      renderAzureClusters(context, filtered, keep);
    });
    // Selecting a cluster back-fills its resource group so the two stay
    // linked.
    scope.on(clusterSelect, "change", () => {
      const clusterId = clusterSelect.value;
      if (clusterId === "__custom__" || clusterId === "") return;
      const cluster = azureClusters.find((item) => item.id === clusterId);
      if (!cluster || !cluster.resourceGroup) return;
      backfillResourceGroupOption(context, rgSelect, cluster.resourceGroup);
    });
  };

  const discoverResources = async (
    provider: "azure" | "aws",
    subscriptionId: string,
    tenantId: string
  ): Promise<void> => {
    if (provider === "azure" ? azureInFlight : awsInFlight) return;
    if (provider === "azure") azureInFlight = true;
    else awsInFlight = true;
    const refreshButton = context.dom.inputById(
      provider === "azure" ? "azure-refresh-btn" : "aws-refresh-btn"
    );
    if (refreshButton) refreshButton.disabled = true;
    const isStale = (): boolean => !scope.active;
    const statusEl = context.dom.byId(
      provider === "azure" ? "azure-discover-status" : "aws-discover-status"
    );
    if (statusEl) statusEl.textContent = "Discovering resources…";
    const payload: Record<string, string> = { provider };
    if (subscriptionId !== "") payload.subscriptionId = subscriptionId;
    if (tenantId !== "") payload.tenantId = tenantId;
    try {
      const response = await context.net.fetch(DISCOVER_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const raw = await response.json();
      if (isStale()) return;
      const data = toDiscoveryData(raw);
      if (provider === "azure") {
        if (statusEl) statusEl.textContent = discoverStatusText(data, "azure");
        azureClusters = sortDiscoveryOptions(
          parseDiscoveryOptions(readArray(raw, "clusters"))
        );
        renderAzureClusters(context, azureClusters, "");
        renderSelect(
          context,
          "azure-rg-select",
          sortDiscoveryOptions(
            parseDiscoveryOptions(readArray(raw, "resourceGroups"))
          ),
          "Select resource group…"
        );
        renderSelect(
          context,
          "azure-namespace-select",
          sortDiscoveryOptions(
            parseDiscoveryOptions(
              readArrayOrDefault(raw, "namespaces", DEFAULT_NAMESPACES)
            )
          ),
          "Select namespace…"
        );
        selectOfferedValue(context, "azure-namespace-select", "default");
        wireAzureInfraFilter();
      } else {
        if (statusEl) statusEl.textContent = discoverStatusText(data, "aws");
        const awsClusters = sortDiscoveryOptions(
          parseDiscoveryOptions(readArray(raw, "clusters"))
        );
        renderSelect(
          context,
          "aws-cluster-select",
          awsClusters,
          "Select EKS cluster…"
        );
        if (awsClusters.length === 1) {
          selectOfferedValue(context, "aws-cluster-select", awsClusters[0].id);
        }
        renderSelect(
          context,
          "aws-namespace-select",
          sortDiscoveryOptions(
            parseDiscoveryOptions(
              readArrayOrDefault(raw, "namespaces", DEFAULT_NAMESPACES)
            )
          ),
          "Select namespace…"
        );
        selectOfferedValue(context, "aws-namespace-select", "default");
        renderSelect(
          context,
          "aws-vpc-select",
          [NONE_OPTION, ...parseDiscoveryOptions(readArray(raw, "vpcs"))],
          "Select VPC…"
        );
        renderSelect(
          context,
          "aws-subnets-select",
          [NONE_OPTION, ...parseDiscoveryOptions(readArray(raw, "subnets"))],
          "Select subnets…"
        );
      }
      applyPendingInfrastructure(provider);
    } catch (error) {
      if (isStale()) return;
      if (statusEl)
        statusEl.textContent = `Discovery error: ${errorMessageOf(error)}`;
    } finally {
      if (provider === "azure") azureInFlight = false;
      else awsInFlight = false;
      if (scope.active && refreshButton) refreshButton.disabled = false;
    }
  };

  const getComboValue = (selectId: string, customId: string): string => {
    const select = context.dom.selectById(selectId);
    if (!select) return "";
    if (select.value === "__custom__") {
      const custom = context.dom.inputById(customId);
      return custom ? custom.value : "";
    }
    return select.value;
  };

  const restoreInfrastructureValue = (
    selectId: string,
    customId: string,
    value: string
  ): void => {
    if (value === "" || selectOfferedValue(context, selectId, value)) return;
    const custom = context.dom.inputById(customId);
    if (!custom || !selectOfferedValue(context, selectId, "__custom__")) return;
    custom.value = value;
    custom.style.display = "";
  };

  const applyPendingInfrastructure = (provider: "azure" | "aws"): void => {
    const config = pendingInfrastructure;
    if (!config) return;
    pendingInfrastructure = null;
    if (provider === "azure") {
      restoreInfrastructureValue(
        "azure-rg-select",
        "azure-rg-custom",
        config.resourceGroup ?? ""
      );
      restoreInfrastructureValue(
        "azure-cluster-select",
        "azure-cluster-custom",
        config.cluster ?? ""
      );
      restoreInfrastructureValue(
        "azure-namespace-select",
        "azure-namespace-custom",
        config.namespace ?? ""
      );
      return;
    }
    restoreInfrastructureValue(
      "aws-cluster-select",
      "aws-cluster-custom",
      config.cluster ?? ""
    );
    restoreInfrastructureValue(
      "aws-namespace-select",
      "aws-namespace-custom",
      config.namespace ?? ""
    );
    restoreInfrastructureValue(
      "aws-vpc-select",
      "aws-vpc-custom",
      config.vpcId ?? ""
    );
    restoreInfrastructureValue(
      "aws-subnets-select",
      "aws-subnets-custom",
      config.subnetIds ?? ""
    );
  };

  return {
    clearSharedAppPin,
    promptServiceManagementReference: () => promptSmr(context),
    promptAppSelection: (options) => showAppPicker(context, options),
    discoverResources,
    getComboValue,
    findAzureClusterResourceGroup,
    setPendingInfraSelection(config) {
      pendingInfrastructure = config;
    },
    currentInfraSelection(provider) {
      return provider === "aws" ?
          {
            cluster: getComboValue("aws-cluster-select", "aws-cluster-custom"),
            namespace: getComboValue(
              "aws-namespace-select",
              "aws-namespace-custom"
            ),
            vpcId: getComboValue("aws-vpc-select", "aws-vpc-custom"),
            subnetIds: getComboValue("aws-subnets-select", "aws-subnets-custom")
          }
        : {
            resourceGroup: getComboValue("azure-rg-select", "azure-rg-custom"),
            cluster: getComboValue(
              "azure-cluster-select",
              "azure-cluster-custom"
            ),
            namespace: getComboValue(
              "azure-namespace-select",
              "azure-namespace-custom"
            )
          };
    },
    teardown() {
      scope.teardown();
    }
  };
}
