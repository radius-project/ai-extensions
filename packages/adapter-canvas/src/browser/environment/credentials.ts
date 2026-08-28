// Canvas adapter — importable browser behavior for the Credentials sub-tab:
// the credential profile table, the Azure/AWS provider form, GitHub Packages
// access verification, and credential save/delete. Root-page initialization,
// deep-linking, and resuming an in-flight operation belong to the page
// controller that composes this module with the Environments pane, not here.

import { createCommandAction } from "../command-action.js";
import type { CommandActionHandle } from "../command-action.js";
import { escapeBrowserHtml } from "../html.js";
import { beginEntry, NOOP_TEARDOWN } from "../lifecycle.js";
import { isRecord, readArray, readBoolean, readString } from "../json.js";
import { environmentStatusMarkup, providerLabel } from "./environments.js";
import type { BrowserTeardown } from "../lifecycle.js";
import type {
  BrowserContext,
  DomElement,
  DomEventListener,
  DomEventTarget
} from "../ports.js";
import type {
  EnvironmentDecisionPort,
  EnvironmentFormPreset
} from "./environments.js";
import type { RemediationView } from "@radius-project/core/remediations";
import type { EnvironmentConfirmDialog } from "./confirm-dialog.js";
import {
  BARE_GH_COMMAND_PRESENTATION,
  displayGhCommand,
  presentedRemediationView,
  type GhCommandPresentation
} from "../../gh-command-display.js";

export const CREDENTIALS_ENTRY_KEY = "environment-credentials";
export const CREDENTIAL_PROFILES_PATH = "/api/credential-profiles";
export const CREDENTIAL_DELETE_PATH = "/api/delete-credential-profile";
export const CREDENTIAL_SAVE_PATH = "/api/save-credential-profile";
export const GITHUB_IDENTITY_PATH = "/api/github-identity";
export const VERIFY_AZURE_PATH = "/api/verify-azure-login";
export const VERIFY_AWS_PATH = "/api/verify-aws-login";
/**
 * Rebuild a remediation view from a server payload.
 *
 * Only the id and its parameters are taken from the payload; the command text
 * is rebuilt locally from the registry, so a payload can never name a command
 * of its own. A remediation that does not resolve is dropped rather than shown
 * as an action that cannot run.
 */
export function payloadRemediation(
  payload: unknown,
  ghCommandPresentation: GhCommandPresentation = BARE_GH_COMMAND_PRESENTATION
): RemediationView | null {
  if (!isRecord(payload)) return null;
  const entry = payload["remediation"];
  if (!isRecord(entry)) return null;
  const view = presentedRemediationView(
    entry["id"],
    entry["params"],
    ghCommandPresentation
  );
  return view.runnable ? view : null;
}

export interface CredentialProfile {
  name: string;
  provider: string;
  status: string;
  tenantId: string;
  subscriptionId: string;
  accountId: string;
  region: string;
  roleArn: string;
}

export type VerifiedCredentials =
  | {
      readonly provider: "azure";
      readonly user: string;
      readonly tenantId: string;
      readonly subscriptionId: string;
      readonly subscriptionName: string;
    }
  | {
      readonly provider: "aws";
      readonly user: string;
      readonly accountId: string;
      readonly region: string;
    };

export interface GitHubPackagesAccount {
  readonly login: string;
  readonly hasPackages: boolean;
  readonly switchable: boolean;
}

export interface GitHubPackagesIdentity {
  error: string;
  actingLogin: string;
  actingHasPackages: boolean;
  accounts: readonly GitHubPackagesAccount[];
  // The credential that will actually publish the package, which is not always
  // the acting login: a Copilot session token overrides stored `gh` logins.
  packagesLogin: string;
  packagesHasWrite: boolean | undefined;
  packagesCredentialSource: string;
}

export interface GitHubAccessView {
  packagesVerified: boolean;
  statusText: string;
  statusHtml: string | null;
  statusColor: string;
  commandVisible: boolean;
  remediation: RemediationView | null;
  retryVisible: boolean;
}

export interface CredentialsPaneDependencies {
  selectEnvironmentsSubtab(): void;
  openEnvironmentForm(preset: EnvironmentFormPreset): void;
  credentialCreated(name: string): void;
}

export interface CredentialsPaneOptions {
  repo: string;
  /** Nonce for mutating requests; run-command hand-off is rejected without it. */
  mutationNonce: string;
  ghCommandPresentation?: GhCommandPresentation;
  decisions: EnvironmentDecisionPort;
  confirmDialog?: EnvironmentConfirmDialog;
}

export interface CredentialsPaneController {
  loadCredentialTable(): void;
  startWizardCreation(): void;
  endWizardCreation(): void;
  teardown(): void;
}

interface Registration {
  target: DomEventTarget;
  type: string;
  listener: DomEventListener;
}

export function parseCredentialProfiles(payload: unknown): CredentialProfile[] {
  return readArray(payload, "profiles")
    .filter(isRecord)
    .map((entry) => ({
      name: readString(entry, "name"),
      provider: readString(entry, "provider"),
      status: readString(entry, "status") || "verified",
      tenantId: readString(entry, "tenantId"),
      subscriptionId: readString(entry, "subscriptionId"),
      accountId: readString(entry, "accountId"),
      region: readString(entry, "region"),
      roleArn: readString(entry, "roleArn")
    }))
    .filter((entry) => entry.name !== "");
}

export function credentialRowsMarkup(
  profiles: readonly CredentialProfile[]
): string {
  if (profiles.length === 0) {
    return '<tr><td class="rad-table__env">No credential profiles created yet.</td><td></td><td></td><td class="rad-table__actions"></td></tr>';
  }
  return profiles
    .map((profile) => {
      const name = escapeBrowserHtml(profile.name);
      return (
        "<tr>" +
        `<td class="rad-table__env">${name}</td>` +
        `<td class="rad-table__provider">${escapeBrowserHtml(
          providerLabel(profile.provider)
        )}</td>` +
        `<td>${environmentStatusMarkup(profile.status)}</td>` +
        '<td class="rad-table__actions">' +
        `<button class="rad-btn rad-btn--neutral js-cred-createenv" data-name="${name}" style="margin:0;">Create Env</button>` +
        `<button class="rad-btn rad-btn--danger-outline js-cred-delete" data-name="${name}" style="margin:0;">Delete Profile</button>` +
        "</td></tr>"
      );
    })
    .join("");
}

export function parseGitHubPackagesIdentity(
  payload: unknown
): GitHubPackagesIdentity {
  const packagesHasWrite =
    isRecord(payload) ? payload["packagesHasWrite"] : undefined;
  const accounts: GitHubPackagesAccount[] = [];
  for (const entry of readArray(payload, "accounts")) {
    if (!isRecord(entry)) continue;
    const login = readString(entry, "login");
    if (login === "") continue;
    accounts.push({
      login,
      hasPackages: readBoolean(entry, "hasPackages"),
      switchable: readBoolean(entry, "switchable")
    });
  }
  return {
    error: readString(payload, "error"),
    actingLogin: readString(payload, "actingLogin"),
    actingHasPackages: readBoolean(payload, "actingHasPackages"),
    accounts,
    packagesLogin: readString(payload, "packagesLogin"),
    packagesHasWrite:
      typeof packagesHasWrite === "boolean" ? packagesHasWrite : undefined,
    packagesCredentialSource: readString(payload, "packagesCredentialSource")
  };
}

/**
 * Whether the credential that will publish the package can write packages.
 *
 * The server reports the publishing credential explicitly when it knows it. A
 * record from before that field existed carries no source, and only then does
 * the acting account's scope stand in for it.
 */
export function packagesCredentialCanWrite(
  identity: GitHubPackagesIdentity
): boolean {
  if (identity.packagesHasWrite === true) return true;
  return identity.packagesCredentialSource === "" && identity.actingHasPackages;
}

function packagesCredentialLogin(identity: GitHubPackagesIdentity): string {
  return identity.packagesLogin || identity.actingLogin;
}

export function renderGitHubAccessView(
  identity: GitHubPackagesIdentity,
  ghCommandPresentation: GhCommandPresentation = BARE_GH_COMMAND_PRESENTATION
): GitHubAccessView {
  // No account we can name, so there is no command we can offer. Both the
  // unreadable-identity case and an acting login the registry will not accept
  // land here, because in either one Radius cannot build the switch safely.
  const noAccount: GitHubAccessView = {
    packagesVerified: false,
    statusText:
      ghCommandPresentation.kind === "unavailable" ?
        ghCommandPresentation.installationNote
      : `Could not detect a GitHub CLI account. Sign in with ${displayGhCommand(
          ghCommandPresentation,
          ["auth", "login"]
        )}, then retry. ${ghCommandPresentation.installationNote}`.trim(),
    statusHtml: null,
    statusColor: "var(--rad-danger)",
    commandVisible: false,
    remediation: null,
    retryVisible: false
  };
  if (identity.error !== "" || identity.actingLogin === "") {
    return noAccount;
  }
  const login = packagesCredentialLogin(identity);
  if (packagesCredentialCanWrite(identity)) {
    const source =
      identity.packagesCredentialSource === "injected-token" ?
        "the Copilot session token"
      : "the stored GitHub CLI credential";
    return {
      packagesVerified: true,
      statusText: "",
      statusHtml: `✓ GitHub Packages access verified for <strong>@${escapeBrowserHtml(
        login
      )}</strong> using ${source}.`,
      statusColor: "var(--rad-primary)",
      commandVisible: false,
      remediation: null,
      retryVisible: false
    };
  }
  if (identity.packagesCredentialSource === "injected-token") {
    // An injected session token cannot be repaired with `gh auth switch` or
    // `gh auth refresh`, so the picker is only worth naming when a stored,
    // switchable account already holds write:packages. Otherwise the only real
    // fix is signing one in with those scopes.
    const alternative =
      identity.accounts.find(
        (account) =>
          account.switchable && account.hasPackages && account.login !== login
      ) ?? null;
    return {
      packagesVerified: false,
      statusText: "",
      statusHtml:
        `The Copilot session token for <strong>@${escapeBrowserHtml(
          login
        )}</strong> cannot publish packages. This token overrides stored ` +
        "<code>gh</code> logins, so <code>gh auth switch</code> and " +
        "<code>gh auth refresh</code> do not change it. " +
        (alternative ?
          `Select the stored account <strong>@${escapeBrowserHtml(
            alternative.login
          )}</strong> in Create Environment, or restart the session with a token that has <code>write:packages</code>.`
        : "No stored GitHub CLI account can publish packages either — run the command below to sign one in, then retry, or restart the session with a token that has <code>write:packages</code>."),
      statusColor: "var(--rad-warning)",
      commandVisible: alternative === null,
      remediation:
        alternative === null ?
          presentedRemediationView(
            "github-cli-login",
            { packages: "true" },
            ghCommandPresentation
          )
        : null,
      retryVisible: true
    };
  }
  // Resolve the command here rather than at the mount site. A non-empty login
  // is not necessarily one the registry will build a command from, and when
  // the row's visibility was decided separately the two disagreed: the row
  // appeared, empty, under status text telling the user to run the command
  // below. One answer drives the status, the row, and the callout.
  // Target the credential that actually publishes, not the acting account: the
  // acting account may already hold write:packages, in which case refreshing it
  // changes nothing and the publisher stays broken.
  const remediation = presentedRemediationView(
    "github-packages-scope",
    { login },
    ghCommandPresentation
  );
  if (!remediation.runnable) {
    return noAccount;
  }
  return {
    packagesVerified: false,
    statusText: "",
    statusHtml:
      `The stored GitHub CLI credential for <strong>@${escapeBrowserHtml(
        login
      )}</strong> cannot publish packages. Run the command below, complete the GitHub authorization, then retry. ` +
      "<strong>Note:</strong> <code>gh auth switch</code> changes the active account machine-wide until you switch back.",
    statusColor: "var(--rad-warning)",
    commandVisible: true,
    remediation,
    retryVisible: true
  };
}

function setButtonState(
  button: DomElement,
  disabled: boolean,
  text: string
): void {
  Reflect.set(button, "disabled", disabled);
  button.textContent = text;
}

function bind(
  registrations: Registration[],
  target: DomEventTarget,
  type: string,
  listener: DomEventListener
): void {
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

export function initializeCredentialsPane(
  context: BrowserContext,
  options: CredentialsPaneOptions,
  dependencies: CredentialsPaneDependencies
): CredentialsPaneController | BrowserTeardown {
  const credLanding = context.dom.byId("cred-landing");
  const credForm = context.dom.byId("cred-form");
  const credFormCard = context.dom.byId("cred-form-card");
  const credFormTitle = context.dom.byId("cred-form-title");
  const wizardFormHost = context.dom.byId("env-cred-form-host");
  const wizardStepCard = context.dom.byId("env-step-credentials-card");
  const credProviderSelect = context.dom.selectById("cred-provider-select");
  const credPanelAzure = context.dom.byId("cred-panel-azure");
  const credPanelAws = context.dom.byId("cred-panel-aws");
  const credTableBody = context.dom.byId("cred-table-body");
  const newCredBtn = context.dom.byId("new-cred-btn");
  const cancelCredBtn = context.dom.byId("cancel-cred-btn");
  const credSuccessBanner = context.dom.byId("cred-success-banner");
  const credSuccessBannerText = context.dom.byId("cred-success-banner-text");
  const credSuccessBannerClose = context.dom.byId("cred-success-banner-close");
  const credNameInput = context.dom.inputById("cred-name-input");
  const azTenantId = context.dom.inputById("az-tenant-id");
  const azSubId = context.dom.inputById("az-sub-id");
  const awsAccountId = context.dom.inputById("aws-account-id");
  const awsRegion = context.dom.inputById("aws-region");
  const awsRoleArn = context.dom.inputById("aws-role-arn");
  const credVerifyStatus = context.dom.byId("cred-verify-status");
  const credVerifyHint = context.dom.byId("cred-verify-hint");
  const saveCredBtn = context.dom.inputById("save-cred-btn");
  const btnVerifyAzure = context.dom.inputById("btn-verify-azure");
  const btnVerifyAws = context.dom.inputById("btn-verify-aws");
  const credGhcrStatus = context.dom.byId("cred-ghcr-status");
  const credGhcrCommandRow = context.dom.byId("cred-ghcr-command-row");
  const credGhcrRetry = context.dom.inputById("cred-ghcr-retry");
  const credVerifyAction = context.dom.byId("cred-verify-action");
  const envVerifyModal = context.dom.byId("env-verify-modal");
  const envVerifyTitle = context.dom.byId("env-verify-title");

  if (
    !credLanding ||
    !credForm ||
    !credFormCard ||
    !credFormTitle ||
    !wizardFormHost ||
    !wizardStepCard ||
    !credProviderSelect ||
    !credPanelAzure ||
    !credPanelAws ||
    !credTableBody ||
    !newCredBtn ||
    !cancelCredBtn ||
    !credSuccessBanner ||
    !credSuccessBannerText ||
    !credSuccessBannerClose ||
    !credNameInput ||
    !azTenantId ||
    !azSubId ||
    !awsAccountId ||
    !awsRegion ||
    !awsRoleArn ||
    !credVerifyStatus ||
    !credVerifyHint ||
    !saveCredBtn ||
    !btnVerifyAzure ||
    !btnVerifyAws ||
    !credGhcrStatus ||
    !credGhcrCommandRow ||
    !credGhcrRetry ||
    !credVerifyAction ||
    !envVerifyModal ||
    !envVerifyTitle
  ) {
    return NOOP_TEARDOWN;
  }

  const scope = beginEntry(context, CREDENTIALS_ENTRY_KEY);
  if (!scope) return NOOP_TEARDOWN;

  const rows: Registration[] = [];
  let tableRequest = 0;
  let tableAbort = context.net.createAbort();
  // Bumped whenever the form context changes (opening/reopening the form for
  // a different profile, returning to the landing table, or restarting
  // verification). Async verify/save responses compare against this
  // token so a response for an earlier form/profile/provider can never
  // overwrite the state of whatever the user is looking at now.
  let formToken = 0;
  let ghChecking = false;
  let credVerified: VerifiedCredentials | null = null;
  let credPackagesVerified = false;
  let formContext: "standalone" | "wizard" = "standalone";
  let active = true;

  const updateSaveState = (): void => {
    saveCredBtn.disabled = !(credVerified !== null && credPackagesVerified);
  };

  const applyProvider = (provider: string): void => {
    const isAws = provider === "aws";
    credPanelAzure.style.display = isAws ? "none" : "";
    credPanelAws.style.display = isAws ? "" : "none";
  };

  const commandActions = new Map<DomElement, CommandActionHandle>();
  const mountCommandAction = (
    host: DomElement,
    remediation: RemediationView | null,
    idPrefix: string
  ): void => {
    commandActions.get(host)?.dispose();
    commandActions.delete(host);
    if (remediation === null) {
      host.replaceChildren();
      return;
    }
    commandActions.set(
      host,
      createCommandAction(context, {
        host,
        remediation,
        mutationNonce: options.mutationNonce,
        idPrefix
      })
    );
  };

  const resetVerification = (): void => {
    formToken += 1;
    credVerified = null;
    mountCommandAction(credVerifyAction, null, "cred-verify");
    credVerifyStatus.style.display = "none";
    credVerifyStatus.innerHTML = "";
    credVerifyHint.style.display = "";
    updateSaveState();
  };

  const verifyError = (
    message: string,
    remediation: RemediationView | null = null
  ): void => {
    credVerifyStatus.style.display = "block";
    credVerifyStatus.innerHTML = `<span style="color:var(--rad-danger);">${escapeBrowserHtml(
      message
    )}</span>`;
    mountCommandAction(credVerifyAction, remediation, "cred-verify");
  };

  const markVerified = (verified: VerifiedCredentials): void => {
    credVerified = verified;
    credVerifyStatus.style.display = "flex";
    credVerifyStatus.innerHTML =
      '<span class="rad-verified-pill">✓ Credentials verified</span>' +
      (verified.user ?
        `<span class="rad-verified-meta">Logged in as <strong>${escapeBrowserHtml(
          verified.user
        )}</strong></span>`
      : "");
    credVerifyHint.style.display = "none";
    updateSaveState();
  };

  const applyGitHubAccessView = (identity: GitHubPackagesIdentity): void => {
    const view = renderGitHubAccessView(
      identity,
      options.ghCommandPresentation
    );
    credPackagesVerified = view.packagesVerified;
    credGhcrCommandRow.style.display = view.commandVisible ? "block" : "none";
    credGhcrRetry.style.display = view.retryVisible ? "" : "none";
    if (view.statusHtml !== null) {
      credGhcrStatus.innerHTML = view.statusHtml;
    } else {
      credGhcrStatus.textContent = view.statusText;
    }
    credGhcrStatus.style.color = view.statusColor;
    mountCommandAction(credGhcrCommandRow, view.remediation, "cred-ghcr");
    updateSaveState();
  };

  // Every real call site always requests a fresh identity check (opening the
  // form and the manual retry both need the latest GitHub CLI account), so
  // this always appends the fresh-check query rather than branching on a
  // parameter no caller ever passes as false.
  const loadGitHubAccess = (): void => {
    if (ghChecking) return;
    ghChecking = true;
    credGhcrStatus.textContent = "Checking GitHub Packages access…";
    credGhcrStatus.style.color = "var(--rad-text-tertiary)";
    credGhcrRetry.disabled = true;
    credGhcrRetry.textContent = "Checking…";
    void context.net
      .fetch(`${GITHUB_IDENTITY_PATH}?fresh=1`)
      .then((response) => response.json())
      .then(
        (payload) => parseGitHubPackagesIdentity(payload),
        (): GitHubPackagesIdentity => ({
          error: "GitHub identity check failed",
          actingLogin: "",
          actingHasPackages: false,
          accounts: [],
          packagesLogin: "",
          packagesHasWrite: undefined,
          packagesCredentialSource: ""
        })
      )
      .then((identity) => {
        ghChecking = false;
        if (!active) return;
        applyGitHubAccessView(identity);
        credGhcrRetry.disabled = false;
        credGhcrRetry.textContent = "I’ve updated permissions — retry";
      });
  };

  const loadCredentialTable = (): void => {
    tableAbort?.abort();
    tableAbort = context.net.createAbort();
    const request = ++tableRequest;
    release(rows);
    if (!options.repo) {
      credTableBody.innerHTML = credentialRowsMarkup([]);
      return;
    }
    credTableBody.innerHTML =
      '<tr><td colspan="4" style="color:var(--rad-text-tertiary);">Loading credential profiles…</td></tr>';
    void context.net
      .fetch(
        `${CREDENTIAL_PROFILES_PATH}?repo=${encodeURIComponent(options.repo)}`,
        tableAbort ? { signal: tableAbort.signal } : undefined
      )
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then(
        (payload) => {
          if (!active || request !== tableRequest) return;
          const profiles = parseCredentialProfiles(payload);
          credTableBody.innerHTML = credentialRowsMarkup(profiles);
          wireRows();
        },
        (error: unknown) => {
          if (
            !active ||
            request !== tableRequest ||
            (error instanceof Error && error.name === "AbortError")
          ) {
            return;
          }
          credTableBody.innerHTML =
            '<tr><td colspan="4" style="color:var(--rad-text-tertiary);">Could not load credential profiles.</td></tr>';
        }
      );
  };

  const showLanding = (): void => {
    formToken += 1;
    credForm.style.display = "none";
    credLanding.style.display = "";
    loadCredentialTable();
  };

  const showSuccessBanner = (name: string): void => {
    credSuccessBannerText.innerHTML = `Successfully created credential profile ${escapeBrowserHtml(
      name
    )}`;
    credSuccessBanner.style.display = "flex";
  };

  const saveLabel = (): string =>
    formContext === "wizard" ? "Save & Continue" : "Save Credential Profile";

  const moveFormTo = (host: DomElement): void => {
    host.appendChild(credFormCard);
  };

  const endWizardCreation = (): void => {
    // Leaving the form invalidates any save still in flight, exactly as
    // showLanding does for the standalone form; otherwise a save that resolves
    // after Cancel still passes the token check and reports a created profile.
    formToken += 1;
    wizardFormHost.style.display = "none";
    wizardStepCard.style.display = "";
    moveFormTo(credForm);
    credForm.style.display = "none";
    credLanding.style.display = "";
    formContext = "standalone";
  };

  const showCredentialsForm = (mode: "standalone" | "wizard"): void => {
    formContext = mode;
    credSuccessBanner.style.display = "none";
    credFormTitle.textContent = "Create Credential Profile";
    saveCredBtn.textContent = saveLabel();
    cancelCredBtn.textContent =
      mode === "wizard" ? "Cancel" : "← Back to credentials";
    credNameInput.value = "";
    credProviderSelect.value = "azure";
    applyProvider("azure");
    azTenantId.value = "";
    azSubId.value = "";
    awsAccountId.value = "";
    awsRegion.value = "";
    awsRoleArn.value = "";
    resetVerification();
    credPackagesVerified = false;
    updateSaveState();
    if (mode === "wizard") {
      moveFormTo(wizardFormHost);
      wizardStepCard.style.display = "none";
      wizardFormHost.style.display = "";
    } else {
      endWizardCreation();
      formContext = "standalone";
      moveFormTo(credForm);
      credLanding.style.display = "none";
      credForm.style.display = "";
    }
    loadGitHubAccess();
    credNameInput.focus();
  };

  const deleteCredentialProfile = (name: string, button: DomElement): void => {
    setButtonState(button, true, "Deleting…");
    void context.net
      .fetch(CREDENTIAL_DELETE_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: options.repo, name })
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
            setButtonState(button, false, "Delete Profile");
            options.decisions.notify(
              error || "Could not delete the credential profile."
            );
            return;
          }
          loadCredentialTable();
        },
        () => {
          if (!active) return;
          setButtonState(button, false, "Delete Profile");
          options.decisions.notify(
            "Could not delete the credential profile. Please try again."
          );
        }
      );
  };

  const confirmCredentialDelete = (name: string, button: DomElement): void => {
    setButtonState(button, true, "Checking usage…");
    // Rows are only wired after a repository-scoped fetch succeeds, so a row
    // action always has a repository to look usage up against.
    const usageRequest = context.net
      .fetch(`/api/list-environments?repo=${encodeURIComponent(options.repo)}`)
      .then((response) => {
        // The handler reports its own failures as HTTP 200 with an `error`
        // field, so a non-OK status is not the only failure shape to catch.
        if (!response.ok) throw new Error("list-environments request failed");
        return response.json();
      })
      .then((payload) => {
        if (readString(payload, "error") !== "") {
          throw new Error("list-environments reported an error");
        }
        return {
          usage: readArray(payload, "environments")
            .filter(isRecord)
            .filter(
              (environment) =>
                readString(environment, "credentialProfile") === name
            )
            .map((environment) => readString(environment, "name"))
            .filter((environment) => environment !== ""),
          checked: true
        };
      })
      .catch(() => ({ usage: [] as string[], checked: false }));
    void usageRequest.then(({ usage, checked }) => {
      if (!active) return;
      setButtonState(button, false, "Delete Profile");
      options.confirmDialog?.show({
        title: "Delete credential profile?",
        message: `This deletes the credential profile "${name}". You will not be able to create new environments from it.${
          checked ? "" : (
            "\n\nCould not check which environments use this profile."
          )
        }`,
        usageLabel:
          usage.length === 1 ?
            "This environment was created from this credential profile and will keep working as the environment has stored its own copy of the credential values:"
          : "These environments were created from this credential profile and will keep working as each environment has stored its own copy of the credential values:",
        usage,
        confirmLabel: "Delete profile",
        onConfirm: () => deleteCredentialProfile(name, button)
      });
    });
  };

  function wireRows(): void {
    release(rows);
    for (const button of context.dom.all(
      context.dom.document,
      ".js-cred-createenv"
    )) {
      bind(rows, button, "click", () => {
        const name = button.getAttribute("data-name") ?? "";
        dependencies.selectEnvironmentsSubtab();
        dependencies.openEnvironmentForm({ name: "", profile: name });
      });
    }
    for (const button of context.dom.all(
      context.dom.document,
      ".js-cred-delete"
    )) {
      bind(rows, button, "click", () => {
        const name = button.getAttribute("data-name") ?? "";
        if (name !== "") confirmCredentialDelete(name, button);
      });
    }
  }

  scope.on(credProviderSelect, "change", () => {
    applyProvider(credProviderSelect.value);
    resetVerification();
  });

  scope.on(newCredBtn, "click", () => showCredentialsForm("standalone"));
  scope.on(cancelCredBtn, "click", () => {
    if (formContext === "wizard") {
      endWizardCreation();
      return;
    }
    showLanding();
  });
  scope.on(credSuccessBannerClose, "click", () => {
    credSuccessBanner.style.display = "none";
  });

  scope.on(credGhcrRetry, "click", () => loadGitHubAccess());
  scope.on(btnVerifyAzure, "click", () => {
    const profileName = credNameInput.value.trim();
    const tenantId = azTenantId.value.trim();
    const subId = azSubId.value.trim();
    resetVerification();
    if (!profileName) {
      verifyError("Please enter a Profile Name before verifying.");
      return;
    }
    if (!tenantId || !subId) {
      verifyError(
        "Please enter both a Tenant ID and a Subscription ID before verifying."
      );
      return;
    }
    const token = formToken;
    btnVerifyAzure.disabled = true;
    btnVerifyAzure.textContent = "⏳ Verifying…";
    envVerifyTitle.textContent = "Verifying authentication to Azure…";
    envVerifyModal.style.display = "flex";
    void context.net
      .fetch(VERIFY_AZURE_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId, subscriptionId: subId })
      })
      .then((response) => response.json())
      .then(
        (payload) => {
          if (!active || token !== formToken) return;
          envVerifyModal.style.display = "none";
          btnVerifyAzure.disabled = false;
          btnVerifyAzure.textContent = "Verify Credentials";
          const error = readString(payload, "error");
          if (error !== "") {
            verifyError(
              error,
              payloadRemediation(payload, options.ghCommandPresentation)
            );
            return;
          }
          const returnedTenantId = readString(payload, "tenantId");
          const returnedSubId = readString(payload, "subscriptionId");
          if (returnedTenantId) azTenantId.value = returnedTenantId;
          if (returnedSubId) azSubId.value = returnedSubId;
          markVerified({
            provider: "azure",
            user: readString(payload, "user"),
            tenantId: returnedTenantId || tenantId,
            subscriptionId: returnedSubId || subId,
            subscriptionName: readString(payload, "subscriptionName")
          });
        },
        () => {
          if (!active || token !== formToken) return;
          envVerifyModal.style.display = "none";
          btnVerifyAzure.disabled = false;
          btnVerifyAzure.textContent = "Verify Credentials";
          verifyError("Could not verify credentials. Please try again.");
        }
      );
  });

  scope.on(btnVerifyAws, "click", () => {
    const profileName = credNameInput.value.trim();
    const accountId = awsAccountId.value.trim();
    const region = awsRegion.value.trim();
    resetVerification();
    if (!profileName) {
      verifyError("Please enter a Profile Name before verifying.");
      return;
    }
    const token = formToken;
    btnVerifyAws.disabled = true;
    btnVerifyAws.textContent = "⏳ Verifying…";
    envVerifyTitle.textContent = "Verifying authentication to AWS…";
    envVerifyModal.style.display = "flex";
    void context.net
      .fetch(VERIFY_AWS_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, region })
      })
      .then((response) => response.json())
      .then(
        (payload) => {
          if (!active || token !== formToken) return;
          envVerifyModal.style.display = "none";
          btnVerifyAws.disabled = false;
          btnVerifyAws.textContent = "Verify Credentials";
          const error = readString(payload, "error");
          if (error !== "") {
            verifyError(
              error,
              payloadRemediation(payload, options.ghCommandPresentation)
            );
            return;
          }
          const returnedAccountId = readString(payload, "accountId");
          if (returnedAccountId) awsAccountId.value = returnedAccountId;
          markVerified({
            provider: "aws",
            user: readString(payload, "user") || readString(payload, "arn"),
            accountId: returnedAccountId || accountId,
            region
          });
        },
        () => {
          if (!active || token !== formToken) return;
          envVerifyModal.style.display = "none";
          btnVerifyAws.disabled = false;
          btnVerifyAws.textContent = "Verify Credentials";
          verifyError("Could not verify credentials. Please try again.");
        }
      );
  });

  scope.on(saveCredBtn, "click", () => {
    const name = credNameInput.value.trim();
    if (!name) {
      options.decisions.notify("Please enter a profile name.");
      return;
    }
    if (!credVerified) {
      options.decisions.notify("Please verify your credentials first.");
      return;
    }
    const provider = credVerified.provider;
    const profile: Record<string, string> = {
      repo: options.repo,
      name,
      provider,
      user: credVerified.user || ""
    };
    if (credVerified.provider === "azure") {
      profile.tenantId = credVerified.tenantId;
      profile.subscriptionId = credVerified.subscriptionId;
      profile.subscriptionName = credVerified.subscriptionName;
    } else {
      profile.accountId = credVerified.accountId;
      profile.region = credVerified.region;
      profile.roleArn = awsRoleArn.value.trim();
    }
    const token = formToken;
    const wizard = formContext === "wizard";
    saveCredBtn.disabled = true;
    saveCredBtn.textContent = "Saving…";
    void context.net
      .fetch(CREDENTIAL_SAVE_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile)
      })
      .then((response) => response.json())
      .then(
        (payload) => {
          if (!active || token !== formToken) return;
          saveCredBtn.disabled = false;
          saveCredBtn.textContent = saveLabel();
          const error = readString(payload, "error");
          if (error !== "") {
            options.decisions.notify(`Could not save profile: ${error}`);
            return;
          }
          if (wizard) {
            endWizardCreation();
            dependencies.credentialCreated(name);
          } else {
            showLanding();
            showSuccessBanner(name);
          }
        },
        () => {
          if (!active || token !== formToken) return;
          saveCredBtn.disabled = false;
          saveCredBtn.textContent = saveLabel();
          options.decisions.notify(
            "Could not save the credential profile. Please try again."
          );
        }
      );
  });

  return {
    loadCredentialTable,
    startWizardCreation() {
      showCredentialsForm("wizard");
    },
    endWizardCreation,
    teardown() {
      if (!active) return;
      active = false;
      tableAbort?.abort();
      release(rows);
      for (const action of commandActions.values()) action.dispose();
      commandActions.clear();
      scope.teardown();
    }
  };
}

export function isCredentialsPaneController(
  value: CredentialsPaneController | BrowserTeardown
): value is CredentialsPaneController {
  return "loadCredentialTable" in value;
}
