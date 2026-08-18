import { describe, expect, it, vi } from "vitest";
import {
  ENVIRONMENT_DELETE_PATH,
  ENVIRONMENT_DELETE_REDIRECT_MS,
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

function renderPage(repo = "octo/app") {
  const browser = createFakeBrowser();
  const elements = {
    environmentPane: createFakeElement("pane-environments"),
    credentialPane: createFakeElement("pane-credentials"),
    environmentLanding: createFakeElement("env-landing"),
    environmentForm: createFakeElement("env-form"),
    environmentName: createFakeInput("env-name-input", "dev"),
    profileSelect: createFakeInput("env-profile-select"),
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
    loadProfiles: vi.fn(),
    loadGitHubIdentity: vi.fn(),
    clearSharedAppPin: vi.fn()
  };
  const decisions = {
    confirm: vi.fn(() => true),
    notify: vi.fn()
  };
  const initialized = initializeEnvironmentPane(
    browser.context,
    { repo, decisions },
    dependencies
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
    controller: initialized
  };
}

function addRowButtons(browser: FakeBrowser, name = "dev") {
  const deploy = createFakeInput("deploy-row");
  deploy.setAttribute("data-env", name);
  const remove = createFakeInput("delete-row");
  remove.setAttribute("data-env", name);
  browser.document.addSelectorAll(".js-deploy-apps", [deploy]);
  browser.document.addSelectorAll(".js-delete-env", [remove]);
  return { deploy, remove };
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
      loadProfiles() {},
      loadGitHubIdentity() {},
      clearSharedAppPin() {}
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
    ["success", "rad-dot--success", "Success"],
    ["verified", "rad-dot--success", "Verified"],
    ["failed", "rad-dot--failed", "Failed"],
    ["pending", "rad-dot--pending", "Pending"],
    ["unverified", "rad-dot--pending", "Unverified"],
    ["unknown", "rad-dot--pending", "Pending"]
  ])("renders %s status", (status, tone, label) => {
    const markup = environmentStatusMarkup(status);
    expect(markup).toContain(tone);
    expect(markup).toContain(label);
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
        webUrl: "https://github.com/octo/app/settings/environments/dev"
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
    expect(markup).toContain(
      'href="https://github.com/octo/app/settings/environments"'
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

  it("opens and closes the environment form with fresh cross-pane state", () => {
    const page = renderPage();
    page.elements.deployStatus.style.display = "block";
    page.elements.success.style.display = "flex";

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
    expect(page.elements.environmentName.focusCount).toBe(1);
    expect(page.elements.success.style.display).toBe("none");

    page.browser.net.handle(`${ENVIRONMENT_LIST_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ environments: [] })
    );
    page.controller.showEnvironmentLanding();
    expect(page.elements.environmentForm.style.display).toBe("none");
    expect(page.elements.environmentLanding.style.display).toBe("");
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

  it("renders records, wires row navigation, and polls pending state", async () => {
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
    expect(page.browser.nav.assigned).toEqual(["/?page=deploying&env=dev"]);
    expect(page.browser.clock.timeouts).toBe(1);

    page.browser.clock.tick(ENVIRONMENT_POLL_MS);
    await flushPromises();
    expect(page.browser.net.calls).toHaveLength(2);
    expect(rows.deploy.listenerCount("click")).toBe(1);
  });

  it("navigates to the unqualified deploying page for an unnamed row", async () => {
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
    expect(page.browser.nav.assigned).toEqual(["/?page=deploying"]);
  });

  it("treats missing row data attributes as empty", async () => {
    const page = renderPage();
    const deploy = createFakeInput("deploy-row");
    const remove = createFakeInput("delete-row");
    page.browser.document.addSelectorAll(".js-deploy-apps", [deploy]);
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
    expect(page.browser.nav.assigned).toEqual(["/?page=deploying"]);
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
    expect(unnamed.page.browser.net.calls).toHaveLength(1);

    const refused = await readyDelete();
    refused.page.decisions.confirm.mockReturnValue(false);
    refused.rows.remove.dispatch("click");
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

  it("shows an app conflict and redirects only to the safe deployment flow", async () => {
    const { page, rows } = await readyDelete();
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
    expect(page.elements.errorText.textContent).toContain(
      "Delete the app first."
    );
    expect(page.browser.clock.timeouts).toBe(1);
    page.browser.clock.tick(ENVIRONMENT_DELETE_REDIRECT_MS);
    expect(page.browser.nav.assigned).toEqual(["/?page=deploying"]);
  });

  it("accepts a same-page deployment conflict redirect", async () => {
    const { page, rows } = await readyDelete();
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
    rows.remove.dispatch("click");
    await flushPromises();
    page.browser.clock.tick(ENVIRONMENT_DELETE_REDIRECT_MS);
    expect(page.browser.nav.assigned).toEqual(["/?page=deploying&env=dev"]);
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

  it("cancels a pending conflict redirect during teardown", async () => {
    const { page, rows } = await readyDelete();
    page.browser.net.handle(ENVIRONMENT_DELETE_PATH, () =>
      jsonResponse(
        { code: "app-deployed", redirect: "/?page=deploying&env=dev" },
        false,
        409
      )
    );
    rows.remove.dispatch("click");
    await flushPromises();
    expect(page.browser.clock.pending).toBe(1);

    page.controller.teardown();
    expect(page.browser.clock.pending).toBe(0);
    expect(page.browser.nav.assigned).toEqual([]);
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

    // A non-PR outcome carrying its own guidance (incomplete cloud credentials,
    // issue #219) shows the message verbatim, escaped, instead of the
    // open-a-pull-request text.
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
