import { escapeBrowserHtml } from "../html.js";
import { requireSuccessfulJsonResponse } from "../http.js";
import { beginEntry, NOOP_TEARDOWN } from "../lifecycle.js";
import { isRecord, readArray, readRecord, readString } from "../json.js";
import { tableErrorRowMarkup } from "./table-error.js";
import type { EnvironmentConfirmDialog } from "./confirm-dialog.js";
import type { EnvironmentInfrastructure } from "./discovery.js";
import type { BrowserTeardown } from "../lifecycle.js";
import type {
  BrowserContext,
  DomElement,
  DomEventListener,
  DomEventTarget,
  DomInputElement,
  TimerHandle
} from "../ports.js";

export const ENVIRONMENTS_ENTRY_KEY = "environment-environments";
export const ENVIRONMENT_LIST_PATH = "/api/list-environments";
export const ENVIRONMENT_DELETE_PATH = "/api/delete-environment";
export const ENVIRONMENT_POLL_MS = 10000;
const ENVIRONMENT_LIST_FAILURE = "Could not load environments.";

export interface EnvironmentRecord {
  name: string;
  status: string;
  provider: string;
  credentialProfile: string;
  webUrl: string;
  config?: EnvironmentInfrastructure;
}

export interface EnvironmentFormPreset {
  name?: string;
  profile?: string;
  config?: EnvironmentInfrastructure;
  provider?: string;
  editing?: string;
  advance?: boolean;
}

export interface EnvironmentPaneDependencies {
  loadCredentialTable(): void;
  loadProfiles(preselectName?: string): Promise<void> | void;
  loadGitHubIdentity(fresh?: boolean): void;
  clearSharedAppPin(): void;
  setPendingInfraSelection?(
    config: EnvironmentInfrastructure | null,
    provider: "azure" | "aws"
  ): void;
  currentInfraSelection?(provider: "azure" | "aws"): EnvironmentInfrastructure;
  canSubmit?(): boolean;
  // Deletion is an async operation (Radius env delete, credential cleanup,
  // GitHub env delete, app-registration cleanup). The page composes the
  // operation-progress controller, so once the request is accepted the pane
  // hands the environment and provider back to follow it to a terminal state
  // in the shared progress panel.
  startDeleteProgress(environment: string, provider: string): void;
}

export interface EnvironmentDecisionPort {
  confirm?(message: string): boolean;
  notify(message: string): void;
}

export interface EnvironmentPaneOptions {
  repo: string;
  decisions: EnvironmentDecisionPort;
  confirmDialog?: EnvironmentConfirmDialog;
}

export interface EnvironmentPaneController {
  switchSubtab(name: string): void;
  loadEnvironmentTable(): void;
  showEnvironmentForm(preset?: EnvironmentFormPreset): void;
  showEnvironmentLanding(): void;
  showWizardStep(step: 1 | 2): void;
  resetSubmitButton(): void;
  hideTerminalBanners(): void;
  showSuccess(provider: string, name: string): void;
  showError(message: string): void;
  showWarnings(steps: unknown): void;
  showActionRequired(
    provider: string,
    name: string,
    pullRequestUrl: string,
    terminal?: unknown
  ): void;
  teardown(): void;
}

interface Registration {
  target: DomEventTarget;
  type: string;
  listener: DomEventListener;
}

export function providerLabel(provider: string): string {
  if (provider === "aws") return "AWS";
  if (provider === "azure") return "Azure";
  return provider || "—";
}

export function environmentStatusMarkup(status: string): string {
  const labels: Record<string, string> = {
    success: "Success",
    verified: "Verified",
    failed: "Failed",
    pending: "Pending",
    unverified: "Unverified",
    deleting: "Deleting…",
    unknown: "Available"
  };
  return labels[status] ?? labels.pending;
}

export function parseEnvironmentRecords(payload: unknown): EnvironmentRecord[] {
  return readArray(payload, "environments")
    .filter(isRecord)
    .map((entry) => {
      const config = readRecord(entry, "config");
      return {
        name: readString(entry, "name"),
        status: readString(entry, "status"),
        provider: readString(entry, "provider"),
        credentialProfile: readString(entry, "credentialProfile"),
        webUrl: readString(entry, "webUrl"),
        config: {
          resourceGroup: readString(config, "resourceGroup"),
          cluster: readString(config, "cluster"),
          namespace: readString(config, "namespace"),
          vpcId: readString(config, "vpcId"),
          subnetIds: readString(config, "subnetIds")
        }
      };
    })
    .filter((entry) => entry.name !== "");
}

function fallbackSettingsUrl(repo: string): string {
  return `https://github.com/${encodeURI(repo)}/settings/environments`;
}

export function safeEnvironmentEditUrl(value: string, repo: string): string {
  if (value === "") return fallbackSettingsUrl(repo);
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "https:" && parsed.hostname === "github.com") {
      return parsed.href;
    }
  } catch {
    // Invalid external URLs use the repository settings page.
  }
  return fallbackSettingsUrl(repo);
}

export function environmentRowsMarkup(
  environments: readonly EnvironmentRecord[],
  _repo?: string
): string {
  if (environments.length === 0) {
    return '<tr><td class="rad-table__env">No environments created yet.</td><td></td><td></td><td></td><td class="rad-table__actions"></td></tr>';
  }
  return environments
    .map((environment) => {
      const provider = environment.provider || "—";
      const credentials = environment.credentialProfile || "—";
      const name = escapeBrowserHtml(environment.name);
      // A delete already running for this environment fails closed: the Delete
      // action is greyed out so a second deletion can't be started on top of
      // the first while cleanup is in flight.
      const deleting = environment.status === "deleting";
      const deleteAttrs =
        deleting ? ' disabled title="This environment is being deleted."' : "";
      return (
        "<tr>" +
        `<td class="rad-table__env">${name}</td>` +
        `<td>${environmentStatusMarkup(environment.status)}</td>` +
        `<td class="rad-table__provider">${escapeBrowserHtml(provider)}</td>` +
        `<td class="rad-table__creds">${escapeBrowserHtml(credentials)}</td>` +
        '<td class="rad-table__actions">' +
        `<button class="rad-link js-edit-env" data-env="${name}" style="background:none; border:none; padding:0; margin:0; font:inherit; cursor:pointer;">edit</button>` +
        `<button class="rad-btn rad-btn--neutral js-plan-deployment" data-env="${name}" style="margin:0;">Plan Deployment</button>` +
        `<button class="rad-btn rad-btn--danger-outline js-delete-env" data-env="${name}" style="margin:0;"${deleteAttrs}>Delete Env</button>` +
        "</td></tr>"
      );
    })
    .join("");
}

function setButtonState(
  button: DomElement,
  disabled: boolean,
  text: string
): void {
  Reflect.set(button, "disabled", disabled);
  button.textContent = text;
}

function safeDeleteRedirect(value: string): string {
  if (
    value.startsWith("/?page=deploying") ||
    value.startsWith("/?page=deployed")
  ) {
    return value;
  }
  return "/?page=deploying";
}

function bind(
  registrations: Registration[],
  target: DomEventTarget | null,
  type: string,
  listener: DomEventListener
): void {
  if (!target) return;
  target.addEventListener(type, listener);
  registrations.push({ target, type, listener });
}

function release(registrations: Registration[]): void {
  for (const registration of registrations.splice(0)) {
    registration.target.removeEventListener(
      registration.type,
      registration.listener
    );
  }
}

function requiredInput(
  context: BrowserContext,
  elementId: string
): DomInputElement | null {
  return context.dom.inputById(elementId);
}

export function initializeEnvironmentPane(
  context: BrowserContext,
  options: EnvironmentPaneOptions,
  dependencies: EnvironmentPaneDependencies
): EnvironmentPaneController | BrowserTeardown {
  const environmentPane = context.dom.byId("pane-environments");
  const credentialPane = context.dom.byId("pane-credentials");
  const environmentLanding = context.dom.byId("env-landing");
  const environmentForm = context.dom.byId("env-form");
  const environmentName = requiredInput(context, "env-name-input");
  const profileSelect = requiredInput(context, "env-profile-select");
  if (
    !environmentPane ||
    !credentialPane ||
    !environmentLanding ||
    !environmentForm ||
    !environmentName ||
    !profileSelect
  ) {
    return NOOP_TEARDOWN;
  }

  const scope = beginEntry(context, ENVIRONMENTS_ENTRY_KEY);
  if (!scope) return NOOP_TEARDOWN;

  const owned: Registration[] = [];
  const rows: Registration[] = [];
  let pollTimer: TimerHandle | null = null;
  let listRequest = 0;
  let listAbort = context.net.createAbort();
  let active = true;
  let environmentRows: EnvironmentRecord[] = [];
  let editTarget = "";

  const cancelPoll = (): void => {
    if (pollTimer === null) return;
    context.clock.clearTimeout(pollTimer);
    pollTimer = null;
  };

  const hideBanner = (id: string): void => {
    const banner = context.dom.byId(id);
    if (banner) banner.style.display = "none";
  };

  const hideTerminalBanners = (): void => {
    for (const id of [
      "env-success-banner",
      "env-error-banner",
      "env-warning-banner",
      "env-action-banner"
    ]) {
      hideBanner(id);
    }
  };

  const showError = (message: string): void => {
    const banner = context.dom.byId("env-error-banner");
    const text = context.dom.byId("env-error-banner-text");
    if (!banner || !text) return;
    text.textContent = message;
    banner.style.display = "flex";
    banner.scrollIntoView({ block: "nearest" });
  };

  const deleteEnvironment = (
    name: string,
    provider: string,
    button: DomElement
  ): void => {
    setButtonState(button, true, "Deleting…");
    void context.net
      .fetch(ENVIRONMENT_DELETE_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: options.repo,
          environment: name
        })
      })
      .then(async (response) => ({
        ok: response.ok,
        body: await response.json()
      }))
      .then(
        (result) => {
          if (!active) return;
          const error = readString(result.body, "error");
          if (!result.ok || error !== "") {
            setButtonState(button, false, "Delete Env");
            if (readString(result.body, "code") === "app-deployed") {
              const target = safeDeleteRedirect(
                readString(result.body, "redirect")
              );
              options.confirmDialog?.show({
                title: "Delete the application first",
                message: `${
                  error ||
                  "An application is still deployed to this environment."
                }\n\nNothing has been deleted. Delete the application on the Deployments page, then delete this environment.`,
                confirmLabel: "Go to Deployments",
                confirmVariant: "primary",
                cancelLabel: "Stay here",
                onConfirm: () => context.nav.assign(target)
              });
              return;
            }
            options.decisions.notify(
              error || "Could not delete the environment."
            );
            return;
          }
          // The request was accepted; deletion now runs as a tracked
          // operation. Follow it in the shared progress panel instead of
          // refreshing the table immediately, so cleanup and any failure are
          // surfaced the same way as environment creation.
          dependencies.startDeleteProgress(name, provider);
        },
        () => {
          if (!active) return;
          setButtonState(button, false, "Delete Env");
          options.decisions.notify(
            "Could not delete the environment. Please try again."
          );
        }
      );
  };

  const wireRows = (): void => {
    release(rows);
    for (const button of context.dom.all(
      context.dom.document,
      ".js-edit-env"
    )) {
      bind(rows, button, "click", () => {
        const name = button.getAttribute("data-env") ?? "";
        const environment = environmentRows.find((row) => row.name === name);
        if (!environment) return;
        showEnvironmentForm({
          name: environment.name,
          profile: environment.credentialProfile,
          config: environment.config,
          provider: environment.provider,
          editing: environment.name
        });
      });
    }
    for (const button of context.dom.all(
      context.dom.document,
      ".js-plan-deployment"
    )) {
      bind(rows, button, "click", () => {
        const name = button.getAttribute("data-env") ?? "";
        context.nav.assign(
          `/?page=planned${name ? `&env=${encodeURIComponent(name)}` : ""}`
        );
      });
    }
    for (const button of context.dom.all(
      context.dom.document,
      ".js-delete-env"
    )) {
      bind(rows, button, "click", () => {
        // A disabled Delete button (an environment mid-deletion) is inert: never
        // start a second deletion on top of one already running.
        if (Reflect.get(button, "disabled") === true) return;
        const name = button.getAttribute("data-env") ?? "";
        if (!name) return;
        const environment = environmentRows.find((row) => row.name === name);
        const provider = environment?.provider ?? "";
        options.confirmDialog?.show({
          title: "Delete environment?",
          message: `This deletes the GitHub environment "${name}", removes the Radius environment from the cluster, and permanently deletes the environment's federated credential from its Azure app registration (which may be shared). Applications already deployed to it must be deleted first.`,
          confirmLabel: "Delete environment",
          onConfirm: () => deleteEnvironment(name, provider, button)
        });
      });
    }
  };

  const loadEnvironmentTable = (): void => {
    const body = context.dom.byId("env-table-body");
    if (!body) return;
    cancelPoll();
    release(rows);
    listAbort?.abort();
    listAbort = context.net.createAbort();
    const request = ++listRequest;
    if (!options.repo) {
      body.innerHTML = environmentRowsMarkup([]);
      return;
    }
    body.innerHTML =
      '<tr><td colspan="5" style="color:var(--rad-text-tertiary);">Loading environments…</td></tr>';
    void context.net
      .fetch(
        `${ENVIRONMENT_LIST_PATH}?repo=${encodeURIComponent(options.repo)}`,
        listAbort ? { signal: listAbort.signal } : undefined
      )
      .then((response) =>
        requireSuccessfulJsonResponse(response, ENVIRONMENT_LIST_FAILURE)
      )
      .then(
        (payload) => {
          if (!active || request !== listRequest) return;
          const environments = parseEnvironmentRecords(payload);
          environmentRows = environments;
          body.innerHTML = environmentRowsMarkup(environments);
          wireRows();
          if (
            environments.some(
              (environment) =>
                environment.status === "pending" ||
                environment.status === "deleting"
            )
          ) {
            pollTimer = context.clock.setTimeout(
              loadEnvironmentTable,
              ENVIRONMENT_POLL_MS
            );
          }
        },
        (error: unknown) => {
          if (
            !active ||
            request !== listRequest ||
            (error instanceof Error && error.name === "AbortError")
          ) {
            return;
          }
          body.innerHTML = tableErrorRowMarkup(
            error,
            5,
            ENVIRONMENT_LIST_FAILURE
          );
        }
      );
  };

  const showEnvironmentForm = (preset: EnvironmentFormPreset = {}): void => {
    hideTerminalBanners();
    editTarget = preset.editing ?? "";
    environmentName.value = preset.name ?? "";
    environmentName.disabled = editTarget !== "";
    const title = context.dom.byId("env-step2-title");
    if (title)
      title.textContent =
        editTarget === "" ? "Create Environment" : "Edit Environment";
    const help = context.dom.byId("env-name-help");
    if (help) {
      help.textContent =
        editTarget === "" ?
          "The deployment target you'll deploy apps into by name."
        : "An environment cannot be renamed. Delete it and create a new one to change the name.";
    }
    dependencies.setPendingInfraSelection?.(
      editTarget === "" ? null : (preset.config ?? null),
      preset.provider === "aws" ? "aws" : "azure"
    );
    const clientId = requiredInput(context, "az-client-id");
    if (clientId) clientId.value = "";
    dependencies.clearSharedAppPin();
    hideBanner("deploy-status");
    environmentLanding.style.display = "none";
    environmentForm.style.display = "";
    showWizardStep(1);
    void Promise.resolve(dependencies.loadProfiles(preset.profile)).then(() => {
      if (!active || profileSelect.value === "" || preset.advance === false)
        return;
      showWizardStep(2);
      if (editTarget === "") environmentName.focus();
    });
    dependencies.loadGitHubIdentity();
    resetSubmitButton();
    context.dom.byId("env-profile-button")?.focus();
  };

  const showEnvironmentLanding = (): void => {
    editTarget = "";
    dependencies.setPendingInfraSelection?.(null, "azure");
    environmentForm.style.display = "none";
    environmentLanding.style.display = "";
    // The form's controls are now hidden, so keyboard focus has to come back to
    // the control that reveals it instead of being dropped onto the document.
    context.dom.byId("new-env-btn")?.focus();
    loadEnvironmentTable();
  };

  const showWizardStep = (step: 1 | 2): void => {
    const second = step === 2;
    const credentialsStep = context.dom.byId("env-step-credentials");
    const detailsStep = context.dom.byId("env-step-details");
    if (credentialsStep) credentialsStep.style.display = second ? "none" : "";
    if (detailsStep) detailsStep.style.display = second ? "" : "none";
    for (const [id, state] of [
      ["env-wizard-step-1", second ? "done" : "active"],
      ["env-wizard-step-2", second ? "active" : "todo"]
    ] as const) {
      const element = context.dom.byId(id);
      if (!element) continue;
      element.classList.toggle("rad-wizard__step--active", state === "active");
      element.classList.toggle("rad-wizard__step--done", state === "done");
      if (state === "active") element.setAttribute("aria-current", "step");
      else element.removeAttribute("aria-current");
    }
  };

  const resetSubmitButton = (): void => {
    const submit = requiredInput(context, "deploy-btn");
    if (!submit) return;
    submit.textContent =
      environmentName.disabled ? "Save Environment" : "Create Environment";
    submit.disabled =
      dependencies.canSubmit ? !dependencies.canSubmit() : false;
  };

  const switchSubtab = (name: string): void => {
    const credentials = name === "credentials";
    environmentPane.style.display = credentials ? "none" : "";
    credentialPane.style.display = credentials ? "" : "none";
    for (const link of context.dom.all(
      context.dom.document,
      "#env-subtabs .rad-subtab"
    )) {
      link.classList.toggle(
        "rad-subtab--active",
        link.getAttribute("data-subtab") === name
      );
    }
    context.nav.replaceState(
      `/?page=${credentials ? "credentials" : "environment"}`
    );
    if (credentials) {
      dependencies.loadCredentialTable();
      return;
    }
    loadEnvironmentTable();
    if (environmentForm.style.display !== "none") {
      const provider =
        context.dom.inputById("env-selected-provider")?.value === "aws" ?
          "aws"
        : "azure";
      dependencies.setPendingInfraSelection?.(
        dependencies.currentInfraSelection?.(provider) ?? {},
        provider
      );
      void dependencies.loadProfiles(profileSelect.value);
    }
  };

  for (const link of context.dom.all(
    context.dom.document,
    "#env-subtabs .rad-subtab"
  )) {
    bind(owned, link, "click", (event) => {
      event.preventDefault();
      switchSubtab(link.getAttribute("data-subtab") ?? "");
    });
  }

  const closeBindings: ReadonlyArray<readonly [string, string]> = [
    ["env-success-banner-close", "env-success-banner"],
    ["env-error-banner-close", "env-error-banner"],
    ["env-warning-banner-close", "env-warning-banner"],
    ["env-action-banner-close", "env-action-banner"]
  ];
  for (const [controlId, bannerId] of closeBindings) {
    bind(owned, context.dom.byId(controlId), "click", () =>
      hideBanner(bannerId)
    );
  }

  bind(owned, context.dom.byId("env-step1-next"), "click", () => {
    if (profileSelect.value === "") return;
    showWizardStep(2);
    environmentName.focus();
  });
  bind(owned, context.dom.byId("env-step2-back"), "click", () =>
    showWizardStep(1)
  );
  bind(owned, context.dom.byId("env-change-profile-link"), "click", () =>
    showWizardStep(1)
  );

  const controller: EnvironmentPaneController = {
    switchSubtab,
    loadEnvironmentTable,
    showEnvironmentForm,
    showEnvironmentLanding,
    showWizardStep,
    resetSubmitButton,
    hideTerminalBanners,
    showSuccess(provider, name) {
      const banner = context.dom.byId("env-success-banner");
      const text = context.dom.byId("env-success-banner-text");
      if (!banner || !text) return;
      text.innerHTML = `Successfully configured <strong>${escapeBrowserHtml(
        providerLabel(provider)
      )}</strong> Environment <strong>${escapeBrowserHtml(name)}</strong>`;
      banner.style.display = "flex";
    },
    showError,
    showWarnings(steps) {
      const banner = context.dom.byId("env-warning-banner");
      const text = context.dom.byId("env-warning-banner-text");
      if (!banner || !text) return;
      const warnings =
        Array.isArray(steps) ?
          steps.filter(
            (step): step is string =>
              typeof step === "string" && step.startsWith("⚠️")
          )
        : [];
      if (warnings.length === 0) {
        banner.style.display = "none";
        return;
      }
      text.textContent = warnings.join("\n\n");
      banner.style.display = "flex";
      banner.scrollIntoView({ block: "nearest" });
    },
    showActionRequired(provider, name, pullRequestUrl, terminal) {
      const banner = context.dom.byId("env-action-banner");
      const text = context.dom.byId("env-action-banner-text");
      if (!banner || !text) return;
      // A delete operation that stopped because the environment still has
      // deployed applications carries a ready-to-render message; show it
      // verbatim rather than the create-flow "is set up, one step left"
      // guidance, which does not apply to a halted deletion.
      if (readString(terminal, "code") === "environment-has-applications") {
        text.textContent =
          readString(terminal, "userMessage") ||
          "This environment still has one or more deployed applications. Delete the application(s) first, then delete the environment.";
        banner.style.display = "flex";
        banner.scrollIntoView({ block: "nearest" });
        return;
      }
      const hasPullRequest = /^https:\/\/github\.com\//.test(pullRequestUrl);
      let html = `<strong>${escapeBrowserHtml(
        providerLabel(provider)
      )}</strong> Environment <strong>${escapeBrowserHtml(
        name
      )}</strong> is set up, but one step is left for you. `;
      if (readString(terminal, "userMessage")) {
        html += escapeBrowserHtml(readString(terminal, "userMessage"));
      } else if (hasPullRequest) {
        html +=
          "Radius could not push the deploy workflows to the default branch, so it opened a pull request. Credential verification and deploys start working once it merges.";
      } else {
        html += `Radius committed the deploy workflows to <code>${escapeBrowserHtml(
          readString(terminal, "branch") || "the setup branch"
        )}</code>, but could not open a pull request automatically. Open a pull request into <code>${escapeBrowserHtml(
          readString(terminal, "baseBranch") || "the default branch"
        )}</code> and merge it to finish setup.`;
      }
      if (hasPullRequest) {
        html += ` <a href="${escapeBrowserHtml(
          pullRequestUrl
        )}" target="_blank" rel="noopener noreferrer">Review the pull request →</a>`;
      }
      text.innerHTML = html;
      banner.style.display = "flex";
      banner.scrollIntoView({ block: "nearest" });
    },
    teardown() {
      if (!active) return;
      active = false;
      cancelPoll();
      listAbort?.abort();
      release(rows);
      release(owned);
      scope.teardown();
    }
  };

  return controller;
}

export function isEnvironmentPaneController(
  value: EnvironmentPaneController | BrowserTeardown
): value is EnvironmentPaneController {
  return "loadEnvironmentTable" in value;
}
