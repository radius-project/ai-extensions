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
import { setChildren } from "../dom.js";
import type { ElementSpec } from "../dom.js";
import { beginEntry } from "../lifecycle.js";
import { isRecord, readArray, readBoolean, readString } from "../json.js";
import type {
  BrowserContext,
  DomEventListener,
  DomEventTarget
} from "../ports.js";

export const PROFILES_PANEL_ENTRY_KEY = "environment-profiles-panel";
export const CREDENTIAL_PROFILES_ENDPOINT = "/api/credential-profiles";
export const GITHUB_IDENTITY_ENDPOINT = "/api/github-identity";
export const GITHUB_ACCOUNT_ENDPOINT = "/api/github-account";
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
  recheck: "env-gh-recheck"
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
  readonly accounts: readonly GithubAccountSummary[];
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
  return {
    error: readString(payload, "error"),
    actingLogin: readString(payload, "actingLogin"),
    displayLogin: readString(payload, "displayLogin"),
    mismatch: readBoolean(payload, "mismatch"),
    repoAccess: readString(payload, "repoAccess"),
    actingHasWorkflow: readBoolean(payload, "actingHasWorkflow"),
    actingHasPackages: readBoolean(payload, "actingHasPackages"),
    accounts
  };
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
  let label = `@${account.login}`;
  const missingScopes: string[] = [];
  if (!account.hasWorkflow) missingScopes.push("workflow");
  if (!account.hasPackages) missingScopes.push("packages");
  if (missingScopes.length > 0) {
    label += ` — missing ${missingScopes.join(" + ")} scope${
      missingScopes.length > 1 ? "s" : ""
    }`;
  }
  if (!account.switchable) label += " (not switchable)";
  else if (account.login === actingLogin) label += " ✓";
  return label;
}

// Mirrors the mutually-exclusive precedence of the legacy inline note builder:
// a repo-access problem outranks an account mismatch, which outranks a missing
// scope, which falls back to the muted "acts as" message.
export function githubIdentityNote(
  identity: GithubIdentity
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
  if (!identity.actingHasWorkflow || !identity.actingHasPackages) {
    const missNames: string[] = [];
    const refreshScopes: string[] = [];
    if (!identity.actingHasWorkflow) {
      missNames.push("workflow");
      refreshScopes.push("workflow");
    }
    if (!identity.actingHasPackages) {
      missNames.push("write:packages");
      refreshScopes.push("read:packages");
      refreshScopes.push("write:packages");
    }
    const refreshScopeFlags = refreshScopes
      .map((scope) => ` -s ${scope}`)
      .join("");
    const refreshCmd =
      `gh auth switch -h github.com -u ${identity.actingLogin} && ` +
      `gh auth refresh -h github.com${refreshScopeFlags}`;
    return {
      specs: textNote(
        `The active account @${identity.actingLogin} is missing the ${missNames.join(" and ")} ` +
          `scope${missNames.length > 1 ? "s" : ""} environment setup needs. Run "${refreshCmd}" or switch accounts. ` +
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
const VERIFIED_STYLE = "color:var(--rad-primary);font-weight:600;";

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
        { tag: "span", attrs: { style: VERIFIED_STYLE }, text: " · ✓ Verified" }
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
  onProfileChange(profile: CredentialProfile | null): void;
  discoverResources(
    provider: CredentialProvider,
    subscriptionId: string,
    tenantId: string
  ): void;
}

export interface CredentialProfilesPanelHandle {
  loadProfiles(preselectName?: string): Promise<void>;
  loadGithubIdentity(fresh?: boolean): Promise<void>;
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

  let profiles: CredentialProfile[] = [];
  let selectedProfile: CredentialProfile | null = null;
  let profilesToken = 0;
  let githubIdentity: GithubIdentity | null = null;
  let scopeWarnActive = false;
  let checking = false;

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
      profiles = parseCredentialProfiles(payload);
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
      scopeWarnActive = false;
      if (recheckBtn) recheckBtn.style.display = "none";
      return;
    }
    fieldEl.style.display = "";
    if (ghValueEl) ghValueEl.textContent = `@${identity.actingLogin}`;

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
          identity.actingLogin
        );
        if (account.switchable && account.login !== identity.actingLogin) {
          optionButton.setAttribute("data-login", account.login);
          bind(githubAccountOptionBindings, optionButton, "click", () => {
            void switchGitHubAccount(account.login);
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

    if (noteEl) {
      const note = githubIdentityNote(identity);
      setChildren(context.dom, noteEl, note.specs);
      noteEl.style.color =
        note.tone === "warning" ?
          "var(--rad-warning, #9a6700)"
        : "var(--rad-text-tertiary)";
      noteEl.style.display = "";
      scopeWarnActive = note.showRecheck;
    }
    if (recheckBtn) recheckBtn.style.display = scopeWarnActive ? "" : "none";
  };

  const githubIdentityUrl = (fresh: boolean): string => {
    const url = `${GITHUB_IDENTITY_ENDPOINT}?repo=${encodeURIComponent(deps.repo)}`;
    return fresh ? `${url}&fresh=1` : url;
  };

  const loadGithubIdentity = async (fresh = false): Promise<void> => {
    if (checking) return;
    checking = true;
    if (fresh && recheckBtn) {
      recheckBtn.disabled = true;
      recheckBtn.textContent = "Checking…";
    } else if (ghValueEl) {
      ghValueEl.textContent = "Detecting…";
    }
    try {
      const response = await context.net.fetch(githubIdentityUrl(fresh));
      const payload = await response.json();
      githubIdentity = parseGithubIdentity(payload);
      renderGithubIdentity();
    } catch {
      if (fieldEl) fieldEl.style.display = "none";
    } finally {
      checking = false;
      if (recheckBtn) {
        recheckBtn.disabled = false;
        recheckBtn.textContent = "Re-check";
      }
    }
  };

  const autoRecheckGithubIdentity = (): void => {
    if (
      scopeWarnActive &&
      !checking &&
      fieldEl &&
      fieldEl.style.display !== "none"
    ) {
      void loadGithubIdentity(true);
    }
  };

  const errorMessageFrom = (payload: unknown): string => {
    const message = readString(payload, "error");
    return message === "" ? "Could not switch account." : message;
  };

  const switchGitHubAccount = async (login: string): Promise<void> => {
    if (ghValueEl) ghValueEl.textContent = "Switching…";
    try {
      const response = await context.net.fetch(GITHUB_ACCOUNT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login })
      });
      const payload = await response.json();
      if (response.ok) {
        // Re-fetch identity WITH the repo so the admin/read preflight re-runs
        // for the freshly switched account: the switch response resolves
        // identity without the repo, so it carries no repoAccess.
        await loadGithubIdentity(true);
        return;
      }
      renderGithubIdentity();
      if (noteEl) {
        setChildren(context.dom, noteEl, textNote(errorMessageFrom(payload)));
        noteEl.style.color = "var(--rad-danger, #cf222e)";
        noteEl.style.display = "";
      }
    } catch {
      renderGithubIdentity();
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
      void loadGithubIdentity(true);
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
    teardown() {
      scope.teardown();
    }
  };
}
