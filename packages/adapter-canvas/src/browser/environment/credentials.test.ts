import { describe, expect, it, vi } from "vitest";
import type { EnvironmentConfirmOptions } from "./confirm-dialog.js";
import {
  AZURE_CLI_ASSIST_PATH,
  CREDENTIAL_DELETE_PATH,
  CREDENTIAL_PROFILES_PATH,
  CREDENTIAL_SAVE_PATH,
  CREDENTIALS_ENTRY_KEY,
  GHCR_COPY_RESET_MS,
  GITHUB_IDENTITY_PATH,
  VERIFY_AWS_PATH,
  VERIFY_AZURE_PATH,
  azureCliAssistPromptView,
  credentialRowsMarkup,
  initializeCredentialsPane,
  isCredentialsPaneController,
  parseCredentialProfiles,
  parseGitHubPackagesIdentity,
  renderGitHubAccessView
} from "./credentials.js";
import type { CredentialProfile } from "./credentials.js";

const USAGE_LOOKUP_URL = "/api/list-environments?repo=octo%2Fapp";
import {
  createDeferred,
  createFakeBrowser,
  createFakeElement,
  createFakeInput,
  createFakeSelect,
  flushPromises,
  jsonResponse,
  textResponse
} from "../../../test/support/browser/fakes.js";
import type { FakeBrowser } from "../../../test/support/browser/fakes.js";
import type { HttpResponse } from "../ports.js";

function buildElements() {
  const elements = {
    credLanding: createFakeElement("cred-landing"),
    credForm: createFakeElement("cred-form"),
    credFormCard: createFakeElement("cred-form-card"),
    credFormTitle: createFakeElement("cred-form-title"),
    wizardFormHost: createFakeElement("env-cred-form-host"),
    wizardStepCard: createFakeElement("env-step-credentials-card"),
    credProviderSelect: createFakeSelect("cred-provider-select"),
    credPanelAzure: createFakeElement("cred-panel-azure"),
    credPanelAws: createFakeElement("cred-panel-aws"),
    credTableBody: createFakeElement("cred-table-body"),
    newCredBtn: createFakeElement("new-cred-btn"),
    cancelCredBtn: createFakeElement("cancel-cred-btn"),
    credSuccessBanner: createFakeElement("cred-success-banner"),
    credSuccessBannerText: createFakeElement("cred-success-banner-text"),
    credSuccessBannerClose: createFakeElement("cred-success-banner-close"),
    credNameInput: createFakeInput("cred-name-input"),
    azTenantId: createFakeInput("az-tenant-id"),
    azSubId: createFakeInput("az-sub-id"),
    awsAccountId: createFakeInput("aws-account-id"),
    awsRegion: createFakeInput("aws-region"),
    awsRoleArn: createFakeInput("aws-role-arn"),
    credVerifyStatus: createFakeElement("cred-verify-status"),
    credVerifyHint: createFakeElement("cred-verify-hint"),
    saveCredBtn: createFakeInput("save-cred-btn"),
    btnVerifyAzure: createFakeInput("btn-verify-azure"),
    btnVerifyAws: createFakeInput("btn-verify-aws"),
    credGhcrStatus: createFakeElement("cred-ghcr-status"),
    credGhcrCommandRow: createFakeElement("cred-ghcr-command-row"),
    credGhcrCommand: createFakeElement("cred-ghcr-command"),
    credGhcrRetry: createFakeInput("cred-ghcr-retry"),
    credGhcrCopy: createFakeElement("cred-ghcr-copy"),
    envVerifyModal: createFakeElement("env-verify-modal"),
    envVerifyTitle: createFakeElement("env-verify-title"),
    azureCliAssistModal: createFakeElement("azure-cli-assist-modal"),
    azureCliAssistTitle: createFakeElement("azure-cli-assist-title"),
    azureCliAssistMessage: createFakeElement("azure-cli-assist-message"),
    azureCliAssistConfirm: createFakeElement("azure-cli-assist-confirm"),
    azureCliAssistCancel: createFakeElement("azure-cli-assist-cancel")
  };
  elements.credForm.style.display = "none";
  elements.credPanelAws.style.display = "none";
  elements.credSuccessBanner.style.display = "none";
  elements.credVerifyStatus.style.display = "none";
  elements.credGhcrCommandRow.style.display = "none";
  elements.credGhcrRetry.style.display = "none";
  return elements;
}

function renderPage(repo = "octo/app") {
  const browser = createFakeBrowser();
  const elements = buildElements();
  for (const element of Object.values(elements)) browser.document.add(element);

  const dependencies = {
    selectEnvironmentsSubtab: vi.fn(),
    openEnvironmentForm: vi.fn(),
    credentialCreated: vi.fn()
  };
  const decisions = {
    confirm: vi.fn(() => true),
    notify: vi.fn()
  };
  const confirmDialog = {
    show: vi.fn((options: EnvironmentConfirmOptions) => options.onConfirm()),
    close: vi.fn(),
    teardown: vi.fn()
  };
  const initialized = initializeCredentialsPane(
    browser.context,
    { repo, decisions, confirmDialog },
    dependencies
  );
  if (!isCredentialsPaneController(initialized)) {
    throw new Error("Expected credentials pane controller.");
  }
  return {
    browser,
    elements,
    dependencies,
    decisions,
    confirmDialog,
    controller: initialized
  };
}

function addRowButtons(browser: FakeBrowser, name = "acme-azure") {
  const createEnv = createFakeElement("row-createenv");
  createEnv.setAttribute("data-name", name);
  const remove = createFakeInput("row-delete");
  remove.setAttribute("data-name", name);
  browser.document.addSelectorAll(".js-cred-createenv", [createEnv]);
  browser.document.addSelectorAll(".js-cred-delete", [remove]);
  return { createEnv, remove };
}

async function readyTable(profile: Partial<CredentialProfile> = {}) {
  const page = renderPage();
  const rows = addRowButtons(page.browser, profile.name ?? "acme-azure");
  page.browser.net.handle(`${CREDENTIAL_PROFILES_PATH}?repo=octo%2Fapp`, () =>
    jsonResponse({
      profiles: [
        {
          name: "acme-azure",
          provider: "azure",
          status: "verified",
          tenantId: "tenant-1",
          subscriptionId: "sub-1",
          ...profile
        }
      ]
    })
  );
  page.controller.loadCredentialTable();
  await flushPromises();
  return { page, rows };
}

describe("credential profile parsing and markup", () => {
  it("parses valid profiles and drops malformed or unnamed entries", () => {
    expect(
      parseCredentialProfiles({
        profiles: [
          {
            name: "acme-azure",
            provider: "azure",
            status: "pending",
            tenantId: "t",
            subscriptionId: "s",
            accountId: "a",
            region: "r",
            roleArn: "arn",
            ignored: true
          },
          { name: 7 },
          null,
          "bad",
          { provider: "aws" }
        ]
      })
    ).toEqual([
      {
        name: "acme-azure",
        provider: "azure",
        status: "pending",
        tenantId: "t",
        subscriptionId: "s",
        accountId: "a",
        region: "r",
        roleArn: "arn"
      }
    ]);
  });

  it("defaults an empty status to verified and handles a missing payload", () => {
    expect(parseCredentialProfiles({ profiles: [{ name: "acme" }] })).toEqual([
      {
        name: "acme",
        provider: "",
        status: "verified",
        tenantId: "",
        subscriptionId: "",
        accountId: "",
        region: "",
        roleArn: ""
      }
    ]);
    expect(parseCredentialProfiles(null)).toEqual([]);
    expect(parseCredentialProfiles({})).toEqual([]);
  });

  it("renders the empty state without a repository request", () => {
    expect(credentialRowsMarkup([])).toContain(
      "No credential profiles created yet"
    );
  });

  it("renders escaped rows with row action markup", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const markup = credentialRowsMarkup([
      {
        name: hostile,
        provider: "aws",
        status: "verified",
        tenantId: "",
        subscriptionId: "",
        accountId: "",
        region: "",
        roleArn: ""
      }
    ]);
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;img");
    // Profiles are create-and-delete only: an environment snapshots a
    // profile's values at creation, so editing one could never update the
    // environments already created from it.
    expect(markup).not.toContain("js-cred-edit");
    expect(markup).toContain("js-cred-createenv");
    expect(markup).toContain("js-cred-delete");
    expect(markup).toContain("AWS");
    expect(markup).toContain("<td>Verified</td>");
    expect(markup).not.toContain("rad-dot");
  });
});

const LEGACY_IDENTITY = {
  packagesLogin: "",
  packagesHasWrite: undefined,
  packagesCredentialSource: ""
} as const;

describe("GitHub Packages identity parsing and rendering", () => {
  it("parses identity fields and defaults malformed booleans", () => {
    expect(
      parseGitHubPackagesIdentity({
        actingLogin: "octocat",
        actingHasPackages: true,
        packagesLogin: "publisher",
        packagesHasWrite: true,
        packagesCredentialSource: "keyring"
      })
    ).toEqual({
      error: "",
      actingLogin: "octocat",
      actingHasPackages: true,
      packagesLogin: "publisher",
      packagesHasWrite: true,
      packagesCredentialSource: "keyring"
    });
    expect(
      parseGitHubPackagesIdentity({
        actingLogin: "octocat",
        actingHasPackages: "true",
        packagesHasWrite: "true"
      })
    ).toEqual({
      error: "",
      actingLogin: "octocat",
      actingHasPackages: false,
      ...LEGACY_IDENTITY
    });
    expect(parseGitHubPackagesIdentity(null)).toEqual({
      error: "",
      actingLogin: "",
      actingHasPackages: false,
      ...LEGACY_IDENTITY
    });
  });

  it("names the publishing credential rather than the acting account", () => {
    const view = renderGitHubAccessView({
      error: "",
      actingLogin: "octocat",
      actingHasPackages: false,
      packagesLogin: "publisher",
      packagesHasWrite: true,
      packagesCredentialSource: "keyring"
    });
    expect(view.packagesVerified).toBe(true);
    expect(view.statusHtml).toContain("@publisher");
    expect(view.statusHtml).toContain("using the stored GitHub CLI credential");
  });

  it("offers no gh command for a session token that gh cannot repair", () => {
    const view = renderGitHubAccessView({
      error: "",
      actingLogin: "octocat",
      actingHasPackages: true,
      packagesLogin: "octocat",
      packagesHasWrite: false,
      packagesCredentialSource: "injected-token"
    });
    expect(view.packagesVerified).toBe(false);
    expect(view.statusHtml).toContain("The Copilot session token for");
    // A switch/refresh command here would be a dead end.
    expect(view.commandVisible).toBe(false);
    expect(view.command).toBe("");
    expect(view.retryVisible).toBe(true);
  });

  it("does not let the acting account's scope stand in for a known publisher", () => {
    const view = renderGitHubAccessView({
      error: "",
      actingLogin: "octocat",
      actingHasPackages: true,
      packagesLogin: "publisher",
      packagesHasWrite: false,
      packagesCredentialSource: "keyring"
    });
    expect(view.packagesVerified).toBe(false);
    expect(view.statusHtml).toContain("The stored GitHub CLI credential for");
    expect(view.command).toBe(
      "gh auth switch -h github.com -u publisher && gh auth refresh -h github.com -s read:packages -s write:packages"
    );
  });

  it("renders the unauthenticated fallback when login is missing or errored", () => {
    const view = renderGitHubAccessView({
      error: "",
      actingLogin: "",
      actingHasPackages: false,
      ...LEGACY_IDENTITY
    });
    expect(view.packagesVerified).toBe(false);
    expect(view.statusHtml).toBeNull();
    expect(view.statusText).toContain("Could not detect a GitHub CLI account");
    expect(view.commandVisible).toBe(false);
    expect(view.retryVisible).toBe(false);

    const errored = renderGitHubAccessView({
      error: "boom",
      actingLogin: "octocat",
      actingHasPackages: true,
      ...LEGACY_IDENTITY
    });
    expect(errored.packagesVerified).toBe(false);
    expect(errored.statusHtml).toBeNull();
  });

  it("renders the verified view with an escaped login", () => {
    const view = renderGitHubAccessView({
      error: "",
      actingLogin: "<b>octocat</b>",
      actingHasPackages: true,
      ...LEGACY_IDENTITY
    });
    expect(view.packagesVerified).toBe(true);
    expect(view.statusHtml).toContain("&lt;b&gt;octocat&lt;/b&gt;");
    expect(view.commandVisible).toBe(false);
    expect(view.retryVisible).toBe(false);
  });

  it("renders the retry-needed view with the switch command", () => {
    const view = renderGitHubAccessView({
      error: "",
      actingLogin: "octocat",
      actingHasPackages: false,
      ...LEGACY_IDENTITY
    });
    expect(view.packagesVerified).toBe(false);
    expect(view.commandVisible).toBe(true);
    expect(view.retryVisible).toBe(true);
    expect(view.command).toBe(
      "gh auth switch -h github.com -u octocat && gh auth refresh -h github.com -s read:packages -s write:packages"
    );
  });
});

describe("Azure CLI assist prompt copy", () => {
  it("describes the install action", () => {
    const view = azureCliAssistPromptView("install");
    expect(view.title).toBe("Install Azure CLI?");
    expect(view.confirmLabel).toBe("Ask Copilot to install");
  });

  it("describes the login action", () => {
    const view = azureCliAssistPromptView("login");
    expect(view.title).toBe("Start Azure login?");
    expect(view.confirmLabel).toBe("Start Azure login");
  });
});

describe("credentials pane initialization", () => {
  it("does nothing on a page missing required markup", () => {
    const browser = createFakeBrowser();
    // Only add a subset of the required elements.
    browser.document.add(createFakeElement("cred-landing"));
    browser.document.add(createFakeElement("cred-form"));
    const initialized = initializeCredentialsPane(
      browser.context,
      {
        repo: "octo/app",
        decisions: { confirm: () => true, notify: () => {} }
      },
      {
        selectEnvironmentsSubtab: () => {},
        openEnvironmentForm: () => {},
        credentialCreated: () => {}
      }
    );
    expect(isCredentialsPaneController(initialized)).toBe(false);
    expect(() => {
      if (!isCredentialsPaneController(initialized)) initialized();
    }).not.toThrow();
  });

  it("binds once and returns a no-op initializer on a second call", () => {
    const page = renderPage();
    expect(page.browser.bindings.has(CREDENTIALS_ENTRY_KEY)).toBe(true);

    const second = initializeCredentialsPane(
      page.browser.context,
      { repo: "octo/app", decisions: page.decisions },
      page.dependencies
    );
    expect(isCredentialsPaneController(second)).toBe(false);
    expect(() => {
      if (!isCredentialsPaneController(second)) second();
    }).not.toThrow();
  });
});

describe("credential table loading", () => {
  it("renders the local empty state without a repository request", () => {
    const page = renderPage("");
    page.controller.loadCredentialTable();
    expect(page.elements.credTableBody.innerHTML).toContain(
      "No credential profiles created yet"
    );
    expect(page.browser.net.calls).toHaveLength(0);
  });

  it("loads, renders, and wires profile rows", async () => {
    const page = renderPage();
    page.browser.net.handle(`${CREDENTIAL_PROFILES_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({
        profiles: [
          { name: "acme-azure", provider: "azure", status: "verified" }
        ]
      })
    );
    page.controller.loadCredentialTable();
    expect(page.elements.credTableBody.innerHTML).toContain(
      "Loading credential profiles"
    );
    await flushPromises();
    expect(page.elements.credTableBody.innerHTML).toContain("acme-azure");
  });

  it("shows a load failure for a malformed payload response", async () => {
    const page = renderPage();
    page.browser.net.handle(`${CREDENTIAL_PROFILES_PATH}?repo=octo%2Fapp`, () =>
      textResponse("not json")
    );
    page.controller.loadCredentialTable();
    await expect(async () => flushPromises()).not.toThrow();
    await flushPromises();
    expect(page.elements.credTableBody.innerHTML).toContain(
      "Could not load credential profiles"
    );
  });

  it("shows a load failure for a non-ok response", async () => {
    const page = renderPage();
    page.browser.net.handle(`${CREDENTIAL_PROFILES_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ error: "server exploded" }, false, 500)
    );
    page.controller.loadCredentialTable();
    await flushPromises();
    expect(page.elements.credTableBody.innerHTML).toContain(
      "Could not load credential profiles"
    );
  });

  it("shows a load failure on a network error", async () => {
    const page = renderPage();
    page.browser.net.handle(`${CREDENTIAL_PROFILES_PATH}?repo=octo%2Fapp`, () =>
      Promise.reject(new Error("offline"))
    );
    page.controller.loadCredentialTable();
    await flushPromises();
    expect(page.elements.credTableBody.innerHTML).toContain(
      "Could not load credential profiles"
    );
  });

  it("ignores a stale table response", async () => {
    const page = renderPage();
    page.browser.net.supportsAbort = false;
    const first = createDeferred<HttpResponse>();
    const second = createDeferred<HttpResponse>();
    const queue = [first, second];
    page.browser.net.handle(
      `${CREDENTIAL_PROFILES_PATH}?repo=octo%2Fapp`,
      () => queue.shift()?.promise ?? Promise.reject(new Error("extra request"))
    );

    page.controller.loadCredentialTable();
    page.controller.loadCredentialTable();
    second.resolve(jsonResponse({ profiles: [{ name: "current" }] }));
    await flushPromises();
    first.resolve(jsonResponse({ profiles: [{ name: "stale" }] }));
    await flushPromises();

    expect(page.elements.credTableBody.innerHTML).toContain("current");
    expect(page.elements.credTableBody.innerHTML).not.toContain("stale");
  });

  it("aborts the previous in-flight request when reloading", async () => {
    const page = renderPage();
    page.browser.net.handle(
      `${CREDENTIAL_PROFILES_PATH}?repo=octo%2Fapp`,
      () => new Promise<HttpResponse>(() => {})
    );
    page.controller.loadCredentialTable();
    const abortedAfterFirstLoad = page.browser.net.aborted;
    page.controller.loadCredentialTable();
    expect(page.browser.net.aborted).toBe(abortedAfterFirstLoad + 1);
  });
});

describe("row actions", () => {
  it("asks the environments pane to open a create-environment form", async () => {
    const { page, rows } = await readyTable();
    rows.createEnv.dispatch("click");
    expect(page.dependencies.selectEnvironmentsSubtab).toHaveBeenCalledOnce();
    expect(page.dependencies.openEnvironmentForm).toHaveBeenCalledWith({
      name: "",
      profile: "acme-azure"
    });
  });

  it("opens a blank form when a create-environment row is missing its profile name", async () => {
    const { page, rows } = await readyTable();
    rows.createEnv.removeAttribute("data-name");
    rows.createEnv.dispatch("click");
    expect(page.dependencies.selectEnvironmentsSubtab).toHaveBeenCalledOnce();
    expect(page.dependencies.openEnvironmentForm).toHaveBeenCalledWith({
      name: "",
      profile: ""
    });
  });

  it("opens an empty form when creating a new profile", async () => {
    const page = renderPage();
    page.browser.net.handle(`${GITHUB_IDENTITY_PATH}?fresh=1`, () =>
      jsonResponse({ actingLogin: "octocat", actingHasPackages: true })
    );
    page.elements.newCredBtn.dispatch("click");
    expect(page.elements.credNameInput.value).toBe("");
    expect(page.elements.credProviderSelect.value).toBe("azure");
    expect(page.elements.credPanelAzure.style.display).toBe("");
    await flushPromises();
  });

  it("does nothing when the row carries no profile name", async () => {
    const { page, rows } = await readyTable();
    rows.remove.removeAttribute("data-name");
    rows.remove.dispatch("click");
    await flushPromises();
    expect(page.confirmDialog.show).not.toHaveBeenCalled();
    expect(page.browser.net.calls).toHaveLength(1);
  });

  it("lists the environments created from the profile before confirming", async () => {
    const { page, rows } = await readyTable();
    page.confirmDialog.show.mockImplementation(() => {});
    page.browser.net.handle(USAGE_LOOKUP_URL, () =>
      jsonResponse({
        environments: [
          { name: "dev", credentialProfile: "acme-azure" },
          { name: "prod", credentialProfile: "other" },
          { name: "", credentialProfile: "acme-azure" },
          "malformed"
        ]
      })
    );
    rows.remove.dispatch("click");
    // Usage is looked up first so the dialog can name what stays behind.
    expect(rows.remove.disabled).toBe(true);
    expect(rows.remove.textContent).toBe("Checking usage…");
    await flushPromises();
    expect(page.confirmDialog.show).toHaveBeenCalledOnce();
    const shown = page.confirmDialog.show.mock.calls[0][0];
    expect(shown.title).toBe("Delete credential profile?");
    expect(shown.confirmLabel).toBe("Delete profile");
    expect(shown.usage).toEqual(["dev"]);
    expect(shown.usageLabel).toContain("stored its own copy");
    expect(shown.message).not.toContain("Could not check");
    // Dismissing the dialog leaves the profile and the row untouched.
    expect(rows.remove.disabled).toBe(false);
    expect(rows.remove.textContent).toBe("Delete Profile");
    expect(
      page.browser.net.calls.some((call) =>
        call.url.startsWith(CREDENTIAL_DELETE_PATH)
      )
    ).toBe(false);
  });

  it("does not confirm a deletion that resolves after teardown", async () => {
    const { page, rows } = await readyTable();
    const deferred = createDeferred<HttpResponse>();
    page.browser.net.handle(USAGE_LOOKUP_URL, () => deferred.promise);

    rows.remove.dispatch("click");
    page.controller.teardown();
    deferred.resolve(jsonResponse({ environments: [] }));
    await flushPromises();

    expect(page.confirmDialog.show).not.toHaveBeenCalled();
    expect(rows.remove.textContent).toBe("Checking usage…");
  });

  it("warns in the dialog when the usage lookup fails", async () => {
    const { page, rows } = await readyTable();
    page.confirmDialog.show.mockImplementation(() => {});
    page.browser.net.handle(USAGE_LOOKUP_URL, () =>
      Promise.reject(new Error("offline"))
    );
    rows.remove.dispatch("click");
    await flushPromises();
    const shown = page.confirmDialog.show.mock.calls[0][0];
    expect(shown.usage).toEqual([]);
    expect(shown.message).toContain(
      "Could not check which environments use this profile."
    );
  });

  it("warns in the dialog when the usage lookup reports an error payload", async () => {
    const { page, rows } = await readyTable();
    page.confirmDialog.show.mockImplementation(() => {});
    // The handler reports its own failures as HTTP 200 with an `error` field,
    // so an empty environment list here means "unknown", not "unused".
    page.browser.net.handle(USAGE_LOOKUP_URL, () =>
      jsonResponse({ error: "repo lookup failed", environments: [] })
    );
    rows.remove.dispatch("click");
    await flushPromises();
    const shown = page.confirmDialog.show.mock.calls[0][0];
    expect(shown.usage).toEqual([]);
    expect(shown.message).toContain(
      "Could not check which environments use this profile."
    );
  });

  it("warns in the dialog when the usage lookup returns a non-OK status", async () => {
    const { page, rows } = await readyTable();
    page.confirmDialog.show.mockImplementation(() => {});
    page.browser.net.handle(USAGE_LOOKUP_URL, () =>
      jsonResponse({ environments: [] }, false, 500)
    );
    rows.remove.dispatch("click");
    await flushPromises();
    const shown = page.confirmDialog.show.mock.calls[0][0];
    expect(shown.usage).toEqual([]);
    expect(shown.message).toContain(
      "Could not check which environments use this profile."
    );
  });

  it("deletes a profile and refreshes the table on success", async () => {
    const { page, rows } = await readyTable();
    page.browser.net.handle(CREDENTIAL_DELETE_PATH, () =>
      jsonResponse({ success: true })
    );
    rows.remove.dispatch("click");
    expect(rows.remove.disabled).toBe(true);
    await flushPromises();
    expect(page.browser.net.calls).toHaveLength(4);
    expect(
      page.browser.net.calls.some(
        (call) => call.url === `${CREDENTIAL_PROFILES_PATH}?repo=octo%2Fapp`
      )
    ).toBe(true);
  });

  it("fails closed and restores the row on an error payload", async () => {
    const { page, rows } = await readyTable();
    page.browser.net.handle(CREDENTIAL_DELETE_PATH, () =>
      jsonResponse({ error: "profile in use" })
    );
    rows.remove.dispatch("click");
    await flushPromises();
    expect(rows.remove.disabled).toBe(false);
    expect(rows.remove.textContent).toBe("Delete Profile");
    expect(page.decisions.notify).toHaveBeenCalledWith("profile in use");
    expect(page.browser.net.calls).toHaveLength(3);
  });

  it("fails closed and restores the row on a non-ok response with no error field", async () => {
    const { page, rows } = await readyTable();
    page.browser.net.handle(CREDENTIAL_DELETE_PATH, () =>
      jsonResponse({}, false, 500)
    );
    rows.remove.dispatch("click");
    await flushPromises();
    expect(rows.remove.disabled).toBe(false);
    expect(page.decisions.notify).toHaveBeenCalledWith(
      "Could not delete the credential profile."
    );
    expect(page.browser.net.calls).toHaveLength(3);
  });

  it("fails closed and restores the row on a network error", async () => {
    const { page, rows } = await readyTable();
    page.browser.net.handle(CREDENTIAL_DELETE_PATH, () =>
      Promise.reject(new Error("offline"))
    );
    rows.remove.dispatch("click");
    await flushPromises();
    expect(rows.remove.disabled).toBe(false);
    expect(page.decisions.notify).toHaveBeenCalledWith(
      "Could not delete the credential profile. Please try again."
    );
    expect(page.browser.net.calls).toHaveLength(3);
  });

  it("ignores a late delete response after teardown", async () => {
    const { page, rows } = await readyTable();
    const pending = createDeferred<HttpResponse>();
    page.browser.net.handle(CREDENTIAL_DELETE_PATH, () => pending.promise);
    rows.remove.dispatch("click");
    await flushPromises();
    page.controller.teardown();
    pending.resolve(jsonResponse({ success: true }));
    await flushPromises();
    expect(page.decisions.notify).not.toHaveBeenCalled();
    expect(page.browser.net.calls).toHaveLength(3);
  });

  it("ignores a late delete network failure after teardown", async () => {
    const { page, rows } = await readyTable();
    const pending = createDeferred<HttpResponse>();
    page.browser.net.handle(CREDENTIAL_DELETE_PATH, () => pending.promise);
    rows.remove.dispatch("click");
    await flushPromises();
    page.controller.teardown();
    pending.reject(new Error("late network failure"));
    await expect(flushPromises()).resolves.not.toThrow();
    expect(page.decisions.notify).not.toHaveBeenCalled();
  });
});

describe("provider switching", () => {
  it("toggles panels and resets verification state", async () => {
    const page = renderPage();
    page.browser.net.handle(`${GITHUB_IDENTITY_PATH}?fresh=1`, () =>
      jsonResponse({ actingLogin: "octocat", actingHasPackages: true })
    );
    page.elements.newCredBtn.dispatch("click");
    await flushPromises();
    page.browser.net.handle(VERIFY_AZURE_PATH, () =>
      jsonResponse({ user: "me", tenantId: "t", subscriptionId: "s" })
    );
    page.elements.credNameInput.value = "acme";
    page.elements.azTenantId.value = "t";
    page.elements.azSubId.value = "s";
    page.elements.btnVerifyAzure.dispatch("click");
    await flushPromises();
    expect(page.elements.saveCredBtn.disabled).toBe(false);

    page.elements.credProviderSelect.value = "aws";
    page.elements.credProviderSelect.dispatch("change");
    expect(page.elements.credPanelAws.style.display).toBe("");
    expect(page.elements.credPanelAzure.style.display).toBe("none");
    expect(page.elements.credVerifyStatus.style.display).toBe("none");
    expect(page.elements.credVerifyHint.style.display).toBe("");
    expect(page.elements.saveCredBtn.disabled).toBe(true);
  });
});

describe("GitHub Packages identity check", () => {
  it("shows the checking state, then a verified result", async () => {
    const page = renderPage();
    const deferred = createDeferred<HttpResponse>();
    page.browser.net.handle(
      `${GITHUB_IDENTITY_PATH}?fresh=1`,
      () => deferred.promise
    );
    page.elements.newCredBtn.dispatch("click");
    expect(page.elements.credGhcrStatus.textContent).toBe(
      "Checking GitHub Packages access…"
    );
    expect(page.elements.credGhcrRetry.disabled).toBe(true);
    expect(page.elements.credGhcrRetry.textContent).toBe("Checking…");

    deferred.resolve(
      jsonResponse({ actingLogin: "octocat", actingHasPackages: true })
    );
    await flushPromises();
    expect(page.elements.credGhcrStatus.innerHTML).toContain("octocat");
    expect(page.elements.credGhcrRetry.disabled).toBe(false);
    expect(page.elements.credGhcrRetry.textContent).toBe(
      "I\u2019ve updated permissions — retry"
    );
  });

  it("shows the retry command when packages access is missing", async () => {
    const page = renderPage();
    page.browser.net.handle(`${GITHUB_IDENTITY_PATH}?fresh=1`, () =>
      jsonResponse({ actingLogin: "octocat", actingHasPackages: false })
    );
    page.elements.newCredBtn.dispatch("click");
    await flushPromises();
    expect(page.elements.credGhcrCommandRow.style.display).toBe("flex");
    expect(page.elements.credGhcrRetry.style.display).toBe("");
    expect(page.elements.credGhcrCommand.textContent).toContain(
      "gh auth switch"
    );
  });

  it("shows the generic failure state without leaking the raw error on a network failure", async () => {
    const page = renderPage();
    page.browser.net.handle(`${GITHUB_IDENTITY_PATH}?fresh=1`, () =>
      Promise.reject(new Error("secret internal detail"))
    );
    page.elements.newCredBtn.dispatch("click");
    await flushPromises();
    expect(page.elements.credGhcrStatus.textContent).toContain(
      "Could not detect a GitHub CLI account"
    );
    expect(page.elements.credGhcrStatus.textContent).not.toContain(
      "secret internal detail"
    );
  });

  it("ignores a concurrent retry while a check is already in flight", async () => {
    const page = renderPage();
    const deferred = createDeferred<HttpResponse>();
    page.browser.net.handle(
      `${GITHUB_IDENTITY_PATH}?fresh=1`,
      () => deferred.promise
    );
    page.elements.newCredBtn.dispatch("click");
    page.elements.credGhcrRetry.dispatch("click");
    expect(
      page.browser.net.calls.filter((call) =>
        call.url.startsWith(GITHUB_IDENTITY_PATH)
      )
    ).toHaveLength(1);
    deferred.resolve(
      jsonResponse({ actingLogin: "octocat", actingHasPackages: true })
    );
    await flushPromises();
  });

  it("retries with a fresh check", async () => {
    const page = renderPage();
    page.browser.net.handle(`${GITHUB_IDENTITY_PATH}?fresh=1`, () =>
      jsonResponse({ actingLogin: "octocat", actingHasPackages: false })
    );
    page.elements.newCredBtn.dispatch("click");
    await flushPromises();
    page.elements.credGhcrRetry.dispatch("click");
    await flushPromises();
    const calls = page.browser.net.calls.filter((call) =>
      call.url.startsWith(GITHUB_IDENTITY_PATH)
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe(`${GITHUB_IDENTITY_PATH}?fresh=1`);
  });

  it("copies the command and resets the label after a delay", async () => {
    const page = renderPage();
    page.browser.net.handle(`${GITHUB_IDENTITY_PATH}?fresh=1`, () =>
      jsonResponse({ actingLogin: "octocat", actingHasPackages: false })
    );
    page.elements.newCredBtn.dispatch("click");
    await flushPromises();
    page.elements.credGhcrCopy.dispatch("click");
    await flushPromises();
    expect(page.browser.clipboard.writes).toEqual([
      page.elements.credGhcrCommand.textContent
    ]);
    expect(page.elements.credGhcrCopy.textContent).toBe("Copied");
    page.browser.clock.tick(GHCR_COPY_RESET_MS);
    expect(page.elements.credGhcrCopy.textContent).toBe("Copy command");
  });

  it("copies an empty string when the command text has not been set", async () => {
    const page = renderPage();
    page.browser.net.handle(`${GITHUB_IDENTITY_PATH}?fresh=1`, () =>
      jsonResponse({ actingLogin: "octocat", actingHasPackages: false })
    );
    page.elements.newCredBtn.dispatch("click");
    await flushPromises();
    page.elements.credGhcrCommand.textContent = null;
    page.elements.credGhcrCopy.dispatch("click");
    await flushPromises();
    expect(page.browser.clipboard.writes).toEqual([""]);
  });

  it("does not relabel the copy button when the clipboard write is unsuccessful", async () => {
    const page = renderPage();
    page.browser.net.handle(`${GITHUB_IDENTITY_PATH}?fresh=1`, () =>
      jsonResponse({ actingLogin: "octocat", actingHasPackages: false })
    );
    page.elements.newCredBtn.dispatch("click");
    await flushPromises();
    page.browser.clipboard.write = vi.fn(() => Promise.resolve(false));
    page.elements.credGhcrCopy.dispatch("click");
    await flushPromises();
    expect(page.elements.credGhcrCopy.textContent).not.toBe("Copied");
  });

  it("ignores a copy confirmation that resolves after teardown", async () => {
    const page = renderPage();
    page.browser.net.handle(`${GITHUB_IDENTITY_PATH}?fresh=1`, () =>
      jsonResponse({ actingLogin: "octocat", actingHasPackages: false })
    );
    page.elements.newCredBtn.dispatch("click");
    await flushPromises();
    const deferred = createDeferred<boolean>();
    page.browser.clipboard.write = vi.fn(() => deferred.promise);
    page.elements.credGhcrCopy.dispatch("click");
    page.controller.teardown();
    deferred.resolve(true);
    await flushPromises();
    expect(page.elements.credGhcrCopy.textContent).not.toBe("Copied");
  });

  it("ignores a late identity check response that resolves after teardown", async () => {
    const page = renderPage();
    const deferred = createDeferred<HttpResponse>();
    page.browser.net.handle(
      `${GITHUB_IDENTITY_PATH}?fresh=1`,
      () => deferred.promise
    );
    page.elements.newCredBtn.dispatch("click");
    page.controller.teardown();
    deferred.resolve(
      jsonResponse({ actingLogin: "octocat", actingHasPackages: true })
    );
    await expect(flushPromises()).resolves.not.toThrow();
    expect(page.elements.credGhcrStatus.innerHTML).toBe("");
  });
});

describe("Azure CLI assist prompt", () => {
  async function openFormReadyToVerify() {
    const page = renderPage();
    page.browser.net.handle(`${GITHUB_IDENTITY_PATH}?fresh=1`, () =>
      jsonResponse({ actingLogin: "octocat", actingHasPackages: true })
    );
    page.elements.newCredBtn.dispatch("click");
    await flushPromises();
    page.elements.credNameInput.value = "acme";
    page.elements.azTenantId.value = "tenant-in-form";
    page.elements.azSubId.value = "sub-in-form";
    return page;
  }

  it("prompts to sign in for az-login-required and confirms the flow", async () => {
    const page = await openFormReadyToVerify();
    page.browser.net.handle(VERIFY_AZURE_PATH, () =>
      jsonResponse({
        error: "Not logged in.",
        code: "az-login-required",
        tenantId: "server-tenant"
      })
    );
    page.elements.btnVerifyAzure.dispatch("click");
    await flushPromises();
    expect(page.elements.azureCliAssistModal.style.display).toBe("flex");
    expect(page.elements.azureCliAssistTitle.textContent).toBe(
      "Start Azure login?"
    );
    expect(page.elements.azureCliAssistConfirm.focusCount).toBe(1);

    page.browser.net.handle(AZURE_CLI_ASSIST_PATH, (init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        action: "login",
        tenantId: "server-tenant"
      });
      return jsonResponse({ message: "Signing you in…" });
    });
    page.elements.azureCliAssistConfirm.dispatch("click");
    expect(page.elements.azureCliAssistModal.style.display).toBe("none");
    await flushPromises();
    expect(page.elements.credVerifyStatus.innerHTML).toContain(
      "Signing you in…"
    );
  });

  it("prompts to install for az-cli-missing", async () => {
    const page = await openFormReadyToVerify();
    page.browser.net.handle(VERIFY_AZURE_PATH, () =>
      jsonResponse({ error: "Azure CLI missing.", code: "az-cli-missing" })
    );
    page.elements.btnVerifyAzure.dispatch("click");
    await flushPromises();
    expect(page.elements.azureCliAssistTitle.textContent).toBe(
      "Install Azure CLI?"
    );
  });

  it("shows a default info message when the assist response omits one", async () => {
    const page = await openFormReadyToVerify();
    page.browser.net.handle(VERIFY_AZURE_PATH, () =>
      jsonResponse({ error: "nope", code: "az-cli-missing" })
    );
    page.elements.btnVerifyAzure.dispatch("click");
    await flushPromises();
    page.browser.net.handle(AZURE_CLI_ASSIST_PATH, () => jsonResponse({}));
    page.elements.azureCliAssistConfirm.dispatch("click");
    await flushPromises();
    expect(page.elements.credVerifyStatus.innerHTML).toContain(
      "Copilot is helping with Azure CLI setup"
    );
  });

  it("shows the assist error with the fallback message appended", async () => {
    const page = await openFormReadyToVerify();
    page.browser.net.handle(VERIFY_AZURE_PATH, () =>
      jsonResponse({ error: "nope", code: "az-cli-missing" })
    );
    page.elements.btnVerifyAzure.dispatch("click");
    await flushPromises();
    page.browser.net.handle(AZURE_CLI_ASSIST_PATH, () =>
      jsonResponse({ error: "assist failed" })
    );
    page.elements.azureCliAssistConfirm.dispatch("click");
    await flushPromises();
    expect(page.elements.credVerifyStatus.innerHTML).toContain("assist failed");
    expect(page.elements.credVerifyStatus.innerHTML).toContain("nope");
  });

  it("shows a generic error without the raw exception on an assist network failure", async () => {
    const page = await openFormReadyToVerify();
    page.browser.net.handle(VERIFY_AZURE_PATH, () =>
      jsonResponse({ error: "nope", code: "az-cli-missing" })
    );
    page.elements.btnVerifyAzure.dispatch("click");
    await flushPromises();
    page.browser.net.handle(AZURE_CLI_ASSIST_PATH, () =>
      Promise.reject(new Error("raw secret detail"))
    );
    page.elements.azureCliAssistConfirm.dispatch("click");
    await flushPromises();
    expect(page.elements.credVerifyStatus.innerHTML).toContain(
      "Could not reach Copilot"
    );
    expect(page.elements.credVerifyStatus.innerHTML).not.toContain(
      "raw secret detail"
    );
  });

  it("cancels and shows the fallback message when one is pending", async () => {
    const page = await openFormReadyToVerify();
    page.browser.net.handle(VERIFY_AZURE_PATH, () =>
      jsonResponse({ error: "nope", code: "az-cli-missing" })
    );
    page.elements.btnVerifyAzure.dispatch("click");
    await flushPromises();
    page.elements.azureCliAssistCancel.dispatch("click");
    expect(page.elements.azureCliAssistModal.style.display).toBe("none");
    expect(page.elements.credVerifyStatus.innerHTML).toContain("nope");
  });

  it("cancels quietly when there is no pending assist request", () => {
    const page = renderPage();
    expect(() =>
      page.elements.azureCliAssistCancel.dispatch("click")
    ).not.toThrow();
    expect(() =>
      page.elements.azureCliAssistConfirm.dispatch("click")
    ).not.toThrow();
  });

  it("ignores a stale assist response after the form context changes", async () => {
    const page = await openFormReadyToVerify();
    page.browser.net.handle(VERIFY_AZURE_PATH, () =>
      jsonResponse({ error: "nope", code: "az-cli-missing" })
    );
    page.elements.btnVerifyAzure.dispatch("click");
    await flushPromises();
    const deferred = createDeferred<HttpResponse>();
    page.browser.net.handle(AZURE_CLI_ASSIST_PATH, () => deferred.promise);
    page.elements.azureCliAssistConfirm.dispatch("click");

    // Reopen (bumps the form token) before the assist response arrives.
    page.elements.cancelCredBtn.dispatch("click");
    page.browser.net.handle(`${CREDENTIAL_PROFILES_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ profiles: [] })
    );
    await flushPromises();
    page.elements.newCredBtn.dispatch("click");
    const statusBefore = page.elements.credVerifyStatus.innerHTML;

    deferred.resolve(jsonResponse({ message: "late" }));
    await flushPromises();
    expect(page.elements.credVerifyStatus.innerHTML).toBe(statusBefore);
  });

  it("ignores an assist network failure that resolves after teardown", async () => {
    const page = await openFormReadyToVerify();
    page.browser.net.handle(VERIFY_AZURE_PATH, () =>
      jsonResponse({ error: "nope", code: "az-cli-missing" })
    );
    page.elements.btnVerifyAzure.dispatch("click");
    await flushPromises();
    const deferred = createDeferred<HttpResponse>();
    page.browser.net.handle(AZURE_CLI_ASSIST_PATH, () => deferred.promise);
    page.elements.azureCliAssistConfirm.dispatch("click");
    const statusBefore = page.elements.credVerifyStatus.innerHTML;

    page.controller.teardown();
    deferred.reject(new Error("late network failure"));
    await expect(flushPromises()).resolves.not.toThrow();
    expect(page.elements.credVerifyStatus.innerHTML).toBe(statusBefore);
  });
});

describe("Azure verification", () => {
  async function openForm(page: ReturnType<typeof renderPage>) {
    page.browser.net.handle(`${GITHUB_IDENTITY_PATH}?fresh=1`, () =>
      jsonResponse({ actingLogin: "octocat", actingHasPackages: true })
    );
    page.elements.newCredBtn.dispatch("click");
    await flushPromises();
  }

  it("requires a profile name before verifying", async () => {
    const page = renderPage();
    await openForm(page);
    page.elements.btnVerifyAzure.dispatch("click");
    expect(page.elements.credVerifyStatus.innerHTML).toContain(
      "Please enter a Profile Name"
    );
    expect(
      page.browser.net.calls.some((call) => call.url === VERIFY_AZURE_PATH)
    ).toBe(false);
  });

  it("requires tenant and subscription ids before verifying", async () => {
    const page = renderPage();
    await openForm(page);
    page.elements.credNameInput.value = "acme";
    page.elements.btnVerifyAzure.dispatch("click");
    expect(page.elements.credVerifyStatus.innerHTML).toContain(
      "Tenant ID and a Subscription ID"
    );
  });

  it("verifies successfully, fills in server-confirmed ids, and enables save", async () => {
    const page = renderPage();
    await openForm(page);
    page.elements.credNameInput.value = "acme";
    page.elements.azTenantId.value = "tenant-in-form";
    page.elements.azSubId.value = "sub-in-form";
    page.browser.net.handle(VERIFY_AZURE_PATH, (init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        tenantId: "tenant-in-form",
        subscriptionId: "sub-in-form"
      });
      return jsonResponse({
        user: "me@example.com",
        tenantId: "server-tenant",
        subscriptionId: "server-sub",
        subscriptionName: "My Subscription"
      });
    });
    page.elements.btnVerifyAzure.dispatch("click");
    expect(page.elements.btnVerifyAzure.disabled).toBe(true);
    expect(page.elements.envVerifyModal.style.display).toBe("flex");
    await flushPromises();
    expect(page.elements.envVerifyModal.style.display).toBe("none");
    expect(page.elements.btnVerifyAzure.disabled).toBe(false);
    expect(page.elements.azTenantId.value).toBe("server-tenant");
    expect(page.elements.azSubId.value).toBe("server-sub");
    expect(page.elements.credVerifyStatus.innerHTML).toContain(
      "me@example.com"
    );
    expect(page.elements.saveCredBtn.disabled).toBe(false);
  });

  it("shows a generic error for an unrecognized error code", async () => {
    const page = renderPage();
    await openForm(page);
    page.elements.credNameInput.value = "acme";
    page.elements.azTenantId.value = "t";
    page.elements.azSubId.value = "s";
    page.browser.net.handle(VERIFY_AZURE_PATH, () =>
      jsonResponse({ error: "subscription not found" })
    );
    page.elements.btnVerifyAzure.dispatch("click");
    await flushPromises();
    expect(page.elements.credVerifyStatus.innerHTML).toContain(
      "subscription not found"
    );
    expect(page.elements.azureCliAssistModal.style.display).not.toBe("flex");
  });

  it("shows a generic error without the raw exception on a network failure", async () => {
    const page = renderPage();
    await openForm(page);
    page.elements.credNameInput.value = "acme";
    page.elements.azTenantId.value = "t";
    page.elements.azSubId.value = "s";
    page.browser.net.handle(VERIFY_AZURE_PATH, () =>
      Promise.reject(new Error("raw secret"))
    );
    page.elements.btnVerifyAzure.dispatch("click");
    await flushPromises();
    expect(page.elements.envVerifyModal.style.display).toBe("none");
    expect(page.elements.btnVerifyAzure.disabled).toBe(false);
    expect(page.elements.credVerifyStatus.innerHTML).toContain(
      "Could not verify credentials"
    );
    expect(page.elements.credVerifyStatus.innerHTML).not.toContain(
      "raw secret"
    );
  });

  it("ignores a stale verify response after switching provider", async () => {
    const page = renderPage();
    await openForm(page);
    page.elements.credNameInput.value = "acme";
    page.elements.azTenantId.value = "t";
    page.elements.azSubId.value = "s";
    const deferred = createDeferred<HttpResponse>();
    page.browser.net.handle(VERIFY_AZURE_PATH, () => deferred.promise);
    page.elements.btnVerifyAzure.dispatch("click");

    page.elements.credProviderSelect.value = "aws";
    page.elements.credProviderSelect.dispatch("change");
    const statusBefore = page.elements.credVerifyStatus.innerHTML;
    const modalBefore = page.elements.envVerifyModal.style.display;

    deferred.resolve(
      jsonResponse({
        user: "stale@example.com",
        tenantId: "t",
        subscriptionId: "s"
      })
    );
    await flushPromises();
    expect(page.elements.credVerifyStatus.innerHTML).toBe(statusBefore);
    expect(page.elements.envVerifyModal.style.display).toBe(modalBefore);
    expect(page.elements.saveCredBtn.disabled).toBe(true);
  });

  it("keeps the form's ids and shows a login-less verified state when the server omits them", async () => {
    const page = renderPage();
    await openForm(page);
    page.elements.credNameInput.value = "acme";
    page.elements.azTenantId.value = "t";
    page.elements.azSubId.value = "s";
    page.browser.net.handle(VERIFY_AZURE_PATH, () => jsonResponse({}));
    page.elements.btnVerifyAzure.dispatch("click");
    await flushPromises();
    expect(page.elements.azTenantId.value).toBe("t");
    expect(page.elements.azSubId.value).toBe("s");
    expect(page.elements.credVerifyStatus.innerHTML).toContain(
      "Credentials verified"
    );
    expect(page.elements.credVerifyStatus.innerHTML).not.toContain(
      "Logged in as"
    );
  });

  it("ignores a verify network failure that resolves after teardown", async () => {
    const page = renderPage();
    await openForm(page);
    page.elements.credNameInput.value = "acme";
    page.elements.azTenantId.value = "t";
    page.elements.azSubId.value = "s";
    const deferred = createDeferred<HttpResponse>();
    page.browser.net.handle(VERIFY_AZURE_PATH, () => deferred.promise);
    page.elements.btnVerifyAzure.dispatch("click");
    const statusBefore = page.elements.credVerifyStatus.innerHTML;

    page.controller.teardown();
    deferred.reject(new Error("late network failure"));
    await expect(flushPromises()).resolves.not.toThrow();
    expect(page.elements.credVerifyStatus.innerHTML).toBe(statusBefore);
  });
});

describe("AWS verification", () => {
  async function openAwsForm(page: ReturnType<typeof renderPage>) {
    page.browser.net.handle(`${GITHUB_IDENTITY_PATH}?fresh=1`, () =>
      jsonResponse({ actingLogin: "octocat", actingHasPackages: true })
    );
    page.elements.newCredBtn.dispatch("click");
    await flushPromises();
    page.elements.credProviderSelect.value = "aws";
    page.elements.credProviderSelect.dispatch("change");
  }

  it("requires a profile name before verifying", async () => {
    const page = renderPage();
    await openAwsForm(page);
    page.elements.btnVerifyAws.dispatch("click");
    expect(page.elements.credVerifyStatus.innerHTML).toContain(
      "Please enter a Profile Name"
    );
  });

  it("verifies successfully using the account id or arn as the user", async () => {
    const page = renderPage();
    await openAwsForm(page);
    page.elements.credNameInput.value = "acme-aws";
    page.elements.awsAccountId.value = "111122223333";
    page.elements.awsRegion.value = "us-west-2";
    page.browser.net.handle(VERIFY_AWS_PATH, (init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        accountId: "111122223333",
        region: "us-west-2"
      });
      return jsonResponse({
        arn: "arn:aws:iam::111122223333:user/me",
        accountId: "111122223333"
      });
    });
    page.elements.btnVerifyAws.dispatch("click");
    await flushPromises();
    expect(page.elements.credVerifyStatus.innerHTML).toContain(
      "arn:aws:iam::111122223333:user/me"
    );
    expect(page.elements.saveCredBtn.disabled).toBe(false);
  });

  it("shows the server error message on failure", async () => {
    const page = renderPage();
    await openAwsForm(page);
    page.elements.credNameInput.value = "acme-aws";
    page.browser.net.handle(VERIFY_AWS_PATH, () =>
      jsonResponse({ error: "not authorized" })
    );
    page.elements.btnVerifyAws.dispatch("click");
    await flushPromises();
    expect(page.elements.credVerifyStatus.innerHTML).toContain(
      "not authorized"
    );
  });

  it("shows a generic error without the raw exception on a network failure", async () => {
    const page = renderPage();
    await openAwsForm(page);
    page.elements.credNameInput.value = "acme-aws";
    page.browser.net.handle(VERIFY_AWS_PATH, () =>
      Promise.reject(new Error("raw secret"))
    );
    page.elements.btnVerifyAws.dispatch("click");
    await flushPromises();
    expect(page.elements.envVerifyModal.style.display).toBe("none");
    expect(page.elements.credVerifyStatus.innerHTML).toContain(
      "Could not verify credentials"
    );
    expect(page.elements.credVerifyStatus.innerHTML).not.toContain(
      "raw secret"
    );
  });

  it("keeps the form's blank account id when the server response omits one, and saves the blank fallback", async () => {
    const page = renderPage();
    await openAwsForm(page);
    page.elements.credNameInput.value = "acme-aws";
    page.browser.net.handle(VERIFY_AWS_PATH, () =>
      jsonResponse({ user: "iam-user" })
    );
    page.elements.btnVerifyAws.dispatch("click");
    await flushPromises();
    expect(page.elements.awsAccountId.value).toBe("");
    expect(page.elements.credVerifyStatus.innerHTML).toContain("iam-user");
    expect(page.elements.saveCredBtn.disabled).toBe(false);

    page.browser.net.handle(`${CREDENTIAL_PROFILES_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ profiles: [] })
    );
    page.browser.net.handle(CREDENTIAL_SAVE_PATH, (init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        repo: "octo/app",
        name: "acme-aws",
        provider: "aws",
        user: "iam-user",
        accountId: "",
        region: "",
        roleArn: ""
      });
      return jsonResponse({});
    });
    page.elements.saveCredBtn.dispatch("click");
    await flushPromises();
    expect(page.elements.credSuccessBanner.style.display).toBe("flex");
  });

  it("ignores a stale verify success response after switching provider away", async () => {
    const page = renderPage();
    await openAwsForm(page);
    page.elements.credNameInput.value = "acme-aws";
    const deferred = createDeferred<HttpResponse>();
    page.browser.net.handle(VERIFY_AWS_PATH, () => deferred.promise);
    page.elements.btnVerifyAws.dispatch("click");

    page.elements.credProviderSelect.value = "azure";
    page.elements.credProviderSelect.dispatch("change");
    const statusBefore = page.elements.credVerifyStatus.innerHTML;

    deferred.resolve(jsonResponse({ arn: "stale-arn" }));
    await flushPromises();
    expect(page.elements.credVerifyStatus.innerHTML).toBe(statusBefore);
    expect(page.elements.saveCredBtn.disabled).toBe(true);
  });

  it("ignores a verify network failure that resolves after teardown", async () => {
    const page = renderPage();
    await openAwsForm(page);
    page.elements.credNameInput.value = "acme-aws";
    const deferred = createDeferred<HttpResponse>();
    page.browser.net.handle(VERIFY_AWS_PATH, () => deferred.promise);
    page.elements.btnVerifyAws.dispatch("click");
    const statusBefore = page.elements.credVerifyStatus.innerHTML;

    page.controller.teardown();
    deferred.reject(new Error("late network failure"));
    await expect(flushPromises()).resolves.not.toThrow();
    expect(page.elements.credVerifyStatus.innerHTML).toBe(statusBefore);
  });
});

describe("saving a credential profile", () => {
  async function verifiedAzureForm(
    page: ReturnType<typeof renderPage>,
    options: { open?: boolean } = {}
  ) {
    page.browser.net.handle(`${GITHUB_IDENTITY_PATH}?fresh=1`, () =>
      jsonResponse({ actingLogin: "octocat", actingHasPackages: true })
    );
    if (options.open !== false) {
      page.elements.newCredBtn.dispatch("click");
      await flushPromises();
    }
    page.elements.credNameInput.value = "acme";
    page.elements.azTenantId.value = "t";
    page.elements.azSubId.value = "s";
    page.browser.net.handle(VERIFY_AZURE_PATH, () =>
      jsonResponse({
        user: "me@example.com",
        tenantId: "t",
        subscriptionId: "s",
        subscriptionName: "My Sub"
      })
    );
    page.elements.btnVerifyAzure.dispatch("click");
    await flushPromises();
  }

  it("hosts the credential form inside the wizard and returns it on cancel", async () => {
    const page = renderPage();
    page.browser.net.handle(`${GITHUB_IDENTITY_PATH}?fresh=1`, () =>
      jsonResponse({ actingLogin: "octocat", actingHasPackages: true })
    );

    page.elements.newCredBtn.dispatch("click");
    await flushPromises();
    expect(page.elements.credLanding.style.display).toBe("none");

    page.controller.startWizardCreation();
    await flushPromises();

    // In the wizard the form is relocated into the environment step so the
    // user never leaves the environment they are creating.
    expect(page.elements.credFormCard.parentNode).toBe(
      page.elements.wizardFormHost
    );
    expect(page.elements.wizardFormHost.style.display).toBe("");
    expect(page.elements.wizardStepCard.style.display).toBe("none");
    expect(page.elements.saveCredBtn.textContent).toBe("Save & Continue");
    expect(page.elements.cancelCredBtn.textContent).toBe("Cancel");

    page.elements.cancelCredBtn.dispatch("click");

    expect(page.elements.credFormCard.parentNode).toBe(page.elements.credForm);
    expect(page.elements.wizardFormHost.style.display).toBe("none");
    expect(page.elements.wizardStepCard.style.display).toBe("");
    // Cancelling the wizard form returns the card to its standalone home but
    // leaves it hidden, so the credentials pane is not revealed underneath.
    expect(page.elements.credForm.style.display).toBe("none");
    expect(page.elements.credLanding.style.display).toBe("");
  });

  it("hands a profile saved in the wizard back to the environment step", async () => {
    const page = renderPage();
    page.elements.newCredBtn.dispatch("click");
    await flushPromises();
    expect(page.elements.credLanding.style.display).toBe("none");
    page.controller.startWizardCreation();
    await flushPromises();
    await verifiedAzureForm(page, { open: false });
    page.browser.net.handle(CREDENTIAL_SAVE_PATH, () => jsonResponse({}));

    page.elements.saveCredBtn.dispatch("click");
    await flushPromises();

    expect(page.dependencies.credentialCreated).toHaveBeenCalledWith("acme");
    // The wizard continues on the environment step, so the standalone landing
    // success banner must not take over the pane.
    expect(page.elements.credSuccessBanner.style.display).not.toBe("flex");
    expect(page.elements.wizardFormHost.style.display).toBe("none");
    expect(page.elements.wizardStepCard.style.display).toBe("");
    expect(page.elements.credFormCard.parentNode).toBe(page.elements.credForm);
    expect(page.elements.credLanding.style.display).toBe("");
  });

  it("does not hand back a profile whose save resolves after the wizard form is cancelled", async () => {
    const page = renderPage();
    page.controller.startWizardCreation();
    await flushPromises();
    await verifiedAzureForm(page, { open: false });
    const deferred = createDeferred<HttpResponse>();
    page.browser.net.handle(CREDENTIAL_SAVE_PATH, () => deferred.promise);

    page.elements.saveCredBtn.dispatch("click");
    page.elements.cancelCredBtn.dispatch("click");
    deferred.resolve(jsonResponse({}));
    await flushPromises();

    // Cancelling abandons the form, so a save that lands afterwards must not
    // advance the wizard with a profile the user walked away from.
    expect(page.dependencies.credentialCreated).not.toHaveBeenCalled();
  });

  it("requires a profile name", () => {
    const page = renderPage();
    page.elements.saveCredBtn.dispatch("click");
    expect(page.decisions.notify).toHaveBeenCalledWith(
      "Please enter a profile name."
    );
  });

  it("requires verified credentials", () => {
    const page = renderPage();
    page.elements.credNameInput.value = "acme";
    page.elements.saveCredBtn.dispatch("click");
    expect(page.decisions.notify).toHaveBeenCalledWith(
      "Please verify your credentials first."
    );
  });

  it("saves an azure profile and shows the landing success banner", async () => {
    const page = renderPage();
    await verifiedAzureForm(page);
    page.browser.net.handle(`${CREDENTIAL_PROFILES_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ profiles: [] })
    );
    page.browser.net.handle(CREDENTIAL_SAVE_PATH, (init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        repo: "octo/app",
        name: "acme",
        provider: "azure",
        user: "me@example.com",
        tenantId: "t",
        subscriptionId: "s",
        subscriptionName: "My Sub"
      });
      return jsonResponse({});
    });
    page.elements.saveCredBtn.dispatch("click");
    expect(page.elements.saveCredBtn.disabled).toBe(true);
    expect(page.elements.saveCredBtn.textContent).toBe("Saving…");
    await flushPromises();
    expect(page.elements.credForm.style.display).toBe("none");
    expect(page.elements.credLanding.style.display).toBe("");
    expect(page.elements.credSuccessBanner.style.display).toBe("flex");
    expect(page.elements.credSuccessBannerText.innerHTML).toContain(
      "Successfully created credential profile acme"
    );
  });

  it("saves an azure profile with blank fallbacks when the server omits the user and subscription name", async () => {
    const page = renderPage();
    page.browser.net.handle(`${GITHUB_IDENTITY_PATH}?fresh=1`, () =>
      jsonResponse({ actingLogin: "octocat", actingHasPackages: true })
    );
    page.elements.newCredBtn.dispatch("click");
    await flushPromises();
    page.elements.credNameInput.value = "acme";
    page.elements.azTenantId.value = "t";
    page.elements.azSubId.value = "s";
    page.browser.net.handle(VERIFY_AZURE_PATH, () => jsonResponse({}));
    page.elements.btnVerifyAzure.dispatch("click");
    await flushPromises();

    page.browser.net.handle(`${CREDENTIAL_PROFILES_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ profiles: [] })
    );
    page.browser.net.handle(CREDENTIAL_SAVE_PATH, (init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        repo: "octo/app",
        name: "acme",
        provider: "azure",
        user: "",
        tenantId: "t",
        subscriptionId: "s",
        subscriptionName: ""
      });
      return jsonResponse({});
    });
    page.elements.saveCredBtn.dispatch("click");
    await flushPromises();
    expect(page.elements.credSuccessBanner.style.display).toBe("flex");
  });

  it("saves an aws profile including the role arn", async () => {
    const page = renderPage();
    page.browser.net.handle(`${GITHUB_IDENTITY_PATH}?fresh=1`, () =>
      jsonResponse({ actingLogin: "octocat", actingHasPackages: true })
    );
    page.elements.newCredBtn.dispatch("click");
    await flushPromises();
    page.elements.credProviderSelect.value = "aws";
    page.elements.credProviderSelect.dispatch("change");
    page.elements.credNameInput.value = "acme-aws";
    page.elements.awsAccountId.value = "111122223333";
    page.elements.awsRegion.value = "us-west-2";
    page.elements.awsRoleArn.value = "arn:aws:iam::111122223333:role/radius";
    page.browser.net.handle(VERIFY_AWS_PATH, () =>
      jsonResponse({
        arn: "arn:aws:iam::111122223333:user/me",
        accountId: "111122223333"
      })
    );
    page.elements.btnVerifyAws.dispatch("click");
    await flushPromises();

    page.browser.net.handle(`${CREDENTIAL_PROFILES_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ profiles: [] })
    );
    page.browser.net.handle(CREDENTIAL_SAVE_PATH, (init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        repo: "octo/app",
        name: "acme-aws",
        provider: "aws",
        user: "arn:aws:iam::111122223333:user/me",
        accountId: "111122223333",
        region: "us-west-2",
        roleArn: "arn:aws:iam::111122223333:role/radius"
      });
      return jsonResponse({});
    });
    page.elements.saveCredBtn.dispatch("click");
    await flushPromises();
    expect(page.elements.credSuccessBanner.style.display).toBe("flex");
  });

  it("shows the server error and restores the button on a failed save", async () => {
    const page = renderPage();
    await verifiedAzureForm(page);
    page.browser.net.handle(CREDENTIAL_SAVE_PATH, () =>
      jsonResponse({ error: "name already exists" })
    );
    page.elements.saveCredBtn.dispatch("click");
    await flushPromises();
    expect(page.decisions.notify).toHaveBeenCalledWith(
      "Could not save profile: name already exists"
    );
    expect(page.elements.saveCredBtn.disabled).toBe(false);
    expect(page.elements.saveCredBtn.textContent).toBe(
      "Save Credential Profile"
    );
    expect(page.elements.credForm.style.display).toBe("");
  });

  it("shows a generic error without the raw exception on a network failure", async () => {
    const page = renderPage();
    await verifiedAzureForm(page);
    page.browser.net.handle(CREDENTIAL_SAVE_PATH, () =>
      Promise.reject(new Error("raw secret"))
    );
    page.elements.saveCredBtn.dispatch("click");
    await flushPromises();
    expect(page.decisions.notify).toHaveBeenCalledWith(
      "Could not save the credential profile. Please try again."
    );
    expect(page.elements.saveCredBtn.disabled).toBe(false);
  });

  it("ignores a stale save response after the form is reopened", async () => {
    const page = renderPage();
    await verifiedAzureForm(page);
    const deferred = createDeferred<HttpResponse>();
    page.browser.net.handle(CREDENTIAL_SAVE_PATH, () => deferred.promise);
    page.elements.saveCredBtn.dispatch("click");

    page.browser.net.handle(`${CREDENTIAL_PROFILES_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ profiles: [] })
    );
    page.elements.cancelCredBtn.dispatch("click");
    await flushPromises();
    page.browser.net.handle(`${GITHUB_IDENTITY_PATH}?fresh=1`, () =>
      jsonResponse({ actingLogin: "octocat", actingHasPackages: true })
    );
    page.elements.newCredBtn.dispatch("click");
    await flushPromises();

    deferred.resolve(jsonResponse({}));
    await flushPromises();
    expect(page.elements.credSuccessBanner.style.display).toBe("none");
    expect(page.elements.credNameInput.value).toBe("");
  });

  it("ignores a save network failure that resolves after teardown", async () => {
    const page = renderPage();
    await verifiedAzureForm(page);
    const deferred = createDeferred<HttpResponse>();
    page.browser.net.handle(CREDENTIAL_SAVE_PATH, () => deferred.promise);
    page.elements.saveCredBtn.dispatch("click");

    page.controller.teardown();
    deferred.reject(new Error("late network failure"));
    await expect(flushPromises()).resolves.not.toThrow();
    expect(page.decisions.notify).not.toHaveBeenCalledWith(
      "Could not save the credential profile. Please try again."
    );
  });
});

describe("banner dismissal", () => {
  it("hides the success banner", () => {
    const page = renderPage();
    page.elements.credSuccessBanner.style.display = "flex";
    page.elements.credSuccessBannerClose.dispatch("click");
    expect(page.elements.credSuccessBanner.style.display).toBe("none");
  });
});

describe("teardown", () => {
  it("cleans listeners, timers, and requests, and ignores late work", async () => {
    const { page, rows } = await readyTable();
    const list = createDeferred<HttpResponse>();
    page.browser.net.handle(
      `${CREDENTIAL_PROFILES_PATH}?repo=octo%2Fapp`,
      () => list.promise
    );
    page.controller.loadCredentialTable();

    page.controller.teardown();
    page.controller.teardown();
    expect(page.browser.bindings.has(CREDENTIALS_ENTRY_KEY)).toBe(false);
    expect(page.elements.newCredBtn.listenerCount()).toBe(0);
    expect(page.elements.credProviderSelect.listenerCount()).toBe(0);

    list.resolve(jsonResponse({ profiles: [{ name: "late" }] }));
    await flushPromises();
    expect(page.elements.credTableBody.innerHTML).not.toContain("late");
    rows.remove.dispatch("click");
    expect(page.browser.net.calls).toHaveLength(2);
  });

  it("cancels a pending clipboard-copy reset timer on teardown", async () => {
    const page = renderPage();
    page.browser.net.handle(`${GITHUB_IDENTITY_PATH}?fresh=1`, () =>
      jsonResponse({ actingLogin: "octocat", actingHasPackages: false })
    );
    page.elements.newCredBtn.dispatch("click");
    await flushPromises();
    page.elements.credGhcrCopy.dispatch("click");
    await flushPromises();
    expect(page.browser.clock.pending).toBeGreaterThan(0);
    page.controller.teardown();
    expect(page.browser.clock.pending).toBe(0);
  });

  it("allows re-initializing after teardown", () => {
    const page = renderPage();
    page.controller.teardown();
    const reinitialized = initializeCredentialsPane(
      page.browser.context,
      { repo: "octo/app", decisions: page.decisions },
      page.dependencies
    );
    expect(isCredentialsPaneController(reinitialized)).toBe(true);
  });
});
