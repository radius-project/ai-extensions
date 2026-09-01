// Canvas adapter — importable browser behavior for the environment form's
// credential-profile combo and the GitHub identity setup acts as.
//
// Translated from the inline scripts previously carried as strings in
// pages/environment/client-profiles.ts. `discoverResources` and the current
// `selectedProfile` are owned by the sibling discovery module and the
// composing environment page controller respectively, so both cross into this
// module only through the explicit `CredentialProfilesPanelDeps` a parent
// injects — never through a shared browser global.

import { isDomElement } from "../context.js";
import { createCommandAction } from "../command-action.js";
import type { CommandActionHandle } from "../command-action.js";
import { isRemediationId } from "@radius-project/core/remediations";
import type { RemediationView } from "@radius-project/core/remediations";
import {
  BARE_GH_COMMAND_PRESENTATION,
  displayGhCommand,
  presentedRemediationView,
  type GhCommandPresentation
} from "../../gh-command-display.js";
import { setChildren } from "../dom.js";
import type { ElementSpec } from "../dom.js";
import { beginEntry } from "../lifecycle.js";
import { isRecord, readArray, readBoolean, readString } from "../json.js";
import type {
  BrowserContext,
  DomElement,
  DomEventListener,
  DomEventTarget
} from "../ports.js";
import type { ScopeTimer } from "../lifecycle.js";

export const PROFILES_PANEL_ENTRY_KEY = "environment-profiles-panel";
export const CREDENTIAL_PROFILES_ENDPOINT = "/api/credential-profiles";
export const GITHUB_IDENTITY_ENDPOINT = "/api/github-identity";
export const GITHUB_ACCOUNT_ENDPOINT = "/api/github-account";
export const GITHUB_ENVIRONMENT_RECHECK_DELAY_MS = 2_000;
export const PROFILE_PLACEHOLDER_TEXT = "Select a credential profile…";

export const PROFILE_MENU_IDS = {
  button: "env-profile-button",
  menu: "env-profile-menu",
  value: "env-profile-value",
  options: "env-profile-options",
  empty: "env-profile-empty",
  combo: "env-profile-combo",
  select: "env-profile-select",
  status: "env-profile-status"
} as const;

export const GITHUB_IDENTITY_IDS = {
  field: "env-gh-identity-field",
  button: "env-gh-account-button",
  menu: "env-gh-account-menu",
  value: "env-gh-account-value",
  options: "env-gh-account-options",
  empty: "env-gh-account-empty",
  combo: "env-gh-account-combo",
  note: "env-gh-identity-note",
  recheck: "env-gh-recheck",
  details: "env-gh-technical-details",
  repair: "env-gh-repair"
} as const;

export type CredentialProvider = "azure" | "aws";

export interface CredentialProfile {
  readonly name: string;
  readonly provider: string;
  readonly subscriptionId?: string;
  readonly subscriptionName?: string;
  readonly tenantId?: string;
  readonly accountId?: string;
  readonly region?: string;
  readonly roleArn?: string;
  readonly user?: string;
}

export interface GithubAccountSummary {
  readonly login: string;
  readonly hasWorkflow: boolean;
  readonly hasPackages: boolean;
  readonly switchable: boolean;
}

export interface GithubIdentity {
  readonly error: string;
  readonly actingLogin: string;
  readonly displayLogin: string;
  readonly mismatch: boolean;
  readonly repoAccess: string;
  readonly actingHasWorkflow: boolean;
  readonly actingHasPackages: boolean;
  // The credential that will actually publish the state package, which is not
  // always the acting login: a Copilot session token overrides stored `gh`
  // logins and cannot be repaired with `gh auth switch`/`refresh`.
  readonly packagesLogin: string;
  readonly packagesHasWrite: boolean | undefined;
  readonly packagesCredentialSource: string;
  readonly accounts: readonly GithubAccountSummary[];
}

export interface GithubReadiness {
  readonly ready: boolean;
  readonly login: string;
  readonly credentialSource: string;
  readonly summary: string;
  readonly repair: string;
  readonly repairRemediation: RemediationView | null;
  readonly selectionHandle: string;
  readonly checks: Readonly<Record<string, GithubReadinessCheck>>;
}

export interface GithubReadinessCheck {
  readonly state: string;
  readonly detail: string;
}

export interface GithubIdentityNote {
  readonly specs: readonly ElementSpec[];
  readonly tone: "warning" | "muted";
  readonly showRecheck: boolean;
}

function textNote(message: string): readonly ElementSpec[] {
  return [{ tag: "span", text: message }];
}

function optionalString(value: unknown, key: string): string | undefined {
  const text = readString(value, key);
  return text === "" ? undefined : text;
}

function parseCredentialProfile(entry: unknown): CredentialProfile | null {
  if (!isRecord(entry)) return null;
  const name = readString(entry, "name");
  if (name === "") return null;
  return {
    name,
    provider: readString(entry, "provider"),
    subscriptionId: optionalString(entry, "subscriptionId"),
    subscriptionName: optionalString(entry, "subscriptionName"),
    tenantId: optionalString(entry, "tenantId"),
    accountId: optionalString(entry, "accountId"),
    region: optionalString(entry, "region"),
    roleArn: optionalString(entry, "roleArn"),
    user: optionalString(entry, "user")
  };
}

export function parseCredentialProfiles(payload: unknown): CredentialProfile[] {
  const profiles: CredentialProfile[] = [];
  for (const entry of readArray(payload, "profiles")) {
    const profile = parseCredentialProfile(entry);
    if (profile) profiles.push(profile);
  }
  return profiles;
}

function parseGithubAccount(entry: unknown): GithubAccountSummary | null {
  if (!isRecord(entry)) return null;
  const login = readString(entry, "login");
  if (login === "") return null;
  return {
    login,
    hasWorkflow: readBoolean(entry, "hasWorkflow"),
    hasPackages: readBoolean(entry, "hasPackages"),
    switchable: readBoolean(entry, "switchable")
  };
}

export function parseGithubIdentity(payload: unknown): GithubIdentity {
  const accounts: GithubAccountSummary[] = [];
  for (const entry of readArray(payload, "accounts")) {
    const account = parseGithubAccount(entry);
    if (account) accounts.push(account);
  }
  const packagesHasWrite =
    isRecord(payload) ? payload["packagesHasWrite"] : undefined;
  return {
    error: readString(payload, "error"),
    actingLogin: readString(payload, "actingLogin"),
    displayLogin: readString(payload, "displayLogin"),
    mismatch: readBoolean(payload, "mismatch"),
    repoAccess: readString(payload, "repoAccess"),
    actingHasWorkflow: readBoolean(payload, "actingHasWorkflow"),
    actingHasPackages: readBoolean(payload, "actingHasPackages"),
    packagesLogin: readString(payload, "packagesLogin"),
    packagesHasWrite:
      typeof packagesHasWrite === "boolean" ? packagesHasWrite : undefined,
    packagesCredentialSource: readString(payload, "packagesCredentialSource"),
    accounts
  };
}

export function parseGithubReadiness(
  payload: unknown,
  ghCommandPresentation: GhCommandPresentation = BARE_GH_COMMAND_PRESENTATION
): GithubReadiness {
  const readiness =
    isRecord(payload) && isRecord(payload.readiness) ? payload.readiness : {};
  const checksValue =
    isRecord(readiness) && isRecord(readiness.checks) ? readiness.checks : {};
  const checks: Record<string, GithubReadinessCheck> = {};
  for (const [name, value] of Object.entries(checksValue)) {
    if (!isRecord(value)) continue;
    checks[name] = {
      state: readString(value, "state"),
      detail: readString(value, "detail")
    };
  }
  return {
    ready: readBoolean(readiness, "ready"),
    login: readString(readiness, "login"),
    credentialSource: readString(readiness, "credentialSource"),
    summary: readString(readiness, "summary"),
    repair: readString(readiness, "repair"),
    // The server names the remediation; core builds the command. The page is
    // never trusted with the command text itself.
    repairRemediation: (() => {
      const raw = readiness.repairRemediation;
      if (!isRecord(raw)) return null;
      const id = readString(raw, "id");
      if (!isRemediationId(id)) return null;
      const params: Record<string, string> = {};
      if (isRecord(raw.params)) {
        for (const [key, value] of Object.entries(raw.params)) {
          if (typeof value === "string") params[key] = value;
        }
      }
      const view = presentedRemediationView(id, params, ghCommandPresentation);
      return view.runnable ? view : null;
    })(),
    selectionHandle: readString(payload, "selectionHandle"),
    checks
  };
}

/**
 * A stored account that could publish the package instead of the credential
 * that cannot. Only a switchable account already holding `write:packages`
 * qualifies: pointing at the picker when nothing there helps is worse than
 * saying no account can.
 */
export function packagesAlternativeAccount(
  identity: GithubIdentity,
  publishingLogin: string
): GithubAccountSummary | null {
  return (
    identity.accounts.find(
      (account) =>
        account.switchable &&
        account.hasPackages &&
        account.login !== publishingLogin
    ) ?? null
  );
}

/**
 * Whether the credential that will publish the state package can write
 * packages. The server reports the publishing credential explicitly when it
 * knows it; only a record from before that field existed falls back to the
 * acting account's scope.
 */
export function githubPackagesWriteAvailable(
  identity: GithubIdentity
): boolean {
  if (identity.packagesHasWrite === true) return true;
  return identity.packagesCredentialSource === "" && identity.actingHasPackages;
}

export function findProfile(
  profiles: readonly CredentialProfile[],
  name: string
): CredentialProfile | null {
  return profiles.find((profile) => profile.name === name) ?? null;
}

export function providerLabel(provider: string | undefined): string {
  if (provider === "aws") return "AWS";
  if (provider === "azure") return "Azure";
  return provider || "—";
}

export function githubAccountLabel(
  account: GithubAccountSummary,
  actingLogin: string
): string {
  return `@${account.login}${account.login === actingLogin ? " ✓" : ""}`;
}

// Mirrors the mutually-exclusive precedence of the legacy inline note builder:
// a repo-access problem outranks an account mismatch, which outranks a missing
// scope, which falls back to the muted "acts as" message.
export function githubIdentityNote(
  identity: GithubIdentity,
  ghCommandPresentation: GhCommandPresentation = BARE_GH_COMMAND_PRESENTATION
): GithubIdentityNote {
  if (identity.repoAccess !== "") {
    return {
      specs: textNote(identity.repoAccess),
      tone: "warning",
      showRecheck: true
    };
  }
  if (identity.mismatch && identity.displayLogin !== "") {
    return {
      specs: textNote(
        `The app shows @${identity.displayLogin} but setup will act as @${identity.actingLogin}. ` +
          "If deployment fails with a permission error, switch to the account that has access to this repo and your Azure tenant."
      ),
      tone: "warning",
      showRecheck: false
    };
  }
  const packagesMissing = !githubPackagesWriteAvailable(identity);
  const installation =
    ghCommandPresentation.installationNote ?
      ` ${ghCommandPresentation.installationNote}`
    : "";
  if (!identity.actingHasWorkflow || packagesMissing) {
    if (
      packagesMissing &&
      identity.packagesCredentialSource === "injected-token"
    ) {
      // Naming a `gh auth refresh` here would send the customer down a dead
      // end: the injected token overrides stored logins, so neither refreshing
      // nor switching a keyring credential changes it. Only offer the account
      // picker when a stored account can actually publish.
      const publishingLogin = identity.packagesLogin || identity.actingLogin;
      const alternative = packagesAlternativeAccount(identity, publishingLogin);
      const loginCommand = displayGhCommand(ghCommandPresentation, [
        "auth",
        "login",
        "-h",
        "github.com",
        "-s",
        "read:packages",
        "-s",
        "write:packages"
      ]);
      let message =
        `The Copilot session token for @${publishingLogin} is missing the write:packages scope. ` +
        "It overrides stored gh credentials, so refreshing or switching a keyring login does not " +
        "change this token. " +
        (alternative ?
          `Select the stored account @${alternative.login} below, or restart the session with package write access.`
        : loginCommand ?
          `No stored GitHub CLI account can publish packages either, so run "${loginCommand}" and re-check, or restart the session with package write access.${installation}`
        : `No stored GitHub CLI account can publish packages either. ${ghCommandPresentation.installationNote} Then re-check, or restart the session with package write access.`);
      // The workflow scope lives on the credential gh commands use, which is
      // not the packages credential — so its guidance still applies and must
      // not be dropped with the packages warning.
      if (!identity.actingHasWorkflow) {
        const switchCommand = displayGhCommand(ghCommandPresentation, [
          "auth",
          "switch",
          "-h",
          "github.com",
          "-u",
          identity.actingLogin
        ]);
        const refreshCommand = displayGhCommand(ghCommandPresentation, [
          "auth",
          "refresh",
          "-h",
          "github.com",
          "-s",
          "workflow"
        ]);
        message +=
          switchCommand && refreshCommand ?
            ` Separately, the credential for @${identity.actingLogin} is missing the workflow scope environment setup needs: run "${switchCommand}\n${refreshCommand}".${installation} Note: gh auth switch changes your active GitHub account machine-wide for every tool in this terminal until you switch back.`
          : ` Separately, the credential for @${identity.actingLogin} is missing the workflow scope environment setup needs. ${ghCommandPresentation.installationNote}`;
      }
      return { specs: textNote(message), tone: "warning", showRecheck: true };
    }
    const missNames: string[] = [];
    if (!identity.actingHasWorkflow) {
      missNames.push("workflow");
    }
    if (packagesMissing) {
      missNames.push("write:packages");
    }
    // Built from the registry rather than hand-written here, so this note shows
    // the same command the callout would run, quoted the same way, and stays
    // paste-able in Windows PowerShell (which cannot parse `&&`).
    const view = presentedRemediationView(
      "github-account-scopes",
      {
        login: identity.actingLogin,
        ...(identity.actingHasWorkflow ? {} : { workflow: "true" }),
        ...(identity.actingHasPackages ? {} : { packages: "true" })
      },
      ghCommandPresentation
    );
    const runLine =
      view.runnable ?
        ` Run:\n${view.command}\n`
      : " Grant the missing scopes with GitHub CLI, ";
    return {
      specs: textNote(
        `The stored GitHub CLI credential for @${identity.actingLogin} is missing the ${missNames.join(" and ")} ` +
          `scope${missNames.length > 1 ? "s" : ""} environment setup needs.${runLine}or switch accounts. ` +
          "Note: gh auth switch changes your active GitHub account machine-wide for every tool in this terminal until you switch back."
      ),
      tone: "warning",
      showRecheck: true
    };
  }
  return {
    specs: [
      { tag: "span", text: "Acts as " },
      { tag: "strong", text: `@${identity.actingLogin}` },
      {
        tag: "span",
        text: " to commit the deploy workflow to your repo and publish the state package. Needs the "
      },
      { tag: "code", text: "workflow" },
      { tag: "span", text: " and " },
      { tag: "code", text: "write:packages" },
      { tag: "span", text: " scopes." }
    ],
    tone: "muted",
    showRecheck: false
  };
}

const TERTIARY_STYLE = "color:var(--rad-text-tertiary);";
const STRONG_STYLE = "color:var(--rad-text);";
// "Verified" is a success status, so it uses the status token rather than
// --rad-primary. --rad-primary is a fixed brand green tuned for solid fills
// behind white text; as small text on the panel background it fails WCAG AA
// contrast, which the Chromium accessibility gate catches. --rad-success is
// mixed toward the active canvas text colour, so it stays legible in both
// themes.
const VERIFIED_STYLE = "color:var(--rad-success);font-weight:600;";

// Mirrors the legacy inline detail markup for the credential-profile summary
// panel, rebuilt as element specs so no interpolated field can re-enter the
// page as markup.
export function profileDetailSpecs(
  profile: CredentialProfile,
  provider: CredentialProvider
): readonly ElementSpec[] {
  const specs: ElementSpec[] = [];
  if (provider === "aws") {
    specs.push({
      tag: "div",
      attrs: { style: `${TERTIARY_STYLE}margin-bottom:4px;` },
      text: "GitHub Actions assumes the IAM role in this profile over OIDC to deploy — no stored secrets."
    });
    const destination =
      (profile.accountId ?? "") +
      (profile.region ? ` · ${profile.region}` : "");
    if (destination.trim() !== "") {
      specs.push({
        tag: "div",
        children: [
          { tag: "span", attrs: { style: TERTIARY_STYLE }, text: "Account: " },
          { tag: "strong", attrs: { style: STRONG_STYLE }, text: destination }
        ]
      });
    }
  } else {
    specs.push({
      tag: "div",
      attrs: { style: `${TERTIARY_STYLE}margin-bottom:4px;` },
      text: "Creates the Entra app, the OIDC trust to your repo, and grants it Contributor on the resource group and AKS RBAC Cluster Admin on the cluster."
    });
    const subscription =
      profile.subscriptionName || profile.subscriptionId || "";
    if (subscription !== "") {
      specs.push({
        tag: "div",
        children: [
          {
            tag: "span",
            attrs: { style: TERTIARY_STYLE },
            text: "Subscription: "
          },
          { tag: "strong", attrs: { style: STRONG_STYLE }, text: subscription }
        ]
      });
    }
  }
  if (profile.user) {
    specs.push({
      tag: "div",
      children: [
        {
          tag: "span",
          attrs: { style: TERTIARY_STYLE },
          text: "Signed in as "
        },
        { tag: "strong", attrs: { style: STRONG_STYLE }, text: profile.user },
        {
          tag: "span",
          attrs: { style: VERIFIED_STYLE },
          text: " · ✓ Verified"
        }
      ]
    });
  } else {
    specs.push({
      tag: "div",
      children: [
        { tag: "span", attrs: { style: VERIFIED_STYLE }, text: "✓ Verified" }
      ]
    });
  }
  return specs;
}

export interface CredentialProfilesPanelDeps {
  readonly repo: string;
  readonly selectableProviders: readonly CredentialProvider[];
  readonly mutationNonce?: string;
  readonly ghCommandPresentation?: GhCommandPresentation;
  environmentName(): string;
  onProfileChange(profile: CredentialProfile | null): void;
  onReadinessChange?(readiness: GithubReadiness | null): void;
  discoverResources(
    provider: CredentialProvider,
    subscriptionId: string,
    tenantId: string
  ): void;
}

export interface CredentialProfilesPanelHandle {
  loadProfiles(preselectName?: string): Promise<void>;
  loadGithubIdentity(fresh?: boolean): Promise<void>;
  invalidateReadiness(): void;
  teardown(): void;
}

interface Registration {
  readonly target: DomEventTarget;
  readonly type: string;
  readonly listener: DomEventListener;
}

function bind(
  into: Registration[],
  target: DomEventTarget,
  type: string,
  listener: DomEventListener
): void {
  target.addEventListener(type, listener);
  into.push({ target, type, listener });
}

function releaseTracked(into: Registration[]): void {
  for (const entry of into.splice(0)) {
    entry.target.removeEventListener(entry.type, entry.listener);
  }
}

function clickedOutside(target: unknown, comboSelector: string): boolean {
  return !isDomElement(target) || target.closest(comboSelector) === null;
}

export function initializeCredentialProfilesPanel(
  context: BrowserContext,
  deps: CredentialProfilesPanelDeps
): CredentialProfilesPanelHandle | null {
  const button = context.dom.byId(PROFILE_MENU_IDS.button);
  const menu = context.dom.byId(PROFILE_MENU_IDS.menu);
  const valueEl = context.dom.byId(PROFILE_MENU_IDS.value);
  const optionsEl = context.dom.byId(PROFILE_MENU_IDS.options);
  const hiddenInput = context.dom.inputById(PROFILE_MENU_IDS.select);
  if (!button || !menu || !valueEl || !optionsEl || !hiddenInput) return null;

  const scope = beginEntry(context, PROFILES_PANEL_ENTRY_KEY);
  if (!scope) return null;

  const emptyEl = context.dom.byId(PROFILE_MENU_IDS.empty);
  const statusEl = context.dom.byId(PROFILE_MENU_IDS.status);
  const providerInput = context.dom.inputById("env-selected-provider");
  const identityAzureEl = context.dom.byId("env-identity-azure");
  const identityAwsEl = context.dom.byId("env-identity-aws");
  const panelAzureEl = context.dom.byId("panel-azure");
  const panelAwsEl = context.dom.byId("panel-aws");
  const deployBtn = context.dom.inputById("deploy-btn");
  const azureRefreshBtn = context.dom.inputById("azure-refresh-btn");
  const awsRefreshBtn = context.dom.inputById("aws-refresh-btn");

  const fieldEl = context.dom.byId(GITHUB_IDENTITY_IDS.field);
  const ghButton = context.dom.byId(GITHUB_IDENTITY_IDS.button);
  const ghValueEl = context.dom.byId(GITHUB_IDENTITY_IDS.value);
  const ghOptionsEl = context.dom.byId(GITHUB_IDENTITY_IDS.options);
  const ghEmptyEl = context.dom.byId(GITHUB_IDENTITY_IDS.empty);
  const noteEl = context.dom.byId(GITHUB_IDENTITY_IDS.note);
  const recheckBtn = context.dom.inputById(GITHUB_IDENTITY_IDS.recheck);
  const detailsEl = context.dom.byId(GITHUB_IDENTITY_IDS.details);
  const repairEl = context.dom.byId(GITHUB_IDENTITY_IDS.repair);

  let repairAction: CommandActionHandle | null = null;
  const mountRepairAction = (
    host: DomElement,
    remediation: RemediationView | null
  ): void => {
    repairAction?.dispose();
    repairAction = null;
    host.replaceChildren();
    if (!remediation) return;
    repairAction = createCommandAction(context, {
      host,
      remediation,
      mutationNonce: deps.mutationNonce || "",
      idPrefix: "env-gh-repair",
      showWarning: false
    });
  };

  let profiles: CredentialProfile[] = [];
  let selectedProfile: CredentialProfile | null = null;
  let profilesToken = 0;
  let githubIdentity: GithubIdentity | null = null;
  let githubReadiness: GithubReadiness | null = null;
  let selectedGithubLogin = "";
  let checking = false;
  let githubRequestGeneration = 0;
  let loadingIdentityGeneration: number | null = null;
  let environmentNameInvalidated = false;
  let environmentRecheckTimer: ScopeTimer | null = null;

  const profileOptionBindings: Registration[] = [];
  const githubAccountOptionBindings: Registration[] = [];
  scope.onTeardown(() => {
    releaseTracked(profileOptionBindings);
    releaseTracked(githubAccountOptionBindings);
  });

  const openProfileMenu = (open?: boolean): void => {
    const show = open === undefined ? menu.style.display === "none" : open;
    menu.style.display = show ? "" : "none";
    button.setAttribute("aria-expanded", show ? "true" : "false");
  };

  const openGhAccountMenu = (open?: boolean): void => {
    const ghMenu = context.dom.byId(GITHUB_IDENTITY_IDS.menu);
    if (!ghMenu) return;
    const show = open === undefined ? ghMenu.style.display === "none" : open;
    ghMenu.style.display = show ? "" : "none";
    if (ghButton)
      ghButton.setAttribute("aria-expanded", show ? "true" : "false");
  };

  const onEnvProfileSelected = (): void => {
    selectedProfile = findProfile(profiles, hiddenInput.value);
    if (!selectedProfile) {
      if (statusEl) statusEl.style.display = "none";
      if (deployBtn) deployBtn.disabled = true;
      if (azureRefreshBtn) azureRefreshBtn.disabled = true;
      if (awsRefreshBtn) awsRefreshBtn.disabled = true;
      deps.onProfileChange(null);
      return;
    }
    const provider: CredentialProvider =
      selectedProfile.provider === "aws" ? "aws" : "azure";
    if (providerInput) providerInput.value = provider;

    if (statusEl) {
      statusEl.style.display = "";
      setChildren(
        context.dom,
        statusEl,
        profileDetailSpecs(selectedProfile, provider)
      );
    }
    if (identityAzureEl)
      identityAzureEl.style.display = provider === "azure" ? "" : "none";
    if (identityAwsEl)
      identityAwsEl.style.display = provider === "aws" ? "" : "none";
    if (panelAzureEl)
      panelAzureEl.style.display = provider === "azure" ? "" : "none";
    if (panelAwsEl) panelAwsEl.style.display = provider === "aws" ? "" : "none";
    if (deployBtn) deployBtn.disabled = false;
    const refreshBtn = provider === "aws" ? awsRefreshBtn : azureRefreshBtn;
    if (refreshBtn) refreshBtn.disabled = false;
    deps.onProfileChange(selectedProfile);
    deps.discoverResources(
      provider,
      selectedProfile.subscriptionId ?? "",
      selectedProfile.tenantId ?? ""
    );
  };

  const setProfileValue = (profile: CredentialProfile | null): void => {
    const name = profile?.name ?? "";
    hiddenInput.value = name;
    if (profile) {
      valueEl.textContent = `${name} (${providerLabel(profile.provider)})`;
      valueEl.classList.remove("rad-combo__value--placeholder");
    } else {
      valueEl.textContent = PROFILE_PLACEHOLDER_TEXT;
      valueEl.classList.add("rad-combo__value--placeholder");
    }
    onEnvProfileSelected();
  };

  const renderProfileOptions = (): void => {
    releaseTracked(profileOptionBindings);
    optionsEl.replaceChildren();
    for (const profile of profiles) {
      const optionButton = context.dom.createElement("button");
      optionButton.setAttribute("type", "button");
      optionButton.className = "rad-combo__option";
      optionButton.setAttribute("role", "option");
      optionButton.setAttribute("data-name", profile.name);
      optionButton.textContent = `${profile.name} (${providerLabel(profile.provider)})`;
      bind(profileOptionBindings, optionButton, "click", () => {
        setProfileValue(profile);
        openProfileMenu(false);
        // Closing the listbox removes the focused option, so hand focus back to
        // the control that owns the value.
        button.focus();
      });
      optionsEl.appendChild(optionButton);
    }
    if (emptyEl) emptyEl.style.display = profiles.length > 0 ? "none" : "";
  };

  const loadProfiles = async (preselectName = ""): Promise<void> => {
    const token = ++profilesToken;
    try {
      const response = await context.net.fetch(
        `${CREDENTIAL_PROFILES_ENDPOINT}?repo=${encodeURIComponent(deps.repo)}`
      );
      const payload = await response.json();
      if (!scope.active || token !== profilesToken) return;
      profiles = parseCredentialProfiles(payload).filter((profile) =>
        deps.selectableProviders.includes(
          profile.provider === "aws" ? "aws" : "azure"
        )
      );
      renderProfileOptions();
      setProfileValue(
        preselectName === "" ? null : findProfile(profiles, preselectName)
      );
    } catch {
      if (!scope.active || token !== profilesToken) return;
      profiles = [];
      renderProfileOptions();
      setProfileValue(null);
    }
  };

  const renderGithubIdentity = (): void => {
    if (!fieldEl || !githubIdentity) return;
    const identity = githubIdentity;
    if (identity.error !== "" || identity.actingLogin === "") {
      fieldEl.style.display = "none";
      if (recheckBtn) recheckBtn.style.display = "none";
      return;
    }
    fieldEl.style.display = "";
    if (ghValueEl) ghValueEl.textContent = `@${selectedGithubLogin}`;

    releaseTracked(githubAccountOptionBindings);
    if (ghOptionsEl) {
      ghOptionsEl.replaceChildren();
      for (const account of identity.accounts) {
        const optionButton = context.dom.createElement("button");
        optionButton.setAttribute("type", "button");
        optionButton.className = "rad-combo__option";
        optionButton.setAttribute("role", "option");
        optionButton.textContent = githubAccountLabel(
          account,
          selectedGithubLogin
        );
        if (
          account.login !== selectedGithubLogin &&
          (account.switchable || account.login === identity.displayLogin)
        ) {
          optionButton.setAttribute("data-login", account.login);
          bind(githubAccountOptionBindings, optionButton, "click", () => {
            void checkGitHubAccount(account.login);
            openGhAccountMenu(false);
            ghButton?.focus();
          });
        } else {
          // ElementStyle has no opacity/cursor: mark the non-actionable row via
          // the disabled attribute and a class hook instead of inline style.
          optionButton.setAttribute("disabled", "disabled");
          optionButton.classList.add("rad-combo__option--disabled");
        }
        ghOptionsEl.appendChild(optionButton);
      }
    }
    if (ghEmptyEl)
      ghEmptyEl.style.display = identity.accounts.length > 0 ? "none" : "";

    if (noteEl && githubReadiness) {
      const remediation = githubReadiness.repairRemediation;
      setChildren(context.dom, noteEl, [
        {
          tag: "strong",
          text:
            githubReadiness.summary ||
            (githubReadiness.ready ?
              "Ready to configure deployments"
            : "Additional GitHub access is required")
        },
        ...(remediation?.warning ?
          [{ tag: "div", text: remediation.warning }]
        : [])
      ]);
      noteEl.style.color =
        githubReadiness.ready ?
          "var(--rad-success, #1a7f37)"
        : "var(--rad-warning, #9a6700)";
      noteEl.style.display = "";
    } else if (noteEl && checking) {
      setChildren(context.dom, noteEl, textNote("Checking GitHub access…"));
      noteEl.style.color = "var(--rad-text-tertiary)";
      noteEl.style.display = "";
    }
    if (recheckBtn) {
      recheckBtn.style.display = "";
      recheckBtn.disabled = checking;
      recheckBtn.textContent = checking ? "Checking…" : "Re-check";
    }
    if (repairEl) {
      const remediation = githubReadiness?.repairRemediation ?? null;
      // A runnable scope gap becomes a callout with Copy and Run. Everything
      // else — a repository grant, a failed restoration — stays prose, because
      // there is no command that would fix it.
      if (remediation) {
        repairEl.style.display = "";
        mountRepairAction(repairEl, remediation);
      } else {
        mountRepairAction(repairEl, null);
        repairEl.textContent = githubReadiness?.repair || "";
        repairEl.style.display = githubReadiness?.repair ? "" : "none";
      }
    }
    if (detailsEl && githubReadiness) {
      const detailSpecs: ElementSpec[] = [];
      for (const [name, check] of Object.entries(githubReadiness.checks)) {
        detailSpecs.push({
          tag: "div",
          text: `${name}: ${check.state} — ${check.detail}`
        });
      }
      detailSpecs.push({
        tag: "div",
        text: `credential source: ${githubReadiness.credentialSource || "unknown"}`
      });
      setChildren(context.dom, detailsEl, detailSpecs);
    }
  };

  const githubIdentityUrl = (fresh: boolean): string => {
    const url = `${GITHUB_IDENTITY_ENDPOINT}?repo=${encodeURIComponent(deps.repo)}`;
    return fresh ? `${url}&fresh=1` : url;
  };

  const loadGithubIdentity = async (fresh = false): Promise<void> => {
    const generation = ++githubRequestGeneration;
    loadingIdentityGeneration = generation;
    checking = true;
    githubReadiness = null;
    deps.onReadinessChange?.(null);
    if (!fresh && ghValueEl) {
      ghValueEl.textContent = "Detecting…";
    }
    try {
      const response = await context.net.fetch(githubIdentityUrl(fresh));
      const payload = await response.json();
      if (!scope.active || generation !== githubRequestGeneration) return;
      githubIdentity = parseGithubIdentity(payload);
      const availableLogins = new Set(
        githubIdentity.accounts.map((account) => account.login)
      );
      if (!availableLogins.has(selectedGithubLogin)) {
        selectedGithubLogin =
          githubIdentity.actingLogin ||
          githubIdentity.displayLogin ||
          githubIdentity.accounts[0]?.login ||
          "";
      }
      renderGithubIdentity();
      const environment = deps.environmentName().trim();
      // A pending debounce owns the account check for the edited environment.
      if (
        selectedGithubLogin &&
        environmentRecheckTimer === null &&
        (!environmentNameInvalidated || environment !== "")
      ) {
        await checkGitHubAccount(selectedGithubLogin);
      }
    } catch {
      if (!scope.active || generation !== githubRequestGeneration) return;
      if (fieldEl) fieldEl.style.display = "none";
      deps.onReadinessChange?.(null);
    } finally {
      if (loadingIdentityGeneration === generation) {
        loadingIdentityGeneration = null;
      }
      if (generation === githubRequestGeneration) {
        checking = false;
        renderGithubIdentity();
      }
    }
  };

  const autoRecheckGithubIdentity = (): void => {
    const packageCheck = githubReadiness?.checks.packages;
    const packageDenied =
      packageCheck?.state === "missing" || packageCheck?.state === "error";
    if (
      (!githubReadiness || !githubReadiness.ready) &&
      !packageDenied &&
      !checking &&
      fieldEl &&
      fieldEl.style.display !== "none"
    ) {
      void checkGitHubAccount(selectedGithubLogin);
    }
  };

  const cancelEnvironmentRecheck = (): void => {
    if (environmentRecheckTimer === null) return;
    scope.cancel(environmentRecheckTimer);
    environmentRecheckTimer = null;
  };

  const invalidateReadiness = (): void => {
    cancelEnvironmentRecheck();
    environmentNameInvalidated = true;
    if (loadingIdentityGeneration !== githubRequestGeneration) {
      githubRequestGeneration += 1;
    }
    githubReadiness = null;
    checking = loadingIdentityGeneration === githubRequestGeneration;
    deps.onReadinessChange?.(null);
    const environment = deps.environmentName().trim();
    const canScheduleRecheck =
      environment !== "" &&
      (selectedGithubLogin !== "" || loadingIdentityGeneration !== null);
    if (noteEl && selectedGithubLogin) {
      setChildren(
        context.dom,
        noteEl,
        textNote(
          canScheduleRecheck ?
            "GitHub access will be checked automatically."
          : "Re-check GitHub access for this environment."
        )
      );
      noteEl.style.color = "var(--rad-warning, #9a6700)";
      noteEl.style.display = "";
    }
    if (recheckBtn) {
      recheckBtn.disabled = false;
      recheckBtn.style.display = "";
      recheckBtn.textContent = "Re-check";
    }
    if (!canScheduleRecheck) return;
    environmentRecheckTimer = scope.after(
      GITHUB_ENVIRONMENT_RECHECK_DELAY_MS,
      () => {
        environmentRecheckTimer = null;
        const currentEnvironment = deps.environmentName().trim();
        if (currentEnvironment === "" || selectedGithubLogin === "") return;
        void checkGitHubAccount(selectedGithubLogin, currentEnvironment);
      }
    );
  };

  const checkGitHubAccount = async (
    login: string,
    environment = deps.environmentName().trim() || "dev"
  ): Promise<void> => {
    cancelEnvironmentRecheck();
    loadingIdentityGeneration = null;
    environmentNameInvalidated = false;
    const generation = ++githubRequestGeneration;
    selectedGithubLogin = login;
    githubReadiness = null;
    checking = true;
    deps.onReadinessChange?.(null);
    renderGithubIdentity();
    try {
      const response = await context.net.fetch(GITHUB_ACCOUNT_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Radius-Mutation-Nonce": deps.mutationNonce || ""
        },
        body: JSON.stringify({
          login,
          repo: deps.repo,
          environment
        })
      });
      const payload = await response.json();
      if (!scope.active || generation !== githubRequestGeneration) return;
      if (!response.ok) {
        throw new Error(
          readString(payload, "error") || "Could not check GitHub access."
        );
      }
      githubReadiness = parseGithubReadiness(
        payload,
        deps.ghCommandPresentation
      );
      deps.onReadinessChange?.(githubReadiness);
    } catch (error) {
      if (!scope.active || generation !== githubRequestGeneration) return;
      githubReadiness = null;
      deps.onReadinessChange?.(null);
      if (noteEl) {
        setChildren(
          context.dom,
          noteEl,
          textNote(
            error instanceof Error && error.message ?
              error.message
            : "Could not check GitHub access."
          )
        );
        noteEl.style.color = "var(--rad-danger, #cf222e)";
        noteEl.style.display = "";
      }
    } finally {
      if (generation === githubRequestGeneration) {
        checking = false;
        renderGithubIdentity();
      }
    }
  };

  scope.on(button, "click", (event) => {
    event.stopPropagation();
    openProfileMenu();
  });
  scope.on(context.dom.document, "click", (event) => {
    if (clickedOutside(event.target, `#${PROFILE_MENU_IDS.combo}`))
      openProfileMenu(false);
  });
  if (ghButton) {
    scope.on(ghButton, "click", (event) => {
      event.stopPropagation();
      openGhAccountMenu();
    });
  }
  scope.on(context.dom.document, "click", (event) => {
    if (clickedOutside(event.target, `#${GITHUB_IDENTITY_IDS.combo}`)) {
      openGhAccountMenu(false);
    }
  });
  if (recheckBtn) {
    scope.on(recheckBtn, "click", () => {
      if (selectedGithubLogin) void checkGitHubAccount(selectedGithubLogin);
    });
  }
  scope.on(context.dom.document, "visibilitychange", () => {
    if (context.dom.document.visibilityState === "visible")
      autoRecheckGithubIdentity();
  });
  scope.on(context.page, "focus", () => {
    autoRecheckGithubIdentity();
  });
  for (const refreshButton of [azureRefreshBtn, awsRefreshBtn]) {
    if (!refreshButton) continue;
    scope.on(refreshButton, "click", () => {
      if (!selectedProfile) return;
      const provider: CredentialProvider =
        selectedProfile.provider === "aws" ? "aws" : "azure";
      deps.discoverResources(
        provider,
        selectedProfile.subscriptionId ?? "",
        selectedProfile.tenantId ?? ""
      );
    });
  }

  return {
    loadProfiles,
    loadGithubIdentity,
    invalidateReadiness,
    teardown() {
      deps.onReadinessChange?.(null);
      scope.teardown();
    }
  };
}
