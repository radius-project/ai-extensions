import { describe, expect, it, vi } from "vitest";
import type { EnvironmentConfirmOptions } from "./confirm-dialog.js";
import {
  ENVIRONMENT_DELETE_PATH,
  ENVIRONMENT_LIST_PATH,
  ENVIRONMENT_POLL_MS,
  environmentRowsMarkup,
  environmentStatusMarkup,
  initializeEnvironmentPane,
  isEnvironmentPaneController,
  parseEnvironmentRecords,
  providerLabel,
  safeEnvironmentEditUrl
} from "./environments.js";
import {
  createDeferred,
  createFakeBrowser,
  createFakeElement,
  createFakeInput,
  flushPromises,
  jsonResponse
} from "../../../test/support/browser/fakes.js";
import type { FakeBrowser } from "../../../test/support/browser/fakes.js";
import type { HttpResponse } from "../ports.js";

function renderPage(repo = "octo/app", withoutInfraSelection = false) {
  const browser = createFakeBrowser();
  const elements = {
    environmentPane: createFakeElement("pane-environments"),
    credentialPane: createFakeElement("pane-credentials"),
    environmentLanding: createFakeElement("env-landing"),
    newEnvironment: createFakeElement("new-env-btn", "button"),
    environmentForm: createFakeElement("env-form"),
    environmentName: createFakeInput("env-name-input", "dev"),
    profileSelect: createFakeInput("env-profile-select"),
    submit: createFakeInput("deploy-btn"),
    stepOne: createFakeElement("env-step-credentials"),
    stepTwo: createFakeElement("env-step-details"),
    stepOneMarker: createFakeElement("env-wizard-step-1"),
    stepTwoMarker: createFakeElement("env-wizard-step-2"),
    stepOneNext: createFakeInput("env-step1-next"),
    stepTwoBack: createFakeElement("env-step2-back"),
    changeProfile: createFakeElement("env-change-profile-link"),
    profileButton: createFakeElement("env-profile-button"),
    selectedProvider: createFakeInput("env-selected-provider", "azure"),
    stepTwoTitle: createFakeElement("env-step2-title"),
    nameHelp: createFakeElement("env-name-help"),
    clientId: createFakeInput("az-client-id", "old-client"),
    deployStatus: createFakeElement("deploy-status"),
    tableBody: createFakeElement("env-table-body"),
    success: createFakeElement("env-success-banner"),
    successText: createFakeElement("env-success-banner-text"),
    error: createFakeElement("env-error-banner"),
    errorText: createFakeElement("env-error-banner-text"),
    warning: createFakeElement("env-warning-banner"),
    warningText: createFakeElement("env-warning-banner-text"),
    action: createFakeElement("env-action-banner"),
    actionText: createFakeElement("env-action-banner-text"),
    successClose: createFakeElement("env-success-banner-close"),
    errorClose: createFakeElement("env-error-banner-close"),
    warningClose: createFakeElement("env-warning-banner-close"),
    actionClose: createFakeElement("env-action-banner-close")
  };
  elements.environmentForm.style.display = "none";
  for (const element of Object.values(elements)) browser.document.add(element);

  const environmentTab = createFakeElement("environment-tab", "a");
  environmentTab.setAttribute("data-subtab", "environments");
  const credentialTab = createFakeElement("credential-tab", "a");
  credentialTab.setAttribute("data-subtab", "credentials");
  browser.document.addSelectorAll("#env-subtabs .rad-subtab", [
    environmentTab,
    credentialTab
  ]);

  const dependencies = {
    loadCredentialTable: vi.fn(),
    loadProfiles: vi.fn().mockResolvedValue(undefined),
    loadGitHubIdentity: vi.fn(),
    clearSharedAppPin: vi.fn(),
    setPendingInfraSelection: vi.fn(),
    currentInfraSelection: vi.fn(() => ({}))
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
  const initialized = initializeEnvironmentPane(
    browser.context,
    { repo, decisions, confirmDialog },
    withoutInfraSelection ?
      { ...dependencies, currentInfraSelection: undefined }
    : dependencies
  );
  if (!isEnvironmentPaneController(initialized)) {
    throw new Error("Expected environment pane controller.");
  }
  return {
    browser,
    elements,
    environmentTab,
    credentialTab,
    dependencies,
    decisions,
    confirmDialog,
    controller: initialized
  };
}

function addRowButtons(browser: FakeBrowser, name = "dev") {
  const deploy = createFakeInput("deploy-row");
  deploy.setAttribute("data-env", name);
  const remove = createFakeInput("delete-row");
  remove.setAttribute("data-env", name);
  const edit = createFakeInput("edit-row");
  edit.setAttribute("data-env", name);
  browser.document.addSelectorAll(".js-edit-env", [edit]);
  browser.document.addSelectorAll(".js-plan-deployment", [deploy]);
  browser.document.addSelectorAll(".js-delete-env", [remove]);
  return { deploy, remove, edit };
}

function renderRequiredOnly() {
  const browser = createFakeBrowser();
  for (const element of [
    createFakeElement("pane-environments"),
    createFakeElement("pane-credentials"),
    createFakeElement("env-landing"),
    createFakeElement("env-form"),
    createFakeInput("env-name-input"),
    createFakeInput("env-profile-select")
  ]) {
    browser.document.add(element);
  }
  const tab = createFakeElement("unnamed-tab");
  browser.document.addSelectorAll("#env-subtabs .rad-subtab", [tab]);
  const initialized = initializeEnvironmentPane(
    browser.context,
    {
      repo: "octo/app",
      decisions: { confirm: () => true, notify: () => {} }
    },
    {
      loadCredentialTable() {},
      loadProfiles() {
        return Promise.resolve();
      },
      loadGitHubIdentity() {},
      clearSharedAppPin() {},
      setPendingInfraSelection() {},
      currentInfraSelection() {
        return {};
      }
    }
  );
  if (!isEnvironmentPaneController(initialized)) {
    throw new Error("Expected minimal environment pane controller.");
  }
  return { browser, controller: initialized, tab };
}

describe("environment records and markup", () => {
  it.each([
    ["aws", "AWS"],
    ["azure", "Azure"],
    ["custom", "custom"],
    ["", "—"]
  ])("labels provider %s", (provider, expected) => {
    expect(providerLabel(provider)).toBe(expected);
  });

  it.each([
    ["success", "Success"],
    ["verified", "Verified"],
    ["failed", "Failed"],
    ["pending", "Pending"],
    ["unverified", "Unverified"],
    ["unknown", "Available"],
    ["mystery", "Pending"]
  ])("renders %s as text without a colored circle", (status, label) => {
    expect(environmentStatusMarkup(status)).toBe(label);
  });

  it("parses valid records and drops malformed or unnamed entries", () => {
    expect(
      parseEnvironmentRecords({
        environments: [
          {
            name: "dev",
            status: "pending",
            provider: "azure",
            credentialProfile: "profile",
            webUrl: "https://github.com/octo/app/settings/environments/dev",
            ignored: true
          },
          { name: 7 },
          null,
          "bad"
        ]
      })
    ).toEqual([
      {
        name: "dev",
        status: "pending",
        provider: "azure",
        credentialProfile: "profile",
        webUrl: "https://github.com/octo/app/settings/environments/dev",
        config: {
          resourceGroup: "",
          cluster: "",
          namespace: "",
          vpcId: "",
          subnetIds: ""
        }
      }
    ]);
    expect(parseEnvironmentRecords(null)).toEqual([]);
  });

  it("allows only GitHub HTTPS edit links", () => {
    expect(
      safeEnvironmentEditUrl(
        "https://github.com/octo/app/settings/environments/dev",
        "octo/app"
      )
    ).toBe("https://github.com/octo/app/settings/environments/dev");
    for (const unsafe of [
      "javascript:alert(1)",
      "https://example.test/",
      "not a url",
      ""
    ]) {
      expect(safeEnvironmentEditUrl(unsafe, "octo/app")).toBe(
        "https://github.com/octo/app/settings/environments"
      );
    }
  });

  it("renders empty and escaped environment rows", () => {
    expect(environmentRowsMarkup([], "octo/app")).toContain(
      "No environments created yet"
    );
    const hostile = '<img src=x onerror="alert(1)">';
    const markup = environmentRowsMarkup(
      [
        {
          name: hostile,
          status: "success",
          provider: hostile,
          credentialProfile: hostile,
          webUrl: "javascript:alert(1)"
        }
      ],
      "octo/app"
    );
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;img");
    expect(markup).toContain("<td>Success</td>");
    expect(markup).not.toContain("rad-dot");
    // Editing happens in the canvas rather than on GitHub, so the row carries
    // a button rather than an external link.
    expect(markup).not.toContain("href=");
    expect(markup).toContain("js-edit-env");
    expect(markup).toContain(
      '<button class="rad-btn rad-btn--neutral js-plan-deployment"'
    );
    expect(markup).toContain(">Plan Deployment</button>");
    expect(markup).not.toContain("Deploy Apps");
    expect(markup.indexOf("js-edit-env")).toBeLessThan(
      markup.indexOf("js-plan-deployment")
    );
    expect(markup.indexOf("js-plan-deployment")).toBeLessThan(
      markup.indexOf("js-delete-env")
    );
  });
});

describe("environment pane initialization", () => {
  it("does nothing when required page markup is absent", () => {
    const browser = createFakeBrowser();
    const initialized = initializeEnvironmentPane(
      browser.context,
      {
        repo: "octo/app",
        decisions: { confirm: () => true, notify: () => {} }
      },
      {
        loadCredentialTable() {},
        loadProfiles() {},
        loadGitHubIdentity() {},
        clearSharedAppPin() {}
      }
    );
    expect(isEnvironmentPaneController(initialized)).toBe(false);
    if (isEnvironmentPaneController(initialized)) {
      throw new Error("Expected a no-op teardown.");
    }
    expect(() => initialized()).not.toThrow();
  });

  it("switches subtabs, updates navigation, and refreshes the active pane", () => {
    const page = renderPage();
    page.controller.switchSubtab("credentials");

    expect(page.elements.environmentPane.style.display).toBe("none");
    expect(page.elements.credentialPane.style.display).toBe("");
    expect(page.credentialTab.className).toContain("rad-subtab--active");
    expect(page.browser.nav.replaced).toEqual(["/?page=credentials"]);
    expect(page.dependencies.loadCredentialTable).toHaveBeenCalledOnce();

    page.elements.environmentForm.style.display = "";
    page.elements.profileSelect.value = "new-profile";
    page.browser.net.handle(`${ENVIRONMENT_LIST_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ environments: [] })
    );
    page.controller.switchSubtab("environments");

    expect(page.elements.environmentPane.style.display).toBe("");
    expect(page.elements.credentialPane.style.display).toBe("none");
    expect(page.environmentTab.className).toContain("rad-subtab--active");
    expect(page.browser.nav.replaced.at(-1)).toBe("/?page=environment");
    expect(page.dependencies.loadProfiles).toHaveBeenCalledWith("new-profile");
  });

  it("drives subtab switching from links and prevents native navigation", () => {
    const page = renderPage();
    const preventDefault = vi.fn();

    page.credentialTab.dispatch("click", { preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(page.dependencies.loadCredentialTable).toHaveBeenCalledOnce();
  });

  it("binds once and tolerates optional controls being absent", () => {
    const page = renderRequiredOnly();
    const second = initializeEnvironmentPane(
      page.browser.context,
      {
        repo: "octo/app",
        decisions: { confirm: () => true, notify: () => {} }
      },
      {
        loadCredentialTable() {},
        loadProfiles() {},
        loadGitHubIdentity() {},
        clearSharedAppPin() {}
      }
    );
    expect(isEnvironmentPaneController(second)).toBe(false);
    if (isEnvironmentPaneController(second)) {
      throw new Error("Expected an already-bound no-op teardown.");
    }
    second();

    expect(() => {
      page.tab.dispatch("click");
      page.controller.loadEnvironmentTable();
      page.controller.showEnvironmentForm();
      page.controller.showSuccess("azure", "dev");
      page.controller.showError("error");
      page.controller.showWarnings(["⚠️ warning"]);
      page.controller.showActionRequired("azure", "dev", "");
      page.controller.hideTerminalBanners();
      page.controller.resetSubmitButton();
    }).not.toThrow();
  });

  it("does not refresh profiles while returning to a hidden form", () => {
    const page = renderPage();
    page.browser.net.handle(`${ENVIRONMENT_LIST_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ environments: [] })
    );
    page.controller.switchSubtab("environments");
    expect(page.dependencies.loadProfiles).not.toHaveBeenCalled();
  });

  it("opens and closes the environment form with fresh cross-pane state", async () => {
    const page = renderPage();
    page.elements.deployStatus.style.display = "block";
    page.elements.success.style.display = "flex";

    // Loading the preset profile selects it, which is what lets the wizard
    // advance past the credential step.
    page.dependencies.loadProfiles.mockImplementation((profile?: string) => {
      page.elements.profileSelect.value = profile ?? "";
    });
    page.controller.showEnvironmentForm({
      name: "prod",
      profile: "azure-prod"
    });

    expect(page.elements.environmentName.value).toBe("prod");
    expect(page.elements.clientId.value).toBe("");
    expect(page.elements.deployStatus.style.display).toBe("none");
    expect(page.elements.environmentLanding.style.display).toBe("none");
    expect(page.elements.environmentForm.style.display).toBe("");
    expect(page.dependencies.clearSharedAppPin).toHaveBeenCalledOnce();
    expect(page.dependencies.loadProfiles).toHaveBeenCalledWith("azure-prod");
    expect(page.dependencies.loadGitHubIdentity).toHaveBeenCalledWith();
    // The form opens on the credential step and only advances to the details
    // step once the preset profile has loaded, so the name is focused then.
    expect(
      page.elements.stepTwoMarker.classList.contains("rad-wizard__step--active")
    ).toBe(false);
    await flushPromises();
    expect(
      page.elements.stepTwoMarker.classList.contains("rad-wizard__step--active")
    ).toBe(true);
    expect(page.elements.stepTwoMarker.getAttribute("aria-current")).toBe(
      "step"
    );
    expect(page.elements.environmentName.focusCount).toBe(1);
    expect(page.elements.success.style.display).toBe("none");

    page.browser.net.handle(`${ENVIRONMENT_LIST_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ environments: [] })
    );
    page.controller.showEnvironmentLanding();
    expect(page.elements.environmentForm.style.display).toBe("none");
    expect(page.elements.environmentLanding.style.display).toBe("");
    expect(page.elements.newEnvironment.focusCount).toBe(1);
  });

  it("returns to the landing view when the reveal control is absent", () => {
    const page = renderRequiredOnly();
    expect(() => page.controller.showEnvironmentLanding()).not.toThrow();
  });

  it("opens an existing environment for editing without renaming it", async () => {
    const page = renderPage();
    page.dependencies.loadProfiles.mockImplementation((profile?: string) => {
      page.elements.profileSelect.value = profile ?? "";
    });

    page.controller.showEnvironmentForm({
      name: "prod",
      profile: "azure-prod",
      config: { resourceGroup: "rg-prod" },
      editing: "prod"
    });
    await flushPromises();

    expect(page.elements.environmentName.value).toBe("prod");
    // An environment cannot be renamed, so editing locks the name field and
    // explains why instead of silently ignoring a changed value.
    expect(page.elements.environmentName.disabled).toBe(true);
    expect(page.elements.environmentName.focusCount).toBe(0);
    expect(page.elements.stepTwoTitle.textContent).toBe("Edit Environment");
    expect(page.elements.nameHelp.textContent).toContain("cannot be renamed");
    expect(page.dependencies.setPendingInfraSelection).toHaveBeenCalledWith(
      { resourceGroup: "rg-prod" },
      "azure"
    );
  });

  it("restores aws infrastructure when editing an aws environment", async () => {
    const page = renderPage();
    page.dependencies.loadProfiles.mockImplementation((profile?: string) => {
      page.elements.profileSelect.value = profile ?? "";
    });

    page.controller.showEnvironmentForm({
      name: "prod",
      profile: "aws-prod",
      provider: "aws",
      config: { cluster: "eks-prod" },
      editing: "prod"
    });
    await flushPromises();

    expect(page.dependencies.setPendingInfraSelection).toHaveBeenCalledWith(
      { cluster: "eks-prod" },
      "aws"
    );
  });

  it("labels a fresh form for creation and carries no pending infrastructure", () => {
    const page = renderPage();

    page.controller.showEnvironmentForm();

    expect(page.elements.environmentName.disabled).toBe(false);
    expect(page.elements.stepTwoTitle.textContent).toBe("Create Environment");
    expect(page.elements.nameHelp.textContent).toContain("deploy apps into");
    expect(page.dependencies.setPendingInfraSelection).toHaveBeenCalledWith(
      null,
      "azure"
    );
  });

  it("keeps the wizard on the credential step when asked not to advance", async () => {
    const page = renderPage();
    page.dependencies.loadProfiles.mockImplementation((profile?: string) => {
      page.elements.profileSelect.value = profile ?? "";
    });

    page.controller.showEnvironmentForm({
      profile: "azure-prod",
      advance: false
    });
    await flushPromises();

    expect(
      page.elements.stepTwoMarker.classList.contains("rad-wizard__step--active")
    ).toBe(false);
    expect(page.elements.stepOne.style.display).toBe("");
    expect(page.elements.stepTwo.style.display).toBe("none");
  });

  it("opens the edit form from an environment row", async () => {
    const page = renderPage();
    const { edit } = addRowButtons(page.browser, "dev");
    edit.setAttribute("data-env", "dev");
    page.browser.net.handle(`${ENVIRONMENT_LIST_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({
        environments: [
          {
            name: "dev",
            provider: "azure",
            status: "success",
            credentialProfile: "azure-prod",
            config: { resourceGroup: "rg-dev" }
          }
        ]
      })
    );
    page.controller.loadEnvironmentTable();
    await flushPromises();

    edit.dispatch("click");

    expect(page.elements.environmentForm.style.display).toBe("");
    expect(page.elements.environmentName.value).toBe("dev");
    expect(page.elements.environmentName.disabled).toBe(true);
    expect(page.dependencies.loadProfiles).toHaveBeenCalledWith("azure-prod");
    expect(page.dependencies.setPendingInfraSelection).toHaveBeenCalledWith(
      expect.objectContaining({ resourceGroup: "rg-dev" }),
      "azure"
    );
  });

  it("ignores an edit button that carries no environment name", async () => {
    const page = renderPage();
    const { edit } = addRowButtons(page.browser, "dev");
    edit.removeAttribute("data-env");
    page.browser.net.handle(`${ENVIRONMENT_LIST_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({
        environments: [{ name: "dev", provider: "azure", status: "success" }]
      })
    );
    page.controller.loadEnvironmentTable();
    await flushPromises();

    edit.dispatch("click");

    expect(page.elements.environmentForm.style.display).toBe("none");
  });

  it("edits an environment that stored no infrastructure selection", async () => {
    const page = renderPage();

    page.controller.showEnvironmentForm({ name: "prod", editing: "prod" });

    expect(page.dependencies.setPendingInfraSelection).toHaveBeenCalledWith(
      null,
      "azure"
    );
  });

  it("labels the submit button for the environment being saved", () => {
    const page = renderPage();

    page.controller.showEnvironmentForm({ name: "prod", editing: "prod" });

    expect(page.elements.submit.textContent).toBe("Save Environment");
    expect(page.elements.submit.disabled).toBe(false);

    page.controller.showEnvironmentForm();

    expect(page.elements.submit.textContent).toBe("Create Environment");
  });

  it("restores the open form's infrastructure when returning from credentials", async () => {
    const page = renderPage();
    page.elements.selectedProvider.value = "aws";
    page.browser.net.handle(`${ENVIRONMENT_LIST_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ environments: [] })
    );
    page.dependencies.currentInfraSelection.mockReturnValue({
      cluster: "eks-1"
    });
    page.controller.showEnvironmentForm();
    await flushPromises();
    page.dependencies.setPendingInfraSelection.mockClear();

    page.controller.switchSubtab("environments");

    expect(page.dependencies.currentInfraSelection).toHaveBeenCalledWith("aws");
    expect(page.dependencies.setPendingInfraSelection).toHaveBeenCalledWith(
      { cluster: "eks-1" },
      "aws"
    );
    expect(page.dependencies.loadProfiles).toHaveBeenCalledWith("");
  });

  it("falls back to an empty selection when no discovery panel is wired", async () => {
    const page = renderPage("octo/app", true);
    page.browser.net.handle(`${ENVIRONMENT_LIST_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ environments: [] })
    );
    page.controller.showEnvironmentForm();
    await flushPromises();
    page.dependencies.setPendingInfraSelection.mockClear();

    page.controller.switchSubtab("environments");

    expect(page.dependencies.setPendingInfraSelection).toHaveBeenCalledWith(
      {},
      "azure"
    );
  });

  it("ignores an edit request for a row that is no longer listed", async () => {
    const page = renderPage();
    const { edit } = addRowButtons(page.browser, "dev");
    edit.setAttribute("data-env", "ghost");
    page.browser.net.handle(`${ENVIRONMENT_LIST_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({
        environments: [{ name: "dev", provider: "azure", status: "success" }]
      })
    );
    page.controller.loadEnvironmentTable();
    await flushPromises();

    edit.dispatch("click");

    expect(page.elements.environmentForm.style.display).toBe("none");
  });

  it("moves between the credential and detail steps from the wizard controls", async () => {
    const page = renderPage();
    page.controller.showEnvironmentForm();
    await flushPromises();

    // Without a chosen profile the wizard refuses to advance, because the
    // environment cannot be created without a credential.
    page.elements.stepOneNext.dispatch("click");
    expect(page.elements.stepTwo.style.display).toBe("none");
    expect(page.elements.environmentName.focusCount).toBe(0);

    page.elements.profileSelect.value = "azure-prod";
    page.elements.stepOneNext.dispatch("click");
    expect(page.elements.stepTwo.style.display).toBe("");
    expect(page.elements.stepOne.style.display).toBe("none");
    expect(page.elements.environmentName.focusCount).toBe(1);
    expect(
      page.elements.stepOneMarker.classList.contains("rad-wizard__step--done")
    ).toBe(true);

    page.elements.stepTwoBack.dispatch("click");
    expect(page.elements.stepOne.style.display).toBe("");
    expect(page.elements.stepOneMarker.getAttribute("aria-current")).toBe(
      "step"
    );

    page.elements.stepOneNext.dispatch("click");
    page.elements.changeProfile.dispatch("click");
    expect(page.elements.stepOne.style.display).toBe("");
    expect(page.elements.stepTwoMarker.getAttribute("aria-current")).toBe(null);
  });

  it("uses empty form defaults when no preset is supplied", () => {
    const page = renderPage();
    page.controller.showEnvironmentForm();
    expect(page.elements.environmentName.value).toBe("");
    expect(page.dependencies.loadProfiles).toHaveBeenCalledWith(undefined);
  });
});

describe("environment list behavior", () => {
  it("renders the local empty state without a repository request", () => {
    const page = renderPage("");
    page.controller.loadEnvironmentTable();

    expect(page.elements.tableBody.innerHTML).toContain(
      "No environments created yet"
    );
    expect(page.browser.net.calls).toHaveLength(0);
  });

  it("renders records, wires Plan Deployment navigation, and polls pending state", async () => {
    const page = renderPage();
    const rows = addRowButtons(page.browser);
    page.browser.net.handle(`${ENVIRONMENT_LIST_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({
        environments: [
          {
            name: "dev",
            status: "pending",
            provider: "azure",
            credentialProfile: "profile"
          }
        ]
      })
    );

    page.controller.loadEnvironmentTable();
    await flushPromises();

    expect(page.elements.tableBody.innerHTML).toContain("dev");
    expect(rows.deploy.listenerCount("click")).toBe(1);
    rows.deploy.dispatch("click");
    expect(page.browser.nav.assigned).toEqual(["/?page=planned&env=dev"]);
    expect(page.browser.clock.timeouts).toBe(1);

    page.browser.clock.tick(ENVIRONMENT_POLL_MS);
    await flushPromises();
    expect(page.browser.net.calls).toHaveLength(2);
    expect(rows.deploy.listenerCount("click")).toBe(1);
  });

  it("URL-encodes the environment selected for planning", async () => {
    const page = renderPage();
    const rows = addRowButtons(page.browser, "dev/team east");
    page.browser.net.handle(`${ENVIRONMENT_LIST_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({
        environments: [{ name: "dev/team east", status: "success" }]
      })
    );
    page.controller.loadEnvironmentTable();
    await flushPromises();

    rows.deploy.dispatch("click");
    expect(page.browser.nav.assigned).toEqual([
      "/?page=planned&env=dev%2Fteam%20east"
    ]);
  });

  it("navigates to the unqualified planned page for an unnamed row", async () => {
    const page = renderPage();
    const rows = addRowButtons(page.browser, "");
    page.browser.net.handle(`${ENVIRONMENT_LIST_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({
        environments: [{ name: "dev", status: "success" }]
      })
    );
    page.controller.loadEnvironmentTable();
    await flushPromises();

    rows.deploy.dispatch("click");
    expect(page.browser.nav.assigned).toEqual(["/?page=planned"]);
  });

  it("treats missing row data attributes as empty", async () => {
    const page = renderPage();
    const deploy = createFakeInput("deploy-row");
    const remove = createFakeInput("delete-row");
    page.browser.document.addSelectorAll(".js-plan-deployment", [deploy]);
    page.browser.document.addSelectorAll(".js-delete-env", [remove]);
    page.browser.net.handle(`${ENVIRONMENT_LIST_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({
        environments: [{ name: "dev", status: "success" }]
      })
    );
    page.controller.loadEnvironmentTable();
    await flushPromises();

    deploy.dispatch("click");
    remove.dispatch("click");
    expect(page.browser.nav.assigned).toEqual(["/?page=planned"]);
    expect(
      page.browser.net.calls.filter(
        (entry) => entry.url === ENVIRONMENT_DELETE_PATH
      )
    ).toHaveLength(0);
  });

  it("loads without an AbortController", async () => {
    const page = renderPage();
    page.browser.net.supportsAbort = false;
    page.browser.net.handle(`${ENVIRONMENT_LIST_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ environments: [] })
    );
    page.controller.loadEnvironmentTable();
    page.controller.loadEnvironmentTable();
    await flushPromises();
    expect(page.elements.tableBody.innerHTML).toContain(
      "No environments created yet"
    );
  });

  it("renders empty, malformed, HTTP-error, and rejected responses safely", async () => {
    const page = renderPage();
    let mode: "empty" | "malformed" | "http" | "reject" = "empty";
    page.browser.net.handle(`${ENVIRONMENT_LIST_PATH}?repo=octo%2Fapp`, () => {
      if (mode === "reject") return Promise.reject(new Error("offline"));
      if (mode === "http") return jsonResponse({}, false, 503);
      if (mode === "malformed") return jsonResponse({ environments: "bad" });
      return jsonResponse({ environments: [] });
    });

    page.controller.loadEnvironmentTable();
    await flushPromises();
    expect(page.elements.tableBody.innerHTML).toContain(
      "No environments created yet"
    );

    mode = "malformed";
    page.controller.loadEnvironmentTable();
    await flushPromises();
    expect(page.elements.tableBody.innerHTML).toContain(
      "No environments created yet"
    );

    mode = "http";
    page.controller.loadEnvironmentTable();
    await flushPromises();
    expect(page.elements.tableBody.innerHTML).toContain(
      "Could not load environments"
    );

    mode = "reject";
    page.controller.loadEnvironmentTable();
    await flushPromises();
    expect(page.elements.tableBody.innerHTML).toContain(
      "Could not load environments"
    );
  });

  it("ignores a stale list response", async () => {
    const page = renderPage();
    page.browser.net.supportsAbort = false;
    const first = createDeferred<HttpResponse>();
    const second = createDeferred<HttpResponse>();
    const queue = [first, second];
    page.browser.net.handle(
      `${ENVIRONMENT_LIST_PATH}?repo=octo%2Fapp`,
      () => queue.shift()?.promise ?? Promise.reject(new Error("extra request"))
    );

    page.controller.loadEnvironmentTable();
    page.controller.loadEnvironmentTable();
    second.resolve(
      jsonResponse({ environments: [{ name: "current", status: "success" }] })
    );
    await flushPromises();
    first.resolve(
      jsonResponse({ environments: [{ name: "stale", status: "success" }] })
    );
    await flushPromises();

    expect(page.elements.tableBody.innerHTML).toContain("current");
    expect(page.elements.tableBody.innerHTML).not.toContain("stale");
  });
});

// The table is the server's listing and nothing else. A rollback removes the
// environment behind a row that is still reported as Pending — because the
// setup's verify run never completed — so the reload after the rollback has to
// take the row away, and nothing in the browser may keep it, re-add it, or
// invent one for an operation that just finished.
describe("environment rows after a rollback", () => {
  function listing(page: ReturnType<typeof renderPage>, payloads: unknown[]) {
    page.browser.net.handle(`${ENVIRONMENT_LIST_PATH}?repo=octo%2Fapp`, () => {
      const next = payloads.shift();
      if (next === undefined) throw new Error("unexpected listing request");
      return jsonResponse(next);
    });
  }

  it("takes the pending row away when the listing stops reporting it", async () => {
    const page = renderPage();
    listing(page, [
      { environments: [{ name: "dev", status: "pending", provider: "azure" }] },
      { environments: [] }
    ]);

    page.controller.loadEnvironmentTable();
    await flushPromises();
    expect(page.elements.tableBody.innerHTML).toContain("dev");
    expect(page.elements.tableBody.innerHTML).toContain("Pending");
    // A pending row keeps the table polling, which is how a row that is still
    // being removed refreshes itself.
    expect(page.browser.clock.timeouts).toBe(1);

    page.controller.loadEnvironmentTable();
    await flushPromises();

    expect(page.elements.tableBody.innerHTML).toContain(
      "No environments created yet"
    );
    expect(page.elements.tableBody.innerHTML).not.toContain("dev");
    // Nothing is pending any more, so the table stops polling instead of
    // re-rendering the environment the rollback removed.
    expect(page.browser.clock.timeouts).toBe(0);
    expect(page.browser.net.calls).toHaveLength(2);
  });

  it("keeps a pending row the listing still reports after a stop", async () => {
    const page = renderPage();
    listing(page, [
      { environments: [{ name: "dev", status: "pending", provider: "azure" }] },
      { environments: [{ name: "dev", status: "pending", provider: "azure" }] }
    ]);

    page.controller.loadEnvironmentTable();
    await flushPromises();
    page.controller.loadEnvironmentTable();
    await flushPromises();

    // A stopped setup keeps its resources, so the row that reports them is the
    // truthful one and the table keeps watching it.
    expect(page.elements.tableBody.innerHTML).toContain("dev");
    expect(page.elements.tableBody.innerHTML).toContain("Pending");
    expect(page.browser.clock.timeouts).toBe(1);
  });

  it("renders exactly the rows the listing returned, in its order", async () => {
    const page = renderPage();
    listing(page, [
      {
        environments: [
          { name: "staging", status: "success", provider: "azure" },
          { name: "prod", status: "failed", provider: "aws" }
        ]
      }
    ]);

    page.controller.loadEnvironmentTable();
    await flushPromises();

    const body = page.elements.tableBody.innerHTML;
    expect(body.indexOf("staging")).toBeGreaterThan(-1);
    expect(body.indexOf("staging")).toBeLessThan(body.indexOf("prod"));
    expect(body.match(/<tr>/g)).toHaveLength(2);
    expect(body).not.toContain("Pending");
  });
});

describe("environment deletion", () => {
  async function readyDelete(name = "dev") {
    const page = renderPage();
    const rows = addRowButtons(page.browser, name);
    page.browser.net.handle(`${ENVIRONMENT_LIST_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({
        environments: [{ name: "dev", status: "success" }]
      })
    );
    page.controller.loadEnvironmentTable();
    await flushPromises();
    return { page, rows };
  }

  it("does not dispatch without identity or confirmation", async () => {
    const unnamed = await readyDelete("");
    unnamed.rows.remove.dispatch("click");
    expect(unnamed.page.confirmDialog.show).not.toHaveBeenCalled();
    expect(unnamed.page.browser.net.calls).toHaveLength(1);

    const refused = await readyDelete();
    refused.page.confirmDialog.show.mockImplementation(() => {});
    refused.rows.remove.dispatch("click");
    expect(refused.page.confirmDialog.show).toHaveBeenCalledOnce();
    expect(refused.page.confirmDialog.show.mock.calls[0][0].title).toBe(
      "Delete environment?"
    );
    expect(refused.page.browser.net.calls).toHaveLength(1);
  });

  it("posts the exact target and refreshes only after explicit success", async () => {
    const { page, rows } = await readyDelete();
    page.browser.net.handle(ENVIRONMENT_DELETE_PATH, () =>
      jsonResponse({ success: true })
    );

    rows.remove.dispatch("click");
    expect(rows.remove.disabled).toBe(true);
    expect(rows.remove.textContent).toBe("Deleting…");
    await flushPromises();

    const call = page.browser.net.calls.find(
      (entry) => entry.url === ENVIRONMENT_DELETE_PATH
    );
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      repo: "octo/app",
      environment: "dev"
    });
    expect(page.browser.net.calls.at(-1)?.url).toBe(
      `${ENVIRONMENT_LIST_PATH}?repo=octo%2Fapp`
    );
  });

  it.each([
    ["HTTP error", jsonResponse({ error: "Denied" }, false, 500)],
    ["success-shaped error", jsonResponse({ error: "Still active" })],
    ["malformed refusal", jsonResponse({}, false, 500)]
  ])("fails closed on %s", async (_name, response) => {
    const { page, rows } = await readyDelete();
    page.browser.net.handle(ENVIRONMENT_DELETE_PATH, () => response);

    rows.remove.dispatch("click");
    await flushPromises();

    expect(rows.remove.disabled).toBe(false);
    expect(rows.remove.textContent).toBe("Delete Env");
    expect(page.decisions.notify).toHaveBeenCalled();
    expect(
      page.browser.net.calls.filter((entry) =>
        entry.url.includes(ENVIRONMENT_LIST_PATH)
      )
    ).toHaveLength(1);
  });

  it("explains an app conflict instead of navigating away", async () => {
    const { page, rows } = await readyDelete();
    page.confirmDialog.show
      .mockReset()
      .mockImplementationOnce((options: EnvironmentConfirmOptions) =>
        options.onConfirm()
      )
      .mockImplementation(() => {});
    page.browser.net.handle(ENVIRONMENT_DELETE_PATH, () =>
      jsonResponse(
        {
          code: "app-deployed",
          error: "Delete the app first.",
          redirect: "javascript:alert(1)"
        },
        false,
        409
      )
    );

    rows.remove.dispatch("click");
    await flushPromises();
    // Nothing was deleted, so the page stays put and explains why rather than
    // sweeping the user off to another page on a timer.
    expect(page.browser.clock.timeouts).toBe(0);
    expect(page.browser.nav.assigned).toEqual([]);
    expect(rows.remove.disabled).toBe(false);
    expect(rows.remove.textContent).toBe("Delete Env");

    const conflict = page.confirmDialog.show.mock.calls[1][0];
    expect(conflict.title).toBe("Delete the application first");
    expect(conflict.message).toContain("Delete the app first.");
    expect(conflict.message).toContain("Nothing has been deleted.");
    expect(conflict.confirmLabel).toBe("Go to Deployments");
    expect(conflict.confirmVariant).toBe("primary");
    expect(conflict.cancelLabel).toBe("Stay here");

    // Only an explicit confirmation navigates, and a hostile redirect is
    // replaced by the deployments page.
    conflict.onConfirm();
    expect(page.browser.nav.assigned).toEqual(["/?page=deploying"]);
  });

  it("keeps a same-page deployment conflict redirect", async () => {
    const { page, rows } = await readyDelete();
    page.confirmDialog.show
      .mockReset()
      .mockImplementationOnce((options: EnvironmentConfirmOptions) =>
        options.onConfirm()
      )
      .mockImplementation(() => {});
    page.browser.net.handle(ENVIRONMENT_DELETE_PATH, () =>
      jsonResponse(
        {
          code: "app-deployed",
          redirect: "/?page=deploying&env=dev"
        },
        false,
        409
      )
    );

    rows.remove.dispatch("click");
    await flushPromises();
    const conflict = page.confirmDialog.show.mock.calls[1][0];
    expect(conflict.message).toContain(
      "An application is still deployed to this environment."
    );
    conflict.onConfirm();
    expect(page.browser.nav.assigned).toEqual(["/?page=deploying&env=dev"]);
  });

  it("keeps a failed-teardown recovery redirect", async () => {
    const { page, rows } = await readyDelete();
    page.confirmDialog.show
      .mockReset()
      .mockImplementationOnce((options: EnvironmentConfirmOptions) =>
        options.onConfirm()
      )
      .mockImplementation(() => {});
    page.browser.net.handle(ENVIRONMENT_DELETE_PATH, () =>
      jsonResponse(
        {
          code: "app-deployed",
          error: "The previous teardown failed.",
          redirect: "/?page=deployed&application=app&environment=dev"
        },
        false,
        409
      )
    );

    rows.remove.dispatch("click");
    await flushPromises();
    const conflict = page.confirmDialog.show.mock.calls[1][0];
    expect(conflict.message).toContain("The previous teardown failed.");
    conflict.onConfirm();
    expect(page.browser.nav.assigned).toEqual([
      "/?page=deployed&application=app&environment=dev"
    ]);
  });

  it("restores the row and reports a request failure", async () => {
    const { page, rows } = await readyDelete();
    page.browser.net.handle(ENVIRONMENT_DELETE_PATH, () =>
      Promise.reject(new Error("offline"))
    );

    rows.remove.dispatch("click");
    await flushPromises();

    expect(rows.remove.disabled).toBe(false);
    expect(rows.remove.textContent).toBe("Delete Env");
    expect(page.decisions.notify).toHaveBeenCalledWith(
      "Could not delete the environment. Please try again."
    );
  });

  it("ignores late delete success and failure after teardown", async () => {
    const success = await readyDelete();
    const pendingSuccess = createDeferred<HttpResponse>();
    success.page.browser.net.handle(
      ENVIRONMENT_DELETE_PATH,
      () => pendingSuccess.promise
    );
    success.rows.remove.dispatch("click");
    await flushPromises();
    success.page.controller.teardown();
    pendingSuccess.resolve(jsonResponse({ success: true }));
    await flushPromises();
    expect(success.page.browser.net.calls).toHaveLength(2);

    const failure = await readyDelete();
    const pendingFailure = createDeferred<HttpResponse>();
    failure.page.browser.net.handle(
      ENVIRONMENT_DELETE_PATH,
      () => pendingFailure.promise
    );
    failure.rows.remove.dispatch("click");
    await flushPromises();
    failure.page.controller.teardown();
    pendingFailure.reject(new Error("late"));
    await flushPromises();
    expect(failure.page.decisions.notify).not.toHaveBeenCalled();
  });
});

describe("environment terminal banners", () => {
  it("renders escaped success and plain-text failure", () => {
    const page = renderPage();
    const hostile = '<img src=x onerror="alert(1)">';

    page.controller.showSuccess(hostile, hostile);
    expect(page.elements.successText.innerHTML).not.toContain("<img");
    expect(page.elements.successText.innerHTML).toContain("&lt;img");
    expect(page.elements.success.style.display).toBe("flex");

    page.controller.showError(hostile);
    expect(page.elements.errorText.textContent).toBe(hostile);
    expect(page.elements.error.style.display).toBe("flex");
    expect(page.elements.error.scrollCount).toBe(1);
  });

  it("shows only warning-prefixed setup steps", () => {
    const page = renderPage();
    page.controller.showWarnings([
      "done",
      "⚠️ grant role manually",
      7,
      "⚠️ check access"
    ]);
    expect(page.elements.warningText.textContent).toBe(
      "⚠️ grant role manually\n\n⚠️ check access"
    );
    expect(page.elements.warning.style.display).toBe("flex");

    page.controller.showWarnings("malformed");
    expect(page.elements.warning.style.display).toBe("none");
  });

  it("renders safe pull-request and manual action-required states", () => {
    const page = renderPage();
    page.controller.showActionRequired(
      "azure",
      "prod",
      "https://github.com/octo/app/pull/1"
    );
    expect(page.elements.actionText.innerHTML).toContain(
      "Review the pull request"
    );
    expect(page.elements.actionText.innerHTML).toContain(
      'href="https://github.com/octo/app/pull/1"'
    );

    page.controller.showActionRequired(
      "azure",
      "prod",
      "https://github.com/octo/app/pull/1",
      {
        userMessage:
          "I couldn't push workflow files for <octo/app>; merge the pull request."
      }
    );
    expect(page.elements.actionText.innerHTML).toContain(
      "I couldn&#39;t push workflow files for &lt;octo/app&gt;; merge the pull request."
    );
    expect(page.elements.actionText.innerHTML).toContain(
      'href="https://github.com/octo/app/pull/1"'
    );

    page.controller.showActionRequired("aws", "<prod>", "javascript:alert(1)", {
      branch: "<setup>",
      baseBranch: "<main>"
    });
    expect(page.elements.actionText.innerHTML).not.toContain("javascript:");
    expect(page.elements.actionText.innerHTML).toContain("&lt;setup&gt;");
    expect(page.elements.actionText.innerHTML).toContain("&lt;main&gt;");

    page.controller.showActionRequired("aws", "prod", "");
    expect(page.elements.actionText.innerHTML).toContain("the setup branch");
    expect(page.elements.action.style.display).toBe("flex");

    page.controller.showActionRequired("azure", "dev", "", {
      userMessage: "Missing <subscription> ID."
    });
    expect(page.elements.actionText.innerHTML).toContain(
      "Missing &lt;subscription&gt; ID."
    );
    expect(page.elements.actionText.innerHTML).not.toContain(
      "could not open a pull request"
    );
  });

  it("dismisses and clears every terminal banner", () => {
    const page = renderPage();
    for (const banner of [
      page.elements.success,
      page.elements.error,
      page.elements.warning,
      page.elements.action
    ]) {
      banner.style.display = "flex";
    }
    page.elements.successClose.dispatch("click");
    page.elements.errorClose.dispatch("click");
    page.elements.warningClose.dispatch("click");
    page.elements.actionClose.dispatch("click");
    for (const banner of [
      page.elements.success,
      page.elements.error,
      page.elements.warning,
      page.elements.action
    ]) {
      expect(banner.style.display).toBe("none");
      banner.style.display = "flex";
    }
    page.controller.hideTerminalBanners();
    for (const banner of [
      page.elements.success,
      page.elements.error,
      page.elements.warning,
      page.elements.action
    ]) {
      expect(banner.style.display).toBe("none");
    }
  });
});

describe("environment pane teardown", () => {
  it("cleans listeners, timers, requests, and ignores late work", async () => {
    const page = renderPage();
    const rows = addRowButtons(page.browser);
    const list = createDeferred<HttpResponse>();
    page.browser.net.handle(
      `${ENVIRONMENT_LIST_PATH}?repo=octo%2Fapp`,
      () => list.promise
    );
    page.controller.loadEnvironmentTable();
    await flushPromises();

    page.controller.teardown();
    page.controller.teardown();
    expect(page.environmentTab.listenerCount()).toBe(0);
    expect(page.browser.clock.pending).toBe(0);
    expect(page.browser.bindings.has("environment-environments")).toBe(false);

    list.resolve(
      jsonResponse({ environments: [{ name: "late", status: "pending" }] })
    );
    await flushPromises();
    expect(page.elements.tableBody.innerHTML).not.toContain("late");
    expect(rows.deploy.listenerCount()).toBe(0);
  });
});
