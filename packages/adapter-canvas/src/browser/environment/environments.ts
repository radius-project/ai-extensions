import { escapeBrowserHtml } from "../html.js";
import { beginEntry, NOOP_TEARDOWN } from "../lifecycle.js";
import { isRecord, readArray, readString } from "../json.js";
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
export const ENVIRONMENT_DELETE_REDIRECT_MS = 2000;

export interface EnvironmentRecord {
  name: string;
  status: string;
  provider: string;
  credentialProfile: string;
  webUrl: string;
}

export interface EnvironmentFormPreset {
  name?: string;
  profile?: string;
}

export interface EnvironmentPaneDependencies {
  loadCredentialTable(): void;
  loadProfiles(preselectName?: string): void;
  loadGitHubIdentity(fresh?: boolean): void;
  clearSharedAppPin(): void;
}

export interface EnvironmentDecisionPort {
  confirm(message: string): boolean;
  notify(message: string): void;
}

export interface EnvironmentPaneOptions {
  repo: string;
  decisions: EnvironmentDecisionPort;
}

export interface EnvironmentPaneController {
  switchSubtab(name: string): void;
  loadEnvironmentTable(): void;
  showEnvironmentForm(preset?: EnvironmentFormPreset): void;
  showEnvironmentLanding(): void;
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
  const mapped: Record<string, readonly [string, string]> = {
    success: ["success", "Success"],
    verified: ["success", "Verified"],
    failed: ["failed", "Failed"],
    pending: ["pending", "Pending"],
    unverified: ["pending", "Unverified"]
  };
  const [tone, label] = mapped[status] ?? mapped.pending;
  return `<span class="rad-dot rad-dot--${tone}"></span><span class="rad-status-label">${label}</span>`;
}

export function parseEnvironmentRecords(payload: unknown): EnvironmentRecord[] {
  return readArray(payload, "environments")
    .filter(isRecord)
    .map((entry) => ({
      name: readString(entry, "name"),
      status: readString(entry, "status"),
      provider: readString(entry, "provider"),
      credentialProfile: readString(entry, "credentialProfile"),
      webUrl: readString(entry, "webUrl")
    }))
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
  repo: string
): string {
  if (environments.length === 0) {
    return '<tr><td class="rad-table__env">No environments created yet.</td><td></td><td></td><td></td><td class="rad-table__actions"></td></tr>';
  }
  return environments
    .map((environment) => {
      const provider = environment.provider || "—";
      const credentials = environment.credentialProfile || "—";
      const editUrl = safeEnvironmentEditUrl(environment.webUrl, repo);
      const name = escapeBrowserHtml(environment.name);
      return (
        "<tr>" +
        `<td class="rad-table__env">${name}</td>` +
        `<td>${environmentStatusMarkup(environment.status)}</td>` +
        `<td class="rad-table__provider">${escapeBrowserHtml(provider)}</td>` +
        `<td class="rad-table__creds">${escapeBrowserHtml(credentials)}</td>` +
        '<td class="rad-table__actions">' +
        `<a class="rad-link" href="${escapeBrowserHtml(editUrl)}" target="_blank" rel="noopener noreferrer">edit</a>` +
        `<button class="rad-btn rad-btn--neutral js-deploy-apps" data-env="${name}" style="margin:0;">Deploy Apps</button>` +
        `<button class="rad-btn rad-btn--danger-outline js-delete-env" data-env="${name}" style="margin:0;">Delete Env</button>` +
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
  if (value.startsWith("/?page=deploying")) return value;
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
  let redirectTimer: TimerHandle | null = null;
  let listRequest = 0;
  let listAbort = context.net.createAbort();
  let active = true;

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

  const wireRows = (): void => {
    release(rows);
    for (const button of context.dom.all(
      context.dom.document,
      ".js-deploy-apps"
    )) {
      bind(rows, button, "click", () => {
        const name = button.getAttribute("data-env") ?? "";
        context.nav.assign(
          `/?page=deploying${name ? `&env=${encodeURIComponent(name)}` : ""}`
        );
      });
    }
    for (const button of context.dom.all(
      context.dom.document,
      ".js-delete-env"
    )) {
      bind(rows, button, "click", () => {
        const name = button.getAttribute("data-env") ?? "";
        const prompt = `Delete environment "${name}"? This removes the GitHub environment and its Radius configuration.`;
        if (!name || !options.decisions.confirm(prompt)) return;
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
                  showError(
                    `${
                      error || "Delete the application deployment first."
                    } Redirecting you to delete the application…`
                  );
                  const target = safeDeleteRedirect(
                    readString(result.body, "redirect")
                  );
                  if (redirectTimer !== null) {
                    context.clock.clearTimeout(redirectTimer);
                  }
                  redirectTimer = context.clock.setTimeout(() => {
                    context.nav.assign(target);
                  }, ENVIRONMENT_DELETE_REDIRECT_MS);
                  return;
                }
                options.decisions.notify(
                  error || "Could not delete the environment."
                );
                return;
              }
              loadEnvironmentTable();
            },
            () => {
              if (!active) return;
              setButtonState(button, false, "Delete Env");
              options.decisions.notify(
                "Could not delete the environment. Please try again."
              );
            }
          );
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
      body.innerHTML = environmentRowsMarkup([], options.repo);
      return;
    }
    body.innerHTML =
      '<tr><td colspan="5" style="color:var(--rad-text-tertiary);">Loading environments…</td></tr>';
    void context.net
      .fetch(
        `${ENVIRONMENT_LIST_PATH}?repo=${encodeURIComponent(options.repo)}`,
        listAbort ? { signal: listAbort.signal } : undefined
      )
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then(
        (payload) => {
          if (!active || request !== listRequest) return;
          const environments = parseEnvironmentRecords(payload);
          body.innerHTML = environmentRowsMarkup(environments, options.repo);
          wireRows();
          if (
            environments.some((environment) => environment.status === "pending")
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
          body.innerHTML =
            '<tr><td colspan="5" style="color:var(--rad-text-tertiary);">Could not load environments.</td></tr>';
        }
      );
  };

  const showEnvironmentForm = (preset: EnvironmentFormPreset = {}): void => {
    hideTerminalBanners();
    environmentName.value = preset.name ?? "";
    const clientId = requiredInput(context, "az-client-id");
    if (clientId) clientId.value = "";
    dependencies.clearSharedAppPin();
    hideBanner("deploy-status");
    environmentLanding.style.display = "none";
    environmentForm.style.display = "";
    dependencies.loadProfiles(preset.profile);
    dependencies.loadGitHubIdentity();
    environmentName.focus();
  };

  const showEnvironmentLanding = (): void => {
    environmentForm.style.display = "none";
    environmentLanding.style.display = "";
    // The form's controls are now hidden, so keyboard focus has to come back to
    // the control that reveals it instead of being dropped onto the document.
    context.dom.byId("new-env-btn")?.focus();
    loadEnvironmentTable();
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
      dependencies.loadProfiles(profileSelect.value);
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

  const controller: EnvironmentPaneController = {
    switchSubtab,
    loadEnvironmentTable,
    showEnvironmentForm,
    showEnvironmentLanding,
    hideTerminalBanners,
    showSuccess(provider, name) {
      const banner = context.dom.byId("env-success-banner");
      const text = context.dom.byId("env-success-banner-text");
      if (!banner || !text) return;
      text.innerHTML = `Successfully created <strong>${escapeBrowserHtml(
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
      const hasPullRequest = /^https:\/\/github\.com\//.test(pullRequestUrl);
      let html = `<strong>${escapeBrowserHtml(
        providerLabel(provider)
      )}</strong> Environment <strong>${escapeBrowserHtml(
        name
      )}</strong> is set up, but one step is left for you. `;
      if (hasPullRequest) {
        html +=
          "Radius could not push the deploy workflows to the default branch, so it opened a pull request. Credential verification and deploys start working once it merges.";
      } else if (readString(terminal, "userMessage")) {
        // A non-PR action-required outcome (e.g. incomplete cloud credentials,
        // issue #219) carries its own guidance; show it verbatim rather than the
        // open-a-pull-request text, which would not apply.
        html += escapeBrowserHtml(readString(terminal, "userMessage"));
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
      if (redirectTimer !== null) {
        context.clock.clearTimeout(redirectTimer);
        redirectTimer = null;
      }
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
