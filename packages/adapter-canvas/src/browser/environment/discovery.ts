// Canvas adapter — importable browser behavior for Azure/AWS resource
// discovery, the shared-app-identity pin, and the deploy-identity picker.
//
// Translated from the inline script previously carried as a string in
// pages/environment/client-discovery.ts. The deploy-button submission
// handler and the new/cancel-environment navigation embedded in that legacy
// file belong to the environments/deploying page and credentials modules, not
// here, and are intentionally not reproduced.

import { isEksClusterName } from "@radius-project/core/platforms";
import { remediationView } from "@radius-project/core/remediations";
import {
  discoverStatusText,
  formatServesReposLabel,
  isUuid
} from "../../azure-oidc.js";
import { remediationReference } from "../../remediation-reference.js";
import { createCommandAction } from "../command-action.js";
import {
  AWS_CLUSTER_SELECT_ID,
  AWS_NAMESPACE_NOTE_ID,
  awsClusterPresentation,
  awsMissingClusterNoteLine,
  awsNamespaceFallbackNote,
  initializeAwsInfrastructure,
  parseAwsClusterInfo,
  parseAwsSubnetInfo,
  parseAwsVpcInfo,
  readAwsErrorKinds,
  type AwsClusterInfo,
  type AwsClusterNoteLine
} from "./aws-infrastructure.js";
import { beginEntry } from "../lifecycle.js";
import { isRecord, readArray, readString, readStringArray } from "../json.js";
import type { DiscoveryData } from "../../azure-oidc.js";
import type { CommandActionHandle } from "../command-action.js";
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
export const DEFAULT_NAMESPACES: readonly string[] = ["default"];

export const COMBO_PAIRS: readonly (readonly [string, string])[] = [
  ["azure-namespace-select", "azure-namespace-custom"],
  ["aws-namespace-select", "aws-namespace-custom"]
];

export interface DiscoveryOption {
  readonly id: string;
  readonly name: string;
  readonly resourceGroup?: string;
  // Listed but not selectable, such as an EKS cluster Radius can't use.
  readonly disabled?: boolean;
}

export interface DiscoverResourcesOptions {
  // Hold the AWS cluster, namespace, and subnets on screen across this
  // discovery, as Refresh does, instead of showing the defaults.
  readonly keepSelection?: boolean;
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
  // False when candidates already carry their served repositories, so the
  // picker must not look them up as Azure app registrations.
  readonly lazyServes?: boolean;
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
    tenantId: string,
    options?: DiscoverResourcesOptions
  ): Promise<void>;
  findAzureClusterResourceGroup(clusterId: string): string;
  setPendingInfraSelection(
    config: EnvironmentInfrastructure | null,
    provider: "azure" | "aws"
  ): void;
  currentInfraSelection(provider: "azure" | "aws"): EnvironmentInfrastructure;
  // Hold the selection across a subtab switch, so the next discovery restores
  // it. An AWS selection that no discovery has restored yet stays held for the
  // account and region it belongs to. Otherwise the selection on screen is held.
  preserveInfraSelection(provider: "azure" | "aws"): void;
  // The AWS subnet, cluster, or namespace-read problem that keeps Create
  // Environment disabled.
  awsInfrastructureError(): string;
  teardown(): void;
}

export interface DiscoveryPanelOptions {
  readonly mutationNonce: string;
  readonly onInfrastructureChange?: () => void;
}

// A saved or refreshed AWS selection. Discovery keeps it until a response can
// restore it, so a failed discovery doesn't lose it. `scope` is the account and
// region it belongs to, or null until a discovery claims it.
interface HeldAwsSelection {
  config: EnvironmentInfrastructure;
  scope: string | null;
}

const MISSING_MUTATION_NONCE_REASON =
  "Reload the Radius canvas before asking Copilot to run this command.";

export interface EnvironmentInfrastructure {
  readonly resourceGroup?: string;
  readonly cluster?: string;
  readonly namespace?: string;
  readonly vpcId?: string;
  readonly subnetIds?: string;
  // The cloud account a cluster name is scoped to. A cluster name alone is not
  // a cluster: the same name can exist in two Azure subscriptions or two AWS
  // account/region pairs. Carried so the wizard's duplicate-namespace check
  // compares the same identity the server's admission rung does, and cannot
  // refuse an environment the server would admit.
  readonly subscriptionId?: string;
  readonly accountId?: string;
  readonly region?: string;
  // The resource group the AKS cluster lives in, which scopes its name within
  // the subscription. Separate from `resourceGroup`, which is where the
  // application deploys.
  readonly clusterResourceGroup?: string;
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
export function sortDiscoveryOptions<T extends DiscoveryOption>(
  options: readonly T[]
): T[] {
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

function readStringRecord(value: unknown): Record<string, string> {
  const record: Record<string, string> = {};
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "string") record[key] = entry;
    }
  }
  return record;
}

function toDiscoveryData(payload: unknown): DiscoveryData {
  if (!isRecord(payload)) return {};
  return {
    clusters: readArray(payload, "clusters"),
    resourceGroups: readArray(payload, "resourceGroups"),
    vpcs: readArray(payload, "vpcs"),
    subnets: readArray(payload, "subnets"),
    error: optionalString(payload, "error"),
    errors: readStringRecord(payload.errors),
    errorKinds: readAwsErrorKinds(payload.errorKinds)
  };
}

function renderSelectOptions(
  context: BrowserContext,
  select: DomSelectElement,
  items: readonly DiscoveryOption[],
  placeholder: string,
  allowCustom = true,
  emptyLabel = "No resources found"
): void {
  const optionElements: DomOptionElement[] = [];
  if (items.length === 0) {
    const empty = context.dom.createOption({
      value: "",
      label: emptyLabel,
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
      const option = context.dom.createOption({
        value: item.id,
        label: item.name
      });
      if (item.disabled === true) option.setAttribute("disabled", "true");
      optionElements.push(option);
    }
  }
  if (allowCustom) {
    optionElements.push(
      context.dom.createOption({
        value: "__custom__",
        label: "+ Enter custom..."
      })
    );
  }
  select.replaceChildren(...optionElements);
}

function renderSelect(
  context: BrowserContext,
  selectId: string,
  items: readonly DiscoveryOption[],
  placeholder: string,
  allowCustom = true,
  emptyLabel?: string
): void {
  const select = context.dom.selectById(selectId);
  if (!select) return;
  renderSelectOptions(
    context,
    select,
    items,
    placeholder,
    allowCustom,
    emptyLabel
  );
}

function renderSelectLoading(
  context: BrowserContext,
  select: DomSelectElement,
  label: string
): void {
  const loading = context.dom.createOption({
    value: "",
    label,
    selected: true
  });
  loading.setAttribute("disabled", "true");
  select.replaceChildren(loading);
  select.disabled = true;
}

function selectOfferedValue(
  context: BrowserContext,
  selectId: string,
  value: string
): boolean {
  const select = context.dom.selectById(selectId);
  if (!select) return false;
  for (const option of Array.from(select.options)) {
    if (option.value !== value || option.disabled === true) continue;
    select.value = value;
    return true;
  }
  return false;
}

function renderAwsClusterNote(
  context: BrowserContext,
  lines: readonly AwsClusterNoteLine[]
): void {
  const note = context.dom.byId("aws-cluster-note");
  if (!note) return;
  note.replaceChildren();
  for (const line of lines) {
    const row = context.dom.createElement("div");
    const text = context.dom.createElement("span");
    text.textContent = line.text;
    row.appendChild(text);
    if (line.command !== undefined) {
      const command = context.dom.createElement("code");
      command.setAttribute(
        "style",
        "display:block; margin:2px 0 4px; user-select:all; overflow-wrap:anywhere;"
      );
      command.textContent = line.command;
      row.appendChild(command);
    }
    note.appendChild(row);
  }
  note.hidden = lines.length === 0;
}

function renderAwsNamespaceNote(context: BrowserContext, text: string): void {
  const note = context.dom.byId(AWS_NAMESPACE_NOTE_ID);
  if (!note) return;
  note.textContent = text;
  note.hidden = text === "";
}

// Populate the AKS cluster dropdown from a (possibly RG-filtered) list, keeping
// the current selection when it is still present in the new list.
function renderAzureClusters(
  context: BrowserContext,
  list: readonly DiscoveryOption[],
  keepValue: string,
  allowAutoSelect = true
): void {
  const select = context.dom.selectById("azure-cluster-select");
  if (!select) return;
  renderSelectOptions(context, select, list, "Select AKS cluster…", false);
  if (keepValue !== "") {
    // Both callers pass a non-empty value only after confirming it is present
    // in the list, so no second membership branch is needed here.
    select.value = keepValue;
  } else if (allowAutoSelect && list.length === 1) {
    select.value = list[0].id;
  }
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
    } else if (
      options.lazyServes !== false &&
      value !== "" &&
      value !== "__create__"
    ) {
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
  context: BrowserContext,
  options: DiscoveryPanelOptions = { mutationNonce: "" }
): DiscoveryPanelHandle | null {
  const scope = beginEntry(context, DISCOVERY_PANEL_ENTRY_KEY);
  if (!scope) return null;

  const awsInfrastructure = initializeAwsInfrastructure(context, scope, () =>
    options.onInfrastructureChange?.()
  );
  let awsClusterInfo: ReturnType<typeof parseAwsClusterInfo> = [];
  let azureClusters: DiscoveryOption[] = [];
  let renderedAzureClusters = new Map<string, DiscoveryOption>();
  let azureFilterWired = false;
  // Discovery is de-duplicated by request identity, not merely by provider.
  // Two requests are the same question only when they target the same provider
  // *and* the same account, so re-selecting the running profile is suppressed
  // while switching to a different account supersedes the outstanding request.
  // `token` is the per-provider sequence number: only the newest request may
  // render results or re-enable Refresh, which drops a superseded response
  // instead of letting it overwrite the newer account's resource list.
  const discoveryRequests: Record<
    "azure" | "aws",
    { identity: string | null; token: number }
  > = {
    azure: { identity: null, token: 0 },
    aws: { identity: null, token: 0 }
  };
  const discoveryAccounts: Record<
    "azure" | "aws",
    { subscriptionId: string; tenantId: string }
  > = {
    azure: { subscriptionId: "", tenantId: "" },
    aws: { subscriptionId: "", tenantId: "" }
  };
  const accountDiscovered = { azure: false, aws: false };
  // Each provider has its own sign-in host and action, so one provider's
  // discovery never hides or replaces the other's button.
  const remediations: Record<
    "azure" | "aws",
    { host: DomElement | null; action: CommandActionHandle | null }
  > = {
    azure: {
      host: context.dom.byId("azure-discover-remediation"),
      action: null
    },
    aws: { host: context.dom.byId("aws-discover-remediation"), action: null }
  };
  const renderDiscoverRemediation = (
    provider: "azure" | "aws",
    payload: unknown
  ): void => {
    const slot = remediations[provider];
    slot.action?.dispose();
    slot.action = null;
    const host = slot.host;
    if (!host) return;
    host.replaceChildren();
    host.hidden = true;
    if (!isRecord(payload)) return;
    const reference = remediationReference(payload["remediation"]);
    if (!reference) return;
    const remediation = remediationView(reference.id, reference.params);
    const guardedRemediation =
      remediation.runnable && options.mutationNonce.trim() === "" ?
        {
          ...remediation,
          runnable: false,
          unsupportedReason: MISSING_MUTATION_NONCE_REASON
        }
      : remediation;
    host.hidden = false;
    slot.action = createCommandAction(context, {
      host,
      remediation: guardedRemediation,
      mutationNonce: options.mutationNonce,
      idPrefix: `${provider}-discover-login`
    });
  };
  // A saved Azure selection that the next Azure response restores once.
  let pendingAzureInfrastructure: EnvironmentInfrastructure | null = null;
  let heldAwsSelection: HeldAwsSelection | null = null;
  // Only the newest AWS namespace request may change the namespace list. An
  // AWS discovery also bumps it, because that discovery lists namespaces too.
  let awsNamespaceToken = 0;
  // The token of the namespace read that a cluster pick started. Create stays
  // blocked while it matches awsNamespaceToken.
  let awsNamespaceReadToken: number | null = null;
  // A saved namespace survives one extra discovery round trip: the first,
  // untargeted request cannot list namespaces, so the restored value has to be
  // reapplied once the follow-up request returns the cluster's real list.
  let pendingAzureNamespace = "";

  const comboValue = (selectId: string, customId: string): string => {
    const select = context.dom.selectById(selectId);
    if (!select) return "";
    if (select.value === "__custom__") {
      return context.dom.inputById(customId)?.value ?? "";
    }
    return select.value;
  };

  const selectedAzureClusterId = (): string => {
    const select = context.dom.selectById("azure-cluster-select");
    if (!select) return "";
    return renderedAzureClusters.get(select.value)?.id ?? select.value;
  };

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

  const selectedAzureCluster = (): DiscoveryOption | undefined => {
    const select = context.dom.selectById("azure-cluster-select");
    if (!select) return undefined;
    return renderedAzureClusters.get(select.value);
  };

  const findAzureClusterResourceGroup = (clusterId: string): string => {
    const selected = selectedAzureCluster();
    if (selected?.id === clusterId) return selected.resourceGroup ?? "";
    const matches = azureClusters.filter((item) => item.id === clusterId);
    const resourceGroups = new Set(
      matches
        .map((item) => item.resourceGroup ?? "")
        .filter((resourceGroup) => resourceGroup !== "")
    );
    return resourceGroups.size === 1 ? Array.from(resourceGroups)[0] : "";
  };

  const renderClusters = (
    list: readonly DiscoveryOption[],
    keepCluster: string,
    keepResourceGroup: string
  ): void => {
    const repeatedIds = new Set(
      list
        .filter(
          (item, index) =>
            list.findIndex((other) => other.id === item.id) !== index
        )
        .map((item) => item.id)
    );
    const optionValue = (item: DiscoveryOption, index: number): string =>
      repeatedIds.has(item.id) ?
        `__aks__:${encodeURIComponent(item.resourceGroup ?? "")}:${encodeURIComponent(item.id)}:${index}`
      : item.id;
    renderedAzureClusters = new Map(
      list.map((item, index) => [optionValue(item, index), item])
    );
    const keepMatches = [...renderedAzureClusters].filter(
      ([, item]) =>
        item.id === keepCluster &&
        (keepResourceGroup === "" || item.resourceGroup === keepResourceGroup)
    );
    const keepValue = keepMatches.length === 1 ? keepMatches[0][0] : "";
    renderAzureClusters(
      context,
      list.map((item, index) =>
        repeatedIds.has(item.id) && item.resourceGroup ?
          {
            ...item,
            id: optionValue(item, index),
            name: `${item.name} (${item.resourceGroup})`
          }
        : { ...item, id: optionValue(item, index) }
      ),
      keepValue,
      // A caller asking to keep a specific cluster that the list no longer
      // offers must fail closed rather than silently target another cluster.
      keepCluster === ""
    );
  };

  const renderClustersForResourceGroup = (
    resourceGroup: string,
    keepCluster: string
  ): void => {
    renderClusters(
      resourceGroup === "" ?
        []
      : azureClusters.filter((item) => item.resourceGroup === resourceGroup),
      keepCluster,
      resourceGroup
    );
  };

  const restoreAzureClusterValue = (
    cluster: string,
    resourceGroup: string
  ): void => {
    if (cluster === "") return;
    const select = context.dom.selectById("azure-cluster-select");
    if (!select) return;
    const matches = [...renderedAzureClusters].filter(
      ([, item]) =>
        item.id === cluster &&
        (resourceGroup === "" || item.resourceGroup === resourceGroup)
    );
    if (matches.length === 1) {
      select.value = matches[0][0];
      return;
    }
  };

  const resetAzureNamespaceDiscovery = (): void => {
    const request = discoveryRequests.azure;
    request.token += 1;
    request.identity = null;
    renderSelect(context, "azure-namespace-select", [], "Select namespace…");
    const namespaceSelect = context.dom.selectById("azure-namespace-select");
    if (namespaceSelect) namespaceSelect.disabled = false;
    const refreshButton = context.dom.inputById("azure-refresh-btn");
    if (refreshButton) refreshButton.disabled = false;
  };

  const applyAzureResourceGroupFilter = (resourceGroup: string): void => {
    renderClustersForResourceGroup(resourceGroup, "");
    resetAzureNamespaceDiscovery();
    if (selectedAzureClusterId() !== "") {
      void rediscoverAzureNamespaces();
    }
  };

  const wireAzureInfraFilter = (): void => {
    if (azureFilterWired) return;
    const clusterSelect = context.dom.selectById("azure-cluster-select");
    const rgSelect = context.dom.selectById("azure-rg-select");
    if (!clusterSelect || !rgSelect) return;
    azureFilterWired = true;
    scope.on(rgSelect, "change", () => {
      applyAzureResourceGroupFilter(rgSelect.value);
    });
    scope.on(clusterSelect, "change", () => {
      const clusterId = clusterSelect.value;
      if (clusterId === "") {
        resetAzureNamespaceDiscovery();
        return;
      }
      void rediscoverAzureNamespaces();
    });
  };

  const discoverResources = async (
    provider: "azure" | "aws",
    subscriptionId: string,
    tenantId: string,
    discoverOptions: DiscoverResourcesOptions = {}
  ): Promise<void> => {
    const refreshButton = context.dom.inputById(
      provider === "azure" ? "azure-refresh-btn" : "aws-refresh-btn"
    );
    // The newest full discovery owns the namespace list. It also takes over
    // from an AWS cluster pick whose namespace read it drops.
    const namespaceSelect = context.dom.selectById(
      provider === "azure" ? "azure-namespace-select" : "aws-namespace-select"
    );
    const request = discoveryRequests[provider];
    const previousAccount = discoveryAccounts[provider];
    const accountChanged =
      accountDiscovered[provider] &&
      (previousAccount.subscriptionId !== subscriptionId ||
        previousAccount.tenantId !== tenantId);
    discoveryAccounts[provider] = { subscriptionId, tenantId };
    accountDiscovered[provider] = true;
    const hasPendingSelection = pendingAzureInfrastructure !== null;
    const deploymentResourceGroup =
      provider === "azure" && !accountChanged && !hasPendingSelection ?
        (context.dom.selectById("azure-rg-select")?.value ?? "")
      : "";
    if (provider === "aws") {
      claimAwsSelection(
        `${subscriptionId}\u0000${tenantId}`,
        discoverOptions.keepSelection === true && !accountChanged
      );
    }
    // An AWS discovery sends the held cluster, so the server lists that
    // cluster's namespaces. With none, it lists those of the only usable one.
    const heldAwsCluster = heldAwsSelection?.config.cluster ?? "";
    const cluster =
      provider === "aws" ?
        isEksClusterName(heldAwsCluster) ? heldAwsCluster
        : ""
      : !accountChanged && !hasPendingSelection ? selectedAzureClusterId()
      : "";
    const discoveredClusterResourceGroup =
      provider === "azure" ? findAzureClusterResourceGroup(cluster) : "";
    const clusterResourceGroup =
      cluster === "" ? ""
      : discoveredClusterResourceGroup !== "" ? discoveredClusterResourceGroup
      : deploymentResourceGroup;
    const identity = [
      subscriptionId,
      tenantId,
      provider === "azure" ? deploymentResourceGroup : "",
      clusterResourceGroup,
      cluster
    ].join("\u0000");
    if (request.identity === identity) {
      // The very same lookup is already running. Re-assert the disabled state
      // because callers enable Refresh optimistically when a profile is
      // selected, which would otherwise leave it clickable mid-discovery.
      if (refreshButton) refreshButton.disabled = true;
      if (namespaceSelect) {
        renderSelectLoading(
          context,
          namespaceSelect,
          "Discovering namespaces…"
        );
      }
      return;
    }
    // A different account supersedes whatever is outstanding: claim the newest
    // token so the in-flight response is discarded when it lands.
    const token = ++request.token;
    request.identity = identity;
    if (refreshButton) refreshButton.disabled = true;
    if (namespaceSelect) {
      renderSelectLoading(context, namespaceSelect, "Discovering namespaces…");
    }
    const isStale = (): boolean => !scope.active || request.token !== token;
    const statusEl = context.dom.byId(
      provider === "azure" ? "azure-discover-status" : "aws-discover-status"
    );
    if (statusEl) statusEl.textContent = "Discovering resources…";
    renderDiscoverRemediation(provider, null);
    // The cluster, VPC, and subnets on screen belong to the previous lookup,
    // possibly in another account or region. Clear them so Create stays
    // blocked until this lookup succeeds, and stays blocked if it fails.
    if (provider === "aws") {
      awsClusterInfo = [];
      renderSelect(
        context,
        AWS_CLUSTER_SELECT_ID,
        [],
        "",
        false,
        "Discovering EKS clusters…"
      );
      renderAwsClusterNote(context, []);
      renderAwsNamespaceNote(context, "");
      awsNamespaceToken += 1;
      awsInfrastructure.reset();
    }
    const payload: Record<string, string> = { provider };
    // An AWS profile names an account and region where Azure names a
    // subscription and tenant; they arrive in the same two positions.
    if (provider === "aws") {
      payload.accountId = subscriptionId;
      payload.region = tenantId;
    } else {
      if (subscriptionId !== "") payload.subscriptionId = subscriptionId;
      if (tenantId !== "") payload.tenantId = tenantId;
    }
    if (clusterResourceGroup !== "") {
      payload.resourceGroup = clusterResourceGroup;
    }
    if (cluster !== "") payload.cluster = cluster;
    try {
      const response = await context.net.fetch(DISCOVER_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const raw = await response.json();
      if (isStale()) return;
      const data = toDiscoveryData(raw);
      renderDiscoverRemediation(provider, raw);
      if (provider === "azure") {
        if (statusEl) statusEl.textContent = discoverStatusText(data, "azure");
        azureClusters = sortDiscoveryOptions(
          parseDiscoveryOptions(readArray(raw, "clusters"))
        );
        renderSelect(
          context,
          "azure-rg-select",
          sortDiscoveryOptions(
            parseDiscoveryOptions(readArray(raw, "resourceGroups"))
          ),
          "Select resource group…",
          false
        );
        selectOfferedValue(context, "azure-rg-select", deploymentResourceGroup);
        // Filter the cluster list by the resource group the selected cluster
        // lives in, not the application's, so a cluster outside the
        // application's resource group is not dropped from the picker. With no
        // cluster selected there is nothing to scope by and the resource group
        // dropdown decides, exactly as before.
        renderClustersForResourceGroup(
          clusterResourceGroup ||
            (context.dom.selectById("azure-rg-select")?.value ?? ""),
          cluster
        );
        restoreAzureClusterValue(cluster, clusterResourceGroup);
        renderSelect(
          context,
          "azure-namespace-select",
          sortDiscoveryOptions(
            parseDiscoveryOptions(readArray(raw, "namespaces"))
          ),
          "Select namespace…"
        );
        if (pendingAzureNamespace !== "") {
          const namespace = pendingAzureNamespace;
          pendingAzureNamespace = "";
          restoreInfrastructureValue(
            "azure-namespace-select",
            "azure-namespace-custom",
            namespace
          );
        } else {
          selectOfferedValue(context, "azure-namespace-select", "default");
        }
        wireAzureInfraFilter();
        const restoredNamespace = applyPendingAzureInfrastructure();
        if (cluster === "" && selectedAzureClusterId() !== "") {
          pendingAzureNamespace = restoredNamespace;
          void rediscoverAzureNamespaces();
        }
      } else {
        if (statusEl) {
          statusEl.textContent = discoverStatusText(data, "aws", tenantId);
        }
        showAwsDiscovery(raw, data, tenantId);
      }
    } catch (error) {
      if (isStale()) return;
      if (statusEl)
        statusEl.textContent = `Discovery error: ${errorMessageOf(error)}`;
      renderDiscoverRemediation(provider, null);
      if (provider === "azure") {
        renderSelect(
          context,
          "azure-namespace-select",
          [],
          "Select namespace…"
        );
      } else {
        // The held selection stays for the next discovery in this account.
        renderSelect(
          context,
          AWS_CLUSTER_SELECT_ID,
          [],
          "",
          false,
          "Clusters unavailable"
        );
        renderSelect(context, "aws-namespace-select", [], "Select namespace…");
        restoreInfrastructureValue(
          "aws-namespace-select",
          "aws-namespace-custom",
          heldAwsSelection?.config.namespace ?? ""
        );
      }
    } finally {
      // Only the newest request clears the slot; a superseded one must leave
      // both the identity and the disabled Refresh button owned by its
      // successor.
      if (request.token === token) {
        request.identity = null;
        if (scope.active && refreshButton) refreshButton.disabled = false;
        if (scope.active && namespaceSelect) namespaceSelect.disabled = false;
      }
    }
  };

  const rediscoverAzureNamespaces = async (): Promise<void> => {
    const account = discoveryAccounts.azure;
    const resourceGroup =
      context.dom.selectById("azure-rg-select")?.value ?? "";
    const cluster = selectedAzureClusterId();
    const clusterResourceGroup =
      findAzureClusterResourceGroup(cluster) || resourceGroup;
    if (clusterResourceGroup === "" || cluster === "") return;
    await discoverResources("azure", account.subscriptionId, account.tenantId);
  };

  const restoreInfrastructureValue = (
    selectId: string,
    customId: string,
    value: string
  ): void => {
    if (value === "") return;
    const custom = context.dom.inputById(customId);
    if (selectOfferedValue(context, selectId, value)) {
      // A previous restore may have revealed the custom input; the select now
      // carries the value directly, so the leftover input must not stay visible.
      if (custom) custom.style.display = "none";
      return;
    }
    if (!custom || !selectOfferedValue(context, selectId, "__custom__")) return;
    custom.value = value;
    custom.style.display = "";
  };

  const applyPendingAzureInfrastructure = (): string => {
    const config = pendingAzureInfrastructure;
    if (!config) return "";
    pendingAzureInfrastructure = null;
    selectOfferedValue(context, "azure-rg-select", config.resourceGroup ?? "");
    const resourceGroup =
      context.dom.selectById("azure-rg-select")?.value ?? "";
    // The cluster list is filtered by the resource group the cluster lives
    // in, not the application's. Those are separate values, and filtering on
    // the application's would leave the environment's own cluster out of the
    // picker whenever the two differ. An environment stored before the
    // cluster's resource group was recorded has none, so it falls back to the
    // application's and behaves exactly as it did before.
    const clusterResourceGroup = config.clusterResourceGroup || resourceGroup;
    renderClustersForResourceGroup(clusterResourceGroup, config.cluster ?? "");
    restoreAzureClusterValue(config.cluster ?? "", clusterResourceGroup);
    restoreInfrastructureValue(
      "azure-namespace-select",
      "azure-namespace-custom",
      config.namespace ?? ""
    );
    return config.namespace ?? "";
  };

  const currentAwsSelection = (): EnvironmentInfrastructure => ({
    cluster: context.dom.selectById(AWS_CLUSTER_SELECT_ID)?.value ?? "",
    namespace: comboValue("aws-namespace-select", "aws-namespace-custom"),
    vpcId: awsInfrastructure.vpcId(),
    subnetIds: awsInfrastructure.selectedSubnetIds().join(",")
  });

  // Runs as an AWS discovery starts. A held selection from another account or
  // region is dropped, and an unclaimed one is tied to this account and region.
  // Refresh holds the selection on screen when a cluster is selected.
  const claimAwsSelection = (
    accountScope: string,
    keepSelection: boolean
  ): void => {
    if (heldAwsSelection !== null) {
      if (heldAwsSelection.scope === null) {
        heldAwsSelection.scope = accountScope;
      } else if (heldAwsSelection.scope !== accountScope) {
        heldAwsSelection = null;
      }
      return;
    }
    const current = currentAwsSelection();
    if (keepSelection && current.cluster !== "") {
      heldAwsSelection = { config: current, scope: accountScope };
    }
  };

  const onlyUsableAwsCluster = (): string => {
    const usable = awsClusterInfo.filter((item) => item.usable);
    return usable.length === 1 ? usable[0].id : "";
  };

  // Render the cluster options from awsClusterInfo, with a disabled option for
  // each unusable cluster. Returns the note line of each one.
  const renderAwsClusterSelect = (
    region: string,
    clusterListFailed: boolean
  ): AwsClusterNoteLine[] => {
    const options = sortDiscoveryOptions(
      awsClusterInfo.map((info: AwsClusterInfo) => {
        const presentation = awsClusterPresentation(info, region);
        return {
          id: info.id,
          name: presentation.label,
          disabled: !info.usable,
          note: presentation.note
        };
      })
    );
    renderSelect(
      context,
      AWS_CLUSTER_SELECT_ID,
      options,
      "Select a cluster",
      false,
      clusterListFailed ? "Clusters unavailable" : "No EKS clusters"
    );
    return options.flatMap((option) => (option.note ? [option.note] : []));
  };

  // Show an AWS discovery response: the cluster options and note, the
  // namespaces, and either the defaults or the held selection.
  const showAwsDiscovery = (
    raw: unknown,
    data: DiscoveryData,
    region: string
  ): void => {
    const kinds = data.errorKinds ?? {};
    const errors = data.errors ?? {};
    const clusterListFailed =
      data.error !== undefined ||
      kinds.clusters !== undefined ||
      errors.clusters !== undefined;
    awsClusterInfo =
      clusterListFailed ? [] : parseAwsClusterInfo(readArray(raw, "clusters"));
    const noteLines = renderAwsClusterSelect(region, clusterListFailed);
    awsInfrastructure.setDiscovered({
      clusters: awsClusterInfo,
      subnets: parseAwsSubnetInfo(readArray(raw, "subnets")),
      vpcs: parseAwsVpcInfo(readArray(raw, "vpcs")),
      subnetsErrorKind: kinds.subnets ?? "",
      routeTablesErrorKind: kinds.routeTables ?? "",
      vpcsErrorKind: kinds.vpcs ?? ""
    });
    const held = heldAwsSelection;
    if (held === null) {
      awsInfrastructure.showCluster(onlyUsableAwsCluster(), "defaults");
      renderAwsClusterNote(context, noteLines);
      showAwsNamespaces(raw, data);
      return;
    }
    const heldCluster = held.config.cluster ?? "";
    if (clusterListFailed) {
      awsInfrastructure.showCluster("", "defaults");
    } else if (heldCluster === "") {
      heldAwsSelection = null;
      awsInfrastructure.showCluster(onlyUsableAwsCluster(), "defaults");
    } else if (
      !awsClusterInfo.some((item) => item.id === heldCluster && item.usable)
    ) {
      const heldInfo = awsClusterInfo.find((item) => item.id === heldCluster);
      // A cluster that AWS didn't describe may still be usable, so its
      // selection stays held for the next discovery.
      if (heldInfo?.unusableReason !== "not-described") {
        heldAwsSelection = null;
      }
      awsInfrastructure.showCluster("", "defaults");
      if (heldInfo === undefined) {
        noteLines.push(awsMissingClusterNoteLine(heldCluster, region));
      }
    } else if (kinds.subnets !== undefined) {
      // Without the subnet list, no saved subnet can be checked or named as
      // removed, so the subnets stay held for the next discovery.
      awsInfrastructure.showCluster(heldCluster, "defaults");
    } else {
      heldAwsSelection = null;
      awsInfrastructure.showCluster(
        heldCluster,
        (held.config.subnetIds ?? "").split(",")
      );
    }
    renderAwsClusterNote(context, noteLines);
    showAwsNamespaces(raw, data);
    restoreInfrastructureValue(
      "aws-namespace-select",
      "aws-namespace-custom",
      held.config.namespace ?? ""
    );
  };

  // Show the namespaces in a response for the cluster on screen, with
  // "default" selected. The server lists them only for a usable cluster. When
  // it can't, the list has only "default", and a note says so.
  const showAwsNamespaces = (raw: unknown, data: DiscoveryData): void => {
    const cluster = context.dom.selectById(AWS_CLUSTER_SELECT_ID)?.value ?? "";
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
    // Setting the value doesn't fire the select's change handler, so hide a
    // custom name typed for the previous list here.
    const custom = context.dom.inputById("aws-namespace-custom");
    if (custom) custom.style.display = "none";
    const listed =
      data.errors?.namespaces === undefined &&
      data.errorKinds?.namespaces === undefined &&
      parseAwsClusterInfo(readArray(raw, "clusters")).some(
        (item) => item.id === cluster && item.usable
      );
    renderAwsNamespaceNote(
      context,
      cluster === "" || listed ? "" : awsNamespaceFallbackNote(cluster)
    );
  };

  // A cluster the developer picks gets its own namespaces. Only the namespace
  // list changes, unless the response marks that cluster unusable. Then the
  // cluster is disabled and cleared, as a full discovery would do.
  const rediscoverAwsNamespaces = async (cluster: string): Promise<void> => {
    const token = ++awsNamespaceToken;
    const namespaceSelect = context.dom.selectById("aws-namespace-select");
    renderAwsNamespaceNote(context, "");
    let raw: unknown = null;
    if (isEksClusterName(cluster)) {
      if (namespaceSelect) {
        renderSelectLoading(
          context,
          namespaceSelect,
          "Discovering namespaces…"
        );
      }
      awsNamespaceReadToken = token;
      options.onInfrastructureChange?.();
      const account = discoveryAccounts.aws;
      try {
        const response = await context.net.fetch(DISCOVER_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "aws",
            accountId: account.subscriptionId,
            region: account.tenantId,
            cluster
          })
        });
        raw = await response.json();
      } catch {
        // A failed request shows default and the note.
      }
      if (
        !scope.active ||
        awsNamespaceToken !== token ||
        context.dom.selectById(AWS_CLUSTER_SELECT_ID)?.value !== cluster
      ) {
        return;
      }
      const reported = parseAwsClusterInfo(readArray(raw, "clusters")).find(
        (item) => item.id === cluster
      );
      if (reported !== undefined && !reported.usable) {
        awsClusterInfo = awsClusterInfo.map((item) =>
          item.id === cluster ? reported : item
        );
        const noteLines = renderAwsClusterSelect(account.tenantId, false);
        awsInfrastructure.showCluster("", "defaults");
        renderAwsClusterNote(context, noteLines);
      }
    }
    if (namespaceSelect) namespaceSelect.disabled = false;
    showAwsNamespaces(raw, toDiscoveryData(raw));
    if (awsNamespaceReadToken === token) {
      awsNamespaceReadToken = null;
      options.onInfrastructureChange?.();
    }
  };

  // A cluster the developer picks replaces the held one. A namespace the
  // developer picks replaces the held namespace.
  const awsClusterSelect = context.dom.selectById(AWS_CLUSTER_SELECT_ID);
  if (awsClusterSelect) {
    scope.on(awsClusterSelect, "change", () => {
      heldAwsSelection = null;
      void rediscoverAwsNamespaces(awsClusterSelect.value);
    });
  }
  for (const elementId of ["aws-namespace-select", "aws-namespace-custom"]) {
    const element = context.dom.byId(elementId);
    if (!element) continue;
    scope.on(element, "change", () => {
      if (heldAwsSelection === null) return;
      heldAwsSelection.config = {
        ...heldAwsSelection.config,
        namespace: comboValue("aws-namespace-select", "aws-namespace-custom")
      };
    });
  }

  const currentInfraSelection = (
    provider: "azure" | "aws"
  ): EnvironmentInfrastructure =>
    provider === "aws" ?
      currentAwsSelection()
    : {
        resourceGroup: context.dom.selectById("azure-rg-select")?.value ?? "",
        cluster: selectedAzureClusterId(),
        namespace: comboValue(
          "azure-namespace-select",
          "azure-namespace-custom"
        )
      };

  const holdInfraSelection = (
    provider: "azure" | "aws",
    aws: HeldAwsSelection | null,
    azure: EnvironmentInfrastructure | null
  ): void => {
    pendingAzureNamespace = "";
    pendingAzureInfrastructure = azure;
    heldAwsSelection = aws;
    const request = discoveryRequests[provider];
    if ((aws !== null || azure !== null) && request.identity !== null) {
      // Editing another environment changes what the pending response should
      // restore, even when the account and currently rendered target match.
      // Supersede that response so the new selection starts target-free.
      request.token += 1;
      request.identity = null;
    }
  };

  return {
    clearSharedAppPin,
    promptServiceManagementReference: () => promptSmr(context),
    promptAppSelection: (options) => showAppPicker(context, options),
    discoverResources,
    findAzureClusterResourceGroup,
    setPendingInfraSelection(config, provider) {
      // One form owns the selection, so a selection for one provider drops the
      // other's.
      holdInfraSelection(
        provider,
        provider === "aws" && config ? { config, scope: null } : null,
        provider === "azure" ? config : null
      );
    },
    currentInfraSelection,
    preserveInfraSelection(provider) {
      if (provider === "azure") {
        holdInfraSelection("azure", null, currentInfraSelection("azure"));
        return;
      }
      const account = discoveryAccounts.aws;
      holdInfraSelection(
        "aws",
        heldAwsSelection ?? {
          config: currentAwsSelection(),
          scope:
            accountDiscovered.aws ?
              `${account.subscriptionId}\u0000${account.tenantId}`
            : null
        },
        null
      );
    },
    awsInfrastructureError() {
      // The select can't pick a disabled cluster, so this guards only a
      // selection made by code.
      const cluster =
        context.dom.selectById(AWS_CLUSTER_SELECT_ID)?.value ?? "";
      const info = awsClusterInfo.find((item) => item.id === cluster);
      const line =
        info ?
          awsClusterPresentation(info, discoveryAccounts.aws.tenantId).note
        : null;
      if (line) {
        return line.command === undefined ?
            line.text
          : `${line.text} ${line.command}`;
      }
      const infrastructureError = awsInfrastructure.validationError();
      if (infrastructureError !== "") return infrastructureError;
      return awsNamespaceReadToken === awsNamespaceToken ?
          "Wait for the namespace list to load."
        : "";
    },
    teardown() {
      for (const slot of Object.values(remediations)) {
        slot.action?.dispose();
        slot.action = null;
        if (slot.host) slot.host.hidden = true;
      }
      scope.teardown();
    }
  };
}
