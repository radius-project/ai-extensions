import { describe, expect, it } from "vitest";
import {
  CREDENTIALS_ENTRY_KEY,
  CREDENTIAL_PROFILES_PATH,
  CREDENTIAL_SAVE_PATH,
  GITHUB_IDENTITY_PATH,
  VERIFY_AZURE_PATH
} from "./credentials.js";
import { DISCOVER_ENDPOINT, DISCOVERY_PANEL_ENTRY_KEY } from "./discovery.js";
import {
  ENVIRONMENTS_ENTRY_KEY,
  ENVIRONMENT_DELETE_PATH,
  ENVIRONMENT_LIST_PATH
} from "./environments.js";
import {
  ENVIRONMENT_OPERATIONS_ENTRY_KEY,
  OPERATIONS_PATH,
  PROGRESS_IDS
} from "./operations.js";
import {
  GITHUB_ACCOUNT_ENDPOINT,
  PROFILES_PANEL_ENTRY_KEY
} from "./profiles.js";
import {
  CREATE_ENVIRONMENT_OPERATION_PATH,
  ENVIRONMENT_PAGE_ENTRY_KEY,
  ENVIRONMENT_PAGE_STATE_ID,
  initializeEnvironmentPage
} from "./page.js";
import {
  createFakeBrowser,
  createFakeElement,
  createFakeInput,
  createFakeSelect,
  fakeText,
  flushPromises,
  jsonResponse,
  textResponse
} from "../../../test/support/browser/fakes.js";
import type {
  FakeBrowser,
  FakeElement
} from "../../../test/support/browser/fakes.js";
import type { BrowserTeardown } from "../lifecycle.js";
import type {
  DomInputElement,
  HttpResponse,
  HttpRequestInit
} from "../ports.js";

interface PageFixture {
  readonly browser: FakeBrowser;
  readonly elements: Record<string, FakeElement>;
  readonly repo: string;
  readonly branch: string;
}

const REQUIRED_INPUTS = [
  "env-name-input",
  "env-profile-select",
  "cred-name-input",
  "az-tenant-id",
  "az-sub-id",
  "aws-account-id",
  "aws-region",
  "aws-role-arn",
  "save-cred-btn",
  "btn-verify-azure",
  "btn-verify-aws",
  "cred-ghcr-retry",
  "env-smr-input",
  "env-smr-retry",
  "env-smr-cancel",
  "env-appselect-confirm",
  "env-appselect-cancel",
  "env-gh-recheck",
  "azure-refresh-btn",
  "aws-refresh-btn",
  "deploy-btn",
  "env-step1-next",
  "env-step2-back",
  "target-repo",
  "deploy-branch-select",
  "az-client-id",
  "az-app-name-input",
  "az-selected-app-id"
] as const;

const REQUIRED_SELECTS = [
  "cred-provider-select",
  "azure-cluster-select",
  "azure-rg-select",
  "azure-namespace-select",
  "aws-cluster-select",
  "aws-namespace-select",
  "aws-vpc-select",
  "aws-subnets-select"
] as const;

const REQUIRED_ELEMENTS = [
  "pane-environments",
  "pane-credentials",
  "env-landing",
  "env-form",
  "env-table-body",
  "env-error-banner",
  "env-error-banner-text",
  "env-success-banner",
  "env-success-banner-text",
  "env-warning-banner",
  "env-warning-banner-text",
  "cred-landing",
  "cred-form",
  "cred-panel-azure",
  "cred-panel-aws",
  "cred-table-body",
  "new-cred-btn",
  "cancel-cred-btn",
  "cred-success-banner",
  "cred-success-banner-text",
  "cred-success-banner-close",
  "cred-verify-status",
  "cred-verify-hint",
  "cred-ghcr-status",
  "cred-ghcr-command-row",
  "cred-verify-action",
  "env-verify-modal",
  "env-verify-title",
  "env-profile-button",
  "env-profile-menu",
  "env-profile-value",
  "env-profile-options",
  PROGRESS_IDS.panel,
  PROGRESS_IDS.commands,
  PROGRESS_IDS.commandButtons,
  PROGRESS_IDS.commandNote,
  PROGRESS_IDS.actions,
  PROGRESS_IDS.bottomButtons,
  PROGRESS_IDS.dismiss,
  "deploy-status",
  "new-env-btn",
  "cancel-env-btn",
  "env-create-profile-link",
  // The credential form is one relocatable fragment: it is physically moved
  // between the wizard host and the Credentials sub-tab, so both the card it
  // lives in and the two hosts have to exist for the pane to initialize.
  "cred-form-card",
  "cred-form-title",
  "env-cred-form-host",
  "env-step-credentials-card",
  "env-step-credentials",
  "env-step-details",
  "env-wizard-step-1",
  "env-wizard-step-2",
  "env-step1-hint",
  "env-profile-summary",
  "env-profile-detail",
  "env-profile-status",
  "env-confirm-modal",
  "env-confirm-title",
  "env-confirm-message",
  "env-confirm-usage",
  "env-confirm-usage-label",
  "env-confirm-usage-list",
  "env-confirm-ok",
  "env-confirm-cancel"
] as const;

function fixture(
  state: {
    repo?: string;
    branch?: string;
    activeSubtab?: string;
    search?: string;
    omit?: readonly string[];
  } = {}
): PageFixture {
  const browser = createFakeBrowser();
  const repo = state.repo ?? "octo/app";
  const branch = state.branch ?? "feature/x";
  const elements: Record<string, FakeElement> = {};
  const add = (element: FakeElement): void => {
    elements[element.id] = element;
    browser.document.add(element);
  };
  const stateElement = createFakeElement(ENVIRONMENT_PAGE_STATE_ID);
  stateElement.textContent = JSON.stringify({
    repo,
    branch,
    activeSubtab: state.activeSubtab ?? "environments",
    mutationNonce: "browser-nonce"
  });
  add(stateElement);
  const omitted = new Set(state.omit ?? []);
  for (const id of REQUIRED_ELEMENTS) {
    if (!omitted.has(id)) add(createFakeElement(id));
  }
  for (const id of REQUIRED_INPUTS) {
    if (!omitted.has(id)) add(createFakeInput(id));
  }
  for (const id of REQUIRED_SELECTS) add(createFakeSelect(id));
  const setValue = (id: string, value: string): void => {
    const element = browser.context.dom.inputById(id);
    if (!element) throw new Error(`Missing fixture input "${id}".`);
    element.value = value;
  };
  setValue("target-repo", repo);
  setValue("deploy-branch-select", branch);
  setValue("cred-provider-select", "azure");
  elements["env-profile-menu"].style.display = "none";
  const environmentTab = createFakeElement("environment-subtab", "a");
  environmentTab.setAttribute("data-subtab", "environments");
  const credentialTab = createFakeElement("credentials-subtab", "a");
  credentialTab.setAttribute("data-subtab", "credentials");
  elements[environmentTab.id] = environmentTab;
  elements[credentialTab.id] = credentialTab;
  browser.document.addSelectorAll("#env-subtabs .rad-subtab", [
    environmentTab,
    credentialTab
  ]);
  browser.nav.search = state.search ?? "?page=environment";
  browser.nav.href = `http://localhost/${browser.nav.search}`;
  browser.net.handle(
    `${ENVIRONMENT_LIST_PATH}?repo=${encodeURIComponent(repo)}`,
    () => jsonResponse({ environments: [] })
  );
  browser.net.handle(
    `${OPERATIONS_PATH}?repo=${encodeURIComponent(repo)}`,
    () => jsonResponse({ operation: null })
  );
  browser.net.handle(
    `${CREDENTIAL_PROFILES_PATH}?repo=${encodeURIComponent(repo)}`,
    () => jsonResponse({ profiles: [] })
  );
  browser.net.handle(
    `${GITHUB_IDENTITY_PATH}?repo=${encodeURIComponent(repo)}`,
    () =>
      jsonResponse({
        actingLogin: "octocat",
        displayLogin: "octocat",
        actingHasPackages: true,
        accounts: [
          {
            login: "octocat",
            hasWorkflow: true,
            hasPackages: true,
            switchable: true
          }
        ]
      })
  );
  browser.net.handle(GITHUB_ACCOUNT_ENDPOINT, () =>
    jsonResponse({
      readiness: {
        ready: true,
        login: "octocat",
        credentialSource: "keyring",
        summary: "Ready to configure deployments",
        repair: null,
        checks: {
          repository: { state: "ready", detail: "ready" },
          workflow: { state: "ready", detail: "ready" },
          environment: { state: "ready", detail: "ready" },
          packages: { state: "ready", detail: "ready" },
          identity: { state: "ready", detail: "ready" }
        }
      },
      selectionHandle: "selection-handle"
    })
  );
  return { browser, elements, repo, branch };
}

function pageInput(page: PageFixture, id: string): DomInputElement {
  const element = page.browser.context.dom.inputById(id);
  if (!element) throw new Error(`Missing fixture input "${id}".`);
  return element;
}

function profile(provider: "azure" | "aws") {
  return provider === "azure" ?
      {
        name: "azure-prod",
        provider,
        tenantId: "tenant-1",
        subscriptionId: "sub-1",
        subscriptionName: "Production",
        user: "octocat"
      }
    : {
        name: "aws-prod",
        provider,
        accountId: "123456789012",
        region: "us-east-1",
        roleArn: "arn:aws:iam::123456789012:role/radius"
      };
}

async function openWithProfile(
  page: PageFixture,
  provider: "azure" | "aws"
): Promise<BrowserTeardown> {
  page.browser.nav.search = `?page=environment&new=1&profile=${provider}-prod`;
  page.browser.net.handle(
    `${CREDENTIAL_PROFILES_PATH}?repo=${encodeURIComponent(page.repo)}`,
    () => jsonResponse({ profiles: [profile(provider)] })
  );
  page.browser.net.handle(DISCOVER_ENDPOINT, () =>
    jsonResponse(
      provider === "azure" ?
        {
          clusters: [
            { id: "aks-1", name: "aks-1", resourceGroup: "cluster-rg" }
          ],
          resourceGroups: [{ id: "app-rg", name: "app-rg" }],
          namespaces: ["default"]
        }
      : {
          clusters: [{ id: "eks-1", name: "eks-1" }],
          namespaces: ["default"],
          vpcs: [{ id: "vpc-1", name: "vpc-1" }],
          subnets: [{ id: "subnet-1", name: "subnet-1" }]
        }
    )
  );
  const teardown = initializeEnvironmentPage(page.browser.context);
  await flushPromises();
  await flushPromises();
  return teardown;
}

describe("initializeEnvironmentPage", () => {
  it("does nothing outside the environment page", () => {
    const browser = createFakeBrowser();
    const teardown = initializeEnvironmentPage(browser.context);
    expect(() => teardown()).not.toThrow();
    expect(browser.bindings.has(ENVIRONMENT_PAGE_ENTRY_KEY)).toBe(false);
  });

  it.each([
    DISCOVERY_PANEL_ENTRY_KEY,
    PROFILES_PANEL_ENTRY_KEY,
    ENVIRONMENTS_ENTRY_KEY,
    CREDENTIALS_ENTRY_KEY,
    ENVIRONMENT_OPERATIONS_ENTRY_KEY
  ])("rolls back partial construction when %s is already owned", (childKey) => {
    const page = fixture();
    page.browser.bindings.claim(childKey);

    const teardown = initializeEnvironmentPage(page.browser.context);

    expect(teardown).toBeTypeOf("function");
    expect(page.browser.bindings.has(ENVIRONMENT_PAGE_ENTRY_KEY)).toBe(false);
    expect(page.browser.bindings.has(childKey)).toBe(true);
    page.browser.bindings.release(childKey);
  });

  it("initializes once, loads the environment landing, and tears down cleanly", async () => {
    const page = fixture();
    const teardown = initializeEnvironmentPage(page.browser.context);
    const duplicate = initializeEnvironmentPage(page.browser.context);
    await flushPromises();

    expect(
      page.browser.net.calls.some((call) =>
        call.url.startsWith(ENVIRONMENT_LIST_PATH)
      )
    ).toBe(true);
    expect(page.browser.bindings.has(ENVIRONMENT_PAGE_ENTRY_KEY)).toBe(true);
    duplicate();
    teardown();
    expect(page.browser.bindings.has(ENVIRONMENT_PAGE_ENTRY_KEY)).toBe(false);
    expect(page.browser.clock.pending).toBe(0);
  });

  it("survives a malformed escape in the query string and stays rebindable", async () => {
    // A hand-edited or truncated URL can carry `%` with nothing after it.
    // decodeURIComponent throws URIError on that, and this read happens after
    // the entry key is claimed and before the teardown is returned, so an
    // unguarded decode would escape the entry IIFE with the claim held and
    // leave the page permanently dead.
    const page = fixture({ search: "?page=environment&new=1&name=%" });

    const teardown = initializeEnvironmentPage(page.browser.context);
    await flushPromises();

    expect(teardown).toBeTypeOf("function");
    expect(page.browser.bindings.has(ENVIRONMENT_PAGE_ENTRY_KEY)).toBe(true);
    teardown();
    expect(page.browser.bindings.has(ENVIRONMENT_PAGE_ENTRY_KEY)).toBe(false);

    const rebound = initializeEnvironmentPage(page.browser.context);
    expect(page.browser.bindings.has(ENVIRONMENT_PAGE_ENTRY_KEY)).toBe(true);
    rebound();
  });

  it("loads credential profiles instead of the environment table on the credentials subtab", async () => {
    const page = fixture({ activeSubtab: "credentials" });
    initializeEnvironmentPage(page.browser.context);
    await flushPromises();

    expect(
      page.browser.net.calls.some((call) =>
        call.url.startsWith(CREDENTIAL_PROFILES_PATH)
      )
    ).toBe(true);
    expect(
      page.browser.net.calls.some((call) =>
        call.url.startsWith(ENVIRONMENT_LIST_PATH)
      )
    ).toBe(false);
  });

  it("routes a credential row's Create Env action back through the environment controller", async () => {
    const page = fixture({ activeSubtab: "credentials" });
    const createEnvironment = createFakeElement("credential-create-env");
    createEnvironment.setAttribute("data-name", "azure-prod");
    page.browser.document.addSelectorAll(".js-cred-createenv", [
      createEnvironment
    ]);
    page.browser.net.handle(
      `${CREDENTIAL_PROFILES_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () => jsonResponse({ profiles: [profile("azure")] })
    );
    initializeEnvironmentPage(page.browser.context);
    await flushPromises();

    createEnvironment.dispatch("click");
    await flushPromises();

    expect(page.elements["pane-environments"].style.display).toBe("");
    expect(page.elements["pane-credentials"].style.display).toBe("none");
    expect(page.elements["env-form"].style.display).toBe("");
  });

  it("opens and cancels the environment form and routes create-profile to credentials", async () => {
    const page = fixture();
    initializeEnvironmentPage(page.browser.context);
    await flushPromises();

    page.elements["new-env-btn"].dispatch("click");
    expect(page.elements["env-form"].style.display).toBe("");
    expect(page.elements["env-landing"].style.display).toBe("none");
    page.elements["cancel-env-btn"].dispatch("click");
    expect(page.elements["env-form"].style.display).toBe("none");
    page.elements["env-create-profile-link"].dispatch("click");
    expect(page.elements["pane-credentials"].style.display).toBe("");
    expect(page.elements["cred-form"].style.display).toBe("");
  });

  it("summarizes the chosen credential profile and unlocks the wizard", async () => {
    const page = fixture();
    page.elements["env-profile-status"].innerHTML = "<b>Account 1234</b>";

    await openWithProfile(page, "aws");

    expect(page.elements["env-profile-summary"].textContent).toBe(
      "aws-prod (AWS)"
    );
    expect(page.elements["env-profile-detail"].innerHTML).toBe(
      "<b>Account 1234</b>"
    );
    expect(page.elements["env-profile-detail"].style.display).toBe("");
    expect(pageInput(page, "env-step1-next").disabled).toBe(false);
    expect(page.elements["env-step1-hint"].style.display).toBe("none");
  });

  it("keeps the wizard locked while no credential profile is chosen", async () => {
    const page = fixture();
    initializeEnvironmentPage(page.browser.context);
    await flushPromises();

    page.elements["new-env-btn"].dispatch("click");
    await flushPromises();

    expect(page.elements["env-profile-summary"].textContent).toBe(
      "No credential profile selected"
    );
    expect(page.elements["env-profile-detail"].innerHTML).toBe("");
    expect(page.elements["env-profile-detail"].style.display).toBe("none");
    expect(pageInput(page, "env-step1-next").disabled).toBe(true);
    expect(page.elements["env-step1-hint"].style.display).toBe("");
  });

  it("returns to the environment step with the profile just created in the wizard", async () => {
    const page = fixture();
    let profiles: readonly ReturnType<typeof profile>[] = [];
    page.browser.net.handle(
      `${CREDENTIAL_PROFILES_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () => jsonResponse({ profiles })
    );
    page.browser.net.handle(`${GITHUB_IDENTITY_PATH}?fresh=1`, () =>
      jsonResponse({ actingLogin: "octocat", actingHasPackages: true })
    );
    page.browser.net.handle(VERIFY_AZURE_PATH, () =>
      jsonResponse({
        user: "octocat",
        tenantId: "tenant-1",
        subscriptionId: "sub-1",
        subscriptionName: "Production"
      })
    );
    page.browser.net.handle(CREDENTIAL_SAVE_PATH, () => {
      profiles = [profile("azure")];
      return jsonResponse({});
    });
    initializeEnvironmentPage(page.browser.context);
    await flushPromises();

    page.elements["new-env-btn"].dispatch("click");
    page.elements["env-create-profile-link"].dispatch("click");
    await flushPromises();
    pageInput(page, "cred-name-input").value = "azure-prod";
    pageInput(page, "az-tenant-id").value = "tenant-1";
    pageInput(page, "az-sub-id").value = "sub-1";
    page.elements["btn-verify-azure"].dispatch("click");
    await flushPromises();
    page.elements["save-cred-btn"].dispatch("click");
    await flushPromises();

    // Saving inside the wizard hands the new profile straight back to the
    // environment step instead of dropping the user on the credentials pane.
    expect(page.elements["env-step-details"].style.display).toBe("");
    expect(page.elements["env-step-credentials"].style.display).toBe("none");
    expect(page.elements["env-name-input"].focusCount).toBe(1);
  });

  it("leaves the profile detail empty when the status markup is absent", async () => {
    const page = fixture({ omit: ["env-profile-status"] });

    const teardown = await openWithProfile(page, "azure");

    expect(page.elements["env-profile-detail"].innerHTML).toBe("");
    expect(page.elements["env-profile-detail"].style.display).toBe("");
    teardown();
  });

  it("still runs when the optional wizard summary and confirm dialog are absent", async () => {
    const page = fixture({
      omit: [
        "env-profile-summary",
        "env-profile-detail",
        "env-profile-status",
        "env-step1-hint",
        "env-step1-next",
        "env-confirm-modal",
        "env-confirm-title",
        "env-confirm-message",
        "env-confirm-usage",
        "env-confirm-usage-label",
        "env-confirm-usage-list",
        "env-confirm-ok",
        "env-confirm-cancel"
      ]
    });

    const teardown = await openWithProfile(page, "azure");

    // The wizard summary and the shared dialog are presentation extras, so the
    // page must still select a profile and stay usable without them.
    expect(page.browser.net.calls.length).toBeGreaterThan(0);
    expect(page.elements["env-step-details"]).toBeDefined();
    expect(() => teardown()).not.toThrow();
  });

  it("loads the credential table when the credentials subtab is chosen", async () => {
    const page = fixture();
    initializeEnvironmentPage(page.browser.context);
    await flushPromises();
    const before = page.browser.net.calls.length;

    page.elements["credentials-subtab"].dispatch("click", {
      preventDefault() {}
    });
    await flushPromises();

    expect(
      page.browser.net.calls
        .slice(before)
        .some((call) => call.url.startsWith(CREDENTIAL_PROFILES_PATH))
    ).toBe(true);
  });

  it("reads deep-link values without a leading question mark", async () => {
    const page = fixture({
      search: "page=environment&new=1&name=prod&profile=azure-prod"
    });
    page.browser.net.handle(
      `${CREDENTIAL_PROFILES_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () => jsonResponse({ profiles: [profile("azure")] })
    );
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      jsonResponse({
        clusters: [],
        resourceGroups: [],
        namespaces: []
      })
    );

    initializeEnvironmentPage(page.browser.context);
    await flushPromises();

    expect(page.elements["env-form"].style.display).toBe("");
    expect(pageInput(page, "env-name-input").value).toBe("prod");
  });

  it("treats a bare deep-link key as an empty value", () => {
    const page = fixture({ search: "?page=environment&new" });
    page.elements["env-form"].style.display = "none";

    initializeEnvironmentPage(page.browser.context);

    expect(page.elements["env-form"].style.display).not.toBe("");
  });

  it("requires a selected credential profile before creating", () => {
    const page = fixture({ search: "?page=environment&new=1" });
    initializeEnvironmentPage(page.browser.context);
    pageInput(page, "env-name-input").value = "dev";
    page.elements["deploy-btn"].dispatch("click");

    expect(page.elements["deploy-status"].textContent).toBe(
      "Please select a credential profile."
    );
  });

  it("requires an environment name before creating", async () => {
    const page = fixture();
    await openWithProfile(page, "azure");
    pageInput(page, "env-name-input").value = "";
    page.elements["deploy-btn"].dispatch("click");

    expect(page.elements["deploy-status"].textContent).toBe(
      "Please enter an environment name."
    );
  });

  it("blocks creation when selected-account readiness has not passed", async () => {
    const page = fixture();
    page.browser.net.handle(GITHUB_ACCOUNT_ENDPOINT, () =>
      jsonResponse({
        readiness: {
          ready: false,
          login: "octocat",
          credentialSource: "keyring",
          summary: "Additional GitHub access is required",
          repair: "Refresh access.",
          checks: {}
        }
      })
    );
    await openWithProfile(page, "azure");
    pageInput(page, "env-name-input").value = "dev";

    page.elements["deploy-btn"].dispatch("click");

    expect(page.elements["deploy-status"].textContent).toBe(
      "Re-check the selected GitHub account before creating the environment."
    );
  });

  it("invalidates account readiness when the environment name changes", async () => {
    const page = fixture();
    await openWithProfile(page, "azure");
    const environment = pageInput(page, "env-name-input");
    expect(pageInput(page, "deploy-btn").disabled).toBe(false);

    environment.value = "prod";
    page.elements["env-name-input"].dispatch("input");

    expect(pageInput(page, "deploy-btn").disabled).toBe(true);
  });

  it("fails closed when repository identity changes", async () => {
    const page = fixture();
    await openWithProfile(page, "azure");
    pageInput(page, "env-name-input").value = "dev";
    pageInput(page, "target-repo").value = "attacker/other";
    page.elements["deploy-btn"].dispatch("click");

    expect(page.elements["deploy-status"].textContent).toContain(
      "repository context changed"
    );
    expect(
      page.browser.net.calls.filter(
        (call) => call.url === CREATE_ENVIRONMENT_OPERATION_PATH
      )
    ).toHaveLength(0);
  });

  it.each([
    [
      "resource group",
      "azure-rg-select",
      "",
      "Please specify a resource group."
    ],
    ["cluster", "azure-cluster-select", "", "Please specify an AKS cluster."]
  ])("validates the Azure %s", async (_label, id, value, expected) => {
    const page = fixture();
    await openWithProfile(page, "azure");
    pageInput(page, "env-name-input").value = "dev";
    pageInput(page, "azure-rg-select").value = "app-rg";
    pageInput(page, "azure-cluster-select").value = "aks-1";
    pageInput(page, id).value = value;
    page.elements["deploy-btn"].dispatch("click");
    expect(page.elements["deploy-status"].textContent).toBe(expected);
  });

  it("validates the AWS cluster", async () => {
    const page = fixture();
    await openWithProfile(page, "aws");
    pageInput(page, "env-name-input").value = "prod";
    pageInput(page, "aws-cluster-select").value = "";

    page.elements["deploy-btn"].dispatch("click");

    expect(page.elements["deploy-status"].textContent).toBe(
      "Please specify an EKS cluster."
    );
  });

  it.each([
    [
      "Azure",
      {
        name: "azure-broken",
        provider: "azure",
        tenantId: "",
        subscriptionId: ""
      },
      "The selected profile needs both a tenant ID and subscription ID."
    ],
    [
      "AWS",
      {
        name: "aws-broken",
        provider: "aws",
        accountId: "",
        region: ""
      },
      "The selected profile needs both an account ID and region."
    ]
  ])(
    "fails closed for incomplete %s profile identity",
    async (_name, brokenProfile, expected) => {
      const page = fixture();
      page.browser.nav.search = `?page=environment&new=1&profile=${brokenProfile.name}`;
      page.browser.net.handle(
        `${CREDENTIAL_PROFILES_PATH}?repo=${encodeURIComponent(page.repo)}`,
        () => jsonResponse({ profiles: [brokenProfile] })
      );
      page.browser.net.handle(DISCOVER_ENDPOINT, () =>
        jsonResponse({
          clusters: [
            {
              id: brokenProfile.provider === "aws" ? "eks-1" : "aks-1",
              name: "cluster",
              resourceGroup: "cluster-rg"
            }
          ],
          resourceGroups: [{ id: "app-rg", name: "app-rg" }],
          namespaces: ["default"]
        })
      );
      initializeEnvironmentPage(page.browser.context);
      await flushPromises();
      await flushPromises();
      pageInput(page, "env-name-input").value = "dev";
      pageInput(
        page,
        brokenProfile.provider === "aws" ?
          "aws-cluster-select"
        : "azure-cluster-select"
      ).value = brokenProfile.provider === "aws" ? "eks-1" : "aks-1";
      pageInput(page, "azure-rg-select").value = "app-rg";

      page.elements["deploy-btn"].dispatch("click");

      expect(page.elements["deploy-status"].textContent).toContain(expected);
      expect(
        page.browser.net.calls.filter(
          (call) => call.url === CREATE_ENVIRONMENT_OPERATION_PATH
        )
      ).toHaveLength(0);
    }
  );

  it("dispatches an Azure environment operation with preserved branch identity", async () => {
    const page = fixture();
    let createInit: HttpRequestInit | undefined;
    await openWithProfile(page, "azure");
    pageInput(page, "env-name-input").value = "dev";
    pageInput(page, "azure-rg-select").value = "app-rg";
    pageInput(page, "azure-cluster-select").value = "aks-1";
    pageInput(page, "azure-namespace-select").value = "default";
    pageInput(page, "az-app-name-input").value = "radius-deploy-octo-app";
    pageInput(page, "deploy-branch-select").value = "";
    page.browser.net.handle(CREATE_ENVIRONMENT_OPERATION_PATH, (init) => {
      createInit = init;
      return jsonResponse({ operationId: "op-1" }, true, 202);
    });

    page.elements["deploy-btn"].dispatch("click");
    await flushPromises();

    expect(JSON.parse(String(createInit?.body))).toMatchObject({
      repo: "octo/app",
      environment: "dev",
      provider: "azure",
      cluster: "aks-1",
      namespace: "default",
      profileName: "azure-prod",
      branch: "feature/x",
      resourceGroup: "app-rg",
      clusterResourceGroup: "cluster-rg",
      appName: "radius-deploy-octo-app",
      resumeTarget: {
        page: "planned",
        repo: "octo/app",
        branch: "feature/x"
      }
    });
    expect(page.elements[PROGRESS_IDS.panel].style.display).toBe("");
  });

  it("labels the submit as a save and defaults the namespace when editing", async () => {
    const page = fixture();
    let createInit: HttpRequestInit | undefined;
    await openWithProfile(page, "azure");
    // Editing locks the name, which is what marks this submission as a save of
    // an existing environment rather than the creation of a new one.
    pageInput(page, "env-name-input").value = "dev";
    pageInput(page, "env-name-input").disabled = true;
    pageInput(page, "azure-rg-select").value = "app-rg";
    pageInput(page, "azure-cluster-select").value = "aks-1";
    pageInput(page, "azure-namespace-select").value = "";
    page.browser.net.handle(CREATE_ENVIRONMENT_OPERATION_PATH, (init) => {
      createInit = init;
      return jsonResponse({ operationId: "op-1" }, true, 202);
    });

    page.elements["deploy-btn"].dispatch("click");

    expect(page.elements["deploy-btn"].textContent).toBe("Saving environment…");
    await flushPromises();
    expect(JSON.parse(String(createInit?.body))).toMatchObject({
      environment: "dev",
      namespace: "default"
    });
  });

  it("clears the create latch when the tracked operation becomes terminal", async () => {
    const page = fixture();
    let createRequests = 0;
    await openWithProfile(page, "azure");
    pageInput(page, "env-name-input").value = "dev";
    pageInput(page, "azure-rg-select").value = "app-rg";
    pageInput(page, "azure-cluster-select").value = "aks-1";
    page.browser.net.handle(CREATE_ENVIRONMENT_OPERATION_PATH, () => {
      createRequests += 1;
      return jsonResponse({ operationId: `op-${createRequests}` }, true, 202);
    });
    let operationPolls = 0;
    page.browser.net.handle(
      `${OPERATIONS_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () => {
        operationPolls += 1;
        return jsonResponse({
          operation: {
            operationId: `op-${createRequests}`,
            environment: "dev",
            provider: "azure",
            state: operationPolls === 1 ? "running" : "succeeded",
            terminalState: operationPolls === 1 ? null : "succeeded",
            summary: operationPolls === 1 ? "creating" : "ready"
          }
        });
      }
    );

    page.elements["deploy-btn"].dispatch("click");
    await flushPromises();
    page.browser.clock.tick(1500);
    await flushPromises();
    expect(page.elements["deploy-btn"].textContent).toBe("Create Environment");

    page.elements["deploy-btn"].dispatch("click");
    await flushPromises();

    expect(createRequests).toBe(2);
  });

  it("dispatches AWS-specific infrastructure without Azure fields", async () => {
    const page = fixture();
    let createInit: HttpRequestInit | undefined;
    await openWithProfile(page, "aws");
    page.browser.net.supportsAbort = false;
    pageInput(page, "env-name-input").value = "prod";
    pageInput(page, "aws-cluster-select").value = "eks-1";
    pageInput(page, "aws-namespace-select").value = "default";
    pageInput(page, "aws-vpc-select").value = "vpc-1";
    pageInput(page, "aws-subnets-select").value = "subnet-1";
    page.browser.net.handle(CREATE_ENVIRONMENT_OPERATION_PATH, (init) => {
      createInit = init;
      return jsonResponse({ operationId: "op-aws" }, true, 202);
    });

    page.elements["deploy-btn"].dispatch("click");
    await flushPromises();

    const body = JSON.parse(String(createInit?.body));
    expect(body).toMatchObject({
      provider: "aws",
      cluster: "eks-1",
      accountId: "123456789012",
      region: "us-east-1",
      roleArn: "arn:aws:iam::123456789012:role/radius",
      vpcId: "vpc-1",
      subnetIds: "subnet-1"
    });
    expect(body).not.toHaveProperty("resourceGroup");
    expect(createInit?.signal).toBeUndefined();
  });

  it("dispatches an AWS profile with no optional role ARN", async () => {
    const page = fixture();
    let createInit: HttpRequestInit | undefined;
    page.browser.nav.search = "?page=environment&new=1&profile=aws-basic";
    page.browser.net.handle(
      `${CREDENTIAL_PROFILES_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () =>
        jsonResponse({
          profiles: [
            {
              name: "aws-basic",
              provider: "aws",
              accountId: "123456789012",
              region: "us-east-1"
            }
          ]
        })
    );
    page.browser.net.handle(DISCOVER_ENDPOINT, () =>
      jsonResponse({
        clusters: [{ id: "eks-1", name: "eks-1" }],
        namespaces: ["default"],
        vpcs: [],
        subnets: []
      })
    );
    initializeEnvironmentPage(page.browser.context);
    await flushPromises();
    await flushPromises();
    pageInput(page, "env-name-input").value = "prod";
    pageInput(page, "aws-cluster-select").value = "eks-1";
    page.browser.net.handle(CREATE_ENVIRONMENT_OPERATION_PATH, (init) => {
      createInit = init;
      return jsonResponse({ operationId: "op-aws" }, true, 202);
    });

    page.elements["deploy-btn"].dispatch("click");
    await flushPromises();

    expect(JSON.parse(String(createInit?.body))).toMatchObject({
      provider: "aws",
      roleArn: ""
    });
  });

  it("dispatches only one create while a request is pending", async () => {
    const page = fixture();
    await openWithProfile(page, "azure");
    pageInput(page, "env-name-input").value = "dev";
    pageInput(page, "azure-rg-select").value = "app-rg";
    pageInput(page, "azure-cluster-select").value = "aks-1";
    let requests = 0;
    page.browser.net.handle(CREATE_ENVIRONMENT_OPERATION_PATH, () => {
      requests += 1;
      return new Promise<HttpResponse>(() => {});
    });

    page.elements["deploy-btn"].dispatch("click");
    page.elements["deploy-btn"].dispatch("click");
    await flushPromises();

    expect(requests).toBe(1);
  });

  it("releases the create latch after a control command reaches terminal", async () => {
    const page = fixture();
    for (const id of [
      PROGRESS_IDS.commands,
      PROGRESS_IDS.commandButtons,
      PROGRESS_IDS.commandNote,
      PROGRESS_IDS.commandGuidance,
      PROGRESS_IDS.commandStatus,
      PROGRESS_IDS.commandError,
      PROGRESS_IDS.title,
      PROGRESS_IDS.activity
    ]) {
      const element = createFakeElement(id);
      page.elements[id] = element;
      page.browser.document.add(element);
    }
    let createRequests = 0;
    let created = false;
    page.browser.net.handle(
      `${OPERATIONS_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () =>
        jsonResponse({
          operation:
            created ?
              {
                operationId: "op-1",
                environment: "dev",
                provider: "azure",
                state: "running",
                terminalState: null,
                summary: "Creating dev…",
                startedAt: "2026-08-20T00:00:00.000Z",
                actions: [
                  {
                    id: "stop",
                    kind: "stop",
                    label: "Stop Setup",
                    path: "/api/operations/op-1/stop",
                    description: "Stop at the next safe boundary."
                  }
                ]
              }
            : null
        })
    );
    await openWithProfile(page, "azure");
    pageInput(page, "env-name-input").value = "dev";
    pageInput(page, "azure-rg-select").value = "app-rg";
    pageInput(page, "azure-cluster-select").value = "aks-1";
    page.browser.net.handle(CREATE_ENVIRONMENT_OPERATION_PATH, () => {
      createRequests += 1;
      created = true;
      return jsonResponse({ operationId: `op-${createRequests}` }, true, 202);
    });
    page.browser.net.handle("/api/operations/op-1/stop", () =>
      jsonResponse({
        operation: {
          operationId: "op-1",
          environment: "dev",
          provider: "azure",
          state: "cancelled",
          terminalState: "cancelled",
          summary: "Setup stopped",
          startedAt: "2026-08-20T00:00:00.000Z",
          endedAt: "2026-08-20T00:00:01.000Z"
        }
      })
    );

    page.elements["deploy-btn"].dispatch("click");
    await flushPromises();
    await flushPromises();
    const stop = page.elements[PROGRESS_IDS.commandButtons].children[0];
    expect(stop?.id).toBe("env-progress-command-stop");

    stop?.dispatch("click");
    await flushPromises();
    await flushPromises();

    expect(pageInput(page, "deploy-btn").disabled).toBe(false);
    page.elements["deploy-btn"].dispatch("click");
    await flushPromises();
    expect(createRequests).toBe(2);
  });

  it.each([
    [
      "HTTP failure",
      () => jsonResponse({ error: "setup denied" }, false, 403),
      "setup denied"
    ],
    [
      "HTTP failure without a message",
      () => jsonResponse({}, false, 500),
      "Could not start environment setup."
    ],
    [
      "missing operation identity",
      () => jsonResponse({}, true, 202),
      "Radius did not return an environment operation."
    ],
    [
      "malformed response",
      () => textResponse("not json", false, 500),
      "Radius returned an invalid environment response."
    ],
    [
      "network failure",
      () => Promise.reject({ secret: "do-not-render" }),
      "Could not start environment setup. Please try again."
    ]
  ])(
    "reports %s explicitly and restores the action",
    async (_label, result, expected) => {
      const page = fixture();
      await openWithProfile(page, "azure");
      pageInput(page, "env-name-input").value = "dev";
      pageInput(page, "azure-rg-select").value = "app-rg";
      pageInput(page, "azure-cluster-select").value = "aks-1";
      page.browser.net.handle(CREATE_ENVIRONMENT_OPERATION_PATH, result);

      page.elements["deploy-btn"].dispatch("click");
      await flushPromises();

      expect(page.elements["env-error-banner-text"].textContent).toBe(expected);
      expect(pageInput(page, "deploy-btn").disabled).toBe(false);
      expect(page.elements["deploy-btn"].textContent).toBe(
        "Create Environment"
      );
      expect(page.elements[PROGRESS_IDS.panel].style.display).toBe("none");
    }
  );

  it("renders a recorded failure returned with the rejected create request", async () => {
    const page = fixture();
    await openWithProfile(page, "azure");
    pageInput(page, "env-name-input").value = "dev";
    pageInput(page, "azure-rg-select").value = "app-rg";
    pageInput(page, "azure-cluster-select").value = "aks-1";
    page.browser.net.handle(CREATE_ENVIRONMENT_OPERATION_PATH, () =>
      jsonResponse(
        {
          error: "setup failed",
          operationId: "op-failed"
        },
        false,
        500
      )
    );
    page.browser.net.handle("/api/operations/op-failed", () =>
      jsonResponse({
        operation: {
          operationId: "op-failed",
          environment: "dev",
          provider: "azure",
          state: "failed",
          terminalState: "failed",
          summary: "setup failed"
        }
      })
    );

    page.elements["deploy-btn"].dispatch("click");
    await flushPromises();
    await flushPromises();

    expect(page.elements["deploy-btn"].textContent).toBe("Create Environment");
    expect(pageInput(page, "deploy-btn").disabled).toBe(false);
    expect(page.elements[PROGRESS_IDS.panel].style.display).not.toBe("none");
  });

  it("focuses the previous cleanup operation and releases the create latch", async () => {
    const page = fixture();
    for (const id of [
      PROGRESS_IDS.commands,
      PROGRESS_IDS.commandButtons,
      PROGRESS_IDS.commandNote,
      PROGRESS_IDS.commandGuidance,
      PROGRESS_IDS.commandStatus,
      PROGRESS_IDS.commandError,
      PROGRESS_IDS.title,
      PROGRESS_IDS.activity
    ]) {
      const element = createFakeElement(id);
      page.elements[id] = element;
      page.browser.document.add(element);
    }
    await openWithProfile(page, "azure");
    pageInput(page, "env-name-input").value = "dev";
    pageInput(page, "azure-rg-select").value = "app-rg";
    pageInput(page, "azure-cluster-select").value = "aks-1";
    let createRequests = 0;
    page.browser.net.handle(CREATE_ENVIRONMENT_OPERATION_PATH, () => {
      createRequests += 1;
      return jsonResponse(
        {
          error:
            "An earlier setup must finish rollback first. Then create a new environment for contoso/store.",
          code: "previous-cleanup-required",
          operationId: "op-cleanup"
        },
        false,
        409
      );
    });
    page.browser.net.handle("/api/operations/op-cleanup", () =>
      jsonResponse({
        operation: {
          operationId: "op-cleanup",
          environment: "old-dev",
          provider: "azure",
          state: "failed_partial",
          terminalState: "failed_partial",
          summary: "Earlier setup needs rollback",
          failure: { message: "Setup stopped before cleanup." },
          cleanup: {
            state: "not_started",
            created: [{ target: "radius-deploy (app-1)" }],
            manualActionRequired: []
          },
          actions: [
            {
              id: "rollback",
              kind: "rollback",
              label: "Roll back resources",
              description:
                "Finish rollback before creating another environment.",
              path: "/api/operations/op-cleanup/rollback",
              pending: false,
              tone: "danger",
              placement: "row",
              requiresConfirmation: false
            }
          ],
          startedAt: "2026-08-22T10:00:00.000Z",
          endedAt: "2026-08-22T10:01:00.000Z"
        }
      })
    );

    page.elements["deploy-btn"].dispatch("click");
    await flushPromises();
    await flushPromises();

    expect(page.elements[PROGRESS_IDS.panel].style.display).not.toBe("none");
    expect(page.elements[PROGRESS_IDS.panel].focusCount).toBe(2);
    expect(page.elements[PROGRESS_IDS.commandButtons].children[0]?.id).toBe(
      "env-progress-command-rollback"
    );
    expect(pageInput(page, "deploy-btn").disabled).toBe(false);
    expect(page.elements["deploy-btn"].textContent).toBe("Create Environment");

    page.elements["deploy-btn"].dispatch("click");
    await flushPromises();
    expect(createRequests).toBe(2);
  });

  it("supersedes a resumed poll before rendering a recorded create failure", async () => {
    const page = fixture();
    let resumedPolls = 0;
    page.browser.net.handle(
      `${OPERATIONS_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () => {
        resumedPolls += 1;
        return jsonResponse({
          operation: {
            operationId: "old-op",
            environment: "old",
            provider: "azure",
            state: "running",
            terminalState: null,
            summary: "old operation"
          }
        });
      }
    );
    await openWithProfile(page, "azure");
    pageInput(page, "env-name-input").value = "dev";
    pageInput(page, "azure-rg-select").value = "app-rg";
    pageInput(page, "azure-cluster-select").value = "aks-1";
    page.browser.net.handle(CREATE_ENVIRONMENT_OPERATION_PATH, () =>
      jsonResponse(
        { error: "new setup failed", operationId: "new-op" },
        false,
        500
      )
    );
    page.browser.net.handle("/api/operations/new-op", () =>
      jsonResponse({
        operation: {
          operationId: "new-op",
          environment: "dev",
          provider: "azure",
          state: "failed",
          terminalState: "failed",
          summary: "new setup failed"
        }
      })
    );

    page.elements["deploy-btn"].dispatch("click");
    await flushPromises();
    await flushPromises();
    const pollsAfterFailure = resumedPolls;
    expect(page.elements[PROGRESS_IDS.panel].className).toContain(
      "env-progress--failed"
    );

    page.browser.clock.tick(5000);
    await flushPromises();

    expect(resumedPolls).toBe(pollsAfterFailure);
    expect(page.elements[PROGRESS_IDS.panel].className).toContain(
      "env-progress--failed"
    );
  });

  it("aborts an in-flight create and ignores its response on teardown", async () => {
    const page = fixture();
    let resolveCreate: (() => void) | undefined;
    const teardown = await openWithProfile(page, "azure");
    pageInput(page, "env-name-input").value = "dev";
    pageInput(page, "azure-rg-select").value = "app-rg";
    pageInput(page, "azure-cluster-select").value = "aks-1";
    page.browser.net.handle(
      CREATE_ENVIRONMENT_OPERATION_PATH,
      () =>
        new Promise<HttpResponse>((resolve) => {
          resolveCreate = () =>
            resolve(jsonResponse({ operationId: "late" }, true, 202));
        })
    );

    page.elements["deploy-btn"].dispatch("click");
    await flushPromises();
    teardown();
    resolveCreate?.();
    await flushPromises();

    expect(page.browser.net.aborted).toBeGreaterThan(0);
    expect(page.elements["deploy-btn"].textContent).toBe(
      "Creating environment…"
    );
  });

  it("ignores a late create success when abort is unavailable", async () => {
    const page = fixture();
    let resolveCreate: (() => void) | undefined;
    const teardown = await openWithProfile(page, "azure");
    page.browser.net.supportsAbort = false;
    pageInput(page, "env-name-input").value = "dev";
    pageInput(page, "azure-rg-select").value = "app-rg";
    pageInput(page, "azure-cluster-select").value = "aks-1";
    page.browser.net.handle(
      CREATE_ENVIRONMENT_OPERATION_PATH,
      () =>
        new Promise<HttpResponse>((resolve) => {
          resolveCreate = () =>
            resolve(jsonResponse({ operationId: "late" }, true, 202));
        })
    );

    page.elements["deploy-btn"].dispatch("click");
    await flushPromises();
    teardown();
    resolveCreate?.();
    await flushPromises();

    expect(page.elements["deploy-btn"].textContent).toBe(
      "Creating environment…"
    );
  });

  it("does not fetch or render a late create failure after teardown", async () => {
    const page = fixture();
    let resolveCreate: (() => void) | undefined;
    const teardown = await openWithProfile(page, "azure");
    page.browser.net.supportsAbort = false;
    pageInput(page, "env-name-input").value = "dev";
    pageInput(page, "azure-rg-select").value = "app-rg";
    pageInput(page, "azure-cluster-select").value = "aks-1";
    page.browser.net.handle(
      CREATE_ENVIRONMENT_OPERATION_PATH,
      () =>
        new Promise<HttpResponse>((resolve) => {
          resolveCreate = () =>
            resolve(
              jsonResponse(
                { error: "late failure", operationId: "late-op" },
                false,
                500
              )
            );
        })
    );

    page.elements["deploy-btn"].dispatch("click");
    await flushPromises();
    teardown();
    resolveCreate?.();
    await flushPromises();

    expect(
      page.browser.net.calls.some(
        (call) => call.url === "/api/operations/late-op"
      )
    ).toBe(false);
  });

  it("follows an environment deletion through the shared progress panel", async () => {
    const page = fixture();
    const remove = createFakeInput("delete-row");
    remove.setAttribute("data-env", "dev");
    page.browser.document.addSelectorAll(".js-delete-env", [remove]);
    page.browser.net.handle(
      `${ENVIRONMENT_LIST_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () =>
        jsonResponse({
          environments: [{ name: "dev", status: "success", provider: "azure" }]
        })
    );
    let deleteRequested = false;
    let operationPolls = 0;
    page.browser.net.handle(ENVIRONMENT_DELETE_PATH, () => {
      deleteRequested = true;
      return jsonResponse({ success: true }, true, 202);
    });
    page.browser.net.handle(
      `${OPERATIONS_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () => {
        if (!deleteRequested) return jsonResponse({ operation: null });
        operationPolls += 1;
        const terminal = operationPolls >= 2;
        return jsonResponse({
          operation: {
            operationId: "del-1",
            environment: "dev",
            provider: "azure",
            state: terminal ? "succeeded" : "running",
            terminalState: terminal ? "succeeded" : null,
            summary: "Deleting dev…"
          }
        });
      }
    );

    const teardown = initializeEnvironmentPage(page.browser.context);
    await flushPromises();

    remove.dispatch("click");
    // The row click opens the in-DOM confirmation; confirming it performs the
    // delete (native modals are suppressed under the canvas host).
    page.elements["env-confirm-ok"].dispatch("click");
    await flushPromises();

    const deleteCall = page.browser.net.calls.find(
      (entry) => entry.url === ENVIRONMENT_DELETE_PATH
    );
    expect(JSON.parse(String(deleteCall?.init?.body))).toEqual({
      repo: "octo/app",
      environment: "dev"
    });
    // The optimistic delete record opens the shared progress panel while the
    // operation is tracked.
    expect(page.elements[PROGRESS_IDS.panel].style.display).toBe("");

    const listCallsBefore = page.browser.net.calls.filter((entry) =>
      entry.url.includes(ENVIRONMENT_LIST_PATH)
    ).length;
    page.browser.clock.tick(1600);
    await flushPromises();

    // Reaching a terminal state reloads the environment table.
    expect(operationPolls).toBeGreaterThanOrEqual(2);
    const listCallsAfter = page.browser.net.calls.filter((entry) =>
      entry.url.includes(ENVIRONMENT_LIST_PATH)
    ).length;
    expect(listCallsAfter).toBeGreaterThan(listCallsBefore);

    teardown();
  });

  it("shows an app-registration acknowledgement dialog after an azure delete succeeds", async () => {
    const page = fixture();
    const remove = createFakeInput("delete-row");
    remove.setAttribute("data-env", "dev");
    page.browser.document.addSelectorAll(".js-delete-env", [remove]);
    page.browser.net.handle(
      `${ENVIRONMENT_LIST_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () =>
        jsonResponse({
          environments: [{ name: "dev", status: "success", provider: "azure" }]
        })
    );
    let deleteRequested = false;
    let operationPolls = 0;
    page.browser.net.handle(ENVIRONMENT_DELETE_PATH, () => {
      deleteRequested = true;
      return jsonResponse({ success: true }, true, 202);
    });
    page.browser.net.handle(`${OPERATIONS_PATH}/del-1/dismiss`, () =>
      jsonResponse({ operationId: "del-1" })
    );
    page.browser.net.handle(
      `${OPERATIONS_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () => {
        if (!deleteRequested) return jsonResponse({ operation: null });
        operationPolls += 1;
        const terminal = operationPolls >= 2;
        return jsonResponse({
          operation: {
            operationId: "del-1",
            kind: "delete",
            environment: "dev",
            provider: "azure",
            state: terminal ? "succeeded" : "running",
            terminalState: terminal ? "succeeded" : null,
            summary: "Deleting dev…"
          }
        });
      }
    );

    const teardown = initializeEnvironmentPage(page.browser.context);
    await flushPromises();

    remove.dispatch("click");
    // Confirm the initial delete prompt to kick off the operation.
    page.elements["env-confirm-ok"].dispatch("click");
    await flushPromises();
    page.browser.clock.tick(1600);
    await flushPromises();
    await flushPromises();

    // On success the same modal is reused to acknowledge that the Entra app
    // registration was intentionally left in place.
    expect(page.elements["env-confirm-modal"].style.display).toBe("flex");
    expect(page.elements["env-confirm-title"].textContent).toBe(
      "Environment deleted"
    );
    const acknowledgement = fakeText(page.elements["env-confirm-message"]);
    expect(acknowledgement).not.toContain("reported warnings");
    expect(acknowledgement).toContain(
      "Microsoft Entra app registration was not deleted"
    );
    expect(acknowledgement).toContain("delete it in the Azure portal.");
    expect(acknowledgement).not.toContain("yourself");
    const portalLink = page.elements["env-confirm-message"].children[1];
    expect(portalLink?.textContent).toBe("Azure portal");
    expect(portalLink?.getAttribute("href")).toBe(
      "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"
    );
    expect(portalLink?.getAttribute("target")).toBe("_blank");
    expect(portalLink?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(page.elements["env-confirm-ok"].textContent).toBe("Done");
    // The acknowledgement is a single-button dialog: cancel is hidden.
    expect(page.elements["env-confirm-cancel"].style.display).toBe("none");
    // Dismissing the acknowledgement closes the modal.
    page.elements["env-confirm-ok"].dispatch("click");
    await flushPromises();
    expect(page.elements["env-confirm-modal"].style.display).toBe("none");

    teardown();
  });

  it("uses warning-aware wording when an azure delete succeeds with warnings", async () => {
    const page = fixture();
    const remove = createFakeInput("delete-row");
    remove.setAttribute("data-env", "dev");
    page.browser.document.addSelectorAll(".js-delete-env", [remove]);
    page.browser.net.handle(
      `${ENVIRONMENT_LIST_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () =>
        jsonResponse({
          environments: [{ name: "dev", status: "success", provider: "azure" }]
        })
    );
    let deleteRequested = false;
    let operationPolls = 0;
    let dismissed = false;
    page.browser.net.handle(ENVIRONMENT_DELETE_PATH, () => {
      deleteRequested = true;
      return jsonResponse({ success: true }, true, 202);
    });
    page.browser.net.handle(`${OPERATIONS_PATH}/del-1/dismiss`, () => {
      dismissed = true;
      return jsonResponse({ operationId: "del-1" });
    });
    page.browser.net.handle(
      `${OPERATIONS_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () => {
        if (!deleteRequested) return jsonResponse({ operation: null });
        operationPolls += 1;
        const terminal = operationPolls >= 2;
        return jsonResponse({
          operation: {
            operationId: "del-1",
            kind: "delete",
            environment: "dev",
            provider: "azure",
            state: terminal ? "succeeded_with_warnings" : "running",
            terminalState: terminal ? "succeeded_with_warnings" : null,
            summary: "Deleting dev…"
          }
        });
      }
    );

    const teardown = initializeEnvironmentPage(page.browser.context);
    await flushPromises();

    page.elements["env-success-banner"].style.display = "flex";
    page.elements["env-success-banner-text"].textContent =
      "Successfully configured Azure Environment windows";
    remove.dispatch("click");
    page.elements["env-confirm-ok"].dispatch("click");
    await flushPromises();
    expect(page.elements["env-success-banner"].style.display).toBe("none");
    page.browser.clock.tick(1600);
    await flushPromises();
    await flushPromises();

    // A warnings outcome does not claim a clean deletion: the title and body
    // both flag that some cleanup steps reported warnings.
    expect(page.elements["env-confirm-modal"].style.display).toBe("flex");
    expect(page.elements["env-confirm-title"].textContent).toBe(
      "Environment deleted with warnings"
    );
    expect(fakeText(page.elements["env-confirm-message"])).toContain(
      "reported warnings"
    );
    expect(fakeText(page.elements["env-confirm-message"])).toContain(
      "Microsoft Entra app registration was not deleted"
    );

    // Acknowledging the warning leaves both choices available in the panel:
    // retry the unfinished cleanup or explicitly exit the completed deletion.
    page.elements["env-confirm-ok"].dispatch("click");
    await flushPromises();
    expect(dismissed).toBe(false);
    expect(page.elements[PROGRESS_IDS.dismiss].textContent).toBe("Exit");
    expect(page.elements[PROGRESS_IDS.dismiss].style.display).toBe("");

    page.elements[PROGRESS_IDS.dismiss].dispatch("click");
    await flushPromises();
    expect(dismissed).toBe(true);
    expect(page.elements[PROGRESS_IDS.panel].style.display).toBe("none");

    teardown();
  });

  it("keeps a clean azure delete panel on acknowledgement and dismisses it from the panel's own button so it stays gone after navigation", async () => {
    const page = fixture();
    const remove = createFakeInput("delete-row");
    remove.setAttribute("data-env", "dev");
    page.browser.document.addSelectorAll(".js-delete-env", [remove]);
    page.browser.net.handle(
      `${ENVIRONMENT_LIST_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () =>
        jsonResponse({
          environments: [{ name: "dev", status: "success", provider: "azure" }]
        })
    );
    let deleteRequested = false;
    let dismissed = false;
    let operationPolls = 0;
    page.browser.net.handle(ENVIRONMENT_DELETE_PATH, () => {
      deleteRequested = true;
      return jsonResponse({ success: true }, true, 202);
    });
    page.browser.net.handle(`${OPERATIONS_PATH}/del-1/dismiss`, () => {
      dismissed = true;
      return jsonResponse({ operationId: "del-1" });
    });
    page.browser.net.handle(
      `${OPERATIONS_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () => {
        // Once dismissed, the server reports nothing for the repo — the exact
        // condition a returning user's resume must honor.
        if (!deleteRequested || dismissed) {
          return jsonResponse({ operation: null });
        }
        operationPolls += 1;
        const terminal = operationPolls >= 2;
        return jsonResponse({
          operation: {
            operationId: "del-1",
            kind: "delete",
            environment: "dev",
            provider: "azure",
            state: terminal ? "succeeded" : "running",
            terminalState: terminal ? "succeeded" : null,
            summary: "Deleting dev…"
          }
        });
      }
    );

    const teardown = initializeEnvironmentPage(page.browser.context);
    await flushPromises();

    remove.dispatch("click");
    page.elements["env-confirm-ok"].dispatch("click");
    await flushPromises();
    page.browser.clock.tick(1600);
    await flushPromises();
    await flushPromises();

    // The succeeded panel is on screen alongside the acknowledgement dialog.
    expect(page.elements[PROGRESS_IDS.panel].style.display).not.toBe("none");

    // Acknowledging the notice ("Done") only closes the dialog. It must NOT
    // dismiss the operation or tear the panel down — the panel keeps its own
    // "OK" button as the single control that ends a finished deletion.
    page.elements["env-confirm-ok"].dispatch("click");
    await flushPromises();
    expect(dismissed).toBe(false);
    expect(page.elements["env-confirm-modal"].style.display).toBe("none");
    expect(page.elements[PROGRESS_IDS.panel].style.display).not.toBe("none");
    expect(page.elements[PROGRESS_IDS.dismiss].textContent).toBe("OK");
    expect(page.elements[PROGRESS_IDS.dismiss].style.display).toBe("");

    // Clicking the panel's own OK button dismisses the operation and hides it.
    page.elements[PROGRESS_IDS.dismiss].dispatch("click");
    await flushPromises();
    expect(dismissed).toBe(true);
    expect(page.elements[PROGRESS_IDS.panel].style.display).toBe("none");

    teardown();

    // Returning to the page (a fresh mount) must not resurface the dismissed
    // panel: the server now reports no operation for the repo.
    const rejoin = initializeEnvironmentPage(page.browser.context);
    await flushPromises();
    expect(page.elements[PROGRESS_IDS.panel].style.display).toBe("none");

    rejoin();
  });

  it("shows the acknowledgement dialog when rejoining a running azure delete", async () => {
    const page = fixture();
    page.browser.document.addSelectorAll(".js-delete-env", []);
    page.browser.net.handle(
      `${ENVIRONMENT_LIST_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () =>
        jsonResponse({
          environments: [{ name: "dev", status: "success", provider: "azure" }]
        })
    );
    // The operation is already running when the panel loads (resume path) and
    // then terminates while we poll.
    let operationPolls = 0;
    page.browser.net.handle(
      `${OPERATIONS_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () => {
        operationPolls += 1;
        const terminal = operationPolls >= 3;
        return jsonResponse({
          operation: {
            operationId: "del-1",
            kind: "delete",
            environment: "dev",
            provider: "azure",
            state: terminal ? "succeeded" : "running",
            terminalState: terminal ? "succeeded" : null,
            summary: "Deleting dev…"
          }
        });
      }
    );

    const teardown = initializeEnvironmentPage(page.browser.context);
    await flushPromises();
    page.browser.clock.tick(1600);
    await flushPromises();
    await flushPromises();
    page.browser.clock.tick(1600);
    await flushPromises();
    await flushPromises();

    // Even though the user never clicked delete this session, rejoining a
    // delete operation still surfaces the app-registration acknowledgement.
    expect(page.elements["env-confirm-modal"].style.display).toBe("flex");
    expect(page.elements["env-confirm-title"].textContent).toBe(
      "Environment deleted"
    );
    expect(fakeText(page.elements["env-confirm-message"])).toContain(
      "Microsoft Entra app registration was not deleted"
    );

    teardown();
  });

  it("does not show the acknowledgement dialog when an azure delete fails", async () => {
    const page = fixture();
    const remove = createFakeInput("delete-row");
    remove.setAttribute("data-env", "dev");
    page.browser.document.addSelectorAll(".js-delete-env", [remove]);
    page.browser.net.handle(
      `${ENVIRONMENT_LIST_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () =>
        jsonResponse({
          environments: [{ name: "dev", status: "success", provider: "azure" }]
        })
    );
    let deleteRequested = false;
    let operationPolls = 0;
    page.browser.net.handle(ENVIRONMENT_DELETE_PATH, () => {
      deleteRequested = true;
      return jsonResponse({ success: true }, true, 202);
    });
    page.browser.net.handle(
      `${OPERATIONS_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () => {
        if (!deleteRequested) return jsonResponse({ operation: null });
        operationPolls += 1;
        const terminal = operationPolls >= 2;
        return jsonResponse({
          operation: {
            operationId: "del-1",
            environment: "dev",
            provider: "azure",
            state: terminal ? "failed" : "running",
            terminalState: terminal ? "failed" : null,
            summary: "Deleting dev…"
          }
        });
      }
    );

    const teardown = initializeEnvironmentPage(page.browser.context);
    await flushPromises();

    remove.dispatch("click");
    page.elements["env-confirm-ok"].dispatch("click");
    await flushPromises();
    expect(page.elements["env-confirm-modal"].style.display).toBe("none");
    page.browser.clock.tick(1600);
    await flushPromises();
    await flushPromises();

    expect(operationPolls).toBeGreaterThanOrEqual(2);
    expect(page.elements["env-confirm-modal"].style.display).toBe("none");

    teardown();
  });

  it("does not show the acknowledgement dialog after an aws delete succeeds", async () => {
    const page = fixture();
    const remove = createFakeInput("delete-row");
    remove.setAttribute("data-env", "dev");
    page.browser.document.addSelectorAll(".js-delete-env", [remove]);
    page.browser.net.handle(
      `${ENVIRONMENT_LIST_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () =>
        jsonResponse({
          environments: [{ name: "dev", status: "success", provider: "aws" }]
        })
    );
    let deleteRequested = false;
    let operationPolls = 0;
    page.browser.net.handle(ENVIRONMENT_DELETE_PATH, () => {
      deleteRequested = true;
      return jsonResponse({ success: true }, true, 202);
    });
    page.browser.net.handle(
      `${OPERATIONS_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () => {
        if (!deleteRequested) return jsonResponse({ operation: null });
        operationPolls += 1;
        const terminal = operationPolls >= 2;
        return jsonResponse({
          operation: {
            operationId: "del-1",
            environment: "dev",
            provider: "aws",
            state: terminal ? "succeeded" : "running",
            terminalState: terminal ? "succeeded" : null,
            summary: "Deleting dev…"
          }
        });
      }
    );

    const teardown = initializeEnvironmentPage(page.browser.context);
    await flushPromises();

    remove.dispatch("click");
    page.elements["env-confirm-ok"].dispatch("click");
    await flushPromises();
    // The initial delete confirmation closes and no acknowledgement replaces it.
    expect(page.elements["env-confirm-modal"].style.display).toBe("none");
    page.browser.clock.tick(1600);
    await flushPromises();
    await flushPromises();

    expect(operationPolls).toBeGreaterThanOrEqual(2);
    expect(page.elements["env-confirm-modal"].style.display).toBe("none");

    teardown();
  });
});
